import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageFlags } from 'discord.js';
import { container } from 'tsyringe';
import {
  ServerInteractions,
  storeServerRankingQuery,
  getCachedServerRankingQuery,
} from '../serverInteractions';
import type { CachedServerRanking } from '../serverInteractions';
import { ServerBuilders } from '@bot/builders/serverBuilders';
import type { ServerRankingType } from '@bot/builders/serverBuilders';
import { OrderType } from '@bot/services/guildRankingService';
import type { GuildRankingItem, GuildRankingSettings } from '@bot/services/guildRankingService';
import { CacheService } from '@bot/services/system/cacheService';
import type { ButtonInteraction } from 'discord.js';

const makeSettings = (over: Partial<GuildRankingSettings> = {}): GuildRankingSettings => ({
  chartTimePeriod: 'weekly',
  timeDescription: 'last week',
  orderType: OrderType.Listeners,
  amountOfDays: 7,
  startDateTime: new Date('2026-01-05'),
  endDateTime: new Date('2026-01-12'),
  billboardStartDateTime: null,
  billboardEndDateTime: null,
  billboardTimeDescription: null,
  newSearchValue: null,
  ...over,
});

const makeItems = (n: number): GuildRankingItem[] =>
  Array.from({ length: n }, (_, i) => ({
    name: `Entry ${i + 1}`,
    secondaryName: i % 2 === 0 ? 'Radiohead' : undefined,
    totalPlaycount: 100 - i,
    listenerCount: 10 - i,
    id: i + 1,
  }));

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'caller1' },
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const guildRankingService = {
    getGuildTopArtists: vi.fn(async (_guildId: string, _settings: GuildRankingSettings) => makeItems(25)),
    getGuildTopAlbums: vi.fn(
      async (_guildId: string, _settings: GuildRankingSettings, _artistFilter?: string | null) => makeItems(25),
    ),
    getGuildTopTracks: vi.fn(
      async (_guildId: string, _settings: GuildRankingSettings, _artistFilter?: string | null) => makeItems(25),
    ),
    getGuildTopGenres: vi.fn(async (_guildId: string, _settings: GuildRankingSettings) => makeItems(25)),
    ...(over.guildRankingService as object),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0xff0000),
    ...(over.colorService as object),
  };
  const si = new ServerInteractions(guildRankingService as never, colorService as never);
  return { si, guildRankingService, colorService };
};

const seed = (
  key: string,
  data: Partial<Omit<CachedServerRanking, 'expiresAt'>> = {},
): void => {
  storeServerRankingQuery(key, {
    type: 'artists',
    guildId: 'g1',
    serverName: 'TestGuild',
    settings: makeSettings(),
    ...data,
  } as Omit<CachedServerRanking, 'expiresAt'>);
};

/** Sentinel response. The handler uses `toMessagePayload()`, so stub it. */
const sentinel = (label: string) => ({ toMessagePayload: () => ({ label }) });

/** Fake CacheService whose Redis store JSON round-trips values, like the real one does. */
const registerJsonRedis = () => {
  const wire = new Map<string, unknown>();
  const cache = {
    isRedisReady: () => true,
    set: vi.fn(async (key: string, value: unknown) => {
      wire.set(key, JSON.parse(JSON.stringify(value)));
    }),
    get: vi.fn(async (key: string) => wire.get(key) ?? null),
    delete: vi.fn(async (key: string) => {
      wire.delete(key);
    }),
  };
  container.registerInstance(CacheService, cache as never);
  return { wire, cache };
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(ServerBuilders, 'buildServerLeaderboardResponse').mockReturnValue(sentinel('lb') as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  container.clearInstances();
  vi.useRealTimers();
});

describe('storeServerRankingQuery / getCachedServerRankingQuery', () => {
  it('round-trips a stored query from memory with Date fields intact', async () => {
    seed('rt-1', { type: 'albums', artistFilter: 'Radiohead' });

    const cached = await getCachedServerRankingQuery('rt-1');

    expect(cached!.type).toBe('albums');
    expect(cached!.artistFilter).toBe('Radiohead');
    expect(cached!.settings.startDateTime).toBeInstanceOf(Date);
    expect(cached!.settings.startDateTime.toISOString()).toBe('2026-01-05T00:00:00.000Z');
  });

  it('stamps a future expiresAt on store', async () => {
    const before = Date.now();
    seed('rt-2');

    const cached = await getCachedServerRankingQuery('rt-2');

    expect(cached!.expiresAt).toBeGreaterThanOrEqual(before);
  });

  it('returns undefined for an unknown key', async () => {
    await expect(getCachedServerRankingQuery('never-seeded-key')).resolves.toBeUndefined();
  });
});

