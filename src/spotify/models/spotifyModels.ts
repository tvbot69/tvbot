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
  artists?: Array<{ id?: string; name: string }>;
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
  artists?: Array<{ id?: string; name: string }>;
}

export interface SpotifySearchResponse {
  artists?: { items?: SpotifySearchArtist[] };
  albums?: { items?: SpotifySearchAlbum[] };
  tracks?: { items?: SpotifySearchTrack[] };
}

/**
 * `GET /v1/artists/{id}/albums`
 *
 * Distinct from a search response, and getting this wrong is easy because the
 * two look alike: a SEARCH result for a track carries its artwork at
 * `album.images`, while this endpoint returns album objects that carry
 * `images` at the TOP level. Verified against the live API - the item keys
 * are album_type, total_tracks, external_urls, href, id, images, name,
 * release_date, release_date_precision, type, uri, artists.
 *
 * Note there is no `total_pages` on this response, so paging cannot be
 * inferred from it.
 */
export interface SpotifyArtistAlbumsResponse {
  items?: Array<{
    id: string;
    name: string;
    album_type?: string;
    release_date?: string;
    total_tracks?: number;
    images?: SpotifyImage[];
    external_urls?: { spotify?: string };
  }>;
  href?: string;
}
