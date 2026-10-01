import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrownRepository } from '../crownRepository';

/**
 * The 17 crownRepository methods `crownRepository.test.ts` does not reach.
 *
 * That file covers `replaceCrown` alone, which is the right call - it is the
 * money path - but it left every read and every other write at zero. This file
 * covers the rest over a hand-written Prisma double, for two reasons:
 *
 *  1. `crownRepository.db.test.ts` DOES cover most of this, but it only runs in
 *     CI against a disposable postgres. Locally it is 500+ skipped assertions,
 *     so the branch that decides what a crown page renders is unexercised on
 *     the machine that writes the code.
 *  2. The unit double can pin the THING THAT ACTUALLY GOES WRONG HERE, which a
 *     real database cannot: the arguments handed to Prisma. A where-clause that
 *     names a column the model does not have, or a view boolean bound the wrong
 *     way round, is a RUNTIME failure in production and a silent pass in a db
 *     test written against the same broken string.
 *
 * ---------------------------------------------------------------------------
 * THE PROPERTY UNDER TEST, THROUGHOUT: A FAILED READ IS NOT AN EMPTY READ.
 * ---------------------------------------------------------------------------
 *
 * Every `catch` in this directory that turns a failure into `[]`, `null` or `0`
 * is a machine for a confident wrong answer, and crowns are the most visible
 * number the bot has: "X holds the Radiohead crown" is rendered in a public
 * channel. `getUserAllTimeTopAlbumsByReleasePrefix` once selected columns that
 * did not exist and its catch returned the UNFILTERED list, so a broken query
 * reported as "the top albums, all of them" - a plausible number with no way
 * for the reader to tell it was fabricated. crownRepository has no catch at
 * all today, and that is the correct shape; the `a failed read is not an empty
 * read` block at the bottom exists to keep it that way, method by method, so a
 * future `catch { return [] }` fails the suite instead of shipping.
 *
 * Each read is therefore tested in BOTH directions: a genuine empty result IS
 * empty, and a database failure is NOT empty.
 */

type Args = Record<string, unknown>;

const callArg = <T = Args>(fn: unknown, callIndex = 0, argIndex = 0): T =>
  (fn as { mock: { calls: unknown[][] } }).mock.calls[callIndex]?.[argIndex] as T;

/**
 * A tagged-template call is `(strings, ...values)`. Joining the static text with
 * `?` gives one inspectable string in which every interpolation is a hole, and
 * the values array then says what was put in each hole - which is the only way
 * to see that `getUserCrowns` binds `active = false` for the Stolen view and
 * `true` for the other two, or that a LIMIT is a number and not a string.
 *
 * A repository method is a claim about the SCHEMA, so the expected `sql` here
 * is checked against `src/persistence/prisma/schema.prisma`: every aliased
 * column asserted below exists on the model it is read from.
 */
type RawCall = { sql: string; values: unknown[] };

const rawCallOf = (fn: unknown, index = 0): RawCall => {
  const call = (fn as { mock: { calls: unknown[][] } }).mock.calls[index];
  if (!call) throw new Error('no raw query was issued');
  const strings = call[0] as TemplateStringsArray;
  return { sql: strings.join('?'), values: call.slice(1) };
};

/** A raw-query row: exactly the columns the six queries alias. */
const crownRow = (over: Args = {}) => ({
  crownId: 1,
  guildId: '8800001',
  userId: 7,
  artistName: 'Radiohead',
  currentPlaycount: 40,
  startPlaycount: 10,
  created: new Date('2024-01-01T12:00:00Z'),
  modified: new Date('2024-01-02T12:00:00Z'),
  active: true,
  seededCrown: false,
  userNameLastFm: 'someone',
  discordUserId: '4242',
  ...over,
});

/**
 * One Prisma double for every model crownRepository touches: `user_crowns`,
 * `guild_users` (the crown block) and `guilds` (crown roles).
 *
 * `updateMany` / `count` / `findFirst` / `deleteMany` evaluate their `where`
 * against the row set, so the number they return is a real number rather than a
 * fixture constant. Without that, a mutation that flipped `active: false` to
 * `active: true` would still report "3 deactivated" and the test would pass on
 * the exact regression it was written to catch.
 */
