import { PrismaClient, Track } from '@prisma/client';
import type { ITrackRepository } from '@domain/interfaces/itrackRepository';

export class TrackRepository implements ITrackRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public async getOrCreateTrack(trackName: string, artistId: number, imageUrl?: string): Promise<Track> {
    const normalized = trackName.toLowerCase();
    const existing = await this.prisma.track.findFirst({
      where: { artistId: artistId, name: { equals: normalized, mode: 'insensitive' } },
    });
    if (existing) {
      return existing;
    }
    return this.prisma.track.create({
      data: { name: normalized, artistId: artistId, imageUrl: imageUrl ?? null },
    });
  }

  public async getTrackByNameAndArtist(trackName: string, artistId: number): Promise<Track | null> {
    return this.prisma.track.findFirst({
      where: { artistId: artistId, name: trackName.toLowerCase() },
    });
  }

  public async setSpotifyImage(trackId: number, url: string, date: Date): Promise<void> {
    await this.prisma.track.update({
      where: { trackId: trackId },
      data: { spotifyImageUrl: url, spotifyImageDate: date },
    });
  }

  public async setImageUrl(trackId: number, url: string): Promise<void> {
    await this.prisma.track.update({
      where: { trackId: trackId },
      data: { imageUrl: url },
    });
  }

  public async getTrackById(trackId: number): Promise<Track | null> {
    return this.prisma.track.findUnique({ where: { trackId: trackId } });
  }

  public async getOrCreateTracksBulk(
    items: Array<{ trackName: string; artistId: number }>,
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const unique = new Map<string, { name: string; artistId: number }>();
    for (const item of items) {
      const key = item.trackName.toLowerCase();
      if (!key) continue;
      unique.set(`${item.artistId}|${key}`, { name: key, artistId: item.artistId });
    }
    if (unique.size === 0) return map;

    const list = [...unique.values()];
    const chunkSize = 400;
    for (let i = 0; i < list.length; i += chunkSize) {
      const chunk = list.slice(i, i + chunkSize);
      const artistIds = [...new Set(chunk.map((c) => c.artistId))];
      const existing = await this.prisma.track.findMany({
        where: { artistId: { in: artistIds }, name: { in: chunk.map((c) => c.name) } },
        select: { trackId: true, name: true, artistId: true },
      });
      for (const row of existing) {
        map.set(`${row.artistId}|${row.name.toLowerCase()}`, row.trackId);
      }
      const missing = chunk.filter((c) => !map.has(`${c.artistId}|${c.name}`));
      if (missing.length > 0) {
        await this.prisma.track.createMany({ data: missing, skipDuplicates: true });
        const created = await this.prisma.track.findMany({
          where: { artistId: { in: artistIds }, name: { in: missing.map((m) => m.name) } },
          select: { trackId: true, name: true, artistId: true },
        });
        for (const row of created) {
          map.set(`${row.artistId}|${row.name.toLowerCase()}`, row.trackId);
        }
      }
    }
    return map;
  }
}
