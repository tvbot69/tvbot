import { prisma } from '@persistence/prismaClient';
import { TimePeriod } from '@domain/enums/timePeriod';

export interface ArtistTopTrack {
  name: string;
  playcount: number;
}

export class ArtistTrackService {
  public async getTopTracksForArtist(userId: number, artistName: string, timePeriod: TimePeriod = TimePeriod.AllTime): Promise<ArtistTopTrack[]> {
    // 1) Find canonical artist in DB
    const artist = await prisma.artist.findFirst({
      where: { name: { equals: artistName, mode: 'insensitive' } },
      select: { artistId: true, name: true },
    });

    const artistId = artist?.artistId;

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
            ...(artistId ? [{ artistId }] : []),
          ],
        },
        _count: { trackName: true },
        orderBy: { _count: { trackName: 'desc' } },
      });

      return rows
        .filter(r => r.trackName)
        .map(r => ({ name: r.trackName!, playcount: r._count.trackName }));
    }

    // AllTime: Query user_tracks joined with tracks (fmbot ArtistsService.cs line 609)
    const trackMap = new Map<string, { name: string; playcount: number }>();

    if (artistId) {
      const userTracks = await prisma.userTrack.findMany({
        where: {
          userId,
          track: { artistId },
        },
        orderBy: { playcount: 'desc' },
        select: {
          name: true,
          playcount: true,
        },
      });

      for (const t of userTracks) {
        if (t.name) {
          trackMap.set(t.name.toLowerCase(), { name: t.name, playcount: t.playcount });
        }
      }
    }

    // Also query user_plays in case some plays are in user_plays but not yet indexed into user_tracks
    const playRows = await prisma.userPlay.groupBy({
      by: ['trackName'],
      where: {
        userId,
        OR: [
          { artistName: { equals: artistName, mode: 'insensitive' } },
          ...(artistId ? [{ artistId }] : []),
        ],
      },
      _count: { trackName: true },
      orderBy: { _count: { trackName: 'desc' } },
    });

    for (const r of playRows) {
      if (!r.trackName) continue;
      const key = r.trackName.toLowerCase();
      const cur = trackMap.get(key);
      if (!cur) {
        trackMap.set(key, { name: r.trackName, playcount: r._count.trackName });
      } else if (r._count.trackName > cur.playcount) {
        cur.playcount = r._count.trackName;
      }
    }

    return [...trackMap.values()].sort((a, b) => b.playcount - a.playcount);
  }

  public async getTotalArtistPlays(userId: number, artistName: string): Promise<number> {
    const artist = await prisma.artist.findFirst({
      where: { name: { equals: artistName, mode: 'insensitive' } },
      select: { artistId: true },
    });

    if (artist) {
      const userArtist = await prisma.userArtist.findUnique({
        where: { userId_artistId: { userId, artistId: artist.artistId } },
        select: { playcount: true },
      });
      if (userArtist && userArtist.playcount > 0) {
        return userArtist.playcount;
      }
    }

    const count = await prisma.userPlay.count({
      where: {
        userId,
        OR: [
          { artistName: { equals: artistName, mode: 'insensitive' } },
          ...(artist?.artistId ? [{ artistId: artist.artistId }] : []),
        ],
      },
    });

    return count;
  }

  public async getDistinctTrackCount(userId: number, artistName: string): Promise<number> {
    const tracks = await this.getTopTracksForArtist(userId, artistName);
    return tracks.length;
  }

  public async getTopAlbumsForArtist(userId: number, artistName: string, timePeriod: TimePeriod = TimePeriod.AllTime): Promise<Array<{ name: string; playcount: number }>> {
    const artist = await prisma.artist.findFirst({
      where: { name: { equals: artistName, mode: 'insensitive' } },
      select: { artistId: true },
    });

    const artistId = artist?.artistId;

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
            ...(artistId ? [{ artistId }] : []),
          ],
        },
        _count: { albumName: true },
        orderBy: { _count: { albumName: 'desc' } },
      });

      return rows
        .filter(r => r.albumName)
        .map(r => ({ name: r.albumName!, playcount: r._count.albumName }));
    }

    const albumMap = new Map<string, { name: string; playcount: number }>();

    if (artistId) {
      const userAlbums = await prisma.userAlbum.findMany({
        where: {
          userId,
          album: { artistId },
        },
        orderBy: { playcount: 'desc' },
        select: {
          name: true,
          playcount: true,
        },
      });

      for (const a of userAlbums) {
        if (a.name) {
          albumMap.set(a.name.toLowerCase(), { name: a.name, playcount: a.playcount });
        }
      }
    }

    const playRows = await prisma.userPlay.groupBy({
      by: ['albumName'],
      where: {
        userId,
        albumName: { not: null },
        OR: [
          { artistName: { equals: artistName, mode: 'insensitive' } },
          ...(artistId ? [{ artistId }] : []),
        ],
      },
      _count: { albumName: true },
      orderBy: { _count: { albumName: 'desc' } },
    });

    for (const r of playRows) {
      if (!r.albumName) continue;
      const key = r.albumName.toLowerCase();
      const cur = albumMap.get(key);
      if (!cur) {
        albumMap.set(key, { name: r.albumName, playcount: r._count.albumName });
      } else if (r._count.albumName > cur.playcount) {
        cur.playcount = r._count.albumName;
      }
    }

    return [...albumMap.values()].sort((a, b) => b.playcount - a.playcount);
  }

  public async getArtistRecentPlays(userId: number, artistName: string): Promise<{ week: number; month: number }> {
    const artist = await prisma.artist.findFirst({
      where: { name: { equals: artistName, mode: 'insensitive' } },
      select: { artistId: true },
    });

    const now = Date.now();
    const weekAgo = new Date(now - 7 * 24 * 3600000);
    const monthAgo = new Date(now - 31 * 24 * 3600000);

    const orFilter = [
      { artistName: { equals: artistName, mode: 'insensitive' as const } },
      ...(artist?.artistId ? [{ artistId: artist.artistId }] : []),
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
    const artist = await prisma.artist.findFirst({
      where: { name: { equals: artistName, mode: 'insensitive' } },
      select: { artistId: true },
    });

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
      ...(artist?.artistId ? [{ artistId: artist.artistId }] : []),
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
