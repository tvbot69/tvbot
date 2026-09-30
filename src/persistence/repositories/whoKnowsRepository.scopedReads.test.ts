import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhoKnowsRepository } from './whoKnowsRepository';

/**
 * The five of six `WhoKnowsRepository` queries that `whoKnowsRepository.test.ts`
 * does not reach - that file holds one assertion for
 * `getIndexedUsersForArtist` and nothing else.
 *
 * Two things are load-bearing across all six and neither is visible in a
 * return value:
 *
 *  1. THE ABUSE-FLAG CLAUSE IS NOT UNIFORM. All three `getIndexedUsersFor*`
 *     queries carry
 *       NOT EXISTS (SELECT 1 FROM abuse_flags af WHERE ...)
 *     and none of the three `getFriendUsersFor*` queries do. An account that
 *     was removed from the guild leaderboard for abuse still appears in the
 *     personal "your friends also listen to this" list. The source tells the
 *     story in its own naming: the friend variants declare `_guildId` and never
 *     use it. `whoKnowsRepository.db.test.ts` already pins the behaviour with
 *     real rows for the artist variant; this file pins the SQL SHAPE for all
 *     six, so unifying them is a visible edit.
 *
 *  2. THE NUMERIC COERCION IS NOT COSMETIC. `user_artists.playcount` is an
 *     `int4`, but the artist query sums it and casts to `::bigint`, and a
 *     Postgres bigint arrives at node-postgres as a STRING. The `Number()`
 *     calls in `map` are what stop a leaderboard entry being `"200"` and being
 *     compared/sorted as text. A fake row built from a JS number would pass
 *     even with the coercion removed, so these fixtures use strings.
 *
 * The joins are asserted column by column against
 * `src/persistence/prisma/schema.prisma`: `user_id`, `album_id`, `track_id`,
 * `friend_user_id`, `expires_at` all exist on the models they are read from.
 */

type Args = Record<string, unknown>;

/** The columns a Postgres row actually arrives with. */
const rawRow = (over: Args = {}) => ({
  userId: 7,
  playcount: '200',
  userNameLastFm: 'someone',
  ...over,
});

const sqlOf = (fn: unknown, index = 0): { sql: string; values: unknown[] } => {
  const call = (fn as { mock: { calls: unknown[][] } }).mock.calls[index];
  if (!call) throw new Error('no raw query was issued');
  return { sql: (call[0] as TemplateStringsArray).join('?'), values: call.slice(1) };
};

const makePrisma = (rows: Args[] = []) => ({
  $queryRaw: vi.fn(async (..._args: unknown[]) => rows as unknown[]),
});

type Double = ReturnType<typeof makePrisma>;

let d: Double;
let repo: WhoKnowsRepository;

beforeEach(() => {
  d = makePrisma();
  repo = new WhoKnowsRepository(d as never);
});

const GUILD = '8800001';

