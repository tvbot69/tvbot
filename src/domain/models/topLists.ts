import type { TimePeriod } from '@domain/enums/timePeriod';

export interface TopArtist {
  name: string;
  playcount: number;
  mbid?: string;
  url?: string;
}

export interface TopAlbum {
  name: string;
  artistName: string;
  playcount: number;
  mbid?: string;
  url?: string;
  imageUrl?: string;
  releaseDate?: Date;
  releaseDatePrecision?: string;
  albumType?: string;
}

export interface TopTrack {
  name: string;
  artistName: string;
  playcount: number;
  mbid?: string;
  url?: string;
  imageUrl?: string;
}

export type { TimePeriod };
