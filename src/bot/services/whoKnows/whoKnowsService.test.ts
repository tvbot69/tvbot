import { describe, it, expect } from 'vitest';
import { WhoKnowsService } from './whoKnowsService';
import type { WhoKnowsUser } from '@bot/models/whoKnowsModels';
import type { FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';
import type { User } from '@domain/interfaces/iuserRepository';
import { UserType, DataSource } from '@persistence/domain/models/user';
import { PrivacyLevel } from '@domain/enums/privacyLevel';
import type { Guild } from '@persistence/domain/models/guild';

describe('WhoKnowsService', () => {
  it('formats whoKnows list with proper ranking, padding, and bolding for requester', () => {
    const users: WhoKnowsUser[] = [
      { userId: 1, playcount: 1500, lastFmUsername: 'alice', discordName: 'Alice' },
      { userId: 2, playcount: 850, lastFmUsername: 'bob', discordName: 'Bob' },
      { userId: 3, playcount: 42, lastFmUsername: 'charlie', discordName: 'Charlie' },
    ];

    const formatted = WhoKnowsService.whoKnowsListToString(users, 2);
    expect(formatted).toContain('Alice');
    expect(formatted).toContain('https://last.fm/user/alice');
    expect(formatted).toContain('1,500 plays');
    // Caller row is bolded
    expect(formatted).toContain('**[⁦Bob⁩](https://last.fm/user/bob) - 850 plays**');
    expect(formatted).toContain('Charlie');
  });

  it('adds pinned requester row if caller is ranked below 14', () => {
    const users: WhoKnowsUser[] = [];
    for (let i = 1; i <= 20; i++) {
      users.push({
        userId: i,
        playcount: 1000 - i * 10,
        lastFmUsername: `user_${i}`,
        discordName: `User ${i}`,
      });
    }

    const formatted = WhoKnowsService.whoKnowsListToString(users, 18);
    expect(formatted).toContain('14.');
    expect(formatted).toContain('User 14');
    expect(formatted).toContain('18.');
    expect(formatted).toContain('User 18');
    expect(formatted).toContain('820 plays');
  });

  it('filters blocked users and inactive users when filter is enabled', () => {
    const users: WhoKnowsUser[] = [
      { userId: 1, playcount: 100, lastFmUsername: 'active_user' },
      { userId: 2, playcount: 50, lastFmUsername: 'blocked_user' },
      { userId: 3, playcount: 30, lastFmUsername: 'inactive_user' },
    ];

    const guildUserMap = new Map<number, FullGuildUserDetails>();
    guildUserMap.set(1, {
      userId: 1,
      discordUserId: 'd1',
      userNameLastFm: 'active_user',
      whoKnowsWhitelisted: false,
      whoKnowsBanned: false,
      lastUsed: new Date(),
    });
    guildUserMap.set(2, {
      userId: 2,
      discordUserId: 'd2',
      userNameLastFm: 'blocked_user',
      whoKnowsWhitelisted: false,
      whoKnowsBanned: true,
      lastUsed: new Date(),
    });
    guildUserMap.set(3, {
      userId: 3,
      discordUserId: 'd3',
      userNameLastFm: 'inactive_user',
      whoKnowsWhitelisted: false,
      whoKnowsBanned: false,
      lastUsed: new Date(Date.now() - 200 * 86400000), // 200 days old
    });

    const guild: Guild = {
      guildId: 'g1',
      guildName: 'Test Guild',
      guildCreatedOn: new Date(),
      commandsDisabled: false,
      emotesDisabled: false,
      whoKnowsActivityThreshold: 90,
    };

    const { filterStats, filteredUsers } = WhoKnowsService.filterWhoKnowsObjects(
      users,
      guildUserMap,
      guild,
      1,
      false,
    );

    expect(filterStats.blockedFiltered).toBe(1);
    expect(filterStats.activityThresholdFiltered).toBe(1);
    expect(filteredUsers.length).toBe(1);
    expect(filteredUsers[0]!.userId).toBe(1);
  });

  it('addOrReplaceUserToIndexList updates caller live playcount in list', () => {
    const users: WhoKnowsUser[] = [
      { userId: 1, playcount: 10, lastFmUsername: 'alice' },
      { userId: 2, playcount: 50, lastFmUsername: 'bob' },
    ];

    const caller: User = {
      userId: 1,
      userNameLastFm: 'alice',
      discordUserId: 'd1',
      registeredOn: new Date(),
      userType: UserType.User,
      dataSource: DataSource.LastFm,
      privacyLevel: PrivacyLevel.Default,
    };

    const updated = WhoKnowsService.addOrReplaceUserToIndexList(users, caller, 'Alice Caller', 99);
    expect(updated[0]!.userId).toBe(1);
    expect(updated[0]!.playcount).toBe(99);
    expect(updated[0]!.discordName).toBe('Alice Caller');
  });
});