const makePrisma = (seed: { crowns?: Args[] } = {}) => {
  const state = {
    crowns: (seed.crowns ?? []).map((c) => ({ ...c })),
    queries: 0 as number,
  };

  const matches = (row: Args, where: Args): boolean => {
    for (const [key, value] of Object.entries(where)) {
      if (key === 'AND') {
        if (!(value as Args[]).every((sub) => matches(row, sub))) return false;
        continue;
      }
      if (key === 'OR') {
        if (!(value as Args[]).some((sub) => matches(row, sub))) return false;
        continue;
      }
      if (value === null || typeof value !== 'object') {
        if (row[key] !== value) return false;
        continue;
      }
      const ops = value as Args;
      if ('equals' in ops) {
        if (String(row[key]).toLowerCase() !== String(ops.equals).toLowerCase()) return false;
        if (ops.mode !== undefined && ops.mode !== 'insensitive') {
          throw new Error('crown double only models mode: insensitive');
        }
        continue;
      }
      // An operator this double does not model must fail loudly, or a test
      // asserting against a shape it does not understand passes for the wrong
      // reason.
      throw new Error(`crown double cannot model the operator on "${key}"`);
    }
    return true;
  };

  const userCrown = {
    create: vi.fn(async (..._args: unknown[]) => {
      const arg = _args[0] as { data: Args; include?: Args };
      const row = { crownId: 900, created: new Date(), modified: new Date(), ...arg.data };
      state.crowns.push(row);
      return arg.include
        ? { ...row, user: { userNameLastFm: 'winner', discordUserId: 42n } }
        : row;
    }),
    update: vi.fn(async (..._args: unknown[]) => {
      const arg = _args[0] as { where: Args; data: Args };
      const row = state.crowns.find((c) => String(c.crownId) === String(arg.where.crownId));
      if (!row) throw new Error(`no crown ${String(arg.where.crownId)}`);
      Object.assign(row, arg.data);
      return row;
    }),
    updateMany: vi.fn(async (..._args: unknown[]) => {
      const arg = _args[0] as { where: Args; data: Args };
      const hit = state.crowns.filter((c) => matches(c, arg.where));
      for (const h of hit) Object.assign(h, arg.data);
      return { count: hit.length };
    }),
    deleteMany: vi.fn(async (..._args: unknown[]) => {
      const arg = _args[0] as { where: Args };
      const hit = state.crowns.filter((c) => matches(c, arg.where));
      const keep = state.crowns.filter((c) => !hit.includes(c));
      state.crowns.length = 0;
      state.crowns.push(...keep);
      return { count: hit.length };
    }),
    findFirst: vi.fn(async (..._args: unknown[]) => {
      const arg = _args[0] as { where: Args };
      return state.crowns.find((c) => matches(c, arg.where)) ?? null;
    }),
    count: vi.fn(async (..._args: unknown[]) => {
      const arg = _args[0] as { where: Args };
      return state.crowns.filter((c) => matches(c, arg.where)).length;
    }),
  };

  return {
    state,
    userCrown,
    guildUser: {
      upsert: vi.fn(async (..._args: unknown[]) => ({ guildId: 1n, userId: 1 })),
    },
    guild: {
      update: vi.fn(async (..._args: unknown[]) => ({ guildId: 1n })),
      findUnique: vi.fn(async (..._args: unknown[]) => null as unknown),
    },
    $queryRaw: vi.fn(async (..._args: unknown[]) => {
      state.queries += 1;
      return [] as unknown[];
    }),
  };
};

type Double = ReturnType<typeof makePrisma>;

const GUILD = '8800001';

/** Row lookup by primary key. `state.crowns` is untyped, so the id is compared as text. */
const crownById = (p: Double, crownId: number): Args | undefined =>
  p.state.crowns.find((c) => String(c.crownId) === String(crownId));

let prisma: Double;
let r: CrownRepository;

beforeEach(() => {
  prisma = makePrisma();
  r = new CrownRepository(prisma as never);
});

