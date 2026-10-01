import { container, inject, injectable } from 'tsyringe';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';
import type { IArtistRepository } from '@domain/interfaces/ports/iartistRepository';
import type { IAlbumRepository } from '@domain/interfaces/ports/ialbumRepository';
import type { IUserRepository, User } from '@domain/interfaces/ports/iuserRepository';
import type { IGuildUserRepository } from '@domain/interfaces/ports/iguildUserRepository';
import type { AlbumInfo } from '@domain/models/musicInfo';
import type { TopAlbum } from '@domain/models/topLists';
import { CacheService } from '@bot/services/system/cacheService';
import { ArtworkService } from '@bot/services/media/artworkService';
import { ColorService } from '@bot/services/system/colorService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { parseSpotifyReleaseDate } from '@bot/services/library/albumEnrichmentService';
import { PrismaClient } from '@prisma/client';
import { Logger } from '@domain/logging/logger';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { isPlaceholderImageUrl } from '@bot/services/media/artworkService';
import { SourceUnavailableError, isSourceUnavailable } from '@domain/models/errors/sourceUnavailableError';

const CACHE_TTL_SECONDS = 3600;

/**
 * The single place a query failure becomes a caller-visible result.
 *
 * Same rule as `orDatabaseUnavailable` in `playHistoryService`,
 * `guildAdminService`, `genreService` and `countryService`: a query that returns
 * NO ROWS is a real answer and stays an empty array, but a query that THROWS is
 * a failure and is raised rather than returned. `getUserAllTimeTopAlbums` and
 * `getUserAllTimeTopAlbumsByReleasePrefix` both ended in `catch { return [] }`,
 * so a dropped connection told a user they had no albums at all — and worse, for
 * the release-prefix variant, indistinguishable from a genuine decade with no
 * matching releases.
 *
 * There is no "not found" case to split out the way Last.fm has one. Both are
 * aggregates over `user_plays` / `user_albums`, and an aggregate with no
 * matching rows succeeds with a shorter result rather than erroring. So empty IS
 * the answer, and an error is always an error.
 *
 * The wrapper is deliberately NARROW — it covers the query and nothing else. A
 * method-wide `try` would also swallow the `SourceUnavailableError` raised by
 * the `throw` below and return `[]` for it, re-creating the exact bug through the
 * back door, and it would turn a failed cache write into "you have no albums".
 * `CacheService.set` cannot reject anyway: it writes memory first and swallows
 * its own Redis errors.
 */
const orDatabaseUnavailable = async <T>(
  method: string,
  label: string,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (err) {
    Logger.error(
      { query: `${method}:${label}`, err: (err as Error)?.message ?? String(err) },
      `Database unavailable in ${method} (${label}); refusing to render it as an empty album list`,
    );
    throw new SourceUnavailableError(`albumService.${method}:${label}`, err, 'Database unavailable');
  }
};

/**
 * `discord_user_id` is BigInt and arrives as a string, so `BigInt()` throws a
 * SyntaxError on anything non-numeric.
 *
 * A malformed id is a CALLER bug, not a source that failed to answer, and it
 * must not be laundered into a "database unavailable" diagnosis — that would
 * send whoever reads the log looking at Postgres instead of at the caller. Same
 * shape and same reasoning as `parseGuildId` in `genreService` and `toGuildId`
 * in `countryService`: the guard answers with the empty list WITHOUT opening a
 * query, because no such user exists, so no rows can.
 */
const parseDiscordUserId = (discordUserId: string): bigint | null => {
  if (!discordUserId || !/^\d+$/.test(discordUserId)) return null;
  try {
    return BigInt(discordUserId);
  } catch {
    return null;
  }
};

export interface ResolvedAlbumTrack {
  name: string;
  durationSeconds?: number;
  playcount?: number;
  url?: string;
  rank?: number;
}

export interface AlbumSearchResult {
  albumName: string;
  artistName: string;
  albumUrl?: string;
  artistUrl?: string;
  albumCoverUrl?: string;
  albumId: number;
  userPlaycount?: number;
  userMonthlyPlaycount?: number;
  globalPlaycount?: number;
  globalListeners?: number;
  releaseDate?: Date;
  label?: string;
  summary?: string;
  tracks: ResolvedAlbumTrack[];
  totalDurationSeconds?: number;
  serverPlaycount?: number;
  serverListeners?: number;
  userTotalPlays?: number;
  userTimeListenedSeconds?: number;
  userPercentageOfAllPlays?: number;
  spotifyUrl?: string;
}

@injectable()
export class AlbumService {
  private readonly lastfmRepository: ILastfmRepository;
  private readonly artistRepository: IArtistRepository;
  private readonly albumRepository: IAlbumRepository;
  private readonly userRepository: IUserRepository;
  private readonly guildUserRepository: IGuildUserRepository;
  private readonly artworkService: ArtworkService;
  private readonly spotifyApi: SpotifySearchApi;
  private readonly prisma: PrismaClient;
  private readonly cache: CacheService;
  private readonly colorService?: ColorService;

