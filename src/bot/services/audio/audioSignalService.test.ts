import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * `getAudioSignalAndSr` must never report a sample rate it did not produce, and
 * must never return a signal it did not decode.
 *
 * Every assertion here was first observed LIVE (scripts/tmp-audioLive.ts,
 * deleted after use) against a real Deezer 30s preview of Metallica / Enter
 * Sandman - 29.99s, 44100Hz stereo MP3 - and against three files that are
 * deliberately not audio. The two lies this locks out:
 *
 *   1. a sample rate for a file with no audio stream in it. Observed live on a
 *      valid video-only MP4: ffprobe succeeds, `streams` has one video entry and
 *      no audio entry, and the old expression answered 44100 anyway.
 *   2. a sample rate that does not describe the returned frames. Observed live
 *      on a 48kHz copy of the same preview: 1,439,452 frames reported as
 *      44100Hz (32.64s of audio for 30.0s of audio), and Essentia then returned
 *      bpm=113.9 for a 123 BPM track - confidently wrong, nothing logged.
 */

const ffprobeMock = vi.fn();
const chainMock = vi.fn();

vi.mock('fluent-ffmpeg', () => {
  // `audioSignalService` default-imports the module, so the mock has to be the
  // `default` key - and the callable factory itself has to carry the statics the
  // module reaches for at import time and per decode.
  const factory = Object.assign(vi.fn(() => chainMock()), {
    ffprobe: ffprobeMock,
    setFfmpegPath: vi.fn(),
    setFfprobePath: vi.fn(),
  });
  return { default: factory };
});

const tempRoot = path.join(os.tmpdir(), 'tvbot-audio-unit');
fs.mkdirSync(tempRoot, { recursive: true });

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

type Stream = { codec_type?: string; sample_rate?: string | number; codec_name?: string };

/** The shape the fluent chain is asserted against. Narrowed from the mock so the
 *  assertion names the calls it cares about instead of `any`. */
type Chain = { audioChannels: ReturnType<typeof vi.fn>; audioFrequency: ReturnType<typeof vi.fn> };

/** Set up one decode: ffprobe returns `streams`, ffmpeg writes `rawBytes`. */
const arrange = (streams: Stream[], rawBytes: Buffer): void => {
  ffprobeMock.mockImplementation((_file: string, cb: (e: Error | null, d: unknown) => void) => {
    cb(null, { streams });
  });
  chainMock.mockImplementation(() => {
    const listeners: { end?: () => void; error?: (e: Error) => void } = {};
    const chain = {
      audioChannels: vi.fn(() => chain),
      audioFrequency: vi.fn(() => chain),
      audioCodec: vi.fn(() => chain),
      format: vi.fn(() => chain),
      on: vi.fn((event: string, fn: (e?: Error) => void) => {
        if (event === 'end' || event === 'error') listeners[event] = fn as () => void;
        return chain;
      }),
      run: vi.fn(() => chain),
      output: vi.fn((out: string) => {
        // ffmpeg's `end` is where the real decoder has written the file. Queued
        // so it lands after the `.on('end')` registration that follows `.output()`
        // in the call chain, exactly as the real emitter behaves.
        queueMicrotask(() => {
          if (rawBytes) fs.writeFileSync(out, rawBytes);
          listeners.end?.();
        });
        return chain;
      }),
    };
    return chain;
  });
};

const realSignal = (frames: number): Buffer => Buffer.alloc(frames * 4, 0x00);

/** Import the module fresh so the mocked fluent-ffmpeg is picked up. */
const load = async (): Promise<typeof import('./audioSignalService')> => {
  vi.resetModules();
  return import('./audioSignalService');
};

