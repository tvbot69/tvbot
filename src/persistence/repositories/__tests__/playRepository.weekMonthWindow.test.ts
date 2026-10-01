import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { PlayRepository } from '../playRepository';

/**
 * The dynamic SQL in `getRecentEntityPlaycounts`, which nothing asserts.
 *
 * This is the "N plays this week / this month" figure on the now-playing card
 * and the who-knows panel, and it is built by string concatenation with
 * POSITIONAL placeholders whose index MOVES depending on which of the album and
 * track arguments the caller supplied:
 *
 *   params = [userId, monthAgo, artistName, (albumName), (trackName), weekAgo]
 *   week filter is $${params.length}   <- the index of weekAgo
 *
 * An off-by-one there is the exact failure mode this whole repository layer
 * exists to prevent: `$4` where the album name lives reads `LOWER(album_name)
 * = LOWER(<timestamp>)`, which matches nothing, so the raw aggregate returns
 * one row of zeros - a real, successful, WRONG answer that renders as "0 plays
 * this week" and cannot be told from the truth. Every existing test of this
 * method stubs the query's RESULT, so a wrong placeholder passes all of them.
 *
 * The second half is the fallback path. `catch` here does not return a default
 * (unlike the `getEntityTotalPlaycount` that used to end in `catch { return 0 }`);
 * it re-asks the same question as an independent `findMany`, and if THAT throws
 * the error propagates untouched. Both halves are pinned below.
 */

type Args = Record<string, unknown>;

const makePrisma = () => ({
  userPlay: {
    findMany: vi.fn(async (..._args: unknown[]) => [] as Array<{ timePlayed: Date }>),
  },
  $queryRawUnsafe: vi.fn(async (..._args: unknown[]) => [] as Array<{ week?: unknown; month?: unknown }>),
});

type Double = ReturnType<typeof makePrisma>;

const repo = (p: Double) => new PlayRepository(p as never);

/** `$queryRawUnsafe(sql, ...params)`: the statement plus its bound values. */
const rawCallOf = (p: Double) => {
  const call = p.$queryRawUnsafe.mock.calls[0];
  if (!call) throw new Error('the raw query was never issued');
  return { sql: call[0] as string, params: call.slice(1) as unknown[] };
};

/** The args object of the first `findMany`, which is the fallback query. */
const firstFindManyArgs = (p: Double): Args => {
  const call = p.userPlay.findMany.mock.calls[0];
  if (!call) throw new Error('the fallback findMany was never issued');
  return call[0] as Args;
};

const DAY = 86_400_000;

