import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutopostService } from '@bot/services/charts/autopostService';
import { CrownCommands } from '@bot/textCommands/guild/crownCommands';
import { GuildAdminCommands } from '@bot/textCommands/guild/guildAdminCommands';
import { TrackCommands } from '@bot/textCommands/lastfm/trackCommands';
import { LoginCommands } from '@bot/textCommands/lastfm/loginCommands';
import { ContextModel } from '@bot/models/contextModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { TelemetryService } from '@bot/services/system/telemetryService';
import { CrownService } from '@bot/services/crown/crownService';
import { UserService } from '@bot/services/user/userService';
import { LoginService } from '@bot/services/user/loginService';
import { PrefixService } from '@bot/services/user/prefixService';
import { UpdateService } from '@bot/services/lastfm/updateService';
import { GuildService } from '@bot/services/guild/guildService';
import { GuildAdminService } from '@bot/services/guild/guildAdminService';
import { GuildDisabledCommandService } from '@bot/services/guild/guildDisabledCommandService';
import { ComponentInteractionTracker } from '@bot/services/system/componentInteractionTracker';
import { UserType, DataSource } from '@persistence/models/user';
import { PrivacyLevel } from '@domain/enums/privacyLevel';
import type { ArtistsService } from '@bot/services/library/artistsService';
import type { AlbumService } from '@bot/services/library/albumService';
import type { TrackService } from '@bot/services/library/trackService';
import type { TrackDetailsService } from '@bot/services/audio/trackDetailsService';
import type { LyricsService } from '@bot/services/music/lyricsService';
import type { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type { User } from '@domain/interfaces/ports/iuserRepository';

/**
 * Typed partial double for a class-shaped dependency.
 *
 * `Partial<T>` carries the REAL signature of every member the test supplies, so a
 * production signature change breaks this file at compile time instead of letting a
 * mis-shaped `any` double keep passing. Members the test does not supply stay ABSENT,
 * so production reaching for one throws instead of silently reading `undefined` off an
 * unconstrained object. Duplicated verbatim from `oauthActions.test.ts` because a
 * shared helper module would be scored as production source by `count-debt.ts`
 * (it only skips `*.test.ts`).
 */
const stub = <T>(partial: Partial<T>): T => partial as T;

/** A complete `User`: `getUserByDiscordId` returns `User | null`, not a loose shape. */
const user = (over: Partial<User> = {}): User => ({
  userId: 1,
  discordUserId: '111',
  userNameLastFm: 'tester',
  registeredOn: new Date('2024-01-01T00:00:00Z'),
  userType: UserType.User,
  dataSource: DataSource.LastFm,
  privacyLevel: PrivacyLevel.Default,
  ...over,
});

describe('New Features Suite', () => {
  describe('AutopostService & AutopostCommands', () => {
    let autopostService: AutopostService;
    let mockArtistsService: ArtistsService;
    let mockAlbumService: AlbumService;
    let mockTrackService: TrackService;
    let mockCrownService: CrownService;
    let mockTelemetryService: TelemetryService;

    beforeEach(() => {
      mockArtistsService = stub<ArtistsService>({});
      mockAlbumService = stub<AlbumService>({});
      mockTrackService = stub<TrackService>({});
      mockCrownService = stub<CrownService>({
        getGuildLeaderboard: vi.fn<CrownService['getGuildLeaderboard']>().mockResolvedValue({
          entries: [],
          totalActiveCrowns: 0,
        }),
      });
      mockTelemetryService = stub<TelemetryService>({
        recordCommandExecution: vi.fn<TelemetryService['recordCommandExecution']>(),
      });

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
    let mockUserService: UserService;
    let mockCrownService: CrownService;
    let mockLastfmRepo: LastFmRepository;
    let mockArtistsService: ArtistsService;
    let mockUpdateService: UpdateService;

    beforeEach(() => {
      mockUserService = stub<UserService>({
        getUserByDiscordId: vi.fn<UserService['getUserByDiscordId']>().mockResolvedValue(user()),
        getUserByLastFmName: vi.fn<UserService['getUserByLastFmName']>().mockResolvedValue(user()),
      });
      mockCrownService = stub<CrownService>({
        killCrown: vi.fn<CrownService['killCrown']>().mockResolvedValue(true),
        removeUserCrowns: vi.fn<CrownService['removeUserCrowns']>().mockResolvedValue(5),
        setCrownBlock: vi.fn<CrownService['setCrownBlock']>().mockResolvedValue(undefined),
        getBlockedCrownUsers: vi.fn<CrownService['getBlockedCrownUsers']>().mockResolvedValue([
          { userId: 1, userNameLastFm: 'tester', discordUserId: '111' },
        ]),
        setCrownRole: vi.fn<CrownService['setCrownRole']>().mockResolvedValue(undefined),
        getCrownRoles: vi.fn<CrownService['getCrownRoles']>().mockResolvedValue(['999']),
        killAllCrowns: vi.fn<CrownService['killAllCrowns']>().mockResolvedValue(10),
      });
      mockLastfmRepo = stub<LastFmRepository>({});
      mockArtistsService = stub<ArtistsService>({});
      mockUpdateService = stub<UpdateService>({});

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
      ctx.guildId = guildId;
      ctx.discordUserId = '111';
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
    let mockGuildService: GuildService;
    let mockGuildAdminService: GuildAdminService;
    let mockUserService: UserService;
    let mockPrefixService: PrefixService;
    let mockGuildDisabledCommandService: GuildDisabledCommandService;

    beforeEach(() => {
      mockGuildService = stub<GuildService>({ getGuild: vi.fn<GuildService['getGuild']>() });
      mockGuildAdminService = stub<GuildAdminService>({});
      mockUserService = stub<UserService>({});
      mockPrefixService = stub<PrefixService>({
        getPrefix: vi.fn<PrefixService['getPrefix']>().mockResolvedValue('!'),
        setPrefix: vi.fn<PrefixService['setPrefix']>().mockResolvedValue(undefined),
      });
      mockGuildDisabledCommandService = stub<GuildDisabledCommandService>({
        isCommandDisabled: vi.fn<GuildDisabledCommandService['isCommandDisabled']>().mockResolvedValue(false),
        addDisabledCommand: vi.fn<GuildDisabledCommandService['addDisabledCommand']>().mockResolvedValue(undefined),
        removeDisabledCommand: vi.fn<GuildDisabledCommandService['removeDisabledCommand']>().mockResolvedValue(undefined),
        getDisabledCommands: vi.fn<GuildDisabledCommandService['getDisabledCommands']>().mockResolvedValue(['ping']),
      });

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
      ctx.guildId = guildId;
      ctx.discordUserId = '111';
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
    let mockUserService: UserService;
    let mockTrackService: TrackService;
    let mockTrackDetailsService: TrackDetailsService;
    let mockLastfmRepository: LastFmRepository;
    let mockUpdateService: UpdateService;
    let mockLyricsService: LyricsService;

    beforeEach(() => {
      mockUserService = stub<UserService>({
        getUserByDiscordId: vi.fn<UserService['getUserByDiscordId']>().mockResolvedValue(user()),
      });
      mockTrackService = stub<TrackService>({});
      mockTrackDetailsService = stub<TrackDetailsService>({});
      mockLastfmRepository = stub<LastFmRepository>({
        getUserRecentTracks: vi.fn<LastFmRepository['getUserRecentTracks']>().mockResolvedValue([
          { name: 'Paranoid Android', artistName: 'Radiohead', albumName: 'OK Computer', nowPlaying: false },
        ]),
      });
      mockUpdateService = stub<UpdateService>({});
      mockLyricsService = stub<LyricsService>({
        getLyrics: vi.fn<LyricsService['getLyrics']>().mockResolvedValue({
          title: 'Paranoid Android',
          artist: 'Radiohead',
          plainLyrics: 'Please could you stop the noise...',
          instrumental: false,
          source: 'lrclib',
        }),
      });

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
      const cmd = trackCommands.commands.find((c) => c.name === 'lyric')!;
      const ctx = new ContextModel();
      ctx.discordUserId = '111';
      const res = await cmd.executeAsync(ctx, ['Radiohead - Paranoid Android']);
      expect(res.commandResponse).toBe(CommandResponse.Ok);
      expect(mockLyricsService.getLyrics).toHaveBeenCalledWith('Paranoid Android', 'Radiohead');
      expect(res.embed.data.description).toContain('Please could you stop the noise');
    });

    it('fetches lyrics for now playing if no query provided', async () => {
      const cmd = trackCommands.commands.find((c) => c.name === 'lyric')!;
      const ctx = new ContextModel();
      ctx.discordUserId = '111';
      const res = await cmd.executeAsync(ctx, []);
      expect(res.commandResponse).toBe(CommandResponse.Ok);
      expect(mockLastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('tester', 1, 1, undefined, undefined);
      expect(mockLyricsService.getLyrics).toHaveBeenCalledWith('Paranoid Android', 'Radiohead');
    });
  });

  describe('Account Unlink / Removal', () => {
    let loginCommands: LoginCommands;
    let mockLoginService: LoginService;
    let mockUserService: UserService;
    let mockComponentTracker: ComponentInteractionTracker;

    beforeEach(() => {
      mockLoginService = stub<LoginService>({});
      mockUserService = stub<UserService>({
        getUserByDiscordId: vi.fn<UserService['getUserByDiscordId']>().mockResolvedValue(user()),
        removeUser: vi.fn<UserService['removeUser']>().mockResolvedValue(true),
      });
      mockComponentTracker = stub<ComponentInteractionTracker>({
        register: vi.fn<ComponentInteractionTracker['register']>(),
      });

      loginCommands = new LoginCommands(
        mockLoginService,
        mockUserService,
        mockComponentTracker,
      );
    });

    it('asks for confirmation before removing account', async () => {
      const cmd = loginCommands.commands.find((c) => c.name === 'unlink')!;
      const ctx = new ContextModel();
      ctx.discordUserId = '111';
      ctx.prefix = '.';
      const res = await cmd.executeAsync(ctx, []);
      expect(res.embed.data.title).toContain('Account Deletion');
      expect(res.embed.data.description).toContain('.unlink confirm');
      expect(mockUserService.removeUser).not.toHaveBeenCalled();
    });

    it('deletes account when confirmed', async () => {
      const cmd = loginCommands.commands.find((c) => c.name === 'unlink')!;
      const ctx = new ContextModel();
      ctx.discordUserId = '111';
      ctx.prefix = '.';
      const res = await cmd.executeAsync(ctx, ['confirm']);
      expect(res.commandResponse).toBe(CommandResponse.Ok);
      expect(mockUserService.removeUser).toHaveBeenCalledWith('111');
      expect(res.embed.data.description).toContain('Successfully deleted your account');
    });
  });
});