  constructor(
    @inject('ILastfmRepository') lastfmRepository: ILastfmRepository,
    @inject('IArtistRepository') artistRepository: IArtistRepository,
    @inject('IAlbumRepository') albumRepository: IAlbumRepository,
    @inject('IUserRepository') userRepository: IUserRepository,
    @inject('IGuildUserRepository') guildUserRepository: IGuildUserRepository,
    @inject(ArtworkService) artworkService: ArtworkService,
    @inject(SpotifySearchApi) spotifyApi: SpotifySearchApi,
    @inject(PrismaClient) prisma: PrismaClient,
    @inject(CacheService) cache: CacheService,
    @inject(ColorService) colorService?: ColorService,
  ) {
    this.lastfmRepository = lastfmRepository;
    this.artistRepository = artistRepository;
    this.albumRepository = albumRepository;
    this.userRepository = userRepository;
    this.guildUserRepository = guildUserRepository;
    this.artworkService = artworkService;
    this.spotifyApi = spotifyApi;
    this.prisma = prisma;
    this.cache = cache;
    this.colorService = colorService;
  }

  public async getAlbumInfo(
    artistName: string,
    albumName: string,
    username?: string,
  ): Promise<AlbumInfo | null> {
    const key = `album-info:${artistName.toLowerCase()}:${albumName.toLowerCase()}${username ? `:${username.toLowerCase()}` : ''}`;
    const cached = await this.cache.get<AlbumInfo>(key);
    if (cached) {
      return cached;
    }
    const info = await this.lastfmRepository.getAlbumInfo(artistName, albumName, username);
    if (info) {
      await this.cache.set(key, info, CACHE_TTL_SECONDS);
    }
    return info;
  }

  public async searchAlbums(query: string): Promise<TopAlbum[]> {
    return this.lastfmRepository.searchAlbums(query);
  }

  public async getAlbumById(albumId: number): Promise<{ albumName: string; artistName: string; albumId: number } | null> {
    const album = await this.albumRepository.getAlbumById(albumId);
    if (!album) {
      return null;
    }
    const artistRecord = await this.prisma.artist.findUnique({ where: { artistId: album.artistId } });
    return {
      albumName: album.name,
      artistName: artistRecord?.name ?? '',
      albumId: album.albumId,
    };
  }

