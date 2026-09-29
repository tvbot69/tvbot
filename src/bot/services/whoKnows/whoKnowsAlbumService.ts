import type { IWhoKnowsRepository } from '@domain/interfaces/iwhoKnowsRepository';
import type { IGuildUserRepository, FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';
import type { IAlbumRepository } from '@domain/interfaces/ialbumRepository';
import type { IArtistRepository } from '@domain/interfaces/iartistRepository';
import type { GuildService } from '../guild/guildService';
import type { User } from '@domain/interfaces/iuserRepository';
import { WhoKnowsService } from './whoKnowsService';
import type { WhoKnowsUser, FilterStats, WhoKnowsRoleRead } from '@bot/models/whoKnowsModels';
import { isUnknownDiscordMember } from '@domain/discordErrors';
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
      let memberRoles: WhoKnowsRoleRead | undefined;
      if (gu?.discordUserId && discordGuild) {
        let member = discordGuild.members.cache.get(gu.discordUserId);
        if (!member) {
          // CORRECT AS IS: a Discord API call for a display name, not a
          // database read, and the fallback is `gu.userNameLastFm` - a real
          // stored name. Playcount, rank, and the listener/play/avg footer never
          // pass through this catch; they come from `getIndexedUsersForAlbum` at
          // line 66, which is deliberately unwrapped so a database outage
          // propagates to the command boundary and the user is told, rather than
          // being shown "Nobody in this server has listened to this".
          //
          // Unlike the identical catch in `whoKnowsArtistService`, the degraded
          // `memberRoles` has NO consumer here: no crown service is wired to the
          // album path, and `whoKnowsBuilders` never reads `.roles`. So the
          // only reachable outcome is the Last.fm name in place of the member's
          // nickname, plus a role state that nothing ever inspects. Raising
          // would delete a complete leaderboard of real people over a nickname,
          // which is the worse lie in the other direction.
          //
          // The role state is still recorded honestly rather than left
          // `undefined`, so that if a crown consumer is ever wired to this path
          // it starts from "unknown" (which blocks a write) instead of "no
          // roles" (which would let it name the wrong person).
          try {
            member = await discordGuild.members.fetch(gu.discordUserId);
            memberRoles = { read: true, roles: Array.from(member.roles.cache.keys()) };
          } catch (err) {
            memberRoles = { read: false, absent: isUnknownDiscordMember(err) };
          }
        } else {
          memberRoles = { read: true, roles: Array.from(member.roles.cache.keys()) };
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
        roles: memberRoles,
      };
    }));

    const requesterMember = discordGuild?.members.cache.get(contextUser.discordUserId);
    const requesterRoles: WhoKnowsRoleRead | undefined = requesterMember
      ? { read: true, roles: Array.from(requesterMember.roles.cache.keys()) }
      : undefined;
    users = WhoKnowsService.addOrReplaceUserToIndexList(
      users,
      contextUser,
      requesterMember?.displayName,
      contextUserPlaycount,
      requesterRoles,
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
