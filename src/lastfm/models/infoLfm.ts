import type { LfmImage } from './recentTracksLfm';

export interface ArtistInfoResponseLfm {
  artist: {
    name: string;
    mbid?: string;
    url?: string;
    image?: LfmImage[];
    streamable?: string;
    ontour?: string;
    stats: {
      listeners: string;
      playcount: string;
      userplaycount?: string;
    };
    tags?: {
      tag: Array<{ name: string; url?: string }> | { name: string; url?: string };
    };
    bio?: {
      summary?: string;
    };
    similar?: {
      artist: Array<{ name: string; url?: string; image?: LfmImage[] }>;
    };
  };
}

export interface AlbumInfoResponseLfm {
  album: {
    name: string;
    artist: string;
    mbid?: string;
    url?: string;
    image?: LfmImage[];
    listeners?: string;
    playcount?: string;
    userplaycount?: string;
    wiki?: {
      summary?: string;
      content?: string;
      published?: string;
    };
    tracks?: {
      track?:
        | Array<{
            name: string;
            duration?: string;
            url?: string;
            '@attr'?: { rank?: string };
          }>
        | {
            name: string;
            duration?: string;
            url?: string;
            '@attr'?: { rank?: string };
          };
    };
  };
}

export interface TrackInfoResponseLfm {
  track: {
    name: string;
    mbid?: string;
    url?: string;
    duration?: string;
    streamable?: Record<string, unknown>;
    listeners?: string;
    playcount?: string;
    userplaycount?: string;
    userloved?: string;
    artist?: { name: string; mbid?: string; url?: string };
    album?:
      | {
          title?: string;
          artist?: string;
          url?: string;
          image?: LfmImage[];
        }
      | string;
    toptags?: {
      tag?: Array<{ name: string; url?: string }> | { name: string; url?: string };
    };
    wiki?: {
      summary?: string;
      content?: string;
    };
    image?: LfmImage[];
  };
}
