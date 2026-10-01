import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { WhoKnowsRepository } from '../whoKnowsRepository';
import {
  connect,
  resetTables,
  seedUser,
  skipReason,
  useScratchSchema,
} from '../../../testSupport/dbHarness';

/**
 * The six raw queries in whoKnowsRepository.ts, executed by a real Postgres:
 *
 *   L24  getIndexedUsersForArtist  - SUM across case-variant rows, guild-scoped
 *   L44  getIndexedUsersForAlbum   - per-album leaderboard
 *   L63  getIndexedUsersForTrack   - per-track leaderboard
 *   L83  getFriendUsersForArtist   - DISTINCT ON inside a subquery
 *   L113 getFriendUsersForAlbum    - DISTINCT ON inside a subquery
 *   L141 getFriendUsersForTrack    - DISTINCT ON inside a subquery
 *
 * These are the numbers in the "who knows this?" leaderboards, so a query that
 * throws does not degrade - it returns nothing, and "nobody in this guild knows
 * this album" is indistinguishable from "the album does not exist". All six are
 * `$queryRaw` tagged templates, so the audit that claimed full raw-query coverage
 * (it matched `$queryRawUnsafe` only) never saw them.
 *
 * Two shapes are worth a dedicated test rather than an incidental assertion:
 *
 *  1. `SUM(ua.playcount)::bigint` on the artist query versus a plain
 *     `ub.playcount` on the album and track queries. int8 comes back from
 *     Postgres as a JS BigInt and int4 as a number, so the SAME `Number(r.playcount)`
 *     in the mapper is load-bearing for one query and a no-op for the other. If
 *     the cast were dropped from the first, every artist leaderboard would rank
 *     by string comparison and the ordering would be wrong rather than absent.
 *  2. `NOT EXISTS (... abuse_flags ...)` is carried by ALL SIX queries. The three
 *     friend queries used to omit it, so a banned account vanished from the
 *     guild leaderboard and stayed on the personal friends list; the exclusion is
 *     asserted below for the artist variant with real rows and for the SQL shape
 *     of all six in `whoKnowsRepository.scopedReads.test.ts`.
 */

const skip = skipReason();
const suite = skip ? describe.skip : describe;

let prisma: PrismaClient | null = null;
let repo: WhoKnowsRepository | null = null;
let userId = 1;

const GUILD_ID = 9_900_001n;
const OTHER_GUILD_ID = 9_900_002n;
const guildId = String(GUILD_ID);
const otherGuildId = String(OTHER_GUILD_ID);

const DAY = 24 * 60 * 60;

/**
 * `artists.name` is UNIQUE and `user_artists.name` is not, so the catalogue row
 * and the denormalised display name are separate. A test that wants two
 * case-variant rows for ONE user has to give them two different artist ids,
 * because `UserArtist` is keyed (userId, artistId) - which is exactly the real
 * shape this SUM exists to clean up.
 */
let artistSerial = 0;

const seedUserArtistRow = async (
  id: number,
  name: string,
  playcount: number,
): Promise<void> => {
  const artist = await prisma!.artist.create({ data: { name: `cat ${name} #${artistSerial++}` } });
  await prisma!.userArtist.create({
    data: { userId: id, artistId: artist.artistId, name, playcount },
  });
};

interface AlbumSeed {
  id: number;
  name: string;
  artistId: number;
  albumId: number;
}

const seedAlbumChain = async (name: string, artistName: string): Promise<AlbumSeed> => {
  const artist = await prisma!.artist.create({ data: { name: `${artistName} #${artistSerial++}` } });
  const album = await prisma!.album.create({ data: { artistId: artist.artistId, name } });
  return { id: album.albumId, name, artistId: artist.artistId, albumId: album.albumId };
};

const seedUserAlbumRow = async (id: number, name: string, playcount: number): Promise<number> => {
  const artist = await prisma!.artist.create({ data: { name: `cat ${name} #${artistSerial++}` } });
  const album = await prisma!.album.create({ data: { artistId: artist.artistId, name } });
  await prisma!.userAlbum.create({ data: { userId: id, albumId: album.albumId, name, playcount } });
  return album.albumId;
};