describe('PlayRepository.getRecentEntityPlaycounts placeholder arithmetic', () => {
  it('binds userId, the month window and the artist name in that order', async () => {
    const p = makePrisma();
    await repo(p).getRecentEntityPlaycounts(2, 'Radiohead');
    const { params } = rawCallOf(p);

    expect(params[0]).toBe(2);
    expect(params[1]).toBeInstanceOf(Date);
    expect(params[2]).toBe('Radiohead');
  });

  it('the month window is about a month back and the week window exactly seven days', async () => {
    const p = makePrisma();
    await repo(p).getRecentEntityPlaycounts(2, 'Radiohead');
    const { params } = rawCallOf(p);
    const monthAgo = params[1] as Date;
    const weekAgo = params[params.length - 1] as Date;
    const now = Date.now();

    // Seven days exactly, computed as `now - 7 * 24 * 60 * 60 * 1000`.
    expect(Math.round((now - weekAgo.getTime()) / DAY)).toBe(7);
    // `setMonth(getMonth() - 1)` is NOT 30 days - it is the same day of the
    // previous month, so it ranges from 28 to 31 days back and it is not
    // monotonic across a month boundary (31 March minus one month is 3 March
    // in a non-leap year). Asserted as a range because that IS the semantics.
    const daysBack = (now - monthAgo.getTime()) / DAY;
    expect(daysBack).toBeGreaterThanOrEqual(27);
    expect(daysBack).toBeLessThanOrEqual(32);
    // The month window must contain the week window, or "this month" would be
    // narrower than "this week" and the footer would read as a decline.
    expect(monthAgo.getTime()).toBeLessThanOrEqual(weekAgo.getTime());
  });

  it('uses $4 for the week filter when neither an album nor a track is given', async () => {
    const p = makePrisma();
    await repo(p).getRecentEntityPlaycounts(2, 'Radiohead');
    const { sql, params } = rawCallOf(p);

    expect(params).toHaveLength(4);
    // If this said $3 the filter would compare a timestamp to the artist name.
    expect(sql).toContain(`time_played >= $${params.length}))::int AS week`);
    expect(sql).toContain('time_played >= $2');
    expect(sql).toContain('LOWER(artist_name) = LOWER($3)');
  });

  it('shifts the week filter to $5 when an ALBUM is given', async () => {
    const p = makePrisma();
    await repo(p).getRecentEntityPlaycounts(2, 'Radiohead', 'OK Computer');
    const { sql, params } = rawCallOf(p);

    expect(params[3]).toBe('OK Computer');
    expect(params[4]).toBeInstanceOf(Date);
    expect(sql).toContain('LOWER(album_name) = LOWER($4)');
    expect(sql).toContain(`time_played >= $${params.length}))::int AS week`);
    // The month window is still $2: it is bound before any of the optional
    // arguments are pushed.
    expect(sql).toContain('time_played >= $2');
  });

  it('shifts the week filter to $6 when BOTH an album and a track are given', async () => {
    const p = makePrisma();
    await repo(p).getRecentEntityPlaycounts(2, 'Radiohead', 'OK Computer', 'Airbag');
    const { sql, params } = rawCallOf(p);

    expect(params[3]).toBe('OK Computer');
    expect(params[4]).toBe('Airbag');
    expect(params[5]).toBeInstanceOf(Date);
    expect(sql).toContain('LOWER(album_name) = LOWER($4)');
    expect(sql).toContain('LOWER(track_name) = LOWER($5)');
    expect(sql).toContain(`time_played >= $${params.length}))::int AS week`);
  });

  it('a TRACK with no album shifts the window correctly too', async () => {
    // The album argument is optional and the track one is not, so this is the
    // shape that a "shift by the number of arguments" shortcut gets wrong.
    const p = makePrisma();
    await repo(p).getRecentEntityPlaycounts(2, 'Radiohead', null, 'Airbag');
    const { sql, params } = rawCallOf(p);

    expect(sql).not.toContain('album_name');
    expect(params[3]).toBe('Airbag');
    expect(params[4]).toBeInstanceOf(Date);
    expect(sql).toContain('LOWER(track_name) = LOWER($4)');
    expect(sql).toContain(`time_played >= $${params.length}))::int AS week`);
  });

  it('skips the album and track clauses for an EMPTY string, which is falsy', async () => {
    const p = makePrisma();
    await repo(p).getRecentEntityPlaycounts(2, 'Radiohead', '', '');
    const { sql, params } = rawCallOf(p);

    // A Last.fm scrobble can carry an empty album name; binding it would add a
    // `LOWER(album_name) = LOWER('')` clause that matches nothing and turns the
    // footer into zero.
    expect(sql).not.toContain('album_name');
    expect(sql).not.toContain('track_name');
    expect(params).toHaveLength(4);
    expect(sql).toContain(`time_played >= $${params.length}))::int AS week`);
  });

  it('folds case on BOTH sides of the name comparisons', async () => {
    const p = makePrisma();
    await repo(p).getRecentEntityPlaycounts(2, 'Radiohead', 'OK Computer', 'Airbag');
    const { sql } = rawCallOf(p);

    // Last.fm sends whatever the tagger typed.
    expect(sql).toContain('LOWER(artist_name) = LOWER(');
    expect(sql).toContain('LOWER(album_name) = LOWER(');
    expect(sql).toContain('LOWER(track_name) = LOWER(');
  });

  it('BOUNDS every value; the artist, album and track names never reach the statement', async () => {
    const p = makePrisma();
    await repo(p).getRecentEntityPlaycounts(2, "Guns N' Roses", 'Use Your Illusion', `Don't`);

    const { sql } = rawCallOf(p);
    // `$queryRawUnsafe` does NOT parameterise for you. A name interpolated here
    // would close the quotes and change the statement.
    expect(sql).not.toContain('Guns');
    expect(sql).not.toContain('Illusion');
  });

  it('counts over user_plays and casts both aggregates to int', async () => {
    const p = makePrisma();
    await repo(p).getRecentEntityPlaycounts(2, 'Radiohead');
    const { sql } = rawCallOf(p);

    expect(sql).toContain('FROM user_plays');
    expect(sql).toContain('user_id = $1');
    // `::int` is what keeps the value a JS number rather than a BigInt, which
    // would throw on JSON.stringify in the embed.
    expect(sql).toContain('::int AS week');
    expect(sql).toContain('::int AS month');
    expect(sql).toContain('COUNT(*) FILTER (WHERE');
  });
});

