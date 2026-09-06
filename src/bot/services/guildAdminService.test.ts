import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GuildAdminService } from './guildAdminService';
import type { IGuildUserRepository, FullGuildUserDetails } from '@domain/interfaces/iguildUserRepository';
import type { IUserRepository, User } from '@domain/interfaces/iuserRepository';
import type { GuildService } from './guild/guildService';
import type { PrismaClient } from '@prisma/client';

describe('GuildAdminService', () => {
  let service: GuildAdminService;
  let mockGuildUserRepo: Partial<IGuildUserRepository>;
  let mockUserRepo: Partial<IUserRepository>;
  let mockGuildService: Partial<GuildService>;
  let mockPrisma: any;

  beforeEach(() => {
    mockGuildUserRepo = {
      getGuildUsers: vi.fn(),
      getUserIdsForGuild: vi.fn(),
      upsertMany: vi.fn(),
      setBlockStatus: vi.fn(),
    };

    mockUserRepo = {
      getUsersByDiscordIds: vi.fn(),
    };

    mockGuildService = {
      setCrownsThreshold: vi.fn(),
      setCrownsActivityThreshold: vi.fn(),
      setCrownsDisabled: vi.fn(),
    };

    mockPrisma = {
      user: {
        findMany: vi.fn(),
      },
      userCrown: {
        groupBy: vi.fn(),
      },
    };

    service = new GuildAdminService(
      mockGuildUserRepo as IGuildUserRepository,
      mockUserRepo as IUserRepository,
      mockGuildService as GuildService,
      mockPrisma as PrismaClient,
    );
  });

  describe('getMembersOverview', () => {
    it('returns empty array when guild has no users', async () => {
      vi.mocked(mockGuildUserRepo.getGuildUsers!).mockResolvedValue([]);

      const result = await service.getMembersOverview('12345');
      expect(result).toEqual([]);
      expect(mockGuildUserRepo.getGuildUsers).toHaveBeenCalledWith('12345');
    });

    it('returns sorted members with playcounts and crowns', async () => {
      const mockGuildUsers: FullGuildUserDetails[] = [
        {
          userId: 1,
          discordUserId: '1001',
          userNameLastFm: 'user_one',
          whoKnowsWhitelisted: false,
          whoKnowsBanned: false,
        },
        {
          userId: 2,
          discordUserId: '1002',
          userNameLastFm: 'user_two',
          whoKnowsWhitelisted: false,
          whoKnowsBanned: true,
        },
      ];
      vi.mocked(mockGuildUserRepo.getGuildUsers!).mockResolvedValue(mockGuildUsers);

      mockPrisma.user.findMany.mockResolvedValue([
        { userId: 1, totalPlayCount: 500 },
        { userId: 2, totalPlayCount: 1500 },
      ]);

      mockPrisma.userCrown.groupBy.mockResolvedValue([
        { userId: 1, _count: { crownId: 5 } },
        { userId: 2, _count: { crownId: 1 } },
      ]);

      const result = await service.getMembersOverview('12345');

      expect(result).toHaveLength(2);
      // User 2 has higher playcount (1500), so should be first
      expect(result[0]!.userId).toBe(2);
      expect(result[0]!.totalPlayCount).toBe(1500);
      expect(result[0]!.crownsCount).toBe(1);
      expect(result[0]!.whoKnowsBanned).toBe(true);

      // User 1 has 500 scrobbles
      expect(result[1]!.userId).toBe(1);
      expect(result[1]!.totalPlayCount).toBe(500);
      expect(result[1]!.crownsCount).toBe(5);
      expect(result[1]!.whoKnowsBanned).toBe(false);
    });
  });

  describe('refreshGuildMembers', () => {
    it('returns zero counts when member list is empty', async () => {
      const res = await service.refreshGuildMembers('12345', []);
      expect(res).toEqual({
        indexedCount: 0,
        totalServerMembers: 0,
        newlyAddedCount: 0,
      });
    });

    it('indexes matching users and identifies newly added members', async () => {
      vi.mocked(mockGuildUserRepo.getUserIdsForGuild!).mockResolvedValue([1]);

      const usersMap = new Map<string, User>();
      usersMap.set('1001', {
        userId: 1,
        discordUserId: '1001',
        userNameLastFm: 'user_one',
        registeredOn: new Date(),
        totalPlayCount: 100,
      } as User);
      usersMap.set('1002', {
        userId: 2,
        discordUserId: '1002',
        userNameLastFm: 'user_two',
        registeredOn: new Date(),
        totalPlayCount: 200,
      } as User);
      vi.mocked(mockUserRepo.getUsersByDiscordIds!).mockResolvedValue(usersMap);

      const res = await service.refreshGuildMembers('12345', ['1001', '1002', '1003']);

      expect(res.totalServerMembers).toBe(3);
      expect(res.indexedCount).toBe(2);
      expect(res.newlyAddedCount).toBe(1); // User 2 is new
      expect(mockGuildUserRepo.upsertMany).toHaveBeenCalledWith('12345', [1, 2]);
    });
  });

  describe('setBlockUser', () => {
    it('calls guildUserRepository.setBlockStatus', async () => {
      await service.setBlockUser('12345', 10, true);
      expect(mockGuildUserRepo.setBlockStatus).toHaveBeenCalledWith('12345', 10, true);
    });
  });

  describe('getBlockedUsers', () => {
    it('returns only users where whoKnowsBanned is true', async () => {
      const users: FullGuildUserDetails[] = [
        { userId: 1, discordUserId: '1001', userNameLastFm: 'u1', whoKnowsWhitelisted: false, whoKnowsBanned: false },
        { userId: 2, discordUserId: '1002', userNameLastFm: 'u2', whoKnowsWhitelisted: false, whoKnowsBanned: true },
      ];
      vi.mocked(mockGuildUserRepo.getGuildUsers!).mockResolvedValue(users);

      const res = await service.getBlockedUsers('12345');
      expect(res).toHaveLength(1);
      expect(res[0]!.userId).toBe(2);
    });
  });

  describe('crown settings delegation', () => {
    it('delegates setCrownThreshold to guildService', async () => {
      await service.setCrownThreshold('12345', 50);
      expect(mockGuildService.setCrownsThreshold).toHaveBeenCalledWith('12345', 50);
    });

    it('delegates setCrownActivityThreshold to guildService', async () => {
      await service.setCrownActivityThreshold('12345', 14);
      expect(mockGuildService.setCrownsActivityThreshold).toHaveBeenCalledWith('12345', 14);
    });

    it('delegates toggleCrowns to guildService', async () => {
      await service.toggleCrowns('12345', true);
      expect(mockGuildService.setCrownsDisabled).toHaveBeenCalledWith('12345', true);
    });
  });
});
