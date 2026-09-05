import type { LfmImage } from './recentTracksLfm';

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