describe('CrownRepository.safeBigInt (the malformed-guild-id guard)', () => {
  /**
   * A guild id arrives from Discord as a string and `BigInt('abc')` THROWS, so
   * the guard is what stops a bad id from becoming an exception the user sees
   * as a crash. More importantly the answer it produces is "no such guild",
   * which is an honest absence - NOT "the database is unreachable", which
   * would send an operator to Postgres for a fault that is upstream of it.
   *
   * The load-bearing half is that the query is never OPENED: a guard that ran
   * after the read would be useless.
   */
  it('answers empty WITHOUT opening a query for a non-numeric guild id', async () => {
    expect(await r.getCurrentCrown('not-a-guild', 'Radiohead')).toBeNull();
    expect(await r.getUserCrowns('not-a-guild', 7)).toEqual([]);
    expect(await r.getTopCrownHoldersInGuild('not-a-guild')).toEqual([]);
    expect(await r.getTotalActiveCrownsInGuild('not-a-guild')).toBe(0);
    expect(await r.getCrownHistoryForArtist('not-a-guild', 'Radiohead')).toEqual([]);
    expect(await r.seedCrownsForGuild('not-a-guild')).toBe(0);
    expect(await r.getBlockedCrownUsers('not-a-guild')).toEqual([]);
    expect(await r.getCrownRoles('not-a-guild')).toEqual([]);
    expect(await r.killAllCrowns('not-a-guild')).toBe(0);

    expect(prisma.state.queries).toBe(0);
    expect(prisma.userCrown.count).not.toHaveBeenCalled();
    expect(prisma.userCrown.deleteMany).not.toHaveBeenCalled();
    expect(prisma.userCrown.updateMany).not.toHaveBeenCalled();
    expect(prisma.guild.findUnique).not.toHaveBeenCalled();
  });

  it('answers empty for an EMPTY guild id, which is also not a database fault', async () => {
    expect(await r.getCurrentCrown('', 'Radiohead')).toBeNull();
    expect(await r.getUserCrowns('', 7)).toEqual([]);
    expect(await r.getTotalActiveCrownsInGuild('')).toBe(0);
    expect(prisma.state.queries).toBe(0);
  });

  it('refuses a NEGATIVE guild id rather than coercing it', async () => {
    // `/^\d+$/` rejects the sign. A negative BigInt would otherwise be a
    // syntactically valid query against a primary key that cannot hold it.
    expect(await r.getTotalActiveCrownsInGuild('-5')).toBe(0);
    expect(prisma.userCrown.count).not.toHaveBeenCalled();
  });

  it('does not query an id with surrounding whitespace', async () => {
    expect(await r.getCurrentCrown(' 8800001 ', 'Radiohead')).toBeNull();
    expect(prisma.state.queries).toBe(0);
  });

  it('accepts a leading zero, which is a valid numeric string', async () => {
    // `/^\d+$/` admits `008800001` and `BigInt('008800001')` is 880001n, so this
    // is a REAL guild id and the query must be opened.
    prisma.$queryRaw.mockResolvedValue([crownRow()] as never);
    await expect(r.getCurrentCrown('008800001', 'Radiohead')).resolves.not.toBeNull();
    // Asserted on the mock's own call count, NOT on `state.queries`: that
    // counter only increments in the DEFAULT `$queryRaw` implementation, and
    // `mockResolvedValue` above replaced it, so it reads 0 on any test that
    // stubs a response.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('CrownRepository.getCurrentCrown', () => {
  it('returns the first row, which is the LIMIT 1 winner', async () => {
    prisma.$queryRaw.mockResolvedValue([crownRow({ crownId: 5 })] as never);

    const got = await r.getCurrentCrown(GUILD, 'Radiohead');

    expect(got?.crownId).toBe(5);
    expect(got?.userNameLastFm).toBe('someone');
    expect(got?.discordUserId).toBe('4242');
    expect(got?.active).toBe(true);
  });

  it('joins the holder, and asks only for the ACTIVE crown in that one guild', async () => {
    prisma.$queryRaw.mockResolvedValue([crownRow()] as never);
    await r.getCurrentCrown(GUILD, 'Radiohead');
    const { sql, values } = rawCallOf(prisma.$queryRaw);

    expect(sql).toMatch(/FROM user_crowns c\s*JOIN users u ON u\.user_id = c\.user_id/);
    // A stolen crown is not the current holder; returning one here is a
    // "wrong user publicly credited as top listener" bug.
    expect(sql).toMatch(/c\.active = true/);
    expect(sql).toMatch(/LIMIT 1/);
    // The BigInt guild id is BOUND, not interpolated into the statement.
    expect(values[0]).toBe(8800001n);
  });

  it('matches the artist name case-insensitively, keeping its original casing', async () => {
    prisma.$queryRaw.mockResolvedValue([crownRow()] as never);
    await r.getCurrentCrown(GUILD, 'RaDiOhEaD');
    const { sql, values } = rawCallOf(prisma.$queryRaw);
    // Last.fm sends whatever the tagger typed, so an exact match silently
    // finds nothing and the card shows "no crown".
    expect(sql).toMatch(/UPPER\(c\.artist_name\) = UPPER\(\?\)/);
    expect(values[1]).toBe('RaDiOhEaD');
  });

  it('returns null - not a crown - when nobody holds it', async () => {
    prisma.$queryRaw.mockResolvedValue([] as never);
    expect(await r.getCurrentCrown(GUILD, 'Radiohead')).toBeNull();
  });
});

describe('CrownRepository.getUserCrowns', () => {
  it('filters on the active flag for the Playcount view', async () => {
    prisma.$queryRaw.mockResolvedValue([crownRow()] as never);
    await r.getUserCrowns(GUILD, 7, 'Playcount');
    const { sql, values } = rawCallOf(prisma.$queryRaw);
    expect(sql).toMatch(/c\.active = \?/);
    expect(values[2]).toBe(true);
  });

  it('DEFAULTS to the Playcount view when the caller names none', async () => {
    prisma.$queryRaw.mockResolvedValue([crownRow()] as never);
    expect(await r.getUserCrowns(GUILD, 7)).toHaveLength(1);
    expect(rawCallOf(prisma.$queryRaw).values[2]).toBe(true);
  });

  it('lists INACTIVE crowns for the Stolen view, newest steal first', async () => {
    // The whole point of the Stolen tab is the crowns you LOST, so the active
    // filter inverts here. Read as `active = true` it renders the tab empty,
    // which looks like "you have never had a crown".
    prisma.$queryRaw.mockResolvedValue([crownRow({ active: false })] as never);
    const got = await r.getUserCrowns(GUILD, 7, 'Stolen');
    const { sql, values } = rawCallOf(prisma.$queryRaw);

    expect(got[0]?.active).toBe(false);
    expect(values[2]).toBe(false);
    expect(sql).toMatch(/CASE WHEN \? THEN c\.modified END DESC/);
    // Exactly one of the three view booleans is true, and it is the Stolen one.
    expect(values.slice(3, 6)).toEqual([false, true, false]);
  });

  it('orders by created for the Recent view', async () => {
    await r.getUserCrowns(GUILD, 7, 'Recent');
    const { sql, values } = rawCallOf(prisma.$queryRaw);
    expect(values.slice(3, 6)).toEqual([true, false, false]);
    expect(sql).toMatch(/CASE WHEN \? THEN c\.created END DESC/);
  });

  it('orders by playcount for the Playcount view', async () => {
    await r.getUserCrowns(GUILD, 7, 'Playcount');
    const { sql, values } = rawCallOf(prisma.$queryRaw);
    expect(values.slice(3, 6)).toEqual([false, false, true]);
    expect(sql).toMatch(/CASE WHEN \? THEN c\.current_playcount END DESC/);
  });

  it('never leaks another user crowns into the result', async () => {
    await r.getUserCrowns(GUILD, 7);
    const { sql, values } = rawCallOf(prisma.$queryRaw);
    expect(sql).toMatch(/c\.user_id = \?/);
    expect(values[1]).toBe(7);
  });

  it('returns an empty list for a user with no crowns', async () => {
    prisma.$queryRaw.mockResolvedValue([] as never);
    expect(await r.getUserCrowns(GUILD, 7)).toEqual([]);
  });
});

describe('CrownRepository.getTopCrownHoldersInGuild', () => {
  it('returns one aggregated row per holder', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { userId: 7, crownCount: 12, userNameLastFm: 'someone', discordUserId: '4242' },
    ] as never);

    expect(await r.getTopCrownHoldersInGuild(GUILD)).toEqual([
      { userId: 7, crownCount: 12, userNameLastFm: 'someone', discordUserId: '4242' },
    ]);
  });

  it('counts only ACTIVE crowns, so a user who lost everything drops off', async () => {
    await r.getTopCrownHoldersInGuild(GUILD);
    const { sql } = rawCallOf(prisma.$queryRaw);
    expect(sql).toMatch(/c\.active = true/);
    expect(sql).toMatch(/GROUP BY c\.user_id/);
  });

  it('orders the leaderboard by the aliased crown count', async () => {
    await r.getTopCrownHoldersInGuild(GUILD);
    // The ORDER BY references the SELECT alias, which is also what
    // `CrownLeaderboardEntry.crownCount` is typed against. `ORDER BY COUNT(*)`
    // would still be valid SQL but would no longer match the alias.
    expect(rawCallOf(prisma.$queryRaw).sql).toMatch(/ORDER BY "crownCount" DESC/);
  });

  it('returns an empty list for a guild with no crowns', async () => {
    prisma.$queryRaw.mockResolvedValue([] as never);
    expect(await r.getTopCrownHoldersInGuild(GUILD)).toEqual([]);
  });
});

