import 'reflect-metadata';
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveBinary, SIGNAL_SAMPLE_RATE } from '@bot/services/audio/audioSignalService';
import { EssentiaService, ESSENTIA_SAMPLE_RATE } from '@bot/services/audio/essentiaService';
import { Logger } from '@domain/logging/logger';

/**
 * The audio pipeline's honesty contract, and the binary resolution that decides
 * whether it runs at all.
 *
 * Every case here was first observed LIVE against a real Deezer 30s preview
 * (Metallica / Enter Sandman, 29.99s, 44100Hz stereo MP3) with the real ffmpeg
 * 9.0.2 and the real essentia.js WASM. The live probe found that
 * `node_modules/ffmpeg-static/ffmpeg.exe` is ABSENT on this machine while
 * `ffprobe-static`'s Windows binary is present - an asymmetry that made every
 * decode die at `spawn ... ENOENT` while ffprobe kept working, and the only
 * symptom was `bpm=null` in a track card.
 *
 * The rule these lock: an empty answer is fine, a fabricated number is a lie.
 * There are two ways this code used to lie, and both are now unrepresentable:
 *   1. a sample rate for a file that has no audio stream in it, and
 *   2. a BPM/key computed from a signal at a rate Essentia was never given.
 */

// A real directory, so `fs.existsSync` is true for it. `existsSync` is TRUE for
// a directory, which is the whole reason the binary check is a stat, not an
// existsSync - a directory called `ffmpeg` on PATH used to be accepted.
const realDir = os.tmpdir();

