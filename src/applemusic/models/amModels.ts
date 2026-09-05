export interface AmArtwork {
  url: string;
  width?: number;
  height?: number;
}

export interface AmArtistAttributes {
  name: string;
  artwork?: AmArtwork;
  genreNames?: string[];
  url?: string;
}

export interface AmAlbumAttributes {
  name: string;
  artistName: string;
  artwork?: AmArtwork;
  releaseDate?: string;
  trackCount?: number;
  url?: string;
}

export interface AmSongAttributes {
  name: string;
  artistName: string;
  albumName?: string;
  artwork?: AmArtwork;
  durationInMillis?: number;
  url?: string;
}

export interface AmResource {
  id: string;
  type: string;
  attributes?:
    | AmArtistAttributes
    | AmAlbumAttributes
    | AmSongAttributes;
}

export interface AmSearchResponse {
  results?: {
    artists?: { data?: Array<{ id: string; attributes?: AmArtistAttributes }> };
    albums?: { data?: Array<{ id: string; attributes?: AmAlbumAttributes }> };
    songs?: { data?: Array<{ id: string; attributes?: AmSongAttributes }> };
  };
}
