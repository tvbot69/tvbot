import 'reflect-metadata';
import { container } from 'tsyringe';
import { Client, GatewayIntentBits, ActivityType, version as discordJsVersion } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logging/logger';
import { prisma } from '@persistence/prismaClient';
import { LastfmErrorRateTracker } from '@domain/lastfm/lastfmErrorRateTracker';
import { StartupService } from '@bot/services/system/startupService';
import { ShutdownService } from '@bot/services/system/shutdownService';
import { TimerService } from '@bot/services/lastfm/timerService';
import { HealthServer } from '@bot/services/system/healthServer';
import { CacheService } from '@bot/services/system/cacheService';
import { PrefixService } from '@bot/services/user/prefixService';
import { UserService } from '@bot/services/user/userService';
import { GuildService } from '@bot/services/guild/guildService';
import { GuildUserService } from '@bot/services/guild/guildUserService';
import { DisabledChannelService } from '@bot/services/guild/disabledChannelService';
import { GuildDisabledCommandService } from '@bot/services/guild/guildDisabledCommandService';
import { ChannelToggledCommandService } from '@bot/services/guild/channelToggledCommandService';
import { UserUpdateQueueService } from '@bot/services/lastfm/userUpdateQueueService';
import { UserIndexQueueService } from '@bot/services/lastfm/userIndexQueueService';
import { IndexService } from '@bot/services/lastfm/indexService';
import { ReconcileService } from '@bot/services/lastfm/reconcileService';
import { UpdateService } from '@bot/services/lastfm/updateService';
import { LoginService } from '@bot/services/user/loginService';
import { ColorService } from '@bot/services/system/colorService';
import { ImageUploadService } from '@bot/services/system/imageUploadService';
import { AlbumEnrichmentService } from '@bot/services/library/albumEnrichmentService';
import { ArtworkService } from '@bot/services/media/artworkService';
import { SettingService } from '@bot/services/system/settingService';
import { ArtistsService } from '@bot/services/library/artistsService';
import { AlbumService } from '@bot/services/library/albumService';
import { TrackService } from '@bot/services/library/trackService';
import { ComponentInteractionTracker } from '@bot/services/system/componentInteractionTracker';
import { ComponentPaginatorService } from '@bot/services/system/componentPaginatorService';
import { PaginationService } from '@bot/services/system/paginationService';
import { TelemetryService } from '@bot/services/system/telemetryService';
import { AutopostService } from '@bot/services/charts/autopostService';
import { NowPlayingInteractions } from '@bot/interactions/music/nowPlayingInteractions';
import { UserRepository } from '@persistence/repositories/userRepository';
import { GuildRepository } from '@persistence/repositories/guildRepository';
import { GuildUserRepository } from '@persistence/repositories/guildUserRepository';
import { ChannelRepository } from '@persistence/repositories/channelRepository';
import { GuildDisabledCommandRepository } from '@persistence/repositories/guildDisabledCommandRepository';
import { AutopostRepository } from '@persistence/repositories/autopostRepository';
import { ArtistRepository } from '@persistence/repositories/artistRepository';
import { AlbumRepository } from '@persistence/repositories/albumRepository';
import { TrackRepository } from '@persistence/repositories/trackRepository';
import { PlayRepository } from '@persistence/repositories/playRepository';
import { UserFmSettingRepository } from '@persistence/repositories/userFmSettingRepository';
import { FmSettingService } from '@bot/services/system/fmSettingService';
import { LastfmApi } from '@lastfm/api/lastfmApi';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { SpotifyTokenManager } from '@spotify/api/spotifyTokenManager';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { DeezerApi } from '@deezer/api/deezerApi';
import { AppleMusicTokenScraper } from '@applemusic/api/appleMusicTokenScraper';
import { AppleMusicWebApi } from '@applemusic/api/appleMusicWebApi';
import { AppleMusicSearchApi } from '@applemusic/api/appleMusicSearchApi';
import { PuppeteerService } from '@images/generators/puppeteerService';
import { ChartService as ImageChartService } from '@images/generators/chartService';
import { WhoKnowsGenerator } from '@images/generators/whoKnowsGenerator';
import { ChartService as BotChartService } from '@bot/services/charts/chartService';
import { ClientLogHandler } from '@bot/handlers/logs/clientLogHandler';
import { InteractionHandler } from '@bot/handlers/interactions/interactionHandler';
import { CommandHandler } from '@bot/handlers/commands/commandHandler';
import { UpdateQueueHandler } from '@bot/handlers/queues/updateQueueHandler';
import { UserEventHandler } from '@bot/handlers/users/userEventHandler';
import { UserSlashCommands } from '@bot/slashCommands/user/userSlashCommands';
import { StaticSlashCommands } from '@bot/slashCommands/meta/staticSlashCommands';
import { ChartSlashCommands } from '@bot/slashCommands/charts/chartSlashCommands';
import { LoginSlashCommands } from '@bot/slashCommands/user/loginSlashCommands';
import { PlayCommands } from '@bot/textCommands/lastfm/playCommands';
import { StaticCommands } from '@bot/textCommands/meta/staticCommands';
import { ChartCommands } from '@bot/textCommands/lastfm/chartCommands';
import { LoginCommands } from '@bot/textCommands/lastfm/loginCommands';
import { SettingsInteractions } from '@bot/interactions/user/settingsInteractions';
import { UserSettingsInteractions } from '@bot/interactions/user/userSettingsInteractions';
import { ChartInteractions } from '@bot/interactions/charts/chartInteractions';
import { SettingsSlashCommands } from '@bot/slashCommands/user/settingsSlashCommands';
import { SettingsCommands } from '@bot/textCommands/user/settingsCommands';
import { AlbumSlashCommands } from '@bot/slashCommands/library/albumSlashCommands';
import { AlbumCommands } from '@bot/textCommands/lastfm/albumCommands';
import { AlbumInteractions } from '@bot/interactions/library/albumInteractions';
import { FmModeInteractions } from '@bot/interactions/common/fmModeInteractions';
import { WhoKnowsRepository } from '@persistence/repositories/whoKnowsRepository';
import { FriendsRepository } from '@persistence/repositories/friendsRepository';
import { FriendsService } from '@bot/services/social/friendsService';
import { WhoKnowsArtistService } from '@bot/services/whoKnows/whoKnowsArtistService';
import { WhoKnowsTrackService } from '@bot/services/whoKnows/whoKnowsTrackService';
import { WhoKnowsAlbumService } from '@bot/services/whoKnows/whoKnowsAlbumService';
import { WhoKnowsPlayService } from '@bot/services/whoKnows/whoKnowsPlayService';
import { ArtistGenreRepository } from '@persistence/repositories/artistGenreRepository';
import { GenreService } from '@bot/services/library/genreService';
import { FriendInteractions } from '@bot/interactions/social/friendInteractions';
import { WhoKnowsCommands } from '@bot/textCommands/guild/whoKnowsCommands';
import { FriendsCommands } from '@bot/textCommands/lastfm/friendsCommands';
import { WhoKnowsSlashCommands } from '@bot/slashCommands/whoknows/whoKnowsSlashCommands';
import { FriendSlashCommands } from '@bot/slashCommands/social/friendSlashCommands';
import { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import { SpotifyResolver } from '@bot/services/music/spotifyResolver';
import { SpotifyScraperService } from '@bot/services/music/spotifyScraperService';
import { DeezerResolver } from '@bot/services/music/deezerResolver';
import { AppleMusicResolver } from '@bot/services/music/appleMusicResolver';
import { PlaylistChunkManager } from '@bot/services/music/playlistChunkManager';
import { QueueService } from '@bot/services/music/queueService';
import { MusicService } from '@bot/services/music/musicService';
import { LyricsService } from '@bot/services/music/lyricsService';
import { VoiceChannelStatusService } from '@bot/services/music/voiceChannelStatusService';
import { MusicHandler } from '@bot/handlers/music/musicHandler';
import { MusicInteractions } from '@bot/interactions/music/musicInteractions';
import { MusicCommands } from '@bot/textCommands/music/musicCommands';
import { MusicSlashCommands } from '@bot/slashCommands/music/musicSlashCommands';
import { MusicHistoryRepository } from '@persistence/repositories/musicHistoryRepository';
import { EssentiaService } from '@bot/services/audio/essentiaService';
import { PreviewResolverService } from '@bot/services/audio/previewResolverService';
import { TrackDetailsService } from '@bot/services/audio/trackDetailsService';
import { VoiceMessageService } from '@bot/services/audio/voiceMessageService';
import { TrackSlashCommands } from '@bot/slashCommands/library/trackSlashCommands';
import { TrackCommands } from '@bot/textCommands/lastfm/trackCommands';
import { TrackPreviewInteractions } from '@bot/interactions/library/trackPreviewInteractions';
import { OverviewService } from '@bot/services/library/overviewService';
import { TopSlashCommands } from '@bot/slashCommands/library/topSlashCommands';
import { CrownRepository } from '@persistence/repositories/crownRepository';
import { FmFooterRepository } from '@persistence/repositories/fmFooterRepository';
import { GuildMusicSettingsRepository } from '@persistence/repositories/guildMusicSettingsRepository';
import { AbuseFilterService } from '@bot/services/system/abuseFilterService';
import { AbuseFlagRepository } from '@persistence/repositories/abuseFlagRepository';
import { CrownService } from '@bot/services/crown/crownService';
import { CrownInteractions } from '@bot/interactions/crown/crownInteractions';
import { CrownCommands } from '@bot/textCommands/guild/crownCommands';
import { CrownSlashCommands } from '@bot/slashCommands/crown/crownSlashCommands';
import { OverviewSlashCommands } from '@bot/slashCommands/library/overviewSlashCommands';
import { TopCommands } from '@bot/textCommands/lastfm/topCommands';
import { OverviewCommands } from '@bot/textCommands/lastfm/overviewCommands';
import { TopInteractions } from '@bot/interactions/library/topInteractions';
import { ArtistTrackService } from '@bot/services/library/artistTrackService';
import { ArtistTrackSlashCommands } from '@bot/slashCommands/library/artistTrackSlashCommands';
import { ArtistTrackCommands } from '@bot/textCommands/lastfm/artistTrackCommands';
import { ArtistTrackInteractions } from '@bot/interactions/library/artistTrackInteractions';
import { UpdateCommands } from '@bot/textCommands/lastfm/updateCommands';
import { UpdateSlashCommands } from '@bot/slashCommands/music/updateSlashCommands';
import { MusicBrainzService } from '@bot/services/media/musicBrainzService';
import { ArtistCommands } from '@bot/textCommands/lastfm/artistCommands';
import { ArtistSlashCommands } from '@bot/slashCommands/library/artistSlashCommands';
import { ArtistInteractions } from '@bot/interactions/library/artistInteractions';
import { CountryService } from '@bot/services/library/countryService';
import { TasteService } from '@bot/services/library/tasteService';
import { TasteInteractions } from '@bot/interactions/library/tasteInteractions';
import { RecentInteractions } from '@bot/interactions/library/recentInteractions';
import { RymInteractions } from '@bot/interactions/library/rymInteractions';
import { TasteCommands } from '@bot/textCommands/lastfm/tasteCommands';
import { TasteSlashCommands } from '@bot/slashCommands/social/tasteSlashCommands';

import { PlayHistoryService } from '@bot/services/library/playHistoryService';
import { PlaycountCommands } from '@bot/textCommands/lastfm/playcountCommands';
import { PlaycountSlashCommands } from '@bot/slashCommands/library/playcountSlashCommands';
import { PlaycountInteractions } from '@bot/interactions/library/playcountInteractions';
import { ProfileService } from '@bot/services/user/profileService';
import { ProfileInteractions } from '@bot/interactions/user/profileInteractions';
import { ProfileCommands } from '@bot/textCommands/lastfm/profileCommands';
import { ProfileSlashCommands } from '@bot/slashCommands/user/profileSlashCommands';
import { StreakService } from '@bot/services/user/streakService';
import { StreakCommands } from '@bot/textCommands/lastfm/streakCommands';
import { StreakSlashCommands } from '@bot/slashCommands/user/streakSlashCommands';
import { LibrarySearchService } from '@bot/services/library/librarySearchService';
import { LibrarySearchInteractions } from '@bot/interactions/library/librarySearchInteractions';
import { LibrarySearchCommands } from '@bot/textCommands/lastfm/librarySearchCommands';
import { LibrarySearchSlashCommands } from '@bot/slashCommands/library/librarySearchSlashCommands';
import { GuildRankingService } from '@bot/services/guild/guildRankingService';
import { ServerInteractions } from '@bot/interactions/guild/serverInteractions';
import { ServerCommands } from '@bot/textCommands/guild/serverCommands';
import { ServerSlashCommands } from '@bot/slashCommands/guild/serverSlashCommands';
import { GenreInteractions } from '@bot/interactions/library/genreInteractions';
import { GenreCommands } from '@bot/textCommands/lastfm/genreCommands';
import { GenreSlashCommands } from '@bot/slashCommands/library/genreSlashCommands';
import { WorldMapGenerator } from '@images/generators/worldMapGenerator';
import { ReceiptGenerator } from '@images/generators/receiptGenerator';
import { CountryInteractions } from '@bot/interactions/library/countryInteractions';
import { CountryCommands } from '@bot/textCommands/lastfm/countryCommands';
import { CountrySlashCommands } from '@bot/slashCommands/library/countrySlashCommands';
import { GameService } from '@bot/services/guild/gameService';
import { GameInteractions } from '@bot/interactions/guild/gameInteractions';
import { GameCommands } from '@bot/textCommands/lastfm/gameCommands';
import { GameSlashCommands } from '@bot/slashCommands/guild/gameSlashCommands';
import { MusicIntelligenceService } from '@bot/services/library/musicIntelligenceService';
import { IntelligenceCommands } from '@bot/textCommands/lastfm/intelligenceCommands';
import { IntelligenceSlashCommands } from '@bot/slashCommands/intelligence/intelligenceSlashCommands';
import { GuildAdminService } from '@bot/services/guild/guildAdminService';
import { GuildAdminCommands } from '@bot/textCommands/guild/guildAdminCommands';
import { GuildAdminSlashCommands } from '@bot/slashCommands/guild/guildAdminSlashCommands';
import { BotScrobblingService } from '@bot/services/music/botScrobblingService';
import { FeaturedService } from '@bot/services/library/featuredService';
import { ShortcutService } from '@bot/services/user/shortcutService';
import { UserHubInteractions } from '@bot/interactions/user/userHubInteractions';
import { UserHubCommands } from '@bot/textCommands/user/userHubCommands';
import { UserHubSlashCommands } from '@bot/slashCommands/user/userHubSlashCommands';
import { IcebergGenerator } from '@images/generators/icebergGenerator';
import { IntelligenceInteractions } from '@bot/interactions/intelligence/intelligenceInteractions';
import { ImportService } from '@bot/services/library/importService';
import { AppleMusicService } from '@bot/services/media/appleMusicService';
import { ImportCommands } from '@bot/textCommands/thirdParty/importCommands';
import { ImportSlashCommands } from '@bot/slashCommands/imports/importSlashCommands';
import { StreamingCommands } from '@bot/textCommands/thirdParty/streamingCommands';
import { StreamingSlashCommands } from '@bot/slashCommands/music/streamingSlashCommands';
import { RateMyCommands } from '@bot/textCommands/thirdParty/rateMyCommands';
import { RateMySlashCommands } from '@bot/slashCommands/music/rateMySlashCommands';
import { RymTransport } from '@rateyourmusic/api/rymTransport';
import { HelpInteractions } from '@bot/interactions/meta/helpInteractions';
import { HelpCommands } from '@bot/textCommands/meta/helpCommands';
import { HelpSlashCommands } from '@bot/slashCommands/meta/helpSlashCommands';
import { LyricStatusService } from '@bot/services/music/lyricStatusService';
import { ExposedService } from '@bot/services/social/exposedService';
import { ExposedCommands } from '@bot/textCommands/lastfm/exposedCommands';
import { ExposedSlashCommands } from '@bot/slashCommands/social/exposedSlashCommands';
import type { ICache } from '@domain/interfaces/ports/icache';
import { ICACHE } from '@domain/interfaces/ports/icache';
import type { ITelemetry } from '@domain/interfaces/ports/telemetry';
import { ITELEMETRY } from '@domain/interfaces/ports/telemetry';

/**
 * Consecutive per-shard send failures. The first few are DEBUG (a reconnecting
 * shard is routine); a sustained run is WARN (the bot is not reaching Discord).
 */
export const BROADCAST_PATCH_WARN_AFTER = 5;

let broadcastShardFailureCount = 0;

export function getBroadcastShardFailureCount(): number {
  return broadcastShardFailureCount;
}

export function resetBroadcastShardFailureCountForTest(): void {
  broadcastShardFailureCount = 0;
}

type BroadcastSendFn = (shardId: number, packet: unknown) => unknown;

interface BroadcastManagerLike {
  broadcast?: unknown;
  shards?: unknown;
  _ws?: unknown;
}

function recordBroadcastShardFailure(err: unknown, shardId: number): void {
  broadcastShardFailureCount += 1;
  if (broadcastShardFailureCount >= BROADCAST_PATCH_WARN_AFTER) {
    Logger.warn(
      { err, shardId, failures: broadcastShardFailureCount },
      'Repeated shard broadcast failure',
    );
  } else {
    Logger.debug({ err, shardId, failures: broadcastShardFailureCount }, 'Failed to broadcast packet to shard');
  }
}

/**
 * Replace discord.js WebSocketManager.broadcast with a per-shard _ws.send loop
 * so one missing/reconnecting shard cannot reject the whole broadcast.
 *
 * Gated on version AND shape: discord.js v14 with a function broadcast and a
 * shards map. A _ws that is PRESENT but has no function send is drift (a
 * discord.js upgrade renamed the private field): keep the native broadcast and
 * log a WARN so it fails loudly instead of silently running unpatched. A _ws
 * that is ABSENT is the normal pre-connect state (measured: null on a fresh
 * Client, set on connect): still patch, resolving send live per call and
 * skipping unconnected shards at DEBUG.
 */
export function patchWebSocketBroadcast(manager: unknown): boolean {
  if (typeof discordJsVersion !== 'string' || !discordJsVersion.startsWith('14.')) {
    Logger.warn(
      { discordJsVersion },
      'Skipping WebSocket broadcast patch: unsupported discord.js version, using native broadcast',
    );
    return false;
  }
  const candidate = manager as BroadcastManagerLike | null | undefined;
  if (!candidate || typeof candidate !== 'object' || typeof candidate.broadcast !== 'function') {
    Logger.warn('Skipping WebSocket broadcast patch: broadcast shape mismatch, using native broadcast');
    return false;
  }
  const shards = candidate.shards as { keys?: unknown } | null | undefined;
  if (!shards || typeof shards.keys !== 'function') {
    Logger.warn('Skipping WebSocket broadcast patch: shards shape mismatch, using native broadcast');
    return false;
  }
  if (candidate._ws !== null && candidate._ws !== undefined) {
    const present = candidate._ws as { send?: unknown };
    if (typeof present.send !== 'function') {
      Logger.warn('Skipping WebSocket broadcast patch: _ws.send shape mismatch, using native broadcast');
      return false;
    }
  }
  const shardKeys = shards.keys as () => Iterable<number>;
  const target = candidate as { broadcast: (packet: unknown) => void };
  const holder = candidate;
  target.broadcast = (packet: unknown) => {
    try {
      for (const shardId of shardKeys.call(shards)) {
        const live = holder._ws as { send?: unknown } | null | undefined;
        if (!live || typeof live.send !== 'function') {
          Logger.debug({ shardId }, 'Skipping shard broadcast: transport not connected');
          continue;
        }
        let result: unknown;
        try {
          result = (live.send as BroadcastSendFn).call(live, shardId, packet);
        } catch (err) {
          recordBroadcastShardFailure(err, shardId);
          continue;
        }
        Promise.resolve(result).then(
          () => {
            broadcastShardFailureCount = 0;
          },
          (err: unknown) => {
            recordBroadcastShardFailure(err, shardId);
          },
        );
      }
    } catch (err) {
      Logger.debug({ err }, 'Error in WebSocketManager broadcast safe wrapper');
    }
  };
  return true;
}

/**
 * Boot self-test: exercise the same patch path against a fake manager with no
 * network. Returns true when a packet reaches _ws.send. Never throws, never
 * touches the real client, so configureContainer can run it every boot and
 * tests can call it directly.
 */
export function selfTestBroadcastPatch(): boolean {
  try {
    resetBroadcastShardFailureCountForTest();
    const seen: number[] = [];
    const fake = {
      broadcast(_packet: unknown): void {
        // Replaced by the patch under test.
      },
      shards: new Map<number, unknown>([[0, {}]]),
      _ws: {
        send(shardId: number): Promise<string> {
          seen.push(shardId);
          return Promise.resolve('ok');
        },
      },
    };
    if (!patchWebSocketBroadcast(fake)) return false;
    fake.broadcast({ op: 1 });
    return seen.length === 1 && seen[0] === 0 && getBroadcastShardFailureCount() === 0;
  } catch {
    return false;
  }
}

export const configureContainer = (): void => {
  const settings = ConfigData.Data;
  void settings;

  container.registerInstance(PrismaClient, prisma);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
    presence: {
      activities: [{ name: 'scrobbles', type: ActivityType.Watching }],
      status: 'online',
    },
    rest: {
      timeout: 25000,
    },
  });

  // Guard against unhandled promise rejections from discord.js WebSocketManager.broadcast
  // when shards are reconnecting or not yet found in the sharding strategy.
  patchWebSocketBroadcast(client.ws);
  if (!selfTestBroadcastPatch()) {
    Logger.warn('WebSocket broadcast self-test failed, using native broadcast');
  }
  container.registerInstance(Client, client);

  const errorRateTracker = new LastfmErrorRateTracker();
  const settingService = new SettingService();
  const cache = new CacheService();
  const componentTracker = new ComponentInteractionTracker();
  const componentPaginatorService = new ComponentPaginatorService();
  container.registerInstance(LastfmErrorRateTracker, errorRateTracker);
  container.registerInstance(SettingService, settingService);
  container.registerInstance(CacheService, cache);
  // Bind the narrow port too, so src/ can depend on the cache capability
  // without importing the implementation from @bot/* (plan 3.2).
  container.registerInstance<ICache>(ICACHE, cache);
  container.registerInstance(ComponentInteractionTracker, componentTracker);
  container.registerInstance(ComponentPaginatorService, componentPaginatorService);

  const spotifyTokenManager = new SpotifyTokenManager();
  // The SAME tracker the container hands to CrownService/ArtworkService and that
  // TimerService resets on its statistics tick. It used to be a second, private
  // `new LastfmErrorRateTracker()`, so nothing else could ever see a Last.fm
  // call: `isElevated()` answered false through every outage (the crown-steal
  // kill switch could not fire) and `logAndReset()` early-returned on a
  // permanent zero. The writer and the reader have to be one object.
  const lastfmApi = new LastfmApi(errorRateTracker);
  const spotifySearchApi = new SpotifySearchApi(spotifyTokenManager);
  const deezerApi = new DeezerApi();
  const appleMusicTokenScraper = new AppleMusicTokenScraper();
  const appleMusicWebApi = new AppleMusicWebApi(appleMusicTokenScraper);
  const appleMusicSearchApi = new AppleMusicSearchApi();
  const lastFmRepository = new LastFmRepository(lastfmApi);

  const userRepository = new UserRepository(prisma);
  const guildRepository = new GuildRepository(prisma);
  const guildUserRepository = new GuildUserRepository(prisma);
  const channelRepository = new ChannelRepository(prisma);
  const guildDisabledCommandRepository = new GuildDisabledCommandRepository(prisma);
  const artistRepository = new ArtistRepository(prisma);
  const albumRepository = new AlbumRepository(prisma);
  const trackRepository = new TrackRepository(prisma);
  const playRepository = new PlayRepository(prisma);
  const userFmSettingRepository = new UserFmSettingRepository(prisma);
  const whoKnowsRepository = new WhoKnowsRepository(prisma);
  const friendsRepository = new FriendsRepository(prisma);
  const artistGenreRepository = new ArtistGenreRepository(prisma);
  const fmFooterRepository = new FmFooterRepository(prisma);

  const userUpdateQueue = new UserUpdateQueueService(cache);
  const userIndexQueue = new UserIndexQueueService(cache);

  const prefixService = new PrefixService(cache, guildRepository);
  const userService = new UserService(userRepository, cache, userUpdateQueue);
  const guildService = new GuildService(guildRepository, cache);
  const guildUserService = new GuildUserService(guildUserRepository, userRepository);
  const disabledChannelService = new DisabledChannelService(cache, channelRepository);
  const guildDisabledCommandService = new GuildDisabledCommandService(
    cache,
    guildDisabledCommandRepository,
  );
  const channelToggledCommandService = new ChannelToggledCommandService(
    cache,
    channelRepository,
  );

  const genreService = new GenreService(cache, artistGenreRepository, artistRepository, lastFmRepository, prisma);
  const friendsService = new FriendsService(friendsRepository, userRepository);
  const crownRepository = new CrownRepository(prisma);
  const abuseFlagRepository = new AbuseFlagRepository(prisma);
  const abuseFilterService = new AbuseFilterService(prisma, abuseFlagRepository);
  container.registerInstance(AbuseFilterService, abuseFilterService);
  const crownService = new CrownService(crownRepository, userService, lastFmRepository, errorRateTracker, abuseFilterService);
  const whoKnowsArtistService = new WhoKnowsArtistService(
    whoKnowsRepository,
    guildUserRepository,
    guildService,
    genreService,
    crownService,
  );
  const whoKnowsTrackService = new WhoKnowsTrackService(
    whoKnowsRepository,
    guildUserRepository,
    guildService,
    trackRepository,
    artistRepository,
  );
  const whoKnowsAlbumService = new WhoKnowsAlbumService(
    whoKnowsRepository,
    guildUserRepository,
    guildService,
    albumRepository,
    artistRepository,
  );
  const whoKnowsPlayService = new WhoKnowsPlayService(cache);

  const artworkService = new ArtworkService(
    spotifySearchApi,
    deezerApi,
    appleMusicWebApi,
    appleMusicSearchApi,
    artistRepository,
    albumRepository,
    trackRepository,
    lastFmRepository,
    cache,
    errorRateTracker,
  );
  const albumEnrichmentService = new AlbumEnrichmentService(
    spotifySearchApi,
    artistRepository,
    albumRepository,
    cache,
  );
  const colorService = new ColorService(cache);
  const artistsService = new ArtistsService(lastFmRepository, cache, undefined, colorService);
  const albumService = new AlbumService(
    lastFmRepository,
    artistRepository,
    albumRepository,
    userRepository,
    guildUserRepository,
    artworkService,
    spotifySearchApi,
    prisma,
    cache,
    colorService,
  );
  const trackService = new TrackService(
    lastFmRepository,
    artistRepository,
    trackRepository,
    whoKnowsRepository,
    artworkService,
    cache,
    prisma,
  );
  const fmSettingService = new FmSettingService(userFmSettingRepository, cache);

  const indexService = new IndexService(
    userIndexQueue,
    cache,
    userRepository,
    artistRepository,
    albumRepository,
    trackRepository,
    playRepository,
    lastFmRepository,
  );
  const updateService = new UpdateService(
    userRepository,
    playRepository,
    lastFmRepository,
    cache,
    (userId) => indexService.recalculateTopLists(userId),
    artistRepository,
    albumRepository,
    trackRepository,
    genreService,
  );

  const loginService = new LoginService(
    lastFmRepository,
    userService,
    cache,
    indexService,
    userRepository,
  );

  const paginationService = new PaginationService(componentTracker);

  const puppeteerService = new PuppeteerService();
  const imageChartService = new ImageChartService(puppeteerService);
  const whoKnowsGenerator = new WhoKnowsGenerator(puppeteerService);
  const imageUploadService = container.resolve(ImageUploadService);
  const chartService = new BotChartService(
    artworkService,
    lastFmRepository,
    userService,
    albumEnrichmentService,
    imageChartService,
    imageUploadService,
    cache,
  );

  const timerService = new TimerService();
  const healthServer = new HealthServer();
  const reconcileService = new ReconcileService(indexService);

  container.registerInstance(HealthServer, healthServer);

  container.registerInstance(UserRepository, userRepository);
  container.registerInstance(GuildRepository, guildRepository);
  container.registerInstance(GuildUserRepository, guildUserRepository);
  container.registerInstance(ChannelRepository, channelRepository);
  container.registerInstance(GuildDisabledCommandRepository, guildDisabledCommandRepository);
  container.registerInstance(ArtistRepository, artistRepository);
  container.registerInstance(AlbumRepository, albumRepository);
  container.registerInstance(TrackRepository, trackRepository);
  container.registerInstance(PlayRepository, playRepository);
  container.registerInstance(LastfmApi, lastfmApi);
  container.registerInstance(LastFmRepository, lastFmRepository);
  container.registerInstance(SpotifyTokenManager, spotifyTokenManager);
  container.registerInstance(SpotifySearchApi, spotifySearchApi);
  container.registerInstance(DeezerApi, deezerApi);
  container.registerInstance(AppleMusicTokenScraper, appleMusicTokenScraper);
  container.registerInstance(AppleMusicWebApi, appleMusicWebApi);
  container.registerInstance(AppleMusicSearchApi, appleMusicSearchApi);

  container.registerInstance(UserUpdateQueueService, userUpdateQueue);
  container.registerInstance(UserIndexQueueService, userIndexQueue);
  container.registerInstance(IndexService, indexService);
  container.registerInstance(UpdateService, updateService);
  container.registerInstance(LoginService, loginService);

  container.registerInstance(PrefixService, prefixService);
  container.registerInstance(UserService, userService);
  container.registerInstance(GuildService, guildService);
  container.registerInstance(GuildUserService, guildUserService);
  container.registerInstance(DisabledChannelService, disabledChannelService);
  container.registerInstance(GuildDisabledCommandService, guildDisabledCommandService);
  container.registerInstance(ChannelToggledCommandService, channelToggledCommandService);
  container.registerInstance(ArtworkService, artworkService);
  container.registerInstance(AlbumEnrichmentService, albumEnrichmentService);
  container.registerInstance(ArtistsService, artistsService);
  container.registerInstance(AlbumService, albumService);
  container.registerInstance(TrackService, trackService);

  container.registerInstance(PaginationService, paginationService);
  container.registerInstance(ColorService, colorService);
  container.registerInstance(FmSettingService, fmSettingService);
  container.registerInstance(UserFmSettingRepository, userFmSettingRepository);
  container.registerInstance(WhoKnowsRepository, whoKnowsRepository);
  container.registerInstance(FmFooterRepository, fmFooterRepository);
  container.registerInstance(FriendsRepository, friendsRepository);

  container.registerInstance(ArtistGenreRepository, artistGenreRepository);
  container.registerInstance(GenreService, genreService);
  container.registerInstance(FriendsService, friendsService);
  container.registerInstance(CrownRepository, crownRepository);
  container.registerInstance(AbuseFlagRepository, abuseFlagRepository);
  container.registerInstance(CrownService, crownService);
  container.registerInstance(WhoKnowsArtistService, whoKnowsArtistService);
  container.registerInstance(WhoKnowsTrackService, whoKnowsTrackService);
  container.registerInstance(WhoKnowsAlbumService, whoKnowsAlbumService);
  container.registerInstance(WhoKnowsPlayService, whoKnowsPlayService);

  container.registerInstance('IGuildRepository', guildRepository);
  container.registerInstance('IUserRepository', userRepository);
  container.registerInstance('ILastfmRepository', lastFmRepository);
  container.registerInstance(TimerService, timerService);
  container.registerInstance(ReconcileService, reconcileService);
  // Bind the narrow port too, so src/lastfm can inject a capability rather than
  // resolve a class out of the container from a lower layer (plan 3.2/3.3).

  const lyricsService = new LyricsService();
  const nowPlayingInteractions = new NowPlayingInteractions(
    userRepository,
    lastFmRepository,
    trackService,
    lyricsService,
  );
  container.registerInstance(LyricsService, lyricsService);
  container.registerInstance(NowPlayingInteractions, nowPlayingInteractions);

  const lyricStatusService = new LyricStatusService(client, lyricsService, prisma);
  container.registerInstance(LyricStatusService, lyricStatusService);

  const friendInteractions = new FriendInteractions(friendsService, userService, colorService);
  container.registerInstance(FriendInteractions, friendInteractions);

  container.registerInstance(SettingsInteractions, new SettingsInteractions(prefixService));
  const userSettingsInteractions = new UserSettingsInteractions(userService, fmSettingService, prefixService);
  container.registerInstance(UserSettingsInteractions, userSettingsInteractions);
  container.registerInstance(ChartInteractions, new ChartInteractions(chartService, userService, colorService));
  container.registerInstance(FmModeInteractions, new FmModeInteractions(userService, fmSettingService));
  container.registerInstance(SettingsSlashCommands, new SettingsSlashCommands(prefixService, colorService, userService));
  container.registerInstance(PuppeteerService, puppeteerService);
  container.registerInstance(ImageChartService, imageChartService);
  container.registerInstance(WhoKnowsGenerator, whoKnowsGenerator);
  container.registerInstance(ImageUploadService, imageUploadService);
  container.registerInstance(BotChartService, chartService);

  container.registerInstance(
    WhoKnowsCommands,
    new WhoKnowsCommands(
      userService,
      settingService,
      artworkService,
      artistsService,
      albumService,
      trackService,
      friendsService,
      whoKnowsArtistService,
      whoKnowsTrackService,
      whoKnowsAlbumService,
      whoKnowsPlayService,
      lastFmRepository,
      updateService,
    ),
  );
  container.registerInstance(
    FriendsCommands,
    new FriendsCommands(userService, friendsService, lastFmRepository),
  );
  container.registerInstance(
    WhoKnowsSlashCommands,
    new WhoKnowsSlashCommands(
      userService,
      artworkService,
      artistsService,
      albumService,
      trackService,
      friendsService,
      whoKnowsArtistService,
      whoKnowsTrackService,
      whoKnowsAlbumService,
      whoKnowsPlayService,
      lastFmRepository,
      updateService,
    ),
  );
  container.registerInstance(
    FriendSlashCommands,
    new FriendSlashCommands(userService, friendsService, lastFmRepository),
  );

  const albumInteractions = new AlbumInteractions(albumService, userService, colorService);
  container.registerInstance(AlbumInteractions, albumInteractions);

  const musicHistoryRepository = new MusicHistoryRepository();
  const moonlinkManager = new MoonlinkManager(cache);
  const spotifyScraperService = new SpotifyScraperService();
  const spotifyResolver = new SpotifyResolver(spotifyTokenManager, spotifyScraperService);
  const guildMusicSettingsRepository = new GuildMusicSettingsRepository(prisma);
  container.registerInstance(GuildMusicSettingsRepository, guildMusicSettingsRepository);
  const queueService = new QueueService(musicHistoryRepository, guildMusicSettingsRepository);
  const playlistChunkManager = new PlaylistChunkManager(moonlinkManager, spotifyScraperService);
  const musicService = new MusicService(moonlinkManager, spotifyResolver, queueService, playlistChunkManager, artworkService);
  // Provider link resolvers share the container's API singletons (one token
  // scrape cache, one Deezer client) and slot into MusicService via setters
  // — never constructor params (tests build it positionally).
  const deezerResolver = new DeezerResolver(deezerApi);
  const appleMusicResolver = new AppleMusicResolver(appleMusicTokenScraper);
  musicService.setDeezerResolver(deezerResolver);
  musicService.setAppleMusicResolver(appleMusicResolver);
  const voiceChannelStatusService = new VoiceChannelStatusService(client);
  const musicInteractions = new MusicInteractions(musicService, colorService, lyricsService);
  const musicCommands = new MusicCommands(musicService, colorService, lyricsService, musicInteractions);
  const musicSlashCommands = new MusicSlashCommands(musicService, colorService, lyricsService, musicInteractions);

  container.registerInstance(MusicHistoryRepository, musicHistoryRepository);
  container.registerInstance(MoonlinkManager, moonlinkManager);
  container.registerInstance(SpotifyResolver, spotifyResolver);
  container.registerInstance(DeezerResolver, deezerResolver);
  container.registerInstance(AppleMusicResolver, appleMusicResolver);
  container.registerInstance(QueueService, queueService);
  container.registerInstance(MusicService, musicService);

  container.registerInstance(VoiceChannelStatusService, voiceChannelStatusService);
  container.registerInstance(MusicInteractions, musicInteractions);
  container.registerInstance(MusicCommands, musicCommands);
  container.registerInstance(MusicSlashCommands, musicSlashCommands);

  container.registerInstance(
    UserSlashCommands,
    new UserSlashCommands(userService, lastFmRepository, updateService),
  );
  container.registerInstance(StaticSlashCommands, new StaticSlashCommands());
  container.registerInstance(HelpSlashCommands, new HelpSlashCommands());
  container.registerInstance(HelpCommands, new HelpCommands());
  container.registerInstance(HelpInteractions, new HelpInteractions(prefixService, colorService));
  container.registerInstance(
    ChartSlashCommands,
    new ChartSlashCommands(chartService, userService, settingService, updateService, colorService),
  );
  container.registerInstance(
    LoginSlashCommands,
    new LoginSlashCommands(loginService, userService, componentTracker),
  );
  container.registerInstance(
    PlayCommands,
    new PlayCommands(userService, lastFmRepository, updateService),
  );
  container.registerInstance(StaticCommands, new StaticCommands());
  container.registerInstance(SettingsCommands, new SettingsCommands(prefixService, colorService, userService, guildService));
  container.registerInstance(
    ChartCommands,
    new ChartCommands(chartService, userService, settingService, updateService, colorService),
  );
  container.registerInstance(
    LoginCommands,
    new LoginCommands(loginService, userService, componentTracker),
  );
  container.registerInstance(
    AlbumSlashCommands,
    new AlbumSlashCommands(userService, albumService, updateService, colorService),
  );
  container.registerInstance(
    AlbumCommands,
    new AlbumCommands(userService, albumService, updateService),
  );

  // TrackDetails + Voice Preview (Essentia BPM/key, flags 8192) — Spotify scraper first for p.scdn.co preview
  const essentiaService = new EssentiaService();
  const previewResolverService = new PreviewResolverService(appleMusicSearchApi, deezerApi, cache, spotifyScraperService, spotifySearchApi);
  const trackDetailsService = new TrackDetailsService(previewResolverService, essentiaService, spotifySearchApi);
  const overviewService = new OverviewService(genreService);
  const topInteractions = container.resolve(TopInteractions);
  const voiceMessageService = new VoiceMessageService();
  // Registered HERE, not in the block below: `TrackPreviewInteractions` is
  // resolved by reflection two lines down and injects this class, and tsyringe
  // does not fail on an unregistered constructor token - it quietly builds a
  // SECOND instance of it. `ArtistTrackInteractions` and `ArtistInteractions`
  // had the same shape, so three classes existed twice each, split between the
  // instance this file hands to one caller and the one handed to the next.
  container.registerInstance(VoiceMessageService, voiceMessageService);
  const trackSlashCommands = new TrackSlashCommands(userService, trackService, trackDetailsService, lastFmRepository, updateService, colorService);
  const trackCommands = new TrackCommands(userService, trackService, trackDetailsService, lastFmRepository, updateService, lyricsService, colorService);
  const trackPreviewInteractions = container.resolve(TrackPreviewInteractions);
  const artistTrackService = new ArtistTrackService();
  container.registerInstance(ArtistTrackService, artistTrackService);
  const artistTrackSlashCommands = new ArtistTrackSlashCommands(userService, artistTrackService, lastFmRepository, updateService);
  const artistTrackCommands = new ArtistTrackCommands(userService, artistTrackService, lastFmRepository, updateService);
  const artistTrackInteractions = container.resolve(ArtistTrackInteractions);

  container.registerInstance(EssentiaService, essentiaService);
  container.registerInstance(PreviewResolverService, previewResolverService);
  container.registerInstance(TrackDetailsService, trackDetailsService);
  container.registerInstance(TrackSlashCommands, trackSlashCommands);
  container.registerInstance(TrackCommands, trackCommands);
  container.registerInstance(TrackPreviewInteractions, trackPreviewInteractions);
  container.registerInstance(ArtistTrackSlashCommands, artistTrackSlashCommands);
  container.registerInstance(ArtistTrackCommands, artistTrackCommands);
  container.registerInstance(ArtistTrackInteractions, artistTrackInteractions);
  container.registerInstance(OverviewService, overviewService);
  container.registerInstance(TopInteractions, topInteractions);
  // Top + Overview (no images, paginator embeds)
  const topSlashCommands = new TopSlashCommands(userService, settingService, lastFmRepository, updateService, colorService, artworkService);
  const overviewSlashCommands = new OverviewSlashCommands(userService, overviewService, updateService, colorService);
  const topCommands = new TopCommands(userService, settingService, lastFmRepository, updateService, colorService, artworkService);
  const overviewCommands = new OverviewCommands(userService, overviewService, updateService, colorService);
  const updateSlashCommands = new UpdateSlashCommands(userService, updateService, indexService);
  const updateCommands = new UpdateCommands(userService, updateService, indexService);
  const musicBrainzService = new MusicBrainzService(cache);
  // Same reason as VoiceMessageService above: `ArtistInteractions` injects this
  // class and is resolved by reflection further down.
  container.registerInstance(MusicBrainzService, musicBrainzService);
  const artistCommands = new ArtistCommands(userService, artistTrackService, musicBrainzService, genreService, spotifySearchApi, lastFmRepository, updateService, artistsService);
  const artistSlashCommands = new ArtistSlashCommands(userService, artistTrackService, musicBrainzService, genreService, spotifySearchApi, lastFmRepository, updateService);
  const artistInteractions = container.resolve(ArtistInteractions);

  container.registerInstance(TopSlashCommands, topSlashCommands);
  container.registerInstance(OverviewSlashCommands, overviewSlashCommands);
  container.registerInstance(TopCommands, topCommands);
  container.registerInstance(OverviewCommands, overviewCommands);
  container.registerInstance(UpdateSlashCommands, updateSlashCommands);
  container.registerInstance(UpdateCommands, updateCommands);
  container.registerInstance(ArtistCommands, artistCommands);
  container.registerInstance(ArtistSlashCommands, artistSlashCommands);
  container.registerInstance(ArtistInteractions, artistInteractions);

  const countryService = new CountryService(prisma, musicBrainzService, cache);
  const tasteService = new TasteService(lastFmRepository, genreService, countryService, cache);
  const tasteInteractions = new TasteInteractions(tasteService, colorService);
  const recentInteractions = new RecentInteractions(lastFmRepository, userService, colorService);
  const tasteCommands = new TasteCommands(userService, tasteService, lastFmRepository, updateService);
  const tasteSlashCommands = new TasteSlashCommands(userService, tasteService, updateService);

  container.registerInstance(CountryService, countryService);
  container.registerInstance(TasteService, tasteService);
  container.registerInstance(TasteInteractions, tasteInteractions);
  container.registerInstance(RecentInteractions, recentInteractions);
  container.registerInstance(TasteCommands, tasteCommands);
  container.registerInstance(TasteSlashCommands, tasteSlashCommands);

  const crownInteractions = new CrownInteractions(crownService, userService, colorService);
  const crownCommands = new CrownCommands(userService, crownService, lastFmRepository, artistsService, updateService);
  const crownSlashCommands = new CrownSlashCommands(userService, crownService, lastFmRepository, artistsService, updateService);

  container.registerInstance(CrownInteractions, crownInteractions);
  container.registerInstance(CrownCommands, crownCommands);
  container.registerInstance(CrownSlashCommands, crownSlashCommands);

  const playHistoryService = new PlayHistoryService(playRepository, lastFmRepository, prisma, genreService, countryService);
  const receiptGenerator = new ReceiptGenerator(puppeteerService);
  const playcountInteractions = new PlaycountInteractions(userService, playHistoryService, artworkService, colorService, lastFmRepository);
  const playcountCommands = new PlaycountCommands(
    userService,
    settingService,
    playHistoryService,
    artistsService,
    albumService,
    trackService,
    artworkService,
    lastFmRepository,
    colorService,
    receiptGenerator,
  );
  const playcountSlashCommands = new PlaycountSlashCommands(
    userService,
    settingService,
    playHistoryService,
    artistsService,
    albumService,
    trackService,
    artworkService,
    lastFmRepository,
    colorService,
    receiptGenerator,
  );

  container.registerInstance(ReceiptGenerator, receiptGenerator);
  container.registerInstance(PlayHistoryService, playHistoryService);
  container.registerInstance(PlaycountInteractions, playcountInteractions);
  container.registerInstance(PlaycountCommands, playcountCommands);
  container.registerInstance(PlaycountSlashCommands, playcountSlashCommands);

  const profileService = new ProfileService(lastFmRepository, friendsRepository);
  const profileInteractions = new ProfileInteractions(userService, profileService, colorService);
  const profileCommands = new ProfileCommands(userService, profileService, colorService);
  const profileSlashCommands = new ProfileSlashCommands(userService, profileService, colorService);

  container.registerInstance(ProfileService, profileService);
  container.registerInstance(ProfileInteractions, profileInteractions);
  container.registerInstance(ProfileCommands, profileCommands);
  container.registerInstance(ProfileSlashCommands, profileSlashCommands);

  const streakService = new StreakService(lastFmRepository);
  const streakCommands = new StreakCommands(userService, streakService, colorService);
  const streakSlashCommands = new StreakSlashCommands(userService, streakService, colorService);

  container.registerInstance(StreakService, streakService);
  container.registerInstance(StreakCommands, streakCommands);
  container.registerInstance(StreakSlashCommands, streakSlashCommands);

  const librarySearchService = new LibrarySearchService();
  const librarySearchInteractions = new LibrarySearchInteractions(librarySearchService, colorService);
  const librarySearchCommands = new LibrarySearchCommands(userService, librarySearchService, colorService);
  const librarySearchSlashCommands = new LibrarySearchSlashCommands(userService, librarySearchService, colorService);

  container.registerInstance(LibrarySearchService, librarySearchService);
  container.registerInstance(LibrarySearchInteractions, librarySearchInteractions);
  container.registerInstance(LibrarySearchCommands, librarySearchCommands);
  container.registerInstance(LibrarySearchSlashCommands, librarySearchSlashCommands);

  const guildRankingService = new GuildRankingService(prisma);
  const serverInteractions = new ServerInteractions(guildRankingService, colorService);
  const serverCommands = new ServerCommands(guildRankingService, colorService);
  const serverSlashCommands = new ServerSlashCommands(guildRankingService, colorService);

  container.registerInstance(GuildRankingService, guildRankingService);
  container.registerInstance(ServerInteractions, serverInteractions);
  container.registerInstance(ServerCommands, serverCommands);
  container.registerInstance(ServerSlashCommands, serverSlashCommands);

  // Built here rather than with the telemetry block above: Top autoposts read
  // real guild leaderboards through GuildRankingService, which is constructed
  // just above. Moving this down keeps the positional wiring honest — the
  // eighth argument is a real service, not a structural guess.
  const telemetryService = new TelemetryService();
  const autopostRepository = new AutopostRepository(prisma);
  container.registerInstance(AutopostRepository, autopostRepository);
  const autopostService = new AutopostService(
    artistsService,
    albumService,
    trackService,
    crownService,
    telemetryService,
    guildRepository,
    autopostRepository,
    guildRankingService,
  );
  container.registerInstance(TelemetryService, telemetryService);
  // Bind the narrow port too, so src/lastfm can inject a capability rather than
  // resolve a class out of the container from a lower layer (plan 3.2/3.3).
  container.registerInstance<ITelemetry>(ITELEMETRY, telemetryService);
  container.registerInstance(AutopostService, autopostService);

  const genreInteractions = new GenreInteractions(genreService, userService);
  const genreCommands = new GenreCommands(userService, settingService, lastFmRepository, genreService, colorService);
  const genreSlashCommands = new GenreSlashCommands(userService, settingService, lastFmRepository, genreService, colorService);

  container.registerInstance(GenreInteractions, genreInteractions);
  container.registerInstance(GenreCommands, genreCommands);
  container.registerInstance(GenreSlashCommands, genreSlashCommands);

  const worldMapGenerator = new WorldMapGenerator(puppeteerService);
  const countryInteractions = new CountryInteractions(countryService, worldMapGenerator, userService);
  const countryCommands = new CountryCommands(userService, settingService, lastFmRepository, countryService, worldMapGenerator, colorService);
  const countrySlashCommands = new CountrySlashCommands(userService, settingService, lastFmRepository, countryService, worldMapGenerator, colorService);

  container.registerInstance(WorldMapGenerator, worldMapGenerator);
  container.registerInstance(CountryInteractions, countryInteractions);
  container.registerInstance(CountryCommands, countryCommands);
  container.registerInstance(CountrySlashCommands, countrySlashCommands);

  const gameService = new GameService(puppeteerService);
  const gameInteractions = new GameInteractions(gameService, colorService);
  const gameCommands = new GameCommands(userService, lastFmRepository, gameService, colorService, artworkService);
  const gameSlashCommands = new GameSlashCommands(userService, lastFmRepository, gameService, colorService, artworkService);

  container.registerInstance(GameService, gameService);
  container.registerInstance(GameInteractions, gameInteractions);
  container.registerInstance(GameCommands, gameCommands);
  container.registerInstance(GameSlashCommands, gameSlashCommands);

  const musicIntelligenceService = new MusicIntelligenceService(prisma, countryService);
  const icebergGenerator = new IcebergGenerator(puppeteerService);
  const intelligenceInteractions = new IntelligenceInteractions(musicIntelligenceService, userService, colorService);
  const intelligenceCommands = new IntelligenceCommands(
    userService,
    settingService,
    lastFmRepository,
    musicIntelligenceService,
    colorService,
    icebergGenerator,
  );
  const intelligenceSlashCommands = new IntelligenceSlashCommands(
    userService,
    settingService,
    lastFmRepository,
    musicIntelligenceService,
    colorService,
    icebergGenerator,
  );

  container.registerInstance(IcebergGenerator, icebergGenerator);
  container.registerInstance(IntelligenceInteractions, intelligenceInteractions);
  container.registerInstance(MusicIntelligenceService, musicIntelligenceService);
  container.registerInstance(IntelligenceCommands, intelligenceCommands);
  container.registerInstance(IntelligenceSlashCommands, intelligenceSlashCommands);

  const guildAdminService = new GuildAdminService(guildUserRepository, userRepository, guildService, prisma);
  const guildAdminCommands = new GuildAdminCommands(guildService, guildAdminService, userService, prefixService, guildDisabledCommandService, colorService, channelToggledCommandService, disabledChannelService);
  const guildAdminSlashCommands = new GuildAdminSlashCommands(guildService, guildAdminService, userService, prefixService, colorService, channelToggledCommandService, disabledChannelService);

  container.registerInstance(GuildAdminService, guildAdminService);
  container.registerInstance(GuildAdminCommands, guildAdminCommands);
  container.registerInstance(GuildAdminSlashCommands, guildAdminSlashCommands);

  const botScrobblingService = new BotScrobblingService(lastFmRepository, userRepository, guildMusicSettingsRepository);
  const featuredService = new FeaturedService(lastFmRepository, prisma);
  const shortcutService = new ShortcutService();
  const userHubInteractions = new UserHubInteractions(botScrobblingService, userService, colorService);
  const userHubCommands = new UserHubCommands(
    userService,
    botScrobblingService,
    featuredService,
    shortcutService,
    prefixService,
    lastFmRepository,
    colorService,
  );
  const userHubSlashCommands = new UserHubSlashCommands(
    userService,
    botScrobblingService,
    featuredService,
    shortcutService,
    prefixService,
    lastFmRepository,
    colorService,
  );

  container.registerInstance(BotScrobblingService, botScrobblingService);
  container.registerInstance(FeaturedService, featuredService);
  container.registerInstance(ShortcutService, shortcutService);
  container.registerInstance(UserHubInteractions, userHubInteractions);
  container.registerInstance(UserHubCommands, userHubCommands);
  container.registerInstance(UserHubSlashCommands, userHubSlashCommands);

  const importService = new ImportService(prisma);
  const appleMusicService = new AppleMusicService();
  const rymTransport = new RymTransport();

  const rateMyCommands = new RateMyCommands(userService, rymTransport, prefixService, lastFmRepository, artworkService, colorService);
  const rateMySlashCommands = new RateMySlashCommands(userService, rymTransport, prefixService, lastFmRepository, artworkService, colorService);
  const rymInteractions = new RymInteractions(rymTransport, colorService, artworkService);

  const importCommands = new ImportCommands(userService, importService, prefixService, colorService);
  const importSlashCommands = new ImportSlashCommands(userService, importService, prefixService, colorService);
  const streamingCommands = new StreamingCommands(userService, spotifySearchApi, appleMusicService, prefixService, lastFmRepository, colorService);
  const streamingSlashCommands = new StreamingSlashCommands(userService, spotifySearchApi, appleMusicService, prefixService, lastFmRepository, colorService);

  container.registerInstance(ImportService, importService);
  container.registerInstance(AppleMusicService, appleMusicService);
  container.registerInstance(RymTransport, rymTransport);
  container.registerInstance(ImportCommands, importCommands);
  container.registerInstance(ImportSlashCommands, importSlashCommands);
  container.registerInstance(StreamingCommands, streamingCommands);
  container.registerInstance(StreamingSlashCommands, streamingSlashCommands);
  container.registerInstance(RateMyCommands, rateMyCommands);
  container.registerInstance(RateMySlashCommands, rateMySlashCommands);
  container.registerInstance(RymInteractions, rymInteractions);

  const exposedService = new ExposedService(genreService, playRepository, prisma);
  const exposedCommands = new ExposedCommands(userService, exposedService);
  const exposedSlashCommands = new ExposedSlashCommands(userService, exposedService);
  container.registerInstance(ExposedService, exposedService);
  container.registerInstance(ExposedCommands, exposedCommands);
  container.registerInstance(ExposedSlashCommands, exposedSlashCommands);

  const musicHandler = new MusicHandler(
    client,
    moonlinkManager,
    queueService,
    colorService,
    voiceChannelStatusService,
    botScrobblingService,
    lyricsService,
    artworkService,
  );
  container.registerInstance(MusicHandler, musicHandler);

  // Playback ingestion notices (skipped tracks, queue cap) surface as a
  // one-line system message in the guild's now-playing channel.
  const musicSystemNotifier = (guildId: string, message: string) => musicHandler.sendSystemMusicNotice(guildId, message);
  musicService.setUnavailableNotifier(musicSystemNotifier);
  musicService.setKaraokeToggleNotifier((guildId: string) => musicHandler.refreshGuildCard(guildId));
  musicService.setCardRefreshNotifier((guildId: string) => musicHandler.refreshGuildCard(guildId));
  playlistChunkManager.setUnavailableNotifier(musicSystemNotifier);

  container.registerInstance(ClientLogHandler, container.resolve(ClientLogHandler));
  // Resolved, not constructed: the 37 dependencies are declared as @inject params.
  container.registerInstance(InteractionHandler, container.resolve(InteractionHandler));
  container.registerInstance(CommandHandler, container.resolve(CommandHandler));
  container.registerInstance(
    UpdateQueueHandler,
    new UpdateQueueHandler(userUpdateQueue, updateService),
  );
  container.registerInstance(UserEventHandler, container.resolve(UserEventHandler));

  container.registerInstance(
    StartupService,
    container.resolve(StartupService),
  );
};

const configureProcessErrorHandling = (): void => {
  // NOTE: unhandledRejection/uncaughtException are registered ONCE, in
  // src/bot/index.ts. They used to be registered here as well, so every
  // unhandled rejection was logged twice and pushed to the error feed twice —
  // doubling the most expensive path (a full error + stack to disk) exactly
  // when the process is already in trouble. Registration here also happened
  // AFTER configureContainer(), so a constructor failure escaped without it.
  // Only the signal handlers belong here.
  process.on('SIGINT', () => { void ShutdownService.shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void ShutdownService.shutdown('SIGTERM'); });
  process.on('SIGHUP', () => { void ShutdownService.shutdown('SIGHUP'); });
};

export class Startup {
  public static async runAsync(): Promise<void> {
    Logger.banner();
    const settings = ConfigData.Data;
    Logger.info(`tvbot initializing in ${settings.environment} environment...`);

    // Signal handlers first: they only need module-level imports, and having
    // them in place before the container is built means a constructor failure
    // still shuts down cleanly.
    configureProcessErrorHandling();
    configureContainer();

    await container.resolve(StartupService).startAsync();

    await new Promise(() => undefined);
  }
}