describe('WhoKnowsRepository.getIndexedUsersForAlbum', () => {
  it('maps rows to numbers, coercing the Postgres bigint playcount', async () => {
    d = makePrisma([rawRow({ playcount: '64' })]);
    repo = new WhoKnowsRepository(d as never);

    expect(await repo.getIndexedUsersForAlbum(GUILD, 42)).toEqual([{ userId: 7, playcount: 64 }]);
  });

  it('reads the user_albums row by album id, scoped to the guild membership', async () => {
    d = makePrisma([]);
    repo = new WhoKnowsRepository(d as never);
    await repo.getIndexedUsersForAlbum(GUILD, 42);
    const { sql, values } = sqlOf(d.$queryRaw);

    expect(sql).toMatch(/FROM user_albums AS ub/);
    expect(sql).toMatch(/ub\.album_id = \?/);
    // Guild membership is a subquery, not a JOIN on the artist table: the
    // who-knows board only counts listeners who are IN this server.
    expect(sql).toMatch(/ANY\(SELECT user_id FROM guild_users WHERE guild_id = \?\)/);
    expect(values).toEqual([42, 8800001n]);
  });

  it('excludes abuse-flagged users, unlike the three friend queries', async () => {
    d = makePrisma([]);
    repo = new WhoKnowsRepository(d as never);
    await repo.getIndexedUsersForAlbum(GUILD, 42);
    const { sql } = sqlOf(d.$queryRaw);

    // `expires_at IS NULL` is the permanent flag; the `> NOW()` arm is the
    // TTL-bound one. Dropping either leaves lapsed flags applied forever.
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM abuse_flags af WHERE af\.user_id = ub\.user_id/);
    expect(sql).toMatch(/af\.expires_at IS NULL OR af\.expires_at > NOW\(\)/);
  });

  it('orders by playcount descending, most plays first', async () => {
    d = makePrisma([]);
    repo = new WhoKnowsRepository(d as never);
    await repo.getIndexedUsersForAlbum(GUILD, 42);
    expect(sqlOf(d.$queryRaw).sql).toMatch(/ORDER BY ub\.playcount DESC/);
  });

  it('returns an empty list when nobody in the guild has played the album', async () => {
    expect(await repo.getIndexedUsersForAlbum(GUILD, 42)).toEqual([]);
  });

  it('propagates a query failure rather than reporting an empty leaderboard', async () => {
    d.$queryRaw.mockRejectedValue(new Error('connection reset') as never);
    // An empty board and a dead connection are the same render, and the user
    // reads the first as "nobody here listens to Kid A".
    await expect(repo.getIndexedUsersForAlbum(GUILD, 42)).rejects.toThrow('connection reset');
  });

  it('DOCUMENTS THE CLASS SHAPE: a malformed guild id throws on the BigInt coercion', async () => {
    await expect(repo.getIndexedUsersForAlbum('not-a-guild', 42)).rejects.toThrow(/BigInt/);
    expect(d.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('WhoKnowsRepository.getIndexedUsersForTrack', () => {
  it('maps rows to numbers', async () => {
    d = makePrisma([rawRow({ playcount: '9' })]);
    repo = new WhoKnowsRepository(d as never);

    expect(await repo.getIndexedUsersForTrack(GUILD, 77)).toEqual([{ userId: 7, playcount: 9 }]);
  });

  it('reads user_tracks by track id, not the album table', async () => {
    d = makePrisma([]);
    repo = new WhoKnowsRepository(d as never);
    await repo.getIndexedUsersForTrack(GUILD, 77);
    const { sql, values } = sqlOf(d.$queryRaw);

    expect(sql).toMatch(/FROM user_tracks AS ut/);
    expect(sql).toMatch(/ut\.track_id = \?/);
    expect(sql).not.toMatch(/user_albums/);
    expect(values).toEqual([77, 8800001n]);
  });

  it('excludes abuse-flagged users', async () => {
    d = makePrisma([]);
    repo = new WhoKnowsRepository(d as never);
    await repo.getIndexedUsersForTrack(GUILD, 77);
    expect(sqlOf(d.$queryRaw).sql).toMatch(/abuse_flags af/);
  });

  it('orders by playcount descending', async () => {
    d = makePrisma([]);
    repo = new WhoKnowsRepository(d as never);
    await repo.getIndexedUsersForTrack(GUILD, 77);
    expect(sqlOf(d.$queryRaw).sql).toMatch(/ORDER BY ut\.playcount DESC/);
  });

  it('returns an empty list for a track nobody has played', async () => {
    expect(await repo.getIndexedUsersForTrack(GUILD, 77)).toEqual([]);
  });

  it('propagates a query failure rather than reporting an empty leaderboard', async () => {
    d.$queryRaw.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.getIndexedUsersForTrack(GUILD, 77)).rejects.toThrow('connection reset');
  });
});

describe('WhoKnowsRepository.getFriendUsersForArtist', () => {
  it('maps rows to numbers AND carries the last.fm name through', async () => {
    d = makePrisma([rawRow({ playcount: '40', userNameLastFm: 'alice' })]);
    repo = new WhoKnowsRepository(d as never);

    expect(await repo.getFriendUsersForArtist(1, 'Radiohead')).toEqual([
      { userId: 7, playcount: 40, userNameLastFm: 'alice' },
    ]);
  });

  it('leaves userNameLastFm undefined when the row carries no name', async () => {
    d = makePrisma([{ userId: 7, playcount: '1' }]);
    repo = new WhoKnowsRepository(d as never);

    // The service falls back to `user_${userId}` for this shape, so it must not
    // be coerced into an empty string here or the fallback never fires.
    expect((await repo.getFriendUsersForArtist(1, 'Radiohead'))[0]?.userNameLastFm).toBeUndefined();
  });

  it('joins the friends table in ONE direction only', async () => {
    d = makePrisma([]);
    repo = new WhoKnowsRepository(d as never);
    await repo.getFriendUsersForArtist(1, 'Radiohead');
    const { sql, values } = sqlOf(d.$queryRaw);

    // `WHERE fr.user_id = $1` is what makes this MY friends. Swapping it for
    // `fr.friend_user_id` inverts the list into "people who added me", and an
    // unqualified join would make every user a friend of every user.
    expect(sql).toMatch(/JOIN friends AS fr ON fr\.friend_user_id = ua\.user_id/);
    expect(sql).toMatch(/WHERE fr\.user_id = \?/);
    expect(values).toEqual([1, 'Radiohead']);
  });

  it('collapses case-variant accounts with DISTINCT ON, keeping the higher count', async () => {
    d = makePrisma([]);
    repo = new WhoKnowsRepository(d as never);
    await repo.getFriendUsersForArtist(1, 'Radiohead');
    const { sql } = sqlOf(d.$queryRaw);

    // A user and their alt account must be one person in a friend list,
    // otherwise a duo account outranks a real listener.
    expect(sql).toMatch(/DISTINCT ON\(UPPER\(u\.user_name_last_fm\)\)/);
    expect(sql).toMatch(/ORDER BY UPPER\(u\.user_name_last_fm\) DESC, ua\.playcount DESC/);
  });

  it('DOCUMENTS THE ORDERING: the DISTINCT ON key is sorted DESCENDING', async () => {
    // Postgres requires the DISTINCT ON expression to lead the ORDER BY, and
    // it does - but the direction is DESC, so the survivor of a case-variant
    // collision is the alphabetically LAST spelling. That is a tiebreak
    // choice, not a correctness one, and it is pinned so changing it is
    // deliberate.
    d = makePrisma([]);
    repo = new WhoKnowsRepository(d as never);
    await repo.getFriendUsersForArtist(1, 'Radiohead');
    expect(sqlOf(d.$queryRaw).sql).toMatch(/ORDER BY UPPER\(u\.user_name_last_fm\) DESC/);
  });

  it('re-orders the subquery by playcount on the way out', async () => {
    d = makePrisma([]);
    repo = new WhoKnowsRepository(d as never);
    await repo.getFriendUsersForArtist(1, 'Radiohead');
    // The inner ORDER BY exists to pick a DISTINCT ON winner; the outer one is
    // what the leaderboard actually reads.
    expect(sqlOf(d.$queryRaw).sql).toMatch(/ORDER BY sub\."playcount" DESC/);
  });

  it('matches the artist case-insensitively', async () => {
    d = makePrisma([]);
    repo = new WhoKnowsRepository(d as never);
    await repo.getFriendUsersForArtist(1, 'radiohead');
    expect(sqlOf(d.$queryRaw).sql).toMatch(/UPPER\(ua\.name\) = UPPER\(\?\)/);
  });

  it('DOCUMENTS THE INCONSISTENCY: this query does NOT exclude abuse-flagged users', async () => {
    d = makePrisma([]);
    repo = new WhoKnowsRepository(d as never);
    await repo.getFriendUsersForArtist(1, 'Radiohead');
    // The three `getIndexedUsersFor*` queries all carry this clause. Its
    // absence here is why an account banned for abuse disappears from the
    // guild board and reappears in the personal friends list. Pinned, not
    // endorsed.
    expect(sqlOf(d.$queryRaw).sql).not.toMatch(/abuse_flags/);
  });

  it('ignores the optional guildId argument, because a friends list is personal', async () => {
    d = makePrisma([]);
    repo = new WhoKnowsRepository(d as never);
    await repo.getFriendUsersForArtist(1, 'Radiohead', '9999999');
    // The parameter is declared `_guildId` and never bound. Pinned so a future
    // "scope it to the guild" change is a deliberate edit.
    expect(sqlOf(d.$queryRaw).values).toEqual([1, 'Radiohead']);
  });

  it('returns an empty list when none of the user friends know the artist', async () => {
    expect(await repo.getFriendUsersForArtist(1, 'Radiohead')).toEqual([]);
  });

  it('propagates a query failure rather than reporting "no friends know this"', async () => {
    d.$queryRaw.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.getFriendUsersForArtist(1, 'Radiohead')).rejects.toThrow('connection reset');
  });
});

describe('WhoKnowsRepository.getFriendUsersForAlbum', () => {
  it('maps rows to numbers and carries the name through', async () => {
    d = makePrisma([rawRow({ playcount: '12', userNameLastFm: 'alice' })]);
    repo = new WhoKnowsRepository(d as never);

    expect(await repo.getFriendUsersForAlbum(1, 42)).toEqual([
      { userId: 7, playcount: 12, userNameLastFm: 'alice' },
    ]);
  });

  it('reads user_albums by album id and binds the pair in order', async () => {
    d = makePrisma([]);
    repo = new WhoKnowsRepository(d as never);
    await repo.getFriendUsersForAlbum(1, 42);
    const { sql, values } = sqlOf(d.$queryRaw);

    expect(sql).toMatch(/FROM user_albums AS ub/);
    expect(sql).toMatch(/ub\.album_id = \?/);
    // userId first, then albumId: swapping them would return the caller's
    // friends who played the album with the id `1`.
    expect(values).toEqual([1, 42]);
  });

  it('DOCUMENTS THE INCONSISTENCY: this query does NOT exclude abuse-flagged users', async () => {
    d = makePrisma([]);
    repo = new WhoKnowsRepository(d as never);
    await repo.getFriendUsersForAlbum(1, 42);
    expect(sqlOf(d.$queryRaw).sql).not.toMatch(/abuse_flags/);
  });

  it('returns an empty list when no friend has played the album', async () => {
    expect(await repo.getFriendUsersForAlbum(1, 42)).toEqual([]);
  });

  it('propagates a query failure rather than reporting an empty list', async () => {
    d.$queryRaw.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.getFriendUsersForAlbum(1, 42)).rejects.toThrow('connection reset');
  });
});

describe('WhoKnowsRepository.getFriendUsersForTrack', () => {
  it('maps rows to numbers and carries the name through', async () => {
    d = makePrisma([rawRow({ playcount: '3', userNameLastFm: 'bob' })]);
    repo = new WhoKnowsRepository(d as never);

    expect(await repo.getFriendUsersForTrack(1, 77)).toEqual([
      { userId: 7, playcount: 3, userNameLastFm: 'bob' },
    ]);
  });

  it('reads user_tracks by track id and binds the pair in order', async () => {
    d = makePrisma([]);
    repo = new WhoKnowsRepository(d as never);
    await repo.getFriendUsersForTrack(1, 77);
    const { sql, values } = sqlOf(d.$queryRaw);

    expect(sql).toMatch(/FROM user_tracks AS ut/);
    expect(sql).toMatch(/ut\.track_id = \?/);
    expect(sql).not.toMatch(/user_albums/);
    expect(values).toEqual([1, 77]);
  });

  it('DOCUMENTS THE INCONSISTENCY: this query does NOT exclude abuse-flagged users', async () => {
    d = makePrisma([]);
    repo = new WhoKnowsRepository(d as never);
    await repo.getFriendUsersForTrack(1, 77);
    expect(sqlOf(d.$queryRaw).sql).not.toMatch(/abuse_flags/);
  });

  it('returns an empty list when no friend has played the track', async () => {
    expect(await repo.getFriendUsersForTrack(1, 77)).toEqual([]);
  });

  it('propagates a query failure rather than reporting an empty list', async () => {
    d.$queryRaw.mockRejectedValue(new Error('connection reset') as never);
    await expect(repo.getFriendUsersForTrack(1, 77)).rejects.toThrow('connection reset');
  });
});

describe('WhoKnowsRepository: the album and track indexed queries share one guild-scoping shape', () => {
  it('both bind the guild id LAST, after the entity key', async () => {
    // The same two placeholders in the same order across all three, so a
    // refactor that reorders one of them is caught here rather than as a
    // who-knows board that silently counts a different entity.
    for (const [call, expected] of [
      [() => repo.getIndexedUsersForAlbum(GUILD, 42), [42, 8800001n]],
      [() => repo.getIndexedUsersForTrack(GUILD, 77), [77, 8800001n]],
    ] as Array<[() => Promise<unknown>, unknown[]]>) {
      d = makePrisma([]);
      repo = new WhoKnowsRepository(d as never);
      await call();
      expect(sqlOf(d.$queryRaw).values).toEqual(expected);
    }
  });

  it('both order the result by playcount, so the board is not arbitrary', async () => {
    for (const call of [
      () => repo.getIndexedUsersForAlbum(GUILD, 42),
      () => repo.getIndexedUsersForTrack(GUILD, 77),
    ] as Array<() => Promise<unknown>>) {
      d = makePrisma([]);
      repo = new WhoKnowsRepository(d as never);
      await call();
      expect(sqlOf(d.$queryRaw).sql).toMatch(/ORDER BY (ub|ut)\.playcount DESC/);
    }
  });
});
