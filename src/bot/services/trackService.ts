import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { IArtistRepository } from '@domain/interfaces/iartistRepository';
import type { ITrackRepository } from '@domain/interfaces/itrackRepository';
import type { IWhoKnowsRepository } from '@domain/interfaces/iwhoKnowsRepository';
import type { User } from '@domain/interfaces/iuserRepository';
import type { TrackInfo } from '@domain/models/musicInfo';
import type { TopTrack } from '@domain/models/topLists';
import { ArtworkService, isPlaceholderImageUrl } from './artworkService';
import { CacheService } from './cacheService';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import { Logger } from '@domain/logger';
import type { PrismaClient } from '@prisma/client';

const CACHE_TTL_SECONDS = 1800;

export interface TrackSearchResult {
  trackName: string;
  artistName: string;
  albumName?: string;
  trackUrl?: string;
  artistUrl?: string;
  albumUrl?: string;
  coverUrl?: string;
  trackId?: number;
  durationSeconds?: number;
  userPlaycount?: number;
  globalPlaycount?: number;
  globalListeners?: number;
  summary?: string;
  tags?: string[];
  serverPlaycount?: number;
  serverListeners?: number;
  isLoved?: boolean;
  lastMonthPlays?: number;
}

export class TrackService {
  constructor(
    private readonly lastfmRepository: ILastfmRepository,
    private readonly artistRepository: IArtistRepository,
    private readonly trackRepository: ITrackRepository,
    private readonly whoKnowsRepository: IWhoKnowsRepository,
    private readonly artworkService: ArtworkService,
    private readonly cache: CacheService,
    private readonly prisma?: PrismaClient,
  ) {}

  public async getTrackInfo(
    trackName: string,
    artistName: string,
    username?: string,
  ): Promise<TrackInfo | null> {
    const key = `track-info:${artistName.toLowerCase()}:${trackName.toLowerCase()}${
      username ? `:${username.toLowerCase()}` : ':global'
    }`;
    const cached = await this.cache.get<TrackInfo>(key);
    if (cached) {
      return cached;
    }
    const info = await this.lastfmRepository.getTrackInfo(trackName, artistName, username);
    if (info) {
      await this.cache.set(key, info, CACHE_TTL_SECONDS);
    }
    return info;
  }

  public async searchTracks(query: string): Promise<TopTrack[]> {
    return this.lastfmRepository.searchTracks(query);
  }

