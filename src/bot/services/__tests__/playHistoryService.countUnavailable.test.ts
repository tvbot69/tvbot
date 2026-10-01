/**
 * The rest of `playHistoryService`: a `count` that returns 0 and two
 * leaderboards that return `[]` were all produced by `catch`/`catch(() => [])`
 * during an outage, and both reach a user as a claim.
 *
 * `getArtistPlaycountForDays` is the one that goes in the CONFIDENT-ZERO
 * direction, and it is worth being precise about why, because the previous two
 * sites in this codebase failed in opposite directions and a reader who assumes
 * "empty result" is always the honest version will mis-predict this one.
 * `buildArtistPaceResponse` computes `avgPerDay = periodPlays / days` and then
 * prints "No plays found on <artist> in the last 30 days to estimate pace" - a
 * statement about what the user did - or projects a completion date from it. The
 * swallowed failure did not omit a clause; it REPLACED the number with a zero the
 * builder has no way to distrust.
 *
 * The two leaderboards are the plain empty case: `buildLeaderboardResponse`
 * renders `[]` as "No members found with plays in this server yet", which is a
 * claim about every member of a real server.
 *
 * Both directions are asserted for all three. Asserting only the raise would
 * also pass against a method that always raises, and for a `count` that is a
 * genuinely dangerous outcome: the user would be told they cannot have played
 * anything. That is why the zero is pinned as hard as the throw - and why the
 * comment in the source says raising cannot reach the genuine zero, because a
 * `count` that runs and matches no rows SUCCEEDS with 0.
 *
 * The database is mocked, not connected: this is about the contract of the
 * failure path. Plain-object doubles, built per test, handed to the constructor
 * in its exact positional order (`playRepository`, `lastfmRepository`,
 * `prisma`) - a swapped stub compiles clean and would make every query fail
 * inside the service, indistinguishable from "this user has no plays".
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { PlayHistoryService } from '../playHistoryService';
import { SourceUnavailableError, isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import { isLastFmUnavailable } from '@domain/models/lastfmUnavailableError';

/** Prisma 5xx / driver-level connectivity failure, the realistic shape. */
const DB_DOWN = () => new Error("Can't reach database server at `host.docker.internal:5432`");

const GUILD_ID = '112233445566778899';

type Db = {
  count: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
};

const makeService = (db: Partial<Db> = {}): PlayHistoryService => {
  const base: Db = {
    count: db.count ?? vi.fn(async (..._args: unknown[]) => 0),
    query: db.query ?? vi.fn(async () => []),
  };
  return new PlayHistoryService(
    {} as never,
    {} as never,
    {
      userPlay: { count: base.count },
      $queryRawUnsafe: base.query,
    } as unknown as PrismaClient,
  );
};

const failing = (): Db => ({
  count: vi.fn(async () => {
    throw DB_DOWN();
  }),
  query: vi.fn(async () => {
    throw DB_DOWN();
  }),
});