describe('PlayRepository.getRecentEntityPlaycounts result coercion', () => {
  it('coerces Postgres bigint-shaped strings into numbers', async () => {
    const p = makePrisma();
    // `::int` on a COUNT keeps it int4, but a driver that reports int as a
    // string would otherwise hand the footer a `"12"` that sorts as text.
    p.$queryRawUnsafe.mockResolvedValue([{ week: '3', month: '12' }] as never);

    const out = await repo(p).getRecentEntityPlaycounts(2, 'Radiohead');

    expect(out).toEqual({ week: 3, month: 12 });
    expect(typeof out.week).toBe('number');
    expect(typeof out.month).toBe('number');
  });

  it('reads a missing aggregate as zero rather than NaN', async () => {
    const p = makePrisma();
    p.$queryRawUnsafe.mockResolvedValue([{}] as never);

    expect(await repo(p).getRecentEntityPlaycounts(2, 'Radiohead')).toEqual({ week: 0, month: 0 });
  });

  it('an empty match set is a genuine zero, not a degradation', async () => {
    // The statement is an aggregate with no GROUP BY, so a match set of zero
    // rows still returns one row of zeros. This path is only reached by a
    // driver that returns an empty array for it, and the zero is real.
    const p = makePrisma();
    p.$queryRawUnsafe.mockResolvedValue([] as never);

    expect(await repo(p).getRecentEntityPlaycounts(2, 'Radiohead')).toEqual({ week: 0, month: 0 });
    // A zero must not trigger the fallback: that would run a second query and,
    // on a real outage, silently replace the aggregate with a findMany count.
    expect(p.userPlay.findMany).not.toHaveBeenCalled();
  });
});

