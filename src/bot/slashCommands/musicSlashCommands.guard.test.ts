import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MusicSlashCommands } from './musicSlashCommands';
import { MusicBuilders } from '@bot/builders/musicBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';

/**
 * musicSlashCommands was 37.35% with 421 uncovered lines and no tests.
 *
 * The slash family routes EVERY subcommand through one dispatcher, so the
 * gate is applied in exactly one place and the whole file's security depends
 * on it. `CONTROL_SUBCOMMANDS` is the allowlist: anything that changes playback
 * is gated, and anything that only reads (play, search, nowplaying, queue,
 * chapters, lyrics, karaoke, history, nodes) is not. A subcommand accidentally
 * added to the wrong list is a privilege change, so the list itself is
 * asserted rather than assumed.
 *
 * A second rule worth pinning: an unknown subcommand must be REJECTED, not
 * silently treated as a read-only one.
 */

const opts = (o: Record<string, string | number | null> = {}, sub: string | null = 'nowplaying') => ({
  getSubcommand: () => sub,
  getString: (n: string) => (typeof o[n] === 'string' ? (o[n] as string) : null),
  getInteger: (n: string) => (typeof o[n] === 'number' ? (o[n] as number) : null),
  getBoolean: () => null,
});

const mkCtx = (sub: string | null, o: Record<string, string | number | null> = {}, over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    prefix: '/',
    member: { voice: { channelId: 'voice-1' }, displayName: 'Caller' },
    interaction: { channelId: 'text-1', id: 'i1', options: opts(o, sub) },
    userIsGuildAdmin: false,
    ...over,
  }) as unknown as ContextModel;

const build = (over: Record<string, unknown> = {}) => {
  const musicService = {
    canControlPlayback: vi.fn(() => true),
    getQueueInfo: vi.fn(() => ({ current: { title: 'Airbag' }, guildUsers: [], tracks: [] })),
    searchTracks: vi.fn(async (..._a: unknown[]) => []),
    skip: vi.fn(async (..._a: unknown[]) => true),
    previous: vi.fn(async (..._a: unknown[]) => true),
    skipto: vi.fn(async (..._a: unknown[]) => true),
    move: vi.fn(async (..._a: unknown[]) => true),
    ...(over.musicService as object),
  };
  const colorService = { getAccentColorAsync: vi.fn(async () => undefined) };
  const service = new MusicSlashCommands(musicService as never, colorService as never, undefined, undefined);
  return { service, musicService, colorService };
};

const call = (service: MusicSlashCommands, name: string, ...args: unknown[]) => {
  const h = service as unknown as Record<string, (...a: unknown[]) => Promise<{ commandResponse?: CommandResponse }>>;
  return h[name]!.bind(service)(...args);
};

beforeEach(() => {
  vi.restoreAllMocks();
  for (const n of ['buildQueueResponse', 'buildNowPlayingResponse', 'buildSearchResponse', 'buildSimpleResponse'] as const) {
    vi.spyOn(MusicBuilders, n).mockReturnValue({ setAutoDelete: () => ({ embed: {} }) } as never);
  }
});

