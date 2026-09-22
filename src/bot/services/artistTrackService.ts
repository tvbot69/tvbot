import { prisma } from '@persistence/prismaClient';
import { TimePeriod } from '@domain/enums/timePeriod';

export interface ArtistTopTrack {
  name: string;
  playcount: number;
}

/**
 * Detects a still-indexing library: the authoritative total (Last.fm-synced
 * userArtist playcount) dwarfs the sum of locally-indexed per-track plays.
 * Callers should tell the user results are partial instead of looking broken.
 */
export const isArtistIndexPartial = (
  tracks: Array<{ playcount: number }>,
  totalPlays: number,
): boolean => {
  if (totalPlays < 10 || tracks.length === 0) return false;
  const indexed = tracks.reduce((sum, t) => sum + (t.playcount || 0), 0);
  return indexed < totalPlays * 0.5;
};

export class ArtistTrackService {
  /**
   * Every artist id matching a name (case-insensitive, plus the trimmed
   * form to catch whitespace-variant duplicate rows). The artists.name
   * unique constraint is case-sensitive, so parallel rows ("Mac DeMarco"
   * vs "mac demarco") exist — reads aggregate across the whole set and
   * never trust a single findFirst row.
   */
  private async artistIdsFor(artistName: string): Promise<number[]> {
    const variants = [...new Set([artistName, artistName.trim()])].filter(Boolean);
    const rows = await prisma.artist.findMany({
      where: { OR: variants.map((v) => ({ name: { equals: v, mode: 'insensitive' as const } })) },
      select: { artistId: true },
    });
    return rows.map((r) => r.artistId);
  }

  public async getTopTracksForArtist(userId: number, artistName: string, timePeriod: TimePeriod = TimePeriod.AllTime): Promise<ArtistTopTrack[]> {
    // 1) All canonical ids for this name (never a single findFirst row)
    const artistIds = await this.artistIdsFor(artistName);

    if (timePeriod === TimePeriod.Weekly || timePeriod === TimePeriod.Monthly) {
      const days = timePeriod === TimePeriod.Weekly ? 7 : 31;
      const since = new Date(Date.now() - days * 24 * 3600000);
      const rows = await prisma.userPlay.groupBy({
        by: ['trackName'],
        where: {
          userId,
          timePlayed: { gte: since },
          OR: [
            { artistName: { equals: artistName, mode: 'insensitive' } },
            ...(artistIds.length > 0 ? [{ artistId: { in: artistIds } }] : []),
          ],
        },
        _count: { trackName: true },
        orderBy: { _count: { trackName: 'desc' } },
      });

      // groupBy is case-sensitive: merge spelling variants by summing.
      const merged = new Map<string, { name: string; playcount: number }>();
      for (const r of rows) {
        if (!r.trackName) continue;
        const key = r.trackName.toLowerCase();
        const cur = merged.get(key);
        if (!cur) merged.set(key, { name: r.trackName, playcount: r._count.trackName });
        else cur.playcount += r._count.trackName;
      }
      return [...merged.values()].sort((a, b) => b.playcount - a.playcount);
    }

    // AllTime: Query user_tracks joined with tracks (fmbot ArtistsService.cs line 609)
    // SUM within each source across spelling variants first; MAX across the
    // two sources second (indexed aggregates and raw rows overlap, so SUM
    // across sources would double-count — MAX picks the fresher side).
    const trackSums = new Map<string, { name: string; playcount: number }>();
    const trackMax = new Map<string, { name: string; playcount: number }>();
    const addSum = (map: Map<string, { name: string; playcount: number }>, name: string, count: number) => {
      const key = name.toLowerCase();
      const cur = map.get(key);
      if (!cur) map.set(key, { name, playcount: count });
      else cur.playcount += count;
    };

    if (artistIds.length > 0) {
      const userTracks = await prisma.userTrack.findMany({
        where: {
          userId,
          track: { artistId: { in: artistIds } },
        },
        orderBy: { playcount: 'desc' },
        select: {
          name: true,
          playcount: true,
        },
      });

      for (const t of userTracks) {
        if (t.name) addSum(trackSums, t.name, t.playcount);
      }
    }

    // Also query user_plays in case some plays are in user_plays but not yet indexed into user_tracks
    const playRows = await prisma.userPlay.groupBy({
      by: ['trackName'],
      where: {
        userId,
        OR: [
          { artistName: { equals: artistName, mode: 'insensitive' } },
          ...(artistIds.length > 0 ? [{ artistId: { in: artistIds } }] : []),
        ],
      },
      _count: { trackName: true },
      orderBy: { _count: { trackName: 'desc' } },
    });

    // SUM raw rows across spelling variants first, then MAX against the
    // indexed side (the two sources overlap — indexed aggregates derive from
    // raw rows — so SUM across sources would double-count).
    const rawSums = new Map<string, { name: string; playcount: number }>();
    for (const r of playRows) {
      if (!r.trackName) continue;
      const key = r.trackName.toLowerCase();
      const cur = rawSums.get(key);
      if (!cur) rawSums.set(key, { name: r.trackName, playcount: r._count.trackName });
      else cur.playcount += r._count.trackName;
    }
    for (const [key, raw] of rawSums) {
      const indexed = trackSums.get(key);
      const best = Math.max(indexed?.playcount ?? 0, raw.playcount);
      trackMax.set(key, { name: best === raw.playcount ? raw.name : (indexed?.name ?? raw.name), playcount: best });
    }
    for (const [key, v] of trackSums) {
      if (!trackMax.has(key)) trackMax.set(key, v);
    }

    return [...trackMax.values()].sort((a, b) => b.playcount - a.playcount);
  }

