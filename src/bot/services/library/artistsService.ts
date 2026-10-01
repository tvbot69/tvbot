import { container } from 'tsyringe';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { ArtistInfo } from '@domain/models/musicInfo';
import type { TopArtist } from '@domain/models/topLists';
import type { User } from '@domain/interfaces/iuserRepository';
import type { ReferencedMusic } from '@domain/models/referencedMusic';
import { ArtworkService } from '@bot/services/media/artworkService';
import { ColorService } from '@bot/services/system/colorService';
import { CacheService } from '@bot/services/system/cacheService';
import { prisma as defaultPrisma } from '@persistence/prismaClient';
import type { PrismaClient } from '@prisma/client';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { Logger } from '@domain/logger';
import type { TasteItem } from '@bot/services/library/tasteService';
import { isPlaceholderImageUrl } from '@bot/services/media/artworkService';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';

/**
 * A query that could not run is not a query that found nothing.
 *
 * Seven methods in this file each wrapped a Prisma call in `try { ... } catch {
 * return [] }` (or `return null`). Every one of them is an aggregate over
 * `user_plays` or a lookup against `artists`, which means a dropped connection
 * and a user who genuinely has never pressed play produced the SAME value -
 * and the caller could not tell them apart.
 *
 * That matters because these are not internal counters. `getArtistForId` and
 * `getArtistFromDatabase` returning `null` read as "no such artist", and
 * `getUserAllTimeTopArtists` returning `[]` silently demotes `.playcount
 * artist rnd` from the user's own indexed history to a Last.fm pick presented
 * as their taste. A confident wrong answer the user has no way to distrust.
 *
 * The four list queries below have exactly one production caller each -
 * `whoKnowsImageBuilder`, which already wraps them in its own try/catch and
 * falls through to the next cover source - so raising changes nothing there and
 * costs one ERROR line per mosaic render during an outage, which is the point:
 * that render is already visibly degraded and the log should say why.
 *
 * NOT `artistTrackSlashCommands`, which renders `[]` as "No tracks found for
 * artist X" - that command calls `ArtistTrackService`, a different service with
 * a different query. Nothing in this file feeds that string.
 *
 * Same rule as `orUnavailable` in lastFmRepository and
 * `orDatabaseUnavailable` in playHistoryService: a query that returns NO ROWS is
 * a real answer and stays empty; a query that THROWS raises. Empty is only
 * honest when something actually answered.
 *
 * `label` is `method:query` because these seven sites are the whole reason this
 * helper exists - the method name in the log is what tells you which command
 * broke.
 */
const orDatabaseUnavailable = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (err) {
    Logger.error(
      { query: label, err: (err as Error)?.message ?? String(err) },
      `Database unavailable in artistsService (${label}); refusing to render the failure as a real result`,
    );
    throw new SourceUnavailableError(label, err, 'Database unavailable');
  }
};

const CACHE_TTL_SECONDS = 3600;

export interface ArtistSearchResult {
  artistName: string;
  artistUrl?: string;
  imageUrl?: string;
  userPlaycount?: number;
  globalPlaycount?: number;
  globalListeners?: number;
  bio?: string;
  tags?: string[];
  rndPosition?: number;
  rndPlaycount?: number;
}

export enum EmbedSize {
  Default = 'default',
  Small = 'small',
  Large = 'large',
}

export interface UserTrackEntry {
  userTrackId?: number;
  userId: number;
  name: string;
  artistName: string;
  playcount: number;
}

export interface UserAlbumEntry {
  id?: number;
  userId: number;
  name: string;
  artistName: string;
  playcount: number;
}

export class ArtistsService {
  private readonly lastfmRepository: ILastfmRepository;
  private readonly cache: CacheService;
  private readonly artworkService?: ArtworkService;
  private readonly colorService?: ColorService;
  private readonly prisma?: PrismaClient;

