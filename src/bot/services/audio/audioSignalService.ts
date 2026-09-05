import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import cp from 'child_process';
import { Logger } from '@domain/logger';

import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import ffmpegFluent from 'fluent-ffmpeg';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ffmpeg: any = null;
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

export async function downloadMP3(url: string, trackId: string): Promise<string> {
  const mp3Path = path.join(tempDir, `${trackId}.mp3`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download preview (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(mp3Path, buf);
  return mp3Path;
}

export async function downloadAndConvert(url: string, trackId: string, duration?: number): Promise<string> {
  const mp3Path = await downloadMP3(url, trackId);
  const oggPath = path.join(tempDir, `${trackId}.ogg`);
  await new Promise<void>((resolve, reject) => {
    let cmd = ffmpeg(mp3Path).noVideo().audioChannels(1).audioCodec('libopus').format('ogg').outputOptions(['-vbr on']);
    if (duration) cmd = cmd.duration(duration);
    cmd.output(oggPath).on('end', () => resolve()).on('error', (err: any) => reject(err)).run();
  });
  await fsp.unlink(mp3Path).catch(() => undefined);
  return oggPath;
}

export async function getAudioSignalAndSr(trackId: string, url: string): Promise<{ signal: Float32Array; sampleRate: number }> {
  const mp3Path = await downloadMP3(url, trackId);
  let rawPath: string | undefined;
  try {
    const metadata: any = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(mp3Path, (err: any, data: any) => (err ? reject(err) : resolve(data)));
    });
    const audioStream = metadata?.streams?.find((s: any) => s.codec_type === 'audio');
    const sampleRate = audioStream?.sample_rate ? Number(audioStream.sample_rate) : 44100;
    rawPath = path.join(tempDir, `${trackId}.raw`);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(mp3Path).audioChannels(1).audioCodec('pcm_f32le').format('f32le').output(rawPath!).on('end', () => resolve()).on('error', (err: any) => reject(err)).run();
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
