import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { getAudioDurationInSeconds } from 'get-audio-duration';
import { Logger } from '@domain/logger';

export const previewMap = new Map<string, string>();

async function getDuration(oggPath: string): Promise<number> {
  try {
    const ffprobePath = process.env.FFPROBE_PATH || (fsSync.existsSync('/usr/bin/ffprobe') ? '/usr/bin/ffprobe' : undefined);
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

    const res = await fetch(`https://discord.com/api/v10/webhooks/${appId}/${interactionToken}`, {
      method: 'POST',
      headers: { Authorization: `Bot ${botToken}` },
      body: form as any,
    });
    if (!res.ok) {
      const txt = await res.text();
      Logger.warn({ txt }, '[VoiceMessage] webhook send failed');
      throw new Error(`Webhook send failed ${res.status}: ${txt}`);
    }
  }

  // Send via channel attachments endpoint (text commands / preview button)
  public async sendViaChannel(channelId: string, oggPath: string, botToken: string, replyToMessageId?: string): Promise<any> {
    const duration = await getDuration(oggPath);
    const stat = await fs.stat(oggPath);
    const fileName = path.basename(oggPath);

    // Step 1: request upload url (Discord attachments endpoint)
    const reqBody = { files: [{ filename: fileName, file_size: stat.size, id: '0' }] };
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/attachments`, {
      method: 'POST',
      body: JSON.stringify(reqBody),
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
    });
    if (!res.ok) throw new Error(`attach req failed ${res.status} ${await res.text()}`);
    const data: any = await res.json();

    // Step 2: PUT to upload_url
    const putRes = await fetch(data.attachments[0].upload_url, {
      method: 'PUT',
      body: await fs.readFile(oggPath),
      headers: { 'Content-Type': 'audio/ogg' },
    });
    if (!putRes.ok) throw new Error(`PUT failed ${putRes.status}`);

    const waveBuf = Buffer.alloc(100);
    for (let i = 0; i < 100; i++) waveBuf[i] = Math.floor(20 + Math.random() * 130);

    const payload: any = {
      attachments: [{ id: '0', filename: fileName, uploaded_filename: data.attachments[0].upload_filename, duration_secs: Number.isFinite(duration) ? duration : 30, waveform: waveBuf.toString('base64') }],
      flags: 8192,
    };
    if (replyToMessageId) payload.message_reference = { message_id: replyToMessageId };

    const res3 = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
    });
    if (!res3.ok) throw new Error(`send message failed ${res3.status} ${await res3.text()}`);
    return res3.json();
  }
}