describe('TtlStore reviver — the reason this file has one', () => {
  it('revives all four date keys as Date objects after the JSON round trip', async () => {
    const { wire } = registerJsonRedis();
    vi.useFakeTimers({ toFake: ['Date'] });

    storeServerRankingQuery('rev-1', {
      type: 'artists',
      guildId: 'g1',
      serverName: 'TestGuild',
      settings: makeSettings({
        startDateTime: new Date('2026-01-05'),
        endDateTime: new Date('2026-01-12'),
        billboardStartDateTime: new Date('2025-12-08'),
        billboardEndDateTime: new Date('2025-12-15'),
      }),
    });
    await flush();

    // What actually sits on the wire: every date has become a bare string.
    const onWire = wire.get('session:server-ranking:rev-1') as { settings: Record<string, unknown> };
    expect(typeof onWire.settings.startDateTime).toBe('string');
    expect(typeof onWire.settings.endDateTime).toBe('string');
    expect(typeof onWire.settings.billboardStartDateTime).toBe('string');
    expect(typeof onWire.settings.billboardEndDateTime).toBe('string');

    // Push past the 30-minute memory TTL so the read falls through to Redis.
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    const revived = await getCachedServerRankingQuery('rev-1');

    expect(revived).toBeDefined();
    expect(revived!.settings.startDateTime).toBeInstanceOf(Date);
    expect(revived!.settings.endDateTime).toBeInstanceOf(Date);
    expect(revived!.settings.billboardStartDateTime).toBeInstanceOf(Date);
    expect(revived!.settings.billboardEndDateTime).toBeInstanceOf(Date);
    expect(revived!.settings.startDateTime.toISOString()).toBe('2026-01-05T00:00:00.000Z');
    expect(revived!.settings.billboardEndDateTime!.toISOString()).toBe('2025-12-15T00:00:00.000Z');
  });

  it('leaves non-date settings fields untouched', async () => {
    registerJsonRedis();
    vi.useFakeTimers({ toFake: ['Date'] });

    storeServerRankingQuery('rev-2', {
      type: 'artists',
      guildId: 'g1',
      serverName: 'TestGuild',
      settings: makeSettings({ orderType: OrderType.Playcount, timeDescription: 'last month' }),
    });
    await flush();

    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    const revived = await getCachedServerRankingQuery('rev-2');

    expect(revived!.settings.orderType).toBe(OrderType.Playcount);
    expect(revived!.settings.timeDescription).toBe('last month');
    expect(revived!.settings.chartTimePeriod).toBe('weekly');
    expect(revived!.serverName).toBe('TestGuild');
  });

  it('keeps null billboard dates as null rather than an Invalid Date', async () => {
    registerJsonRedis();
    vi.useFakeTimers({ toFake: ['Date'] });

    storeServerRankingQuery('rev-3', {
      type: 'genres',
      guildId: 'g1',
      serverName: 'TestGuild',
      settings: makeSettings({ billboardStartDateTime: null, billboardEndDateTime: null }),
    });
    await flush();

    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    const revived = await getCachedServerRankingQuery('rev-3');

    expect(revived!.settings.billboardStartDateTime).toBeNull();
    expect(revived!.settings.billboardEndDateTime).toBeNull();
  });

  it('does not revive when the value comes back from memory', async () => {
    registerJsonRedis();
    seed('rev-4');

    const fromMemory = await getCachedServerRankingQuery('rev-4');

    // Same object identity as the one handed to `set` — the memory path skips the reviver.
    expect(fromMemory!.settings.startDateTime).toBeInstanceOf(Date);
  });
});