describe('PlayHistoryService.getArtistPlaycountForDays - a dead database is not zero plays', () => {
  it('raises rather than returning the 0 the pace card would print as fact', async () => {
    const db = failing();

    const err = await makeService(db).getArtistPlaycountForDays(1, 'Radiohead', 30).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as Error).message).toContain('playHistoryService.getArtistPlaycountForDays');
    expect((err as Error).message).toContain('Database unavailable');
    // The label names the query, so the log says which count failed rather than
    // which method happened to be running.
    expect((err as Error).message).toContain('artistPlaycountWindow');
    expect(db.count).toHaveBeenCalledTimes(1);
  });

  it('returns 0 when the count RAN and matched nothing', async () => {
    // The non-obvious half. A `count` with no matching rows SUCCEEDS with 0, so
    // "the user did not listen to this artist in the window" never reaches the
    // guard. Raising must not have flipped this the other way - that would tell
    // a real zero "the database is down" and send users chasing an outage.
    const db = { count: vi.fn(async (..._args: unknown[]) => 0) };

    await expect(makeService(db).getArtistPlaycountForDays(1, 'Radiohead', 30)).resolves.toBe(0);
    expect(db.count).toHaveBeenCalledTimes(1);
  });

  it('returns the real number when the count succeeds', async () => {
    const db = { count: vi.fn(async (..._args: unknown[]) => 412) };

    await expect(makeService(db).getArtistPlaycountForDays(1, 'Radiohead', 30)).resolves.toBe(412);
  });

  it('scopes the count to the user, the window and the artist', async () => {
    // Without this the raise could have been bought by widening or dropping the
    // filter, and a "0 plays in 30 days" from a broken `where` is the same lie
    // wearing a different hat.
    const db = { count: vi.fn(async (..._args: unknown[]) => 1) };
    const before = Date.now();

    await makeService(db).getArtistPlaycountForDays(7, 'Radiohead', 30);

    expect(db.count).toHaveBeenCalledWith({
      where: {
        userId: 7,
        timePlayed: { gte: expect.any(Date) },
        artistName: { equals: 'Radiohead', mode: 'insensitive' },
      },
    });
    const args = db.count.mock.calls[0]![0] as { where: { timePlayed: { gte: Date } } };
    const cutoff = args.where.timePlayed.gte.getTime();
    // 30 days back, allowing a little slack for the clock advancing mid-test.
    const thirtyDays = 30 * 86400 * 1000;
    expect(cutoff).toBeLessThanOrEqual(before - thirtyDays + 5000);
    expect(cutoff).toBeGreaterThanOrEqual(before - thirtyDays - 5000);
  });

  it('produces an error the Last.fm family check does not claim', async () => {
    const err = await makeService(failing())
      .getArtistPlaycountForDays(1, 'Radiohead', 30)
      .catch((e: unknown) => e);

    expect(isSourceUnavailable(err)).toBe(true);
    expect(isLastFmUnavailable(err)).toBe(false);
  });
});

describe('PlayHistoryService guild leaderboards - an outage is not an empty server', () => {
  const CASES = [
    {
      name: 'getGuildPlayLeaderboard',
      run: (s: PlayHistoryService) => s.getGuildPlayLeaderboard(GUILD_ID),
      rows: [
        {
          discord_user_id: 111n,
          user_name_last_fm: 'moha',
          display_name: null,
          playcount: 900n,
        },
      ],
      expected: { discordUserId: '111', userNameLastFm: 'moha', displayName: 'moha', value: 900 },
    },
    {
      name: 'getGuildTimeLeaderboard',
      run: (s: PlayHistoryService) => s.getGuildTimeLeaderboard(GUILD_ID),
      rows: [
        {
          discord_user_id: 111n,
          user_name_last_fm: 'moha',
          display_name: null,
          total_minutes: 4200n,
        },
      ],
      expected: { discordUserId: '111', userNameLastFm: 'moha', displayName: 'moha', value: 4200 },
    },
  ] as const;

  it.each(CASES)('$name raises instead of returning an empty leaderboard', async (c) => {
    const db = failing();

    const err = await c.run(makeService(db)).catch((e: unknown) => e);

    expect(isSourceUnavailable(err)).toBe(true);
    expect((err as Error).message).toContain(`playHistoryService.${c.name}`);
  });

  it.each(CASES)('$name returns an empty list when the query RAN and found nobody', async (c) => {
    // A server whose members have no indexed plays is a real, common state - a
    // fresh server, or one where nobody has opted into scrobbling - and it must
    // keep rendering "No members found with plays in this server yet" rather
    // than "the database is unreachable". This is the half that stops the fix
    // from being a new bug.
    const db = { query: vi.fn(async () => []) };

    await expect(c.run(makeService(db))).resolves.toEqual([]);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it.each(CASES)('$name still returns the real rows', async (c) => {
    const db = { query: vi.fn(async () => c.rows) };

    await expect(c.run(makeService(db))).resolves.toEqual([c.expected]);
  });
});