  public async getTotalArtistPlays(userId: number, artistName: string): Promise<number> {
    // SUM across every duplicate row — a single findFirst row is arbitrary
    // and usually partial.
    const artistIds = await this.artistIdsFor(artistName);

    if (artistIds.length > 0) {
      const agg = await prisma.userArtist.aggregate({
        _sum: { playcount: true },
        where: { userId, artistId: { in: artistIds } },
      });
      const total = agg._sum.playcount ?? 0;
      if (total > 0) return total;
    }

    const count = await prisma.userPlay.count({
      where: {
        userId,
        OR: [
          { artistName: { equals: artistName, mode: 'insensitive' } },
          ...(artistIds.length > 0 ? [{ artistId: { in: artistIds } }] : []),
        ],
      },
    });

    return count;
  }

  public async getDistinctTrackCount(userId: number, artistName: string): Promise<number> {
    const tracks = await this.getTopTracksForArtist(userId, artistName);
    return tracks.length;
  }

  /**
   * Returns one representative track title for (user, artist) — used to anchor
   * external metadata (Spotify/Apple) to the exact same-name artist the user
   * actually listens to, instead of the globally-most-popular namesake.
   * Falls back to a second user's top track when the primary user has none.
   */
  public async getSampleTrackForArtist(
    userId: number,
    artistName: string,
    fallbackUserId?: number,
  ): Promise<string | undefined> {
    try {
      const mine = await this.getTopTracksForArtist(userId, artistName);
      if (mine[0]?.name) return mine[0].name;
    } catch {
      // fall through to fallback user
    }
    if (fallbackUserId && fallbackUserId !== userId) {
      try {
        const theirs = await this.getTopTracksForArtist(fallbackUserId, artistName);
        if (theirs[0]?.name) return theirs[0].name;
      } catch {
        // no sample available — callers fall back to name-only resolution
      }
    }
    return undefined;
  }

