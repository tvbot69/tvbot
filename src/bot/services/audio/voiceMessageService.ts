import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { getAudioDurationInSeconds } from 'get-audio-duration';
import { Logger } from '@domain/logger';
import { ffprobePath as configuredFfprobePath } from '@config/runtimeEnv';

/**
 * Preview URL hand-off between a command that resolves one and the button
 * that plays it. Bounded + expiring on purpose: it used to be a plain Map
 * that only ever grew, so every /track leaked an entry for the process
 * lifetime AND its Preview button stayed clickable forever — each press
 * re-running a download plus an ffmpeg transcode, on demand, with no limit.
 */
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const PREVIEW_MAX_ENTRIES = 500;
const previewExpiry = new Map<string, number>();

const evictExpiredPreviews = (now: number): void => {
  for (const [key, expiresAt] of previewExpiry) {
    if (expiresAt <= now) {
      previewExpiry.delete(key);
      previewMap.delete(key);
    }
  }
  // Hard cap in case entries are created faster than they expire.
  while (previewMap.size > PREVIEW_MAX_ENTRIES) {
    const oldest = previewExpiry.keys().next();
    if (oldest.done) break;
    previewExpiry.delete(oldest.value);
    previewMap.delete(oldest.value);
  }
};

/** Bound on every Discord CDN/API call here: a stalled upload otherwise
 * hangs the interaction forever. */
const DISCORD_TIMEOUT_MS = 20_000;

const fetchTimeout = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, { ...init, signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS) });

export const previewMap = new Map<string, string>();

/** Register a resolvable preview, replacing any previous entry for the id. */
export const setPreview = (id: string, url: string): void => {
  const now = Date.now();
  evictExpiredPreviews(now);
  previewMap.set(id, url);
  previewExpiry.set(id, now + PREVIEW_TTL_MS);
};

/** Fetch a preview if it has not expired. */
export const getPreview = (id: string): string | undefined => {
  const expiresAt = previewExpiry.get(id);
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    previewExpiry.delete(id);
    previewMap.delete(id);
    return undefined;
  }
  return previewMap.get(id);
};

async function getDuration(oggPath: string): Promise<number> {
  try {
    // The configured path comes from audioSignalService's import-time
    // resolution (see its write-back). Read lazily here, not at module scope:
    // this file does not import audioSignalService, so on a cold import order
    // the value may not be published yet.
    const ffprobePath = configuredFfprobePath() || (fsSync.existsSync('/usr/bin/ffprobe') ? '/usr/bin/ffprobe' : undefined);
    const duration = Number(await getAudioDurationInSeconds(oggPath, ffprobePath));
    return Number.isFinite(duration) && duration > 0 ? duration : 30;
  } catch (err) {
    Logger.warn({ err }, '[VoiceMessage] Failed to get audio duration, defaulting to 30s');
    return 30;
  }
}

async function generateWaveformAndDuration(oggPath: string, _isAac: boolean): Promise<{ waveform: string; duration: number }> {
  const waveBuf = Buffer.alloc(100);
  for (let i = 0; i < 100; i++) waveBuf[i] = Math.floor(20 + Math.random() * 130);
  const duration = await getDuration(oggPath);
  return { waveform: waveBuf.toString('base64'), duration };
}

export class VoiceMessageService {
  // Send via interaction webhook (slash) — preferred, shows as followup with flags 8192
  public async sendViaWebhook(appId: string, interactionToken: string, oggPath: string, botToken: string): Promise<void> {
    const durationInfo = await generateWaveformAndDuration(oggPath, oggPath.endsWith('.m4a'));
    const oggBytes = await fs.readFile(oggPath);

    // Use multipart webhook: payload_json + files[0]
    const form = new FormData();
    const blob = new Blob([oggBytes], { type: 'audio/ogg' });
    form.append('files[0]', blob, 'voice-message.ogg');
    const payload = {
      flags: 8192,
      attachments: [{ id: '0', filename: 'voice-message.ogg', duration_secs: durationInfo.duration, waveform: durationInfo.waveform }],
    };
    form.append('payload_json', JSON.stringify(payload));

    const res = await fetchTimeout(`https://discord.com/api/v10/webhooks/${appId}/${interactionToken}`, {
      method: 'POST',
      headers: { Authorization: `Bot ${botToken}` },
      body: form,
    });
    if (!res.ok) {
      const txt = await res.text();
      Logger.warn({ txt }, '[VoiceMessage] webhook send failed');
      throw new Error(`Webhook send failed ${res.status}: ${txt}`);
    }
  }

  // Send via channel attachments endpoint (text commands / preview button)
  public async sendViaChannel(channelId: string, oggPath: string, botToken: string, replyToMessageId?: string): Promise<void> {
    const duration = await getDuration(oggPath);
    const stat = await fs.stat(oggPath);
    const fileName = path.basename(oggPath);

    // Step 1: request upload url (Discord attachments endpoint)
    const reqBody = { files: [{ filename: fileName, file_size: stat.size, id: '0' }] };
    const res = await fetchTimeout(`https://discord.com/api/v10/channels/${channelId}/attachments`, {
      method: 'POST',
      body: JSON.stringify(reqBody),
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
    });
    if (!res.ok) throw new Error(`attach req failed ${res.status} ${await res.text()}`);
    const data = await res.json() as { attachments: { upload_url: string; upload_filename: string }[] };
    const attachment = data.attachments[0];
    if (!attachment) throw new Error('No attachment in response');

    // Step 2: PUT to upload_url
    const putRes = await fetchTimeout(attachment.upload_url, {
      method: 'PUT',
      body: await fs.readFile(oggPath),
      headers: { 'Content-Type': 'audio/ogg' },
    });
    if (!putRes.ok) throw new Error(`PUT failed ${putRes.status}`);

    const waveBuf = Buffer.alloc(100);
    for (let i = 0; i < 100; i++) waveBuf[i] = Math.floor(20 + Math.random() * 130);

    const payload = {
      attachments: [{ id: '0', filename: fileName, uploaded_filename: attachment.upload_filename, duration_secs: Number.isFinite(duration) ? duration : 30, waveform: waveBuf.toString('base64') }],
      flags: 8192,
    };
    if (replyToMessageId) (payload as Record<string, unknown>).message_reference = { message_id: replyToMessageId };

    const res3 = await fetchTimeout(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
    });
    if (!res3.ok) throw new Error(`send message failed ${res3.status} ${await res3.text()}`);
    return res3.json();
  }
}
