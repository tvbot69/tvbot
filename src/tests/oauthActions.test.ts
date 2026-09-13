import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TrackCommands } from '@bot/textCommands/lastfm/trackCommands';
import { TrackSlashCommands } from '@bot/slashCommands/trackSlashCommands';
import { NowPlayingInteractions } from '@bot/interactions/nowPlayingInteractions';
import { ContextModel } from '@bot/models/contextModel';
import { CommandResponse } from '@domain/enums/commandResponse';

describe('OAuth Actions (love, unlove, loved, scrobble)', () => {
  let mockUserService: any;
  let mockTrackService: any;
  let mockTrackDetailsService: any;
  let mockLastfmRepository: any;
  let mockUpdateService: any;
  let mockUserRepository: any;

  const sampleUser = {
    userId: 1,
    discordUserId: '123456789',
    userNameLastFm: 'MohaTest',
    sessionKey: 'test-session-key-xyz',
  };

  beforeEach(() => {
    mockUserService = {
      getUserByDiscordId: vi.fn().mockResolvedValue(sampleUser),
    };
    mockUserRepository = {
      getUserByDiscordUserId: vi.fn().mockResolvedValue(sampleUser),
    };
    mockTrackService = {
      searchTrack: vi.fn(),
      getScrobbleReference: vi.fn(),
    };
    mockTrackDetailsService = {
      getDetails: vi.fn(),
    };
    mockLastfmRepository = {
      loveTrack: vi.fn().mockResolvedValue(true),
      unloveTrack: vi.fn().mockResolvedValue(true),
      getLovedTracks: vi.fn().mockResolvedValue({
        tracks: [
          { name: 'Karma Police', artistName: 'Radiohead' },
          { name: 'Enjoy The Silence', artistName: 'Depeche Mode' },
        ],
        total: 2,
      }),
      getUserRecentTracks: vi.fn().mockResolvedValue([
        { name: 'Creep', artistName: 'Radiohead' },
      ]),
      searchTracks: vi.fn().mockResolvedValue([
        { name: 'Paranoid Android', artistName: 'Radiohead' },
      ]),
      scrobbleTrack: vi.fn().mockResolvedValue(true),
    };
    mockUpdateService = {
      updateUser: vi.fn(),
    };
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
      mockUserService.getUserByDiscordId.mockResolvedValueOnce({
        ...sampleUser,
        sessionKey: null,
      });

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
      const ctx = new ContextModel();
      ctx.discordUserId = '123456789';
      ctx.interaction = {
        options: {
          getString: vi.fn((key: string) => {
            if (key === 'track') return 'Harder Better Faster Stronger';
            if (key === 'artist') return 'Daft Punk';
            if (key === 'album') return 'Discovery';
            return null;
          }),
        },
      } as any;

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

      const interaction = {
        customId: 'loved:next:0:MohaTest',
        user: { id: '123456789' },
        guild: { members: { cache: { get: () => ({ displayName: 'Moha' }) } } },
        deferUpdate: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
      } as any;

      await nowPlayingInteractions.handleLovedPagination(interaction);

      expect(interaction.deferUpdate).toHaveBeenCalled();
      expect(mockLastfmRepository.getLovedTracks).toHaveBeenCalledWith('MohaTest', 200, 1, 'test-session-key-xyz');
      expect(interaction.editReply).toHaveBeenCalled();
    });
  });
});
