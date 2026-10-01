import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MusicCommands } from '@bot/textCommands/music/musicCommands';
import { MusicBuilders } from '@bot/builders/music/musicBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';

/**
 * musicCommands was 36.7% with 457 uncovered lines.
 *
 * Two things here are worth pinning beyond the ordinary guards:
 *
 *  1. `withControl` is the requester-or-admin gate. Without it the buttons were
 *     requester-only while every text command was open to the whole server, so
 *     anyone could skip or steal the queue. The rule is deliberately narrow:
 *     DM (no guild) is exempt, because there is nobody to gate against.
 *
 *  2. The queue page is parsed with a guard. "abc" used to become NaN, which
 *     the builder's clamp passed straight through - producing an empty "Up
 *     Next" list with a "Page NaN/3" footer. That is a visible artefact of an
 *     unvalidated number, and the test asserts the real number.
 */

const mkContext = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    prefix: '.',
    member: { voice: { channelId: 'voice-1' }, displayName: 'Caller' },
    interaction: { channelId: 'text-1' },
    message: { channelId: 'text-1', id: 'm1' },
    userIsGuildAdmin: false,
    ...over,
  }) as unknown as ContextModel;

const build = (over: Record<string, unknown> = {}) => {
  const musicService = {
    canControlPlayback: vi.fn(() => true),
    getQueueInfo: vi.fn(() => ({ current: { title: 'Airbag' }, guildUsers: [], tracks: [] })),
    searchTracks: vi.fn(async (..._a: unknown[]) => []),
    skip: vi.fn(async () => true),
    ...(over.musicService as object),
  };
  const colorService = { getAccentColorAsync: vi.fn(async () => undefined) };
  const service = new MusicCommands(
    musicService as never,
    colorService as never,
    undefined,
    undefined,
  );
  return { service, musicService, colorService };
};

const call = (service: MusicCommands, name: string, ...args: unknown[]) => {
  const h = service as unknown as Record<string, (...a: unknown[]) => Promise<{ commandResponse?: CommandResponse }>>;
  return h[name]!.bind(service)(...args);
};

const withControl = (service: MusicCommands, context: ContextModel) =>
  (service as unknown as { withControl(c: ContextModel, r: () => Promise<unknown>): Promise<{ commandResponse?: CommandResponse }> })
    .withControl(context, async () => ({ commandResponse: CommandResponse.Ok }));

beforeEach(() => {
  vi.restoreAllMocks();
  for (const n of ['buildQueueResponse', 'buildNowPlayingResponse', 'buildSearchResponse'] as const) {
    vi.spyOn(MusicBuilders, n).mockReturnValue({ embed: {} } as never);
  }
});

