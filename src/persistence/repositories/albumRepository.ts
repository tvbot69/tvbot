import { PrismaClient, Album } from '@prisma/client';
import type { IAlbumRepository } from '@domain/interfaces/ialbumRepository';

export class AlbumRepository implements IAlbumRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public async getOrCreateAlbum(albumName: string, artistId: number, imageUrl?: string): Promise<Album> {
    const normalized = albumName.toLowerCase();
    const existing = await this.prisma.album.findFirst({
      where: { artistId: artistId, name: { equals: normalized, mode: 'insensitive' } },
    });
    if (existing) {
      return existing;
    }
    return this.prisma.album.create({
      data: { name: normalized, artistId: artistId, imageUrl: imageUrl ?? null },
    });
  }

  public async getAlbumByNameAndArtist(albumName: string, artistId: number): Promise<Album | null> {
    return this.prisma.album.findFirst({
      where: { artistId: artistId, name: albumName.toLowerCase() },
    });
  }

  public async setSpotifyImage(albumId: number, url: string, date: Date): Promise<void> {
    await this.prisma.album.update({
      where: { albumId: albumId },
      data: { spotifyImageUrl: url, spotifyImageDate: date },
    });
  }

  public async setDeezerImage(albumId: number, deezerAlbumId: number, url: string): Promise<void> {
    await this.prisma.album.update({
      where: { albumId: albumId },
      data: { deezerAlbumId: BigInt(deezerAlbumId), deezerImageUrl: url },
    });
  }

  public async setImageUrl(albumId: number, url: string): Promise<void> {
    await this.prisma.album.update({
      where: { albumId: albumId },
      data: { imageUrl: url },
    });
  }

  public async getAlbumById(albumId: number): Promise<Album | null> {
    return this.prisma.album.findUnique({ where: { albumId: albumId } });
  }

  public async setReleaseData(
    albumId: number,
    data: { releaseDate?: Date; releaseDatePrecision?: string; spotifyAlbumType?: string },
  ): Promise<void> {
    await this.prisma.album.update({
      where: { albumId: albumId },
      data: {
        releaseDate: data.releaseDate ?? null,
        releaseDatePrecision: data.releaseDatePrecision ?? null,
        spotifyAlbumType: data.spotifyAlbumType ?? null,
      },
    });
  }

  public async getOrCreateAlbumsBulk(
    items: Array<{ albumName: string; artistId: number }>,
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const unique = new Map<string, { name: string; artistId: number }>();
    for (const item of items) {
      const key = item.albumName.toLowerCase();
      if (!key) continue;
      unique.set(`${item.artistId}|${key}`, { name: key, artistId: item.artistId });
    }
    if (unique.size === 0) return map;

    const list = [...unique.values()];
    const chunkSize = 400;
    for (let i = 0; i < list.length; i += chunkSize) {
      const chunk = list.slice(i, i + chunkSize);
      const artistIds = [...new Set(chunk.map((c) => c.artistId))];
      const existing = await this.prisma.album.findMany({
        where: { artistId: { in: artistIds }, name: { in: chunk.map((c) => c.name) } },
        select: { albumId: true, name: true, artistId: true },
      });
      for (const row of existing) {
        map.set(`${row.artistId}|${row.name.toLowerCase()}`, row.albumId);
      }
      const missing = chunk.filter((c) => !map.has(`${c.artistId}|${c.name}`));
      if (missing.length > 0) {
        await this.prisma.album.createMany({ data: missing, skipDuplicates: true });
        const created = await this.prisma.album.findMany({
          where: { artistId: { in: artistIds }, name: { in: missing.map((m) => m.name) } },
          select: { albumId: true, name: true, artistId: true },
        });
        for (const row of created) {
          map.set(`${row.artistId}|${row.name.toLowerCase()}`, row.albumId);
        }
      }
    }
    return map;
  }
}
