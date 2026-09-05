import { inject } from 'tsyringe';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { Logger } from '@domain/logger';
import type { LastFmUser } from '@domain/models/lastFmUser';
import type {
  RecentTrack,
  RecentTrackList,
} from '@domain/models/recentTrack';
import { TimePeriod, TimePeriodToLastfmApiPeriod } from '@domain/enums/timePeriod';
import type {
  TopAlbum,
  TopArtist,
  TopTrack,
} from '@domain/models/topLists';
import type {
  AlbumInfo,
  ArtistInfo,
  TrackInfo,
} from '@domain/models/musicInfo';
import { LastfmApi } from '@lastfm/api/lastfmApi';
import type {
  RecentTracksResponseLfm,
} from '@lastfm/models/recentTracksLfm';
import type {
  TopAlbumsResponseLfm,
  TopArtistsResponseLfm,
  TopTracksResponseLfm,
} from '@lastfm/models/topListsLfm';
import type {
  AlbumInfoResponseLfm,
  ArtistInfoResponseLfm,
  TrackInfoResponseLfm,
} from '@lastfm/models/infoLfm';
import type {
  AlbumSearchResponseLfm,
  ArtistSearchResponseLfm,
  TrackSearchResponseLfm,
} from '@lastfm/models/searchLfm';
import type { UserInfoResponseLfm } from '@lastfm/models/userInfoLfm';
import { TrackConverter } from '@lastfm/converters/recentTrackConverter';
import { UserConverter } from '@lastfm/converters/userConverter';
import { TopListConverter } from '@lastfm/converters/topListConverter';
import { InfoConverter } from '@lastfm/converters/infoConverter';
import { CacheService } from '@bot/services/cacheService';

