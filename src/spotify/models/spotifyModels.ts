export interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

export interface SpotifySearchArtist {
  id: string;
  name: string;
  uri: string;
  external_urls?: { spotify?: string };
  images?: SpotifyImage[];
  followers?: { total?: number };
  popularity?: number;
  genres?: string[];
}

export interface SpotifySearchAlbum {
  id: string;
  name: string;
  uri: string;
  album_type?: string;
  total_tracks?: number;
  release_date?: string;
  release_date_precision?: string;
  external_urls?: { spotify?: string };
  images?: SpotifyImage[];
  artists?: Array<{ name: string }>;
  label?: string;
  copyrights?: Array<{ text: string; type: string }>;
  tracks?: {
    items?: Array<{
      name: string;
      track_number: number;
      duration_ms: number;
      explicit?: boolean;
    }>;
  };
}

export interface SpotifySearchTrack {
  id: string;
  name: string;
  uri: string;
  duration_ms?: number;
  explicit?: boolean;
  external_urls?: { spotify?: string };
  album?: {
    name?: string;
    images?: SpotifyImage[];
  };
  artists?: Array<{ name: string }>;
}

export interface SpotifySearchResponse {
  artists?: { items?: SpotifySearchArtist[] };
  albums?: { items?: SpotifySearchAlbum[] };
  tracks?: { items?: SpotifySearchTrack[] };
}
