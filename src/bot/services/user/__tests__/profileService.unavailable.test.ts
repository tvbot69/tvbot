import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ProfileService } from '@bot/services/user/profileService';
import { isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { LastFmUser } from '@domain/models/lastFmUser';
import type { User } from '@domain/interfaces/iuserRepository';
import { DataSource, UserType } from '@persistence/models/user';
import { PrivacyLevel } from '@domain/enums/privacyLevel';

/**
 * `getProfileHistory` is the one catch in `profileService` that was producing a
 * fabricated claim rather than an omitted clause.
 *
 * `months` and `years` come from two `GROUP BY` rollups over `user_plays` and
 * have no fallback source, so a failed query was indistinguishable from "this
 * user has no plays" at the call site. `profileBuilders` does not merely skip a
 * clause for an empty history - it renders
 * "Sorry, it seems like there is no stored data in tvbot for this user." So a
 * dropped connection told a user with millions of indexed plays that the bot had
 * never heard of them.
 *
 * THE PAIR IS THE CLAIM. Asserting only the happy half cannot tell this fix
 * from the bug: a `catch { }` that returns empty arrays and a `catch { }` that
 * raises produce the same value for every query that SUCCEEDS. Both halves are
 * therefore pinned below, and the empty half is not decoration - it is the half
 * a naive "always raise" fix would break.
 *
 * The prisma handle is a module singleton, not an injected dependency, so it is
 * replaced at the module boundary. `ProfileService`'s constructor is 2 positional
 * args and does NOT take prisma.
 */
const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  userArtist: { findMany: vi.fn(), count: vi.fn() },
  userAlbum: { count: vi.fn() },
  userTrack: { count: vi.fn() },
}));

vi.mock('@persistence/prismaClient', () => ({ prisma: db }));

const lastFmUser: LastFmUser = {
  name: 'DreadRock',
  playCount: 11361,
  registeredAt: new Date('2011-04-05T00:00:00.000Z'),
  trackCount: 500,
  albumCount: 60,
  artistCount: 30,
};

/** Only the two methods `getProfileHistory` reaches. */
const lastfmRepo = (user: LastFmUser | null): ILastfmRepository =>
  ({
    getUserInfo: async () => user,
    getTopArtists: async () => [],
  }) as unknown as ILastfmRepository;

const targetUser = (over: Partial<User> = {}): User => ({
  userId: 7,
  userNameLastFm: 'DreadRock',
  discordUserId: '900000000000000001',
  registeredOn: new Date('2011-04-05T00:00:00.000Z'),
  userType: UserType.User,
  dataSource: DataSource.LastFm,
  privacyLevel: PrivacyLevel.Default,
  ...over,
});

