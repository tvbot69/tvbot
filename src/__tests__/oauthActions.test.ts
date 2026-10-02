import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TrackCommands } from '@bot/textCommands/lastfm/trackCommands';
import { TrackSlashCommands } from '@bot/slashCommands/library/trackSlashCommands';
import { NowPlayingInteractions } from '@bot/interactions/music/nowPlayingInteractions';
import { ContextModel } from '@bot/models/contextModel';
import { CommandResponse } from '@domain/enums/commandResponse';
import { UserService } from '@bot/services/user/userService';
import { TrackService } from '@bot/services/library/trackService';
import { TrackDetailsService } from '@bot/services/audio/trackDetailsService';
import { UpdateService } from '@bot/services/lastfm/updateService';
import { UserType, DataSource } from '@persistence/models/user';
import { PrivacyLevel } from '@domain/enums/privacyLevel';
import type { UserRepository } from '@persistence/repositories/userRepository';
import type { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type { User } from '@domain/interfaces/ports/iuserRepository';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';

/**
 * Typed partial double for a class-shaped dependency.
 *
 * `Partial<T>` carries the REAL signature of every member the test supplies, so a
 * production signature change breaks this file at compile time instead of letting a
 * mis-shaped `any` double keep passing. Members the test does not supply stay ABSENT,
 * so production reaching for one throws instead of silently reading `undefined` off an
 * unconstrained object. `newFeatures.test.ts` and the two other suites in this folder
 * use the same helper; it is four lines and cannot be shared without a helper module
 * that `count-debt.ts` would score as production source (it only skips `*.test.ts`).
 */
const stub = <T>(partial: Partial<T>): T => partial as T;

/** A complete `User`: the oauth paths read `sessionKey`, so it is the field under test. */
const sampleUser = (over: Partial<User> = {}): User => ({
  userId: 1,
  discordUserId: '123456789',
  userNameLastFm: 'MohaTest',
  registeredOn: new Date('2024-01-01T00:00:00Z'),
  userType: UserType.User,
  dataSource: DataSource.LastFm,
  privacyLevel: PrivacyLevel.Default,
  sessionKey: 'test-session-key-xyz',
  ...over,
});

describe('OAuth Actions (love, unlove, loved, scrobble)', () => {
  let mockUserService: UserService;
  let mockTrackService: TrackService;
  let mockTrackDetailsService: TrackDetailsService;
  let mockLastfmRepository: LastFmRepository;
  let mockUpdateService: UpdateService;
  let mockUserRepository: UserRepository;

  beforeEach(() => {
    mockUserService = stub<UserService>({
      getUserByDiscordId: vi.fn<UserService['getUserByDiscordId']>().mockResolvedValue(sampleUser()),
    });
    mockUserRepository = stub<UserRepository>({
      getUserByDiscordUserId: vi.fn<UserRepository['getUserByDiscordUserId']>().mockResolvedValue(sampleUser()),
    });
    mockTrackService = stub<TrackService>({
      searchTrack: vi.fn<TrackService['searchTrack']>(),
      getScrobbleReference: vi.fn<TrackService['getScrobbleReference']>(),
    });
    mockTrackDetailsService = stub<TrackDetailsService>({
      getDetails: vi.fn<TrackDetailsService['getDetails']>(),
    });
    mockLastfmRepository = stub<LastFmRepository>({
      loveTrack: vi.fn<LastFmRepository['loveTrack']>().mockResolvedValue(true),
      unloveTrack: vi.fn<LastFmRepository['unloveTrack']>().mockResolvedValue(true),
      getLovedTracks: vi.fn<LastFmRepository['getLovedTracks']>().mockResolvedValue({
        tracks: [
          { name: 'Karma Police', artistName: 'Radiohead', playcount: 10 },
          { name: 'Enjoy The Silence', artistName: 'Depeche Mode', playcount: 8 },
        ],
        total: 2,
      }),
      getUserRecentTracks: vi.fn<LastFmRepository['getUserRecentTracks']>().mockResolvedValue([
        { name: 'Creep', artistName: 'Radiohead', albumName: 'OK Computer', nowPlaying: false },
      ]),
      searchTracks: vi.fn<LastFmRepository['searchTracks']>().mockResolvedValue([
        { name: 'Paranoid Android', artistName: 'Radiohead', playcount: 5 },
      ]),
      scrobbleTrack: vi.fn<LastFmRepository['scrobbleTrack']>().mockResolvedValue(true),
    });
    mockUpdateService = stub<UpdateService>({
      updateUser: vi.fn<UpdateService['updateUser']>(),
    });
  });

  describe('TrackCommands (Text)', () => {
    let trackCommands: TrackCommands;

    beforeEach(() => {
      trackCommands = new TrackCommands(
        mockUserService,
        mockTrackService,
        mockTrackDetailsService,
        mockLastfmRepository,
        mockUpdateService,
      );
    });

    it('has love, unlove, loved, scrobble registered in commands', () => {
      const names = trackCommands.commands.map((c) => c.name);
      expect(names).toContain('love');
      expect(names).toContain('unlove');
      expect(names).toContain('loved');
      expect(names).toContain('scrobble');
    });

    it('loves current track when no args provided', async () => {
      const ctx = new ContextModel();
      ctx.discordUserId = '123456789';

      const loveCmd = trackCommands.commands.find((c) => c.name === 'love')!;
      const res = await loveCmd.executeAsync(ctx, []);

      expect(mockLastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('MohaTest', 1, 1, undefined, 'test-session-key-xyz');
      expect(mockLastfmRepository.loveTrack).toHaveBeenCalledWith('Radiohead', 'Creep', 'test-session-key-xyz');
      expect(res.commandResponse).toBe(CommandResponse.Ok);
      const json = JSON.stringify(res.componentsV2Container!.toJSON());
      expect(json).toContain('Loved **Creep** by **Radiohead**');
    });

    it('loves track with artist | track format', async () => {
      const ctx = new ContextModel();
      ctx.discordUserId = '123456789';

      const loveCmd = trackCommands.commands.find((c) => c.name === 'love')!;
      const res = await loveCmd.executeAsync(ctx, ['Gorillaz', '|', 'Feel', 'Good', 'Inc']);

      expect(mockLastfmRepository.loveTrack).toHaveBeenCalledWith('Gorillaz', 'Feel Good Inc', 'test-session-key-xyz');
      expect(res.commandResponse).toBe(CommandResponse.Ok);
    });

    it('unloves current track when no args provided', async () => {
      const ctx = new ContextModel();
      ctx.discordUserId = '123456789';

      const unloveCmd = trackCommands.commands.find((c) => c.name === 'unlove')!;
      const res = await unloveCmd.executeAsync(ctx, []);

      expect(mockLastfmRepository.unloveTrack).toHaveBeenCalledWith('Radiohead', 'Creep', 'test-session-key-xyz');
      expect(res.commandResponse).toBe(CommandResponse.Ok);
      const json = JSON.stringify(res.componentsV2Container!.toJSON());
      expect(json).toContain('Unloved **Creep** by **Radiohead**');
    });

    it('rejects love when session key is missing', async () => {
      // `User.sessionKey` is `string | undefined` and the guard is the falsy check
      // `if (!user.sessionKey)` (trackCommands.ts:244), so `undefined` is the
      // in-contract spelling of the same missing-authorisation state.
      vi.mocked(mockUserService.getUserByDiscordId).mockResolvedValueOnce(
        sampleUser({ sessionKey: undefined }),
      );

      const ctx = new ContextModel();
      ctx.discordUserId = '123456789';

      const loveCmd = trackCommands.commands.find((c) => c.name === 'love')!;
      const res = await loveCmd.executeAsync(ctx, []);

      expect(res.commandResponse).toBe(CommandResponse.NoPermission);
      expect(mockLastfmRepository.loveTrack).not.toHaveBeenCalled();
    });

    it('displays loved tracks list', async () => {
      const ctx = new ContextModel();
      ctx.discordUserId = '123456789';

      const lovedCmd = trackCommands.commands.find((c) => c.name === 'loved')!;
      const res = await lovedCmd.executeAsync(ctx, []);

      expect(mockLastfmRepository.getLovedTracks).toHaveBeenCalledWith('MohaTest', 200, 1, 'test-session-key-xyz');
      expect(res.commandResponse).toBe(CommandResponse.Ok);
      const json = JSON.stringify(res.componentsV2Container!.toJSON());
      expect(json).toContain('Loved tracks');
      expect(json).toContain('Karma Police');
    });

    it('scrobbles a track with Artist | Track | Album', async () => {
      const ctx = new ContextModel();
      ctx.discordUserId = '123456789';

      const scrobbleCmd = trackCommands.commands.find((c) => c.name === 'scrobble')!;
      const res = await scrobbleCmd.executeAsync(ctx, ['Daft', 'Punk', '|', 'One', 'More', 'Time', '|', 'Discovery']);

      expect(mockLastfmRepository.scrobbleTrack).toHaveBeenCalledWith(
        'Daft Punk',
        'One More Time',
        expect.any(Number),
        'test-session-key-xyz',
        'Discovery',
      );
      expect(res.commandResponse).toBe(CommandResponse.Ok);
      const json = JSON.stringify(res.componentsV2Container!.toJSON());
      expect(json).toContain('Scrobbled **One More Time** by **Daft Punk**');
    });
  });

  describe('TrackSlashCommands (Slash)', () => {
    let trackSlashCommands: TrackSlashCommands;

    beforeEach(() => {
      trackSlashCommands = new TrackSlashCommands(
        mockUserService,
        mockTrackService,
        mockTrackDetailsService,
        mockLastfmRepository,
        mockUpdateService,
      );
    });

    it('has love, unlove, loved, scrobble registered in slash commands', () => {
      const names = trackSlashCommands.commands.map((c) => c.data.name);
      expect(names).toContain('love');
      expect(names).toContain('unlove');
      expect(names).toContain('loved');
      expect(names).toContain('scrobble');
    });

    it('executes /scrobble with options', async () => {
      const getString = vi.fn<(key: string) => string | null>((key) => {
        if (key === 'track') return 'Harder Better Faster Stronger';
        if (key === 'artist') return 'Daft Punk';
        if (key === 'album') return 'Discovery';
        return null;
      });
      const ctx = new ContextModel();
      ctx.discordUserId = '123456789';
      ctx.interaction = { options: { getString } } as unknown as ChatInputCommandInteraction;

      const scrobbleCmd = trackSlashCommands.commands.find((c) => c.data.name === 'scrobble')!;
      const res = await scrobbleCmd.executeAsync(ctx);

      expect(mockLastfmRepository.scrobbleTrack).toHaveBeenCalledWith(
        'Daft Punk',
        'Harder Better Faster Stronger',
        expect.any(Number),
        'test-session-key-xyz',
        'Discovery',
      );
      expect(res.commandResponse).toBe(CommandResponse.Ok);
    });
  });

  describe('NowPlayingInteractions pagination', () => {
    it('handles loved:next button click correctly', async () => {
      const nowPlayingInteractions = new NowPlayingInteractions(
        mockUserRepository,
        mockLastfmRepository,
        mockTrackService,
      );

      // Neither `deferUpdate` nor `editReply` resolves a value the handler reads, so both
      // mocks stay unresolved (`undefined`), exactly as they ran before.
      const deferUpdate = vi.fn<ButtonInteraction['deferUpdate']>();
      const editReply = vi.fn<ButtonInteraction['editReply']>();
      const interaction = {
        customId: 'loved:next:0:MohaTest',
        user: { id: '123456789' },
        guild: { members: { cache: { get: () => ({ displayName: 'Moha' }) } } },
        deferUpdate,
        editReply,
      } as unknown as ButtonInteraction;

      await nowPlayingInteractions.handleLovedPagination(interaction);

      expect(deferUpdate).toHaveBeenCalled();
      expect(mockLastfmRepository.getLovedTracks).toHaveBeenCalledWith('MohaTest', 200, 1, 'test-session-key-xyz');
      expect(editReply).toHaveBeenCalled();
    });
  });
});