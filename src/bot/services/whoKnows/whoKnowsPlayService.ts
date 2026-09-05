import { CacheService } from '../cacheService';
import type { FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';

export class WhoKnowsPlayService {
  private readonly cache: CacheService;

  constructor(cache: CacheService) {
    this.cache = cache;
  }

  public async getGuildAlsoPlayingArtist(
    currentUserId: number,
    guildUsers: Map<number, FullGuildUserDetails>,
    artistName: string,
  ): Promise<string | null> {
    if (!guildUsers || guildUsers.size === 0) return null;

    const foundUsers: FullGuildUserDetails[] = [];

    for (const [userId, user] of guildUsers.entries()) {
      if (userId === currentUserId) continue;
      const key = `${userId}-lp-artist-${artistName.toLowerCase()}`;
      const play = await this.cache.get<{ timePlayed?: string; nowPlaying?: boolean }>(key);
      if (play) {
        foundUsers.push(user);
      }
    }

    if (foundUsers.length === 0) return null;
    return this.formatAlsoPlaying(foundUsers);
  }

  public async getGuildAlsoPlayingAlbum(
    currentUserId: number,
    guildUsers: Map<number, FullGuildUserDetails>,
    artistName: string,
    albumName: string,
  ): Promise<string | null> {
    if (!guildUsers || guildUsers.size === 0) return null;

    const foundUsers: FullGuildUserDetails[] = [];

    for (const [userId, user] of guildUsers.entries()) {
      if (userId === currentUserId) continue;
      const key = `${userId}-lp-album-${artistName.toLowerCase()}-${albumName.toLowerCase()}`;
      const play = await this.cache.get<{ timePlayed?: string; nowPlaying?: boolean }>(key);
      if (play) {
        foundUsers.push(user);
      }
    }

    if (foundUsers.length === 0) return null;
    return this.formatAlsoPlaying(foundUsers);
  }

  public async getGuildAlsoPlayingTrack(
    currentUserId: number,
    guildUsers: Map<number, FullGuildUserDetails>,
    artistName: string,
    trackName: string,
  ): Promise<string | null> {
    if (!guildUsers || guildUsers.size === 0) return null;

    const foundUsers: FullGuildUserDetails[] = [];

    for (const [userId, user] of guildUsers.entries()) {
      if (userId === currentUserId) continue;
      const key = `${userId}-lp-track-${artistName.toLowerCase()}-${trackName.toLowerCase()}`;
      const play = await this.cache.get<{ timePlayed?: string; nowPlaying?: boolean }>(key);
      if (play) {
        foundUsers.push(user);
      }
    }

    if (foundUsers.length === 0) return null;
    return this.formatAlsoPlaying(foundUsers);
  }

  private formatAlsoPlaying(users: FullGuildUserDetails[]): string {
    const formatUser = (u: FullGuildUserDetails) =>
      `[${u.userNameLastFm}](https://www.last.fm/user/${encodeURIComponent(u.userNameLastFm)})`;

    if (users.length === 1) {
      return `Also playing: **${formatUser(users[0]!)}**`;
    }
    if (users.length === 2) {
      return `Also playing: **${formatUser(users[0]!)}** and **${formatUser(users[1]!)}**`;
    }
    if (users.length === 3) {
      return `Also playing: **${formatUser(users[0]!)}**, **${formatUser(users[1]!)}** and **${formatUser(users[2]!)}**`;
    }
    return `Also playing: **${formatUser(users[0]!)}**, **${formatUser(users[1]!)}** and ${users.length - 2} others`;
  }
}
