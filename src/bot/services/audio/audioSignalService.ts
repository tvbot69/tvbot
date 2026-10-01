import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import cp from 'child_process';
import { Logger } from '@domain/logging/logger';
import { ffmpegPath, ffprobePath, setFfmpegPath, setFfprobePath, currentEnv } from '@config/runtimeEnv';

import { encodeVoiceWaveform } from '@bot/services/audio/voiceWaveform';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import ffmpegFluent from 'fluent-ffmpeg';

/**
 * The fluent-ffmpeg module, captured so the resolved binary paths can be
 * installed once at import time.
 *
 * Typed as `typeof ffmpegFluent` rather than `any`. `@types/fluent-ffmpeg` is
 * already a devDependency and describes the whole surface used here -
 * setFfmpegPath, setFfprobePath, the callable command form, audioChannels,
 * output, run and ffprobe - so the annotation was suppressing checks that
 * would have passed.
 *
 * `typeof ffmpegFluent` rather than the FfmpegCommand interface: the module
 * IS the callable command factory, and FfmpegCommand is the instance type it
 * returns. The typings use `export =`, so the interface has to be reached
 * through the namespace rather than a named import.
 */
let ffmpeg: typeof ffmpegFluent | null = null;
let resolvedFfmpeg: string | undefined;
let resolvedFfprobe: string | undefined;

/** Locations a packaged Windows toolchain lands in. Checked before PATH so an
 *  operator who unpacked one there keeps winning over whatever the machine's
 *  own `where ffmpeg` finds. */
const WELL_KNOWN_FFMPEG = ['C:\\tools\\ffmpeg\\bin\\ffmpeg.exe', '/usr/bin/ffmpeg'];
const WELL_KNOWN_FFPROBE = ['C:\\tools\\ffmpeg\\bin\\ffprobe.exe', '/usr/bin/ffprobe'];

/**
 * Executable suffixes to try when a bare command name is looked up on PATH.
 *
 * `''` first, unconditionally: it is the only one that matches on POSIX (where
 * `ffmpeg` has no extension) and a harmless miss on Windows. The rest come from
 * PATHEXT, which Windows sets per-machine — assuming `.exe` is enough and
 * ignoring it would make `PATHEXT` a lie the resolver quietly contradicts.
 */
const pathExtensions = (env: NodeJS.ProcessEnv): string[] => {
  const raw = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return ['', ...raw.split(';').map((e) => e.trim()).filter(Boolean)];
};

/**
 * The name a directory actually holds for `wanted`, so the PATH rung publishes
 * `ffmpeg.exe` and not `ffmpeg.EXE`.
 *
 * `existsSync`/`statSync` are case-insensitive on Windows, so a PATH lookup
 * built from PATHEXT happily "finds" `ffprobe.EXE` in a directory that contains
 * `ffprobe.exe`. The string is then written into `process.env.FFMPEG_PATH` and
 * printed in the startup log, where it reads as a file that does not exist.
 * Resolving the real name is a `readdirSync` on a directory already known to
 * contain the file, done once at import.
 */
const nameOnDisk = (dir: string, wanted: string): string => {
  try {
    return fs.readdirSync(dir).find((entry) => entry.toLowerCase() === wanted.toLowerCase()) ?? wanted;
  } catch {
    return wanted;
  }
};

/**
 * Resolve a bare command name against PATH, or undefined.
 *
 * Two details that are the whole reason this exists as a function:
 * `existsSync` is true for a DIRECTORY, so a directory named `ffmpeg` on PATH
 * would otherwise be published as the binary and every later spawn would fail
 * with the same ENOENT it failed with before; and a broken symlink throws out
 * of `statSync`, so the check is guarded rather than trusted.
 */
const findOnPath = (name: string, env: NodeJS.ProcessEnv = currentEnv()): string | undefined => {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = pathExtensions(env);
  for (const dir of dirs) {
    for (const ext of exts) {
      const wanted = `${name}${ext}`;
      const candidate = path.join(dir, wanted);
      try {
        if (fs.statSync(candidate).isFile()) return path.join(dir, nameOnDisk(dir, wanted));
      } catch {
        // ENOENT, EACCES or a broken link - all mean "not this one".
      }
    }
  }
  return undefined;
};