describe('CrownRepository.getTotalActiveCrownsInGuild', () => {
  it('counts the active rows for exactly that guild', async () => {
    expect(await r.getTotalActiveCrownsInGuild(GUILD)).toBe(0);
    expect(callArg(prisma.userCrown.count)).toEqual({
      where: { guildId: 8800001n, active: true },
    });
    // A count, not a raw query - a different mechanism, so a different test.
    expect(prisma.state.queries).toBe(0);
  });

  it('returns 0 for a guild whose crown table is genuinely empty', async () => {
    prisma.userCrown.count.mockResolvedValue(0 as never);
    expect(await r.getTotalActiveCrownsInGuild(GUILD)).toBe(0);
  });
});

describe('CrownRepository.getCrownHistoryForArtist', () => {
  it('bounds the result with a NUMERIC limit of ten by default', async () => {
    await r.getCrownHistoryForArtist(GUILD, 'Radiohead');
    const { sql, values } = rawCallOf(prisma.$queryRaw);
    expect(sql).toMatch(/LIMIT \?/);
    expect(values[2]).toBe(10);
    expect(typeof values[2]).toBe('number');
  });

  it('honours an explicit limit, including zero', async () => {
    await r.getCrownHistoryForArtist(GUILD, 'Radiohead', 3);
    expect(rawCallOf(prisma.$queryRaw).values[2]).toBe(3);

    prisma.$queryRaw.mockClear();
    await r.getCrownHistoryForArtist(GUILD, 'Radiohead', 0);
    expect(rawCallOf(prisma.$queryRaw).values[2]).toBe(0);
  });

  it('matches the artist case-insensitively', async () => {
    await r.getCrownHistoryForArtist(GUILD, 'radiohead');
    expect(rawCallOf(prisma.$queryRaw).sql).toMatch(/UPPER\(c\.artist_name\) = UPPER\(\?\)/);
  });

  it('returns STOLEN crowns as well as live ones, newest first', async () => {
    // No `active` FILTER here: the history IS the point, and an active filter
    // would render "crown history" as "crowns you still hold". The column is
    // still SELECTed (`c.active as "active"`), so the assertion is scoped to
    // the WHERE clause rather than the whole statement.
    await r.getCrownHistoryForArtist(GUILD, 'Radiohead');
    const { sql } = rawCallOf(prisma.$queryRaw);
    const where = sql.slice(sql.indexOf('WHERE'));
    expect(where).not.toMatch(/active/);
    expect(sql).toMatch(/c\.active as "active"/);
    expect(sql).toMatch(/ORDER BY c\.created DESC/);
  });

  it('returns an empty list for an artist nobody has ever crowned', async () => {
    prisma.$queryRaw.mockResolvedValue([] as never);
    expect(await r.getCrownHistoryForArtist(GUILD, 'Nothing Here')).toEqual([]);
  });
});

describe('CrownRepository.createCrown', () => {
  it('creates an ACTIVE crown seeded from the supplied playcounts', async () => {
    await r.createCrown({
      guildId: GUILD, userId: 7, artistName: 'Radiohead', startPlaycount: 10, currentPlaycount: 40,
    });

    expect(callArg(prisma.userCrown.create)).toEqual({
      data: {
        guildId: 8800001n,
        userId: 7,
        artistName: 'Radiohead',
        startPlaycount: 10,
        currentPlaycount: 40,
        active: true,
        seededCrown: false,
      },
      include: { user: true },
    });
  });

  it('carries an explicit seededCrown flag through', async () => {
    await r.createCrown({
      guildId: GUILD, userId: 7, artistName: 'Radiohead',
      startPlaycount: 1, currentPlaycount: 1, seededCrown: true,
    });
    expect(callArg<{ data: Args }>(prisma.userCrown.create).data.seededCrown).toBe(true);
  });

  it('stringifies the BigInt guild and discord ids in the DTO', async () => {
    // A BigInt reaching JSON.stringify throws, which in practice means the
    // whole embed fails to send rather than this method being visibly wrong.
    const dto = await r.createCrown({
      guildId: GUILD, userId: 7, artistName: 'Radiohead', startPlaycount: 1, currentPlaycount: 2,
    });

    expect(typeof dto.guildId).toBe('string');
    expect(typeof dto.discordUserId).toBe('string');
    expect(dto.userNameLastFm).toBe('winner');
    expect(() => JSON.stringify(dto)).not.toThrow();
  });
});

