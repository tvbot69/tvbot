import { inject, injectable } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@persistence/prismaClient';
import type { ILastfmRepository } from '@domain/interfaces/ilastfmRepository';
import { TimePeriod } from '@domain/enums/timePeriod';

export interface FeaturedEntry {
  userId: number;
  discordUserId: string;
  userNameLastFm: string;
  artistName: string;
  albumName?: string;
  trackName?: string;
  playcount: number;
  imageUrl?: string;
  featuredAt: Date;
}

@injectable()
export class FeaturedService {
  private currentFeatured: FeaturedEntry | null = null;
  private readonly historyLog: FeaturedEntry[] = [];
  private readonly ONE_HOUR_MS = 60 * 60 * 1000;

  constructor(
    @inject('ILastfmRepository') private readonly lastFmRepository: ILastfmRepository,
    @inject(PrismaClient) private readonly prisma?: PrismaClient,
  ) {}

  private get db(): PrismaClient {
    return this.prisma ?? defaultPrisma;
  }

  public async getFeatured(): Promise<FeaturedEntry | null> {
    const now = Date.now();
    if (this.currentFeatured && now - this.currentFeatured.featuredAt.getTime() < this.ONE_HOUR_MS) {
      return this.currentFeatured;
    }

    return await this.pickNewFeatured();
  }

  public async pickNewFeatured(): Promise<FeaturedEntry | null> {
    // Select an active user who has scrobbles
    const users = await this.db.user.findMany({
      where: {
        totalPlayCount: { gt: 0 },
      },
      select: {
        userId: true,
        discordUserId: true,
        userNameLastFm: true,
      },
      take: 50,
      orderBy: { lastUsed: 'desc' },
    }).catch(() => []);

    if (users.length === 0) return null;

    // Pick a random user from the active pool
    const selectedUser = users[Math.floor(Math.random() * users.length)];
    if (!selectedUser) return null;

    // Fetch their weekly top albums or tracks
    const topAlbums = await this.lastFmRepository
      .getTopAlbums(selectedUser.userNameLastFm, TimePeriod.Weekly, 5)
      .catch(() => []);

    let artistName = 'Unknown Artist';
    let albumName: string | undefined;
    let trackName: string | undefined;
    let playcount = 0;
    let imageUrl: string | undefined;

    if (topAlbums.length > 0 && topAlbums[0]) {
      const top = topAlbums[0];
      artistName = top.artistName;
      albumName = top.name;
      playcount = top.playcount ?? 0;
      imageUrl = top.imageUrl ?? undefined;
    } else {
      const topTracks = await this.lastFmRepository
        .getTopTracks(selectedUser.userNameLastFm, TimePeriod.Weekly, 5)
        .catch(() => []);

      if (topTracks.length > 0 && topTracks[0]) {
        const top = topTracks[0];
        artistName = top.artistName;
        trackName = top.name;
        playcount = top.playcount ?? 0;
        imageUrl = top.imageUrl ?? undefined;
      }
    }

    const featured: FeaturedEntry = {
      userId: selectedUser.userId,
      discordUserId: selectedUser.discordUserId.toString(),
      userNameLastFm: selectedUser.userNameLastFm,
      artistName,
      albumName,
      trackName,
      playcount,
      imageUrl,
      featuredAt: new Date(),
    };

    this.currentFeatured = featured;
    this.historyLog.unshift(featured);
    if (this.historyLog.length > 25) {
      this.historyLog.pop();
    }

    return featured;
  }

  public getFeaturedLog(): FeaturedEntry[] {
    return [...this.historyLog];
  }
}
