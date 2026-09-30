import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { TextChannel } from 'discord.js';
import { ImageUploadService } from './imageUploadService';
import { ConfigData } from '@bot/configurations/configData';

/**
 * Staging a rendered chart to a scratch channel.
 *
 * The service answers `null` for "could not upload" and never throws, because
 * `chartService` reads that null as "no staging channel" and falls back to
 * returning the raw buffer to the caller — which is the difference between a
 * user seeing their chart and seeing an error. So `null` is a working answer
 * here and not a silent failure.
 *
 * Two false-negatives are guarded: a channel id of `'0'` (the unconfigured
 * default, which is a real snowflake shape and would be fetched) and a channel
 * that exists but is not text-based.
 */

const setStaging = (value: string | undefined) => {
  (ConfigData.Data.bot as { stagingChannelId: string | undefined }).stagingChannelId = value;
};

const original = ConfigData.Data.bot.stagingChannelId;

/** A `TextChannel`-shaped object that really is an instance, since the service
 *  uses `instanceof` and a plain object double would always be rejected. */
const channelDouble = () => {
  const channel = Object.create(TextChannel.prototype) as Record<string, unknown>;
  const sent: Array<Record<string, unknown>> = [];
  channel.isTextBased = () => true;
  channel.send = vi.fn(async (payload: Record<string, unknown>) => {
    sent.push(payload);
    return { attachments: { first: () => ({ url: 'https://cdn/chart.png' }) } };
  });
  return { channel, sent };
};

let service: ImageUploadService;
let client: { channels: { fetch: ReturnType<typeof vi.fn> } };

beforeEach(() => {
  client = { channels: { fetch: vi.fn(async () => null) } };
  service = new ImageUploadService(client as never);
});

// `ConfigData` is module-level state shared by the whole process, so the
// configured staging id is put back rather than left as whichever value the
// last test happened to need.
afterAll(() => setStaging(original));

describe('ImageUploadService.uploadToStagingChannel', () => {
  it('uploads and returns the attachment URL', async () => {
    setStaging('800');
    const { channel, sent } = channelDouble();
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(channel);

    const url = await service.uploadToStagingChannel(Buffer.from('png'), 'chart.png', '3x3 album chart');

    expect(url).toBe('https://cdn/chart.png');
    expect(sent[0]).toMatchObject({
      files: [{ attachment: expect.anything(), name: 'chart.png', description: '3x3 album chart' }],
    });
  });

  it('sends the buffer under the exact file name it was given', async () => {
    setStaging('800');
    const { channel, sent } = channelDouble();
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(channel);
    const buffer = Buffer.from('png');

    await service.uploadToStagingChannel(buffer, 'artist-chart-5w-2h-Alltime-user.png');

    expect(sent[0]).toMatchObject({ files: [{ attachment: buffer, name: 'artist-chart-5w-2h-Alltime-user.png' }] });
  });

  it('sends no description when the caller did not give one', async () => {
    setStaging('800');
    const { channel, sent } = channelDouble();
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(channel);

    await service.uploadToStagingChannel(Buffer.from('png'), 'chart.png');

    const payload = sent[0] as unknown as { files: Array<{ description?: string }> };
    expect(payload.files[0]?.description).toBeUndefined();
  });

  it('fetches the configured channel, not one it invented', async () => {
    setStaging('800');
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(channelDouble().channel);

    await service.uploadToStagingChannel(Buffer.from('png'), 'chart.png');

    expect(client.channels.fetch).toHaveBeenCalledWith('800');
  });
});

describe('ImageUploadService — every "no staging" answer, and why', () => {
  it('answers null without fetching when no channel is configured', async () => {
    // The dev default. Chart callers turn this null into "return the buffer",
    // so a fetch here would be a wasted API call on every chart.
    setStaging(undefined);
    await expect(service.uploadToStagingChannel(Buffer.from('png'), 'chart.png')).resolves.toBeNull();
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it('treats the placeholder id "0" as unconfigured', async () => {
    // `'0'` is a syntactically valid snowflake, so without this guard the bot
    // would upload every chart to a channel that does not exist.
    setStaging('0');
    await expect(service.uploadToStagingChannel(Buffer.from('png'), 'chart.png')).resolves.toBeNull();
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it('answers null when the channel no longer exists', async () => {
    setStaging('800');
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(service.uploadToStagingChannel(Buffer.from('png'), 'chart.png')).resolves.toBeNull();
  });

  it('answers null when the channel is not text-based', async () => {
    setStaging('800');
    const voice = { isTextBased: () => false };
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(voice);
    await expect(service.uploadToStagingChannel(Buffer.from('png'), 'chart.png')).resolves.toBeNull();
  });

  it('answers null rather than uploading to a channel it cannot type-check', async () => {
    // `instanceof TextChannel` is what rejects a structurally-correct double
    // and a partial: `channel.send` is not something to discover at runtime.
    setStaging('800');
    const structural = { isTextBased: () => true, send: vi.fn() };
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(structural);
    await expect(service.uploadToStagingChannel(Buffer.from('png'), 'chart.png')).resolves.toBeNull();
    expect(structural.send).not.toHaveBeenCalled();
  });

  it('answers null when the fetch itself fails', async () => {
    setStaging('800');
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Missing Access'));
    await expect(service.uploadToStagingChannel(Buffer.from('png'), 'chart.png')).resolves.toBeNull();
  });

  it('answers null when the upload is rejected, instead of throwing at the caller', async () => {
    // Missing Permissions on the staging channel is a routine configuration
    // state; it must degrade to "no URL" so the chart still reaches the user.
    setStaging('800');
    const channel = Object.create(TextChannel.prototype) as Record<string, unknown>;
    channel.isTextBased = () => true;
    channel.send = vi.fn(async () => { throw new Error('Missing Permissions'); });
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(channel);

    await expect(service.uploadToStagingChannel(Buffer.from('png'), 'chart.png')).resolves.toBeNull();
  });

  it('answers null when the message came back with no attachment', async () => {
    setStaging('800');
    const channel = Object.create(TextChannel.prototype) as Record<string, unknown>;
    channel.isTextBased = () => true;
    channel.send = vi.fn(async () => ({ attachments: { first: () => undefined } }));
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(channel);

    await expect(service.uploadToStagingChannel(Buffer.from('png'), 'chart.png')).resolves.toBeNull();
  });
});
