export interface ArtistInfo {
  name: string;
  mbid?: string;
  url?: string;
  imageUrl?: string;
  listeners?: number;
  playCount?: number;
  userPlayCount?: number;
  summary?: string;
  tags?: string[];
}

export interface AlbumTrackInfo {
  name: string;
  durationSeconds?: number;
  url?: string;
  rank?: number;
}

export interface AlbumInfo {
  name: string;
  artistName: string;
  mbid?: string;
  url?: string;
  imageUrl?: string;
  listeners?: number;
  playCount?: number;
  userPlayCount?: number;
  summary?: string;
  releaseDate?: Date;
  tracks?: AlbumTrackInfo[];
}

export interface TrackInfo {
  name: string;
  artistName: string;
  albumName?: string;
  albumCoverUrl?: string;
  mbid?: string;
  url?: string;
  imageUrl?: string;
  durationSeconds?: number;
  listeners?: number;
  playCount?: number;
  userPlayCount?: number;
  summary?: string;
  tags?: string[];
  userLoved?: boolean;
}
