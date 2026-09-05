import type { IWhoKnowsRepository } from '@domain/interfaces/iwhoKnowsRepository';
import type { IGuildUserRepository, FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';
import type { IAlbumRepository } from '@domain/interfaces/ialbumRepository';
import type { IArtistRepository } from '@domain/interfaces/iartistRepository';
import type { GuildService } from '../guild/guildService';
import type { User } from '@domain/interfaces/iuserRepository';
import { WhoKnowsService } from './whoKnowsService';
import type { WhoKnowsUser, FilterStats } from '@bot/models/whoKnowsModels';
import type { Guild } from '@persistence/domain/models/guild';
import type { Guild as DiscordGuild } from 'discord.js';

export class WhoKnowsAlbumService {
  private readonly whoKnowsRepository: IWhoKnowsRepository;
  private readonly guildUserRepository: IGuildUserRepository;
  private readonly guildService: GuildService;
  private readonly albumRepository: IAlbumRepository;
  private readonly artistRepository: IArtistRepository;

  constructor(
    whoKnowsRepository: IWhoKnowsRepository,
    guildUserRepository: IGuildUserRepository,
    guildService: GuildService,
    albumRepository: IAlbumRepository,
    artistRepository: IArtistRepository,
  ) {
    this.whoKnowsRepository = whoKnowsRepository;
    this.guildUserRepository = guildUserRepository;
    this.guildService = guildService;
    this.albumRepository = albumRepository;
    this.artistRepository = artistRepository;
  }

  public async getFilteredUsersForAlbum(
    discordGuild: DiscordGuild | null,
    contextUser: User,
    artistName: string,
    albumName: string,
    contextUserPlaycount?: number | null,
    filterDisabled: boolean = false,
  ): Promise<{
    guild: Guild | null;
    guildUsers: Map<number, FullGuildUserDetails>;
    filteredUsersWithAlbum: WhoKnowsUser[];
    filterStats: FilterStats;
    albumId?: number;
  }> {
    const guild = discordGuild ? await this.guildService.getGuild(discordGuild.id) : null;
    const guildUserList = discordGuild
      ? await this.guildUserRepository.getGuildUsers(discordGuild.id)
      : [];

    const guildUserMap = new Map<number, FullGuildUserDetails>();
    for (const gu of guildUserList) {
      guildUserMap.set(gu.userId, gu);
    }

    let indexedRows: Array<{ userId: number; playcount: number }> = [];
    let resolvedAlbumId: number | undefined;

    if (discordGuild) {
      const artist = await this.artistRepository.getArtistByName(artistName);
      if (artist) {
        const album = await this.albumRepository.getAlbumByNameAndArtist(albumName, artist.artistId);
        if (album) {
          resolvedAlbumId = album.albumId;
          indexedRows = await this.whoKnowsRepository.getIndexedUsersForAlbum(
            discordGuild.id,
            album.albumId,
          );
        }
      }
    }

    let users: WhoKnowsUser[] = await Promise.all(indexedRows.map(async (row) => {
      const gu = guildUserMap.get(row.userId);
      let displayName: string | undefined;
      if (gu?.discordUserId && discordGuild) {
        let member = discordGuild.members.cache.get(gu.discordUserId);
        if (!member) {
          try { member = await discordGuild.members.fetch(gu.discordUserId); } catch { /* fallback */ }
        }
        displayName = member?.displayName;
      }
      return {
        userId: row.userId,
        playcount: row.playcount,
        lastFmUsername: gu?.userNameLastFm ?? `user_${row.userId}`,
        discordName: displayName ?? gu?.userNameLastFm,
        discordUserId: gu?.discordUserId,
        lastUsed: gu?.lastUsed,
      };
    }));

    const requesterMember = discordGuild?.members.cache.get(contextUser.discordUserId);
    users = WhoKnowsService.addOrReplaceUserToIndexList(
      users,
      contextUser,
      requesterMember?.displayName,
      contextUserPlaycount,
    );

    const { filterStats, filteredUsers } = WhoKnowsService.filterWhoKnowsObjects(
      users,
      guildUserMap,
      guild,
      contextUser.userId,
      filterDisabled,
    );

    return {
      guild,
      guildUsers: guildUserMap,
      filteredUsersWithAlbum: filteredUsers,
      filterStats,
      albumId: resolvedAlbumId,
    };
  }

  public async getFriendUsersForAlbum(
    discordGuild: DiscordGuild | null,
    userId: number,
    artistName: string,
    albumName: string,
  ): Promise<WhoKnowsUser[]> {
    const artist = await this.artistRepository.getArtistByName(artistName);
    if (!artist) return [];

    const album = await this.albumRepository.getAlbumByNameAndArtist(albumName, artist.artistId);
    if (!album) return [];

    const rows = await this.whoKnowsRepository.getFriendUsersForAlbum(
      userId,
      album.albumId,
      discordGuild?.id,
    );

    return rows.map((r) => ({
      userId: r.userId,
      playcount: r.playcount,
      lastFmUsername: r.userNameLastFm ?? `user_${r.userId}`,
      discordName: r.discordName ?? r.userNameLastFm,
    }));
  }
}
