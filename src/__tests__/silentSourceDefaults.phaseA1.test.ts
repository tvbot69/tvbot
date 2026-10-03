import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutopostService, type AutopostConfig } from '@bot/services/charts/autopostService';
import { AutopostRepository } from '@persistence/repositories/autopostRepository';
import { SpotifySearchApi, SpotifyUnavailableError } from '@spotify/api/spotifySearchApi';
import type { SpotifyTokenManager } from '@spotify/api/spotifyTokenManager';
import { UserUpdateQueueService } from '@bot/services/lastfm/userUpdateQueueService';
import type { Client } from 'discord.js';

/**
 * Phase A1: "no query is silent."
 *
 * Every test here is a PAIR, and the second half is the one that matters most:
 *
 *   (a) a failure raises (or is counted), and
 *   (b) a query that RAN and matched nothing still returns the honest empty.
 *
 * Asserting only (a) cannot tell the fix from the bug it replaced — the bug also
 * "handled" a failure, it just answered with a default. Asserting only (b) is
 * the same test the old behaviour already passed.
 *
 * There is no "not found" case to split out anywhere in this file. Every query is
 * a `count`, a `findMany` or an aggregate, and those SUCCEED with a shorter
 * result — empty IS the answer, an error is always an error. A `count` that runs
 * and matches nothing succeeds with 0, so raising can never be reached by a
 * genuine zero. That is what half (b) demonstrates rather than asserts in prose.
 *
 * No test here spies on the object under test or on a live shared client, and
 * none asserts on a `Logger` spy: `Logger` is a module-level singleton shared by
 * the whole file, and `mockRestore()` on it leaves an own property set to
 * `undefined` for every later test. Where a fix is log-only there is no test, and
 * the report says so.
 */

const okResponse = (body: unknown) =>
  ({ status: 200, ok: true, headers: new Headers(), json: async () => body }) as unknown as Response;

const errorResponse = (status: number) =>
  ({ status, ok: false, headers: new Headers() }) as unknown as Response;

// ---------------------------------------------------------------------------
// autopostService.createAutopost — the spam-guard count
// ---------------------------------------------------------------------------