describe('PlayRepository.getRecentEntityPlaycounts fallback', () => {
  it('re-asks the same question as findMany, scoped to the MONTH window', async () => {
    const p = makePrisma();
    p.$queryRawUnsafe.mockRejectedValue(new Error('syntax error') as never);
    p.userPlay.findMany.mockResolvedValue([] as never);

    await repo(p).getRecentEntityPlaycounts(2, 'Radiohead', 'OK Computer', 'Airbag');

    const where = firstFindManyArgs(p).where as Args;
    expect(where.userId).toBe(2);
    expect(where.artistName).toEqual({ equals: 'Radiohead', mode: 'insensitive' });
    expect(where.albumName).toEqual({ equals: 'OK Computer', mode: 'insensitive' });
    expect(where.trackName).toEqual({ equals: 'Airbag', mode: 'insensitive' });
    // The month window, not the week one - otherwise "this month" would be
    // undercounted to at most seven days.
    expect((where.timePlayed as { gte: Date }).gte).toBeInstanceOf(Date);
    expect((where.timePlayed as { gte: Date }).gte.getTime()).toBeLessThanOrEqual(Date.now() - 27 * DAY);
  });

  it('omits the album and track filters when they are not supplied', async () => {
    const p = makePrisma();
    p.$queryRawUnsafe.mockRejectedValue(new Error('boom') as never);
    p.userPlay.findMany.mockResolvedValue([] as never);

    await repo(p).getRecentEntityPlaycounts(2, 'Radiohead');

    const where = firstFindManyArgs(p).where as Args;
    expect(where.albumName).toBeUndefined();
    expect(where.trackName).toBeUndefined();
  });

  it('splits the returned rows into a week count and a month count', async () => {
    const p = makePrisma();
    const now = Date.now();
    p.$queryRawUnsafe.mockRejectedValue(new Error('boom') as never);
    p.userPlay.findMany.mockResolvedValue([
      { timePlayed: new Date(now - DAY) },
      { timePlayed: new Date(now - 3 * DAY) },
      { timePlayed: new Date(now - 20 * DAY) },
    ] as never);

    expect(await repo(p).getRecentEntityPlaycounts(2, 'Radiohead')).toEqual({ week: 2, month: 3 });
  });

  it('a play outside the week but inside the month counts once, for the month', async () => {
    const p = makePrisma();
    p.$queryRawUnsafe.mockRejectedValue(new Error('boom') as never);
    const r = repo(p);
    p.userPlay.findMany.mockResolvedValue([] as never);
    await r.getRecentEntityPlaycounts(2, 'Radiohead');
    // The month window the call just bound. A play one day AFTER it is inside
    // the month and far outside the seven-day week, so the week/month split is
    // proved by the arithmetic rather than by a hand-picked fixture date.
    const monthAgo = (firstFindManyArgs(p).where as { timePlayed: { gte: Date } }).timePlayed.gte;
    p.userPlay.findMany.mockResolvedValue([{ timePlayed: new Date(monthAgo.getTime() + DAY) }] as never);

    expect(await r.getRecentEntityPlaycounts(2, 'Radiohead')).toEqual({ week: 0, month: 1 });
  });

  it('a play inside the week counts for BOTH windows', async () => {
    // The control for the test above: same code path, and the only difference
    // is the timestamp. Without it, a method that returned `{ week: 0, month: N }`
    // for everything would pass the other test.
    const p = makePrisma();
    p.$queryRawUnsafe.mockRejectedValue(new Error('boom') as never);
    p.userPlay.findMany.mockResolvedValue([{ timePlayed: new Date(Date.now() - DAY) }] as never);

    expect(await repo(p).getRecentEntityPlaycounts(2, 'Radiohead')).toEqual({ week: 1, month: 1 });
  });

  it('returns a genuine zero for a user who never played the entity', async () => {
    const p = makePrisma();
    p.$queryRawUnsafe.mockRejectedValue(new Error('boom') as never);
    p.userPlay.findMany.mockResolvedValue([] as never);

    expect(await repo(p).getRecentEntityPlaycounts(2, 'Radiohead')).toEqual({ week: 0, month: 0 });
  });

  it('PROPAGATES when the fallback ALSO fails, rather than reporting zero', async () => {
    // The A1 rule, and the reason this catch does not return a default. A dead
    // database must be visible; `{ week: 0, month: 0 }` would render as "you
    // have not played this artist in a month", which is a plausible and very
    // wrong statement about the user's listening.
    const p = makePrisma();
    p.$queryRawUnsafe.mockRejectedValue(new Error('raw dead') as never);
    p.userPlay.findMany.mockRejectedValue(new Error('fallback dead') as never);

    await expect(repo(p).getRecentEntityPlaycounts(2, 'Radiohead')).rejects.toThrow('fallback dead');
  });

  it('does NOT swallow a raw failure when the fallback succeeds - it answers truthfully', async () => {
    // The documented design: a degraded-but-TRUE answer beats replacing it
    // with an error, because raising here would tell the user nothing when the
    // repository genuinely knows the answer.
    const p = makePrisma();
    const now = Date.now();
    p.$queryRawUnsafe.mockRejectedValue(new Error('raw dead') as never);
    p.userPlay.findMany.mockResolvedValue([{ timePlayed: new Date(now - DAY) }] as never);

    expect(await repo(p).getRecentEntityPlaycounts(2, 'Radiohead')).toEqual({ week: 1, month: 1 });
  });
});