describe('MusicSlashCommands.denyIfNotController', () => {
  const deny = (service: MusicSlashCommands, ctx: ContextModel) =>
    (service as unknown as { denyIfNotController(c: ContextModel): { commandResponse?: CommandResponse } | null })
      .denyIfNotController(ctx);

  it('allows the requester', () => {
    const { service } = build();
    expect(deny(service, mkCtx('skip'))).toBeNull();
  });

  it('refuses a non-requester who is not an admin', () => {
    const { service, musicService } = build();
    (musicService.canControlPlayback as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect(deny(service, mkCtx('skip'))?.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('does not gate in a DM', () => {
    const { service, musicService } = build();
    (musicService.canControlPlayback as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect(deny(service, mkCtx('skip', {}, { guildId: undefined }))).toBeNull();
  });
});

describe('MusicSlashCommands.executeMusic dispatch', () => {
  it('rejects an unknown subcommand rather than treating it as read-only', async () => {
    // Falling through would run a read path for something nobody defined.
    const { service } = build();
    const result = await call(service, 'executeMusic', mkCtx('definitelynotacommand'));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('rejects when no subcommand is present', async () => {
    const { service } = build();
    const result = await call(service, 'executeMusic', mkCtx(null));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('survives an interaction that throws while reading the subcommand', async () => {
    // A malformed interaction must not take the whole command down.
    const { service } = build();
    const ctx = mkCtx('nowplaying', {}, {
      interaction: { options: { getSubcommand: () => { throw new Error('malformed'); } } },
    });
    const result = await call(service, 'executeMusic', ctx);
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('routes a read-only subcommand without checking the control gate', async () => {
    const { service, musicService } = build();
    (musicService.canControlPlayback as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const result = await call(service, 'executeMusic', mkCtx('nowplaying'));
    expect(result.commandResponse).not.toBe(CommandResponse.WrongInput);
  });

  it('routes a control subcommand through the gate', async () => {
    const { service, musicService } = build();
    (musicService.canControlPlayback as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const result = await call(service, 'executeMusic', mkCtx('skip'));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(musicService.skip).not.toHaveBeenCalled();
  });
});

describe('MusicSlashCommands.executeNowPlaying', () => {
  it('refuses outside a server', async () => {
    const { service } = build();
    const result = await call(service, 'executeNowPlaying', mkCtx('nowplaying', {}, { guildId: undefined }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports nothing playing for an empty queue', async () => {
    const { service, musicService } = build();
    (musicService.getQueueInfo as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const result = await call(service, 'executeNowPlaying', mkCtx('nowplaying'));
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });
});

describe('MusicSlashCommands.executeQueue page option', () => {
  it('defaults to page 1 when the option is absent', async () => {
    const { service } = build();
    await call(service, 'executeQueue', mkCtx('queue'));
    expect((MusicBuilders.buildQueueResponse as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe(1);
  });

  it('uses the requested page', async () => {
    const { service } = build();
    await call(service, 'executeQueue', mkCtx('queue', { page: 4 }));
    expect((MusicBuilders.buildQueueResponse as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe(4);
  });
});

describe('MusicSlashCommands.executeSkip', () => {
  it('defaults to skipping one track', async () => {
    const { service, musicService } = build();
    await call(service, 'executeSkip', mkCtx('skip'));
    expect(musicService.skip).toHaveBeenCalledWith('222', 1);
  });

  it('skips several when given an amount', async () => {
    const { service, musicService } = build();
    await call(service, 'executeSkip', mkCtx('skip', { amount: 5 }));
    expect(musicService.skip).toHaveBeenCalledWith('222', 5);
  });

  it('reports an empty queue when the service refuses', async () => {
    const { service, musicService } = build();
    (musicService.skip as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const result = await call(service, 'executeSkip', mkCtx('skip'));
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });
});

describe('MusicSlashCommands queue position commands', () => {
  it('skips to the requested position', async () => {
    const { service, musicService } = build();
    await call(service, 'executeSkipTo', mkCtx('skipto', { position: 7 }));
    expect(musicService.skipto).toHaveBeenCalledWith('222', 7);
  });

  it('rejects an invalid position by name', async () => {
    const { service, musicService } = build();
    (musicService.skipto as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const result = await call(service, 'executeSkipTo', mkCtx('skipto', { position: 99 }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('moves a track between positions', async () => {
    const { service, musicService } = build();
    await call(service, 'executeMove', mkCtx('move', { from: 2, to: 5 }));
    expect(musicService.move).toHaveBeenCalledWith('222', 2, 5);
  });

  it('rejects invalid move positions', async () => {
    const { service, musicService } = build();
    (musicService.move as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const result = await call(service, 'executeMove', mkCtx('move', { from: 2, to: 5 }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('reports an empty history on previous', async () => {
    const { service, musicService } = build();
    (musicService.previous as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const result = await call(service, 'executePrevious', mkCtx('previous'));
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });
});

describe('MusicSlashCommands.executeSearch', () => {
  it('refuses outside a voice channel', async () => {
    const { service } = build();
    const result = await call(service, 'executeSearch', mkCtx('search', {}, { member: { displayName: 'x' } }));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
  });

  it('asks for a query when none is given', async () => {
    const { service, musicService } = build();
    const result = await call(service, 'executeSearch', mkCtx('search', {}));
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(musicService.searchTracks).not.toHaveBeenCalled();
  });

  it('reports when nothing matches', async () => {
    const { service } = build();
    const result = await call(service, 'executeSearch', mkCtx('search', { query: 'nothing' }));
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });
});

describe('MusicSlashCommands command table', () => {
  it('gives every command a unique name', () => {
    const { service } = build();
    const names = service.commands.map((c) => c.data.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