describe('autopostService.createAutopost: the per-guild cap guard', () => {
  const makeRepo = (count: number | 'throws') => ({
    countForGuild: vi.fn(async () => {
      if (count === 'throws') throw new Error('connection terminated unexpectedly');
      return count;
    }),
    createAutopost: vi.fn(async () => ({
      id: '77',
      guildId: 'g1',
      channelId: 'c1',
      schedule: 'Weekly' as const,
      contentType: 'TopArtists' as const,
      enabled: true,
    })),
  });

  const makeService = (repo: ReturnType<typeof makeRepo>) =>
    new AutopostService({} as never, {} as never, {} as never, {} as never, { recordCommandExecution: vi.fn() } as never, undefined, repo as never);

  const config = { guildId: 'g1', channelId: 'c1', schedule: 'Weekly' as const, contentType: 'TopArtists' as const, enabled: true };

  it('(a) RAISES when the cap count could not be read, instead of answering "zero autoposts"', async () => {
    const service = makeService(makeRepo('throws'));

    await expect(service.createAutopost(config)).rejects.toThrow(/Database unavailable/i);
    // The guard is the control; a failed read must not create the row either.
    expect(service.getAutopostsForGuild('g1')).toHaveLength(0);
  });

  it('(b) still creates when the count RAN and matched nothing — a genuine zero is not a failure', async () => {
    const repo = makeRepo(0);
    const service = makeService(repo);

    const created = await service.createAutopost(config);

    expect(repo.countForGuild).toHaveBeenCalledWith('g1');
    expect(created?.id).toBe('77');
    // The row the caller gets back is the one it will edit and re-schedule.
    expect(created).toMatchObject({
      id: '77',
      guildId: 'g1',
      channelId: 'c1',
      schedule: 'Weekly',
      contentType: 'TopArtists',
      enabled: true,
    });
    // The write is the columns the schema has, not the caller's whole object:
    // `enabled` is a service-side default, and forwarding it here would create
    // a row the migration never defined.
    expect(repo.createAutopost).toHaveBeenCalledWith({
      guildId: 'g1',
      channelId: 'c1',
      contentType: 'TopArtists',
      schedule: 'Weekly',
    });
    expect(service.getAutopostsForGuild('g1')).toHaveLength(1);
  });

  it('(b2) still refuses at the cap, because a count that RAN is a real answer', async () => {
    const repo = makeRepo(AutopostService.MAX_AUTOPOSTS_PER_GUILD);
    const service = makeService(repo);

    await expect(service.createAutopost(config)).resolves.toBeNull();
    // The refusal is a refusal to WRITE: a cap hit that still inserted the row
    // would report the cap and blow past it.
    expect(repo.createAutopost).not.toHaveBeenCalled();
    expect(service.getAutopostsForGuild('g1')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// autopostService.runScheduledAutoposts — the due-claim
// ---------------------------------------------------------------------------

describe('autopostService.runScheduledAutoposts: a due-claim that could not be read', () => {
  const due: AutopostConfig = {
    id: '55',
    guildId: 'g1',
    channelId: 'c1',
    schedule: 'Daily',
    contentType: 'ServerCrowns',
    enabled: true,
    lastPosted: new Date(Date.now() - 25 * 3600 * 1000),
  };

  const makeRepo = (claim: 'throws' | 'not-due') => ({
    getAllActiveAutoposts: vi.fn(async () => [due]),
    claimDueAutopost: vi.fn(async () => {
      if (claim === 'throws') throw new Error('deadlock detected');
      return null;
    }),
    releaseClaim: vi.fn(async () => undefined),
  });

  const client = () =>
    ({
      channels: {
        fetch: vi.fn(async () => ({
          isTextBased: () => true,
          send: vi.fn(async () => ({})),
          guild: { name: 'Test Guild' },
        })),
      },
    }) as unknown as Client;

  it('(a) COUNTS the skip as failed, so a broken claim cannot pass for "not due"', async () => {
    const repo = makeRepo('throws');
    const service = new AutopostService({} as never, {} as never, {} as never, { getGuildLeaderboard: vi.fn() } as never, { recordCommandExecution: vi.fn() } as never, undefined, repo as never);

    const result = await service.runScheduledAutoposts(client());

    expect(result).toEqual({ executed: 0, failed: 1 });
    // Nothing was claimed, so nothing is rolled back, and nothing was posted.
    expect(repo.releaseClaim).not.toHaveBeenCalled();
  });

  it('(b) a claim that RAN and returned null is "not due": skipped, and not a failure', async () => {
    const repo = makeRepo('not-due');
    const service = new AutopostService({} as never, {} as never, {} as never, { getGuildLeaderboard: vi.fn() } as never, { recordCommandExecution: vi.fn() } as never, undefined, repo as never);

    const result = await service.runScheduledAutoposts(client());

    expect(result).toEqual({ executed: 0, failed: 0 });
    expect(repo.releaseClaim).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// autopostRepository.releaseClaim — the rollback
// ---------------------------------------------------------------------------

describe('autopostRepository.releaseClaim', () => {
  const prisma = (update: () => Promise<unknown>) => ({ guildAutopost: { update: vi.fn(update) } });

  it('(a) propagates a failed rollback, so the caller can see that the post is now suppressed for a cycle', async () => {
    const repo = new AutopostRepository(prisma(async () => { throw new Error('write conflict'); }) as never);

    await expect(repo.releaseClaim(55, null)).rejects.toThrow(/write conflict/);
  });

  it('(b) writes the previous stamp back on the happy path', async () => {
    const previous = new Date('2026-01-01T00:00:00.000Z');
    const client = prisma(async () => ({ id: 55 }));
    const repo = new AutopostRepository(client as never);

    await expect(repo.releaseClaim(55, previous)).resolves.toBeUndefined();
    expect(client.guildAutopost.update).toHaveBeenCalledWith({ where: { id: 55 }, data: { lastPosted: previous } });
  });
});

// ---------------------------------------------------------------------------
// Spotify: a failed search must not become "not on Spotify"
// ---------------------------------------------------------------------------

describe('SpotifySearchApi.getArtistIdViaTrackSample', () => {
  let api: SpotifySearchApi;

  beforeEach(() => {
    SpotifySearchApi.clearRateLimit();
    api = new SpotifySearchApi({
      getToken: vi.fn().mockResolvedValue('test-token'),
      invalidate: vi.fn(),
      rotateCredential: vi.fn().mockReturnValue(false),
    } as unknown as SpotifyTokenManager);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SpotifySearchApi.clearRateLimit();
  });

  it('(a) RAISES on a network failure rather than reporting "no exact match"', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    await expect(api.getArtistIdViaTrackSample('Mond', 'Esme')).rejects.toThrow(SpotifyUnavailableError);
  });

  it('(a2) RAISES on HTTP 500 for the same reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(500));

    await expect(api.getArtistIdViaTrackSample('Mond', 'Esme')).rejects.toThrow(SpotifyUnavailableError);
  });

  it('(b) still answers null when the search RAN and no artist matched exactly', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse({ tracks: { items: [{ name: 'Esme', artists: [{ name: 'Someone Else', id: 'other-id' }] }] } }),
    );

    await expect(api.getArtistIdViaTrackSample('Mond', 'Esme')).resolves.toBeNull();
    // The search really ran, with BOTH names — a null from a request that never
    // left would look identical and would cache 'none' for an artist that does
    // have a Spotify id.
    expect(String(fetchMock.mock.calls[0]![0])).toContain('q=Mond+Esme');
  });

  it('(b2) still resolves the id when the search ran and matched', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse({ tracks: { items: [{ name: 'Esme', artists: [{ name: 'Mond', id: 'egypt-mond-id' }] }] } }),
    );

    await expect(api.getArtistIdViaTrackSample('Mond', 'Esme')).resolves.toBe('egypt-mond-id');
  });
});

describe('SpotifySearchApi.getAlbumTrackNames', () => {
  let api: SpotifySearchApi;

  beforeEach(() => {
    SpotifySearchApi.clearRateLimit();
    api = new SpotifySearchApi({
      getToken: vi.fn().mockResolvedValue('test-token'),
      invalidate: vi.fn(),
      rotateCredential: vi.fn().mockReturnValue(false),
    } as unknown as SpotifyTokenManager);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SpotifySearchApi.clearRateLimit();
  });

  it('(a) RAISES when every rung failed, instead of returning "this album has no tracks"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(500));

    await expect(api.getAlbumTrackNames('Geogaddi', 'Boards of Canada')).rejects.toThrow(SpotifyUnavailableError);
  });

  it('(a2) RAISES when the last rung works but the tracklist request does not', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(okResponse({ albums: { items: [{ id: 'alb1', name: 'Geogaddi' }] } }));
    fetchMock.mockResolvedValueOnce(errorResponse(503));

    await expect(api.getAlbumTrackNames('Geogaddi', 'Boards of Canada')).rejects.toThrow(SpotifyUnavailableError);
  });

  it('(b) still answers empty when the searches RAN and matched no album', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(okResponse({ albums: { items: [] } }));
    fetchMock.mockResolvedValueOnce(okResponse({ albums: { items: [] } }));

    await expect(api.getAlbumTrackNames('Geogaddi', 'Boards of Canada')).resolves.toEqual([]);
  });

  it('(b2) still answers empty on a 404, which is Spotify saying the album has no tracklist', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(okResponse({ albums: { items: [{ id: 'alb1', name: 'Geogaddi' }] } }));
    fetchMock.mockResolvedValueOnce(errorResponse(404));

    await expect(api.getAlbumTrackNames('Geogaddi', 'Boards of Canada')).resolves.toEqual([]);
  });

  it('(b3) still returns the REAL tracklist when the search ran and the album matched', async () => {
    // The direction both tests above are paired with. Raising is not "be strict",
    // it is "do not answer when nothing was read": a fix that returned `[]`
    // everywhere would satisfy (a), (b) and (b2) and hide every album's
    // tracklist. The names are what `albumService` renders.
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(okResponse({ albums: { items: [{ id: 'alb1', name: 'Geogaddi' }] } }));
    fetchMock.mockResolvedValueOnce(okResponse({ items: [{ name: 'Alpha' }, { name: 'Beta' }] }));

    await expect(api.getAlbumTrackNames('Geogaddi', 'Boards of Canada')).resolves.toEqual([
      'Alpha',
      'Beta',
    ]);
    // The second leg asked the album Spotify actually matched, for the whole
    // tracklist — a guessed album id would return another album's songs.
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/v1/albums/alb1/tracks');
  });
});