const seedUserTrackRow = async (id: number, name: string, playcount: number): Promise<number> => {
  const artist = await prisma!.artist.create({ data: { name: `cat ${name} #${artistSerial++}` } });
  const track = await prisma!.track.create({ data: { artistId: artist.artistId, name } });
  await prisma!.userTrack.create({ data: { userId: id, trackId: track.trackId, name, playcount } });
  return track.trackId;
};

const seedNamedUser = async (id: number, name: string): Promise<void> => {
  await prisma!.user.create({
    data: { userId: id, userNameLastFm: name, discordUserId: BigInt(id) * 1000n },
  });
};

const seedGuildMember = async (id: number, guild: bigint = GUILD_ID): Promise<void> => {
  await prisma!.guildUser.create({ data: { guildId: guild, userId: id } });
};

const flag = async (id: number, expiresAt: Date | null): Promise<void> => {
  await prisma!.abuseFlag.create({ data: { userId: id, reason: 'test', expiresAt } });
};

suite('WhoKnowsRepository raw queries against a real database', () => {
  beforeAll(async () => {
    prisma = await connect();
    if (!prisma) return;
    await useScratchSchema(prisma);
    repo = new WhoKnowsRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    if (!prisma) return;
    await resetTables(prisma);
    userId += 1;
    await prisma!.guild.create({ data: { guildId: GUILD_ID, guildName: 'Who Knows Guild' } });
    await prisma!.guild.create({ data: { guildId: OTHER_GUILD_ID, guildName: 'Other Guild' } });
    await seedUser(prisma!, userId);
  });

  describe('getIndexedUsersForArtist (L24)', () => {
    it('returns an empty list when the artist is not in anybody library', async () => {
      await seedGuildMember(userId);
      await seedUserArtistRow(userId, 'Radiohead', 100);
      await expect(repo!.getIndexedUsersForArtist(guildId, 'Portishead')).resolves.toEqual([]);
    });

    it('returns an empty list for a guild with no members', async () => {
      await seedUserArtistRow(userId, 'Radiohead', 100);
      await expect(repo!.getIndexedUsersForArtist(guildId, 'Radiohead')).resolves.toEqual([]);
    });

    it('returns one row per guild member, most plays first', async () => {
      const second = userId + 5000;
      await seedUser(prisma!, second);
      await seedGuildMember(userId);
      await seedGuildMember(second);
      await seedUserArtistRow(userId, 'Radiohead', 30);
      await seedUserArtistRow(second, 'Radiohead', 80);
      const rows = await repo!.getIndexedUsersForArtist(guildId, 'Radiohead');
      expect(rows).toEqual([
        { userId: second, playcount: 80 },
        { userId: userId, playcount: 30 },
      ]);
    });

    it('matches the artist name case-insensitively', async () => {
      await seedGuildMember(userId);
      await seedUserArtistRow(userId, 'Radiohead', 30);
      // The await is load-bearing. `expect(promise).toHaveLength(1)` inspects the
      // PROMISE object synchronously and fails with "expected Promise{...} to have
      // property 'length'" - a statement about the ORM, not about the leaderboard.
      expect((await repo!.getIndexedUsersForArtist(guildId, 'radiohead'))).toHaveLength(1);
      expect((await repo!.getIndexedUsersForArtist(guildId, 'RADIOHEAD'))).toHaveLength(1);
    });

    it('sums a users case-variant rows into one entry instead of ranking them twice', async () => {
      // The SUM is the whole reason this query is not a plain SELECT. "Mac
      // DeMarco" and "mac demarco" are two rows on two artist ids, and a user
      // with split rows would otherwise appear twice in the leaderboard.
      await seedGuildMember(userId);
      await seedUserArtistRow(userId, 'Mac DeMarco', 5);
      await seedUserArtistRow(userId, 'MAC DEMARCO', 7);
      const rows = await repo!.getIndexedUsersForArtist(guildId, 'Mac DeMarco');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.playcount).toBe(12);
    });

    it('returns playcount and userId as JS numbers, so the leaderboard sorts numerically', async () => {
      // SUM(int4) is int8, so `::bigint` hands Prisma a BigInt and the mapper's
      // Number() is load-bearing. Without it `ORDER BY` in the consumer, or any
      // arithmetic on the count, would be string maths: 100 < 90.
      await seedGuildMember(userId);
      await seedUserArtistRow(userId, 'Radiohead', 100);
      const [row] = await repo!.getIndexedUsersForArtist(guildId, 'Radiohead');
      expect(typeof row?.playcount).toBe('number');
      expect(typeof row?.userId).toBe('number');
      expect(row?.userId).toBe(userId);
    });

    it('orders a three-digit count above a two-digit one, which string ordering would get wrong', async () => {
      const big = userId + 5000;
      const small = userId + 6000;
      await seedUser(prisma!, big);
      await seedUser(prisma!, small);
      await seedGuildMember(big);
      await seedGuildMember(small);
      await seedUserArtistRow(big, 'Radiohead', 100);
      await seedUserArtistRow(small, 'Radiohead', 90);
      const rows = await repo!.getIndexedUsersForArtist(guildId, 'Radiohead');
      expect(rows.map((r) => r.playcount)).toEqual([100, 90]);
    });

    it('excludes a user who is not a member of the guild', async () => {
      const outsider = userId + 5000;
      await seedUser(prisma!, outsider);
      await seedGuildMember(userId);
      await seedUserArtistRow(userId, 'Radiohead', 30);
      await seedUserArtistRow(outsider, 'Radiohead', 999);
      const rows = await repo!.getIndexedUsersForArtist(guildId, 'Radiohead');
      expect(rows).toEqual([{ userId, playcount: 30 }]);
    });

    it('is scoped to one guild when the same user is in two', async () => {
      const second = userId + 5000;
      await seedUser(prisma!, second);
      await seedGuildMember(userId);
      await seedGuildMember(second, OTHER_GUILD_ID);
      await seedUserArtistRow(userId, 'Radiohead', 30);
      await seedUserArtistRow(second, 'Radiohead', 999);
      expect(await repo!.getIndexedUsersForArtist(guildId, 'Radiohead')).toEqual([{ userId, playcount: 30 }]);
      expect(await repo!.getIndexedUsersForArtist(otherGuildId, 'Radiohead')).toEqual([{ userId: second, playcount: 999 }]);
    });

    it('drops a permanently flagged user, and one whose TTL has not lapsed', async () => {
      const permanent = userId + 5000;
      const ttl = userId + 6000;
      const clean = userId + 7000;
      await seedUser(prisma!, permanent);
      await seedUser(prisma!, ttl);
      await seedUser(prisma!, clean);
      await seedGuildMember(permanent);
      await seedGuildMember(ttl);
      await seedGuildMember(clean);
      await seedUserArtistRow(permanent, 'Radiohead', 900);
      await seedUserArtistRow(ttl, 'Radiohead', 800);
      await seedUserArtistRow(clean, 'Radiohead', 10);
      await flag(permanent, null);
      await flag(ttl, new Date(Date.now() + 30 * DAY * 1000));
      const rows = await repo!.getIndexedUsersForArtist(guildId, 'Radiohead');
      expect(rows).toEqual([{ userId: clean, playcount: 10 }]);
    });

    it('keeps a user whose flag has already lapsed', async () => {
      // The predicate is `expires_at IS NULL OR expires_at > NOW()`, so a dead
      // TTL stops excluding. Getting this backwards would permanently ban
      // everyone ever flagged.
      await seedGuildMember(userId);
      await seedUserArtistRow(userId, 'Radiohead', 10);
      await flag(userId, new Date(Date.now() - DAY * 1000));
      expect((await repo!.getIndexedUsersForArtist(guildId, 'Radiohead'))).toHaveLength(1);
    });

    it('counts a zero-play row as a leaderboard entry, because the aggregate has no lower bound', async () => {
      await seedGuildMember(userId);
      await seedUserArtistRow(userId, 'Radiohead', 0);
      expect((await repo!.getIndexedUsersForArtist(guildId, 'Radiohead'))).toEqual([{ userId, playcount: 0 }]);
    });
  });

  describe('getIndexedUsersForAlbum (L44)', () => {
    it('returns an empty list for an album nobody has played', async () => {
      const played = await seedUserAlbumRow(userId, 'Kid A', 10);
      await seedUserAlbumRow(userId, 'Amnesiac', 10);
      await seedGuildMember(userId);
      // A synthetic id, so this is an album that does not exist rather than one
      // that happens to be empty.
      await expect(repo!.getIndexedUsersForAlbum(guildId, played + 100_000)).resolves.toEqual([]);
    });

    it('returns one row per guild member, most plays first', async () => {
      const second = userId + 5000;
      await seedUser(prisma!, second);
      await seedGuildMember(userId);
      await seedGuildMember(second);
      const albumId = await seedUserAlbumRow(userId, 'Kid A', 30);
      await prisma!.userAlbum.create({ data: { userId: second, albumId, name: 'Kid A', playcount: 80 } });
      const rows = await repo!.getIndexedUsersForAlbum(guildId, albumId);
      expect(rows).toEqual([
        { userId: second, playcount: 80 },
        { userId, playcount: 30 },
      ]);
    });

    it('returns playcount as a JS number without needing the aggregate cast', async () => {
      // int4 on this query, int8 on the artist query. Both must land as numbers,
      // which is the reason the mapper is uniform even though the SQL is not.
      await seedGuildMember(userId);
      const albumId = await seedUserAlbumRow(userId, 'Kid A', 42);
      const [row] = await repo!.getIndexedUsersForAlbum(guildId, albumId);
      expect(typeof row?.playcount).toBe('number');
      expect(typeof row?.userId).toBe('number');
    });

    it('is scoped to the album and to the guild', async () => {
      const outsider = userId + 5000;
      await seedUser(prisma!, outsider);
      await seedGuildMember(userId);
      const albumId = await seedUserAlbumRow(userId, 'Kid A', 30);
      await prisma!.userAlbum.create({ data: { userId: outsider, albumId, name: 'Kid A', playcount: 999 } });
      const otherAlbumId = await seedUserAlbumRow(userId, 'Amnesiac', 999);
      expect(await repo!.getIndexedUsersForAlbum(guildId, albumId)).toEqual([{ userId, playcount: 30 }]);
      expect(await repo!.getIndexedUsersForAlbum(guildId, otherAlbumId)).toEqual([{ userId, playcount: 999 }]);
      await seedGuildMember(outsider);
      expect(await repo!.getIndexedUsersForAlbum(guildId, albumId)).toHaveLength(2);
    });

    it('drops a flagged user', async () => {
      const flagged = userId + 5000;
      await seedUser(prisma!, flagged);
      await seedGuildMember(flagged);
      await seedGuildMember(userId);
      const albumId = await seedUserAlbumRow(userId, 'Kid A', 30);
      await prisma!.userAlbum.create({ data: { userId: flagged, albumId, name: 'Kid A', playcount: 900 } });
      await flag(flagged, null);
      await expect(repo!.getIndexedUsersForAlbum(guildId, albumId)).resolves.toEqual([{ userId, playcount: 30 }]);
    });

    it('does not join the album name, so a denormalised rename cannot hide a row', async () => {
      // The query filters on album_id only. `user_albums.name` is the user's own
      // copy of the title and is allowed to disagree with `albums.name`.
      const chain = await seedAlbumChain('Kid A', 'Radiohead');
      await seedGuildMember(userId);
      await prisma!.userAlbum.create({
        data: { userId, albumId: chain.albumId, name: 'KID A (2011 REMASTER)', playcount: 12 },
      });
      await expect(repo!.getIndexedUsersForAlbum(guildId, chain.albumId)).resolves.toEqual([
        { userId, playcount: 12 },
      ]);
    });
  });

  describe('getIndexedUsersForTrack (L63)', () => {
    it('returns an empty list for a track nobody has played', async () => {
      const played = await seedUserTrackRow(userId, 'Airbag', 10);
      await seedGuildMember(userId);
      await expect(repo!.getIndexedUsersForTrack(guildId, played + 100_000)).resolves.toEqual([]);
    });

    it('returns one row per guild member, most plays first, as numbers', async () => {
      const second = userId + 5000;
      await seedUser(prisma!, second);
      await seedGuildMember(userId);
      await seedGuildMember(second);
      const trackId = await seedUserTrackRow(userId, 'Airbag', 30);
      await prisma!.userTrack.create({ data: { userId: second, trackId, name: 'Airbag', playcount: 80 } });
      const rows = await repo!.getIndexedUsersForTrack(guildId, trackId);
      expect(rows).toEqual([
        { userId: second, playcount: 80 },
        { userId, playcount: 30 },
      ]);
      expect(typeof rows[0]?.playcount).toBe('number');
    });

    it('is scoped to the track and to the guild', async () => {
      const outsider = userId + 5000;
      await seedUser(prisma!, outsider);
      await seedGuildMember(userId);
      const trackId = await seedUserTrackRow(userId, 'Airbag', 30);
      await prisma!.userTrack.create({ data: { userId: outsider, trackId, name: 'Airbag', playcount: 999 } });
      const otherTrack = await seedUserTrackRow(userId, 'Karma Police', 999);
      expect(await repo!.getIndexedUsersForTrack(guildId, trackId)).toEqual([{ userId, playcount: 30 }]);
      expect(await repo!.getIndexedUsersForTrack(guildId, otherTrack)).toEqual([{ userId, playcount: 999 }]);
    });

    it('drops a flagged user whose TTL is still running', async () => {
      const flagged = userId + 5000;
      await seedUser(prisma!, flagged);
      await seedGuildMember(flagged);
      await seedGuildMember(userId);
      const trackId = await seedUserTrackRow(userId, 'Airbag', 30);
      await prisma!.userTrack.create({ data: { userId: flagged, trackId, name: 'Airbag', playcount: 900 } });
      await flag(flagged, new Date(Date.now() + DAY * 1000));
      await expect(repo!.getIndexedUsersForTrack(guildId, trackId)).resolves.toEqual([{ userId, playcount: 30 }]);
    });

    it('counts a zero-play track row', async () => {
      await seedGuildMember(userId);
      const trackId = await seedUserTrackRow(userId, 'Airbag', 0);
      await expect(repo!.getIndexedUsersForTrack(guildId, trackId)).resolves.toEqual([{ userId, playcount: 0 }]);
    });
  });

  describe('getFriendUsersForArtist (L83)', () => {
    it('returns an empty list when the user has no friends who know the artist', async () => {
      await seedUserArtistRow(userId, 'Radiohead', 100);
      await expect(repo!.getFriendUsersForArtist(userId, 'Radiohead')).resolves.toEqual([]);
    });

    it('returns the friend name alongside the count, most plays first', async () => {
      const friend = userId + 5000;
      await seedNamedUser(friend, 'alice');
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'alice', friendUserId: friend } });
      await seedUserArtistRow(friend, 'Radiohead', 40);
      const rows = await repo!.getFriendUsersForArtist(userId, 'Radiohead');
      expect(rows).toEqual([{ userId: friend, playcount: 40, userNameLastFm: 'alice' }]);
    });

    it('only returns people who are actually friended, not everyone who knows the artist', async () => {
      const friend = userId + 5000;
      const stranger = userId + 6000;
      await seedNamedUser(friend, 'alice');
      await seedNamedUser(stranger, 'mallory');
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'alice', friendUserId: friend } });
      await seedUserArtistRow(friend, 'Radiohead', 40);
      await seedUserArtistRow(stranger, 'Radiohead', 999);
      const rows = await repo!.getFriendUsersForArtist(userId, 'Radiohead');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(friend);
    });

    it('is directional: a friend of a friend is not your friend', async () => {
      // `JOIN friends fr ON fr.friend_user_id = ua.user_id WHERE fr.user_id = $1`
      // reads one direction only. Asserted so a change to an unqualified join -
      // which would make every user a friend of every user - is loud.
      const friend = userId + 5000;
      const ofFriend = userId + 6000;
      await seedNamedUser(friend, 'alice');
      await seedNamedUser(ofFriend, 'bob');
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'alice', friendUserId: friend } });
      await prisma!.friend.create({ data: { userId: friend, lastFmUserName: 'bob', friendUserId: ofFriend } });
      await seedUserArtistRow(ofFriend, 'Radiohead', 999);
      await expect(repo!.getFriendUsersForArtist(userId, 'Radiohead')).resolves.toEqual([]);
    });

    it('collapses two friends whose last.fm names differ only by case, keeping the higher count', async () => {
      // DISTINCT ON (UPPER(user_name_last_fm)) with ORDER BY UPPER(...) DESC,
      // playcount DESC. A user and their alt account must be one person in a
      // friend list, otherwise a duo account outranks a real listener.
      const alice = userId + 5000;
      const aliceAlt = userId + 6000;
      await seedNamedUser(alice, 'Alice');
      await seedNamedUser(aliceAlt, 'alice');
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'Alice', friendUserId: alice } });
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'alice', friendUserId: aliceAlt } });
      await seedUserArtistRow(alice, 'Radiohead', 40);
      await seedUserArtistRow(aliceAlt, 'Radiohead', 90);
      const rows = await repo!.getFriendUsersForArtist(userId, 'Radiohead');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.playcount).toBe(90);
      expect(rows[0]?.userId).toBe(aliceAlt);
    });

    it('returns every distinct friend, ordered by playcount', async () => {
      const alice = userId + 5000;
      const bob = userId + 6000;
      const carol = userId + 7000;
      await seedNamedUser(alice, 'alice');
      await seedNamedUser(bob, 'bob');
      await seedNamedUser(carol, 'carol');
      for (const [name, id] of [['alice', alice], ['bob', bob], ['carol', carol]] as const) {
        await prisma!.friend.create({ data: { userId, lastFmUserName: name, friendUserId: id } });
        await seedUserArtistRow(id, 'Radiohead', name === 'alice' ? 10 : name === 'bob' ? 30 : 20);
      }
      const rows = await repo!.getFriendUsersForArtist(userId, 'Radiohead');
      expect(rows.map((r) => r.userNameLastFm)).toEqual(['bob', 'carol', 'alice']);
      expect(rows.every((r) => typeof r.playcount === 'number')).toBe(true);
    });

    it('matches the artist case-insensitively', async () => {
      const friend = userId + 5000;
      await seedNamedUser(friend, 'alice');
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'alice', friendUserId: friend } });
      await seedUserArtistRow(friend, 'Radiohead', 40);
      expect((await repo!.getFriendUsersForArtist(userId, 'radiohead'))).toHaveLength(1);
    });

    it('ignores the optional guildId argument', async () => {
      // The parameter is declared `_guildId` and never used: the friends list is
      // personal, not guild-scoped. Pinned so a future "scope it to the guild"
      // change is a deliberate edit rather than an accident.
      const friend = userId + 5000;
      await seedNamedUser(friend, 'alice');
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'alice', friendUserId: friend } });
      await seedUserArtistRow(friend, 'Radiohead', 40);
      await expect(repo!.getFriendUsersForArtist(userId, 'Radiohead', otherGuildId)).resolves.toHaveLength(1);
    });

    it('EXCLUDES a flagged user, the same as the three indexed queries', async () => {
      // The three `getIndexedUsersFor*` queries carry
      //   NOT EXISTS (SELECT 1 FROM abuse_flags ...)
      // and these three did not, so an abusive account was removed from the
      // guild leaderboard and still appeared in the personal "your friends"
      // list — one moderation decision answered two ways from two queries about
      // the same user. All six now carry the clause. A friends list is personal,
      // not guild-scoped, but "personal" is not "exempt".
      const friend = userId + 5000;
      await seedNamedUser(friend, 'alice');
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'alice', friendUserId: friend } });
      await seedUserArtistRow(friend, 'Radiohead', 40);
      // Guild membership is seeded, so the indexed query below returns [] purely
      // because of the flag. Without it this test would pass for the wrong reason.
      await seedGuildMember(friend);
      await flag(friend, null);
      await expect(repo!.getIndexedUsersForArtist(guildId, 'Radiohead')).resolves.toEqual([]);
      await expect(repo!.getFriendUsersForArtist(userId, 'Radiohead')).resolves.toEqual([]);
    });

    it('a LAPSED flag does not keep a friend out of the list', async () => {
      // The other direction, and the one a missing `> NOW()` arm would break:
      // an expired ban must not exclude anyone forever, on either family of
      // query.
      const friend = userId + 5000;
      await seedNamedUser(friend, 'alice');
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'alice', friendUserId: friend } });
      await seedUserArtistRow(friend, 'Radiohead', 40);
      await flag(friend, new Date(Date.now() - DAY * 1000));
      await expect(repo!.getFriendUsersForArtist(userId, 'Radiohead')).resolves.toHaveLength(1);
    });
  });

  describe('getFriendUsersForAlbum (L113)', () => {
    it('returns an empty list when no friend has played the album', async () => {
      const friend = userId + 5000;
      await seedNamedUser(friend, 'alice');
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'alice', friendUserId: friend } });
      const albumId = await seedUserAlbumRow(friend, 'Kid A', 40);
      await expect(repo!.getFriendUsersForAlbum(userId, albumId + 100_000)).resolves.toEqual([]);
    });

    it('returns the friend name and count for the right album only', async () => {
      const friend = userId + 5000;
      await seedNamedUser(friend, 'alice');
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'alice', friendUserId: friend } });
      const wanted = await seedUserAlbumRow(friend, 'Kid A', 40);
      await seedUserAlbumRow(friend, 'Amnesiac', 999);
      await expect(repo!.getFriendUsersForAlbum(userId, wanted)).resolves.toEqual([
        { userId: friend, playcount: 40, userNameLastFm: 'alice' },
      ]);
    });

    it('collapses a case-variant alt account, keeping the higher count', async () => {
      const alice = userId + 5000;
      const aliceAlt = userId + 6000;
      await seedNamedUser(alice, 'Alice');
      await seedNamedUser(aliceAlt, 'ALICE');
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'Alice', friendUserId: alice } });
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'ALICE', friendUserId: aliceAlt } });
      const albumId = await seedUserAlbumRow(alice, 'Kid A', 10);
      await prisma!.userAlbum.create({ data: { userId: aliceAlt, albumId, name: 'Kid A', playcount: 70 } });
      const rows = await repo!.getFriendUsersForAlbum(userId, albumId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(aliceAlt);
      expect(rows[0]?.playcount).toBe(70);
    });

    it('orders several friends by playcount and returns numbers', async () => {
      const alice = userId + 5000;
      const bob = userId + 6000;
      await seedNamedUser(alice, 'alice');
      await seedNamedUser(bob, 'bob');
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'alice', friendUserId: alice } });
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'bob', friendUserId: bob } });
      const albumId = await seedUserAlbumRow(alice, 'Kid A', 10);
      await prisma!.userAlbum.create({ data: { userId: bob, albumId, name: 'Kid A', playcount: 80 } });
      const rows = await repo!.getFriendUsersForAlbum(userId, albumId);
      expect(rows.map((r) => r.userNameLastFm)).toEqual(['bob', 'alice']);
      expect(rows.every((r) => typeof r.playcount === 'number' && typeof r.userId === 'number')).toBe(true);
    });

    it('excludes a stranger who played the album but is not friended', async () => {
      const stranger = userId + 5000;
      await seedNamedUser(stranger, 'mallory');
      const albumId = await seedUserAlbumRow(stranger, 'Kid A', 40);
      await expect(repo!.getFriendUsersForAlbum(userId, albumId)).resolves.toEqual([]);
    });
  });

  describe('getFriendUsersForTrack (L141)', () => {
    it('returns an empty list when no friend has played the track', async () => {
      const friend = userId + 5000;
      await seedNamedUser(friend, 'alice');
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'alice', friendUserId: friend } });
      const trackId = await seedUserTrackRow(friend, 'Airbag', 40);
      await expect(repo!.getFriendUsersForTrack(userId, trackId + 100_000)).resolves.toEqual([]);
    });

    it('returns the friend name and count for the right track only', async () => {
      const friend = userId + 5000;
      await seedNamedUser(friend, 'alice');
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'alice', friendUserId: friend } });
      const wanted = await seedUserTrackRow(friend, 'Airbag', 40);
      await seedUserTrackRow(friend, 'Karma Police', 999);
      await expect(repo!.getFriendUsersForTrack(userId, wanted)).resolves.toEqual([
        { userId: friend, playcount: 40, userNameLastFm: 'alice' },
      ]);
    });

    it('collapses a case-variant alt account, keeping the higher count', async () => {
      const alice = userId + 5000;
      const aliceAlt = userId + 6000;
      await seedNamedUser(alice, 'Alice');
      await seedNamedUser(aliceAlt, 'alice');
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'Alice', friendUserId: alice } });
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'alice', friendUserId: aliceAlt } });
      const trackId = await seedUserTrackRow(alice, 'Airbag', 10);
      await prisma!.userTrack.create({ data: { userId: aliceAlt, trackId, name: 'Airbag', playcount: 70 } });
      const rows = await repo!.getFriendUsersForTrack(userId, trackId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(aliceAlt);
    });

    it('orders several friends by playcount and returns numbers', async () => {
      const alice = userId + 5000;
      const bob = userId + 6000;
      await seedNamedUser(alice, 'alice');
      await seedNamedUser(bob, 'bob');
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'alice', friendUserId: alice } });
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'bob', friendUserId: bob } });
      const trackId = await seedUserTrackRow(alice, 'Airbag', 100);
      await prisma!.userTrack.create({ data: { userId: bob, trackId, name: 'Airbag', playcount: 900 } });
      const rows = await repo!.getFriendUsersForTrack(userId, trackId);
      // 900 over 100 - the two-digit-vs-three-digit case that a BigInt or a
      // string sort would get backwards.
      expect(rows.map((r) => r.playcount)).toEqual([900, 100]);
    });

    it('is not affected by guild membership at all', async () => {
      const friend = userId + 5000;
      await seedNamedUser(friend, 'alice');
      await prisma!.friend.create({ data: { userId, lastFmUserName: 'alice', friendUserId: friend } });
      const trackId = await seedUserTrackRow(friend, 'Airbag', 40);
      await expect(repo!.getFriendUsersForTrack(userId, trackId, guildId)).resolves.toHaveLength(1);
    });
  });

  describe('column types the mapper depends on', () => {
    it('user_artists.user_id is int4 while SUM() is int8, which is the asymmetry the mapper smooths over', async () => {
      const columns = await prisma!.$queryRawUnsafe<Array<{ udt_name: string }>>(
        `SELECT udt_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'user_artists' AND column_name = 'user_id'`,
      );
      expect(columns[0]?.udt_name).toBe('int4');
      await seedGuildMember(userId);
      await seedUserArtistRow(userId, 'Radiohead', 7);
      const raw = await prisma!.$queryRawUnsafe<Array<{ userId: number; playcount: bigint }>>(
        `SELECT user_id AS "userId", SUM(playcount)::bigint AS "playcount"
           FROM user_artists WHERE UPPER(name) = UPPER('Radiohead') GROUP BY user_id`,
      );
      expect(typeof raw[0]?.userId).toBe('number');
      expect(typeof raw[0]?.playcount).toBe('bigint');
      // And the repository converts it, which is the claim the Number() makes.
      const [row] = await repo!.getIndexedUsersForArtist(guildId, 'Radiohead');
      expect(row?.playcount).toBe(7);
      expect(typeof row?.playcount).toBe('number');
    });
  });
});
