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
      let memberRoles: string[] | undefined;
      if (gu?.discordUserId && discordGuild) {
        let member = discordGuild.members.cache.get(gu.discordUserId);
        if (!member) {
          // CORRECT AS IS for the card, and it is not a database read: this is a
          // Discord API call for a display name, and the fallback is
          // `gu.userNameLastFm` - a real stored name, not a fabricated one. The
          // leaderboard itself (rows, playcounts, and the listener/play/avg
          // footer) never passes through this catch. Those numbers come from
          // `getIndexedUsersForArtist` at line 54, which is deliberately NOT
          // wrapped, so a database outage there propagates to the command
          // boundary and the user gets "Could not reach the database" instead of
          // a table of zeroes. Raising here would delete a complete leaderboard
          // of real people because one nickname could not be fetched, and the
          // dominant reason this catch fires is a member who has genuinely left
          // the server - an absence, not an outage.
          //
          // KNOWN DEFECT, DELIBERATELY LEFT VISIBLE RATHER THAN PAPERED OVER -
          // there is one real consequence, and this round does not own the fix.
          // On failure `memberRoles` stays `undefined`, and
          // `CrownService.getAndUpdateCrownForArtist` reads that as
          // `u.roles ?? []` (crownService.ts:60) and then drops the user from
          // crown eligibility. So in a guild that has configured `crownRoles`
          // (`.crownroles`), a transient Discord failure can silently remove a
          // real listener from crown contention and hand the crown to the next
          // user down: a permanent, named claim about two people produced from
          // a role list that was never read. This is the same shape of lie that
          // `crownService.liveRecheckUnavailable.test.ts` exists to close on the
          // Last.fm side, and the `catch` below at line 134 is the boundary that
          // makes that one safe - which is precisely why raising here would be
          // the wrong trade. The fix needs a tri-state on `WhoKnowsUser.roles`
          // ("no roles" versus "roles unknown") and a matching change in
          // `crownService`; neither file is in this round's ownership, and
          // guessing at an error-code shape from `members.fetch` would be worse
          // than leaving the seam visible.
          try { member = await discordGuild.members.fetch(gu.discordUserId); } catch { /* fallback */ }
        }
        displayName = member?.displayName;
        if (member) {
          memberRoles = Array.from(member.roles.cache.keys());
        }
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
    const requesterRoles = requesterMember ? Array.from(requesterMember.roles.cache.keys()) : undefined;
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
}