describe('MusicCommands.withControl gate', () => {
  it('allows the requester', async () => {
    const { service } = build();
    const result = await withControl(service, mkContext());
    expect(result.commandResponse).toBe(CommandResponse.Ok);
  });

  it('refuses a non-requester who is not an admin', async () => {
    const { service, musicService } = build();
    (musicService.canControlPlayback as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const result = await withControl(service, mkContext());
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('does not gate in a DM, because there is nobody to gate against', async () => {
    const { service, musicService } = build();
    (musicService.canControlPlayback as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const result = await withControl(service, mkContext({ guildId: undefined }));
    expect(result.commandResponse).toBe(CommandResponse.Ok);
  });

  it('passes the admin flag through to the permission check', async () => {
    const { service, musicService } = build();
    await withControl(service, mkContext({ userIsGuildAdmin: true }));
    expect(musicService.canControlPlayback).toHaveBeenCalledWith('222', '111', true);
  });
});

describe('MusicCommands.getGuildAndMember', () => {
  const probe = (service: MusicCommands, context: ContextModel) =>
    (service as unknown as { getGuildAndMember(c: ContextModel): Promise<unknown> }).getGuildAndMember(context);

  it('returns null outside a guild', async () => {
    const { service } = build();
    await expect(probe(service, mkContext({ guildId: undefined }))).resolves.toBeNull();
  });

  it('returns null when the member has no voice channel', async () => {
    const { service } = build();
    await expect(probe(service, mkContext({ member: { displayName: 'x' } }))).resolves.toBeNull();
  });

  it('returns null when there is no text channel to reply in', async () => {
    const { service } = build();
    await expect(probe(service, mkContext({ interaction: undefined, message: undefined }))).resolves.toBeNull();
  });

  it('returns the ids when everything is present', async () => {
    const { service } = build();
    await expect(probe(service, mkContext())).resolves.toEqual(
      expect.objectContaining({ guildId: '222', voiceChannelId: 'voice-1', textChannelId: 'text-1' }),
    );
  });
});

describe('MusicCommands.nowPlayingAsync', () => {
  it('refuses outside a server', async () => {
    const { service } = build();
    const result = await call(service, 'nowPlayingAsync', mkContext({ guildId: undefined }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports nothing playing when the queue is empty', async () => {
    const { service, musicService } = build();
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const result = await call(service, 'nowPlayingAsync', mkContext());
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('reports nothing playing when a queue exists but has no current track', async () => {
    const { service, musicService } = build();
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue({ current: null, tracks: [] });
    const result = await call(service, 'nowPlayingAsync', mkContext());
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });
});

describe('MusicCommands.queueAsync page parsing', () => {
  const pageOf = async (args: string[]) => {
    const { service, musicService } = build();
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue({ current: { title: 'x' }, tracks: [] });
    await call(service, 'queueAsync', mkContext(), args);
    return (MusicBuilders.buildQueueResponse as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
  };

  it('uses a valid page number', async () => {
    await expect(pageOf(['3'])).resolves.toBe(3);
  });

  it('falls back to page 1 for a non-numeric page', async () => {
    // "abc" used to become NaN and render "Page NaN/3" under an empty list.
    await expect(pageOf(['abc'])).resolves.toBe(1);
  });

  it('falls back to page 1 for zero and negatives', async () => {
    await expect(pageOf(['0'])).resolves.toBe(1);
    await expect(pageOf(['-4'])).resolves.toBe(1);
  });

  it('falls back to page 1 when no page is given', async () => {
    await expect(pageOf([])).resolves.toBe(1);
  });
});

describe('MusicCommands.skipAsync', () => {
  it('refuses when the caller is not in a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'skipAsync', mkContext({ member: { displayName: 'x' } }), []);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('skips one track by default', async () => {
    const { service, musicService } = build();
    await call(service, 'skipAsync', mkContext(), []);
    expect(musicService.skip).toHaveBeenCalledWith('222', 1);
  });

  it('skips several when given a count', async () => {
    const { service, musicService } = build();
    await call(service, 'skipAsync', mkContext(), ['3']);
    expect(musicService.skip).toHaveBeenCalledWith('222', 3);
  });

  it('clamps a nonsense count to one rather than skipping everything', async () => {
    const { service, musicService } = build();
    await call(service, 'skipAsync', mkContext(), ['abc']);
    expect(musicService.skip).toHaveBeenCalledWith('222', 1);
  });

  it('reports an empty queue when the service refuses', async () => {
    const { service, musicService } = build();
    (musicService.skip as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const result = await call(service, 'skipAsync', mkContext(), []);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });
});

describe('MusicCommands.searchAsync', () => {
  it('refuses outside a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'searchAsync', mkContext({ member: { displayName: 'x' } }), ['a']);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('asks for a search term when none is given', async () => {
    const { service, musicService } = build();
    await call(service, 'searchAsync', mkContext(), []);
    expect(musicService.searchTracks).not.toHaveBeenCalled();
  });

  it('reports when nothing is found', async () => {
    const { service } = build();
    const result = await call(service, 'searchAsync', mkContext(), ['nothing']);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('joins the args into one query', async () => {
    const { service, musicService } = build();
    (musicService.searchTracks as ReturnType<typeof vi.fn>).mockResolvedValue([{ title: 'A' }]);
    await call(service, 'searchAsync', mkContext(), ['daft', 'punk']);
    expect(musicService.searchTracks.mock.calls[0]?.[0]).toBe('daft punk');
  });
});

describe('MusicCommands command table', () => {
  it('gives every command a unique name including aliases', () => {
    const { service } = build();
    const names = service.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not collide with the reserved text-command name', () => {
    const { service } = build();
    const names = service.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(names).not.toContain('remove-duplicate');
  });
});
