import { inject, injectable } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@persistence/prismaClient';
import type { ILastfmRepository } from '@domain/interfaces/ports/ilastfmRepository';
import { TimePeriod } from '@domain/enums/timePeriod';
import { SourceUnavailableError } from '@domain/models/errors/sourceUnavailableError';
import { Logger } from '@domain/logging/logger';

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

/**
 * The single place the featured-pool read becomes a caller-visible result.
 *
 * Same rule as `orDatabaseUnavailable` in `countryService`, `playHistoryService`
 * and `guildAdminService`: a query that returns NO ROWS is a real answer and stays
 * an empty pool (rendered as `null`, "nobody featured"), but a query that THROWS
 * is a failure and is raised rather than returned. An aggregate over `users` with
 * no matching rows succeeds with an empty list - it never errors. So empty IS the
 * answer, and an error is always an error.
 *
 * Every caller sits behind a boundary that replies on a throw, so raising surfaces
 * as a visible error rather than a lie, and records nothing in `historyLog`.
 */
const orDatabaseUnavailable = async <T>(
  method: string,
  label: string,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (err) {
    Logger.error(
      { query: `${method}:${label}`, err: (err as Error)?.message ?? String(err) },
      `Database unavailable in ${method} (${label}); refusing to render the featured pool as empty`,
    );
    throw new SourceUnavailableError(`featuredService.${method}:${label}`, err, 'Database unavailable');
  }
};

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
    // A pool read that THROWS is an outage, not an empty pool. Degrading it to
    // `[]` renders a confident "nobody featured" card for a dropped connection,
    // and a pool that silently empties is what lets a later retry publish an
    // "Unknown Artist" history entry for a real user. `pickNewFeatured` is only
    // reached from commands whose boundary already catches and replies, so the
    // raise costs one visible error and records nothing.
    const users = await orDatabaseUnavailable('pickNewFeatured', 'user.findMany', () =>
      this.db.user.findMany({
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
      }),
    );

    if (users.length === 0) return null;

    // Pick a random user from the active pool
    const selectedUser = users[Math.floor(Math.random() * users.length)];
    if (!selectedUser) return null;

    // Fetch their weekly top albums or tracks.
    //
    // No `.catch` on either Last.fm read. The entry this builds is pushed onto
    // `historyLog` and rendered with the selected user's real Discord name, so
    // degrading a failed read to `[]` publishes a card saying that person
    // featured "Unknown Artist" with 0 plays - a claim about a named human,
    // produced entirely by an outage. `pickNewFeatured` is only reached from the
    // user-hub commands, whose boundary already catches and replies, so the
    // raise costs one visible error instead of a permanent, confidently wrong
    // entry in the featured log.
    const topAlbums = await this.lastFmRepository.getTopAlbums(
      selectedUser.userNameLastFm,
      TimePeriod.Weekly,
      5,
    );

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
      const topTracks = await this.lastFmRepository.getTopTracks(
        selectedUser.userNameLastFm,
        TimePeriod.Weekly,
        5,
      );

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