/**
 * Pick the first candidate that is a real file, then the packaged build, then
 * PATH.
 *
 * THE ORDER IS THE FIX. `ffmpeg-static` used to be taken UNCONDITIONALLY when
 * the candidates missed, with no `existsSync` on it — and its Windows binary is
 * not always there (a partially-populated install, a cached module directory
 * with the platform-mismatched file in it, an optional-dependency skip). The
 * resolved string was then published into `process.env.FFMPEG_PATH` and handed
 * to `fluent-ffmpeg`, so every decode in the process died at `spawn ... ENOENT`
 * while ffprobe - which WAS present - kept working, and the only symptom was
 * `bpm=null` in a track card. A candidate nobody checked is not a resolution.
 *
 * PATH sits AFTER the packaged build deliberately: on a machine where
 * `ffmpeg-static` is intact this changes nothing, and where it is not intact a
 * system ffmpeg is the only thing left to find. Failing both is reported by the
 * caller as a lost capability rather than being pushed through as a guess.
 */
export function resolveBinary(
  configured: string | undefined,
  wellKnown: readonly string[],
  packaged: string | undefined,
  commandName: string,
  env: NodeJS.ProcessEnv = currentEnv(),
): string | undefined {
  for (const candidate of [configured, ...wellKnown].filter((p): p is string => typeof p === 'string' && p.length > 0)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  if (packaged && fs.existsSync(packaged)) return packaged;
  return findOnPath(commandName, env);
}

const packagedPath = (pkg: unknown): string | undefined => {
  const asObj = pkg as { path?: unknown } | undefined;
  if (asObj && typeof asObj.path === 'string') return asObj.path;
  return typeof pkg === 'string' ? pkg : undefined;
};

try {
  resolvedFfmpeg = resolveBinary(ffmpegPath(), WELL_KNOWN_FFMPEG, packagedPath(ffmpegStatic), 'ffmpeg');
  resolvedFfprobe = resolveBinary(ffprobePath(), WELL_KNOWN_FFPROBE, packagedPath(ffprobeStatic), 'ffprobe');
  // A lost capability, not an expected-but-notable outcome: with no ffmpeg the
  // bot has no BPM/key and no preview playback, and that is invisible at the
  // call site (both report "no analysis"). WARN is the level that says a
  // feature is gone, per the logging rule; the throw below is not enough
  // because resolution does not throw when it simply finds nothing.
  if (!resolvedFfmpeg) {
    Logger.warn('[AudioSignal] no ffmpeg found - BPM/key and voice-message transcoding are unavailable');
  }
  if (!resolvedFfprobe) {
    Logger.warn('[AudioSignal] no ffprobe found - voice-message duration will fall back to 30s');
  }
  // Publishing the resolved binaries back into the environment is load-bearing,
  // not leftover: `voiceMessageService.getDuration` reads FFPROBE_PATH to hand a
  // path to get-audio-duration, and on Windows its own `/usr/bin/ffprobe`
  // fallback does not exist, so without this a voice message is stuck at the
  // hardcoded 30s duration. The setters live in runtimeEnv so the key names
  // are written in exactly one place.
  if (resolvedFfmpeg) setFfmpegPath(resolvedFfmpeg);
  if (resolvedFfprobe) setFfprobePath(resolvedFfprobe);
  ffmpeg = ffmpegFluent;
  if (resolvedFfmpeg) ffmpeg.setFfmpegPath(resolvedFfmpeg);
  if (resolvedFfprobe) ffmpeg.setFfprobePath(resolvedFfprobe);
} catch (e) {
  Logger.warn({ err: e }, '[AudioSignal] ffmpeg init failed');
}

export const tempDir = path.join(os.tmpdir(), 'tvbot-audio');
// CORRECT AS IS: best-effort at import, and a failure is NOT hidden — the
// first downloadMP3 write then throws ENOENT to its real caller, which
// trackDetailsService catches and reports as "no analysis". Swallowing here
// cannot turn a missing temp dir into a fabricated BPM or key.
void fsp.mkdir(tempDir, { recursive: true }).catch(() => undefined);

/** Bound on preview downloads. Without it a CDN that accepts the connection
 *  and then stalls leaves this promise pending forever, and the caller
 *  (a Discord interaction) never answers. */
const PREVIEW_FETCH_TIMEOUT_MS = 15_000;

export async function downloadMP3(url: string, trackId: string): Promise<string> {
  const mp3Path = path.join(tempDir, `${trackId}.mp3`);
  const res = await fetch(url, { signal: AbortSignal.timeout(PREVIEW_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Failed to download preview (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(mp3Path, buf);
  return mp3Path;
}

export async function downloadAndConvert(url: string, trackId: string, duration?: number): Promise<string> {
  const mp3Path = await downloadMP3(url, trackId);
  const oggPath = path.join(tempDir, `${trackId}.ogg`);
  try {
    await new Promise<void>((resolve, reject) => {
      let cmd = ffmpeg(mp3Path).noVideo().audioChannels(1).audioCodec('libopus').format('ogg').outputOptions(['-vbr on']);
      if (duration) cmd = cmd.duration(duration);
      cmd.output(oggPath).on('end', () => resolve()).on('error', (err: Error) => reject(err)).run();
    });
  } catch (err) {
    // The unlink used to sit only on the success path, so every failed
    // transcode left its .mp3 in the temp dir for the life of the process.
    // CORRECT AS IS: a failed unlink only leaves a temp file behind; the
    // transcode failure is rethrown either way, so nothing is reported as
    // a converted preview that does not exist.
    await fsp.unlink(mp3Path).catch(() => undefined);
    throw err;
  }
  // CORRECT AS IS: the .ogg this returns was already written and closed.
  // Failing to delete the .mp3 afterwards is temp-file hygiene, not a
  // result — rethrowing here would turn a successful conversion into an
  // error the caller renders as "no preview".
  await fsp.unlink(mp3Path).catch(() => undefined);
  return oggPath;
}

/**
 * The rate the PCM is decoded at, and the rate Essentia's `RhythmExtractor2013`
 * and `KeyExtractor` expect.
 *
 * NOT a fallback. The decode below forces this rate with `-ar`, so the signal
 * that comes back really is at this rate and reporting it is a fact about the
 * bytes on disk rather than a guess.
 */
export const SIGNAL_SAMPLE_RATE = 44100;

/** Anything shorter than 100ms cannot carry a beat or a key, and Essentia
 *  needs a little more than that to find even one. The service enforces its own
 *  floor too; this one exists so the caller can refuse a degenerate signal
 *  before paying for a WASM call. */
const MIN_SIGNAL_FRAMES = 4410;

export async function getAudioSignalAndSr(trackId: string, url: string): Promise<{ signal: Float32Array; sampleRate: number }> {
  const mp3Path = await downloadMP3(url, trackId);
  let rawPath: string | undefined;
  try {
    // The ffprobe shapes, declared rather than imported. @types/fluent-ffmpeg
    // declares FfprobeData/FfprobeStream inside a namespace that is not
    // reachable as a named export (the module uses `export =`), and ffprobe is
    // overloaded four ways, so inferring through Parameters<> picks the wrong
    // overload and yields `never`. Spelling out the two fields actually read is
    // clearer than working around the packaging.
    //
    // `streams` is a required array per those typings, so the optional chaining
    // below is defensive against a shape the types already guarantee.
    interface FfprobeStream {
      codec_type?: string;
      sample_rate?: string | number;
      codec_name?: string;
    }
    interface FfprobeData {
      streams: FfprobeStream[];
    }

    const metadata = await new Promise<FfprobeData>((resolve, reject) => {
      // Typed explicitly because ffprobe is overloaded four ways in the
      // typings, which leaves the callback parameters contextually untyped.
      ffmpeg.ffprobe(mp3Path, (err: Error, data: FfprobeData) => (err ? reject(err) : resolve(data)));
    });
    const audioStream = metadata?.streams?.find((s) => s.codec_type === 'audio');
    // No audio stream means the download was not audio - an HTML error page, a
    // truncated/expired preview, a zero-length file. It used to be answered
    // with `44100`, which is a sample rate for audio that does not exist, and
    // that number was then returned to the caller as if ffprobe had reported
    // it. Throwing is the honest shape: the caller already turns a throw into
    // "no analysis" (trackDetailsService), whereas a plausible rate invites a
    // downstream analysis of silence.
    if (!audioStream) throw new Error('No audio stream in preview file');
    const sourceRate = Number(audioStream.sample_rate);
    if (!Number.isFinite(sourceRate) || sourceRate <= 0) {
      throw new Error(`ffprobe reported an unusable sample rate (${String(audioStream.sample_rate)})`);
    }
    if (sourceRate !== SIGNAL_SAMPLE_RATE) {
      // Expected-but-notable, not an error: Deezer and Apple both serve 30s
      // previews at whatever the catalogue entry was mastered at. Worth a line
      // because it is the reason the `-ar` below exists, and because a change
      // in what a CDN serves would show up here first.
      Logger.debug({ sourceRate, target: SIGNAL_SAMPLE_RATE, trackId }, '[AudioSignal] resampling preview to the analysis rate');
    }
    rawPath = path.join(tempDir, `${trackId}.raw`);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(mp3Path)
        .audioChannels(1)
        .audioFrequency(SIGNAL_SAMPLE_RATE)
        .audioCodec('pcm_f32le')
        .format('f32le')
        .output(rawPath!)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run();
    });
    const buffer = await fsp.readFile(rawPath);
    const signal = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
    if (signal.length < MIN_SIGNAL_FRAMES) {
      // A decode that produced a handful of frames is a real ffmpeg exit code
      // 0 with no audio in it. Returning it would let a caller believe it
      // holds a signal.
      throw new Error(`Decoded ${signal.length} frames, below the ${MIN_SIGNAL_FRAMES} needed to analyse`);
    }
    return { signal, sampleRate: SIGNAL_SAMPLE_RATE };
  } finally {
    // CORRECT AS IS: cleanup only. The return value above is already
    // computed, so a failed unlink must NOT turn a successful decode into a
    // thrown error — and on the throw path the caller already gets the real
    // error, which is what leaves bpm/key null in trackDetailsService.
    await fsp.unlink(mp3Path).catch(() => undefined);
    if (rawPath) await fsp.unlink(rawPath).catch(() => undefined);
  }
}

/**
 * Decode an already-encoded audio FILE to PCM and build its base64 waveform.
 *
 * Separate from {@link getAudioSignalAndSr} on purpose: that one takes a
 * preview URL and resamples to the analysis rate for BPM/key, this one reads
 * a local file (the transcode `downloadAndConvert` just wrote) and returns the
 * waveform Discord requires alongside flag 8192.
 *
 * Throws rather than returning a placeholder when the file cannot be decoded.
 * The caller has no honest way to render a voice message without the field —
 * Discord answers 400/50161 — so a decode failure has to reach the user as a
 * failed preview rather than be papered over with a drawn array.
 */
export async function buildVoiceWaveform(filePath: string): Promise<string> {
  const rawPath = path.join(tempDir, `waveform-${path.basename(filePath)}.raw`);
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(filePath)
        .audioChannels(1)
        .audioFrequency(SIGNAL_SAMPLE_RATE)
        .audioCodec('pcm_f32le')
        .format('f32le')
        .output(rawPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run();
    });
    const buffer = await fsp.readFile(rawPath);
    const signal = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
    if (signal.length === 0) throw new Error('Decoded no frames, so there is no waveform to report');
    return encodeVoiceWaveform(signal, SIGNAL_SAMPLE_RATE);
  } finally {
    // CORRECT AS IS: cleanup only. The waveform is computed into a local
    // before this runs, and a failed unlink must not turn a real waveform
    // into a thrown error the caller renders as "no preview".
    await fsp.unlink(rawPath).catch(() => undefined);
  }
}

export function cleanupSync(p: string): void {
  // CORRECT AS IS: best-effort synchronous unlink of a temp file whose
  // caller has already finished with it. Nothing downstream reads the file
  // afterwards, so a leftover is the only possible consequence.
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
}
void cp;