describe('CrownRepository deactivate and count writers', () => {
  it('deactivateCrownsForUser touches only that user active crowns and reports the count', async () => {
    prisma = makePrisma({
      crowns: [
        { crownId: 1, guildId: 8800001n, userId: 7, active: true },
        { crownId: 2, guildId: 8800001n, userId: 7, active: false },
        { crownId: 3, guildId: 8800001n, userId: 8, active: true },
      ],
    });
    r = new CrownRepository(prisma as never);

    expect(await r.deactivateCrownsForUser(7)).toBe(1);
    expect(callArg<{ where: Args }>(prisma.userCrown.updateMany).where).toEqual({
      userId: 7,
      active: true,
    });
    // The already-inactive row is not re-stamped, and the other user is intact.
    expect(crownById(prisma, 2)?.modified).toBeUndefined();
    expect(crownById(prisma, 3)?.active).toBe(true);
  });

  it('deactivateCrown deactivates one crown by its primary key', async () => {
    prisma = makePrisma({ crowns: [{ crownId: 4, guildId: 8800001n, userId: 7, active: true }] });
    r = new CrownRepository(prisma as never);

    await r.deactivateCrown(4);

    expect(prisma.state.crowns[0]?.active).toBe(false);
    expect(prisma.state.crowns[0]?.modified).toBeInstanceOf(Date);
  });

  it('updateCrownPlaycount writes the count and stamps modified', async () => {
    prisma = makePrisma({ crowns: [{ crownId: 4, guildId: 8800001n, userId: 7, currentPlaycount: 1 }] });
    r = new CrownRepository(prisma as never);

    await r.updateCrownPlaycount(4, 99);

    expect(prisma.state.crowns[0]?.currentPlaycount).toBe(99);
    expect(callArg<{ where: Args }>(prisma.userCrown.update).where).toEqual({ crownId: 4 });
  });

  it('killCrown reports true only when a live crown actually moved', async () => {
    prisma = makePrisma({
      crowns: [
        { crownId: 1, guildId: 8800001n, artistName: 'Radiohead', active: true },
        { crownId: 2, guildId: 8800001n, artistName: 'Muse', active: false },
      ],
    });
    r = new CrownRepository(prisma as never);

    expect(await r.killCrown(GUILD, 'radiohead')).toBe(true);
    expect(prisma.state.crowns[0]?.active).toBe(false);
    // Already dead, and the artist name is matched case-insensitively.
    expect(await r.killCrown(GUILD, 'MUSE')).toBe(false);
  });

  it('killCrown reports false for an artist nobody has a crown for', async () => {
    expect(await r.killCrown(GUILD, 'Nothing Here')).toBe(false);
  });

  it('killAllCrowns empties the guild and reports how many went', async () => {
    prisma = makePrisma({
      crowns: [
        { crownId: 1, guildId: 8800001n, active: true },
        { crownId: 2, guildId: 8800001n, active: true },
        { crownId: 3, guildId: 8800002n, active: true },
      ],
    });
    r = new CrownRepository(prisma as never);

    expect(await r.killAllCrowns(GUILD)).toBe(2);
    // The other guild is untouched - this is the scope that matters.
    expect(crownById(prisma, 3)?.active).toBe(true);
  });

  it('removeUserCrowns deactivates that user crowns in that guild only', async () => {
    prisma = makePrisma({
      crowns: [
        { crownId: 1, guildId: 8800001n, userId: 7, active: true },
        { crownId: 2, guildId: 8800001n, userId: 8, active: true },
        { crownId: 3, guildId: 8800002n, userId: 7, active: true },
      ],
    });
    r = new CrownRepository(prisma as never);

    expect(await r.removeUserCrowns(GUILD, 7)).toBe(1);
    expect(crownById(prisma, 2)?.active).toBe(true);
    expect(crownById(prisma, 3)?.active).toBe(true);
  });
});

describe('CrownRepository.setCrownBlock', () => {
  it('upserts the guild_users row on its composite key', async () => {
    await r.setCrownBlock(GUILD, 7, true);

    expect(callArg(prisma.guildUser.upsert)).toEqual({
      where: { guildId_userId: { guildId: 8800001n, userId: 7 } },
      update: { blockedFromCrowns: true },
      create: { guildId: 8800001n, userId: 7, blockedFromCrowns: true },
    });
  });

  it('drops the blocked user crowns in the same guild, because the block wins', async () => {
    prisma = makePrisma({
      crowns: [
        { crownId: 1, guildId: 8800001n, userId: 7, active: true },
        { crownId: 2, guildId: 8800001n, userId: 8, active: true },
      ],
    });
    r = new CrownRepository(prisma as never);

    await r.setCrownBlock(GUILD, 7, true);

    expect(crownById(prisma, 1)?.active).toBe(false);
    expect(crownById(prisma, 2)?.active).toBe(true);
  });

  it('UNBLOCKING must NOT resurrect or touch crowns', async () => {
    prisma = makePrisma({ crowns: [{ crownId: 1, guildId: 8800001n, userId: 7, active: false }] });
    r = new CrownRepository(prisma as never);

    await r.setCrownBlock(GUILD, 7, false);

    expect(prisma.userCrown.updateMany).not.toHaveBeenCalled();
    expect(prisma.state.crowns[0]?.active).toBe(false);
  });

  it('writes blockedFromCrowns false on the unblock branch too', async () => {
    await r.setCrownBlock(GUILD, 7, false);
    expect(callArg<{ update: Args }>(prisma.guildUser.upsert).update.blockedFromCrowns).toBe(false);
  });
});

describe('CrownRepository.getBlockedCrownUsers', () => {
  it('returns the blocked members with their last.fm name and discord id', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { userId: 7, userNameLastFm: 'someone', discordUserId: '4242' },
    ] as never);

    expect(await r.getBlockedCrownUsers(GUILD)).toEqual([
      { userId: 7, userNameLastFm: 'someone', discordUserId: '4242' },
    ]);
  });

  it('reads the flag from guild_users, not from the crown rows', async () => {
    await r.getBlockedCrownUsers(GUILD);
    // The block is a guild_users column. A query against user_crowns here
    // would return [] forever and the admin would see "nobody is blocked".
    const { sql } = rawCallOf(prisma.$queryRaw);
    expect(sql).toMatch(/FROM guild_users gu/);
    expect(sql).toMatch(/gu\.blocked_from_crowns = true/);
  });

  it('returns an empty list when nobody is blocked', async () => {
    prisma.$queryRaw.mockResolvedValue([] as never);
    expect(await r.getBlockedCrownUsers(GUILD)).toEqual([]);
  });
});

