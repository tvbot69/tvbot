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
import { TrackCommands } from '@bot/textCommands/lastfm/trackCommands';
import { UserSettingsInteractions } from '@bot/interactions/userSettingsInteractions';

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

    it('verifies l alias belongs to love and not music stop', () => {
      const trackCmds = new TrackCommands({} as any, {} as any, {} as any, {} as any, {} as any);
      const loveDef = trackCmds.commands.find((c) => c.name === 'love');
      expect(loveDef).toBeDefined();
      expect(loveDef?.aliases).toContain('l');

      const musicCmds = new MusicCommands({} as any, {} as any, {} as any, {} as any);
      const stopDef = musicCmds.commands.find((c) => c.name === 'stop');
      expect(stopDef).toBeDefined();
      expect(stopDef?.aliases).not.toContain('l');
    });
  });

  describe('Issue 5: .love list routes to loved tracks list', () => {
    it('redirects .love list directly to lovedAsync', async () => {
      // NOTE: the shadowed IntelligenceCommands love-cluster was removed;
      // TrackCommands is the registered implementation (same list-branch).
      const mockUserService = {} as any;
      const mockTrackService = {} as any;
      const mockTrackDetailsService = {} as any;
      const mockLastFmRepository = {} as any;
      const mockUpdateService = {} as any;
      const mockLyricsService = {} as any;

      const commands = new TrackCommands(
        mockUserService,
        mockTrackService,
        mockTrackDetailsService,
        mockLastFmRepository,
        mockUpdateService,
        mockLyricsService,
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
      expect(res.content).toBe('https://spotify.com/track/1');
    });

    it('searches and returns direct link for spotify album and applemusic', async () => {
      const mockUserService = {
        getUserByDiscordId: vi.fn().mockResolvedValue(null),
      } as any;
      const mockSpotifyApi = {
        searchAlbums: vi.fn().mockResolvedValue([
          {
            id: 'sp-album-1',
            name: 'OK Computer',
            external_urls: { spotify: 'https://open.spotify.com/album/okcomputer' },
          },
        ]),
      } as any;
      const mockAppleMusicService = {
        searchSong: vi.fn().mockResolvedValue({
          trackName: 'Creep',
          artistName: 'Radiohead',
          url: 'https://music.apple.com/us/album/creep/123?i=456',
        }),
        searchAlbum: vi.fn().mockResolvedValue('https://music.apple.com/us/album/ok-computer/123'),
      } as any;
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
        discordUserId: 'user-1',
        prefix: '.',
      } as any;

      // Search album with .spotifyalbum
      const albumRes = await streamingCommands.spotifyAlbumAsync(ctx, ['OK', 'Computer']);
      expect(albumRes.content).toBe('https://open.spotify.com/album/okcomputer');

      // Search song with .applemusic
      const amRes = await streamingCommands.appleMusicAsync(ctx, ['Radiohead', 'Creep']);
      expect(amRes.content).toBe('https://music.apple.com/us/album/creep/123?i=456');

      // Search album with .applemusicalbum
      const amAlbumRes = await streamingCommands.appleMusicAlbumAsync(ctx, ['OK', 'Computer']);
      expect(amAlbumRes.content).toBe('https://music.apple.com/us/album/ok-computer/123');
    });
  });

  describe('Issue 10: UserSettingsInteractions Components V2 flags', () => {
    it('sets MessageFlags.IsComponentsV2 on select menu replies', async () => {
      const mockUserService = {
        getUserByDiscordId: vi.fn().mockResolvedValue({
          userId: 1,
          discordUserId: '123',
          userNameLastFm: 'tester',
        }),
      } as any;
      const mockFmSettingService = {
        get: vi.fn().mockResolvedValue(null),
      } as any;
      const mockPrefixService = {} as any;

      const interactions = new UserSettingsInteractions(
        mockUserService,
        mockFmSettingService,
        mockPrefixService,
      );

      const replyMock = vi.fn().mockResolvedValue(undefined);
      const interaction = {
        isButton: () => false,
        isStringSelectMenu: () => true,
        customId: 'user-settings:select',
        values: ['us-view-WkMode'],
        user: { id: '123', displayName: 'tester' },
        reply: replyMock,
      } as any;

      await interactions.handle(interaction);
      expect(replyMock).toHaveBeenCalledTimes(1);
      const callArgs = replyMock.mock.calls[0]![0];
      expect(callArgs.flags & MessageFlags.IsComponentsV2).toBeTruthy();
      expect(callArgs.flags & MessageFlags.Ephemeral).toBeTruthy();
      expect(callArgs.components.length).toBe(1);
    });
  });

  describe('Issue 11: no shadowed duplicate triggers across modules', () => {
    const triggersOf = (mod: { commands: Array<{ name: string; aliases?: string[] }> }): string[] =>
      mod.commands.flatMap((c) => [c.name.toLowerCase(), ...(c.aliases ?? []).map((a) => a.toLowerCase())]);

    it('intelligence modules claim no love/scrobble triggers (track owns them)', async () => {
      const { IntelligenceCommands: IC } = await import('@bot/textCommands/lastfm/intelligenceCommands');
      const { IntelligenceSlashCommands: ISC } = await import('@bot/slashCommands/intelligenceSlashCommands');
      const textTriggers = triggersOf(new (IC as any)());
      for (const t of ['love', 'heart', 'favorite', 'unlove', 'ul', 'unheart', 'loved', 'lovedtracks', 'lt', 'scrobble']) {
        expect(textTriggers).not.toContain(t);
      }
      const slashNames: string[] = (new (ISC as any)()).commands.map((c: { data: { name: string } }) =>
        c.data.name.toLowerCase(),
      );
      expect(slashNames).not.toContain('loved');
      expect(slashNames).not.toContain('scrobble');
    });

    it('dead single-letter aliases stay removed', async () => {
      const { FriendsCommands } = await import('@bot/textCommands/lastfm/friendsCommands');
      const { StreamingCommands } = await import('@bot/textCommands/thirdParty/streamingCommands');
      const { ChartCommands } = await import('@bot/textCommands/lastfm/chartCommands');
      const { AlbumCommands } = await import('@bot/textCommands/lastfm/albumCommands');
      const friendsTriggers = triggersOf(new (FriendsCommands as any)());
      expect(friendsTriggers).not.toContain('f');
      expect(friendsTriggers).not.toContain('remove');
      const streamingTriggers = triggersOf(new (StreamingCommands as any)());
      expect(streamingTriggers).not.toContain('s');
      const chartTriggers = triggersOf(new (ChartCommands as any)());
      expect(chartTriggers).not.toContain('c');
      expect(chartTriggers).not.toContain('tc');
      const albumTriggers = triggersOf(new (AlbumCommands as any)());
      expect(albumTriggers).not.toContain('tracks');
    });

    it('searchdb reaches the library, search stays music', async () => {
      const { LibrarySearchCommands } = await import('@bot/textCommands/lastfm/librarySearchCommands');
      const { LibrarySearchSlashCommands } = await import('@bot/slashCommands/librarySearchSlashCommands');
      const { MusicCommands } = await import('@bot/textCommands/music/musicCommands');
      const libTriggers = triggersOf(new (LibrarySearchCommands as any)());
      expect(libTriggers).toContain('searchdb');
      const slashNames: string[] = (new (LibrarySearchSlashCommands as any)()).commands.map(
        (c: { data: { name: string } }) => c.data.name.toLowerCase(),
      );
      expect(slashNames).toContain('searchdb');
      const musicTriggers = triggersOf(new (MusicCommands as any)());
      expect(musicTriggers).toContain('search');
      expect(musicTriggers).not.toContain('searchdb');
    });
  });
});