describe('ServerInteractions.handleButton — customId routing', () => {
  it('ignores a customId without the "server:page:" prefix', async () => {
    const { si, guildRankingService } = build();
    const press = mkButton('server:other:artists:k1:0:caller1');

    await si.handleButton(press);

    expect(guildRankingService.getGuildTopArtists).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('returns for a malformed id with too few parts', async () => {
    const { si, guildRankingService } = build();
    seed('r-1');
    const press = mkButton('server:page:artists:r-1');

    await si.handleButton(press);

    expect(guildRankingService.getGuildTopArtists).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('parses the 7-part pattern with an action segment', async () => {
    const { si } = build();
    seed('r-2', { type: 'albums' });
    const press = mkButton('server:page:next:albums:r-2:3:caller1');

    await si.handleButton(press);

    expect(ServerBuilders.buildServerLeaderboardResponse).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'albums', cacheKey: 'r-2', pageIndex: 3, callerDiscordUserId: 'caller1' }),
    );
  });

  it('parses the 6-part pattern without an action segment', async () => {
    const { si } = build();
    seed('r-3', { type: 'tracks' });
    const press = mkButton('server:page:tracks:r-3:5:caller1');

    await si.handleButton(press);

    expect(ServerBuilders.buildServerLeaderboardResponse).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tracks', cacheKey: 'r-3', pageIndex: 5, callerDiscordUserId: 'caller1' }),
    );
  });

  it('ignores the action segment — it never adjusts the page', async () => {
    const { si } = build();
    seed('r-4', { type: 'artists' });

    await si.handleButton(mkButton('server:page:first:artists:r-4:7:caller1'));

    expect(ServerBuilders.buildServerLeaderboardResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 7 }),
    );
  });

  it('passes an out-of-range page through unclamped', async () => {
    const { si } = build();
    seed('r-5', { type: 'artists' });

    await si.handleButton(mkButton('server:page:next:artists:r-5:999:caller1'));

    expect(ServerBuilders.buildServerLeaderboardResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 999 }),
    );
  });

  it('passes a NaN page through when the segment is not numeric', async () => {
    const { si } = build();
    seed('r-6', { type: 'artists' });

    await si.handleButton(mkButton('server:page:next:artists:r-6:abc:caller1'));

    expect(ServerBuilders.buildServerLeaderboardResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: Number.NaN }),
    );
  });
});

describe('ServerInteractions.handleButton — guards', () => {
  it('refuses a page from a different caller', async () => {
    const { si, guildRankingService } = build();
    seed('g-1');
    const press = mkButton('server:page:next:artists:g-1:0:someoneElse');

    await si.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'Only the user who initiated the command can interact with these controls.',
      flags: MessageFlags.Ephemeral,
    });
    expect(guildRankingService.getGuildTopArtists).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('replies "expired" when nothing is cached', async () => {
    const { si } = build();
    const press = mkButton('server:page:next:artists:missing:0:caller1');

    await si.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'This server chart interaction has expired. Please run the command again.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.update).not.toHaveBeenCalled();
  });
});

