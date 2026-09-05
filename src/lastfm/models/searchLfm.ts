import type { LfmImage } from './recentTracksLfm';

interface SearchArtistMatchLfm {
  name: string;
  listeners?: string;
  mbid?: string;
  url?: string;
  image?: LfmImage[];
}

interface SearchAlbumOrTrackMatchLfm {
  name: string;
  artist?: string;
  mbid?: string;
  url?: string;
  image?: LfmImage[];
}

export interface ArtistSearchResponseLfm {
  results: {
    artistmatches?: { artist?: SearchArtistMatchLfm[] };
    'opensearch:totalResults'?: string;
  };
}

export interface AlbumSearchResponseLfm {
  results: {
    albummatches?: { album?: SearchAlbumOrTrackMatchLfm[] };
  };
}

export interface TrackSearchResponseLfm {
  results: {
    trackmatches?: { track?: SearchAlbumOrTrackMatchLfm[] };
  };
}
