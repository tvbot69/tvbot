import type { LastFmUser } from '@domain/models/lastFmUser';
import type {
  RecentTrack,
  RecentTrackList,
} from '@domain/models/recentTrack';
import { TimePeriod } from '@domain/enums/timePeriod';
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

export interface ILastfmRepository {
  getAuthToken(): Promise<string | null>;
  getAuthSession(token: string): Promise<{ name: string; key: string } | null>;
  getUserInfo(userName: string): Promise<LastFmUser | null>;
  getUserRecentTracks(
    userName: string,
    count?: number,
    page?: number,
    fromUnixTimestamp?: number,
    sessionKey?: string,
  ): Promise<RecentTrack[]>;
  getUserRecentTracksWithMetadata(
    userName: string,
    count?: number,
    page?: number,
    fromUnixTimestamp?: number,
    sessionKey?: string,
    errorRetries?: number,
  ): Promise<RecentTrackList>;
  getTopArtists(userName: string, period?: TimePeriod, count?: number, page?: number, sessionKey?: string, from?: number, to?: number): Promise<TopArtist[]>;
  getTopAlbums(userName: string, period?: TimePeriod, count?: number, page?: number, sessionKey?: string, from?: number, to?: number): Promise<TopAlbum[]>;
  getTopTracks(userName: string, period?: TimePeriod, count?: number, page?: number, sessionKey?: string, from?: number, to?: number): Promise<TopTrack[]>;
  getArtistInfo(artistName: string, username?: string): Promise<ArtistInfo | null>;
  getAlbumInfo(artistName: string, albumName: string, username?: string): Promise<AlbumInfo | null>;
  getTrackInfo(trackName: string, artistName: string, username?: string): Promise<TrackInfo | null>;
  searchArtists(query: string): Promise<TopArtist[]>;
  searchAlbums(query: string): Promise<TopAlbum[]>;
  searchTracks(query: string): Promise<TopTrack[]>;
  getUserFriends(userName: string, limit?: number, page?: number): Promise<LastFmUser[]>;
  getScrobbleCountFromDate(userName: string, from?: number | null, sessionKey?: string | null, to?: number | null): Promise<number | null>;
  getMilestoneScrobble(userName: string, sessionKey: string | null, totalScrobbles: number, milestone: number): Promise<RecentTrack | null>;
}