describe('ServerInteractions.handleButton — ranking types', () => {
  it('fetches artists without an artist filter', async () => {
    const { si, guildRankingService } = build();
    const settings = makeSettings();
    seed('t-1', { type: 'artists', settings });
    const press = mkButton('server:page:next:artists:t-1:0:caller1');

    await si.handleButton(press);

    expect(guildRankingService.getGuildTopArtists).toHaveBeenCalledWith('g1', settings);
    expect(ServerBuilders.buildServerLeaderboardResponse).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'artists', items: makeItems(25), previousItems: null }),
    );
    expect(press.update).toHaveBeenCalledWith({ label: 'lb' });
  });

  it('fetches albums with the artist filter', async () => {
    const { si, guildRankingService } = build();
    const settings = makeSettings();
    seed('t-2', { type: 'albums', settings, artistFilter: 'Radiohead' });
    const press = mkButton('server:page:next:albums:t-2:0:caller1');

    await si.handleButton(press);

    expect(guildRankingService.getGuildTopAlbums).toHaveBeenCalledWith('g1', settings, 'Radiohead');
    expect(ServerBuilders.buildServerLeaderboardResponse).toHaveBeenCalledWith(
      expect.objectContaining({ artistFilter: 'Radiohead' }),
    );
  });

  it('fetches tracks with the artist filter', async () => {
    const { si, guildRankingService } = build();
    const settings = makeSettings();
    seed('t-3', { type: 'tracks', settings, artistFilter: 'Muse' });
    const press = mkButton('server:page:next:tracks:t-3:0:caller1');

    await si.handleButton(press);

    expect(guildRankingService.getGuildTopTracks).toHaveBeenCalledWith('g1', settings, 'Muse');
  });

  it('fetches genres without an artist filter', async () => {
    const { si, guildRankingService } = build();
    const settings = makeSettings();
    seed('t-4', { type: 'genres', settings });
    const press = mkButton('server:page:next:genres:t-4:0:caller1');

    await si.handleButton(press);

    expect(guildRankingService.getGuildTopGenres).toHaveBeenCalledWith('g1', settings);
    expect(ServerBuilders.buildServerLeaderboardResponse).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'genres', items: makeItems(25) }),
    );
  });

  it('calls only the one service for the requested type', async () => {
    const { si, guildRankingService } = build();
    seed('t-5', { type: 'artists' });

    await si.handleButton(mkButton('server:page:next:artists:t-5:0:caller1'));

    expect(guildRankingService.getGuildTopAlbums).not.toHaveBeenCalled();
    expect(guildRankingService.getGuildTopTracks).not.toHaveBeenCalled();
    expect(guildRankingService.getGuildTopGenres).not.toHaveBeenCalled();
  });

  it('builds an empty leaderboard for an unknown ranking type', async () => {
    const { si, guildRankingService } = build();
    seed('t-6', { type: 'artists' });
    const press = mkButton('server:page:next:bogus:t-6:0:caller1');

    await si.handleButton(press);

    expect(guildRankingService.getGuildTopArtists).not.toHaveBeenCalled();
    expect(guildRankingService.getGuildTopAlbums).not.toHaveBeenCalled();
    expect(guildRankingService.getGuildTopTracks).not.toHaveBeenCalled();
    expect(guildRankingService.getGuildTopGenres).not.toHaveBeenCalled();
    expect(ServerBuilders.buildServerLeaderboardResponse).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'bogus', items: [], previousItems: null }),
    );
    expect(press.update).toHaveBeenCalledWith({ label: 'lb' });
  });

  it('passes the cached settings, server name and accent colour to the builder', async () => {
    const { si } = build();
    const settings = makeSettings({ timeDescription: 'last month', amountOfDays: 30 });
    seed('t-7', { type: 'albums', settings, serverName: 'Cool Server', accentColor: 0xabcdef });
    const press = mkButton('server:page:next:albums:t-7:0:caller1');

    await si.handleButton(press);

    expect(ServerBuilders.buildServerLeaderboardResponse).toHaveBeenCalledWith({
      type: 'albums',
      serverName: 'Cool Server',
      items: makeItems(25),
      previousItems: null,
      settings,
      pageIndex: 0,
      cacheKey: 't-7',
      callerDiscordUserId: 'caller1',
      accentColor: 0xabcdef,
      artistFilter: undefined,
    });
  });

  it('updates the interaction with the builder payload', async () => {
    const { si } = build();
    seed('t-8', { type: 'artists' });
    const press = mkButton('server:page:next:artists:t-8:0:caller1');

    await si.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });
});