  public async searchTrack(
    searchValue: string | null | undefined,
    user: User,
    guildId?: string | null,
  ): Promise<TrackSearchResult | null> {
    let searchArtist = '';
    let searchTrack = '';

    const trimmed = (searchValue ?? '').trim();

    if (!trimmed) {
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
      searchTrack = latest.name;
    } else if (trimmed.toLowerCase() === 'random') {
      const topTracks = await this.lastfmRepository.getTopTracks(
        user.userNameLastFm,
        undefined as never,
        100,
      );
      if (topTracks.length === 0) {
        return null;
      }
      const picked = topTracks[Math.floor(Math.random() * topTracks.length)]!;
      searchArtist = picked.artistName;
      searchTrack = picked.name;
    } else if (trimmed.includes(' | ')) {
      const parts = trimmed.split(' | ');
      searchArtist = parts[0]!.trim();
      searchTrack = parts[1]!.trim();
    } else if (trimmed.toLowerCase().includes(' by ')) {
      const parts = trimmed.split(/ by /i);
      searchTrack = parts[0]!.trim();
      searchArtist = parts[1]!.trim();
    } else {
      const results = await this.lastfmRepository.searchTracks(trimmed);
      if (results.length > 0) {
        searchArtist = results[0]!.artistName;
        searchTrack = results[0]!.name;
      } else {
        searchArtist = 'Unknown Artist';
        searchTrack = trimmed;
      }
    }

    const info = await this.getTrackInfo(searchTrack, searchArtist, user.userNameLastFm);

    let coverUrl: string | undefined;
    const resolvedCover = await this.artworkService.getTrackCoverUrl(searchTrack, searchArtist);
    if (resolvedCover && !isPlaceholderImageUrl(resolvedCover)) {
      coverUrl = resolvedCover;
    } else if (info?.albumCoverUrl && !isPlaceholderImageUrl(info.albumCoverUrl)) {
      coverUrl = info.albumCoverUrl;
    } else if (info?.imageUrl && !isPlaceholderImageUrl(info.imageUrl)) {
      coverUrl = info.imageUrl;
    }

    let serverPlaycount: number | undefined;
    let serverListeners: number | undefined;
    let trackId: number | undefined;

    if (guildId) {
      try {
        const artist = await this.artistRepository.getArtistByName(searchArtist);
        if (artist) {
          const track = await this.trackRepository.getTrackByNameAndArtist(
            searchTrack,
            artist.artistId,
          );
          if (track) {
            trackId = track.trackId;
            const rows = await this.whoKnowsRepository.getIndexedUsersForTrack(
              guildId,
              track.trackId,
            );
            if (rows && rows.length > 0) {
              serverPlaycount = rows.reduce((acc, r) => acc + r.playcount, 0);
              serverListeners = rows.length;
            }
          }
        }
      } catch (err) {
        // CORRECT AS IS, and the WARN is the point: a swallowed server clause is
        // invisible, and a lost capability is what AGENTS.md §3.10 says deserves
        // WARN rather than DEBUG. The catch itself is the omission, which
        // `trackBuilders`' `!== undefined` guard turns into a missing line rather
        // than a fabricated zero.
        Logger.warn(
          { err: (err as Error)?.message ?? String(err), userId: user.userId, guildId },
          'Failed to read guild server stats for a track; the card will omit the server clause',
        );
      }
    }

    const finalArtist = info?.artistName ?? searchArtist;
    const finalTrack = info?.name ?? searchTrack;

    const lastMonthPlays = await this.getLastMonthPlays(user.userId, finalTrack, finalArtist);

    return {
      trackName: finalTrack,
      artistName: finalArtist,
      albumName: info?.albumName,
      trackUrl:
        info?.url ??
        `https://www.last.fm/music/${encodeURIComponent(finalArtist)}/_/${encodeURIComponent(
          finalTrack,
        )}`,
      artistUrl: `https://www.last.fm/music/${encodeURIComponent(finalArtist)}`,
      albumUrl: info?.albumName
        ? `https://www.last.fm/music/${encodeURIComponent(finalArtist)}/${encodeURIComponent(
            info.albumName,
          )}`
        : undefined,
      coverUrl,
      trackId,
      durationSeconds: info?.durationSeconds,
      userPlaycount: info?.userPlayCount ?? 0,
      globalPlaycount: info?.playCount,
      globalListeners: info?.listeners,
      summary: info?.summary,
      tags: info?.tags,
      serverPlaycount,
      serverListeners,
      isLoved: info?.userLoved,
      lastMonthPlays,
    };
  }

