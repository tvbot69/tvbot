import { PrismaClient, Artist } from '@prisma/client';
import type { IArtistRepository } from '@domain/interfaces/iartistRepository';

export class ArtistRepository implements IArtistRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public async getOrCreateArtist(artistName: string): Promise<Artist> {
    const normalized = artistName.toLowerCase();
    const existing = await this.prisma.artist.findFirst({
      where: { name: normalized },
    });
    if (existing) {
      return existing;
    }
    return this.prisma.artist.create({ data: { name: normalized } });
  }

  public async getOrCreateArtistsBulk(artistNames: string[]): Promise<Map<string, number>> {
    const uniqueLower = [...new Set(artistNames.map((n) => n.toLowerCase()))].filter(Boolean);
    const map = new Map<string, number>();
    if (uniqueLower.length === 0) {
      return map;
    }

    const chunkSize = 500;
    for (let i = 0; i < uniqueLower.length; i += chunkSize) {
      const chunk = uniqueLower.slice(i, i + chunkSize);
      const existing = await this.prisma.artist.findMany({
        where: { name: { in: chunk } },
        select: { artistId: true, name: true },
      });
      for (const row of existing) {
        map.set(row.name.toLowerCase(), row.artistId);
      }

      const missing = chunk.filter((n) => !map.has(n));
      if (missing.length > 0) {
        await this.prisma.artist.createMany({
          data: missing.map((name) => ({ name })),
          skipDuplicates: true,
        });
        const created = await this.prisma.artist.findMany({
          where: { name: { in: missing } },
          select: { artistId: true, name: true },
        });
        for (const row of created) {
          map.set(row.name.toLowerCase(), row.artistId);
        }
      }
    }
    return map;
  }

  public async getArtistByName(artistName: string): Promise<Artist | null> {
    return this.prisma.artist.findFirst({
      where: { name: { equals: artistName.toLowerCase(), mode: 'insensitive' } },
    });
  }

  public async getArtistById(artistId: number): Promise<Artist | null> {
    return this.prisma.artist.findUnique({ where: { artistId: artistId } });
  }

  public async setSpotifyImage(artistId: number, url: string, date: Date): Promise<void> {
    await this.prisma.artist.update({
      where: { artistId: artistId },
      data: { spotifyImageUrl: url, spotifyImageDate: date },
    });
  }

  public async setDeezerImage(artistId: number, deezerArtistId: number, url: string): Promise<void> {
    await this.prisma.artist.update({
      where: { artistId: artistId },
      data: { deezerArtistId: BigInt(deezerArtistId), deezerImageUrl: url },
    });
  }

  public async setAppleMusicUrl(artistId: number, url: string): Promise<void> {
    await this.prisma.artist.update({
      where: { artistId: artistId },
      data: { appleMusicUrl: url },
    });
  }
}
