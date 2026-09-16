import type { WhoKnowsUser, FilterStats } from '@bot/models/whoKnowsModels';
import type { FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';
import type { User } from '@domain/interfaces/iuserRepository';
import type { Guild } from '@persistence/domain/models/guild';

export class WhoKnowsService {
  /**
   * Inject or update caller's live playcount in the WhoKnows list.
   */
  public static addOrReplaceUserToIndexList(
    users: WhoKnowsUser[],
    contextUser: User,
    discordDisplayName?: string,
    livePlaycount?: number | null,
    roles?: string[],
  ): WhoKnowsUser[] {
    if (livePlaycount === undefined || livePlaycount === null) {
      return users;
    }

    const filtered = users.filter(
      (u) =>
        u.userId !== contextUser.userId &&
        u.lastFmUsername.toLowerCase() !== contextUser.userNameLastFm.toLowerCase(),
    );

    filtered.push({
      userId: contextUser.userId,
      playcount: livePlaycount,
      lastFmUsername: contextUser.userNameLastFm,
      discordName: discordDisplayName || contextUser.userNameLastFm,
      discordUserId: contextUser.discordUserId,
      lastUsed: contextUser.lastUsed,
      roles,
    });

    return filtered.sort((a, b) => b.playcount - a.playcount);
  }

  /**
   * Filter WhoKnows users based on activity thresholds and block flags.
   */
  public static filterWhoKnowsObjects(
    users: WhoKnowsUser[],
    guildUsers: Map<number, FullGuildUserDetails>,
    guild: Guild | null,
    contextUserId: number,
    filterDisabled: boolean = false,
  ): { filterStats: FilterStats; filteredUsers: WhoKnowsUser[] } {
    const stats: FilterStats = {
      startCount: users.length,
      endCount: users.length,
    };

    if (filterDisabled) {
      const active = users.filter((u) => {
        const gu = guildUsers.get(u.userId);
        return !gu?.whoKnowsBanned;
      });
      stats.endCount = active.length;
      return { filterStats: stats, filteredUsers: active };
    }

    let filtered = users;

    // Filter banned users
    const preBanCount = filtered.length;
    filtered = filtered.filter((u) => {
      const gu = guildUsers.get(u.userId);
      return !gu?.whoKnowsBanned;
    });
    if (preBanCount !== filtered.length) {
      stats.blockedFiltered = preBanCount - filtered.length;
    }

    // Filter by activity if guild setting exists
    if (guild?.whoKnowsActivityThreshold && guild.whoKnowsActivityThreshold > 0) {
      const cutoff = new Date(Date.now() - guild.whoKnowsActivityThreshold * 86400000);
      const preActivityCount = filtered.length;
      filtered = filtered.filter((u) => {
        const gu = guildUsers.get(u.userId);
        if (!gu) return true;
        const lastActivity = gu.lastUsed;
        if (!lastActivity) return true;
        return lastActivity >= cutoff;
      });
      if (preActivityCount !== filtered.length) {
        stats.activityThresholdFiltered = preActivityCount - filtered.length;
      }
    }

    stats.endCount = filtered.length;
    stats.requesterFiltered = !filtered.some((u) => u.userId === contextUserId);

    return { filterStats: stats, filteredUsers: filtered };
  }

  /**
   * Format WhoKnows list to embed description string (14 users max, with unicode alignment and pinned requester).
   */
  /**
   * Format WhoKnows list to embed description string (14 users max, with exact fmbot unicode alignment, crown handling, and pinned requester).
   */
  public static whoKnowsListToString(
    users: WhoKnowsUser[],
    requestedUserId: number,
    closeFriendUserIds?: Set<number>,
    requestedDiscordUserId?: string,
  ): string {
    if (users.length === 0) {
      return 'Nobody in this server has listened to this.';
    }

    const usersToShow = [...users].sort((a, b) => b.playcount - a.playcount);
    const whoKnowsCount = Math.min(usersToShow.length, 14);

    const hasAnyCrown = usersToShow.some((u) => u.hasCrown);
    const spacer = hasAnyCrown ? '\u2005' : '';

    const lines: string[] = [];
    let requestedUserAdded = false;
    const addedUsers = new Set<number>();
    const addedLfm = new Set<string>();

    let indexNumber = 1;

    for (let index = 0; lines.length < whoKnowsCount && index < usersToShow.length; index++) {
      const user = usersToShow[index]!;

      if (addedUsers.has(user.userId) || addedLfm.has(user.lastFmUsername.toLowerCase())) {
        continue;
      }

      const isRequester =
        (requestedDiscordUserId !== undefined && user.discordUserId === requestedDiscordUserId) ||
        user.userId === requestedUserId;

      let nameWithLink = this.nameWithLink(user);
      if (isRequester) {
        nameWithLink = `**${nameWithLink}`;
      }

      let positionCounter = `${spacer}${indexNumber}.`;
      if (isRequester) {
        positionCounter = `**${positionCounter}**\u2006`;
      } else {
        positionCounter = `${positionCounter}\u2004`;
      }

      if (user.hasCrown) {
        positionCounter = '👑\u200A';
      }

      const afterPositionSpacer =
        index + 1 === 10 ? '' : index + 1 === 7 || index + 1 === 9 ? '\u2004' : '\u2005';

      const playsCount = user.playcount.toLocaleString();
      const playsText = user.playcount === 1 ? '1 play' : `${playsCount} plays`;

      if (isRequester) {
        lines.push(`${positionCounter}${afterPositionSpacer}${nameWithLink} - ${playsText}**`);
        requestedUserAdded = true;
      } else {
        const boldPlays = user.playcount === 1 ? '**1** play' : `**${playsCount}** plays`;
        lines.push(`${positionCounter}${afterPositionSpacer}${nameWithLink} - ${boldPlays}`);
      }

      indexNumber += 1;
      addedUsers.add(user.userId);
      addedLfm.add(user.lastFmUsername.toLowerCase());
    }

    // Pin requester at the bottom if outside top 14
    const pinnedUsers: WhoKnowsUser[] = [];
    if (!requestedUserAdded) {
      const req = usersToShow.find((u) =>
        (requestedDiscordUserId !== undefined && u.discordUserId === requestedDiscordUserId) ||
        u.userId === requestedUserId
      );
      if (req) pinnedUsers.push(req);
    }

    // Pin close friends at the bottom if any
    if (closeFriendUserIds && closeFriendUserIds.size > 0) {
      for (const friend of usersToShow) {
        const isReq =
          (requestedDiscordUserId !== undefined && friend.discordUserId === requestedDiscordUserId) ||
          friend.userId === requestedUserId;
        if (
          closeFriendUserIds.has(friend.userId) &&
          !isReq &&
          !addedUsers.has(friend.userId)
        ) {
          pinnedUsers.push(friend);
          addedUsers.add(friend.userId);
        }
      }
    }

    if (pinnedUsers.length > 0) {
      for (const pinned of pinnedUsers) {
        const rank = usersToShow.findIndex((u) => u.userId === pinned.userId) + 1;
        const nameLink = this.nameWithLink(pinned);
        const playsCount = pinned.playcount.toLocaleString();
        const playsText = pinned.playcount === 1 ? '1 play' : `${playsCount} plays`;
        const isRequester =
          (requestedDiscordUserId !== undefined && pinned.discordUserId === requestedDiscordUserId) ||
          pinned.userId === requestedUserId;
        if (isRequester) {
          lines.push(`**${spacer}${rank}.\u2005\u2009${nameLink} - ${playsText}**`);
        } else {
          const boldPlays = pinned.playcount === 1 ? '**1** play' : `**${playsCount}** plays`;
          lines.push(`${spacer}${rank}.\u2005\u2009*${nameLink}* - ${boldPlays}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Generates pages for paginated WhoKnows (10 users per page).
   */
  public static generatePages(
    users: WhoKnowsUser[],
    requestedUserId: number,
    closeFriendUserIds?: Set<number>,
    usersPerPage: number = 10,
    requestedDiscordUserId?: string,
  ): Array<{ lines: string; pageIndex: number; totalPages: number }> {
    const deduplicated: WhoKnowsUser[] = [];
    const addedUsers = new Set<number>();
    const addedLfm = new Set<string>();

    for (const u of users) {
      if (addedUsers.has(u.userId) || addedLfm.has(u.lastFmUsername.toLowerCase())) continue;
      addedUsers.add(u.userId);
      addedLfm.add(u.lastFmUsername.toLowerCase());
      deduplicated.push(u);
    }

    const chunks: WhoKnowsUser[][] = [];
    for (let i = 0; i < deduplicated.length; i += usersPerPage) {
      chunks.push(deduplicated.slice(i, i + usersPerPage));
    }

    if (chunks.length === 0) chunks.push([]);

    const requestedUser = deduplicated.find(
      (u) =>
        (requestedDiscordUserId !== undefined && u.discordUserId === requestedDiscordUserId) ||
        u.userId === requestedUserId,
    );
    const requestedUserIndex = requestedUser ? deduplicated.indexOf(requestedUser) + 1 : -1;

    return chunks.map((chunk, pageIndex) => {
      const pageLines: string[] = [];
      let indexNumber = pageIndex * usersPerPage + 1;
      let requestedOnPage = false;

      for (const user of chunk) {
        const isRequester =
          (requestedDiscordUserId !== undefined && user.discordUserId === requestedDiscordUserId) ||
          user.userId === requestedUserId;
        const playsCount = user.playcount.toLocaleString();
        const playsText = user.playcount === 1 ? '1 play' : `${playsCount} plays`;
        const link = this.nameWithLink(user);

        const playsWord = user.playcount === 1 ? 'play' : 'plays';

        if (user.hasCrown) {
          if (isRequester) {
            pageLines.push(`👑  **${link} - ${playsText}**`);
            requestedOnPage = true;
          } else {
            pageLines.push(`👑  ${link} - **${playsCount}** ${playsWord}`);
          }
        } else {
          const rank = `${indexNumber}.`;
          if (isRequester) {
            pageLines.push(`**${rank}  ${link} - ${playsText}**`);
            requestedOnPage = true;
          } else {
            pageLines.push(`${rank}  ${link} - **${playsCount}** ${playsWord}`);
          }
        }

        indexNumber++;
      }

      if (pageLines.length === 0) {
        pageLines.push('No listeners found.');
      }

      // If page 0 and requester not on page, pin at bottom
      if (pageIndex === 0 && !requestedOnPage && requestedUser) {
        const reqLink = this.nameWithLink(requestedUser);
        const reqPlays = requestedUser.playcount === 1 ? '1 play' : `${requestedUser.playcount.toLocaleString()} plays`;
        pageLines.push(`\n**${requestedUserIndex}.  ${reqLink} - ${reqPlays}**`);
      }

      // Close friends on page 0
      if (pageIndex === 0 && closeFriendUserIds && closeFriendUserIds.size > 0) {
        const shownIds = new Set(chunk.map((u) => u.userId));
        const closeFriendsList: string[] = [];

        for (const cf of deduplicated) {
          if (
            closeFriendUserIds.has(cf.userId) &&
            cf.userId !== requestedUserId &&
            !shownIds.has(cf.userId)
          ) {
            const cfLink = this.nameWithLink(cf);
            const cfPlays = cf.playcount === 1 ? '1 play' : `${cf.playcount.toLocaleString()} plays`;
            const cfRank = deduplicated.indexOf(cf) + 1;
            closeFriendsList.push(`${cfRank}.  *${cfLink}* - **${cfPlays}**`);
          }
        }

        if (closeFriendsList.length > 0) {
          pageLines.push('\n' + closeFriendsList.join('\n'));
        }
      }

      return {
        lines: pageLines.join('\n'),
        pageIndex,
        totalPages: chunks.length,
      };
    });
  }

  public static nameWithLink(user: WhoKnowsUser): string {
    const rawName = user.discordName || user.lastFmUsername;
    const sanitized = rawName
      .replace(/\[/g, '')
      .replace(/\]/g, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim() || user.lastFmUsername;

    const url = `https://last.fm/user/${encodeURIComponent(user.lastFmUsername)}`;
    return `[${sanitized}](${url})`;
  }
}