describe('CrownRepository crown roles', () => {
  it('stores a single role as a one-element BigInt array', async () => {
    await r.setCrownRole(GUILD, '555');

    expect(callArg(prisma.guild.update)).toEqual({
      where: { guildId: 8800001n },
      data: { crownRoles: [555n] },
    });
  });

  it('clears the roles ONLY for a null role id, which is the one explicit request to', async () => {
    await r.setCrownRole(GUILD, null);
    expect(callArg<{ data: Args }>(prisma.guild.update).data.crownRoles).toEqual([]);
  });

  it('RAISES on a NON-NUMERIC role id instead of silently clearing the config', async () => {
    // This used to be read as "remove the role", so a typo emptied `crownRoles`
    // and the admin was told the role had been set. The next crown
    // notification then went out unpinged with nothing in the logs to say why.
    // Writing the garbage string into a BigInt[] column is not an option
    // either — that is a failure the admin sees as "the crown role could not be
    // set" with the real cause buried in the database log.
    await expect(r.setCrownRole(GUILD, 'not-a-role')).rejects.toThrow(TypeError);
    await expect(r.setCrownRole(GUILD, 'not-a-role')).rejects.toThrow(/roleId must be a decimal string, or null to clear/);
    // The config is untouched, which is the whole point: a bad argument must
    // not destroy working configuration on its way to the error.
    expect(prisma.guild.update).not.toHaveBeenCalled();
  });

  it('raises on an EMPTY role id too, because "" is not an instruction to clear', async () => {
    // The command layer sends `null` for `.crownroles none`; an empty string
    // means the caller passed an argument it never validated, and honouring it
    // is the same silent wipe with a different spelling.
    await expect(r.setCrownRole(GUILD, '')).rejects.toThrow(/roleId must be a decimal string, or null to clear/);
    expect(prisma.guild.update).not.toHaveBeenCalled();
  });

  it('rejects a role id BigInt would refuse but a loose check might accept', async () => {
    for (const bad of ['12.5', ' 555', '555n', '0x22b', '-1', '55 5']) {
      await expect(r.setCrownRole(GUILD, bad)).rejects.toThrow(/roleId must be a decimal string/);
    }
    expect(prisma.guild.update).not.toHaveBeenCalled();
  });

  it('CONTROL: a valid role id is still stored, so the guard is not just refusing everything', async () => {
    await r.setCrownRole(GUILD, '555');
    expect(callArg<{ data: Args }>(prisma.guild.update).data.crownRoles).toEqual([555n]);
  });

  it('getCrownRoles stringifies the stored BigInt array', async () => {
    prisma.guild.findUnique.mockResolvedValue({ crownRoles: [555n, 666n] } as never);

    expect(await r.getCrownRoles(GUILD)).toEqual(['555', '666']);
    expect(callArg(prisma.guild.findUnique)).toEqual({
      where: { guildId: 8800001n },
      select: { crownRoles: true },
    });
  });

  it('getCrownRoles returns empty for a guild with no roles configured', async () => {
    prisma.guild.findUnique.mockResolvedValue({ crownRoles: [] } as never);
    expect(await r.getCrownRoles(GUILD)).toEqual([]);
  });

  it('getCrownRoles returns empty for a guild row that does not exist', async () => {
    prisma.guild.findUnique.mockResolvedValue(null as never);
    // "no such guild" is an honest absence, rendered as "no crown role is
    // configured" rather than claiming a lookup succeeded.
    expect(await r.getCrownRoles(GUILD)).toEqual([]);
  });
});

describe('CrownRepository.seedCrownsForGuild', () => {
  it('deletes only SEEDED crowns first, so a real hand-claimed crown survives', async () => {
    await r.seedCrownsForGuild(GUILD);
    expect(callArg<{ where: Args }>(prisma.userCrown.deleteMany).where).toEqual({
      guildId: 8800001n,
      seededCrown: true,
    });
  });

  it('applies the minimum playcount threshold inclusively and skips blocked members', async () => {
    await r.seedCrownsForGuild(GUILD, 30);
    const { sql, values } = rawCallOf(prisma.$queryRaw);
    expect(values[1]).toBe(30);
    expect(sql).toMatch(/ua\.playcount >= \?/);
    expect(sql).toMatch(/gu\.blocked_from_crowns = false/);
    expect(sql).toMatch(/gu\.who_knows_banned = false/);
  });

  it('DEFAULTS the threshold to 30', async () => {
    await r.seedCrownsForGuild(GUILD);
    expect(rawCallOf(prisma.$queryRaw).values[1]).toBe(30);
  });

  it('gives each artist to exactly one user, the top listener, whatever the spelling', async () => {
    await r.seedCrownsForGuild(GUILD);
    // Case-variant duplicate user_artists rows would otherwise seed two
    // crowns for one artist, and the second holder would be the wrong user.
    expect(rawCallOf(prisma.$queryRaw).sql).toMatch(/SELECT DISTINCT ON \(LOWER\(ua\.name\)\)/);
  });

  it('creates one seeded crown per candidate and reports the count', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { userId: 7, artistName: 'Radiohead', playcount: 40 },
      { userId: 8, artistName: 'Muse', playcount: 35 },
    ] as never);

    expect(await r.seedCrownsForGuild(GUILD)).toBe(2);

    expect(prisma.userCrown.create).toHaveBeenCalledTimes(2);
    expect(callArg<{ data: Args }>(prisma.userCrown.create).data).toEqual({
      guildId: 8800001n,
      userId: 7,
      artistName: 'Radiohead',
      startPlaycount: 40,
      currentPlaycount: 40,
      active: true,
      seededCrown: true,
    });
  });

  it('SKIPS a candidate who already holds a live crown, and does not count it', async () => {
    prisma = makePrisma({ crowns: [{ crownId: 1, guildId: 8800001n, artistName: 'Radiohead', active: true }] });
    r = new CrownRepository(prisma as never);
    prisma.$queryRaw.mockResolvedValue([
      { userId: 7, artistName: 'Radiohead', playcount: 40 },
      { userId: 8, artistName: 'Muse', playcount: 35 },
    ] as never);

    expect(await r.seedCrownsForGuild(GUILD)).toBe(1);
    expect(prisma.userCrown.create).toHaveBeenCalledTimes(1);
  });

  it('matches the existing-crown lookup case-insensitively', async () => {
    prisma = makePrisma({ crowns: [{ crownId: 1, guildId: 8800001n, artistName: 'radiohead', active: true }] });
    r = new CrownRepository(prisma as never);
    prisma.$queryRaw.mockResolvedValue([{ userId: 7, artistName: 'Radiohead', playcount: 40 }] as never);

    expect(await r.seedCrownsForGuild(GUILD)).toBe(0);
    expect(callArg<{ where: Args }>(prisma.userCrown.findFirst).where.artistName).toEqual({
      equals: 'Radiohead',
      mode: 'insensitive',
    });
  });

  it('RE-SEEDS over a DEACTIVATED crown, because nobody holds it any more', async () => {
    prisma = makePrisma({ crowns: [{ crownId: 1, guildId: 8800001n, artistName: 'Radiohead', active: false }] });
    r = new CrownRepository(prisma as never);
    prisma.$queryRaw.mockResolvedValue([{ userId: 7, artistName: 'Radiohead', playcount: 40 }] as never);

    expect(await r.seedCrownsForGuild(GUILD)).toBe(1);
  });

  it('returns 0 and creates nothing when the guild has no indexed artists', async () => {
    prisma.$queryRaw.mockResolvedValue([] as never);

    expect(await r.seedCrownsForGuild(GUILD)).toBe(0);
    expect(prisma.userCrown.create).not.toHaveBeenCalled();
  });
});

