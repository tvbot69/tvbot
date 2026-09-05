import { PrismaClient } from '@prisma/client';

export class ArtistGenreRepository {
  private readonly prisma: PrismaClient;
  constructor(prisma: PrismaClient) { this.prisma = prisma; }

  async getForArtistId(artistId: number): Promise<string[]> {
    const rows = await this.prisma.artistGenre.findMany({ where: { artistId }, select: { name: true } });
    return rows.map(r => r.name);
  }
  async getForArtistName(artistName: string): Promise<string[]> {
    const artist = await this.prisma.artist.findFirst({ where: { name: { equals: artistName, mode: 'insensitive' } }, select: { artistId: true } });
    if (!artist) return [];
    return this.getForArtistId(artist.artistId);
  }
  async setForArtistId(artistId: number, tags: string[]): Promise<void> {
    const clean = [...new Set(tags.map(t => t.trim().toLowerCase()).filter(Boolean))].slice(0, 4);
    await this.prisma.$transaction(async tx => {
      await tx.artistGenre.deleteMany({ where: { artistId } });
      if (clean.length) {
        await tx.artistGenre.createMany({ data: clean.map(name => ({ artistId, name })), skipDuplicates: true });
      }
    });
  }

  async getForArtistNames(artistNames: string[]): Promise<Map<string, string[]>> {
    if (artistNames.length === 0) return new Map();
    const cleanNames = [...new Set(artistNames.map(n => n.trim().toLowerCase()))];
    const artists = await this.prisma.artist.findMany({
      where: {
        name: { in: cleanNames, mode: 'insensitive' },
      },
      select: {
        name: true,
        genres: {
          select: { name: true },
        },
      },
    });

    const map = new Map<string, string[]>();
    for (const a of artists) {
      map.set(a.name.toLowerCase(), a.genres.map(g => g.name));
    }
    return map;
  }
}