  public async searchAlbum(
    searchValue: string | null | undefined,
    user: User,
    guildId?: string | null,
  ): Promise<AlbumSearchResult | null> {
    let searchArtist = '';
    let searchAlbum = '';

    const trimmed = (searchValue ?? '').trim();

    if (!trimmed) {
      // Resolve currently playing track or latest scrobble
      const recent = await this.lastfmRepository.getUserRecentTracksWithMetadata(
        user.userNameLastFm, 1, 1, undefined, user.sessionKey,
      );
      const latest = recent.tracks[0];
      if (!latest) {
        return null;
      }
      searchArtist = latest.artistName;
      searchAlbum = latest.albumName || latest.name;
    } else if (trimmed.toLowerCase() === 'random') {
      const topAlbums = await this.lastfmRepository.getTopAlbums(user.userNameLastFm, undefined as never, 100);
      if (topAlbums.length === 0) {
        return null;
      }
      const randomAlbum = topAlbums[Math.floor(Math.random() * topAlbums.length)];
      if (!randomAlbum) return null;
      searchArtist = randomAlbum.artistName;
      searchAlbum = randomAlbum.name;
    } else if (trimmed.includes(' | ')) {
      const [artistPart, albumPart] = trimmed.split(' | ');
      searchArtist = (artistPart ?? '').trim();
      searchAlbum = (albumPart ?? '').trim();
    } else if (trimmed.includes(' - ')) {
      const [artistPart, ...rest] = trimmed.split(' - ');
      searchArtist = (artistPart ?? '').trim();
      searchAlbum = rest.join(' - ').trim();
    } else if (/\s+by\s+/i.test(trimmed)) {
      const [albumPart, artistPart] = trimmed.split(/\s+by\s+/i);
      searchArtist = (artistPart ?? '').trim();
      searchAlbum = (albumPart ?? '').trim();
    } else {
      const matches = await this.lastfmRepository.searchAlbums(trimmed);
      if (matches.length === 0) {
        return null;
      }
      // If user typed e.g. "future future", pick candidate matching artist words
      const lower = trimmed.toLowerCase();
      const best = matches.find((m) =>
        lower.includes(m.artistName.toLowerCase()) && lower.includes(m.name.toLowerCase()),
      ) ?? matches[0]!;
      searchArtist = best.artistName;
      searchAlbum = best.name;
    }

    if (!searchArtist || !searchAlbum) {
      return null;
    }

    const albumInfo = await this.getAlbumInfo(searchArtist, searchAlbum, user.userNameLastFm);
    const resolvedArtistName = albumInfo?.artistName || searchArtist;
    const resolvedAlbumName = albumInfo?.name || searchAlbum;

    // Database record resolution
    const artistRecord = await this.artistRepository.getOrCreateArtist(resolvedArtistName);
    const albumRecord = await this.albumRepository.getOrCreateAlbum(
      resolvedAlbumName,
      artistRecord.artistId,
      albumInfo?.imageUrl,
    );

    // Fetch Spotify full album for release date + label + tracks
    let spotifyReleaseDate: Date | undefined;
    let spotifyLabel: string | undefined;
    let spotifyTracks: Array<{ name: string; track_number: number; duration_ms: number }> = [];
    try {
      const spotifyAlbum = await this.spotifyApi.searchAndGetFullAlbum(resolvedAlbumName, resolvedArtistName);
      if (spotifyAlbum) {
        spotifyReleaseDate = parseSpotifyReleaseDate(spotifyAlbum.release_date, spotifyAlbum.release_date_precision);

        // Extract label from copyrights (℗ phonographic copyright contains label)
        if (spotifyAlbum.label) {
          spotifyLabel = spotifyAlbum.label;
        } else if (spotifyAlbum.copyrights && spotifyAlbum.copyrights.length > 0) {
          const phonographic = spotifyAlbum.copyrights.find((c) => c.type === 'P');
          const copyright = phonographic ?? spotifyAlbum.copyrights[0];
          if (copyright?.text) {
            // Strip any combination of ℗/©/(P)/(C) symbols and year prefixes
            spotifyLabel = copyright.text
              .replace(/^[\s℗©(P)(C)]+/i, '')
              .replace(/^\d{4}\s*/, '')
              .trim() || undefined;
          }
        }

        // Collect Spotify tracks for supplementing Last.fm
        if (spotifyAlbum.tracks?.items && spotifyAlbum.tracks.items.length > 0) {
          spotifyTracks = spotifyAlbum.tracks.items;
        }

        // Persist release data to DB if missing
        if (!albumRecord.releaseDate && spotifyReleaseDate) {
          // CORRECT AS IS. A WRITE-BACK of data already in hand: the release date
          // was read from Spotify and is about to be returned on the card
          // regardless (the return reads `albumRecord.releaseDate ||
          // spotifyReleaseDate`). Failing to persist it costs one more Spotify
          // lookup next time and nothing the user can see, so raising here would
          // fail a whole album card over a cache write. Same as the MusicBrainz
          // write-back in `countryService.getArtistCountry`.
          await this.albumRepository.setReleaseData(albumRecord.albumId, {
            releaseDate: spotifyReleaseDate,
            releaseDatePrecision: spotifyAlbum.release_date_precision,
            spotifyAlbumType: spotifyAlbum.album_type,
          }).catch((writeErr: unknown) => {
            Logger.debug(
              { albumId: albumRecord.albumId, err: (writeErr as Error)?.message ?? String(writeErr) },
              'albumService could not persist Spotify release data; the next lookup will ask again',
            );
            return undefined;
          });
        }
      }
    } catch (err) {
      Logger.warn({ err }, 'Failed to fetch Spotify album metadata');
    }

    // Resolve cover art — ArtworkService is primary (Spotify→Deezer→Apple→Last.fm), Last.fm raw URL is last-resort
    const rawLfmCover = albumInfo?.imageUrl && !isPlaceholderImageUrl(albumInfo.imageUrl) ? albumInfo.imageUrl : undefined;
    const coverUrl =
      (await this.artworkService.getAlbumCoverUrl(resolvedAlbumName, resolvedArtistName)) ||
      rawLfmCover;

    // Resolve tracks & track durations
    // Use Last.fm tracks, but supplement with Spotify if Last.fm has fewer tracks
    const rawTracks = albumInfo?.tracks ?? [];
    let totalDurationSeconds = 0;
    let tracks: ResolvedAlbumTrack[];

    if (spotifyTracks.length > rawTracks.length) {
      // Use Spotify tracks as primary source (more complete)
      tracks = spotifyTracks.map((st) => {
        const durSec = Math.round(st.duration_ms / 1000);
        totalDurationSeconds += durSec;
        return {
          name: st.name,
          durationSeconds: durSec,
          playcount: undefined,
          url: `https://www.last.fm/music/${encodeURIComponent(resolvedArtistName)}/_/${encodeURIComponent(st.name)}`,
          rank: st.track_number,
        };
      });
    } else {
      // Use Last.fm tracks
      tracks = rawTracks.map((t, idx) => {
        if (t.durationSeconds) {
          totalDurationSeconds += t.durationSeconds;
        }
        return {
          name: t.name,
          durationSeconds: t.durationSeconds,
          playcount: undefined,
          url: t.url || `https://www.last.fm/music/${encodeURIComponent(resolvedArtistName)}/_/${encodeURIComponent(t.name)}`,
          rank: t.rank ?? idx + 1,
        };
      });
    }

    // Resolve user's playcount on tracks from DB if available
    try {
      if (tracks.length > 0 && user.userId) {
        const trackNames = tracks.map((t) => t.name.toLowerCase());
        const userTrackPlays = await this.prisma.userPlay.groupBy({
          by: ['trackName'],
          where: {
            userId: user.userId,
            artistName: { equals: resolvedArtistName, mode: 'insensitive' },
            trackName: { in: trackNames, mode: 'insensitive' },
          },
          _count: { trackName: true },
        });

        const playMap = new Map<string, number>();
        for (const row of userTrackPlays) {
          if (row.trackName) {
            playMap.set(row.trackName.toLowerCase(), row._count.trackName);
          }
        }

        for (const track of tracks) {
          const count = playMap.get(track.name.toLowerCase());
          if (count !== undefined && count > 0) {
            track.playcount = count;
          }
        }
      }
    } catch (err) {
      // CORRECT AS IS, and deliberately NOT raised. This is the PER-TRACK
      // playcount enrichment: `track.playcount` is simply left undefined, so the
      // album card drops one number per track. Nothing is fabricated — the card
      // still shows the right album, artist, tracklist, durations, cover and play
      // counts, and an absent clause is a visible absence rather than a confident
      // wrong number. Raising would fail nine command entry points over
      // decoration, and `userPlaycount` in the block below has a real fallback to
      // Last.fm's own count anyway.
      Logger.warn({ err }, 'Failed to compute track playcounts');
    }

    // User total plays & server stats
    let userPlaycount = albumInfo?.userPlayCount;
    let userMonthlyPlaycount: number | undefined;
    let userTimeListenedSeconds: number | undefined;
    let userPercentageOfAllPlays: number | undefined;
    let serverPlaycount: number | undefined;
    let serverListeners: number | undefined;

    try {
      if (user.userId) {
        const dbPlays = await this.prisma.userPlay.count({
          where: {
            userId: user.userId,
            albumId: albumRecord.albumId,
          },
        });
        if (dbPlays > 0 && (!userPlaycount || dbPlays > userPlaycount)) {
          userPlaycount = dbPlays;
        }

        const oneMonthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
        const monthlyPlays = await this.prisma.userPlay.count({
          where: {
            userId: user.userId,
            albumId: albumRecord.albumId,
            timePlayed: { gte: oneMonthAgo },
          },
        });
        if (monthlyPlays > 0) {
          userMonthlyPlaycount = monthlyPlays;
        }

        // Calculate time listened using per-track playcounts × durations
        if (tracks.length > 0) {
          let computedSeconds = 0;
          for (const track of tracks) {
            const pc = track.playcount ?? 0;
            const dur = track.durationSeconds ?? 0;
            if (pc > 0 && dur > 0) {
              computedSeconds += pc * dur;
            }
          }
          if (computedSeconds > 0) {
            userTimeListenedSeconds = computedSeconds;
          } else if (userPlaycount && totalDurationSeconds > 0 && tracks.length > 0) {
            // Fallback: avg track duration × total plays
            const avgTrackDuration = totalDurationSeconds / tracks.length;
            userTimeListenedSeconds = Math.round(userPlaycount * avgTrackDuration);
          }
        } else if (userPlaycount) {
          userTimeListenedSeconds = userPlaycount * 210; // estimate 3.5 min per track
        }

        if (user.totalPlayCount && user.totalPlayCount > 0 && userPlaycount) {
          userPercentageOfAllPlays = Number(((userPlaycount / user.totalPlayCount) * 100).toFixed(2));
        }
      }

      if (guildId) {
        const guildUserIds = await this.guildUserRepository.getUserIdsForGuild(guildId);
        if (guildUserIds.length > 0) {
          const guildPlays = await this.prisma.userPlay.findMany({
            where: {
              albumId: albumRecord.albumId,
              userId: { in: guildUserIds },
            },
            select: { userId: true },
          });
          if (guildPlays.length > 0) {
            serverPlaycount = guildPlays.length;
            serverListeners = new Set(guildPlays.map((p) => p.userId)).size;
          }
        }
      }
    } catch (err) {
      // CORRECT AS IS, for the same reason as the per-track block above, plus
      // one that only this block has. The headline figure it would have set —
      // `userPlaycount` — was seeded from `albumInfo.userPlayCount` (Last.fm's
      // own number) BEFORE this try, so a failed indexed count degrades to a
      // real number from a real source rather than to a zero. What is lost is
      // `userMonthlyPlaycount`, `serverPlaycount` and `serverListeners`, all of
      // which then render as absent clauses. `Logger.warn` is the honest weight
      // for that; raising would fail nine command entry points over three
      // omitted figures. It is WARN rather than DEBUG because a failed count is a
      // lost capability, not an expected outcome.
      Logger.warn({ err }, 'Failed to query server/user stats for album');
    }

    const artistSlug = encodeURIComponent(resolvedArtistName);
    const albumSlug = encodeURIComponent(resolvedAlbumName);

    return {
      albumName: resolvedAlbumName,
      artistName: resolvedArtistName,
      albumUrl: albumInfo?.url || `https://www.last.fm/music/${artistSlug}/${albumSlug}`,
      artistUrl: `https://www.last.fm/music/${artistSlug}`,
      albumCoverUrl: coverUrl || undefined,
      albumId: albumRecord.albumId,
      userPlaycount: userPlaycount,
      userMonthlyPlaycount: userMonthlyPlaycount,
      globalPlaycount: albumInfo?.playCount,
      globalListeners: albumInfo?.listeners,
      releaseDate: albumRecord.releaseDate || spotifyReleaseDate || undefined,
      label: spotifyLabel || undefined,
      summary: albumInfo?.summary,
      tracks: tracks,
      totalDurationSeconds: totalDurationSeconds > 0 ? totalDurationSeconds : undefined,
      serverPlaycount: serverPlaycount,
      serverListeners: serverListeners,
      userTotalPlays: user.totalPlayCount ?? undefined,
      userTimeListenedSeconds: userTimeListenedSeconds,
      userPercentageOfAllPlays: userPercentageOfAllPlays,
    };
  }

