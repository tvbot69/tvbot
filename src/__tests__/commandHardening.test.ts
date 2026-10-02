import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { ResponseModel } from '@bot/models/responseModel';
import { ContextModel } from '@bot/models/contextModel';
import { GameBuilders } from '@bot/builders/guild/gameBuilders';
import { ProfileCommands } from '@bot/textCommands/lastfm/profileCommands';
import { GameCommands } from '@bot/textCommands/lastfm/gameCommands';
import { MusicCommands } from '@bot/textCommands/music/musicCommands';
import { ContainerBuilder, MessageFlags, type MessageReplyOptions } from 'discord.js';
import type { StringSelectMenuInteraction } from 'discord.js';
import { StreamingCommands } from '@bot/textCommands/thirdParty/streamingCommands';

import { TrackCommands } from '@bot/textCommands/lastfm/trackCommands';
import { UserSettingsInteractions } from '@bot/interactions/user/userSettingsInteractions';
import { UserService } from '@bot/services/user/userService';
import { PrefixService } from '@bot/services/user/prefixService';
import { FmSettingService } from '@bot/services/system/fmSettingService';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { AppleMusicService } from '@bot/services/media/appleMusicService';
import { UpdateService } from '@bot/services/lastfm/updateService';
import { LyricsService } from '@bot/services/music/lyricsService';
import { UserType, DataSource } from '@persistence/models/user';
import { PrivacyLevel } from '@domain/enums/privacyLevel';
import type { TrackService } from '@bot/services/library/trackService';
import type { TrackDetailsService } from '@bot/services/audio/trackDetailsService';
import type { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type { User } from '@domain/interfaces/ports/iuserRepository';
import type { JumbleSession } from '@bot/services/guild/gameService';
import type { TextCommandDefinition, SlashCommandDefinition } from '@bot/models/commandModels';

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

/**
 * Constructs a command module with NO collaborators.
 *
 * The alias-table tests read `commands` and nothing else, and every constructor in
 * these modules assigns its parameters then populates `commands` without touching a
 * parameter. `never[]` makes the zero-argument call the only legal one, and the bound
 * `T` still forces the real `TextCommandDefinition` / `SlashCommandDefinition` shape,
 * so renaming a command member breaks these tests instead of leaving the alias
 * assertions passing vacuously.
 */
const textModule = <T extends { commands: readonly TextCommandDefinition[] }>(
  ctor: new (...args: never[]) => T,
): T => new ctor();

const slashModuleNames = <T extends { commands: readonly SlashCommandDefinition[] }>(
  ctor: new (...args: never[]) => T,
): string[] => new ctor().commands.map((c) => c.data.name.toLowerCase());

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
      // A whole `JumbleSession`: `buildPixelStartResponse` reads `artistName`,
      // `hintsShown`, `blurLevel` and the answer, and the type has 20 members. A
      // factory with overrides means a new required member breaks here rather than
      // being quietly absent from the double.
      const session: JumbleSession = {
        sessionId: 'test-session',
        channelId: 'test-channel',
        starterUserId: 'starter',
        starterDiscordId: '111',
        type: 'pixel',
        correctAnswer: 'OK Computer',
        displayTarget: 'OK Computer',
        artistName: 'Radiohead',
        albumName: 'OK Computer',
        dateStarted: new Date(),
        hints: ['O _ _ _ _'],
        hintsShown: 0,
        blurLevel: 0.04,
        reshuffles: 0,
        ended: false,
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
      const profileCmds = textModule(ProfileCommands);
      const profileDef = profileCmds.commands.find((c) => c.name === 'profile');
      expect(profileDef).toBeDefined();
      expect(profileDef?.aliases).toContain('stats');
    });

    it('verifies game commands do not claim stats and provide gamestats, js, pxs', () => {
      const gameCmds = textModule(GameCommands);
      const statsCmd = gameCmds.commands.find((c) => c.name === 'stats' || c.aliases?.includes('stats'));
      expect(statsCmd).toBeUndefined();

      const gameStatsDef = gameCmds.commands.find((c) => c.name === 'gamestats');
      expect(gameStatsDef).toBeDefined();
      expect(gameStatsDef?.aliases).toContain('js');
      expect(gameStatsDef?.aliases).toContain('pxs');
    });

    it('verifies j alias belongs to music join and not jumble', () => {
      const gameCmds = textModule(GameCommands);
      const jumbleDef = gameCmds.commands.find((c) => c.name === 'jumble');
      expect(jumbleDef).toBeDefined();
      expect(jumbleDef?.aliases).not.toContain('j');

      const musicCmds = textModule(MusicCommands);
      const joinDef = musicCmds.commands.find((c) => c.name === 'join');
      expect(joinDef).toBeDefined();
      expect(joinDef?.aliases).toContain('j');
    });

    it('verifies l alias belongs to love and not music stop', () => {
      const trackCmds = textModule(TrackCommands);
      const loveDef = trackCmds.commands.find((c) => c.name === 'love');
      expect(loveDef).toBeDefined();
      expect(loveDef?.aliases).toContain('l');

      const musicCmds = textModule(MusicCommands);
      const stopDef = musicCmds.commands.find((c) => c.name === 'stop');
      expect(stopDef).toBeDefined();
      expect(stopDef?.aliases).not.toContain('l');
    });
  });

  describe('Issue 5: .love list routes to loved tracks list', () => {
    it('redirects .love list directly to lovedAsync', async () => {
      // NOTE: the shadowed IntelligenceCommands love-cluster was removed;
      // TrackCommands is the registered implementation (same list-branch).
      const mockUserService = stub<UserService>({});
      const mockTrackService = stub<TrackService>({});
      const mockTrackDetailsService = stub<TrackDetailsService>({});
      const mockLastFmRepository = stub<LastFmRepository>({});
      const mockUpdateService = stub<UpdateService>({});
      const mockLyricsService = stub<LyricsService>({});

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

      // Spy on lovedAsync. `as unknown as` because both are `private`, which is the
      // documented convention for reaching privates from a test (AGENTS.md §5): the
      // object identity is unchanged, so the spy is on the real instance.
      const privates = commands as unknown as {
        lovedAsync: (context: ContextModel, args: string[]) => Promise<ResponseModel>;
        loveAsync: (context: ContextModel, args: string[]) => Promise<ResponseModel>;
      };
      const lovedSpy = vi.spyOn(privates, 'lovedAsync').mockResolvedValue(new ResponseModel());
      const loveSpy = vi.spyOn(privates, 'loveAsync').mockResolvedValue(new ResponseModel());

      const ctx = new ContextModel();
      ctx.discordUserId = 'user-1';

      await loveCmd?.executeAsync(ctx, ['list']);
      expect(lovedSpy).toHaveBeenCalled();
      expect(loveSpy).not.toHaveBeenCalled();

      await loveCmd?.executeAsync(ctx, ['Karma', 'Police']);
      expect(loveSpy).toHaveBeenCalled();
    });
  });

  describe('Issue 1: .spotify and .applemusic without arguments', () => {
    it('handles unlinked Last.fm account when query is omitted', async () => {
      const mockUserService = stub<UserService>({
        getUserByDiscordId: vi.fn<UserService['getUserByDiscordId']>().mockResolvedValue(null),
      });
      const mockSpotifyApi = stub<SpotifySearchApi>({});
      const mockAppleMusicService = stub<AppleMusicService>({});
      const mockPrefixService = stub<PrefixService>({});
      const mockLastFmRepository = stub<LastFmRepository>({});

      const streamingCommands = new StreamingCommands(
        mockUserService,
        mockSpotifyApi,
        mockAppleMusicService,
        mockPrefixService,
        mockLastFmRepository,
      );

      const ctx = new ContextModel();
      ctx.discordUserId = 'unlinked-user';

      const res = await streamingCommands.spotifyTrackAsync(ctx, []);
      expect(res.embed.data.description).toContain('not connected your Last.fm account');
    });

    it('resolves currently playing track when no args are provided', async () => {
      const mockUserService = stub<UserService>({
        getUserByDiscordId: vi.fn<UserService['getUserByDiscordId']>().mockResolvedValue(
          user({ discordUserId: 'linked-user', userNameLastFm: 'lastfm-user' }),
        ),
      });
      const mockSpotifyApi = stub<SpotifySearchApi>({
        // `uri` is required by `SpotifySearchTrack`; the builder under test never
        // reads it, but the real type does and the double is now obliged to.
        searchTracks: vi.fn<SpotifySearchApi['searchTracks']>().mockResolvedValue([
          {
            id: 'sp-1',
            name: 'Creep',
            uri: 'spotify:track:sp-1',
            artists: [{ name: 'Radiohead' }],
            external_urls: { spotify: 'https://spotify.com/track/1' },
          },
        ]),
      });
      const mockAppleMusicService = stub<AppleMusicService>({});
      const mockPrefixService = stub<PrefixService>({});
      const mockLastFmRepository = stub<LastFmRepository>({
        getUserRecentTracks: vi.fn<LastFmRepository['getUserRecentTracks']>().mockResolvedValue([
          {
            name: 'Creep',
            artistName: 'Radiohead',
            albumName: 'OK Computer',
            nowPlaying: true,
          },
        ]),
      });

      const streamingCommands = new StreamingCommands(
        mockUserService,
        mockSpotifyApi,
        mockAppleMusicService,
        mockPrefixService,
        mockLastFmRepository,
      );

      const ctx = new ContextModel();
      ctx.discordUserId = 'linked-user';

      const res = await streamingCommands.spotifyTrackAsync(ctx, []);
      expect(mockSpotifyApi.searchTracks).toHaveBeenCalledWith('Radiohead Creep', 1);
      expect(res.content).toBe('https://spotify.com/track/1');
    });

    it('searches and returns direct link for spotify album and applemusic', async () => {
      const mockUserService = stub<UserService>({
        getUserByDiscordId: vi.fn<UserService['getUserByDiscordId']>().mockResolvedValue(null),
      });
      const mockSpotifyApi = stub<SpotifySearchApi>({
        searchAlbums: vi.fn<SpotifySearchApi['searchAlbums']>().mockResolvedValue([
          {
            id: 'sp-album-1',
            name: 'OK Computer',
            uri: 'spotify:album:sp-album-1',
            external_urls: { spotify: 'https://open.spotify.com/album/okcomputer' },
          },
        ]),
      });
      const mockAppleMusicService = stub<AppleMusicService>({
        searchSong: vi.fn<AppleMusicService['searchSong']>().mockResolvedValue({
          trackName: 'Creep',
          artistName: 'Radiohead',
          url: 'https://music.apple.com/us/album/creep/123?i=456',
        }),
        searchAlbum: vi.fn<AppleMusicService['searchAlbum']>().mockResolvedValue(
          'https://music.apple.com/us/album/ok-computer/123',
        ),
      });
      const mockPrefixService = stub<PrefixService>({});
      const mockLastFmRepository = stub<LastFmRepository>({});

      const streamingCommands = new StreamingCommands(
        mockUserService,
        mockSpotifyApi,
        mockAppleMusicService,
        mockPrefixService,
        mockLastFmRepository,
      );

      const ctx = new ContextModel();
      ctx.discordUserId = 'user-1';

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
      const mockUserService = stub<UserService>({
        getUserByDiscordId: vi.fn<UserService['getUserByDiscordId']>().mockResolvedValue(
          user({ discordUserId: '123', userNameLastFm: 'tester' }),
        ),
      });
      const mockFmSettingService = stub<FmSettingService>({
        get: vi.fn<FmSettingService['get']>().mockResolvedValue(null),
      });
      const mockPrefixService = stub<PrefixService>({});

      const interactions = new UserSettingsInteractions(
        mockUserService,
        mockFmSettingService,
        mockPrefixService,
      );

      const replyMock = vi.fn<StringSelectMenuInteraction['reply']>();
      const interaction = {
        isButton: () => false,
        isStringSelectMenu: () => true,
        customId: 'user-settings:select',
        values: ['us-view-WkMode'],
        user: { id: '123', displayName: 'tester' },
        reply: replyMock,
      } as unknown as StringSelectMenuInteraction;

      await interactions.handle(interaction);
      expect(replyMock).toHaveBeenCalledTimes(1);
      const callArgs = replyMock.mock.calls[0]![0] as MessageReplyOptions;
      // `MessageFlags` members are bigints in discord.js v14, so the flags are read
      // through `Number()` rather than a bitwise op on `BitFieldResolvable`.
      expect(Number(callArgs.flags) & Number(MessageFlags.IsComponentsV2)).toBeTruthy();
      expect(Number(callArgs.flags) & Number(MessageFlags.Ephemeral)).toBeTruthy();
      expect(callArgs.components?.length).toBe(1);
    });
  });

  describe('Issue 11: no shadowed duplicate triggers across modules', () => {
    const triggersOf = (mod: { commands: readonly TextCommandDefinition[] }): string[] =>
      mod.commands.flatMap((c) => [c.name.toLowerCase(), ...(c.aliases ?? []).map((a) => a.toLowerCase())]);

    it('intelligence modules claim no love/scrobble triggers (track owns them)', async () => {
      const { IntelligenceCommands: IC } = await import('@bot/textCommands/lastfm/intelligenceCommands');
      const { IntelligenceSlashCommands: ISC } = await import('@bot/slashCommands/intelligence/intelligenceSlashCommands');
      const textTriggers = triggersOf(textModule(IC));
      for (const t of ['love', 'heart', 'favorite', 'unlove', 'ul', 'unheart', 'loved', 'lovedtracks', 'lt', 'scrobble']) {
        expect(textTriggers).not.toContain(t);
      }
      const slashNames: string[] = slashModuleNames(ISC);
      expect(slashNames).not.toContain('loved');
      expect(slashNames).not.toContain('scrobble');
    });

    it('dead single-letter aliases stay removed', async () => {
      const { FriendsCommands } = await import('@bot/textCommands/lastfm/friendsCommands');
      const { StreamingCommands } = await import('@bot/textCommands/thirdParty/streamingCommands');
      const { ChartCommands } = await import('@bot/textCommands/lastfm/chartCommands');
      const { AlbumCommands } = await import('@bot/textCommands/lastfm/albumCommands');
      const friendsTriggers = triggersOf(textModule(FriendsCommands));
      expect(friendsTriggers).not.toContain('f');
      expect(friendsTriggers).not.toContain('remove');
      const streamingTriggers = triggersOf(textModule(StreamingCommands));
      expect(streamingTriggers).not.toContain('s');
      const chartTriggers = triggersOf(textModule(ChartCommands));
      expect(chartTriggers).not.toContain('c');
      expect(chartTriggers).not.toContain('tc');
      const albumTriggers = triggersOf(textModule(AlbumCommands));
      expect(albumTriggers).not.toContain('tracks');
    });

    it('searchdb reaches the library, search stays music', async () => {
      const { LibrarySearchCommands } = await import('@bot/textCommands/lastfm/librarySearchCommands');
      const { LibrarySearchSlashCommands } = await import('@bot/slashCommands/library/librarySearchSlashCommands');
      const { MusicCommands } = await import('@bot/textCommands/music/musicCommands');
      const libTriggers = triggersOf(textModule(LibrarySearchCommands));
      expect(libTriggers).toContain('searchdb');
      // Only the slash twin was cut. The text command keeps its own name and
      // every alias it had, so `.librarysearch` still reaches the feature.
      expect(libTriggers).toContain('librarysearch');
      expect(libTriggers).toContain('libsearch');
      expect(libTriggers).toContain('ls');
      expect(libTriggers).toContain('dbsearch');
      const slashNames: string[] = slashModuleNames(LibrarySearchSlashCommands);
      expect(slashNames).toContain('searchdb');
      // The slash family had no alias mechanism, so `searchdb` was registered
      // twice — once as `librarysearch`, once as `searchdb` — burning one of
      // Discord's 100 global slots. Only the name the owner wants survives.
      expect(slashNames).not.toContain('librarysearch');
      expect(slashNames).toHaveLength(1);
      const musicTriggers = triggersOf(textModule(MusicCommands));
      expect(musicTriggers).toContain('search');
      expect(musicTriggers).not.toContain('searchdb');
    });
  });
});