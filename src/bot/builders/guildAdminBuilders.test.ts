import { describe, it, expect } from 'vitest';
import { GuildAdminBuilders } from './guildAdminBuilders';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { Guild } from '@persistence/domain/models/guild';

describe('GuildAdminBuilders', () => {
  const dummyGuild: Guild = {
    guildId: '123456789012345678',
    guildName: 'Test Guild',
    prefix: '.',
    accentColor: 0xba0000,
    commandsDisabled: false,
    emotesDisabled: false,
    guildCreatedOn: new Date(),
    crownsDisabled: false,
    crownsMinimumPlaycountThreshold: 30,
    crownsActivityThresholdDays: 14,
    crownRoles: [],
  };

  describe('buildGuildDashboard', () => {
    it('creates a dashboard container for guild configuration', () => {
      const response = GuildAdminBuilders.buildGuildDashboard({
        guild: dummyGuild,
        prefix: '.',
        blockedCount: 2,
        memberCount: 50,
        accentColor: 0xba0000,
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildMembersOverviewResponse', () => {
    it('creates container with member list', () => {
      const response = GuildAdminBuilders.buildMembersOverviewResponse({
        guildName: 'Test Guild',
        members: [
          {
            userId: 1,
            discordUserId: '1001',
            userNameLastFm: 'user_one',
            totalPlayCount: 15000,
            crownsCount: 4,
            whoKnowsBanned: false,
          },
          {
            userId: 2,
            discordUserId: '1002',
            userNameLastFm: 'user_two',
            totalPlayCount: 5000,
            crownsCount: 0,
            whoKnowsBanned: true,
          },
        ],
        page: 1,
        pageSize: 10,
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });

    it('creates container with empty message when no members exist', () => {
      const response = GuildAdminBuilders.buildMembersOverviewResponse({
        guildName: 'Test Guild',
        members: [],
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildBlockedUsersResponse', () => {
    it('creates container with blocked users', () => {
      const response = GuildAdminBuilders.buildBlockedUsersResponse({
        guildName: 'Test Guild',
        blocked: [
          {
            userId: 2,
            discordUserId: '1002',
            userNameLastFm: 'banned_user',
            whoKnowsWhitelisted: false,
            whoKnowsBanned: true,
          },
        ],
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });

    it('creates container when no blocked users exist', () => {
      const response = GuildAdminBuilders.buildBlockedUsersResponse({
        guildName: 'Test Guild',
        blocked: [],
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildRefreshResultResponse', () => {
    it('creates refresh summary container', () => {
      const response = GuildAdminBuilders.buildRefreshResultResponse({
        guildName: 'Test Guild',
        result: {
          indexedCount: 45,
          newlyAddedCount: 5,
          totalServerMembers: 120,
        },
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildBlockSuccessResponse', () => {
    it('creates block confirmation message', () => {
      const response = GuildAdminBuilders.buildBlockSuccessResponse({
        discordUserId: '1002',
        userNameLastFm: 'banned_user',
        blocked: true,
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });

    it('creates unblock confirmation message', () => {
      const response = GuildAdminBuilders.buildBlockSuccessResponse({
        discordUserId: '1002',
        userNameLastFm: 'banned_user',
        blocked: false,
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });

  describe('buildCrownSettingSuccessResponse', () => {
    it('creates crown setting confirmation container', () => {
      const response = GuildAdminBuilders.buildCrownSettingSuccessResponse({
        settingName: 'Minimum Playcount Threshold',
        value: 50,
      });

      expect(response.commandResponse).toBe(CommandResponse.Ok);
      expect(response.componentsV2Container).toBeDefined();
    });
  });
});
