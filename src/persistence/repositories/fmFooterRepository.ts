import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';

/** The one field the footer needs off a catalogue album row. */
export interface FmFooterAlbumRow {
  albumId: number;
}

/** The one field the footer needs off a catalogue track row. */
export interface FmFooterTrackRow {
  trackId: number;
}

/**
 * Data access for the now-playing footer. These were six inline Prisma calls
 * service-located from inside `FmFooterResolver`, which meant the only file
 * describing the footer's query shapes was also the file owning the
 * `FmFooterOption` bitmask. Splitting them keeps the mask readable and puts the
 * query semantics in the layer that owns them.
 *
 * Two rules the caller depends on, so they are not "simplified" away:
 *
 *  - A missing rollup row is `null`, not `0`. The footer renders "N plays" only
 *    for a positive sum, and an explicit `0` from the upstream service is a
 *    different answer from an absent row. The repository reports which it was;
 *    the caller decides what to render.
 *  - Name lookups are case-insensitive. Last.fm sends whatever the tagger
 *    typed, so an exact `equals` silently returns nothing.
 */
@injectable()
export class FmFooterRepository {
  constructor(@inject(PrismaClient) private readonly prisma: PrismaClient) {}

  /**
   * Total plays one user has on an artist, from the `user_artists` rollup.
   * `null` when the user has no row for that artist name.
   */
  public async getUserArtistPlaycount(userId: number, artistName: string): Promise<number | null> {
    const agg = await this.prisma.userArtist.aggregate({
      _sum: { playcount: true },
      where: {
        userId,
        name: { equals: artistName, mode: 'insensitive' },
      },
    });
    return agg._sum.playcount ?? null;
  }

  /** Total plays one user has on an album, from the `user_albums` rollup. */
  public async getUserAlbumPlaycount(userId: number, albumName: string): Promise<number | null> {
    const agg = await this.prisma.userAlbum.aggregate({
      _sum: { playcount: true },
      where: {
        userId,
        name: { equals: albumName, mode: 'insensitive' },
      },
    });
    return agg._sum.playcount ?? null;
  }

  /** Total plays one user has on a track, from the `user_tracks` rollup. */
  public async getUserTrackPlaycount(userId: number, trackName: string): Promise<number | null> {
    const agg = await this.prisma.userTrack.aggregate({
      _sum: { playcount: true },
      where: {
        userId,
        name: { equals: trackName, mode: 'insensitive' },
      },
    });
    return agg._sum.playcount ?? null;
  }

  /**
   * Scrobbles one user made for an artist at or after `since`. The window is a
   * caller argument rather than a repository constant: "this week" is footer
   * policy, and the caller already owns the clock it measured the week with.
   *
   * Unlike the playcounts above, a `0` here is a real answer ("you played them
   * zero times this week"), so it is passed straight through.
   */
  public async countUserArtistPlaysSince(
    userId: number,
    artistName: string,
    since: Date,
  ): Promise<number> {
    return this.prisma.userPlay.count({
      where: {
        userId,
        artistName: { equals: artistName, mode: 'insensitive' },
        timePlayed: { gte: since },
      },
    });
  }

  /**
   * The catalogue `albums.album_id` for a name/artist pair, or `null` when the
   * album is not indexed. The id is what the who-knows rollup is keyed by, so a
   * display name has to be resolved before the listener count can be asked for.
   */
  public async findAlbumByNameAndArtist(
    albumName: string,
    artistName: string,
  ): Promise<FmFooterAlbumRow | null> {
    const row = await this.prisma.album.findFirst({
      where: {
        name: { equals: albumName, mode: 'insensitive' },
        artist: { name: { equals: artistName, mode: 'insensitive' } },
      },
    });
    return row ? { albumId: row.albumId } : null;
  }

  /** The catalogue `tracks.track_id` for a name/artist pair, or `null`. */
  public async findTrackByNameAndArtist(
    trackName: string,
    artistName: string,
  ): Promise<FmFooterTrackRow | null> {
    const row = await this.prisma.track.findFirst({
      where: {
        name: { equals: trackName, mode: 'insensitive' },
        artist: { name: { equals: artistName, mode: 'insensitive' } },
      },
    });
    return row ? { trackId: row.trackId } : null;
  }
}
