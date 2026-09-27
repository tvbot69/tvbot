import { Prisma, PrismaClient } from '@prisma/client';
import { normalizeStoredName } from '@domain/textNormalize';
import type {
  IPlayRepository,
  PlayInsert,
  TopEntityResult,
} from '@domain/interfaces/iplayRepository';

const INSERT_CHUNK_SIZE = 500;
const CHUNK_RETRY_DELAYS_MS = [1000, 2500, 5000, 10000];

/**
 * The three per-user rollup tables (user_artists / user_albums /
 * user_tracks) have identical shapes and identical compound primary keys
 * `@@id([userId, <id>])`. Prisma types each delegate separately and none of
 * them share a structural type, so the shapes actually used are described
 * here and each helper takes the delegate as a parameter — that is what lets
 * one implementation serve all three without a `any` in the middle.
 */
type TxLike = Prisma.TransactionClient | PrismaClient;

type ReplaceDelegate = (tx: TxLike) => {
  deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  createMany(args: Record<string, unknown>): Promise<unknown>;
};

type DeltaDelegate = (client: PrismaClient) => {
  findMany(args: Record<string, unknown>): Promise<unknown>;
  delete(args: { where: Record<string, unknown> }): Prisma.PrismaPromise<unknown>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Prisma.PrismaPromise<unknown>;
  create(args: { data: Record<string, unknown> }): Prisma.PrismaPromise<unknown>;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const userArtistDelegate: ReplaceDelegate & DeltaDelegate = ((c: TxLike) => (c as any).userArtist) as never;
const userAlbumDelegate: ReplaceDelegate & DeltaDelegate = ((c: TxLike) => (c as any).userAlbum) as never;
const userTrackDelegate: ReplaceDelegate & DeltaDelegate = ((c: TxLike) => (c as any).userTrack) as never;
/* eslint-enable @typescript-eslint/no-explicit-any */


/**
 * Collapse raw entries sharing one entity id into a single row, SUMMING
 * playcounts and keeping the top entry's display name. Raw spellings vary
 * in case ("Mac DeMarco" vs "mac demarco") while mapping to one id — and
 * every replace* uses createMany(skipDuplicates) on the id PK, so without
 * this the colliding spellings' plays vanish silently.
 */
export const sumEntriesById = <T extends { playcount: number; name: string }>(
  entries: T[],
  keyOf: (e: T) => string,
): T[] => {
  const merged = new Map<string, { entry: T; playcount: number }>();
  for (const e of entries) {
    const k = keyOf(e);
    const cur = merged.get(k);
    if (!cur) {
      merged.set(k, { entry: e, playcount: e.playcount });
    } else {
      cur.playcount += e.playcount;
      if (e.playcount > cur.entry.playcount) cur.entry = e;
    }
  }
  return [...merged.values()].map(({ entry, playcount }) => ({ ...entry, playcount }));
};

export class PlayRepository implements IPlayRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  private isTransientDbError(err: unknown): boolean {
    // Lowercased before matching. This was case-SENSITIVE, and Prisma's own
    // pool timeout is "Timed out fetching a new connection from the connection
    // pool" - capital T - so `includes('timed out')` never matched it. A pool
    // timeout is precisely the transient condition this retry exists to
    // recover, and it was being rethrown on the first attempt. Caught by a test
    // using the real Prisma wording rather than a lowercased paraphrase.
    const message = String(err).toLowerCase();
    return (
      message.includes('closed the connection') ||
      message.includes('server has closed') ||
      message.includes('timed out') ||
      message.includes('p1017') ||
      message.includes('p1001') ||
      // P2024: Timed out fetching a new connection from the connection pool.
      // Named explicitly as well as matched by text, so the intent survives a
      // wording change upstream.
      message.includes('p2024')
    );
  }

  private async createManyWithRetry(data: PlayInsert[]): Promise<number> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= CHUNK_RETRY_DELAYS_MS.length; attempt++) {
      try {
        const result = await this.prisma.userPlay.createMany({
          data: data.map((p) => ({
            userId: p.userId,
            artistId: p.artistId ?? null,
            albumId: p.albumId ?? null,
            trackId: p.trackId ?? null,
            artistName: p.artistName,
            albumName: p.albumName ?? null,
            trackName: p.trackName ?? null,
            timePlayed: p.timePlayed,
            msPlayed: p.msPlayed ?? null,
            playSource: (p.playSource as unknown as import('@prisma/client').PlaySource) ?? 'LastFm',
          })),
          skipDuplicates: true,
        });
        return result.count;
      } catch (err) {
        lastError = err;
        if (!this.isTransientDbError(err) || attempt === CHUNK_RETRY_DELAYS_MS.length) {
          break;
        }
        await new Promise((r) =>
          setTimeout(r, CHUNK_RETRY_DELAYS_MS[Math.min(attempt, CHUNK_RETRY_DELAYS_MS.length - 1)]),
        );
        // No reconnect() here on purpose. It called $disconnect() on the
        // SHARED client, tearing down the connection pool for every in-flight
        // query in the process — one transient blip in a stats write turned
        // unrelated commands into pool timeouts. Prisma's engine already
        // re-establishes a dropped connection per query, and the retry below
        // is what actually recovers the write.
      }
    }
    throw lastError;
  }

  public async batchInsertPlays(plays: PlayInsert[]): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < plays.length; i += INSERT_CHUNK_SIZE) {
      const chunk = plays.slice(i, i + INSERT_CHUNK_SIZE);
      inserted += await this.createManyWithRetry(chunk);
    }
    return inserted;
  }

  public async getPlayCountSince(userId: number, since?: Date): Promise<number> {
    return this.prisma.userPlay.count({
      where: {
        userId: userId,
        ...(since ? { timePlayed: { gte: since } } : {}),
      },
    });
  }

  public async getTopArtists(
    userId: number,
    _since?: Date,
    limit: number = 10,
  ): Promise<TopEntityResult[]> {
    const grouped = await this.prisma.userArtist.findMany({
      where: { userId: userId },
      orderBy: { playcount: 'desc' },
      take: limit,
    });
    return grouped.map((g) => ({
      name: g.name,
      entityId: g.artistId,
      playcount: g.playcount,
    }));
  }

  public async getTopAlbums(
    userId: number,
    _since?: Date,
    limit: number = 10,
  ): Promise<TopEntityResult[]> {
    const grouped = await this.prisma.userAlbum.findMany({
      where: { userId: userId },
      orderBy: { playcount: 'desc' },
      take: limit,
    });
    return grouped.map((g) => ({
      name: g.name,
      entityId: g.albumId,
      playcount: g.playcount,
    }));
  }

  public async getTopTracks(
    userId: number,
    _since?: Date,
    limit: number = 10,
  ): Promise<TopEntityResult[]> {
    const grouped = await this.prisma.userTrack.findMany({
      where: { userId: userId },
      orderBy: { playcount: 'desc' },
      take: limit,
    });
    return grouped.map((g) => ({
      name: g.name,
      entityId: g.trackId,
      playcount: g.playcount,
    }));
  }

  public async getRawTopArtistNames(
    userId: number,
  ): Promise<Array<{ name: string; playcount: number }>> {
    const grouped = await this.prisma.userPlay.groupBy({
      by: ['artistName'],
      where: { userId: userId },
      _count: { artistName: true },
      orderBy: { _count: { artistName: 'desc' } },
    });
    return grouped.map((g) => ({ name: g.artistName, playcount: g._count.artistName }));
  }

  public async getRawTopAlbumEntries(
    userId: number,
  ): Promise<Array<{ name: string; artistName: string; playcount: number }>> {
    const grouped = await this.prisma.userPlay.groupBy({
      by: ['artistName', 'albumName'],
      where: { userId: userId, albumName: { not: null } },
      _count: { albumName: true },
      orderBy: { _count: { albumName: 'desc' } },
    });
    return grouped.map((g) => ({
      name: g.albumName ?? '',
      artistName: g.artistName,
      playcount: g._count.albumName,
    }));
  }

  public async getRawTopTrackEntries(
    userId: number,
  ): Promise<Array<{ name: string; artistName: string; playcount: number }>> {
    const grouped = await this.prisma.userPlay.groupBy({
      by: ['artistName', 'trackName'],
      where: { userId: userId, trackName: { not: null } },
      _count: { trackName: true },
      orderBy: { _count: { trackName: 'desc' } },
    });
    return grouped.map((g) => ({
      name: g.trackName ?? '',
      artistName: g.artistName,
      playcount: g._count.trackName,
    }));
  }

  /**
   * One body for `replaceUserArtists` / `replaceUserAlbums` / `replaceUserTracks`.
   *
   * Those three were byte-identical apart from the delegate and the id field —
   * ~21 lines each, applied three times. A bugfix landing in two of the three
   * was a matter of time, and only one of the three is exercised by any
   * playlist of real activity, so the other two would have rotted silently.
   *
   * Prisma types each model delegate separately and none of them share a
   * structural type, so the delegate is described by the narrow shape actually
   * used here and each call site casts once.
   */
  private async replaceUserEntities(
    userId: number,
    delegate: ReplaceDelegate,
    idField: 'artistId' | 'albumId' | 'trackId',
    entries: Array<{ name: string; playcount: number } & Record<string, unknown>>,
  ): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        await delegate(tx).deleteMany({ where: { userId } });
        await delegate(tx).createMany({
          data: entries.map((e) => ({
            userId,
            [idField]: e[idField],
            name: e.name.toLowerCase(),
            playcount: e.playcount,
          })),
          skipDuplicates: true,
        });
      },
      { timeout: 60000, maxWait: 15000 },
    );
  }

  public async replaceUserArtists(
    userId: number,
    entries: Array<{ artistId: number; name: string; playcount: number }>,
  ): Promise<void> {
    return this.replaceUserEntities(userId, userArtistDelegate, 'artistId', entries);
  }

  public async replaceUserAlbums(
    userId: number,
    entries: Array<{ albumId: number; name: string; playcount: number }>,
  ): Promise<void> {
    return this.replaceUserEntities(userId, userAlbumDelegate, 'albumId', entries);
  }

  public async replaceUserTracks(
    userId: number,
    entries: Array<{ trackId: number; name: string; playcount: number }>,
  ): Promise<void> {
    return this.replaceUserEntities(userId, userTrackDelegate, 'trackId', entries);
  }

  public async getLastStoredPlayTime(userId: number): Promise<Date | null> {
    const last = await this.prisma.userPlay.findFirst({
      where: { userId: userId },
      orderBy: { timePlayed: 'desc' },
      select: { timePlayed: true },
    });
    return last?.timePlayed ?? null;
  }

  public async deletePlaysBefore(userId: number, before: Date): Promise<void> {
    await this.prisma.userPlay.deleteMany({
      where: { userId: userId, timePlayed: { lt: before } },
    });
  }

  public async deleteAllPlaysForUser(userId: number): Promise<void> {
    await this.prisma.userPlay.deleteMany({ where: { userId: userId } });
  }

  /**
   * Returns the identity keys of already-stored plays in a time window.
   * Used to make full-library indexing idempotent: an interrupted index can
   * simply re-fetch from page 1 and skip rows that are already stored, instead
   * of wiping the table first (a wipe + redeploy/SIGTERM midway = permanent
   * history loss, since nothing ever resumes the fetch).
   */
  public async findExistingPlayKeys(
    userId: number,
    since: Date,
    until: Date,
  ): Promise<Set<string>> {
    const rows = await this.prisma.userPlay.findMany({
      where: {
        userId: userId,
        timePlayed: { gte: since, lte: until },
      },
      select: { timePlayed: true, artistName: true, trackName: true },
    });
    const keys = new Set<string>();
    for (const r of rows) {
      keys.add(PlayRepository.playKey(r.timePlayed, r.artistName, r.trackName));
    }
    return keys;
  }

  public static playKey(
    timePlayed: Date,
    artistName: string,
    trackName?: string | null,
  ): string {
    // Normalized like storage (normalizeStoredName): otherwise "Mo  nd" from
    // the API never matches stored "Mo nd", and every sync re-inserts the
    // same plays as exact duplicates while flagging the originals removed.
    return `${new Date(timePlayed).getTime()}|${normalizeStoredName(artistName)}|${normalizeStoredName(trackName ?? '')}`;
  }

  public async getRecentPlays(userId: number, limit: number): Promise<Array<{
    userPlayId: bigint;
    userId: number;
    artistName: string;
    albumName?: string;
    trackName?: string;
    timePlayed: Date;
    playSource?: string;
  }>> {
    const plays = await this.prisma.userPlay.findMany({
      where: {
        userId: userId,
        playSource: 'LastFm',
      },
      orderBy: { timePlayed: 'desc' },
      take: limit,
      select: {
        userPlayId: true,
        userId: true,
        artistName: true,
        albumName: true,
        trackName: true,
        timePlayed: true,
        playSource: true,
      },
    });
    return plays.map((p) => ({
      userPlayId: p.userPlayId,
      userId: p.userId,
      artistName: p.artistName,
      albumName: p.albumName ?? undefined,
      trackName: p.trackName ?? undefined,
      timePlayed: p.timePlayed,
      playSource: p.playSource ?? undefined,
    }));
  }

  public async removePlaysByIds(playIds: bigint[]): Promise<number> {
    if (playIds.length === 0) return 0;
    // Guard: only delete LastFm plays, never Spotify/Apple imports (fmbot play_source !=1,2)
    const result = await this.prisma.userPlay.deleteMany({
      where: {
        userPlayId: { in: playIds },
        OR: [{ playSource: 'LastFm' }, { playSource: null }],
      },
    });
    return result.count;
  }

  // Incremental counters — mirrors fmbot UpdateArtists/Albums/TracksForUser batched deltas.
  // Batched: one read + one transaction per call instead of 2 round-trips per delta row.
  /**
   * One body for `applyArtistDeltas` / `applyAlbumDeltas` / `applyTrackDeltas`.
   *
   * Merge by id (summing deltas, keeping the first name), drop zero deltas,
   * then per id: update when the row exists and the result stays positive,
   * delete when it would go to zero or below, create when it does not exist yet
   * and the delta is positive. All of it in one transaction.
   *
   * Note the album variant used to carry an `artistId` through the merge that
   * nothing ever read — the create writes only userId/albumId/name/playcount —
   * so it is not part of the shared shape.
   */
  private async applyEntityDeltas(
    userId: number,
    delegate: DeltaDelegate,
    idField: 'artistId' | 'albumId' | 'trackId',
    deltas: Array<{ name: string; delta: number } & Record<string, unknown>>,
  ): Promise<void> {
    const merged = new Map<number, { name: string; delta: number }>();
    for (const d of deltas) {
      if (d.delta === 0) continue;
      const id = d[idField] as number;
      const cur = merged.get(id);
      merged.set(id, { name: cur?.name ?? d.name, delta: (cur?.delta ?? 0) + d.delta });
    }
    if (merged.size === 0) return;
    const model = delegate(this.prisma);
    const existing = (await model.findMany({
      where: { userId, [idField]: { in: [...merged.keys()] } },
      select: { [idField]: true, playcount: true },
    })) as Array<Record<string, unknown>>;
    const byId = new Map<number, number>();
    for (const e of existing) byId.set(e[idField] as number, e.playcount as number);
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    // The compound unique key name is `userId_<idField>` for all three tables
    // (e.g. userId_artistId). It MUST be used as written: a flat
    // `{ userId, artistId }` filter is not reliably resolved to the compound
    // unique by update/delete, and getting this wrong on the scrobble path
    // would throw or, worse, touch the wrong row.
    const uniqueKey = `userId_${idField}` as 'userId_artistId';
    for (const [id, { name, delta }] of merged) {
      if (delta === 0) continue;
      const where = { [uniqueKey]: { userId, [idField]: id } };
      const cur = byId.get(id);
      if (cur !== undefined) {
        const next = cur + delta;
        if (next <= 0) {
          ops.push(model.delete({ where }));
        } else {
          ops.push(model.update({ where, data: { playcount: next } }));
        }
      } else if (delta > 0) {
        ops.push(model.create({ data: { userId, [idField]: id, name: name.toLowerCase(), playcount: delta } }));
      }
    }
    if (ops.length > 0) await this.prisma.$transaction(ops);
  }

  public async applyArtistDeltas(userId: number, deltas: Array<{ name: string; artistId: number; delta: number }>): Promise<void> {
    return this.applyEntityDeltas(userId, userArtistDelegate, 'artistId', deltas);
  }

  public async applyAlbumDeltas(userId: number, deltas: Array<{ name: string; artistId: number; albumId: number; delta: number }>): Promise<void> {
    return this.applyEntityDeltas(userId, userAlbumDelegate, 'albumId', deltas);
  }

  public async applyTrackDeltas(userId: number, deltas: Array<{ name: string; artistId: number; trackId: number; delta: number }>): Promise<void> {
    return this.applyEntityDeltas(userId, userTrackDelegate, 'trackId', deltas);
  }

  public async getRecentEntityPlaycounts(
    userId: number,
    artistName: string,
    albumName?: string | null,
    trackName?: string | null,
  ): Promise<{ week: number; month: number }> {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date();
    monthAgo.setMonth(monthAgo.getMonth() - 1);

    const conditions: string[] = [
      'user_id = $1',
      'time_played >= $2',
      'LOWER(artist_name) = LOWER($3)',
    ];
    const params: unknown[] = [userId, monthAgo, artistName];

    if (albumName) {
      params.push(albumName);
      conditions.push(`LOWER(album_name) = LOWER($${params.length})`);
    }
    if (trackName) {
      params.push(trackName);
      conditions.push(`LOWER(track_name) = LOWER($${params.length})`);
    }

    params.push(weekAgo);
    const weekParamIndex = params.length;

    const sql = `
      SELECT
        (COUNT(*) FILTER (WHERE time_played >= $${weekParamIndex}))::int AS week,
        COUNT(*)::int AS month
      FROM user_plays
      WHERE ${conditions.join(' AND ')}
    `;

    try {
      const result = await this.prisma.$queryRawUnsafe<Array<{ week: number; month: number }>>(sql, ...params);
      if (result && result.length > 0) {
        return {
          week: Number(result[0]?.week ?? 0),
          month: Number(result[0]?.month ?? 0),
        };
      }
    } catch {
      // Fallback in case of raw query issues
      const whereClause: Record<string, unknown> = {
        userId,
        timePlayed: { gte: monthAgo },
        artistName: { equals: artistName, mode: 'insensitive' },
      };
      if (albumName) whereClause.albumName = { equals: albumName, mode: 'insensitive' };
      if (trackName) whereClause.trackName = { equals: trackName, mode: 'insensitive' };

      const plays = await this.prisma.userPlay.findMany({
        where: whereClause,
        select: { timePlayed: true },
      });
      return {
        week: plays.filter((p) => p.timePlayed >= weekAgo).length,
        month: plays.length,
      };
    }
    return { week: 0, month: 0 };
  }

  public async getEntityTotalPlaycount(
    userId: number,
    artistName: string,
    albumName?: string | null,
    trackName?: string | null,
  ): Promise<number> {
    try {
      const whereClause: Record<string, unknown> = {
        userId,
        artistName: { equals: artistName, mode: 'insensitive' },
      };
      if (albumName) whereClause.albumName = { equals: albumName, mode: 'insensitive' };
      if (trackName) whereClause.trackName = { equals: trackName, mode: 'insensitive' };

      return await this.prisma.userPlay.count({
        where: whereClause,
      });
    } catch {
      return 0;
    }
  }

  public async getEntityFirstPlay(
    userId: number,
    artistName: string,
  ): Promise<{ timePlayed: Date; albumName: string | null; trackName: string | null } | null> {
    return this.prisma.userPlay.findFirst({
      where: {
        userId,
        artistName: { equals: artistName, mode: 'insensitive' },
      },
      orderBy: { timePlayed: 'asc' },
      select: { timePlayed: true, albumName: true, trackName: true },
    });
  }

  public async getEntityFirstPlayDate(
    userId: number,
    artistName: string,
    albumName?: string | null,
    trackName?: string | null,
  ): Promise<Date | null> {
    const where: Record<string, unknown> = {
      userId,
      artistName: { equals: artistName, mode: 'insensitive' },
    };
    if (albumName) where.albumName = { equals: albumName, mode: 'insensitive' };
    if (trackName) where.trackName = { equals: trackName, mode: 'insensitive' };

    const play = await this.prisma.userPlay.findFirst({
      where,
      orderBy: { timePlayed: 'asc' },
      select: { timePlayed: true },
    });
    return play?.timePlayed ?? null;
  }

  public async getEntityLastPlay(
    userId: number,
    artistName: string,
    cutoff: Date,
  ): Promise<{ timePlayed: Date; albumName: string | null; trackName: string | null } | null> {
    return this.prisma.userPlay.findFirst({
      where: {
        userId,
        timePlayed: { lt: cutoff },
        artistName: { equals: artistName, mode: 'insensitive' },
      },
      orderBy: { timePlayed: 'desc' },
      select: { timePlayed: true, albumName: true, trackName: true },
    });
  }

  public async getEntityLastPlayDate(
    userId: number,
    artistName: string,
    cutoff: Date,
    albumName?: string | null,
    trackName?: string | null,
  ): Promise<Date | null> {
    const where: Record<string, unknown> = {
      userId,
      timePlayed: { lt: cutoff },
      artistName: { equals: artistName, mode: 'insensitive' },
    };
    if (albumName) where.albumName = { equals: albumName, mode: 'insensitive' };
    if (trackName) where.trackName = { equals: trackName, mode: 'insensitive' };

    const play = await this.prisma.userPlay.findFirst({
      where,
      orderBy: { timePlayed: 'desc' },
      select: { timePlayed: true },
    });
    return play?.timePlayed ?? null;
  }
}
