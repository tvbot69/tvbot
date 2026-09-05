import type { Album } from '@prisma/client';

export interface IAlbumRepository {
  getOrCreateAlbum(albumName: string, artistId: number, imageUrl?: string): Promise<Album>;
  getAlbumById(albumId: number): Promise<Album | null>;
  getAlbumByNameAndArtist(albumName: string, artistId: number): Promise<Album | null>;
  setSpotifyImage(albumId: number, url: string, date: Date): Promise<void>;
  setDeezerImage(albumId: number, deezerAlbumId: number, url: string): Promise<void>;
  setImageUrl(albumId: number, url: string): Promise<void>;
  getOrCreateAlbumsBulk(
    items: Array<{ albumName: string; artistId: number }>,
  ): Promise<Map<string, number>>;
  setReleaseData(
    albumId: number,
    data: { releaseDate?: Date; releaseDatePrecision?: string; spotifyAlbumType?: string },
  ): Promise<void>;
}