describe('CrownRepository: a failed read is not an empty read', () => {
  /**
   * The one assertion that cannot be satisfied by a plausible-looking fake.
   *
   * Every method below is a count or a list a crown page renders. If a query
   * throws and the method returns `[]`/`null`/`0`, the user is told "you hold no
   * crowns" / "nobody holds this crown" / "this guild has 0 crowns" - all of
   * which read as facts. That is the `getUserAllTimeTopAlbumsByReleasePrefix`
   * shape exactly. crownRepository has no `catch` today; these tests exist so
   * adding one is a red suite rather than a silent regression.
   *
   * The CONTROL test at the bottom matters as much: it proves a genuine empty
   * still returns empty, so "make every read throw" would not pass this file.
   */
  it('getCurrentCrown raises rather than reporting "nobody holds it"', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection reset') as never);
    await expect(r.getCurrentCrown(GUILD, 'Radiohead')).rejects.toThrow('connection reset');
  });

  it('getUserCrowns raises rather than reporting "you have no crowns"', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection reset') as never);
    await expect(r.getUserCrowns(GUILD, 7)).rejects.toThrow('connection reset');
  });

  it('getTopCrownHoldersInGuild raises rather than reporting an empty leaderboard', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection reset') as never);
    await expect(r.getTopCrownHoldersInGuild(GUILD)).rejects.toThrow('connection reset');
  });

  it('getCrownHistoryForArtist raises rather than reporting "never crowned"', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection reset') as never);
    await expect(r.getCrownHistoryForArtist(GUILD, 'Radiohead')).rejects.toThrow('connection reset');
  });

  it('getBlockedCrownUsers raises rather than reporting "nobody is blocked"', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection reset') as never);
    await expect(r.getBlockedCrownUsers(GUILD)).rejects.toThrow('connection reset');
  });

  it('getTotalActiveCrownsInGuild raises rather than reporting zero crowns', async () => {
    // 0 is the single most dangerous value in this file: the guild-crowns
    // counter renders it as a fact.
    prisma.userCrown.count.mockRejectedValue(new Error('connection reset') as never);
    await expect(r.getTotalActiveCrownsInGuild(GUILD)).rejects.toThrow('connection reset');
  });

  it('getCrownRoles raises rather than reporting "no role configured"', async () => {
    prisma.guild.findUnique.mockRejectedValue(new Error('connection reset') as never);
    await expect(r.getCrownRoles(GUILD)).rejects.toThrow('connection reset');
  });

  it('seedCrownsForGuild raises rather than reporting that it seeded nothing', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection reset') as never);
    await expect(r.seedCrownsForGuild(GUILD)).rejects.toThrow('connection reset');
  });

  it('a mid-seed failure does not report a partial count as a success', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { userId: 7, artistName: 'Radiohead', playcount: 40 },
      { userId: 8, artistName: 'Muse', playcount: 35 },
    ] as never);
    prisma.userCrown.create
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error('unique violation') as never);

    // Reporting 1 here would tell the admin "seeded 1 crown" when the truth is
    // "the seed failed partway and the guild is now inconsistent".
    await expect(r.seedCrownsForGuild(GUILD)).rejects.toThrow('unique violation');
  });

  it('CONTROL: a genuinely empty result is still empty, so these cannot pass by throwing everything', async () => {
    prisma.$queryRaw.mockResolvedValue([] as never);
    prisma.userCrown.count.mockResolvedValue(0 as never);
    prisma.guild.findUnique.mockResolvedValue({ crownRoles: [] } as never);

    expect(await r.getCurrentCrown(GUILD, 'Radiohead')).toBeNull();
    expect(await r.getUserCrowns(GUILD, 7)).toEqual([]);
    expect(await r.getTopCrownHoldersInGuild(GUILD)).toEqual([]);
    expect(await r.getCrownHistoryForArtist(GUILD, 'Radiohead')).toEqual([]);
    expect(await r.getBlockedCrownUsers(GUILD)).toEqual([]);
    expect(await r.getTotalActiveCrownsInGuild(GUILD)).toBe(0);
    expect(await r.getCrownRoles(GUILD)).toEqual([]);
    expect(await r.seedCrownsForGuild(GUILD)).toBe(0);
  });
});

