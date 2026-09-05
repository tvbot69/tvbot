import type { Artist } from '@prisma/client';

export interface IArtistRepository {
  getOrCreateArtist(artistName: string): Promise<Artist>;
  getArtistByName(artistName: string): Promise<Artist | null>;
  getArtistById(artistId: number): Promise<Artist | null>;
  getOrCreateArtistsBulk(artistNames: string[]): Promise<Map<string, number>>;
  setSpotifyImage(artistId: number, url: string, date: Date): Promise<void>;
  setDeezerImage(artistId: number, deezerArtistId: number, url: string): Promise<void>;
  setAppleMusicUrl(artistId: number, url: string): Promise<void>;
}