  public resolveAlbumFromLink(input: string): { artistName?: string; albumName?: string } | null {
    if (!input || !input.includes('http')) return null;

    // Last.fm album URL: https://www.last.fm/music/Radiohead/OK+Computer
    const lastfmMatch = input.match(/last\.fm\/music\/([^/?#]+)\/([^/?#]+)/i);
    if (lastfmMatch && lastfmMatch[1] && lastfmMatch[2]) {
      try {
        return {
          artistName: decodeURIComponent(lastfmMatch[1].replace(/\+/g, ' ')),
          albumName: decodeURIComponent(lastfmMatch[2].replace(/\+/g, ' ')),
        };
      } catch {
        return { artistName: lastfmMatch[1], albumName: lastfmMatch[2] };
      }
    }

    // Spotify album URL: https://open.spotify.com/album/4LH4d3cOWNNXdsqFd42wum
    const spotifyMatch = input.match(/spotify\.com\/(?:intl-[a-zA-Z-]+\/)?album\/([a-zA-Z0-9]+)/i);
    if (spotifyMatch && spotifyMatch[1]) {
      return { albumName: spotifyMatch[1] };
    }

    // Apple Music album URL
    const appleMatch = input.match(/music\.apple\.com\/[a-z]{2}\/album\/([^/]+)\/([0-9]+)/i);
    if (appleMatch && appleMatch[1]) {
      try {
        return { albumName: decodeURIComponent(appleMatch[1].replace(/-/g, ' ')) };
      } catch {
        return { albumName: appleMatch[1] };
      }
    }

    return null;
  }

  public filterAlbumsThatAreSingles<T extends { name: string; albumType?: string }>(albums: T[]): T[] {
    if (!albums || albums.length === 0) return [];
    return albums.filter((a) => {
      if (a.albumType && a.albumType.toLowerCase() === 'single') return false;
      const lower = a.name.toLowerCase();
      return !lower.endsWith(' - single') && !lower.endsWith(' - ep') && lower !== 'single';
    });
  }

  public filterAlbumToReleaseYear<T extends { releaseDate?: Date }>(albums: T[], year: number): T[] {
    if (!albums || albums.length === 0) return [];
    return albums.filter((a) => a.releaseDate && a.releaseDate.getUTCFullYear() === year);
  }

  public filterAlbumToReleaseDecade<T extends { releaseDate?: Date }>(albums: T[], decade: number): T[] {
    if (!albums || albums.length === 0) return [];
    const endDecade = decade + 9;
    return albums.filter((a) => {
      if (!a.releaseDate) return false;
      const y = a.releaseDate.getUTCFullYear();
      return y >= decade && y <= endDecade;
    });
  }
  /**
   * Batch hydrates missing album covers across Spotify / Last.fm
   */
  public async fillMissingAlbumCovers(topAlbums: TopAlbum[]): Promise<TopAlbum[]> {
    const missing = topAlbums.filter((a) => !a.imageUrl);
    if (missing.length === 0) return topAlbums;

    await Promise.all(
      missing.map(async (album) => {
        try {
          const url = await this.artworkService.getAlbumCoverUrl(album.name, album.artistName);
          if (url) {
            album.imageUrl = url;
          }
        } catch {
          // CORRECT AS IS. This is BATCH COVER HYDRATION: every album already in
          // the list is returned unchanged either way, and a cover that cannot be
          // found is the state the method is designed to leave alone (AGENTS.md
          // §3.2, "a chapter whose art genuinely cannot be found holds the
          // previous cover"). No number is invented and no row is dropped, so
          // there is nothing here for a user to be misled about, and
          // `getAlbumCoverUrl` raises nothing itself — `ArtworkService` owns that
          // decision.
        }
      }),
    );

    return topAlbums;
  }

  /**
   * User's all-time top albums
   */
  public async getUserAllTimeTopAlbums(userId: number, useCache: boolean = false): Promise<TopAlbum[]> {
    const cacheKey = `user-${userId}-topalbums-alltime`;
    if (useCache) {
      const cached = await this.cache.get<TopAlbum[]>(cacheKey);
      if (cached) return cached;
    }

    const rows = await orDatabaseUnavailable(
      'getUserAllTimeTopAlbums',
      'userPlaysTopAlbums',
      () => this.prisma.$queryRawUnsafe<Array<{ album_name: string; artist_name: string; playcount: bigint }>>(`
        SELECT album_name, artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND album_name IS NOT NULL AND album_name != ''
        GROUP BY album_name, artist_name
        ORDER BY playcount DESC
        LIMIT 1000
      `, userId),
    );

    const albums: TopAlbum[] = rows.map((r) => ({
      name: r.album_name,
      artistName: r.artist_name,
      playcount: Number(r.playcount),
    }));

    // Cache write, deliberately OUTSIDE the guarded block: the rows are already
    // in hand, and a cache failure must not turn a correct chart into an error.
    if (albums.length > 100) {
      await this.cache.set(cacheKey, albums, 600);
    }

    return albums;
  }

  public async getTopTracksForAlbum(
    artistName: string,
    albumName: string,
    limit: number = 3,
    userId?: number,
  ): Promise<string[]> {
    try {
      // 1. Get official album tracklist from Last.fm or Spotify
      const albumInfo = await this.getAlbumInfo(artistName, albumName);
      let albumTrackNames = (albumInfo?.tracks ?? []).map((t) => t.name).filter(Boolean);

      if (albumTrackNames.length === 0) {
        albumTrackNames = await this.spotifyApi.getAlbumTrackNames(albumName, artistName, 50);
      }

      // 2. If user provided and we have album tracks, count caller's plays for each track
      if (userId && albumTrackNames.length > 0) {
        const lowerTrackNames = albumTrackNames.map((t) => t.toLowerCase());
        const userTrackPlays = await this.prisma.userPlay.groupBy({
          by: ['trackName'],
          where: {
            userId,
            artistName: { equals: artistName, mode: 'insensitive' },
            trackName: { in: lowerTrackNames, mode: 'insensitive' },
          },
          _count: { trackName: true },
        });

        const playMap = new Map<string, number>();
        for (const row of userTrackPlays) {
          if (row.trackName) {
            playMap.set(row.trackName.toLowerCase(), row._count.trackName);
          }
        }

        // Sort album tracks by user's playcount descending; keep original order for ties
        const scoredTracks = albumTrackNames.map((name, idx) => ({
          name,
          plays: playMap.get(name.toLowerCase()) ?? 0,
          originalIdx: idx,
        }));

        scoredTracks.sort((a, b) => {
          if (b.plays !== a.plays) return b.plays - a.plays;
          return a.originalIdx - b.originalIdx;
        });

        return scoredTracks.slice(0, limit).map((t) => t.name);
      }

      // 3. If global (no userId) and we have album tracks, count global plays
      if (albumTrackNames.length > 0) {
        const lowerTrackNames = albumTrackNames.map((t) => t.toLowerCase());
        const globalTrackPlays = await this.prisma.userPlay.groupBy({
          by: ['trackName'],
          where: {
            artistName: { equals: artistName, mode: 'insensitive' },
            trackName: { in: lowerTrackNames, mode: 'insensitive' },
          },
          _count: { trackName: true },
        });

        const playMap = new Map<string, number>();
        for (const row of globalTrackPlays) {
          if (row.trackName) {
            playMap.set(row.trackName.toLowerCase(), row._count.trackName);
          }
        }

        const scoredTracks = albumTrackNames.map((name, idx) => ({
          name,
          plays: playMap.get(name.toLowerCase()) ?? 0,
          originalIdx: idx,
        }));

        scoredTracks.sort((a, b) => {
          if (b.plays !== a.plays) return b.plays - a.plays;
          return a.originalIdx - b.originalIdx;
        });

        return scoredTracks.slice(0, limit).map((t) => t.name);
      }

      // 4. Fallback: query user_plays directly by album_name
      if (userId) {
        const rows = await this.prisma.$queryRawUnsafe<Array<{ track_name: string; playcount: bigint }>>(`
          SELECT track_name, COUNT(*)::bigint AS playcount
          FROM user_plays
          WHERE user_id = $1 AND LOWER(artist_name) = LOWER($2) AND LOWER(album_name) = LOWER($3) AND track_name IS NOT NULL AND track_name != ''
          GROUP BY track_name
          ORDER BY playcount DESC
          LIMIT $4
        `, userId, artistName, albumName, limit);

        const tracks = rows.map((r) => r.track_name).filter(Boolean);
        if (tracks.length > 0) return tracks;
      }

      return [];
    } catch (err) {
      // CORRECT AS IS for a genuine query failure, and NOT for a raised one.
      // The empty list is honest here because `getTopTracksForAlbum` is RUNG 1
      // AND 2 of a four-rung ladder: `whoKnowsImageBuilder` falls through to the
      // album's own metadata tracklist and then to Spotify when this returns
      // nothing, so `[]` costs the caller one rung rather than the answer.
      //
      // But this is a method-wide try spanning `getAlbumInfo` — which goes
      // through `lastFmRepository.getAlbumInfo`, and that method RAISES
      // `LastFmUnavailableError` on a 5xx precisely so no caller can mistake a
      // Last.fm outage for "this album has no tracks". Swallowing it here puts
      // the lie straight back, one layer up, and does it silently. So the
      // deliberately-raised signal is re-thrown and only genuine failures
      // degrade, which is the same narrowing `genreService.getGenresForArtist`
      // uses for the identical reason.
      if (isSourceUnavailable(err)) {
        Logger.error(
          { artistName, albumName, err: (err as Error)?.message ?? String(err) },
          'getTopTracksForAlbum: a source failed to answer; not degrading it to "no top tracks"',
        );
        throw err;
      }
      Logger.warn({ err }, 'Failed to resolve top tracks for album');
      return [];
    }
  }

  /**
   * Filters user's all-time top albums by release prefix (e.g. '199' for 90s, '2023' for 2023)
   */
  public async getUserAllTimeTopAlbumsByReleasePrefix(
    userId: number,
    prefix: string,
    prefixLength: number = 4,
  ): Promise<TopAlbum[]> {
    // Every column here was wrong before the real-Postgres suite ran
    // (42703 ua.artist_name / 42883 left(text, bigint)):
    //   - albums' PK is album_id, not id.
    //   - user_albums has no artist_name; the artist name lives on artists,
    //     reachable only through albums.artist_id.
    //   - there is no albums.type; the column is spotify_album_type.
    //   - $2 arrives as bigint and there is no left(text, bigint).
    // The catch used to sit around the WHOLE method and return the unfiltered
    // all-time list, so a query that threw on every call produced a confident
    // embed with a decade filter that had done nothing. It then "improved" to
    // `return []`, which is still not good enough: a dropped connection and a
    // decade with no matching releases would be the same empty chart. Raised now.
    const rows = await orDatabaseUnavailable(
      'getUserAllTimeTopAlbumsByReleasePrefix',
      'userAlbumsByReleasePrefix',
      () => this.prisma.$queryRawUnsafe<Array<{
        album_name: string;
        artist_name: string;
        playcount: bigint;
        release_date: Date | null;
        album_type: string | null;
      }>>(`
        SELECT ua.name AS album_name,
               ar.name AS artist_name,
               ua.playcount,
               a.release_date,
               a.spotify_album_type AS album_type
        FROM user_albums ua
        INNER JOIN albums a ON ua.album_id = a.album_id
        INNER JOIN artists ar ON a.artist_id = ar.artist_id
        WHERE ua.user_id = $1
          AND a.release_date IS NOT NULL
          AND LEFT(a.release_date::text, $2::int) = $3
        ORDER BY ua.playcount DESC
        LIMIT 100
      `, userId, prefixLength, prefix),
    );

    return rows.map((r) => ({
      name: r.album_name,
      artistName: r.artist_name,
      playcount: Number(r.playcount),
      releaseDate: r.release_date ?? undefined,
      albumType: r.album_type ?? undefined,
    }));
  }
  /**
   * Filters guild albums to release period
   */
  public async filterAlbumsToReleasePeriod<T extends { artistName: string; albumName: string }>(
    albums: T[],
    periodStart: Date,
    periodEnd: Date,
  ): Promise<T[]> {
    if (albums.length === 0) return [];
    try {
      const albumNames = albums.map((a) => a.albumName);
      const rows = await this.prisma.album.findMany({
        where: {
          name: { in: albumNames, mode: 'insensitive' },
          releaseDate: { gte: periodStart, lt: periodEnd },
        },
        select: { name: true, artist: { select: { name: true } } },
      });

      const matched = new Set(rows.map((r) => `${r.artist.name.toLowerCase()}|${r.name.toLowerCase()}`));
      return albums.filter((a) => matched.has(`${a.artistName.toLowerCase()}|${a.albumName.toLowerCase()}`));
    } catch (err) {
      // NOT correct in the abstract, and NOT fixed here on purpose. Returning
      // `albums` means the period filter silently did nothing, which is the very
      // bug `getUserAllTimeTopAlbumsByReleasePrefix` above had and no longer has.
      // It is left as-is for one reason that is verifiable rather than hopeful:
      // `filterAlbumsToReleasePeriod` has ZERO production callers (grep the name
      // outside `*.test.ts`), so no user can be shown a wrong decade today. That
      // is an omission of the caller graph, not a property of the code — whoever
      // wires this up must raise instead. The WARN exists so the shape is not
      // mistaken for an endorsed default.
      Logger.warn({ err }, 'filterAlbumsToReleasePeriod query failed; returning the input UNFILTERED');
      return albums;
    }
  }

  /**
   * Resolves album accent color
   */
  public async getAlbumAccentColor(
    albumCoverUrl?: string | null,
    _albumName?: string,
    _artistName?: string,
  ): Promise<number> {
    if (albumCoverUrl) {
      try {
        const cs = this.colorService ?? container.resolve(ColorService);
        return cs.getColorFromImageUrl(albumCoverUrl);
      } catch {
        // CORRECT AS IS, and it is not a query at all. This is a DECORATIVE
        // accent colour for an embed, so the fallback is a fixed brand colour,
        // never a fabricated fact about the album. Raising would fail four
        // who-knows charts over a stripe.
        return DiscordConstants.LastFmColorRed;
      }
    }
    return DiscordConstants.LastFmColorRed;
  }
  /**
   * Formats album release date string matching C# GetAlbumReleaseDate
   */
  public static getAlbumReleaseDate(album: { releaseDate?: Date | string | null; releaseDatePrecision?: string | null }): string | null {
    if (!album.releaseDate) return null;
    const date = typeof album.releaseDate === 'string' ? new Date(album.releaseDate) : album.releaseDate;
    if (isNaN(date.getTime())) return null;

    if (album.releaseDatePrecision === 'year') {
      return `\`${date.getUTCFullYear()}\``;
    }
    if (album.releaseDatePrecision === 'month') {
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      return `${monthNames[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
    }

    const epochSeconds = Math.floor(date.getTime() / 1000);
    return `<t:${epochSeconds}:D>`;
  }

  /**
   * Autocomplete: Recent albums played in last 2 days
   */
  public async getLatestAlbums(
    discordUserId: string,
    cacheEnabled: boolean = true,
  ): Promise<Array<{ artistName: string; albumName: string }>> {
    const cacheKey = `user-recent-albums-${discordUserId}`;
    if (cacheEnabled) {
      const cached = await this.cache.get<Array<{ artistName: string; albumName: string }>>(cacheKey);
      if (cached) return cached;
    }

    // Guarded BEFORE the query, and after the cache read, so a cache hit still
    // wins (the db suite pins that) while a malformed id never opens a query.
    const parsedId = parseDiscordUserId(discordUserId);
    if (parsedId === null) {
      Logger.debug({ discordUserId }, 'getLatestAlbums received a non-numeric discord id; no query was issued');
      return [];
    }

    try {
      const user = await this.prisma.user.findFirst({
        where: { discordUserId: parsedId },
        select: { userId: true },
      });
      if (!user) return [];

      const cutoff = new Date(Date.now() - 2 * 24 * 3600 * 1000);
      const plays = await this.prisma.userPlay.findMany({
        where: {
          userId: user.userId,
          timePlayed: { gte: cutoff },
          albumName: { not: null },
        },
        orderBy: { timePlayed: 'desc' },
        select: { artistName: true, albumName: true },
        take: 200,
      });

      const unique = new Map<string, { artistName: string; albumName: string }>();
      for (const p of plays) {
        if (p.albumName) {
          const key = `${p.artistName.toLowerCase()}|${p.albumName.toLowerCase()}`;
          if (!unique.has(key)) {
            unique.set(key, { artistName: p.artistName, albumName: p.albumName });
          }
        }
      }

      const result = Array.from(unique.values()).slice(0, 25);
      await this.cache.set(cacheKey, result, 30);
      return result;
    } catch {
      // CORRECT AS IS. This is an AUTOCOMPLETE SUGGESTION LIST, and an empty
      // one is what autocomplete is for: no options is an honest, functional
      // answer that the user simply keeps typing. The list it produces is never
      // rendered as a chart, a play count or a claim about the user, so there is
      // no plausible wrong number here to suppress — the opposite of the case
      // `getUserAllTimeTopAlbums` makes, where `[]` would read as "you have no
      // albums" on a chart. Raising would also risk an unacknowledged
      // interaction on an autocomplete callback.
      return [];
    }
  }

  /**
   * Autocomplete: Top albums in last 20 days
   */
  public async getRecentTopAlbums(
    discordUserId: string,
    cacheEnabled: boolean = true,
  ): Promise<Array<{ artistName: string; albumName: string }>> {
    const cacheKey = `user-recent-top-albums-${discordUserId}`;
    if (cacheEnabled) {
      const cached = await this.cache.get<Array<{ artistName: string; albumName: string }>>(cacheKey);
      if (cached) return cached;
    }

    // Guarded BEFORE the query, and after the cache read — see `getLatestAlbums`.
    const parsedId = parseDiscordUserId(discordUserId);
    if (parsedId === null) {
      Logger.debug({ discordUserId }, 'getRecentTopAlbums received a non-numeric discord id; no query was issued');
      return [];
    }

    try {
      const user = await this.prisma.user.findFirst({
        where: { discordUserId: parsedId },
        select: { userId: true },
      });
      if (!user) return [];

      const cutoff = new Date(Date.now() - 20 * 24 * 3600 * 1000);
      const rows = await this.prisma.$queryRawUnsafe<Array<{
        artist_name: string;
        album_name: string;
        playcount: bigint;
      }>>(`
        SELECT artist_name, album_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND time_played >= $2 AND album_name IS NOT NULL AND album_name != ''
        GROUP BY artist_name, album_name
        ORDER BY playcount DESC
        LIMIT 25
      `, user.userId, cutoff);

      const result = rows.map((r) => ({
        artistName: r.artist_name,
        albumName: r.album_name,
      }));

      await this.cache.set(cacheKey, result, 120);
      return result;
    } catch {
      // CORRECT AS IS. Autocomplete suggestion list — same reasoning as
      // `getLatestAlbums` above. The `playcount` this raw query selects is
      // discarded anyway; nothing is charted from it.
      return [];
    }
  }

  /**
   * Autocomplete: Search through album catalog
   */
  public async searchThroughAlbums(
    searchValue: string,
  ): Promise<Array<{ artistName: string; albumName: string; popularity?: number }>> {
    if (!searchValue || searchValue.trim().length === 0) return [];
    try {
      const rows = await this.prisma.album.findMany({
        where: {
          name: { contains: searchValue.trim(), mode: 'insensitive' },
        },
        take: 25,
        select: { name: true, artist: { select: { name: true } } },
      });

      return rows.map((r) => ({
        artistName: r.artist.name,
        albumName: r.name,
      }));
    } catch {
      // CORRECT AS IS. Autocomplete catalogue search — same reasoning as
      // `getLatestAlbums`: no suggestions is a working autocomplete response, not
      // a claim about the catalogue.
      return [];
    }
  }
}