  public async getLastMonthPlays(userId: number, trackName: string, artistName: string): Promise<number> {
    if (!this.prisma) return 0;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000);
    try {
      return await this.prisma.userPlay.count({
        where: {
          userId,
          artistName: { equals: artistName, mode: 'insensitive' },
          trackName: { equals: trackName, mode: 'insensitive' },
          timePlayed: { gte: thirtyDaysAgo },
        },
      });
    } catch (err) {
      // This feeds `lastMonthPlays` in the track footer. Returning 0 here made a
      // database outage render as "0 plays in the last month" for a user who may
      // well have played the track, and unlike an absent list a 0 is a claim.
      // A member with genuinely no plays in 30 days still returns 0 - that is a
      // real answer from a query that ran, and it is kept.
      Logger.error(
        { err: (err as Error)?.message ?? String(err) },
        'Database unavailable while counting last-month plays; refusing to report it as 0',
      );
      throw new SourceUnavailableError('trackService.getLastMonthPlays', err, 'Database unavailable');
    }
  }

  // Scrobble reference storage matching C# StoreScrobbleReference
  private readonly scrobbleReferences = new Map<string, { artist: string; track: string; album?: string; timePlayed?: Date }>();

  public storeScrobbleReference(artistName: string, trackName: string, albumName?: string, timePlayed?: Date): string {
    const id = Math.random().toString(36).substring(2, 10);
    this.scrobbleReferences.set(`sbref-${id}`, {
      artist: artistName,
      track: trackName,
      album: albumName,
      timePlayed,
    });
    return id;
  }

  public getScrobbleReference(id: string): { artist: string; track: string; album?: string; timePlayed?: Date } | undefined {
    return this.scrobbleReferences.get(`sbref-${id}`);
  }

  // Deduplication cache for scrobbles
  private readonly scrobbledTracksCache = new Set<string>();

  public markTrackAsScrobbled(userId: number, artistName: string, trackName: string, timePlayed?: Date): void {
    const key = `${userId}:${artistName.toLowerCase()}:${trackName.toLowerCase()}:${timePlayed ? Math.floor(timePlayed.getTime() / 60000) : ''}`;
    this.scrobbledTracksCache.add(key);
    if (this.scrobbledTracksCache.size > 10000) {
      const oldest = this.scrobbledTracksCache.values().next().value;
      if (oldest) this.scrobbledTracksCache.delete(oldest);
    }
  }

  public isTrackScrobbled(userId: number, artistName: string, trackName: string, timePlayed?: Date): boolean {
    const key = `${userId}:${artistName.toLowerCase()}:${trackName.toLowerCase()}:${timePlayed ? Math.floor(timePlayed.getTime() / 60000) : ''}`;
    return this.scrobbledTracksCache.has(key);
  }

  public getTrackFromLink(description: string): { artistName?: string; trackName?: string } | null {
    if (!description || !description.includes('http')) return null;

    // Spotify track link: https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp
    const spotifyMatch = description.match(/spotify\.com\/(?:intl-[a-zA-Z-]+\/)?track\/([a-zA-Z0-9]+)/i);
    if (spotifyMatch && spotifyMatch[1]) {
      return { trackName: spotifyMatch[1] };
    }

    // Last.fm track URL: https://www.last.fm/music/Radiohead/_/Karma+Police
    const lastfmMatch = description.match(/last\.fm\/music\/([^/?#]+)\/_\/([^/?#]+)/i);
    if (lastfmMatch && lastfmMatch[1] && lastfmMatch[2]) {
      try {
        return {
          artistName: decodeURIComponent(lastfmMatch[1].replace(/\+/g, ' ')),
          trackName: decodeURIComponent(lastfmMatch[2].replace(/\+/g, ' ')),
        };
      } catch {
        return { artistName: lastfmMatch[1], trackName: lastfmMatch[2] };
      }
    }

    return null;
  }

  /**
   * Parses bold-delimited track and artist strings like "**Track** **by** **Artist**"
   */
  public static parseBoldDelimitedTrackAndArtist(description: string): { track: string; artist: string } | null {
    const byDelimiter = ' **by** ';
    const delimiterIndex = description.indexOf(byDelimiter);
    if (delimiterIndex !== -1) {
      const unbold = (s: string) => {
        const split = s.split('**');
        return split.length === 3 ? split[1] : null;
      };

      const left = unbold(description.substring(0, delimiterIndex));
      const right = unbold(description.substring(delimiterIndex + byDelimiter.length));
      if (left && right) {
        return { track: left, artist: right };
      }
    }
    return null;
  }

  /**
   * User's all-time top tracks with optional 10-minute caching
   *
   * CORRECT AS IS TODAY, AND THE REASON IS DEADNESS, NOT SAFETY. Verified: this
   * method has no production caller. A whole-repo grep for
   * `getUserAllTimeTopTracks` returns this definition plus `trackService.test.ts`
   * and `trackService.db.test.ts`; nothing in `startup.ts`, no builder, no
   * command, no interaction reaches it. So `catch { return [] }` cannot put a
   * wrong number in front of anyone right now, and `[]` here is indistinguishable
   * from "this user has never pressed play" to every caller that exists.
   *
   * THAT IS THE TRAP, and it is why this comment is long rather than absent. The
   * moment a command wires this up it becomes exactly the bug the phase was
   * opened for: `.toptracks` would render an empty leaderboard for a user with
   * 40 million indexed plays, and every other number on the card would stay
   * real, which is the shape a user cannot distrust. The sibling method
   * `artistsService.getUserAllTimeTopArtists` - the same query on `user_plays`,
   * the same `[]` - was fixed for precisely this reason and raises
   * `SourceUnavailableError` via `orDatabaseUnavailable`.
   *
   * NOT FIXED HERE ON PURPOSE, and the reason is the blast radius, not the
   * principle: there is no user-visible behaviour to change, so a raise would
   * alter nothing observable while rewriting four pinned tests. The rule to
   * apply when this is wired up is the one `artistsService` already follows -
   * wrap the query in `orDatabaseUnavailable` and keep the honest empty for a
   * query that RAN and matched nothing. `getLastMonthPlays` in this same file
   * shows that shape, and its comment explains why the empty must survive.
   */
  public async getUserAllTimeTopTracks(userId: number, useCache: boolean = false): Promise<TopTrack[]> {
    const cacheKey = `user-${userId}-toptracks-alltime`;
    if (useCache) {
      const cached = await this.cache.get<TopTrack[]>(cacheKey);
      if (cached) return cached;
    }

    try {
      if (!this.prisma) return [];
      const rows = await this.prisma.$queryRawUnsafe<Array<{
        track_name: string;
        artist_name: string;
        playcount: bigint;
      }>>(`
        SELECT track_name, artist_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND track_name IS NOT NULL AND track_name != ''
        GROUP BY track_name, artist_name
        ORDER BY playcount DESC
        LIMIT 1000
      `, userId);

      const tracks: TopTrack[] = rows.map((r) => ({
        name: r.track_name,
        artistName: r.artist_name,
        playcount: Number(r.playcount),
      }));

      if (tracks.length > 100) {
        await this.cache.set(cacheKey, tracks, 600);
      }

      return tracks;
    } catch {
      // See the method doc: correct as is because nothing calls this yet, and
      // `[]` is a lie the moment someone does. The fix, when that happens, is
      // `orDatabaseUnavailable` exactly as in artistsService.
      return [];
    }
  }

  public async getArtistUserTracks(userId: number, artistName: string): Promise<Array<{ name: string; playcount: number }>> {
    try {
      if (!this.prisma) return [];
      const rows = await this.prisma.$queryRawUnsafe<Array<{
        track_name: string;
        playcount: bigint;
      }>>(`
        SELECT track_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND LOWER(artist_name) = LOWER($2) AND track_name IS NOT NULL
        GROUP BY track_name
        ORDER BY playcount DESC
        LIMIT 50
      `, userId, artistName);

      return rows.map((r) => ({
        name: r.track_name,
        playcount: Number(r.playcount),
      }));
    } catch {
      // CORRECT AS IS for the same reason as `getUserAllTimeTopTracks` above and
      // verified the same way: no production caller reaches this method, only the
      // two test files. Unlike that one, this query has no sibling that was
      // fixed, so if it is ever wired to an "artist top tracks" card the empty
      // list is what the user would read as "you have no plays for this artist"
      // - which is why the note belongs here rather than in a shared helper.
      return [];
    }
  }

  /**
   * Autocomplete: Recent tracks in last 2 days
   */
  public async getLatestTracks(
    discordUserId: string,
    cacheEnabled: boolean = true,
  ): Promise<Array<{ artistName: string; trackName: string }>> {
    const cacheKey = `user-recent-tracks-${discordUserId}`;
    if (cacheEnabled) {
      const cached = await this.cache.get<Array<{ artistName: string; trackName: string }>>(cacheKey);
      if (cached) return cached;
    }

    try {
      if (!this.prisma) return [];
      const user = await this.prisma.user.findFirst({
        where: { discordUserId: BigInt(discordUserId) },
        select: { userId: true },
      });
      if (!user) return [];

      const cutoff = new Date(Date.now() - 2 * 24 * 3600 * 1000);
      const plays = await this.prisma.userPlay.findMany({
        where: {
          userId: user.userId,
          timePlayed: { gte: cutoff },
          trackName: { not: null },
        },
        orderBy: { timePlayed: 'desc' },
        select: { artistName: true, trackName: true },
        take: 200,
      });

      const unique = new Map<string, { artistName: string; trackName: string }>();
      for (const p of plays) {
        if (p.trackName) {
          const key = `${p.artistName.toLowerCase()}|${p.trackName.toLowerCase()}`;
          if (!unique.has(key)) {
            unique.set(key, { artistName: p.artistName, trackName: p.trackName });
          }
        }
      }

      const result = Array.from(unique.values()).slice(0, 25);
      await this.cache.set(cacheKey, result, 30);
      return result;
    } catch {
      // CORRECT AS IS, and the twin of the decision already recorded for
      // `artistsService.getLatestArtists`: this is an AUTOCOMPLETE SUGGESTION
      // list, not a statistic. Nothing here claims a number to the user - the
      // worst case of a failure is a dropdown with nothing in it, which makes no
      // assertion anyone can be misled by. Also verified uncalled in production
      // (only the two test files reference it).
      //
      // Raising would be actively worse here, and the reason is specific to
      // autocomplete: `interactionHandler.handleAutocomplete` wraps every
      // responder in `.catch(() => undefined)`, so the raise would be swallowed
      // at the top anyway while the `Logger.error` beneath it fired ONCE PER
      // KEYSTROKE for the whole duration of a database outage.
      return [];
    }
  }

  /**
   * Autocomplete: Top tracks in last 20 days
   */
  public async getRecentTopTracks(
    discordUserId: string,
    cacheEnabled: boolean = true,
  ): Promise<TopTrack[]> {
    const cacheKey = `user-recent-top-tracks-${discordUserId}`;
    if (cacheEnabled) {
      const cached = await this.cache.get<TopTrack[]>(cacheKey);
      if (cached) return cached;
    }

    try {
      if (!this.prisma) return [];
      const user = await this.prisma.user.findFirst({
        where: { discordUserId: BigInt(discordUserId) },
        select: { userId: true },
      });
      if (!user) return [];

      const cutoff = new Date(Date.now() - 20 * 24 * 3600 * 1000);
      const rows = await this.prisma.$queryRawUnsafe<Array<{
        artist_name: string;
        track_name: string;
        playcount: bigint;
      }>>(`
        SELECT artist_name, track_name, COUNT(*)::bigint AS playcount
        FROM user_plays
        WHERE user_id = $1 AND time_played >= $2 AND track_name IS NOT NULL AND track_name != ''
        GROUP BY artist_name, track_name
        ORDER BY playcount DESC
        LIMIT 25
      `, user.userId, cutoff);

      const result: TopTrack[] = rows.map((r) => ({
        name: r.track_name,
        artistName: r.artist_name,
        playcount: Number(r.playcount),
      }));

      await this.cache.set(cacheKey, result, 120);
      return result;
    } catch {
      // CORRECT AS IS, exactly as `getLatestTracks` above and as the
      // `artistsService.getRecentTopArtists` twin: an autocomplete suggestion
      // list makes no claim, an empty dropdown is not a statistic, and
      // `handleAutocomplete` would swallow a raise at the top while logging once
      // per keystroke. Also verified uncalled in production.
      //
      // The playcounts this query computes are NOT the reason to raise, and that
      // is worth being explicit about: they never leave this method through the
      // autocomplete path. `getRecentTopTracksAutoComplete` maps every row down
      // to `{ artistName, trackName }` and drops the number entirely, so the
      // only thing a caller can render is a list of names.
      return [];
    }
  }

  public async getRecentTopTracksAutoComplete(
    discordUserId: string,
    cacheEnabled: boolean = true,
  ): Promise<Array<{ artistName: string; trackName: string }>> {
    const top = await this.getRecentTopTracks(discordUserId, cacheEnabled);
    return top.map((t) => ({ artistName: t.artistName, trackName: t.name }));
  }

  /**
   * Autocomplete: Search through track catalog
   */
  public async searchThroughTracks(
    searchValue: string,
  ): Promise<Array<{ artistName: string; trackName: string; popularity?: number }>> {
    if (!searchValue || searchValue.trim().length === 0) return [];
    try {
      if (!this.prisma) return [];
      const rows = await this.prisma.track.findMany({
        where: {
          name: { contains: searchValue.trim(), mode: 'insensitive' },
        },
        take: 25,
        select: { name: true, artist: { select: { name: true } } },
      });

      return rows.map((r) => ({
        artistName: r.artist.name,
        trackName: r.name,
      }));
    } catch {
      // CORRECT AS IS, third autocomplete twin (`artistsService.searchThroughArtists`
      // is the fourth): a catalogue name search feeds a dropdown, asserts
      // nothing about any user, and has no production caller. Same reasoning as
      // the two above, including why a raise would be swallowed at the top while
      // logging per keystroke.
      return [];
    }
  }
}
