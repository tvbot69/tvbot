import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import cp from 'child_process';
import { Logger } from '@domain/logger';

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

try {
  const candidatesFfmpeg = [process.env.FFMPEG_PATH, 'C:\\tools\\ffmpeg\\bin\\ffmpeg.exe', '/usr/bin/ffmpeg'].filter(Boolean) as string[];
  for (const p of candidatesFfmpeg) if (fs.existsSync(p)) { resolvedFfmpeg = p; break; }
  if (!resolvedFfmpeg) {
    const pkg = (ffmpegStatic as unknown as { path?: string })?.path ?? ffmpegStatic;
    if (typeof pkg === 'string') resolvedFfmpeg = pkg;
  }
  const candidatesFfprobe = [process.env.FFPROBE_PATH, 'C:\\tools\\ffmpeg\\bin\\ffprobe.exe', '/usr/bin/ffprobe'].filter(Boolean) as string[];
  for (const p of candidatesFfprobe) if (fs.existsSync(p)) { resolvedFfprobe = p; break; }
  if (!resolvedFfprobe) {
    const pkg = (ffprobeStatic as unknown as { path?: string })?.path ?? ffprobeStatic;
    if (typeof pkg === 'string') resolvedFfprobe = pkg;
  }
  if (resolvedFfmpeg) process.env.FFMPEG_PATH = resolvedFfmpeg;
  if (resolvedFfprobe) process.env.FFPROBE_PATH = resolvedFfprobe;
  ffmpeg = ffmpegFluent;
  if (resolvedFfmpeg) ffmpeg.setFfmpegPath(resolvedFfmpeg);
  if (resolvedFfprobe) ffmpeg.setFfprobePath(resolvedFfprobe);
} catch (e) {
  Logger.warn({ err: e }, '[AudioSignal] ffmpeg init failed');
}

export const tempDir = path.join(os.tmpdir(), 'tvbot-audio');
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
    await fsp.unlink(mp3Path).catch(() => undefined);
    throw err;
  }
  await fsp.unlink(mp3Path).catch(() => undefined);
  return oggPath;
}

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
    const sampleRate = audioStream?.sample_rate ? Number(audioStream.sample_rate) : 44100;
    rawPath = path.join(tempDir, `${trackId}.raw`);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(mp3Path).audioChannels(1).audioCodec('pcm_f32le').format('f32le').output(rawPath!).on('end', () => resolve()).on('error', (err: Error) => reject(err)).run();
    });
    const buffer = await fsp.readFile(rawPath);
    const signal = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
    return { signal, sampleRate };
  } finally {
    await fsp.unlink(mp3Path).catch(() => undefined);
    if (rawPath) await fsp.unlink(rawPath).catch(() => undefined);
  }
}

export function cleanupSync(p: string): void {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
}
void cp;