  constructor(
    lastfmRepository: ILastfmRepository,
    cache: CacheService,
    artworkService?: ArtworkService,
    colorService?: ColorService,
    prisma?: PrismaClient,
  ) {
    this.lastfmRepository = lastfmRepository;
    this.cache = cache;
    this.artworkService = artworkService;
    this.colorService = colorService;
    this.prisma = prisma;
  }

  private get db(): PrismaClient {
    return this.prisma ?? defaultPrisma;
  }

  public async getArtistInfo(
    artistName: string,
    username?: string,
  ): Promise<ArtistInfo | null> {
    const key = `artist-info:${artistName.toLowerCase()}${username ? `:${username.toLowerCase()}` : ':global'}`;
    const cached = await this.cache.get<ArtistInfo>(key);
    if (cached) {
      return cached;
    }
    const info = await this.lastfmRepository.getArtistInfo(artistName, username);
    if (info) {
      await this.cache.set(key, info, CACHE_TTL_SECONDS);
    }
    return info;
  }

  public async searchArtists(query: string): Promise<TopArtist[]> {
    return this.lastfmRepository.searchArtists(query);
  }

  /**
   * Resolves artist name from Spotify, Apple Music, or Last.fm URLs
   */
  public async resolveArtistFromLink(input: string): Promise<string | null> {
    if (!input || !input.includes('http')) return null;

    try {
      // Spotify artist link: https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb
      // No DB lookup by Spotify artist id exists (the stub that used to serve
      // this returned null unconditionally, so the branch was unreachable and
      // every Spotify artist link fell through to the Last.fm regex below).
      // Kept as an explicit no-op comment rather than a lying lookup: a
      // real spotify->artist resolver belongs in the artist repository.

      // Last.fm artist URL: https://www.last.fm/music/Radiohead
      const lastfmMatch = input.match(/last\.fm\/music\/([^/?#]+)/i);
      if (lastfmMatch && lastfmMatch[1]) {
        try {
          return decodeURIComponent(lastfmMatch[1].replace(/\+/g, ' '));
        } catch {
          return lastfmMatch[1];
        }
      }

      // Apple Music artist URL: https://music.apple.com/us/artist/radiohead/657515
      const appleMatch = input.match(/music\.apple\.com\/[a-z]{2}\/artist\/([^/]+)\/([0-9]+)/i);
      if (appleMatch && appleMatch[1]) {
        try {
          return decodeURIComponent(appleMatch[1].replace(/-/g, ' '));
        } catch {
          return appleMatch[1];
        }
      }
    } catch (e) {
      Logger.warn({ err: e }, `Failed to resolve artist from link: ${input}`);
    }

    return null;
  }

  /**
   * Batch hydrates artist images using ArtworkService or database cache
   */
  public async fillArtistImages(topArtists: TopArtist[]): Promise<TopArtist[]> {
    const missing = topArtists.filter((a) => !a.imageUrl || isPlaceholderImageUrl(a.imageUrl));
    if (missing.length === 0) return topArtists;

    if (this.artworkService) {
      await Promise.all(
        missing.map(async (artist) => {
          try {
            const url = await this.artworkService!.getArtistImageUrl(artist.name);
            if (url && !isPlaceholderImageUrl(url)) {
              artist.imageUrl = url;
            } else if (isPlaceholderImageUrl(artist.imageUrl)) {
              artist.imageUrl = undefined;
            }
          } catch {
            if (isPlaceholderImageUrl(artist.imageUrl)) {
              artist.imageUrl = undefined;
            }
          }
        }),
      );
      return topArtists;
    }

    try {
      const names = missing.map((m) => m.name);
      const rows = await this.db.artist.findMany({
        where: {
          name: { in: names, mode: 'insensitive' },
        },
        select: {
          name: true,
          imageUrl: true,
          spotifyImageUrl: true,
          deezerImageUrl: true,
        },
      });

      const map = new Map<string, string>();
      for (const r of rows) {
        const cover = r.spotifyImageUrl ?? r.deezerImageUrl ?? r.imageUrl;
        if (cover && !isPlaceholderImageUrl(cover)) map.set(r.name.toLowerCase(), cover);
      }

      for (const a of topArtists) {
        if (!a.imageUrl || isPlaceholderImageUrl(a.imageUrl)) {
          const found = map.get(a.name.toLowerCase());
          if (found) a.imageUrl = found;
          else a.imageUrl = undefined;
        }
      }
    } catch (err) {
      // CORRECT-AS-IS: artwork is decoration. A cover is looked up from four
      // providers and "we could not find one" is already the honest rendering,
      // so an unreachable `artist` table costs a missing image and nothing the
      // user would read as a fact about their listening. Raising here would
      // blank a whole leaderboard because one thumbnail query died.
      //
      // The one thing worth adding is that this is a WRITE-shaped read: the
      // catch drops the cached cover for EVERY artist in the batch, not just the
      // one that failed, because the fallback above sets `imageUrl = undefined`
      // for each. That is why the two branches differ - a failed `getArtistImageUrl`
      // only clears a placeholder, whereas reaching here clears a real cached
      // URL too - and why the log line is at WARN. A dropped connection costs
      // every cover on the card until the next successful pass re-fills them.
      Logger.warn(
        { err: (err as Error)?.message ?? String(err) },
        'Failed to read cached artist covers; the batch will re-resolve covers from providers',
      );
    }

    return topArtists;
  }

  /**
   * Fetches user's all-time top artists with optional 10-minute caching
   */
  public async getUserAllTimeTopArtists(userId: number, useCache: boolean = false): Promise<TopArtist[]> {
    const cacheKey = `user-${userId}-topartists-alltime`;
    if (useCache) {
      const cached = await this.cache.get<TopArtist[]>(cacheKey);
      if (cached) return cached;
    }

    const rows = await orDatabaseUnavailable(
      'artistsService.getUserAllTimeTopArtists:userPlaysByArtist',
      () =>
        this.db.$queryRawUnsafe<Array<{ artist_name: string; playcount: bigint }>>(`
        SELECT artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1
        GROUP BY artist_name
        ORDER BY playcount DESC
        LIMIT 1000
      `, userId),
    );

    const result: TopArtist[] = rows.map((r) => ({
      name: r.artist_name,
      playcount: Number(r.playcount),
    }));

    if (result.length > 100) {
      await this.cache.set(cacheKey, result, 600);
    }

    return result;
  }

  /**
   * Formats taste comparison description header
   */
  public static description(
    mainUserArtists: TasteItem[],
    matchedArtists: TasteItem[],
    timeDescription: string = 'overall',
  ): string {
    const total = mainUserArtists.length;
    const matched = matchedArtists.length;
    const percentage = total > 0 ? ((matched / total) * 100).toFixed(1) : '0.0';
    return `Matched **${matched}** of **${total.toLocaleString('en-US')}** artists (${percentage}%) for ${timeDescription}.`;
  }

  public async getArtistForId(artistId: number): Promise<{ id: number; name: string } | null> {
    // `null` here means "no such artist". A query that failed used to return it
    // too, and the caller rendered that as an unknown artist - the same lie as
    // a wrong id, so the raise is the point.
    const a = await orDatabaseUnavailable('artistsService.getArtistForId:artist', () =>
      this.db.artist.findUnique({
        where: { artistId },
        select: { artistId: true, name: true },
      }),
    );
    return a ? { id: a.artistId, name: a.name } : null;
  }
  public async getArtistFromDatabase(artistName: string, _redirectsEnabled: boolean = true): Promise<{ id: number; name: string } | null> {
    if (!artistName) return null;
    const a = await orDatabaseUnavailable('artistsService.getArtistFromDatabase:artist', () =>
      this.db.artist.findFirst({
        where: { name: { equals: artistName, mode: 'insensitive' } },
        select: { artistId: true, name: true },
      }),
    );
    return a ? { id: a.artistId, name: a.name } : null;
  }

  public async getTopTracksForArtist(userId: number, artistName: string): Promise<UserTrackEntry[]> {
    // `artistTrackSlashCommands` renders an empty list as "No tracks found for
    // artist X", so swallowing a failure here told the user a falsehood.
    const rows = await orDatabaseUnavailable('artistsService.getTopTracksForArtist:userTracksByArtist', () =>
      this.db.$queryRawUnsafe<Array<{ track_name: string; artist_name: string; playcount: bigint }>>(`
        SELECT track_name, artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND LOWER(artist_name) = LOWER($2) AND track_name IS NOT NULL
        GROUP BY track_name, artist_name
        ORDER BY playcount DESC
        LIMIT 50
      `, userId, artistName),
    );

    return rows.map((r) => ({
      userId,
      name: r.track_name,
      artistName: r.artist_name,
      playcount: Number(r.playcount),
    }));
  }

  public async getTopAlbumsForArtist(userId: number, artistName: string): Promise<Array<{ name: string; artistName: string; playcount: number }>> {
    const rows = await orDatabaseUnavailable('artistsService.getTopAlbumsForArtist:userAlbumsByArtist', () =>
      this.db.$queryRawUnsafe<Array<{ album_name: string; artist_name: string; playcount: bigint }>>(`
        SELECT album_name, artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND LOWER(artist_name) = LOWER($2) AND album_name IS NOT NULL AND album_name != ''
        GROUP BY album_name, artist_name
        ORDER BY playcount DESC
        LIMIT 50
      `, userId, artistName),
    );

    return rows.map((r) => ({
      name: r.album_name,
      artistName: r.artist_name,
      playcount: Number(r.playcount),
    }));
  }

  public async getTopAlbumsForArtistGlobal(artistName: string, limit: number = 10): Promise<Array<{ name: string; artistName: string; playcount: number }>> {
    const rows = await orDatabaseUnavailable('artistsService.getTopAlbumsForArtistGlobal:globalAlbumsByArtist', () =>
      this.db.$queryRawUnsafe<Array<{ album_name: string; artist_name: string; playcount: bigint }>>(`
        SELECT album_name, artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE LOWER(artist_name) = LOWER($1) AND album_name IS NOT NULL AND album_name != ''
        GROUP BY album_name, artist_name
        ORDER BY playcount DESC
        LIMIT $2
      `, artistName, limit),
    );

    return rows.map((r) => ({
      name: r.album_name,
      artistName: r.artist_name,
      playcount: Number(r.playcount),
    }));
  }

  public async getTopTracksForArtistGlobal(artistName: string, limit: number = 10): Promise<Array<{ name: string; artistName: string; playcount: number }>> {
    const rows = await orDatabaseUnavailable('artistsService.getTopTracksForArtistGlobal:globalTracksByArtist', () =>
      this.db.$queryRawUnsafe<Array<{ track_name: string; artist_name: string; playcount: bigint }>>(`
        SELECT track_name, artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE LOWER(artist_name) = LOWER($1) AND track_name IS NOT NULL AND track_name != ''
        GROUP BY track_name, artist_name
        ORDER BY playcount DESC
        LIMIT $2
      `, artistName, limit),
    );

    return rows.map((r) => ({
      name: r.track_name,
      artistName: r.artist_name,
      playcount: Number(r.playcount),
    }));
  }

  public async getIndexedAlbumCoversForArtist(artistName: string, limit: number = 25): Promise<string[]> {
    try {
      const rows = await this.db.$queryRawUnsafe<Array<{ cover: string }>>(`
        SELECT DISTINCT COALESCE(al.deezer_image_url, al.spotify_image_url, al.image_url) AS cover
        FROM albums al
        JOIN artists ar ON ar.artist_id = al.artist_id
        WHERE LOWER(ar.name) = LOWER($1)
          AND (al.deezer_image_url IS NOT NULL OR al.spotify_image_url IS NOT NULL OR (al.image_url IS NOT NULL AND al.image_url NOT LIKE '%2a96cbd8b46e442fc41c2b86b821562f%'))
        LIMIT $2
      `, artistName, limit);
      return rows.map((r) => r.cover).filter(Boolean);
    } catch {
      // CORRECT-AS-IS: cover URLs for a collage, nothing more. Both callers
      // (`topBuilders`, `whoKnowsImageBuilder`) already wrap this in their own
      // try/catch and fall through to the next source, so a raise would change
      // no behaviour but would log a failed DB read on every mosaic render.
      return [];
    }
  }
  /**
   * Autocomplete: Recently scrobbled artists in last 2 days
   */
  public async getLatestArtists(discordUserId: string, cacheEnabled: boolean = true): Promise<string[]> {
    const cacheKey = `user-recent-artists-${discordUserId}`;
    if (cacheEnabled) {
      const cached = await this.cache.get<string[]>(cacheKey);
      if (cached) return cached;
    }

    try {
      const user = await this.db.user.findFirst({
        where: { discordUserId: BigInt(discordUserId) },
        select: { userId: true },
      });
      if (!user) return [];

      const cutoff = new Date(Date.now() - 2 * 24 * 3600 * 1000);
      const plays = await this.db.userPlay.findMany({
        where: {
          userId: user.userId,
          timePlayed: { gte: cutoff },
        },
        orderBy: { timePlayed: 'desc' },
        select: { artistName: true },
        take: 200,
      });

      const artists = Array.from(new Set(plays.map((p) => p.artistName)));
      await this.cache.set(cacheKey, artists, 30);
      return artists;
    } catch {
      // CORRECT-AS-IS: this is an autocomplete SUGGESTION list, not a statistic.
      // Nothing here claims a number to the user - the worst case of a failure
      // is a dropdown with nothing in it, which makes no assertion the user can
      // be misled by. Raising would be worse than useless here:
      // `interactionHandler.handleAutocomplete` wraps every responder in
      // `.catch(() => undefined)`, so the raise would be swallowed at the top
      // anyway while `Logger.error` fired ONCE PER KEYSTROKE during an outage.
      return [];
    }
  }

  /**
   * Autocomplete: Top artists in last 20 days
   */
  public async getRecentTopArtists(
    discordUserId: string,
    cacheEnabled: boolean = true,
    daysToGoBack: number = 20,
  ): Promise<TopArtist[]> {
    const cacheKey = `user-recent-top-artists-${discordUserId}`;
    if (cacheEnabled) {
      const cached = await this.cache.get<TopArtist[]>(cacheKey);
      if (cached) return cached;
    }

    try {
      const user = await this.db.user.findFirst({
        where: { discordUserId: BigInt(discordUserId) },
        select: { userId: true },
      });
      if (!user) return [];

      const cutoff = new Date(Date.now() - daysToGoBack * 24 * 3600 * 1000);
      const rows = await this.db.$queryRawUnsafe<Array<{ artist_name: string; playcount: bigint }>>(`
        SELECT artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND time_played >= $2
        GROUP BY artist_name
        ORDER BY playcount DESC
        LIMIT 25
      `, user.userId, cutoff);

      const artists = rows.map((r) => ({
        name: r.artist_name,
        playcount: Number(r.playcount),
      }));

      await this.cache.set(cacheKey, artists, 120);
      return artists;
    } catch {
      // CORRECT-AS-IS: as `getLatestArtists` - a suggestion dropdown, no claim.
      return [];
    }
  }

  /**
   * Autocomplete: Fuzzy search through artist catalog
   */
  public async searchThroughArtists(searchValue: string): Promise<Array<{ name: string; popularity?: number }>> {
    if (!searchValue || searchValue.trim().length === 0) return [];
    try {
      const rows = await this.db.artist.findMany({
        where: {
          name: { contains: searchValue.trim(), mode: 'insensitive' },
        },
        take: 25,
        select: { name: true },
      });
      return rows.map((r) => ({ name: r.name }));
    } catch {
      // CORRECT-AS-IS: as `getLatestArtists` - a suggestion dropdown, no claim.
      return [];
    }
  }

  /**
   * Resolves prominent accent color for artist
   */
  public async getArtistAccentColorAsync(
    artistImageUrl?: string | null,
    _artistId?: number | null,
    _artistName?: string | null,
  ): Promise<number> {
    if (artistImageUrl) {
      try {
        const cs = this.colorService ?? container.resolve(ColorService);
        return cs.getColorFromImageUrl(artistImageUrl);
      } catch {
        return DiscordConstants.LastFmColorRed;
      }
    }

    return DiscordConstants.LastFmColorRed;
  }

  /**
   * Master artist search pipeline matching fmbot SearchArtist cascade
   */
  public async searchArtist(
    searchValue: string | null | undefined,
    user: User,
    _guildId?: string | null,
    referencedMusic?: ReferencedMusic | null,
  ): Promise<ArtistSearchResult | null> {
    let searchArtist = '';
    const trimmed = (searchValue ?? '').trim();

    // 1) Referenced music fallback if reply context
    if (!trimmed && referencedMusic?.artist) {
      searchArtist = referencedMusic.artist;
    } else if (trimmed) {
      // 2) Check if input is a URL
      const fromLink = await this.resolveArtistFromLink(trimmed);
      if (fromLink) {
        searchArtist = fromLink;
      } else if (trimmed.toLowerCase() === 'random' || trimmed.toLowerCase() === 'rnd') {
        const topArtists = await this.getUserAllTimeTopArtists(user.userId, true);
        if (topArtists.length > 0) {
          const rnd = Math.floor(Math.random() * topArtists.length);
          const picked = topArtists[rnd]!;
          return {
            artistName: picked.name,
            userPlaycount: picked.playcount,
            rndPosition: rnd + 1,
            rndPlaycount: picked.playcount,
          };
        }
        const topArtistsLfm = await this.lastfmRepository.getTopArtists(user.userNameLastFm, undefined as never, 100);
        if (topArtistsLfm.length > 0) {
          const rnd = Math.floor(Math.random() * topArtistsLfm.length);
          const picked = topArtistsLfm[rnd]!;
          searchArtist = picked.name;
        }
      } else {
        searchArtist = trimmed;
      }
    } else {
      // 3) Fallback to user's currently playing or last played track
      const recent = await this.lastfmRepository.getUserRecentTracksWithMetadata(
        user.userNameLastFm,
        1,
        1,
        undefined,
        user.sessionKey,
      );
      const latest = recent.tracks[0];
      if (!latest) {
        return null;
      }
      searchArtist = latest.artistName;
    }

    const info = await this.getArtistInfo(searchArtist, user.userNameLastFm);
    if (info) {
      const artUrl = (await this.artworkService?.getArtistImageUrl(info.name)) ?? (info.imageUrl && !isPlaceholderImageUrl(info.imageUrl) ? info.imageUrl : undefined);
      return {
        artistName: info.name,
        artistUrl: info.url,
        imageUrl: artUrl,
        userPlaycount: info.userPlayCount,
        globalPlaycount: info.playCount,
        globalListeners: info.listeners,
        bio: info.summary,
        tags: info.tags,
      };
    }

    // Try search fallback if exact artist info failed
    const searchResults = await this.searchArtists(searchArtist);
    if (searchResults.length > 0) {
      const fallbackName = searchResults[0]!.name;
      const fallbackInfo = await this.getArtistInfo(fallbackName, user.userNameLastFm);
      if (fallbackInfo) {
        const artUrl = (await this.artworkService?.getArtistImageUrl(fallbackInfo.name)) ?? (fallbackInfo.imageUrl && !isPlaceholderImageUrl(fallbackInfo.imageUrl) ? fallbackInfo.imageUrl : undefined);
        return {
          artistName: fallbackInfo.name,
          artistUrl: fallbackInfo.url,
          imageUrl: artUrl,
          userPlaycount: fallbackInfo.userPlayCount,
          globalPlaycount: fallbackInfo.playCount,
          globalListeners: fallbackInfo.listeners,
          bio: fallbackInfo.summary,
          tags: fallbackInfo.tags,
        };
      }
      return {
        artistName: fallbackName,
      };
    }

    return {
      artistName: searchArtist,
    };
  }
}
