import type { Track } from '@prisma/client';

export interface ITrackRepository {
  getOrCreateTrack(trackName: string, artistId: number, imageUrl?: string): Promise<Track>;
  getTrackById(trackId: number): Promise<Track | null>;
  getTrackByNameAndArtist(trackName: string, artistId: number): Promise<Track | null>;
  setSpotifyImage(trackId: number, url: string, date: Date): Promise<void>;
  setImageUrl(trackId: number, url: string): Promise<void>;
  getOrCreateTracksBulk(
    items: Array<{ trackName: string; artistId: number }>,
  ): Promise<Map<string, number>>;
}
