import type { IWhoKnowsRepository } from '@domain/interfaces/ports/iwhoKnowsRepository';
import type { IGuildUserRepository, FullGuildUserDetails } from '@domain/interfaces/ports/iguildUserRepository';
import type { GuildService } from '@bot/services/guild/guildService';
import type { User } from '@domain/interfaces/ports/iuserRepository';
import { WhoKnowsService } from '@bot/services/whoKnows/whoKnowsService';
import type { WhoKnowsArtistContext, WhoKnowsRoleRead, WhoKnowsUser } from '@bot/models/whoKnowsModels';
import { isUnknownDiscordMember } from '@domain/errors/discordErrors';
import type { Guild as DiscordGuild } from 'discord.js';
import type { GenreService } from '@bot/services/library/genreService';
import type { CrownService } from '@bot/services/crown/crownService';
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
    // Representative track title for disambiguating same-name artists
    // (see ArtistTrackService.getSampleTrackForArtist).
    sampleTrack?: string,
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
      let memberRoles: WhoKnowsRoleRead | undefined;
      if (gu?.discordUserId && discordGuild) {
        let member = discordGuild.members.cache.get(gu.discordUserId);
        if (!member) {
          // CORRECT AS IS for the CARD, and it is not a database read: this is a
          // Discord API call for a display name, and the fallback is
          // `gu.userNameLastFm` - a real stored name, not a fabricated one. The
          // leaderboard itself (rows, playcounts, and the listener/play/avg
          // footer) never passes through this catch. Those numbers come from
          // `getIndexedUsersForArtist` at line 54, which is deliberately NOT
          // wrapped, so a database outage there propagates to the command
          // boundary and the user gets "Could not reach the database" instead of
          // a table of zeroes. Raising here would delete a complete leaderboard
          // of real people because one nickname could not be fetched.
          //
          // The failure is NOT discarded, though, and that is the part this
          // round changed. It used to leave `memberRoles` `undefined`, and
          // `CrownService.getAndUpdateCrownForArtist` read that as
          // `u.roles ?? []` (crownService.ts) and dropped the user from crown
          // eligibility - so in a guild with `crownRoles` (`.crownroles`) a
          // transient Discord failure could hand the crown to the next person
          // down: a permanent, named claim about two people produced from a
          // role list that was never read. The dominant reason this catch fires
          // is a member who has genuinely left the server, which is why the
          // display name still falls back silently - but "I could not ask" and
          // "they are not here" are different facts and the crown path has to be
          // able to tell them apart.
          //
          // So the catch now records WHICH, and leaves the decision to
          // `CrownService`: `isUnknownDiscordMember` is true only for Discord's
          // own 10007 "Unknown member" (a real absence - they hold no guild
          // role, so a crownRoles guild correctly excludes them), and false for
          // every other failure - 5xx, 403, 50001 Missing Access, 130000
          // overloaded, a socket error - which becomes `unknown` and blocks the
          // crown write. Verified against Discord's JSON Error Codes table and
          // the `DiscordAPIError` shape in `@discordjs/rest`; see
          // `isUnknownDiscordMember` in `domain/errors/discordErrors.ts`.
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
    // The requester gets the SAME treatment as every row, including the fetch
    // on a cache miss. That is not symmetry for its own sake: `CrownService`
    // only ranks people whose roles were read, and a requester with no role
    // state is `unknown`, which blocks the whole crown write. Leaving this
    // cache-only would therefore mean that in a crownRoles guild a requester
    // Discord has not chunked to us silently freezes every crown for that
    // artist - a fresh outage manufactured by the fix itself, out of a role
    // list nobody asked for. One extra REST call, only on the cache miss.
    let requesterRoles: WhoKnowsRoleRead | undefined = requesterMember
      ? { read: true, roles: Array.from(requesterMember.roles.cache.keys()) }
      : undefined;
    if (!requesterRoles && discordGuild && contextUser.discordUserId) {
      try {
        const fetched = await discordGuild.members.fetch(contextUser.discordUserId);
        requesterRoles = { read: true, roles: Array.from(fetched.roles.cache.keys()) };
      } catch (err) {
        requesterRoles = { read: false, absent: isUnknownDiscordMember(err) };
      }
    }
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

    let genres: string[] | undefined;
    if (this.genreService) {
      // CORRECT AS IS. `genres` here is a DECORATION on an otherwise complete
      // card, and the only thing a failure can do to it is make it absent:
      // `whoKnowsBuilders` renders the tag line only when the list is non-empty
      // and has no "genres could not load" affordance, so a dropped connection
      // produces a leaderboard of real people with real playcounts and one
      // fewer footer line - never a wrong number and never a fabricated
      // "this artist has no genres" claim, because nothing renders that.
      // `getFilteredUsersForArtist` is called directly from the `.whoknows`
      // handlers, so raising would delete the whole card over that line, which
      // is the worse lie in the other direction. Same trade as
      // `fmFooterResolver`. The two command modules that re-read genres with a
      // track anchor carry the same reasoning at their own catch sites.
      try { genres = await this.genreService.getGenresForArtist(artistName, sampleTrack); } catch { genres = undefined; }
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
        // CORRECT AS IS: a crown the bot could not compute must render as NO
        // crown, never as a wrong one, and that is what happens. `crownModel`
        // stays null, so the caller derives no `crownMessage` and nobody gets
        // `hasCrown` - the card shows a real leaderboard of real playcounts
        // with no crown marker. That is an absence the user can see and re-run,
        // not a fabricated claim about who leads.
        //
        // This is also deliberately the boundary the deliberate signal lands
        // on. `CrownService.getHolderLivePlaycount` raises rather than treating
        // an unreachable Last.fm as "the holder is not ahead", and this catch is
        // where that raise is absorbed, so the card survives the outage without
        // ever showing a crown nobody verified. Pinned through this real caller
        // by `crownService.liveRecheckUnavailable.test.ts`, which asserts both
        // the null and that `replaceCrown` was never called.
        //
        // Not narrowed to `isSourceUnavailable`, and that is not an oversight:
        // every failure reaching here lands in the same direction - no crown, no
        // marker - so a narrowed catch and a blanket one would render
        // identically, while the blanket one also covers a plain driver error
        // from `getCurrentCrown`. There is no version of narrowing that is
        // safer than what is already here.
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

  /**
   * Guild members that must never be named, via the already-injected guild-user
   * repository — so command modules never resolve one out of the container.
   */
  public async getGuildHiddenUserIds(discordGuildId: string): Promise<Set<number>> {
    const guildUsers = await this.guildUserRepository.getGuildUsers(discordGuildId);
    return WhoKnowsService.hiddenGuildUserIds(guildUsers);
  }
}
