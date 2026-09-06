import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { ResponseModel } from '@bot/models/responseModel';
import { GameBuilders } from '@bot/builders/gameBuilders';
import { ProfileCommands } from '@bot/textCommands/lastfm/profileCommands';
import { GameCommands } from '@bot/textCommands/lastfm/gameCommands';
import { MusicCommands } from '@bot/textCommands/music/musicCommands';
import { ContainerBuilder, MessageFlags } from 'discord.js';
import type { ContextModel } from '@bot/models/contextModel';
import { StreamingCommands } from '@bot/textCommands/thirdParty/streamingCommands';
import { IntelligenceCommands } from '@bot/textCommands/lastfm/intelligenceCommands';

describe('Bugfixes & Hardening Validation', () => {
  describe('Issue 3: ResponseModel and Pixelation Attachment', () => {
    it('properly populates files array in toMessagePayload for Components V2', () => {
      const response = new ResponseModel();
      const container = new ContainerBuilder();
      response.setComponentsV2Container(container);
      const testBuffer = Buffer.from('fake-pixel-data');
      response.setFile(testBuffer, 'pixel-cover.png', 'Pixelated album cover');

      expect(response.hasFile()).toBe(true);
      const payload = response.toMessagePayload();
      expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
      expect(payload.components).toBeDefined();
      expect(payload.files).toBeDefined();
      const files = payload.files as Array<{ attachment: Buffer; name: string; description?: string }>;
      expect(files.length).toBe(1);
      expect(files[0]?.name).toBe('pixel-cover.png');
      expect(files[0]?.attachment).toBe(testBuffer);
    });

    it('buildPixelStartResponse creates a valid payload with pixel-cover.png file', () => {
      const testBuffer = Buffer.from('album-art-buffer');
      const session: any = {
        sessionId: 'test-session',
        hints: ['O _ _ _ _'],
        hintsShown: 0,
        artistName: 'Radiohead',
        blurLevel: 0.04,
      };

      const res = GameBuilders.buildPixelStartResponse(session, testBuffer, 0x123456);
      expect(res.hasFile()).toBe(true);
      const payload = res.toMessagePayload();
      expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
      expect(payload.files).toBeDefined();
      const files = payload.files as Array<{ attachment: Buffer; name: string }>;
      expect(files[0]?.name).toBe('pixel-cover.png');
    });
  });

  describe('Issue 4: .stats alias belongs to .profile and game stats commands', () => {
    it('verifies profile command has stats alias', () => {
      const profileCmds = new ProfileCommands({} as any, {} as any, {} as any);
      const profileDef = profileCmds.commands.find((c) => c.name === 'profile');
      expect(profileDef).toBeDefined();
      expect(profileDef?.aliases).toContain('stats');
    });

    it('verifies game commands do not claim stats and provide gamestats, js, pxs', () => {
      const gameCmds = new GameCommands({} as any, {} as any, {} as any);
      const statsCmd = gameCmds.commands.find((c) => c.name === 'stats' || c.aliases?.includes('stats'));
      expect(statsCmd).toBeUndefined();

      const gameStatsDef = gameCmds.commands.find((c) => c.name === 'gamestats');
      expect(gameStatsDef).toBeDefined();
      expect(gameStatsDef?.aliases).toContain('js');
      expect(gameStatsDef?.aliases).toContain('pxs');
    });

    it('verifies j alias belongs to music join and not jumble', () => {
      const gameCmds = new GameCommands({} as any, {} as any, {} as any);
      const jumbleDef = gameCmds.commands.find((c) => c.name === 'jumble');
      expect(jumbleDef).toBeDefined();
      expect(jumbleDef?.aliases).not.toContain('j');

      const musicCmds = new MusicCommands({} as any, {} as any, {} as any, {} as any);
      const joinDef = musicCmds.commands.find((c) => c.name === 'join');
      expect(joinDef).toBeDefined();
      expect(joinDef?.aliases).toContain('j');
    });

    it('verifies l alias belongs to music loop and not love', () => {
      const intellCmds = new IntelligenceCommands({} as any, {} as any, {} as any, {} as any);
      const loveDef = intellCmds.commands.find((c) => c.name === 'love');
      expect(loveDef).toBeDefined();
      expect(loveDef?.aliases).not.toContain('l');

      const musicCmds = new MusicCommands({} as any, {} as any, {} as any, {} as any);
      const loopDef = musicCmds.commands.find((c) => c.name === 'loop');
      expect(loopDef).toBeDefined();
      expect(loopDef?.aliases).toContain('l');
    });
  });

  describe('Issue 5: .love list routes to loved tracks list', () => {
    it('redirects .love list directly to lovedAsync', async () => {
      const mockUserService = {} as any;
      const mockSettingService = {} as any;
      const mockLastFmRepository = {} as any;
      const mockIntelligenceService = {
        getLovedTracks: vi.fn().mockResolvedValue({ tracks: [], total: 0 }),
        loveTrack: vi.fn(),
      } as any;

      const commands = new IntelligenceCommands(
        mockUserService,
        mockSettingService,
        mockLastFmRepository,
        mockIntelligenceService,
      );

      const loveCmd = commands.commands.find((c) => c.name === 'love');
      expect(loveCmd).toBeDefined();

      // Spy on lovedAsync
      const lovedSpy = vi.spyOn(commands as any, 'lovedAsync').mockResolvedValue(new ResponseModel());
      const loveSpy = vi.spyOn(commands as any, 'loveAsync').mockResolvedValue(new ResponseModel());

      const ctx: ContextModel = {
        discordUserId: 'user-1',
        prefix: '.',
      } as any;

      await loveCmd?.executeAsync(ctx, ['list']);
      expect(lovedSpy).toHaveBeenCalled();
      expect(loveSpy).not.toHaveBeenCalled();

      await loveCmd?.executeAsync(ctx, ['Karma', 'Police']);
      expect(loveSpy).toHaveBeenCalled();
    });
  });

  describe('Issue 1: .spotify and .applemusic without arguments', () => {
    it('handles unlinked Last.fm account when query is omitted', async () => {
      const mockUserService = {
        getUserByDiscordId: vi.fn().mockResolvedValue(null),
      } as any;
      const mockSpotifyApi = {} as any;
      const mockAppleMusicService = {} as any;
      const mockPrefixService = {} as any;
      const mockLastFmRepository = {} as any;

      const streamingCommands = new StreamingCommands(
        mockUserService,
        mockSpotifyApi,
        mockAppleMusicService,
        mockPrefixService,
        mockLastFmRepository,
      );

      const ctx: ContextModel = {
        discordUserId: 'unlinked-user',
        prefix: '.',
      } as any;

      const res = await streamingCommands.spotifyTrackAsync(ctx, []);
      expect(res.embed.data.description).toContain('not connected your Last.fm account');
    });

    it('resolves currently playing track when no args are provided', async () => {
      const mockUserService = {
        getUserByDiscordId: vi.fn().mockResolvedValue({
          userId: 1,
          userNameLastFm: 'lastfm-user',
        }),
      } as any;
      const mockSpotifyApi = {
        searchTracks: vi.fn().mockResolvedValue([
          {
            id: 'sp-1',
            name: 'Creep',
            artists: [{ name: 'Radiohead' }],
            external_urls: { spotify: 'https://spotify.com/track/1' },
          },
        ]),
      } as any;
      const mockAppleMusicService = {} as any;
      const mockPrefixService = {} as any;
      const mockLastFmRepository = {
        getUserRecentTracks: vi.fn().mockResolvedValue([
          {
            name: 'Creep',
            artistName: 'Radiohead',
            nowPlaying: true,
          },
        ]),
      } as any;

      const streamingCommands = new StreamingCommands(
        mockUserService,
        mockSpotifyApi,
        mockAppleMusicService,
        mockPrefixService,
        mockLastFmRepository,
      );

      const ctx: ContextModel = {
        discordUserId: 'linked-user',
        prefix: '.',
      } as any;

      const res = await streamingCommands.spotifyTrackAsync(ctx, []);
      expect(mockSpotifyApi.searchTracks).toHaveBeenCalledWith('Radiohead Creep', 1);
      expect(res.isComponentsV2).toBe(true);
    });
  });
});