const okResponse = (): Response =>
  new Response(Buffer.from('fake-mp3-bytes'), { status: 200 });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('getAudioSignalAndSr', () => {
  it('decodes a real stream and reports the rate the decoder actually produced', async () => {
    arrange([{ codec_type: 'audio', sample_rate: '44100' }], realSignal(44100));
    const mod = await load();
    const { signal, sampleRate } = await mod.getAudioSignalAndSr('u1', 'https://cdn.example/a.mp3');
    expect(sampleRate).toBe(mod.SIGNAL_SAMPLE_RATE);
    expect(signal.length).toBe(44100);
  });

  // THE LIE. A valid file with no audio stream in it is not audio, and the old
  // code answered with a plausible rate anyway. Downstream that invited a
  // beat analysis of nothing; live, ffmpeg then died with an opaque
  // "Error opening output file ....raw" which told nobody the real reason.
  it('REFUSES a file with no audio stream instead of inventing a sample rate', async () => {
    arrange([{ codec_type: 'video', codec_name: 'h264' }], realSignal(44100));
    const mod = await load();
    await expect(mod.getAudioSignalAndSr('u2', 'https://cdn.example/b.mp3'))
      .rejects.toThrow(/no audio stream/i);
  });

  it('REFUSES a file whose streams array is empty', async () => {
    arrange([], realSignal(44100));
    const mod = await load();
    await expect(mod.getAudioSignalAndSr('u3', 'https://cdn.example/c.mp3'))
      .rejects.toThrow(/no audio stream/i);
  });

  it('REFUSES a stream whose sample rate ffprobe could not read', async () => {
    arrange([{ codec_type: 'audio' }], realSignal(44100));
    const mod = await load();
    await expect(mod.getAudioSignalAndSr('u4', 'https://cdn.example/d.mp3'))
      .rejects.toThrow(/sample rate/i);
  });

  it('REFUSES a non-positive sample rate', async () => {
    arrange([{ codec_type: 'audio', sample_rate: '0' }], realSignal(44100));
    const mod = await load();
    await expect(mod.getAudioSignalAndSr('u5', 'https://cdn.example/e.mp3'))
      .rejects.toThrow(/sample rate/i);
  });

  // The 48kHz case. The decoder must ASK ffmpeg for 44100 whatever the source
  // rate is, so the reported rate describes the returned frames.
  it('forces the analysis rate in the decode, whatever the source rate is', async () => {
    arrange([{ codec_type: 'audio', sample_rate: '48000' }], realSignal(44100));
    const mod = await load();
    const { sampleRate, signal } = await mod.getAudioSignalAndSr('u6', 'https://cdn.example/f.mp3');
    const chains = chainMock.mock.results.map((r) => r.value as Chain);
    const last = chains[chains.length - 1]!;
    // audioFrequency is what becomes `-ar`, and the returned rate has to be the
    // one it was given - otherwise the frames and the label disagree.
    expect(last.audioFrequency).toHaveBeenCalledWith(mod.SIGNAL_SAMPLE_RATE);
    expect(signal.length / sampleRate).toBeCloseTo(1, 5);
  });

  it('propagates an ffprobe failure instead of substituting a rate', async () => {
    ffprobeMock.mockImplementation((_f: string, cb: (e: Error | null) => void) => cb(new Error('ffprobe exited with code 1')));
    const mod = await load();
    await expect(mod.getAudioSignalAndSr('u7', 'https://cdn.example/g.mp3'))
      .rejects.toThrow(/ffprobe exited with code 1/);
  });

  // ffmpeg can exit 0 having written almost nothing. Returning that is a signal
  // the caller cannot use, dressed up as one it can.
  it('REFUSES a decode too short to analyse', async () => {
    arrange([{ codec_type: 'audio', sample_rate: '44100' }], realSignal(1000));
    const mod = await load();
    await expect(mod.getAudioSignalAndSr('u8', 'https://cdn.example/h.mp3'))
      .rejects.toThrow(/below the 4410/);
  });

  it('REFUSES a zero-byte decode', async () => {
    arrange([{ codec_type: 'audio', sample_rate: '44100' }], Buffer.alloc(0));
    const mod = await load();
    await expect(mod.getAudioSignalAndSr('u9', 'https://cdn.example/i.mp3'))
      .rejects.toThrow(/below the 4410/);
  });

  it('propagates a download failure (404) unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })));
    const mod = await load();
    await expect(mod.getAudioSignalAndSr('u10', 'https://cdn.example/j.mp3'))
      .rejects.toThrow(/404/);
  });

  it('passes the decoded signal through untouched, including a byte-offset Buffer', async () => {
    // A sub-pool Buffer has a non-zero byteOffset; reading it with
    // `new Float32Array(buf.buffer)` instead of honouring the offset yields
    // float32 reinterpretations of the POOL, not of the audio.
    arrange([{ codec_type: 'audio', sample_rate: '44100' }], realSignal(44100));
    const mod = await load();
    const { signal } = await mod.getAudioSignalAndSr('u11', 'https://cdn.example/k.mp3');
    expect(signal).toBeInstanceOf(Float32Array);
    expect(signal.length).toBe(44100);
    expect(signal.every((v) => v === 0)).toBe(true);
  });
});

describe('downloadMP3', () => {
  it('throws on a non-ok response and does not return a path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 403 })));
    const mod = await load();
    await expect(mod.downloadMP3('https://cdn.example/k.mp3', 'd1')).rejects.toThrow(/403/);
  });

  // The 15s bound on a stalling CDN is asserted LIVE, not here: it is built on
  // `AbortSignal.timeout`, which runs on a real timer that vitest's fake timers
  // do not drive, so a fake-timer version of this test would pass against an
  // UNBOUNDED fetch and prove nothing. Measured live: 15008ms against a server
  // that accepts the connection and never responds, and 15002ms against a
  // nonexistent CDN host, against the 15_000ms constant.
  it('passes an AbortSignal to fetch, so the stall cannot be unbounded', async () => {
    let seen: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      seen = init.signal as AbortSignal;
      return okResponse();
    }));
    const mod = await load();
    await mod.downloadMP3('https://cdn.example/l.mp3', 'd3');
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});