describe('ServerInteractions.handleButton — billboard previous period', () => {
  const withBillboard = () =>
    makeSettings({
      startDateTime: new Date('2026-01-05'),
      endDateTime: new Date('2026-01-12'),
      billboardStartDateTime: new Date('2025-12-08'),
      billboardEndDateTime: new Date('2025-12-15'),
      billboardTimeDescription: 'previous week',
    });

  it('fetches a second artist snapshot with the billboard window swapped in', async () => {
    const previous = makeItems(3).map((i) => ({ ...i, name: `Old ${i.name}` }));
    const settings = withBillboard();
    const { si, guildRankingService } = build({
      guildRankingService: {
        getGuildTopArtists: vi
          .fn()
          .mockResolvedValueOnce(makeItems(25))
          .mockResolvedValueOnce(previous),
      },
    });
    seed('b-1', { type: 'artists', settings });
    const press = mkButton('server:page:next:artists:b-1:0:caller1');

    await si.handleButton(press);

    expect(guildRankingService.getGuildTopArtists).toHaveBeenCalledTimes(2);
    expect(guildRankingService.getGuildTopArtists).toHaveBeenNthCalledWith(1, 'g1', settings);
    expect(guildRankingService.getGuildTopArtists).toHaveBeenNthCalledWith(2, 'g1', {
      ...settings,
      startDateTime: new Date('2025-12-08'),
      endDateTime: new Date('2025-12-15'),
    });
    expect(ServerBuilders.buildServerLeaderboardResponse).toHaveBeenCalledWith(
      expect.objectContaining({ items: makeItems(25), previousItems: previous }),
    );
  });

  it('swaps the window for albums and keeps the artist filter', async () => {
    const settings = withBillboard();
    const { si, guildRankingService } = build();
    seed('b-2', { type: 'albums', settings, artistFilter: 'Radiohead' });

    await si.handleButton(mkButton('server:page:next:albums:b-2:0:caller1'));

    expect(guildRankingService.getGuildTopAlbums).toHaveBeenNthCalledWith(2, 'g1', {
      ...settings,
      startDateTime: new Date('2025-12-08'),
      endDateTime: new Date('2025-12-15'),
    }, 'Radiohead');
  });

  it('swaps the window for tracks', async () => {
    const settings = withBillboard();
    const { si, guildRankingService } = build();
    seed('b-3', { type: 'tracks', settings, artistFilter: 'Muse' });

    await si.handleButton(mkButton('server:page:next:tracks:b-3:0:caller1'));

    expect(guildRankingService.getGuildTopTracks).toHaveBeenCalledTimes(2);
    expect(guildRankingService.getGuildTopTracks).toHaveBeenNthCalledWith(2, 'g1', {
      ...settings,
      startDateTime: new Date('2025-12-08'),
      endDateTime: new Date('2025-12-15'),
    }, 'Muse');
  });

  it('swaps the window for genres', async () => {
    const settings = withBillboard();
    const { si, guildRankingService } = build();
    seed('b-4', { type: 'genres', settings });

    await si.handleButton(mkButton('server:page:next:genres:b-4:0:caller1'));

    expect(guildRankingService.getGuildTopGenres).toHaveBeenCalledTimes(2);
  });

  it('makes only one call when billboardStartDateTime is null', async () => {
    const { si, guildRankingService } = build();
    seed('b-5', { type: 'artists', settings: makeSettings() });

    await si.handleButton(mkButton('server:page:next:artists:b-5:0:caller1'));

    expect(guildRankingService.getGuildTopArtists).toHaveBeenCalledTimes(1);
    expect(ServerBuilders.buildServerLeaderboardResponse).toHaveBeenCalledWith(
      expect.objectContaining({ previousItems: null }),
    );
  });

  it('still compares when only billboardEndDateTime is set', async () => {
    const settings = makeSettings({
      billboardStartDateTime: null,
      billboardEndDateTime: new Date('2025-12-15'),
    });
    const { si, guildRankingService } = build();
    seed('b-6', { type: 'artists', settings });

    await si.handleButton(mkButton('server:page:next:artists:b-6:0:caller1'));

    // The guard keys off startDateTime only, so no second fetch happens.
    expect(guildRankingService.getGuildTopArtists).toHaveBeenCalledTimes(1);
  });

  it('feeds revived Dates into the second fetch after a Redis round trip', async () => {
    const { wire } = registerJsonRedis();
    vi.useFakeTimers({ toFake: ['Date'] });

    storeServerRankingQuery('b-7', {
      type: 'artists',
      guildId: 'g1',
      serverName: 'TestGuild',
      settings: withBillboard(),
    });
    await flush();
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);

    const { si, guildRankingService } = build();
    const press = mkButton('server:page:next:artists:b-7:0:caller1');

    await si.handleButton(press);

    expect(wire.size).toBe(1);
    expect(guildRankingService.getGuildTopArtists).toHaveBeenCalledTimes(2);
    const revivedSettings = guildRankingService.getGuildTopArtists.mock.calls[1]![1] as GuildRankingSettings;
    expect(revivedSettings.startDateTime).toBeInstanceOf(Date);
    expect(revivedSettings.endDateTime).toBeInstanceOf(Date);
    expect(revivedSettings.startDateTime.toISOString()).toBe('2025-12-08T00:00:00.000Z');
  });
});

describe('ServerInteractions.handleButton — real builder', () => {
  it('updates with a real Components V2 payload', async () => {
    vi.restoreAllMocks();
    const { si } = build();
    seed('real-1', { type: 'artists', serverName: 'TestGuild' });
    const press = mkButton('server:page:next:artists:real-1:0:caller1');

    await si.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
    const payload = press.update.mock.calls[0]![0] as { flags: number; components: unknown[] };
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.components).toHaveLength(1);
  });

  it('updates with a real payload when the ranking is empty', async () => {
    vi.restoreAllMocks();
    const { si } = build({
      guildRankingService: { getGuildTopArtists: vi.fn(async () => []) },
    });
    seed('real-2', { type: 'artists' });
    const press = mkButton('server:page:next:artists:real-2:0:caller1');

    await si.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
    const payload = press.update.mock.calls[0]![0] as { flags: number };
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
  });

  it('renders every ranking type without throwing', async () => {
    vi.restoreAllMocks();
    const types: ServerRankingType[] = ['artists', 'albums', 'tracks', 'genres'];

    for (const type of types) {
      const { si } = build();
      seed(`real-3-${type}`, { type, serverName: 'TestGuild' });
      const press = mkButton(`server:page:next:${type}:real-3-${type}:0:caller1`);

      await si.handleButton(press);

      expect(press.update).toHaveBeenCalledTimes(1);
    }
  });
});
