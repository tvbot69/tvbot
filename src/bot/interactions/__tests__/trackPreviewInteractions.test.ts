import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageFlags } from 'discord.js';
import { TrackPreviewInteractions, TRACK_PREVIEW_PREFIX } from '@bot/interactions/trackPreviewInteractions';
import { setPreview } from '@bot/services/audio/voiceMessageService';
import { Logger } from '@domain/logger';
import type { ButtonInteraction } from 'discord.js';

// `downloadAndConvert` shells out to ffmpeg and the network, and ConfigData
// reads the developer's own .env - both are pinned so the tests are hermetic and
// so the webhook-vs-channel branch is decided by the test, not by local env.
const mocks = vi.hoisted(() => ({
  discord: { token: 'bot-token', applicationId: 'app-123' },
  downloadAndConvert: vi.fn(),
}));

vi.mock('@bot/configurations/configData', () => ({
  ConfigData: {
    get Data() {
      return { discord: mocks.discord };
    },
  },
}));

vi.mock('@bot/services/audio/audioSignalService', () => ({
  downloadAndConvert: mocks.downloadAndConvert,
}));

const OGG_PATH = 'C:/temp/abc123.ogg';
const PREVIEW_URL = 'https://cdn.example/preview.mp3';

// previewMap is module-level and never cleared, so each test owns a unique id.
let idSeq = 0;
const registerPreview = (url = PREVIEW_URL): string => {
  const id = `preview${++idSeq}`;
  setPreview(id, url);
  return id;
};

const makeButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    user: { id: 'user1' },
    channelId: 'chan1',
    token: 'interaction-token',
    isButton: vi.fn(() => true),
    message: { id: 'msg1' },
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    isButton: ReturnType<typeof vi.fn>;
  };

const build = () => {
  const voiceService = {
    sendViaWebhook: vi.fn(async () => undefined),
    sendViaChannel: vi.fn(async () => undefined),
  };
  const tpi = new TrackPreviewInteractions(voiceService as never);
  return { tpi, voiceService };
};

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.discord.token = 'bot-token';
  mocks.discord.applicationId = 'app-123';
  mocks.downloadAndConvert.mockReset();
  mocks.downloadAndConvert.mockResolvedValue(OGG_PATH);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TrackPreviewInteractions.handle — routing', () => {
  it('returns early for an unrelated customId', async () => {
    const { tpi, voiceService } = build();
    const press = makeButton('crowns-page:first:user1:target1:Playcount:1');

    await tpi.handle(press);

    expect(mocks.downloadAndConvert).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
    expect(voiceService.sendViaWebhook).not.toHaveBeenCalled();
    expect(voiceService.sendViaChannel).not.toHaveBeenCalled();
  });

  it('replies that the preview expired when the id is unknown', async () => {
    const { tpi, voiceService } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}never-registered`);

    await tpi.handle(press);

    expect(press.reply).toHaveBeenCalledTimes(1);
    const payload = press.reply.mock.calls[0]![0] as { content: string; flags: number };
    expect(payload.content).toBe('❌ Preview expired.');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(mocks.downloadAndConvert).not.toHaveBeenCalled();
    expect(voiceService.sendViaChannel).not.toHaveBeenCalled();
  });

  it('swallows a reply rejection on the expired path', async () => {
    const { tpi } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}never-registered`, {
      reply: vi.fn(async () => {
        throw new Error('already acknowledged');
      }),
    });

    await expect(tpi.handle(press)).resolves.toBeUndefined();
  });

  it('does not defer when the preview has already expired', async () => {
    const { tpi } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}never-registered`);

    await tpi.handle(press);

    expect(press.deferUpdate).not.toHaveBeenCalled();
  });
});

describe('TrackPreviewInteractions.handle — id parsing', () => {
  it('uses the whole remainder when there is no context suffix', async () => {
    const id = registerPreview();
    const { tpi } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`);

    await tpi.handle(press);

    expect(mocks.downloadAndConvert).toHaveBeenCalledWith(PREVIEW_URL, id);
  });

  it('strips a trailing context suffix to recover the real id', async () => {
    const id = registerPreview();
    const { tpi } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}:fm`);

    await tpi.handle(press);

    expect(mocks.downloadAndConvert).toHaveBeenCalledWith(PREVIEW_URL, id);
    expect(mocks.downloadAndConvert).not.toHaveBeenCalledWith(PREVIEW_URL, `${id}:fm`);
  });

  it('treats an empty remainder as expired', async () => {
    const { tpi } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}`);

    await tpi.handle(press);

    expect(press.reply).toHaveBeenCalledTimes(1);
    expect(mocks.downloadAndConvert).not.toHaveBeenCalled();
  });

  it('resolves a different url per id', async () => {
    const idA = registerPreview('https://cdn.example/a.mp3');
    const idB = registerPreview('https://cdn.example/b.mp3');
    const { tpi } = build();

    await tpi.handle(makeButton(`${TRACK_PREVIEW_PREFIX}${idA}`));
    await tpi.handle(makeButton(`${TRACK_PREVIEW_PREFIX}${idB}:fm`));

    expect(mocks.downloadAndConvert).toHaveBeenNthCalledWith(1, 'https://cdn.example/a.mp3', idA);
    expect(mocks.downloadAndConvert).toHaveBeenNthCalledWith(2, 'https://cdn.example/b.mp3', idB);
  });
});