const FAILURE_DELAY_MS = [500, 2500, 5000, 10000, 25000];

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class LastFmRepository implements ILastfmRepository {
  private readonly api: LastfmApi;
  private readonly cache?: CacheService;

  constructor(
    @inject(LastfmApi) api: LastfmApi,
    @inject(CacheService) cache?: CacheService,
  ) {
    this.api = api;
    this.cache = cache;
  }

  private async callWithRetry<T>(
    context: string,
    maxRetries: number,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        Logger.warn(`Retrying ${context}, attempt ${attempt + 1}`);
        await delay(FAILURE_DELAY_MS[Math.min(attempt - 1, FAILURE_DELAY_MS.length - 1)]!);
      }
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        Logger.warn(
          { err: String(err).slice(0, 140) },
          `${context} failed (attempt ${attempt + 1}/${maxRetries + 1})`,
        );
      }
    }
    Logger.error(`${context} failed after ${maxRetries + 1} attempts`);
    void lastError;
    return null;
  }

  public async getAuthToken(): Promise<string | null> {
    try {
      const response = await this.api.callSigned<{ token: string }>('auth.gettoken');
      return response.token ?? null;
    } catch {
      return null;
    }
  }

  public async getAuthSession(
    token: string,
  ): Promise<{ name: string; key: string } | null> {
    try {
      const response = await this.api.callSigned<{
        session?: { name?: string; key?: string };
      }>('auth.getsession', { token: token });
      if (!response.session?.name || !response.session?.key) {
        return null;
      }
      return { name: response.session.name, key: response.session.key };
    } catch {
      return null;
    }
  }

  public async getUserInfo(userName: string): Promise<LastFmUser | null> {
    try {
      const response = await this.api.call<UserInfoResponseLfm>('user.getinfo', {
        user: userName,
      });
      return UserConverter.convertUserInfo(response);
    } catch {
      return null;
    }
  }

  public async getUserRecentTracks(
    userName: string,
    count: number = 10,
    page: number = 1,
    fromUnixTimestamp?: number,
    sessionKey?: string,
  ): Promise<RecentTrack[]> {
    try {
      const params: Record<string, string> = {
        user: userName,
        limit: String(count),
        page: String(page),
        ...(fromUnixTimestamp ? { from: String(fromUnixTimestamp) } : {}),
        ...(sessionKey ? { sk: sessionKey } : {}),
      };
      const response =
        sessionKey
          ? await this.api.callSigned<RecentTracksResponseLfm>(
              'user.getrecenttracks',
              params,
              'GET',
            )
          : await this.api.call<RecentTracksResponseLfm>('user.getrecenttracks', params);
      const tracks = Array.isArray(response.recenttracks.track)
        ? response.recenttracks.track
        : [];
      return tracks.map((t) => TrackConverter.convertRecentTrack(t));
    } catch (err) {
      Logger.warn(
        { err: String(err).slice(0, 120) },
        `getRecentTracks failed for ${userName}${sessionKey ? ' (with session)' : ''}`,
      );
      return [];
    }
  }

  public async getUserRecentTracksWithMetadata(
    userName: string,
    count: number = 10,
    page: number = 1,
    fromUnixTimestamp?: number,
    sessionKey?: string,
    errorRetries: number = 1,
  ): Promise<RecentTrackList> {
    const params: Record<string, string> = {
      user: userName,
      limit: String(count),
      page: String(page),
      ...(fromUnixTimestamp ? { from: String(fromUnixTimestamp) } : {}),
      ...(sessionKey ? { sk: sessionKey } : {}),
    };

    const response = await this.callWithRetry<RecentTracksResponseLfm>(
      `getRecentTracks for ${userName} page ${page}`,
      errorRetries,
      () =>
        sessionKey
          ? this.api.callSigned<RecentTracksResponseLfm>(
              'user.getrecenttracks',
              params,
              'GET',
            )
          : this.api.call<RecentTracksResponseLfm>('user.getrecenttracks', params),
    );

    if (!response?.recenttracks) {
      return { tracks: [], totalPages: 0, totalScrobbles: 0 };
    }

    const raw = Array.isArray(response.recenttracks.track)
      ? response.recenttracks.track
      : [];
    return {
      tracks: raw.map((t) => TrackConverter.convertRecentTrack(t)),
      totalPages: Number(response.recenttracks['@attr'].totalPages) || 0,
      totalScrobbles: Number(response.recenttracks['@attr'].total) || 0,
    };
  }

  public async getArtistInfo(
    artistName: string,
    username?: string,
  ): Promise<ArtistInfo | null> {
    try {
      const response = await this.api.call<ArtistInfoResponseLfm>('artist.getinfo', {
        artist: artistName,
        ...(username ? { username: username } : {}),
      });
      return InfoConverter.convertArtistInfo(response);
    } catch {
      return null;
    }
  }

  public async getAlbumInfo(
    artistName: string,
    albumName: string,
    username?: string,
  ): Promise<AlbumInfo | null> {
    try {
      const response = await this.api.call<AlbumInfoResponseLfm>('album.getinfo', {
        artist: artistName,
        album: albumName,
        ...(username ? { username: username } : {}),
      });
      return InfoConverter.convertAlbumInfo(response);
    } catch {
      return null;
    }
  }

  public async getTrackInfo(
    trackName: string,
    artistName: string,
    username?: string,
  ): Promise<TrackInfo | null> {
    try {
      const response = await this.api.call<TrackInfoResponseLfm>('track.getinfo', {
        track: trackName,
        artist: artistName,
        ...(username ? { username: username } : {}),
      });
      return InfoConverter.convertTrackInfo(response);
    } catch {
      return null;
    }
  }

  public async searchArtists(query: string): Promise<TopArtist[]> {
    try {
      const response = await this.api.call<ArtistSearchResponseLfm>('artist.search', {
        artist: query,
      });
      const matches = response.results.artistmatches?.artist ?? [];
      return (Array.isArray(matches) ? matches : [matches]).map((a) => ({
        name: a.name,
        playcount: a.listeners ? Number(a.listeners) : 0,
        mbid: a.mbid || undefined,
        url: a.url || undefined,
      }));
    } catch {
      return [];
    }
  }

  public async searchAlbums(query: string): Promise<TopAlbum[]> {
    try {
      const response = await this.api.call<AlbumSearchResponseLfm>('album.search', {
        album: query,
      });
      const matches = response.results.albummatches?.album ?? [];
      const list = Array.isArray(matches) ? matches : [matches];
      return list.map((a) => ({
        name: a.name,
        artistName: a.artist ?? '',
        playcount: 0,
        mbid: a.mbid || undefined,
        url: a.url || undefined,
      }));
    } catch {
      return [];
    }
  }

  public async searchTracks(query: string): Promise<TopTrack[]> {
    try {
      const response = await this.api.call<TrackSearchResponseLfm>('track.search', {
        track: query,
      });
      const matches = response.results.trackmatches?.track ?? [];
      const list = Array.isArray(matches) ? matches : [matches];
      return list.map((t) => ({
        name: t.name,
        artistName: t.artist ?? '',
        playcount: 0,
        mbid: t.mbid || undefined,
        url: t.url || undefined,
      }));
    } catch {
      return [];
    }
  }

  public async getUserFriends(
    userName: string,
    limit: number = 50,
    page: number = 1,
  ): Promise<LastFmUser[]> {
    try {
      const response = await this.api.call<{
        friends?: { user?: UserInfoResponseLfm['user'][] };
      }>('user.getfriends', {
        user: userName,
        limit: String(limit),
        page: String(page),
      });
      const friends = Array.isArray(response.friends?.user)
        ? response.friends?.user
        : response.friends?.user
          ? [response.friends.user]
          : [];
      return friends.map((f) =>
        UserConverter.convertUserInfo({ user: f }),
      );
    } catch {
      return [];
    }
  }

  public async getTopArtists(
    userName: string,
    period: TimePeriod = TimePeriod.AllTime,
    count: number = 10,
    page: number = 1,
    sessionKey?: string,
    from?: number,
    to?: number,
  ): Promise<TopArtist[]> {
    const isCustomOrDaily = period === TimePeriod.Daily || (from !== undefined && to !== undefined);
    if (isCustomOrDaily) {
      const fromSec = from ?? Math.floor((Date.now() - 86400000) / 1000);
      const toSec = to ?? Math.floor(Date.now() / 1000);
      const cacheKey = `lfm:weeklyartists:${userName.toLowerCase()}:${fromSec}:${toSec}:${count}`;
      if (this.cache && !sessionKey) {
        const cached = await this.cache.get<TopArtist[]>(cacheKey);
        if (cached) {
          return cached;
        }
      }

      try {
        const params: Record<string, string> = {
          user: userName,
          from: String(fromSec),
          to: String(toSec),
          limit: String(count),
          ...(sessionKey ? { sk: sessionKey } : {}),
        };
        const response = sessionKey
          ? await this.api.callSigned<any>('user.getweeklyartistchart', params, 'GET')
          : await this.api.call<any>('user.getweeklyartistchart', params);
        let result = TopListConverter.convertWeeklyArtistChart(response);
        if (count && count > 0 && result.length > count) {
          result = result.slice(0, count);
        }
        if (this.cache && !sessionKey && result.length > 0) {
          await this.cache.set(cacheKey, result, 120);
        }
        return result;
      } catch (err) {
        Logger.warn({ err: String(err).slice(0, 120) }, `getweeklyartistchart failed for ${userName}`);
        return [];
      }
    }

    const cacheKey = `lfm:topartists:${userName.toLowerCase()}:${period}:${count}:${page}`;
    if (this.cache && !sessionKey) {
      const cached = await this.cache.get<TopArtist[]>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    try {
      const params: Record<string, string> = {
        user: userName,
        period: TimePeriodToLastfmApiPeriod[period] ?? 'overall',
        limit: String(count),
        page: String(page),
        ...(sessionKey ? { sk: sessionKey } : {}),
      };
      const response = sessionKey
        ? await this.api.callSigned<TopArtistsResponseLfm>('user.gettopartists', params, 'GET')
        : await this.api.call<TopArtistsResponseLfm>('user.gettopartists', params);
      const result = TopListConverter.convertTopArtists(response);
      if (this.cache && !sessionKey && result.length > 0) {
        await this.cache.set(cacheKey, result, 120);
      }
      return result;
    } catch (err) {
      Logger.warn({ err: String(err).slice(0, 120) }, `getTopArtists failed for ${userName}`);
      return [];
    }
  }

  public async getTopAlbums(
    userName: string,
    period: TimePeriod = TimePeriod.AllTime,
    count: number = 10,
    page: number = 1,
    sessionKey?: string,
    from?: number,
    to?: number,
  ): Promise<TopAlbum[]> {
    const isCustomOrDaily = period === TimePeriod.Daily || (from !== undefined && to !== undefined);
    if (isCustomOrDaily) {
      const fromSec = from ?? Math.floor((Date.now() - 86400000) / 1000);
      const toSec = to ?? Math.floor(Date.now() / 1000);
      const cacheKey = `lfm:weeklyalbums:${userName.toLowerCase()}:${fromSec}:${toSec}:${count}`;
      if (this.cache && !sessionKey) {
        const cached = await this.cache.get<TopAlbum[]>(cacheKey);
        if (cached) {
          return cached;
        }
      }

      try {
        const params: Record<string, string> = {
          user: userName,
          from: String(fromSec),
          to: String(toSec),
          limit: String(count),
          ...(sessionKey ? { sk: sessionKey } : {}),
        };
        const response = sessionKey
          ? await this.api.callSigned<any>('user.getweeklyalbumchart', params, 'GET')
          : await this.api.call<any>('user.getweeklyalbumchart', params);
        let result = TopListConverter.convertWeeklyAlbumChart(response);
        if (count && count > 0 && result.length > count) {
          result = result.slice(0, count);
        }
        if (this.cache && !sessionKey && result.length > 0) {
          await this.cache.set(cacheKey, result, 120);
        }
        return result;
      } catch (err) {
        Logger.warn({ err: String(err).slice(0, 120) }, `getweeklyalbumchart failed for ${userName}`);
        return [];
      }
    }

    const cacheKey = `lfm:topalbums:${userName.toLowerCase()}:${period}:${count}:${page}`;
    if (this.cache && !sessionKey) {
      const cached = await this.cache.get<TopAlbum[]>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    try {
      const params: Record<string, string> = {
        user: userName,
        period: TimePeriodToLastfmApiPeriod[period] ?? 'overall',
        limit: String(count),
        page: String(page),
        ...(sessionKey ? { sk: sessionKey } : {}),
      };
      const response = sessionKey
        ? await this.api.callSigned<TopAlbumsResponseLfm>('user.gettopalbums', params, 'GET')
        : await this.api.call<TopAlbumsResponseLfm>('user.gettopalbums', params);
      const result = TopListConverter.convertTopAlbums(response);
      if (this.cache && !sessionKey && result.length > 0) {
        await this.cache.set(cacheKey, result, 120);
      }
      return result;
    } catch (err) {
      Logger.warn({ err: String(err).slice(0, 120) }, `getTopAlbums failed for ${userName}`);
      return [];
    }
  }

  public async getTopTracks(
    userName: string,
    period: TimePeriod = TimePeriod.AllTime,
    count: number = 10,
    page: number = 1,
    sessionKey?: string,
    from?: number,
    to?: number,
  ): Promise<TopTrack[]> {
    const isCustomOrDaily = period === TimePeriod.Daily || (from !== undefined && to !== undefined);
    if (isCustomOrDaily) {
      const fromSec = from ?? Math.floor((Date.now() - 86400000) / 1000);
      const toSec = to ?? Math.floor(Date.now() / 1000);
      const cacheKey = `lfm:weeklytracks:${userName.toLowerCase()}:${fromSec}:${toSec}:${count}`;
      if (this.cache && !sessionKey) {
        const cached = await this.cache.get<TopTrack[]>(cacheKey);
        if (cached) {
          return cached;
        }
      }

      try {
        const params: Record<string, string> = {
          user: userName,
          from: String(fromSec),
          to: String(toSec),
          limit: String(count),
          ...(sessionKey ? { sk: sessionKey } : {}),
        };
        const response = sessionKey
          ? await this.api.callSigned<any>('user.getweeklytrackchart', params, 'GET')
          : await this.api.call<any>('user.getweeklytrackchart', params);
        let result = TopListConverter.convertWeeklyTrackChart(response);
        if (count && count > 0 && result.length > count) {
          result = result.slice(0, count);
        }
        if (this.cache && !sessionKey && result.length > 0) {
          await this.cache.set(cacheKey, result, 120);
        }
        return result;
      } catch (err) {
        Logger.warn({ err: String(err).slice(0, 120) }, `getweeklytrackchart failed for ${userName}`);
        return [];
      }
    }

    const cacheKey = `lfm:toptracks:${userName.toLowerCase()}:${period}:${count}:${page}`;
    if (this.cache && !sessionKey) {
      const cached = await this.cache.get<TopTrack[]>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    try {
      const params: Record<string, string> = {
        user: userName,
        period: TimePeriodToLastfmApiPeriod[period] ?? 'overall',
        limit: String(count),
        page: String(page),
        ...(sessionKey ? { sk: sessionKey } : {}),
      };
      const response = sessionKey
        ? await this.api.callSigned<TopTracksResponseLfm>('user.gettoptracks', params, 'GET')
        : await this.api.call<TopTracksResponseLfm>('user.gettoptracks', params);
      const result = TopListConverter.convertTopTracks(response);
      if (this.cache && !sessionKey && result.length > 0) {
        await this.cache.set(cacheKey, result, 120);
      }
      return result;
    } catch (err) {
      Logger.warn({ err: String(err).slice(0, 120) }, `getTopTracks failed for ${userName}`);
      return [];
    }
  }

  public async getScrobbleCountFromDate(
    userName: string,
    from?: number | null,
    sessionKey?: string | null,
    to?: number | null,
  ): Promise<number | null> {
    try {
      const params: Record<string, string> = {
        user: userName,
        limit: '1',
        extended: '1',
      };
      if (sessionKey) {
        params.sk = sessionKey;
      }
      if (from != null) {
        params.from = String(from);
      }
      if (to != null) {
        params.to = String(to);
      }

      const response = sessionKey
        ? await this.api.callSigned<RecentTracksResponseLfm>('user.getrecenttracks', params, 'GET')
        : await this.api.call<RecentTracksResponseLfm>('user.getrecenttracks', params);

      const totalAttr = response?.recenttracks?.['@attr']?.total;
      if (totalAttr !== undefined) {
        return parseInt(totalAttr, 10);
      }
      return null;
    } catch (err) {
      Logger.warn({ err: String(err).slice(0, 120) }, `getScrobbleCountFromDate failed for ${userName}`);
      return null;
    }
  }

  public async getMilestoneScrobble(
    userName: string,
    sessionKey: string | null,
    totalScrobbles: number,
    milestone: number,
  ): Promise<RecentTrack | null> {
    try {
      const pageNumber = totalScrobbles - milestone + 1;
      if (pageNumber < 1) {
        return null;
      }

      const params: Record<string, string> = {
        user: userName,
        limit: '1',
        extended: '1',
        page: String(pageNumber),
      };
      if (sessionKey) {
        params.sk = sessionKey;
      }

      const response = sessionKey
        ? await this.api.callSigned<RecentTracksResponseLfm>('user.getrecenttracks', params, 'GET')
        : await this.api.call<RecentTracksResponseLfm>('user.getrecenttracks', params);

      const tracks = response?.recenttracks?.track;
      if (!tracks) return null;
      const trackArray = Array.isArray(tracks) ? tracks : [tracks];
      const nonNowPlaying = trackArray.find((t) => !t['@attr']?.nowplaying);
      if (!nonNowPlaying) return null;

      return TrackConverter.convertRecentTrack(nonNowPlaying);
    } catch (err) {
      Logger.warn({ err: String(err).slice(0, 120) }, `getMilestoneScrobble failed for ${userName}`);
      return null;
    }
  }
}