  public async getTopAlbumsForArtist(userId: number, artistName: string, timePeriod: TimePeriod = TimePeriod.AllTime): Promise<Array<{ name: string; playcount: number }>> {
    const artistIds = await this.artistIdsFor(artistName);

    if (timePeriod === TimePeriod.Weekly || timePeriod === TimePeriod.Monthly) {
      const days = timePeriod === TimePeriod.Weekly ? 7 : 31;
      const since = new Date(Date.now() - days * 24 * 3600000);
      const rows = await prisma.userPlay.groupBy({
        by: ['albumName'],
        where: {
          userId,
          timePlayed: { gte: since },
          albumName: { not: null },
          OR: [
            { artistName: { equals: artistName, mode: 'insensitive' } },
            ...(artistIds.length > 0 ? [{ artistId: { in: artistIds } }] : []),
          ],
        },
        _count: { albumName: true },
        orderBy: { _count: { albumName: 'desc' } },
      });

      const merged = new Map<string, { name: string; playcount: number }>();
      for (const r of rows) {
        if (!r.albumName) continue;
        const key = r.albumName.toLowerCase();
        const cur = merged.get(key);
        if (!cur) merged.set(key, { name: r.albumName, playcount: r._count.albumName });
        else cur.playcount += r._count.albumName;
      }
      return [...merged.values()].sort((a, b) => b.playcount - a.playcount);
    }

    const albumSums = new Map<string, { name: string; playcount: number }>();
    const albumMax = new Map<string, { name: string; playcount: number }>();
    const addAlbumSum = (name: string, count: number) => {
      const key = name.toLowerCase();
      const cur = albumSums.get(key);
      if (!cur) albumSums.set(key, { name, playcount: count });
      else cur.playcount += count;
    };

    if (artistIds.length > 0) {
      const userAlbums = await prisma.userAlbum.findMany({
        where: {
          userId,
          album: { artistId: { in: artistIds } },
        },
        orderBy: { playcount: 'desc' },
        select: {
          name: true,
          playcount: true,
        },
      });

      for (const a of userAlbums) {
        if (a.name) addAlbumSum(a.name, a.playcount);
      }
    }

    const playRows = await prisma.userPlay.groupBy({
      by: ['albumName'],
      where: {
        userId,
        albumName: { not: null },
        OR: [
          { artistName: { equals: artistName, mode: 'insensitive' } },
          ...(artistIds.length > 0 ? [{ artistId: { in: artistIds } }] : []),
        ],
      },
      _count: { albumName: true },
      orderBy: { _count: { albumName: 'desc' } },
    });

    const rawSums = new Map<string, { name: string; playcount: number }>();
    for (const r of playRows) {
      if (!r.albumName) continue;
      const key = r.albumName.toLowerCase();
      const cur = rawSums.get(key);
      if (!cur) rawSums.set(key, { name: r.albumName, playcount: r._count.albumName });
      else cur.playcount += r._count.albumName;
    }
    for (const [key, raw] of rawSums) {
      const indexed = albumSums.get(key);
      const best = Math.max(indexed?.playcount ?? 0, raw.playcount);
      albumMax.set(key, { name: best === raw.playcount ? raw.name : (indexed?.name ?? raw.name), playcount: best });
    }
    for (const [key, v] of albumSums) {
      if (!albumMax.has(key)) albumMax.set(key, v);
    }

    return [...albumMax.values()].sort((a, b) => b.playcount - a.playcount);
  }

  public async getArtistRecentPlays(userId: number, artistName: string): Promise<{ week: number; month: number }> {
    const artistIds = await this.artistIdsFor(artistName);

    const now = Date.now();
    const weekAgo = new Date(now - 7 * 24 * 3600000);
    const monthAgo = new Date(now - 31 * 24 * 3600000);

    const orFilter = [
      { artistName: { equals: artistName, mode: 'insensitive' as const } },
      ...(artistIds.length > 0 ? [{ artistId: { in: artistIds } }] : []),
    ];

    const [week, month] = await Promise.all([
      prisma.userPlay.count({
        where: {
          userId,
          timePlayed: { gte: weekAgo },
          OR: orFilter,
        },
      }),
      prisma.userPlay.count({
        where: {
          userId,
          timePlayed: { gte: monthAgo },
          OR: orFilter,
        },
      }),
    ]);

    return { week, month };
  }

  public async getServerArtistStats(guildId: string, artistName: string): Promise<{ serverPlays: number; serverListeners: number }> {
    const artistIds = await this.artistIdsFor(artistName);

    const guildBigInt = BigInt(guildId);
    const guildUsers = await prisma.guildUser.findMany({
      where: { guildId: guildBigInt },
      select: { userId: true },
    });

    if (guildUsers.length === 0) {
      return { serverPlays: 0, serverListeners: 0 };
    }

    const userIds = guildUsers.map(u => u.userId);

    // Group plays by userId to count server listeners and total plays
    const orFilter = [
      { artistName: { equals: artistName, mode: 'insensitive' as const } },
      ...(artistIds.length > 0 ? [{ artistId: { in: artistIds } }] : []),
    ];

    const userPlaysGroup = await prisma.userPlay.groupBy({
      by: ['userId'],
      where: {
        userId: { in: userIds },
        OR: orFilter,
      },
      _count: { userPlayId: true },
    });

    const serverListeners = userPlaysGroup.length;
    const serverPlays = userPlaysGroup.reduce((sum, g) => sum + g._count.userPlayId, 0);

    return { serverPlays, serverListeners };
  }
}