// ---------------------------------------------------------------------------
// The durable queue mirror: an unread backlog is a silent permanent loss
// ---------------------------------------------------------------------------

describe('UserUpdateQueueService.rehydrate', () => {
  const makeCache = (backlog: unknown[], reportedLength: number) => ({
    isRedisReady: () => true,
    listPush: vi.fn(async () => undefined),
    listLength: vi.fn(async () => reportedLength),
    listPopCount: vi.fn(async () => backlog.splice(0, backlog.length)),
    setAddNX: vi.fn(async () => true),
    setRemove: vi.fn(async () => undefined),
  });

  it('reads the queue length before popping, so a backlog it could not restore is measurable', async () => {
    const cache = makeCache([{ userId: 7, discordUserId: 'd7', userNameLastFm: 'u7' }], 1);
    const queue = new UserUpdateQueueService(cache as never);
    const seen: number[] = [];
    queue.registerProcessor(async (batch) => { seen.push(...batch.map((b) => b.userId)); });

    await queue.pump();

    expect(cache.listLength).toHaveBeenCalledWith('queue:user-updates');
    // The honest half survives: what WAS readable is still processed.
    expect(seen).toEqual([7]);
  });

  it('restores a backlog whose length and contents agree, and the length read adds no per-item work', async () => {
    const cache = makeCache([{ userId: 7 }, { userId: 8 }], 2);
    const queue = new UserUpdateQueueService(cache as never);
    const seen: number[] = [];
    queue.registerProcessor(async (batch) => { seen.push(...batch.map((b) => b.userId)); });

    await queue.pump();

    expect(seen.sort()).toEqual([7, 8]);
    expect(cache.listLength).toHaveBeenCalledTimes(1);
    // …against the list this service owns, not some other key: the same
    // measurement against the wrong key would prove nothing about the backlog
    // that was just restored.
    expect(cache.listLength).toHaveBeenCalledWith('queue:user-updates');
    // The trim is the ACKNOWLEDGEMENT, and it trims exactly the batch the
    // processor just ran — two items, on this service's list. A trim of 0 (or of
    // the whole restored backlog) would replay or lose work in equal measure.
    expect(cache.listPopCount).toHaveBeenCalledWith('queue:user-updates', 2);
  });
});