const build = (user: LastFmUser | null = lastFmUser) =>
  new ProfileService(lastfmRepo(user));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProfileService.getProfileHistory — a query that could not run is not an empty history', () => {
  it('RAISES when the month rollup cannot run', async () => {
    // (a) the failure half. Without this the fix is indistinguishable from the
    // original `catch { // Ignored, fallback to empty history }`.
    db.$queryRaw.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const service = build();
    const call = service.getProfileHistory('DreadRock', targetUser());

    await expect(call).rejects.toSatisfy((err: unknown) => isSourceUnavailable(err));
  });

  it('RAISES when the month rollup runs but the year rollup does not', async () => {
    // The second query is a separate round trip, so a connection that dies
    // between them is a real and distinct case. Both calls go through the same
    // `$queryRaw`, so this is sequenced rather than a different method.
    db.$queryRaw
      .mockResolvedValueOnce([
        { month_date: new Date('2024-06-15T00:00:00Z'), play_count: 3, total_ms: 120_000n },
      ])
      .mockRejectedValueOnce(new Error('server closed the connection unexpectedly'));

    const service = build();
    await expect(
      service.getProfileHistory('DreadRock', targetUser()),
    ).rejects.toSatisfy((err: unknown) => isSourceUnavailable(err));
  });

  it('STILL returns an empty history for a user whose query ran and matched nothing', async () => {
    // (b) the honest-empty half, and the half a careless "always raise" fix
    // destroys. `[]` from a successful query is a real answer, and the builder's
    // "no stored data" sentence stays TRUE for a user who genuinely has none.
    db.$queryRaw.mockResolvedValue([]);

    const service = build();
    const stats = await service.getProfileHistory('DreadRock', targetUser());

    expect(stats?.months).toEqual([]);
    expect(stats?.years).toEqual([]);
  });

  it('does not query at all for a Last.fm-only viewer, and still returns empty', async () => {
    // userId 0 is the ONLY gate, and a `WHERE user_id = 0` would be a full scan
    // of a 40-million-row table for a guaranteed-empty answer. So this is the
    // genuine-empty case that must NOT raise: no query was attempted, so nothing
    // failed.
    db.$queryRaw.mockRejectedValue(new Error('must not be called'));

    const service = build();
    const stats = await service.getProfileHistory('DreadRock', targetUser({ userId: 0 }));

    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(stats?.months).toEqual([]);
    expect(stats?.years).toEqual([]);
  });

  it('returns null for a Last.fm user who does not exist, without querying', async () => {
    // The not-found case is a different shape entirely: `getUserInfo` returns
    // null and the method bails before either rollup. Untouched by the fix, and
    // worth pinning because it is the one absence that must NOT raise.
    db.$queryRaw.mockRejectedValue(new Error('must not be called'));

    const service = build(null);

    await expect(service.getProfileHistory('Nobody', targetUser())).resolves.toBeNull();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns the populated history when the rollups succeed', async () => {
    // The happy path, so a mutation that broke the mapping rather than the
    // catch still fails here.
    db.$queryRaw
      .mockResolvedValueOnce([
        { month_date: new Date('2024-06-15T00:00:00Z'), play_count: 3, total_ms: 120_000n },
      ])
      .mockResolvedValueOnce([
        { year_date: new Date('2024-01-01T00:00:00Z'), play_count: 3, total_ms: 120_000n },
      ]);

    const service = build();
    const stats = await service.getProfileHistory('DreadRock', targetUser());

    expect(stats?.months).toEqual([{ monthName: 'June', playCount: 3, timeString: '2 minutes' }]);
    expect(stats?.years).toEqual([
      { year: ' All', playCount: 3, timeString: '2 minutes' },
      { year: '2024', playCount: 3, timeString: '2 minutes' },
    ]);
  });
});

describe('ProfileService.getProfileStats — degraded reads omit their clause and say so', () => {
  it('keeps Last.fm variety counts and WARNs when the indexed read fails', async () => {
    // Not a lie and not a raise: the builder falls back to `lastFmUser.trackCount`
    // etc., which are real numbers from a real source. What is lost is the
    // ability to say "different from the ones Last.fm counts", and that is a lost
    // capability rather than a wrong answer - so the read must not take the card
    // down. The catch is left in place deliberately; these assertions exist to
    // stop a future sweep from "fixing" it into a raise.
    db.userArtist.count.mockRejectedValue(new Error('db down'));
    db.userAlbum.count.mockRejectedValue(new Error('db down'));
    db.userTrack.count.mockRejectedValue(new Error('db down'));

    const service = build();
    const stats = await service.getProfileStats('DreadRock', targetUser());

    expect(stats?.differentTracksCount).toBe(500);
    expect(stats?.differentAlbumsCount).toBe(60);
    expect(stats?.differentArtistsCount).toBe(30);
  });

  it('omits the friends line rather than inventing a count when the read fails', async () => {
    // The builder prints friends only under `> 0`, so `undefined` renders as
    // nothing. A genuine zero and a failure look identical, which is honest:
    // neither card claims a number.
    const service = new ProfileService(
      lastfmRepo(lastFmUser),
      { getTotalFriendCount: vi.fn(async () => { throw new Error('db down'); }) } as unknown as NonNullable<ConstructorParameters<typeof ProfileService>[1]>,
    );

    const stats = await service.getProfileStats('DreadRock', targetUser());

    expect(stats?.friendsCount).toBeUndefined();
  });
});
