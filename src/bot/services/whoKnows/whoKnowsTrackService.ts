import type { IWhoKnowsRepository } from '@domain/interfaces/ports/iwhoKnowsRepository';
import type { IGuildUserRepository, FullGuildUserDetails } from '@domain/interfaces/ports/iguildUserRepository';
import type { ITrackRepository } from '@domain/interfaces/ports/itrackRepository';
import type { IArtistRepository } from '@domain/interfaces/ports/iartistRepository';
import type { GuildService } from '@bot/services/guild/guildService';
import type { User } from '@domain/interfaces/ports/iuserRepository';
import { WhoKnowsService } from '@bot/services/whoKnows/whoKnowsService';
import type { WhoKnowsUser, FilterStats, WhoKnowsRoleRead } from '@bot/models/whoKnowsModels';
import { isUnknownDiscordMember } from '@domain/errors/discordErrors';
import type { Guild } from '@persistence/models/guild';
import type { Guild as DiscordGuild } from 'discord.js';

export class WhoKnowsTrackService {
  private readonly whoKnowsRepository: IWhoKnowsRepository;
  private readonly guildUserRepository: IGuildUserRepository;
  private readonly guildService: GuildService;
  private readonly trackRepository: ITrackRepository;
  private readonly artistRepository: IArtistRepository;

  constructor(
    whoKnowsRepository: IWhoKnowsRepository,
    guildUserRepository: IGuildUserRepository,
    guildService: GuildService,
    trackRepository: ITrackRepository,
    artistRepository: IArtistRepository,
  ) {
    this.whoKnowsRepository = whoKnowsRepository;
    this.guildUserRepository = guildUserRepository;
    this.guildService = guildService;
    this.trackRepository = trackRepository;
    this.artistRepository = artistRepository;
  }

  public async getFilteredUsersForTrack(
    discordGuild: DiscordGuild | null,
    contextUser: User,
    artistName: string,
    trackName: string,
    contextUserPlaycount?: number | null,
    filterDisabled: boolean = false,
  ): Promise<{
    guild: Guild | null;
    guildUsers: Map<number, FullGuildUserDetails>;
    filteredUsersWithTrack: WhoKnowsUser[];
    filterStats: FilterStats;
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

    if (discordGuild) {
      const artist = await this.artistRepository.getArtistByName(artistName);
      if (artist) {
        const track = await this.trackRepository.getTrackByNameAndArtist(trackName, artist.artistId);
        if (track) {
          indexedRows = await this.whoKnowsRepository.getIndexedUsersForTrack(
            discordGuild.id,
            track.trackId,
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
          // pass through this catch; they come from `getIndexedUsersForTrack` at
          // line 63, which is deliberately unwrapped so a database outage
          // propagates to the command boundary and the user is told, rather than
          // being shown "Nobody in this server has listened to this".
          //
          // Unlike the identical catch in `whoKnowsArtistService`, the degraded
          // `memberRoles` has NO consumer here: no crown service is wired to the
          // track path, and `whoKnowsBuilders` never reads `.roles`. So the
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
      filteredUsersWithTrack: filteredUsers,
      filterStats,
    };
  }

  public async getFriendUsersForTrack(
    discordGuild: DiscordGuild | null,
    userId: number,
    artistName: string,
    trackName: string,
  ): Promise<WhoKnowsUser[]> {
    const artist = await this.artistRepository.getArtistByName(artistName);
    if (!artist) return [];

    const track = await this.trackRepository.getTrackByNameAndArtist(trackName, artist.artistId);
    if (!track) return [];

    const rows = await this.whoKnowsRepository.getFriendUsersForTrack(
      userId,
      track.trackId,
      discordGuild?.id,
    );

    return rows.map((r) => ({
      userId: r.userId,
      playcount: r.playcount,
      lastFmUsername: r.userNameLastFm ?? `user_${r.userId}`,
      discordName: r.discordName ?? r.userNameLastFm,
    }));
  }

  /**
   * Guild members that must never be named, via the already-injected guild-user
   * repository — so command modules never resolve one out of the container.
   */
  public async getGuildHiddenUserIds(discordGuildId: string): Promise<Set<number>> {
    const guildUsers = await this.guildUserRepository.getGuildUsers(discordGuildId);
    return WhoKnowsService.hiddenGuildUserIds(guildUsers);
  }
}