describe('CrownRepository: writes that are not reads', () => {
  it('createCrown propagates a write failure rather than returning a half-built DTO', async () => {
    prisma.userCrown.create.mockRejectedValue(new Error('unique violation') as never);

    await expect(
      r.createCrown({
        guildId: GUILD, userId: 7, artistName: 'Radiohead', startPlaycount: 1, currentPlaycount: 1,
      }),
    ).rejects.toThrow('unique violation');
  });

  it('deactivateCrown propagates rather than resolving on a row that is not there', async () => {
    // `update` on a missing primary key throws P2025. Swallowing it would tell
    // the caller the crown is deactivated when it never was.
    prisma.userCrown.update.mockRejectedValue(
      Object.assign(new Error('Record to update not found'), { code: 'P2025' }) as never,
    );
    await expect(r.deactivateCrown(404)).rejects.toThrow('Record to update not found');
  });

  it('killAllCrowns propagates a write failure rather than reporting zero killed', async () => {
    prisma.userCrown.updateMany.mockRejectedValue(new Error('deadlock detected') as never);
    await expect(r.killAllCrowns(GUILD)).rejects.toThrow('deadlock detected');
  });

  it('setCrownRole propagates so the admin is not told the role was set', async () => {
    prisma.guild.update.mockRejectedValue(new Error('permission denied') as never);
    await expect(r.setCrownRole(GUILD, '555')).rejects.toThrow('permission denied');
  });
});

/**
 * EVERY guild id goes through the one guard. This block used to record the
 * opposite: `safeBigInt` guarded nine methods while `createCrown`,
 * `replaceCrown`, `killCrown`, `removeUserCrowns` and `setCrownBlock` called
 * `BigInt(guildId)` directly, so a malformed id raised `SyntaxError: Cannot
 * convert … to a BigInt` out of the middle of the repository for five of
 * seventeen methods and produced the honest empty answer for the other twelve.
 *
 * There are two honest outcomes for a malformed id, and which one applies is
 * decided by what the method can actually return:
 *
 *   - a method with an empty answer (a list, a count, a boolean, a no-op)
 *     returns it. There is no such guild, so it has no crowns.
 *   - a method that MUST produce a row (`createCrown`, `replaceCrown`) has no
 *     empty value, so it raises — and raises a `TypeError` naming the ARGUMENT,
 *     because a malformed id is a caller bug and `SyntaxError` from inside the
 *     driver call points an operator at Prisma instead.
 *
 * `replaceCrown` must NOT answer `null` for a malformed id: `null` already means
 * "a concurrent steal got there first", so laundering a bad argument into it
 * would send the caller round the re-read loop for a crown never written.
 */
describe('CrownRepository: every guild id goes through the guard', () => {
  it('createCrown raises a NAMED error on a malformed guild id, before it writes', async () => {
    await expect(
      r.createCrown({
        guildId: 'not-a-guild', userId: 7, artistName: 'Radiohead',
        startPlaycount: 1, currentPlaycount: 1,
      }),
    ).rejects.toThrow(TypeError);
    // Not the driver's coercion failure, which is what this used to be.
    await expect(
      r.createCrown({
        guildId: 'not-a-guild', userId: 7, artistName: 'Radiohead',
        startPlaycount: 1, currentPlaycount: 1,
      }),
    ).rejects.not.toThrow(/Cannot convert/);
    expect(prisma.userCrown.create).not.toHaveBeenCalled();
  });

  it('replaceCrown raises the same named error rather than answering null', async () => {
    // `null` here would be a lie: it is the "a concurrent steal got there
    // first" signal, and the caller re-reads and retries on it forever.
    //
    // This Prisma double has no `$transaction` at all, so a guard that ran
    // INSIDE the transaction would still raise — a TypeError about a missing
    // method. The assertion is on the message, so it can only pass if the id
    // was rejected before anything was opened. `crownRepository.test.ts` covers
    // the transaction body itself.
    await expect(
      r.replaceCrown(1, {
        guildId: 'not-a-guild', userId: 7, artistName: 'Radiohead',
        startPlaycount: 1, currentPlaycount: 1,
      }),
    ).rejects.toThrow(/guildId must be a decimal string/);
  });

  it('killCrown answers false rather than raising', async () => {
    // The honest empty for this method is "no such crown", and it is the same
    // answer a guild with no crowns for that artist produces.
    await expect(r.killCrown('not-a-guild', 'Radiohead')).resolves.toBe(false);
    expect(prisma.userCrown.updateMany).not.toHaveBeenCalled();
  });

  it('removeUserCrowns answers zero rather than raising', async () => {
    await expect(r.removeUserCrowns('not-a-guild', 7)).resolves.toBe(0);
    expect(prisma.userCrown.updateMany).not.toHaveBeenCalled();
  });

  it('setCrownBlock is a total no-op, so the block and the crown drop stay one intent', async () => {
    await expect(r.setCrownBlock('not-a-guild', 7, true)).resolves.toBeUndefined();
    expect(prisma.guildUser.upsert).not.toHaveBeenCalled();
    expect(prisma.userCrown.updateMany).not.toHaveBeenCalled();
  });

  it('CONTROL: a VALID guild id still writes, so none of this is a method that stopped working', async () => {
    prisma = makePrisma({
      crowns: [
        { crownId: 1, guildId: 8800001n, userId: 7, artistName: 'Radiohead', active: true },
        { crownId: 2, guildId: 8800001n, userId: 7, artistName: 'Muse', active: true },
      ],
    });
    r = new CrownRepository(prisma as never);

    expect(await r.killCrown(GUILD, 'Radiohead')).toBe(true);
    expect(await r.removeUserCrowns(GUILD, 7)).toBe(1);
    await r.setCrownBlock(GUILD, 7, true);
    expect(callArg<{ where: Args }>(prisma.guildUser.upsert).where).toEqual({
      guildId_userId: { guildId: 8800001n, userId: 7 },
    });
  });
});
