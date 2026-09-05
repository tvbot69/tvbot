import type { IWhoKnowsRepository } from '@domain/interfaces/iwhoKnowsRepository';
import type { IGuildUserRepository, FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';
import type { GuildService } from '../guild/guildService';
import type { User } from '@domain/interfaces/iuserRepository';
import { WhoKnowsService } from './whoKnowsService';
import type { WhoKnowsArtistContext, WhoKnowsUser } from '@bot/models/whoKnowsModels';
import type { Guild as DiscordGuild } from 'discord.js';
import type { GenreService } from '../genreService';
import type { CrownService } from '../crown/crownService';
import type { CrownModel } from '@domain/models/crownModels';

export class WhoKnowsArtistService {
  private readonly whoKnowsRepository: IWhoKnowsRepository;
  private readonly guildUserRepository: IGuildUserRepository;
  private readonly guildService: GuildService;
  private readonly genreService?: GenreService;
  private readonly crownService?: CrownService;

  constructor(
    whoKnowsRepository: IWhoKnowsRepository,
    guildUserRepository: IGuildUserRepository,
    guildService: GuildService,
    genreService?: GenreService,
    crownService?: CrownService,
  ) {
    this.whoKnowsRepository = whoKnowsRepository;
    this.guildUserRepository = guildUserRepository;
    this.guildService = guildService;
    this.genreService = genreService;
    this.crownService = crownService;
  }

  public async getFilteredUsersForArtist(
    discordGuild: DiscordGuild | null,
    contextUser: User,
    artistName: string,
    contextUserPlaycount?: number | null,
    filterDisabled: boolean = false,
  ): Promise<WhoKnowsArtistContext> {
    const guild = discordGuild ? await this.guildService.getGuild(discordGuild.id) : null;
    const guildUserList = discordGuild
      ? await this.guildUserRepository.getGuildUsers(discordGuild.id)
      : [];

    const guildUserMap = new Map<number, FullGuildUserDetails>();
    for (const gu of guildUserList) {
      guildUserMap.set(gu.userId, gu);
    }

    const indexedRows = discordGuild
      ? await this.whoKnowsRepository.getIndexedUsersForArtist(discordGuild.id, artistName)
      : [];

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

    let genres: string[] | undefined;
    if (this.genreService) {
      try { genres = await this.genreService.getGenresForArtist(artistName); } catch { genres = undefined; }
    }

    let crownModel: CrownModel | null = null;
    if (this.crownService && filteredUsers.length >= 1 && guild) {
      try {
        crownModel = await this.crownService.getAndUpdateCrownForArtist(
          filteredUsers,
          guildUserMap,
          guild,
          artistName,
        );
        if (crownModel?.crown?.active) {
          const ownerId = crownModel.crown.userId;
          for (const u of filteredUsers) {
            if (u.userId === ownerId) {
              u.hasCrown = true;
            }
          }
        }
      } catch {
        // Crown calculation failure should never crash WhoKnows
      }
    }

    return {
      guild,
      guildUsers: guildUserMap,
      filteredUsersWithArtist: filteredUsers,
      filterStats,
      genres,
      crownModel,
    };
  }

  public async getFriendUsersForArtists(
    discordGuild: DiscordGuild | null,
    userId: number,
    artistName: string,
  ): Promise<WhoKnowsUser[]> {
    const rows = await this.whoKnowsRepository.getFriendUsersForArtist(
      userId,
      artistName,
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