describe('TrackPreviewInteractions.handle — webhook delivery', () => {
  it('sends via webhook when a token and a real application id are present', async () => {
    const id = registerPreview();
    const { tpi, voiceService } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`);

    await tpi.handle(press);

    expect(voiceService.sendViaWebhook).toHaveBeenCalledWith('app-123', 'interaction-token', OGG_PATH, 'bot-token');
    expect(voiceService.sendViaChannel).not.toHaveBeenCalled();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not reply after a successful webhook send', async () => {
    const id = registerPreview();
    const { tpi } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`);

    await tpi.handle(press);

    expect(press.reply).not.toHaveBeenCalled();
    expect(press.followUp).not.toHaveBeenCalled();
  });

  it('falls back to the channel when the webhook send throws', async () => {
    const id = registerPreview();
    const loggerSpy = vi.spyOn(Logger, 'warn').mockReturnValue(undefined as never);
    const { tpi, voiceService } = build();
    voiceService.sendViaWebhook.mockRejectedValueOnce(new Error('webhook 404'));
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`);

    await tpi.handle(press);

    expect(voiceService.sendViaWebhook).toHaveBeenCalledTimes(1);
    expect(voiceService.sendViaChannel).toHaveBeenCalledTimes(1);
    expect(loggerSpy).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), '[TrackPreview] webhook send failed, falling back to channel send');
  });

  it('falls back to the channel when the interaction is not a button', async () => {
    const id = registerPreview();
    const { tpi, voiceService } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`, { isButton: vi.fn(() => false) });

    await tpi.handle(press);

    expect(voiceService.sendViaWebhook).not.toHaveBeenCalled();
    expect(voiceService.sendViaChannel).toHaveBeenCalledTimes(1);
  });

  it('falls back to the channel when there is no interaction token', async () => {
    const id = registerPreview();
    const { tpi, voiceService } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`, { token: undefined });

    await tpi.handle(press);

    expect(voiceService.sendViaWebhook).not.toHaveBeenCalled();
    expect(voiceService.sendViaChannel).toHaveBeenCalledTimes(1);
  });

  it('falls back to the channel when the application id is the default "0"', async () => {
    mocks.discord.applicationId = '0';
    const id = registerPreview();
    const { tpi, voiceService } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`);

    await tpi.handle(press);

    expect(voiceService.sendViaWebhook).not.toHaveBeenCalled();
    expect(voiceService.sendViaChannel).toHaveBeenCalledTimes(1);
  });

  it('falls back to the channel when the application id is empty', async () => {
    mocks.discord.applicationId = '';
    const id = registerPreview();
    const { tpi, voiceService } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`);

    await tpi.handle(press);

    expect(voiceService.sendViaWebhook).not.toHaveBeenCalled();
    expect(voiceService.sendViaChannel).toHaveBeenCalledTimes(1);
  });
});

describe('TrackPreviewInteractions.handle — channel delivery', () => {
  it('passes channel, path, bot token and message id', async () => {
    const id = registerPreview();
    mocks.discord.applicationId = '0';
    const { tpi, voiceService } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`);

    await tpi.handle(press);

    expect(voiceService.sendViaChannel).toHaveBeenCalledWith('chan1', OGG_PATH, 'bot-token', 'msg1');
  });

  it('tolerates a button with no message', async () => {
    const id = registerPreview();
    mocks.discord.applicationId = '0';
    const { tpi, voiceService } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`, { message: undefined });

    await tpi.handle(press);

    expect(voiceService.sendViaChannel).toHaveBeenCalledWith('chan1', OGG_PATH, 'bot-token', undefined);
  });

  it('defers before doing any audio work', async () => {
    const id = registerPreview();
    const order: string[] = [];
    mocks.downloadAndConvert.mockImplementation(async () => {
      order.push('convert');
      return OGG_PATH;
    });
    const { tpi } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`, {
      deferUpdate: vi.fn(async () => {
        order.push('defer');
        return undefined;
      }),
    });

    await tpi.handle(press);

    expect(order).toEqual(['defer', 'convert']);
  });

  it('swallows a deferUpdate rejection and still delivers', async () => {
    const id = registerPreview();
    const { tpi, voiceService } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`, {
      deferUpdate: vi.fn(async () => {
        throw new Error('too late');
      }),
    });

    await expect(tpi.handle(press)).resolves.toBeUndefined();
    expect(voiceService.sendViaWebhook).toHaveBeenCalledTimes(1);
  });
});

describe('TrackPreviewInteractions.handle — in-flight guard', () => {
  // Two presses racing on the same handle: every download is held open so the
  // guard's window is genuinely in flight. Resolvers are collected in a list,
  // not a single `release` variable — a second download would overwrite it and
  // leave the first promise pending forever.
  let pending: Array<(path: string) => void>;

  beforeEach(() => {
    pending = [];
    mocks.downloadAndConvert.mockImplementation(
      () => new Promise<string>((resolve) => { pending.push(resolve); }),
    );
  });

  const settleAll = async (expected = 1) => {
    for (let spin = 0; spin < 200 && pending.length < expected; spin += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    while (pending.length > 0) {
      const batch = pending.splice(0, pending.length);
      for (const resolve of batch) resolve(OGG_PATH);
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  it('rejects a second press for the same user and track while one is running', async () => {
    const id = registerPreview();
    const { tpi, voiceService } = build();

    const first = tpi.handle(makeButton(`${TRACK_PREVIEW_PREFIX}${id}`));
    await tpi.handle(makeButton(`${TRACK_PREVIEW_PREFIX}${id}`));
    await settleAll();
    await first;

    expect(mocks.downloadAndConvert).toHaveBeenCalledTimes(1);
    expect(voiceService.sendViaWebhook).toHaveBeenCalledTimes(1);
  });

  it('replies "still working" without deferring or downloading', async () => {
    const id = registerPreview();
    const { tpi } = build();

    const first = tpi.handle(makeButton(`${TRACK_PREVIEW_PREFIX}${id}`));
    const second = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`);
    await tpi.handle(second);
    await settleAll();
    await first;

    expect(second.reply).toHaveBeenCalledTimes(1);
    const payload = second.reply.mock.calls[0]![0] as { content: string; flags: number };
    expect(payload.content).toBe('⏳ Still working on that preview — give it a moment.');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(second.deferUpdate).not.toHaveBeenCalled();
  });

  it('ignores the context suffix when keying the in-flight guard', async () => {
    const id = registerPreview();
    const { tpi } = build();

    const first = tpi.handle(makeButton(`${TRACK_PREVIEW_PREFIX}${id}`));
    const second = makeButton(`${TRACK_PREVIEW_PREFIX}${id}:fm`);
    await tpi.handle(second);
    await settleAll();
    await first;

    expect(second.reply).toHaveBeenCalledTimes(1);
    expect(mocks.downloadAndConvert).toHaveBeenCalledTimes(1);
  });

  it('lets a different user run the same track concurrently', async () => {
    const id = registerPreview();
    const { tpi } = build();

    const first = tpi.handle(makeButton(`${TRACK_PREVIEW_PREFIX}${id}`));
    const other = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`, { user: { id: 'user2' } });
    // NOT awaited before settling: this press reaches its own download, which
    // only settles once the guard question has already been answered.
    const otherPress = tpi.handle(other);
    await settleAll(2);
    await Promise.all([first, otherPress]);

    expect(other.reply).not.toHaveBeenCalled();
    expect(other.deferUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.downloadAndConvert).toHaveBeenCalledTimes(2);
  });

  it('lets the same user run a different track concurrently', async () => {
    const idA = registerPreview();
    const idB = registerPreview();
    const { tpi } = build();

    const first = tpi.handle(makeButton(`${TRACK_PREVIEW_PREFIX}${idA}`));
    const other = makeButton(`${TRACK_PREVIEW_PREFIX}${idB}`);
    const otherPress = tpi.handle(other);
    await settleAll(2);
    await Promise.all([first, otherPress]);

    expect(other.reply).not.toHaveBeenCalled();
    expect(other.deferUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.downloadAndConvert).toHaveBeenCalledTimes(2);
  });

  it('releases the key after a successful send', async () => {
    const id = registerPreview();
    mocks.downloadAndConvert.mockReset();
    mocks.downloadAndConvert.mockResolvedValue(OGG_PATH);
    const { tpi } = build();

    await tpi.handle(makeButton(`${TRACK_PREVIEW_PREFIX}${id}`));
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`);
    await tpi.handle(press);

    expect(press.reply).not.toHaveBeenCalled();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.downloadAndConvert).toHaveBeenCalledTimes(2);
  });

  it('releases the key after a failed send', async () => {
    const id = registerPreview();
    vi.spyOn(Logger, 'error').mockReturnValue(undefined as never);
    mocks.downloadAndConvert.mockReset();
    mocks.downloadAndConvert.mockRejectedValueOnce(new Error('ffmpeg died'));
    mocks.downloadAndConvert.mockResolvedValue(OGG_PATH);
    const { tpi } = build();

    await tpi.handle(makeButton(`${TRACK_PREVIEW_PREFIX}${id}`));
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`);
    await tpi.handle(press);

    expect(press.reply).not.toHaveBeenCalled();
    expect(mocks.downloadAndConvert).toHaveBeenCalledTimes(2);
  });
});

describe('TrackPreviewInteractions.handle — failure path', () => {
  it('follows up ephemerally when the conversion throws', async () => {
    const id = registerPreview();
    const loggerSpy = vi.spyOn(Logger, 'error').mockReturnValue(undefined as never);
    mocks.downloadAndConvert.mockRejectedValue(new Error('ffmpeg died'));
    const { tpi, voiceService } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`);

    await tpi.handle(press);

    expect(press.followUp).toHaveBeenCalledTimes(1);
    const payload = press.followUp.mock.calls[0]![0] as { content: string; flags: number };
    expect(payload.content).toBe('⚠️ Failed to send preview.');
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(voiceService.sendViaWebhook).not.toHaveBeenCalled();
    expect(voiceService.sendViaChannel).not.toHaveBeenCalled();
    expect(loggerSpy).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), '[TrackPreview] failed to send voice preview');
  });

  it('follows up when both delivery paths fail', async () => {
    const id = registerPreview();
    vi.spyOn(Logger, 'warn').mockReturnValue(undefined as never);
    vi.spyOn(Logger, 'error').mockReturnValue(undefined as never);
    const { tpi, voiceService } = build();
    voiceService.sendViaWebhook.mockRejectedValueOnce(new Error('webhook 404'));
    voiceService.sendViaChannel.mockRejectedValueOnce(new Error('no permission'));
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`);

    await tpi.handle(press);

    expect(voiceService.sendViaChannel).toHaveBeenCalledTimes(1);
    expect(press.followUp).toHaveBeenCalledTimes(1);
  });

  it('swallows a followUp rejection', async () => {
    const id = registerPreview();
    vi.spyOn(Logger, 'error').mockReturnValue(undefined as never);
    mocks.downloadAndConvert.mockRejectedValue(new Error('ffmpeg died'));
    const { tpi } = build();
    const press = makeButton(`${TRACK_PREVIEW_PREFIX}${id}`, {
      followUp: vi.fn(async () => {
        throw new Error('interaction gone');
      }),
    });

    await expect(tpi.handle(press)).resolves.toBeUndefined();
    expect(press.followUp).toHaveBeenCalledTimes(1);
  });
});