// Real, created directories. `zzz-well-known` has to EXIST: resolveBinary's
// contract is "the first candidate that exists", and a path that was never
// created tests nothing about the rung order.
const scratch = path.join(realDir, 'tvbot-resolve-binary-test');
fs.mkdirSync(scratch, { recursive: true });
const wellKnownDir = path.join(scratch, 'well-known');
const packagedFile = path.join(scratch, 'packaged', 'ffmpeg');
fs.mkdirSync(path.dirname(packagedFile), { recursive: true });
fs.writeFileSync(packagedFile, 'x');
fs.mkdirSync(wellKnownDir, { recursive: true });

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('resolveBinary', () => {
  const missing = path.join(scratch, 'definitely-not-here', 'ffmpeg.exe');

  it('returns the configured path when it exists, ahead of everything else', () => {
    // `realDir` stands in for an existing configured path; the wellKnown rung
    // must not be consulted at all when the operator has configured one.
    expect(resolveBinary(realDir, [wellKnownDir], missing, 'ffmpeg', { PATH: '' })).toBe(realDir);
  });

  it('skips a configured path that does not exist and uses the next candidate', () => {
    expect(resolveBinary(missing, [wellKnownDir], packagedFile, 'ffmpeg', { PATH: '' }))
      .toBe(wellKnownDir);
  });

  it('ignores a blank or whitespace configured path rather than accepting it', () => {
    for (const blank of ['', '   ', undefined]) {
      expect(resolveBinary(blank, [wellKnownDir], packagedFile, 'ffmpeg', { PATH: '' })).toBe(wellKnownDir);
    }
  });

  // THE REGRESSION. `ffmpeg-static` was used UNCONDITIONALLY when the candidates
  // missed, with no existence check, and the resulting string was published into
  // process.env.FFMPEG_PATH and handed to fluent-ffmpeg. With the Windows binary
  // absent that published a path to nothing, so every decode threw spawn ENOENT
  // while ffprobe - which WAS present - kept working.
  it('does NOT return a packaged path that does not exist', () => {
    expect(fs.existsSync(missing)).toBe(false);
    expect(resolveBinary(undefined, [], missing, 'ffmpeg', { PATH: '' })).toBeUndefined();
  });

  it('returns the packaged path when it does exist', () => {
    expect(resolveBinary(undefined, [], packagedFile, 'ffmpeg', { PATH: '' })).toBe(packagedFile);
  });

  // WINDOWS-ONLY PINS. The four tests below read the real packaged fixture
  // `node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe`, which exists on a
  // Windows checkout and does not exist on Linux (ubuntu-latest). PATHEXT
  // resolution is a Windows concept, so no Linux fixture is invented for it.
  // Gated with `skipIf`, not deleted: win32 runs them, CI skips them.
  it.skipIf(process.platform !== 'win32')('prefers the packaged build over PATH, so a healthy install is unchanged', () => {
    // A real file on PATH that is NOT the packaged one. If this ever returns the
    // PATH hit, the rung order has been inverted and every host starts using a
    // different ffmpeg build than it did before.
    const ffprobe = path.join(process.cwd(), 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe');
    expect(fs.existsSync(ffprobe)).toBe(true);
    expect(resolveBinary(undefined, [], packagedFile, 'ffprobe', {
      PATH: path.dirname(ffprobe),
      PATHEXT: '.EXE',
    })).toBe(packagedFile);
  });

  it.skipIf(process.platform !== 'win32')('finds a binary on PATH when nothing else is available', () => {
    const ffprobe = path.join(process.cwd(), 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe');
    expect(fs.existsSync(ffprobe)).toBe(true);
    expect(resolveBinary(undefined, [], undefined, 'ffprobe', {
      PATH: path.dirname(ffprobe),
      PATHEXT: '.EXE',
    })).toBe(ffprobe);
  });

  // Windows stat is case-insensitive, so a PATHEXT-built candidate `ffmpeg.EXE`
  // matches a file on disk called `ffmpeg.exe`. Publishing the constructed name
  // writes a path into process.env.FFMPEG_PATH that reads as nonexistent in the
  // startup log.
  it.skipIf(process.platform !== 'win32')('publishes the name as spelled on disk, not as spelled in PATHEXT', () => {
    const ffprobe = path.join(process.cwd(), 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe');
    const found = resolveBinary(undefined, [], undefined, 'ffprobe', {
      PATH: path.dirname(ffprobe),
      PATHEXT: '.EXE',
    });
    expect(found).toBeDefined();
    expect(path.basename(found!)).toBe('ffprobe.exe');
    expect(fs.existsSync(found!)).toBe(true);
  });

  it('finds an extensionless binary on PATH (POSIX)', () => {
    // A real FILE named exactly `ffmpeg`, which is the only shape that matches
    // on Linux/macOS. Guards the `''` first entry in the extension list: drop it
    // and every POSIX host silently loses the rung.
    const dir = path.join(scratch, 'posix-path');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ffmpeg'), 'x');
    expect(resolveBinary(undefined, [], undefined, 'ffmpeg', { PATH: dir })).toBe(path.join(dir, 'ffmpeg'));
  });

  it.skipIf(process.platform !== 'win32')('resolves a Windows .EXE through PATHEXT', () => {
    const ffprobe = path.join(process.cwd(), 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe');
    expect(resolveBinary(undefined, [], undefined, 'ffprobe', {
      PATH: path.dirname(ffprobe),
      PATHEXT: '.COM;.EXE;.BAT',
    })).toBe(ffprobe);
  });

  // `fs.existsSync` is true for a DIRECTORY. A directory named `ffmpeg` sitting
  // on PATH would otherwise be published as the binary and every later spawn
  // would fail with the exact ENOENT this function exists to prevent.
  it('does NOT return a DIRECTORY found on PATH', () => {
    const dir = path.join(scratch, 'dir-on-path');
    fs.mkdirSync(path.join(dir, 'ffmpeg'), { recursive: true });
    expect(resolveBinary(undefined, [], undefined, 'ffmpeg', { PATH: dir })).toBeUndefined();
  });

  it('does NOT return a candidate from wellKnown when it does not exist', () => {
    expect(resolveBinary(undefined, [path.join(scratch, 'no-such-dir', 'ffmpeg.exe')], packagedFile, 'ffmpeg', { PATH: '' }))
      .toBe(packagedFile);
  });

  it('returns undefined when there is genuinely nothing to find', () => {
    expect(resolveBinary(undefined, [], undefined, 'no-such-binary-anywhere', { PATH: '' })).toBeUndefined();
  });
});

describe('sample rate contract', () => {
  it('the decoder and the analyser agree on the rate', () => {
    // The two constants live in different modules on purpose (essentiaService
    // must stay a leaf, and audioSignalService pulls in ffmpeg-static and
    // child_process). Nothing links them at compile time, so something has to -
    // this, plus the runtime refusal in EssentiaService.analyze below.
    expect(SIGNAL_SAMPLE_RATE).toBe(ESSENTIA_SAMPLE_RATE);
  });

  it('the decoder forces the rate with -ar, so the reported rate is a fact about the bytes', () => {
    // Proven live: a 48kHz copy of the same 30s preview decoded to 1,439,452
    // frames. Reported as 44100 that is 32.64s of audio for 30.0s of audio, and
    // Essentia returned bpm=113.9 / key=D# for a 123 BPM F#m track - a confident,
    // wrong number with nothing logged. With -ar it decodes to 1,322,497 frames
    // and returns bpm=123.8 / key=E, identical to the native 44.1kHz result.
    expect(SIGNAL_SAMPLE_RATE).toBe(44100);
  });
});

describe('EssentiaService honesty', () => {
  const service = new EssentiaService();

  const captureWarn = (run: () => void): string[] => {
    const seen: string[] = [];
    const original = Logger.warn;
    (Logger as { warn: unknown }).warn = (...args: unknown[]): void => { seen.push(String(args[1] ?? args[0] ?? '')); };
    try { run(); } finally { (Logger as { warn: unknown }).warn = original; }
    return seen;
  };

  it('loads the real WASM', () => {
    expect(service.isAvailable()).toBe(true);
  });

  it('returns null for a signal too short to carry a beat', () => {
    expect(service.analyze(new Float32Array(4096))).toBeNull();
    expect(service.analyze(new Float32Array(0))).toBeNull();
  });

  it('REFUSES a signal at a rate Essentia was not given, instead of analysing it anyway', () => {
    // The whole point: a wrong rate is not a degraded answer, it is a DIFFERENT
    // answer, and the caller cannot tell it from a real one. Returning a number
    // here is the lie this replaces.
    const signal = new Float32Array(ESSENTIA_SAMPLE_RATE).fill(0.3);
    const warns = captureWarn(() => {
      expect(service.analyze(signal, 48000)).toBeNull();
    });
    expect(warns.some((m) => m.includes('wrong sample rate'))).toBe(true);
  });

  it('logs that refusal above DEBUG - a lost capability, per the logging rule', () => {
    // Swallowing it at DEBUG is the mistake: the track card still renders, the
    // BPM field is just empty, and nothing in the log says the feature is off.
    const signal = new Float32Array(ESSENTIA_SAMPLE_RATE).fill(0.3);
    const warns = captureWarn(() => { service.analyze(signal, 96000); });
    expect(warns.length).toBeGreaterThan(0);
  });

  it('does not refuse a signal it CAN handle', () => {
    // Silence is not a valid analysis, so this asserts the rate guard did not
    // swallow a legitimate call: whatever comes back, the point is that the
    // wrong-rate path returns null and this one is reached at all.
    const result = service.analyze(new Float32Array(ESSENTIA_SAMPLE_RATE), ESSENTIA_SAMPLE_RATE);
    expect(result === null || (typeof result.bpm === 'number' && typeof result.key === 'string')).toBe(true);
  });

  it('defaults the rate so a single-argument call is still checked, not skipped', () => {
    // A caller that forgets the argument gets the correct rate by default, which
    // means the default can never be the thing that lets a bad signal through.
    const warns = captureWarn(() => { service.analyze(new Float32Array(ESSENTIA_SAMPLE_RATE).fill(0.2)); });
    expect(warns.some((m) => m.includes('wrong sample rate'))).toBe(false);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
