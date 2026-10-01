import type { LfmImage } from '@lastfm/models/recentTracksLfm';

interface TopItemAttrLfm {
  rank?: string;
}

interface TopArtistLfm {
  name: string;
  playcount: string;
  mbid?: string;
  url?: string;
  '@attr'?: TopItemAttrLfm;
}

interface TopAlbumOrTrackLfm {
  name: string;
  playcount: string;
  mbid?: string;
  url?: string;
  artist?:
    | {
        name: string;
        mbid?: string;
      }
    | string;
  image?: LfmImage[];
  '@attr'?: TopItemAttrLfm;
}

/**
 * A weekly chart payload.
 *
 * Deliberately not reused from the all-time response types above, because the
 * two differ in ways the compiler must be told about:
 *
 * 1. `artist` is NOT always an array. When the chart holds a single entry,
 *    Last.fm returns the bare object rather than a one-element array. Declaring
 *    it as `TopArtistLfm[]` would be a lie that TypeScript cannot catch, since
 *    the value is only wrong at runtime and only for a user with exactly one
 *    weekly top artist - so every `chart.artist.map(...)` would throw for them
 *    and nobody would know why. Hence the union.
 * 2. The chart is entirely ABSENT on an error response (`{ error: 6 }`), so the
 *    optional chain in the converters is load-bearing, not defensive noise.
 */
type WeeklyArtistChartLfm = {
  '@attr'?: {
    user?: string;
    from?: string;
    to?: string;
  };
  artist?: TopArtistLfm | TopArtistLfm[];
}

type WeeklyAlbumChartLfm = {
  '@attr'?: {
    user?: string;
    from?: string;
    to?: string;
  };
  album?: TopAlbumOrTrackLfm | TopAlbumOrTrackLfm[];
}

type WeeklyTrackChartLfm = {
  '@attr'?: {
    user?: string;
    from?: string;
    to?: string;
  };
  track?: TopAlbumOrTrackLfm | TopAlbumOrTrackLfm[];
}

export interface WeeklyArtistChartResponseLfm {
  weeklyartistchart?: WeeklyArtistChartLfm;
  error?: number;
  message?: string;
}

export interface WeeklyAlbumChartResponseLfm {
  weeklyalbumchart?: WeeklyAlbumChartLfm;
  error?: number;
  message?: string;
}

export interface WeeklyTrackChartResponseLfm {
  weeklytrackchart?: WeeklyTrackChartLfm;
  error?: number;
  message?: string;
}

export interface TopArtistsResponseLfm {
  topartists: {
    '@attr': {
      user: string;
      total: string;
      page: string;
      perPage: string;
      totalPages: string;
    };
    artist: TopArtistLfm[];
  };
}

export interface TopAlbumsResponseLfm {
  topalbums: {
    '@attr': {
      user: string;
      total: string;
      page: string;
      perPage: string;
      totalPages: string;
    };
    album: TopAlbumOrTrackLfm[];
  };
}

export interface TopTracksResponseLfm {
  toptracks: {
    '@attr': {
      user: string;
      total: string;
      page: string;
      perPage: string;
      totalPages: string;
    };
    track: TopAlbumOrTrackLfm[];
  };
}
