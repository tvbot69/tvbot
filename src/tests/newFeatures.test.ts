import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutopostService } from '@bot/services/autopostService';
import { CrownCommands } from '@bot/textCommands/guild/crownCommands';
import { GuildAdminCommands } from '@bot/textCommands/guild/guildAdminCommands';
import { TrackCommands } from '@bot/textCommands/lastfm/trackCommands';
import { LoginCommands } from '@bot/textCommands/lastfm/loginCommands';
import { ContextModel } from '@bot/models/contextModel';
import { CommandResponse } from '@domain/enums/commandResponse';

describe('New Features Suite', () => {
  describe('AutopostService & AutopostCommands', () => {
    let autopostService: AutopostService;
    let mockArtistsService: any;
    let mockAlbumService: any;
    let mockTrackService: any;
    let mockCrownService: any;
    let mockTelemetryService: any;

    beforeEach(() => {
      mockArtistsService = {};
      mockAlbumService = {};
      mockTrackService = {};
      mockCrownService = {
        getGuildLeaderboard: vi.fn().mockResolvedValue({ entries: [], totalActiveCrowns: 0 }),
      };
      mockTelemetryService = {
        recordCommandExecution: vi.fn(),
      };

      autopostService = new AutopostService(
        mockArtistsService,
        mockAlbumService,
        mockTrackService,
        mockCrownService,
        mockTelemetryService,
      );
    });

    it('sets and retrieves autoposts correctly', () => {
      autopostService.setAutopost({
        id: 'ap-1',
        guildId: 'g1',
        channelId: 'c1',
        schedule: 'Weekly',
        contentType: 'TopArtists',
        enabled: true,
      });

      const list = autopostService.getAutopostsForGuild('g1');
      expect(list).toHaveLength(1);
      expect(list[0]?.contentType).toBe('TopArtists');
    });

    it('toggles autopost enabled state', async () => {
      autopostService.setAutopost({
        id: 'ap-toggle',
        guildId: 'g1',
        channelId: 'c1',
        schedule: 'Daily',
        contentType: 'ServerCrowns',
        enabled: true,
      });

      const toggled = await autopostService.toggleAutopost('ap-toggle');
      expect(toggled?.enabled).toBe(false);

      const toggledAgain = await autopostService.toggleAutopost('ap-toggle');
      expect(toggledAgain?.enabled).toBe(true);
    });

    it('removes autoposts', () => {
      autopostService.setAutopost({
        id: 'ap-del',
        guildId: 'g1',
        channelId: 'c1',
        schedule: 'Monthly',
        contentType: 'TopAlbums',
        enabled: true,
      });

      expect(autopostService.removeAutopost('ap-del')).toBe(true);
      expect(autopostService.getAutopostsForGuild('g1')).toHaveLength(0);
    });
  });

  describe('Crown Moderation Commands', () => {
    let crownCommands: CrownCommands;
    let mockUserService: any;
    let mockCrownService: any;
    let mockLastfmRepo: any;
    let mockArtistsService: any;
    let mockUpdateService: any;

    beforeEach(() => {
      mockUserService = {
        getUserByDiscordId: vi.fn().mockResolvedValue({ userId: 1, userNameLastFm: 'tester', discordUserId: '111' }),
        getUserByLastFmName: vi.fn().mockResolvedValue({ userId: 1, userNameLastFm: 'tester', discordUserId: '111' }),
      };
      mockCrownService = {
        killCrown: vi.fn().mockResolvedValue(true),
        removeUserCrowns: vi.fn().mockResolvedValue(5),
        setCrownBlock: vi.fn().mockResolvedValue(undefined),
        getBlockedCrownUsers: vi.fn().mockResolvedValue([
          { userId: 1, userNameLastFm: 'tester', discordUserId: '111' },
        ]),
        setCrownRole: vi.fn().mockResolvedValue(undefined),
        getCrownRoles: vi.fn().mockResolvedValue(['999']),
        killAllCrowns: vi.fn().mockResolvedValue(10),
      };
      mockLastfmRepo = {};
      mockArtistsService = {};
      mockUpdateService = {};

      crownCommands = new CrownCommands(
        mockUserService,
        mockCrownService,
        mockLastfmRepo,
        mockArtistsService,
        mockUpdateService,
      );
    });

    const createAdminContext = (guildId = '123') => {
      const ctx = new ContextModel();
      ctx.guildId = guildId as any;
      ctx.discordUserId = '111' as any;
      ctx.prefix = '.';
      // mock admin
      Object.defineProperty(ctx, 'userIsGuildAdmin', { get: () => true });
      return ctx;
    };

    it('registers all crown moderation commands', () => {
      const names = crownCommands.commands.map((c) => c.name);
      expect(names).toContain('killcrown');
      expect(names).toContain('removeusercrowns');
      expect(names).toContain('crownblock');
      expect(names).toContain('crownunblock');
      expect(names).toContain('crownblockedusers');
      expect(names).toContain('crownroles');
      expect(names).toContain('killallcrowns');
    });

    it('kills crown for artist', async () => {
      const cmd = crownCommands.commands.find((c) => c.name === 'killcrown')!;
      const res = await cmd.executeAsync(createAdminContext(), ['Radiohead']);
      expect(res.commandResponse).toBe(CommandResponse.Ok);
      expect(mockCrownService.killCrown).toHaveBeenCalledWith('123', 'Radiohead');
    });

    it('removes crowns from user', async () => {
      const cmd = crownCommands.commands.find((c) => c.name === 'removeusercrowns')!;
      const res = await cmd.executeAsync(createAdminContext(), ['<@111>']);
      expect(res.commandResponse).toBe(CommandResponse.Ok);
      expect(mockCrownService.removeUserCrowns).toHaveBeenCalledWith('123', 1);
    });

    it('blocks and unblocks user from crowns', async () => {
      const blockCmd = crownCommands.commands.find((c) => c.name === 'crownblock')!;
      const blockRes = await blockCmd.executeAsync(createAdminContext(), ['<@111>']);
      expect(blockRes.commandResponse).toBe(CommandResponse.Ok);
      expect(mockCrownService.setCrownBlock).toHaveBeenCalledWith('123', 1, true);

      const unblockCmd = crownCommands.commands.find((c) => c.name === 'crownunblock')!;
      const unblockRes = await unblockCmd.executeAsync(createAdminContext(), ['<@111>']);
      expect(unblockRes.commandResponse).toBe(CommandResponse.Ok);
      expect(mockCrownService.setCrownBlock).toHaveBeenCalledWith('123', 1, false);
    });

    it('lists crown blocked users', async () => {
      const cmd = crownCommands.commands.find((c) => c.name === 'crownblockedusers')!;
      const res = await cmd.executeAsync(createAdminContext(), []);
      expect(res.commandResponse).toBe(CommandResponse.Ok);
      expect(res.embed.data.description).toContain('tester');
    });

    it('sets and removes crown role', async () => {
      const cmd = crownCommands.commands.find((c) => c.name === 'crownroles')!;
      const setRes = await cmd.executeAsync(createAdminContext(), ['<@&555>']);
      expect(setRes.commandResponse).toBe(CommandResponse.Ok);
      expect(mockCrownService.setCrownRole).toHaveBeenCalledWith('123', '555');

      const removeRes = await cmd.executeAsync(createAdminContext(), ['none']);
      expect(removeRes.commandResponse).toBe(CommandResponse.Ok);
      expect(mockCrownService.setCrownRole).toHaveBeenCalledWith('123', null);
    });

    it('requires confirmation to kill all crowns', async () => {
      const cmd = crownCommands.commands.find((c) => c.name === 'killallcrowns')!;
      const noConfirmRes = await cmd.executeAsync(createAdminContext(), []);
      expect(noConfirmRes.commandResponse).toBe(CommandResponse.WrongInput);
      expect(mockCrownService.killAllCrowns).not.toHaveBeenCalled();

      const confirmRes = await cmd.executeAsync(createAdminContext(), ['confirm']);
      expect(confirmRes.commandResponse).toBe(CommandResponse.Ok);
      expect(mockCrownService.killAllCrowns).toHaveBeenCalledWith('123');
    });
  });

  describe('Guild Admin Prefix & Command Toggles', () => {
    let guildAdminCommands: GuildAdminCommands;
    let mockGuildService: any;
    let mockGuildAdminService: any;
    let mockUserService: any;
    let mockPrefixService: any;
    let mockGuildDisabledCommandService: any;

    beforeEach(() => {
      mockGuildService = { getGuild: vi.fn() };
      mockGuildAdminService = {};
      mockUserService = {};
      mockPrefixService = {
        getPrefix: vi.fn().mockResolvedValue('!'),
        setPrefix: vi.fn().mockResolvedValue(undefined),
      };
      mockGuildDisabledCommandService = {
        isCommandDisabled: vi.fn().mockResolvedValue(false),
        addDisabledCommand: vi.fn().mockResolvedValue(undefined),
        removeDisabledCommand: vi.fn().mockResolvedValue(undefined),
        getDisabledCommands: vi.fn().mockResolvedValue(['ping']),
      };

      guildAdminCommands = new GuildAdminCommands(
        mockGuildService,
        mockGuildAdminService,
        mockUserService,
        mockPrefixService,
        mockGuildDisabledCommandService,
      );
    });

    const createAdminContext = (guildId = '123') => {
      const ctx = new ContextModel();
      ctx.guildId = guildId as any;
      ctx.discordUserId = '111' as any;
      ctx.prefix = '!';
      Object.defineProperty(ctx, 'userIsGuildAdmin', { get: () => true });
      return ctx;
    };

    it('sets server prefix', async () => {
      const cmd = guildAdminCommands.commands.find((c) => c.name === 'prefix')!;
      const res = await cmd.executeAsync(createAdminContext(), ['+']);
      expect(res.commandResponse).toBe(CommandResponse.Ok);
      expect(mockPrefixService.setPrefix).toHaveBeenCalledWith('123', '+');
    });

    it('toggles command disabled status', async () => {
      const cmd = guildAdminCommands.commands.find((c) => c.name === 'togglecommand')!;
      const res = await cmd.executeAsync(createAdminContext(), ['chart']);
      expect(res.commandResponse).toBe(CommandResponse.Ok);
      expect(mockGuildDisabledCommandService.addDisabledCommand).toHaveBeenCalledWith('123', 'chart');
    });

    it('lists disabled commands', async () => {
      const cmd = guildAdminCommands.commands.find((c) => c.name === 'disabledcommands')!;
      const res = await cmd.executeAsync(createAdminContext(), []);
      expect(res.commandResponse).toBe(CommandResponse.Ok);
      expect(res.embed.data.description).toContain('ping');
    });
  });

  describe('Standalone Lyrics Command', () => {
    let trackCommands: TrackCommands;
    let mockUserService: any;
    let mockTrackService: any;
    let mockTrackDetailsService: any;
    let mockLastfmRepository: any;
    let mockUpdateService: any;
    let mockLyricsService: any;

    beforeEach(() => {
      mockUserService = {
        getUserByDiscordId: vi.fn().mockResolvedValue({ userId: 1, userNameLastFm: 'tester' }),
      };
      mockTrackService = {};
      mockTrackDetailsService = {};
      mockLastfmRepository = {
        getUserRecentTracks: vi.fn().mockResolvedValue([
          { name: 'Paranoid Android', artistName: 'Radiohead' },
        ]),
      };
      mockUpdateService = {};
      mockLyricsService = {
        getLyrics: vi.fn().mockResolvedValue({
          title: 'Paranoid Android',
          artist: 'Radiohead',
          plainLyrics: 'Please could you stop the noise...',
          source: 'lrclib',
        }),
      };

      trackCommands = new TrackCommands(
        mockUserService,
        mockTrackService,
        mockTrackDetailsService,
        mockLastfmRepository,
        mockUpdateService,
        mockLyricsService,
      );
    });

    it('fetches lyrics for query', async () => {
      const cmd = trackCommands.commands.find((c) => c.name === 'lyrics')!;
      const ctx = new ContextModel();
      ctx.discordUserId = '111' as any;
      const res = await cmd.executeAsync(ctx, ['Radiohead - Paranoid Android']);
      expect(res.commandResponse).toBe(CommandResponse.Ok);
      expect(mockLyricsService.getLyrics).toHaveBeenCalledWith('Paranoid Android', 'Radiohead');
      expect(res.embed.data.description).toContain('Please could you stop the noise');
    });

    it('fetches lyrics for now playing if no query provided', async () => {
      const cmd = trackCommands.commands.find((c) => c.name === 'lyrics')!;
      const ctx = new ContextModel();
      ctx.discordUserId = '111' as any;
      const res = await cmd.executeAsync(ctx, []);
      expect(res.commandResponse).toBe(CommandResponse.Ok);
      expect(mockLastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('tester', 1);
      expect(mockLyricsService.getLyrics).toHaveBeenCalledWith('Paranoid Android', 'Radiohead');
    });
  });

  describe('Account Unlink / Removal', () => {
    let loginCommands: LoginCommands;
    let mockLoginService: any;
    let mockUserService: any;
    let mockComponentTracker: any;

    beforeEach(() => {
      mockLoginService = {};
      mockUserService = {
        getUserByDiscordId: vi.fn().mockResolvedValue({ userId: 1, userNameLastFm: 'tester' }),
        removeUser: vi.fn().mockResolvedValue(true),
      };
      mockComponentTracker = { register: vi.fn() };

      loginCommands = new LoginCommands(
        mockLoginService,
        mockUserService,
        mockComponentTracker,
      );
    });

    it('asks for confirmation before removing account', async () => {
      const cmd = loginCommands.commands.find((c) => c.name === 'remove')!;
      const ctx = new ContextModel();
      ctx.discordUserId = '111' as any;
      ctx.prefix = '.';
      const res = await cmd.executeAsync(ctx, []);
      expect(res.embed.data.title).toContain('Account Deletion');
      expect(res.embed.data.description).toContain('.remove confirm');
      expect(mockUserService.removeUser).not.toHaveBeenCalled();
    });

    it('deletes account when confirmed', async () => {
      const cmd = loginCommands.commands.find((c) => c.name === 'remove')!;
      const ctx = new ContextModel();
      ctx.discordUserId = '111' as any;
      ctx.prefix = '.';
      const res = await cmd.executeAsync(ctx, ['confirm']);
      expect(res.commandResponse).toBe(CommandResponse.Ok);
      expect(mockUserService.removeUser).toHaveBeenCalledWith('111');
      expect(res.embed.data.description).toContain('Successfully deleted your account');
    });
  });
});
