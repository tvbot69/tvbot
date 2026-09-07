import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import type { IArtistRepository } from '@domain/interfaces/iartistRepository';
import type { ITrackRepository } from '@domain/interfaces/itrackRepository';
import type { IWhoKnowsRepository } from '@domain/interfaces/iwhoKnowsRepository';
import type { User } from '@domain/interfaces/iuserRepository';
import type { TrackInfo } from '@domain/models/musicInfo';
import type { TopTrack } from '@domain/models/topLists';
import { ArtworkService, isPlaceholderImageUrl } from './artworkService';
import { CacheService } from './cacheService';
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
      } catch {
        // ignore server stats lookup errors
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
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000);
      const count = await this.prisma.userPlay.count({
        where: {
          userId,
          artistName: { equals: artistName, mode: 'insensitive' },
          trackName: { equals: trackName, mode: 'insensitive' },
          timePlayed: { gte: thirtyDaysAgo },
        },
      });
      return count;
    } catch {
      return 0;
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
      return [];
    }
  }

  public async getAverageTrackAudioFeaturesForTopTracks(topTracks: TopTrack[]): Promise<AudioFeaturesOverview> {
    if (!this.prisma || !topTracks || topTracks.length === 0) {
      return { total: 0, average: { danceability: 0, energy: 0, valence: 0, tempo: 0, acousticness: 0 } };
    }

    try {
      const trackNames = topTracks.map((t) => t.name);
      const rows = await this.prisma.$queryRawUnsafe<Array<{
        danceability: number | null;
        energy: number | null;
        valence: number | null;
        tempo: number | null;
        acousticness: number | null;
      }>>(`
        SELECT danceability, energy, valence, tempo, acousticness
        FROM tracks
        WHERE name = ANY($1::text[]) AND valence IS NOT NULL
      `, trackNames).catch(() => []);

      if (rows.length === 0) {
        return { total: 0, average: { danceability: 0, energy: 0, valence: 0, tempo: 0, acousticness: 0 } };
      }

      let sumDance = 0, sumEnergy = 0, sumValence = 0, sumTempo = 0, sumAcoustic = 0;
      for (const t of rows) {
        sumDance += t.danceability ?? 0;
        sumEnergy += t.energy ?? 0;
        sumValence += t.valence ?? 0;
        sumTempo += t.tempo ?? 0;
        sumAcoustic += t.acousticness ?? 0;
      }
      const count = rows.length;

      return {
        total: count,
        average: {
          danceability: +(sumDance / count).toFixed(3),
          energy: +(sumEnergy / count).toFixed(3),
          valence: +(sumValence / count).toFixed(3),
          tempo: Math.round(sumTempo / count),
          acousticness: +(sumAcoustic / count).toFixed(3),
        },
      };
    } catch {
      return { total: 0, average: { danceability: 0, energy: 0, valence: 0, tempo: 0, acousticness: 0 } };
    }
  }

  public audioFeatureAnalysisComparisonString(current: AudioFeaturesOverview, previous?: AudioFeaturesOverview): string {
    if (current.total === 0) return 'No audio features available.';
    const lines: string[] = [];

    const formatFeature = (label: string, curVal: number, prevVal?: number, isPercent = true) => {
      const curStr = isPercent ? `${Math.round(curVal * 100)}%` : `${curVal} BPM`;
      if (prevVal !== undefined && previous && previous.total > 0) {
        const delta = isPercent ? Math.round((curVal - prevVal) * 100) : curVal - prevVal;
        const sign = delta > 0 ? `+${delta}` : `${delta}`;
        const prevStr = isPercent ? `${Math.round(prevVal * 100)}%` : `${prevVal} BPM`;
        return `**${label}**: **${curStr}** (${sign}${isPercent ? '%' : ''} from ${prevStr})`;
      }
      return `**${label}**: **${curStr}**`;
    };

    lines.push(formatFeature('Danceability', current.average.danceability, previous?.average.danceability));
    lines.push(formatFeature('Energy', current.average.energy, previous?.average.energy));
    lines.push(formatFeature('Valence (Happiness)', current.average.valence, previous?.average.valence));
    lines.push(formatFeature('Acousticness', current.average.acousticness, previous?.average.acousticness));
    lines.push(formatFeature('Tempo', current.average.tempo, previous?.average.tempo, false));

    return lines.join('\n');
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
      return [];
    }
  }
}

export interface AudioFeaturesOverview {
  total: number;
  average: {
    danceability: number;
    energy: number;
    valence: number;
    tempo: number;
    acousticness: number;
  };
}
