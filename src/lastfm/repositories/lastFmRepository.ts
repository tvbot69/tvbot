import { inject } from 'tsyringe';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';
import { Logger } from '@domain/logging/logger';
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
import { LastfmApiError } from '@domain/models/errors/lastfmError';
import { LastFmUnavailableError } from '@domain/models/errors/lastfmUnavailableError';
import type {
  RecentTracksResponseLfm,
} from '@lastfm/models/recentTracksLfm';
import type {
  TopAlbumsResponseLfm,
  TopArtistsResponseLfm,
  TopTracksResponseLfm,
  WeeklyAlbumChartResponseLfm,
  WeeklyArtistChartResponseLfm,
  WeeklyTrackChartResponseLfm,
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
import type { ICache } from '@domain/interfaces/ports/icache';
import { ICACHE } from '@domain/interfaces/ports/icache';

const FAILURE_DELAY_MS = [500, 2500, 5000, 10000, 25000];

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Last.fm error codes that mean "this thing genuinely does not exist".
 *
 * Everything else - a 5xx, a timeout, a rate limit - is Last.fm being
 * UNAVAILABLE, which is a completely different thing to tell a user. The
 * synthetic -1 is this repo's own "network error or timeout" from lastfmApi.
 *
 * WHAT WAS ACTUALLY OBSERVED (probing a live key, 2026-09-30)
 * -----------------------------------------------------------
 * The earlier version of this comment stated "6 is user not found, 7 is album
 * not found, 8 is artist not found". That is not what the API does, and the
 * distinction matters, because `isNotFound` below decides whether a caller gets
 * a legitimate empty answer or a raise.
 *
 *   - A genuinely unknown user does answer 6. (`user.getinfo` for a name that
 *     does not exist.)
 *   - 7 AND 8 NEVER APPEARED. Not once, for a missing album, a missing artist,
 *     or anything else. They are kept only because removing them is a
 *     behaviour change for real traffic, not because anything here observed
 *     them.
 *   - **6 IS OVERLOADED.** Last.fm also answers HTTP 400 with code 6 for a
 *     MISSING OR OUT-OF-BOUNDS REQUIRED PARAMETER:
 *         user.gettopartists&limit=0  -> 400 {"error":6,"message":"limit param out of bounds (1-1000)"}
 *         user.gettopartists&page=0   -> 400 {"error":6,"message":"page param out of bounds"}
 *
 *     So a caller-side parameter bug is answered with an empty list and NOT one
 *     ERROR log, and a user is told a real account does not exist.
 *
 * THE BOUNDS ARE THE CALLER'S JOB — read this before adding a call site
 * ---------------------------------------------------------------------
 * Last.fm will not tell you which parameter was wrong, and `isNotFound` cannot
 * tell either: by the time it runs, the only thing left is the number 6. Any
 * new caller of a method that forwards `limit` or `page` MUST pass integers
 * inside 1-1000 (page: >= 1) itself. Clamp with `Math.max(1, n)`; do not rely on
 * this set to catch it.
 *
 * SCOPE, because the exposure is not uniform. The methods that reach
 * `isNotFound` are `getUserInfo`, `getArtistInfo`, `getAlbumInfo`,
 * `getTrackInfo`, `searchArtists`/`searchAlbums`/`searchTracks`,
 * `getUserFriends` and the three `getTop*`. Of those, only `getUserFriends` and
 * the three `getTop*` send a `limit`/`page` at all. `getUserRecentTracks`,
 * `getUserRecentTracksWithMetadata` and `getLovedTracks` also forward them, but
 * they log at WARN and return an empty list on any failure, so a bad bound is
 * loud there and never reaches this set. The four `get*Info`/`search*` methods
 * send no limit/page, so for them a code 6 really is a missing entity.
 *
 * REACHABILITY, re-verified by grepping every call site on 2026-09-30: no
 * production path can currently send a bad value. Every caller of
 * `getTopArtists` / `getTopAlbums` / `getTopTracks` passes a literal count
 * (5, 10, 12, 25, 100, 150, 250, 1000) or a `Math.min(..., 1000)` clamp, and
 * `page` is the literal 1 or omitted; `chartService` derives its limit from
 * `chartModels`' `imagesNeeded` (= width x height, default 9) so it is always
 * positive; `updateService` clamps to `Math.max(50, ...)`, `indexService` uses a
 * constant page size with `page` starting at 1, `playCommands` clamps `>= 1`
 * and `recentInteractions` uses `Math.max(1, ...)`. `getUserFriends` forwards
 * `limit`/`page` and has NO production caller at all. This is a trap for the
 * next caller, not a live bug — which is why the fix is this comment and not a
 * change to the set.
 *
 * If the bounds ARE ever violated in production, removing 6 from this set is
 * NOT the fix: every genuine "no such user" would then raise, and a deleted
 * account would render as a Last.fm outage. The split has to happen before the
 * code is known - by validating the parameters at the method boundary, so a
 * caller bug becomes an exception here and still reads as a real not-found from
 * Last.fm.
 */
const NOT_FOUND_CODES = new Set([6, 7, 8]);

/**
 * TRUE when Last.fm answered, and the answer was "no such thing".
 *
 * The distinction matters because every method in this class returns `null` or
 * `[]` for both cases, so before this existed a Last.fm outage was
 * indistinguishable from a deleted account - the bot would confidently tell
 * someone their friend had been removed. A network failure is not an answer.
 */
const isNotFound = (err: unknown): boolean =>
  err instanceof LastfmApiError && NOT_FOUND_CODES.has(err.code);

/**
 * The single place a Last.fm failure becomes a caller-visible result.
 *
 * A genuine "no such artist" is a legitimate empty answer and is returned.
 * Anything else means Last.fm failed, which is logged at ERROR and raised as
 * `LastFmUnavailableError` so the caller can render an error instead of an
 * empty list that looks like real data.
 */
const orUnavailable = <T>(method: string, err: unknown, absent: T): T => {
  if (isNotFound(err)) return absent;
  Logger.error({ method, err: (err as Error)?.message ?? String(err) }, `Last.fm ${method} failed and was not a "not found" answer`);
  throw new LastFmUnavailableError(method, err);
};

export class LastFmRepository implements ILastfmRepository {
  private readonly api: LastfmApi;
  private readonly cache?: ICache;

  constructor(
    @inject(LastfmApi) api: LastfmApi,
    @inject(ICACHE) cache?: ICache,
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
      // CORRECT AS IS, and deliberately NOT `orUnavailable`, which is the whole
      // reason this is worth writing down. Every other method in this class
      // routes its failure through `orUnavailable` because a null there reads as
      // "no such thing" - a deleted account, an artist with no tags. Here the
      // null is consumed by `loginService.startLogin`, which renders
      // "Could not reach Last.fm to start the login flow. Try again in a
      // moment." The caller already names the source, so a raise would produce
      // the same sentence one layer further out while breaking the deliberate
      // null-contract the interface declares (`getAuthToken(): Promise<string |
      // null>`) and the four tests that pin it.
      //
      // There is no measurement here at all: a login has not started, so
      // nothing has been claimed about anyone.
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
      // CORRECT AS IS, same reasoning as `getAuthToken` above, and the null here
      // is even more load-bearing: `loginService.confirmLogin` LOOPS on it. A
      // null means "Last.fm has not registered the session yet", and the loop
      // retries five times over ten seconds before answering. Turning a
      // network error into a raise would abort that retry loop and tell a user
      // mid-flow that Last.fm is unreachable when the very next attempt may well
      // have succeeded - and it would bypass the pending-token TTL, which is
      // what makes a re-press of Confirm work.
      //
      // The honest reading of "this is an outage" is already available: five
      // consecutive `LastfmApiError(-1)`s are logged by `fetchWithRetry` as WARN
      // each, so a failed login is visible in the logs without a user-facing
      // claim being invented.
      return null;
    }
  }

  public async getUserInfo(userName: string): Promise<LastFmUser | null> {
    try {
      const response = await this.api.call<UserInfoResponseLfm>('user.getinfo', {
        user: userName,
      });
      return UserConverter.convertUserInfo(response);
    } catch (err) {
      // Code 6 is a real "no such user". Anything else is Last.fm failing, and
      // returning null for that told callers a deleted account had been deleted.
      return orUnavailable('user.getinfo', err, null);
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
    } catch (err) {
      return orUnavailable('artist.getinfo', err, null);
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
    } catch (err) {
      return orUnavailable('album.getinfo', err, null);
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
    } catch (err) {
      return orUnavailable('track.getinfo', err, null);
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
    } catch (err) {
      return orUnavailable('artist.search', err, []);
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
    } catch (err) {
      return orUnavailable('album.search', err, []);
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
    } catch (err) {
      return orUnavailable('track.search', err, []);
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
    } catch (err) {
      // An empty friend list is indistinguishable from "you have no friends",
      // so a Last.fm outage must not be allowed to produce one.
      return orUnavailable('user.getfriends', err, []);
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
          ? await this.api.callSigned<WeeklyArtistChartResponseLfm>('user.getweeklyartistchart', params, 'GET')
          : await this.api.call<WeeklyArtistChartResponseLfm>('user.getweeklyartistchart', params);
        let result = TopListConverter.convertWeeklyArtistChart(response);
        if (count && count > 0 && result.length > count) {
          result = result.slice(0, count);
        }
        if (this.cache && !sessionKey && result.length > 0) {
          await this.cache.set(cacheKey, result, 120);
        }
        return result;
      } catch (err) {
        // An empty top-artists list IS a claim about a person's listening
        // history, so degrading an outage to one told users they had no taste.
        return orUnavailable('user.getweeklyartistchart', err, []);
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
      return orUnavailable('user.gettopartists', err, []);
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
          ? await this.api.callSigned<WeeklyAlbumChartResponseLfm>('user.getweeklyalbumchart', params, 'GET')
          : await this.api.call<WeeklyAlbumChartResponseLfm>('user.getweeklyalbumchart', params);
        let result = TopListConverter.convertWeeklyAlbumChart(response);
        if (count && count > 0 && result.length > count) {
          result = result.slice(0, count);
        }
        if (this.cache && !sessionKey && result.length > 0) {
          await this.cache.set(cacheKey, result, 120);
        }
        return result;
      } catch (err) {
        return orUnavailable('user.getweeklyalbumchart', err, []);
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
      // Same reasoning as the artists above: "no top albums" and "Last.fm was
      // unreachable" are different claims, and only one of them is an answer.
      return orUnavailable('user.gettopalbums', err, []);
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
          ? await this.api.callSigned<WeeklyTrackChartResponseLfm>('user.getweeklytrackchart', params, 'GET')
          : await this.api.call<WeeklyTrackChartResponseLfm>('user.getweeklytrackchart', params);
        let result = TopListConverter.convertWeeklyTrackChart(response);
        if (count && count > 0 && result.length > count) {
          result = result.slice(0, count);
        }
        if (this.cache && !sessionKey && result.length > 0) {
          await this.cache.set(cacheKey, result, 120);
        }
        return result;
      } catch (err) {
        return orUnavailable('user.getweeklytrackchart', err, []);
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
      return orUnavailable('user.gettoptracks', err, []);
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

  public async loveTrack(artist: string, track: string, sessionKey: string): Promise<boolean> {
    try {
      await this.api.callSigned<{ status?: string }>(
        'track.love',
        {
          artist,
          track,
          sk: sessionKey,
        },
        'POST',
      );
      return true;
    } catch (err) {
      Logger.warn({ err: String(err).slice(0, 120) }, `loveTrack failed for ${artist} - ${track}`);
      return false;
    }
  }

  public async unloveTrack(artist: string, track: string, sessionKey: string): Promise<boolean> {
    try {
      await this.api.callSigned<{ status?: string }>(
        'track.unlove',
        {
          artist,
          track,
          sk: sessionKey,
        },
        'POST',
      );
      return true;
    } catch (err) {
      Logger.warn({ err: String(err).slice(0, 120) }, `unloveTrack failed for ${artist} - ${track}`);
      return false;
    }
  }

  public async getLovedTracks(
    userName: string,
    limit: number = 20,
    page: number = 1,
    sessionKey?: string,
  ): Promise<{ tracks: TopTrack[]; total: number }> {
    try {
      const params: Record<string, string> = {
        user: userName,
        limit: String(limit),
        page: String(page),
      };
      if (sessionKey) {
        params.sk = sessionKey;
      }

      interface LovedTrackLfm {
        name: string;
        mbid?: string;
        url?: string;
        date?: { uts: string; '#text': string };
        artist: { name: string; mbid?: string; url?: string } | string;
        image?: Array<{ '#text': string; size: string }>;
      }

      interface LovedTracksResponseLfm {
        lovedtracks?: {
          track?: LovedTrackLfm | LovedTrackLfm[];
          '@attr'?: {
            total?: string;
            totalPages?: string;
            page?: string;
            perPage?: string;
          };
        };
      }

      const response = await this.api.call<LovedTracksResponseLfm>('user.getlovedtracks', params);
      const trackData = response?.lovedtracks?.track;
      const total = parseInt(response?.lovedtracks?.['@attr']?.total ?? '0', 10);
      if (!trackData) {
        return { tracks: [], total: 0 };
      }

      const rawTracks = Array.isArray(trackData) ? trackData : [trackData];
      const tracks: TopTrack[] = rawTracks.map((t) => ({
        name: t.name,
        artistName: typeof t.artist === 'string' ? t.artist : (t.artist?.name ?? 'Unknown Artist'),
        playcount: 1,
        mbid: t.mbid,
        url: t.url,
        imageUrl: Array.isArray(t.image) ? (t.image[t.image.length - 1]?.['#text'] ?? undefined) : undefined,
        dateLoved: t.date?.uts ? new Date(parseInt(t.date.uts, 10) * 1000) : undefined,
      }));

      return { tracks, total };
    } catch (err) {
      Logger.warn({ err: String(err).slice(0, 120) }, `getLovedTracks failed for ${userName}`);
      return { tracks: [], total: 0 };
    }
  }

  public async scrobbleTrack(
    artist: string,
    track: string,
    timestamp: number,
    sessionKey: string,
    album?: string,
  ): Promise<boolean> {
    try {
      const params: Record<string, string> = {
        artist,
        track,
        timestamp: String(timestamp),
        sk: sessionKey,
      };
      if (album) {
        params.album = album;
      }

      await this.api.callSigned<{ scrobbles?: unknown }>('track.scrobble', params, 'POST');
      return true;
    } catch (err) {
      Logger.warn({ err: String(err).slice(0, 120) }, `scrobbleTrack failed for ${artist} - ${track}`);
      return false;
    }
  }
}
