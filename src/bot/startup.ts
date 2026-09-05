import { container } from 'tsyringe';
import { Client, GatewayIntentBits, ActivityType } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import { ConfigData } from './configurations/configData';
import { Logger } from '@domain/logger';
import { prisma } from '@persistence/prismaClient';
import { LastfmErrorRateTracker } from '@domain/lastfmErrorRateTracker';
import { StartupService } from './services/startupService';
import { ShutdownService } from './services/shutdownService';
import { TimerService } from './services/timerService';
import { HealthServer } from './services/healthServer';
import { CacheService } from './services/cacheService';
import { PrefixService } from './services/prefixService';
import { UserService } from './services/userService';
import { GuildService } from './services/guild/guildService';
import { GuildUserService } from './services/guild/guildUserService';
import { DisabledChannelService } from './services/guild/disabledChannelService';
import { GuildDisabledCommandService } from './services/guild/guildDisabledCommandService';
import { ChannelToggledCommandService } from './services/guild/channelToggledCommandService';
import { UserUpdateQueueService } from './services/userUpdateQueueService';
import { UserIndexQueueService } from './services/userIndexQueueService';
import { IndexService } from './services/indexService';
import { UpdateService } from './services/updateService';
import { LoginService } from './services/loginService';
import { ColorService } from './services/colorService';
import { ImageUploadService } from './services/imageUploadService';
import { AlbumEnrichmentService } from './services/albumEnrichmentService';
import { ArtworkService } from './services/artworkService';
import { SettingService } from './services/settingService';
import { ArtistsService } from './services/artistsService';
import { AlbumService } from './services/albumService';
import { TrackService } from './services/trackService';
import { ComponentInteractionTracker } from './services/componentInteractionTracker';
import { PaginationService } from './services/paginationService';
import { LocalizationService } from './services/localizationService';
import { UserRepository } from '@persistence/repositories/userRepository';
import { GuildRepository } from '@persistence/repositories/guildRepository';
import { GuildUserRepository } from '@persistence/repositories/guildUserRepository';
import { ChannelRepository } from '@persistence/repositories/channelRepository';
import { GuildDisabledCommandRepository } from '@persistence/repositories/guildDisabledCommandRepository';
import { ArtistRepository } from '@persistence/repositories/artistRepository';
import { AlbumRepository } from '@persistence/repositories/albumRepository';
import { TrackRepository } from '@persistence/repositories/trackRepository';
import { PlayRepository } from '@persistence/repositories/playRepository';
import { UserFmSettingRepository } from '@persistence/repositories/userFmSettingRepository';
import { FmSettingService } from './services/fmSettingService';
import { LastfmApi } from '@lastfm/api/lastfmApi';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { SpotifyTokenManager } from '@spotify/api/spotifyTokenManager';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { DeezerApi } from '@deezer/apis/deezerApi';
import { AppleMusicTokenScraper } from '@applemusic/apis/appleMusicTokenScraper';
import { AppleMusicWebApi } from '@applemusic/apis/appleMusicWebApi';
import { AppleMusicSearchApi } from '@applemusic/apis/appleMusicSearchApi';
import { PuppeteerService } from '@images/generators/puppeteerService';
import { ChartService as ImageChartService } from '@images/generators/chartService';
import { ChartService as BotChartService } from './services/chartService';
import { ClientLogHandler } from './handlers/clientLogHandler';
import { InteractionHandler } from './handlers/interactionHandler';
import { CommandHandler } from './handlers/commandHandler';
import { UpdateQueueHandler } from './handlers/updateQueueHandler';
import { UserEventHandler } from './handlers/userEventHandler';
import { UserSlashCommands } from './slashCommands/userSlashCommands';
import { StaticSlashCommands } from './slashCommands/staticSlashCommands';
import { ChartSlashCommands } from './slashCommands/chartSlashCommands';
import { LoginSlashCommands } from './slashCommands/loginSlashCommands';
import { PlayCommands } from './textCommands/lastfm/playCommands';
import { StaticCommands } from './textCommands/staticCommands';
import { ChartCommands } from './textCommands/lastfm/chartCommands';
import { LoginCommands } from './textCommands/lastfm/loginCommands';
import { SettingsInteractions } from './interactions/settingsInteractions';
import { ChartInteractions } from './interactions/chartInteractions';
import { SettingsSlashCommands } from './slashCommands/settingsSlashCommands';
import { SettingsCommands } from './textCommands/settingsCommands';
import { AlbumSlashCommands } from './slashCommands/albumSlashCommands';
import { AlbumCommands } from './textCommands/lastfm/albumCommands';
import { AlbumInteractions } from './interactions/albumInteractions';
import { FmModeInteractions } from './interactions/fmModeInteractions';
import { WhoKnowsRepository } from '@persistence/repositories/whoKnowsRepository';
import { FriendsRepository } from '@persistence/repositories/friendsRepository';
import { FriendsService } from './services/friendsService';
import { WhoKnowsArtistService } from './services/whoKnows/whoKnowsArtistService';
import { WhoKnowsTrackService } from './services/whoKnows/whoKnowsTrackService';
import { WhoKnowsAlbumService } from './services/whoKnows/whoKnowsAlbumService';
import { WhoKnowsPlayService } from './services/whoKnows/whoKnowsPlayService';
import { ArtistGenreRepository } from '@persistence/repositories/artistGenreRepository';
import { GenreService } from './services/genreService';
import { FriendInteractions } from './interactions/friendInteractions';
import { WhoKnowsCommands } from './textCommands/guild/whoKnowsCommands';
import { FriendsCommands } from './textCommands/lastfm/friendsCommands';
import { WhoKnowsSlashCommands } from './slashCommands/whoKnowsSlashCommands';
import { FriendSlashCommands } from './slashCommands/friendSlashCommands';
import { MoonlinkManager } from './services/music/moonlinkManager';
import { SpotifyResolver } from './services/music/spotifyResolver';
import { SpotifyScraperService } from './services/music/spotifyScraperService';
import { PlaylistChunkManager } from './services/music/playlistChunkManager';
import { QueueService } from './services/music/queueService';
import { MusicService } from './services/music/musicService';
import { LyricsService } from './services/music/lyricsService';
import { VoiceChannelStatusService } from './services/music/voiceChannelStatusService';
import { MusicHandler } from './handlers/musicHandler';
import { MusicInteractions } from './interactions/musicInteractions';
import { MusicCommands } from './textCommands/music/musicCommands';
import { MusicSlashCommands } from './slashCommands/musicSlashCommands';
import { MusicHistoryRepository } from '@persistence/repositories/musicHistoryRepository';
import { EssentiaService } from './services/audio/essentiaService';
import { PreviewResolverService } from './services/audio/previewResolverService';
import { TrackDetailsService } from './services/audio/trackDetailsService';
import { VoiceMessageService } from './services/audio/voiceMessageService';
import { TrackSlashCommands } from './slashCommands/trackSlashCommands';
import { TrackCommands } from './textCommands/lastfm/trackCommands';
import { TrackPreviewInteractions } from './interactions/trackPreviewInteractions';
import { OverviewService } from './services/overviewService';
import { TopSlashCommands } from './slashCommands/topSlashCommands';
import { CrownRepository } from '@persistence/repositories/crownRepository';
import { CrownService } from './services/crown/crownService';
import { CrownInteractions } from './interactions/crownInteractions';
import { CrownCommands } from './textCommands/guild/crownCommands';
import { CrownSlashCommands } from './slashCommands/crownSlashCommands';
import { OverviewSlashCommands } from './slashCommands/overviewSlashCommands';
import { TopCommands } from './textCommands/lastfm/topCommands';
import { OverviewCommands } from './textCommands/lastfm/overviewCommands';
import { TopInteractions } from './interactions/topInteractions';
import { ArtistTrackService } from './services/artistTrackService';
import { ArtistTrackSlashCommands } from './slashCommands/artistTrackSlashCommands';
import { ArtistTrackCommands } from './textCommands/lastfm/artistTrackCommands';
import { ArtistTrackInteractions } from './interactions/artistTrackInteractions';
import { UpdateCommands } from './textCommands/lastfm/updateCommands';
import { UpdateSlashCommands } from './slashCommands/updateSlashCommands';
import { MusicBrainzService } from './services/musicBrainzService';
import { ArtistCommands } from './textCommands/lastfm/artistCommands';
import { ArtistSlashCommands } from './slashCommands/artistSlashCommands';
import { ArtistInteractions } from './interactions/artistInteractions';
import { CountryService } from './services/countryService';
import { TasteService } from './services/tasteService';
import { TasteInteractions } from './interactions/tasteInteractions';
import { RecentInteractions } from './interactions/recentInteractions';
import { TasteCommands } from './textCommands/lastfm/tasteCommands';
import { TasteSlashCommands } from './slashCommands/tasteSlashCommands';
import { EspnFootballProvider } from './services/football/espnFootballProvider';
import { EgyptianFootballProvider } from './services/football/egyptianFootballProvider';
import { ApiFootballProvider } from './services/football/apiFootballProvider';
import { FootballBadgeService } from './services/football/footballBadgeService';
import { FootballService } from './services/football/footballService';
import { FootballInteractions } from './interactions/footballInteractions';
import { FootballCommands } from './textCommands/football/footballCommands';
import { FootballSlashCommands } from './slashCommands/footballSlashCommands';

const configureContainer = (): void => {
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
  const wsManager = client.ws as any;
  if (wsManager && typeof wsManager.broadcast === 'function') {
    wsManager.broadcast = (packet: any) => {
      try {
        for (const shardId of wsManager.shards.keys()) {
          Promise.resolve(wsManager._ws?.send(shardId, packet)).catch((err: unknown) => {
            Logger.debug({ err, shardId }, 'Failed to broadcast packet to shard');
          });
        }
      } catch (err) {
        Logger.debug({ err }, 'Error in WebSocketManager broadcast safe wrapper');
      }
    };
  }
  container.registerInstance(Client, client);

  const errorRateTracker = new LastfmErrorRateTracker();
  const settingService = new SettingService();
  const cache = new CacheService();
  const componentTracker = new ComponentInteractionTracker();
  container.registerInstance(LastfmErrorRateTracker, errorRateTracker);
  container.registerInstance(SettingService, settingService);
  container.registerInstance(CacheService, cache);
  container.registerInstance(ComponentInteractionTracker, componentTracker);

  const spotifyTokenManager = new SpotifyTokenManager();
  const lastfmApi = new LastfmApi();
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

  const userUpdateQueue = new UserUpdateQueueService();
  const userIndexQueue = new UserIndexQueueService();

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

  const genreService = new GenreService(cache, artistGenreRepository, artistRepository, lastFmRepository);
  const friendsService = new FriendsService(friendsRepository, userRepository);
  const crownRepository = new CrownRepository(prisma);
  const crownService = new CrownService(crownRepository, userService);
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
  );
  const albumEnrichmentService = new AlbumEnrichmentService(
    spotifySearchApi,
    artistRepository,
    albumRepository,
    cache,
  );
  const artistsService = new ArtistsService(lastFmRepository, cache);
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
  const colorService = new ColorService(userRepository, fmSettingService, cache);

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
  const localizationService = new LocalizationService();

  const puppeteerService = new PuppeteerService();
  const imageChartService = new ImageChartService(puppeteerService);
  const imageUploadService = new ImageUploadService();
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

  container.registerInstance(HealthServer, healthServer);
  container.registerInstance(CacheService, cache);
  container.registerInstance(LastfmErrorRateTracker, errorRateTracker);
  container.registerInstance(SettingService, settingService);

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

  container.registerInstance(ComponentInteractionTracker, componentTracker);
  container.registerInstance(PaginationService, paginationService);
  container.registerInstance(LocalizationService, localizationService);
  container.registerInstance(ColorService, colorService);
  container.registerInstance(FmSettingService, fmSettingService);
  container.registerInstance(UserFmSettingRepository, userFmSettingRepository);
  container.registerInstance(WhoKnowsRepository, whoKnowsRepository);
  container.registerInstance(FriendsRepository, friendsRepository);

  container.registerInstance(ArtistGenreRepository, artistGenreRepository);
  container.registerInstance(GenreService, genreService);
  container.registerInstance(FriendsService, friendsService);
  container.registerInstance(CrownRepository, crownRepository);
  container.registerInstance(CrownService, crownService);
  container.registerInstance(WhoKnowsArtistService, whoKnowsArtistService);
  container.registerInstance(WhoKnowsTrackService, whoKnowsTrackService);
  container.registerInstance(WhoKnowsAlbumService, whoKnowsAlbumService);
  container.registerInstance(WhoKnowsPlayService, whoKnowsPlayService);

  const friendInteractions = new FriendInteractions(friendsService, userService, colorService);
  container.registerInstance(FriendInteractions, friendInteractions);

  container.registerInstance(SettingsInteractions, new SettingsInteractions(prefixService, colorService));
  container.registerInstance(ChartInteractions, new ChartInteractions(chartService, userService, colorService));
  container.registerInstance(FmModeInteractions, new FmModeInteractions(userService, fmSettingService, colorService));
  container.registerInstance(SettingsSlashCommands, new SettingsSlashCommands(prefixService, colorService));
  container.registerInstance(PuppeteerService, puppeteerService);
  container.registerInstance(ImageChartService, imageChartService);
  container.registerInstance(ImageUploadService, imageUploadService);
  container.registerInstance(BotChartService, chartService);
  container.registerInstance(TimerService, timerService);

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
  const queueService = new QueueService(musicHistoryRepository);
  const playlistChunkManager = new PlaylistChunkManager(moonlinkManager, spotifyScraperService);
  const musicService = new MusicService(moonlinkManager, spotifyResolver, queueService, playlistChunkManager);
  const lyricsService = new LyricsService();
  const voiceChannelStatusService = new VoiceChannelStatusService(client);
  const musicInteractions = new MusicInteractions(musicService, colorService);
  const musicCommands = new MusicCommands(musicService, colorService, lyricsService, musicInteractions);
  const musicSlashCommands = new MusicSlashCommands(musicService, colorService, lyricsService, musicInteractions);

  container.registerInstance(MusicHistoryRepository, musicHistoryRepository);
  container.registerInstance(MoonlinkManager, moonlinkManager);
  container.registerInstance(SpotifyResolver, spotifyResolver);
  container.registerInstance(QueueService, queueService);
  container.registerInstance(MusicService, musicService);
  container.registerInstance(LyricsService, lyricsService);
  container.registerInstance(VoiceChannelStatusService, voiceChannelStatusService);
  container.registerInstance(MusicInteractions, musicInteractions);
  container.registerInstance(MusicCommands, musicCommands);
  container.registerInstance(MusicSlashCommands, musicSlashCommands);

  container.registerInstance(
    UserSlashCommands,
    new UserSlashCommands(userService, lastFmRepository, updateService),
  );
  container.registerInstance(StaticSlashCommands, new StaticSlashCommands());
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
  container.registerInstance(SettingsCommands, new SettingsCommands(prefixService, colorService));
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
  const topInteractions = new TopInteractions();
  const voiceMessageService = new VoiceMessageService();
  const trackSlashCommands = new TrackSlashCommands(userService, trackService, trackDetailsService, lastFmRepository, updateService);
  const trackCommands = new TrackCommands(userService, trackService, trackDetailsService, lastFmRepository, updateService);
  const trackPreviewInteractions = new TrackPreviewInteractions();
  const artistTrackService = new ArtistTrackService();
  const artistTrackSlashCommands = new ArtistTrackSlashCommands(userService, artistTrackService, lastFmRepository, updateService);
  const artistTrackCommands = new ArtistTrackCommands(userService, artistTrackService, lastFmRepository, updateService);
  const artistTrackInteractions = new ArtistTrackInteractions();

  container.registerInstance(EssentiaService, essentiaService);
  container.registerInstance(PreviewResolverService, previewResolverService);
  container.registerInstance(TrackDetailsService, trackDetailsService);
  container.registerInstance(TrackService, trackService);
  container.registerInstance(VoiceMessageService, voiceMessageService);
  container.registerInstance(TrackSlashCommands, trackSlashCommands);
  container.registerInstance(TrackCommands, trackCommands);
  container.registerInstance(TrackPreviewInteractions, trackPreviewInteractions);
  container.registerInstance(ArtistTrackService, artistTrackService);
  container.registerInstance(ArtistTrackSlashCommands, artistTrackSlashCommands);
  container.registerInstance(ArtistTrackCommands, artistTrackCommands);
  container.registerInstance(ArtistTrackInteractions, artistTrackInteractions);
  container.registerInstance(OverviewService, overviewService);
  container.registerInstance(TopInteractions, topInteractions);
  // Top + Overview (no images, paginator embeds)
  const topSlashCommands = new TopSlashCommands(userService, settingService, lastFmRepository, updateService, colorService);
  const overviewSlashCommands = new OverviewSlashCommands(userService, overviewService, updateService, colorService);
  const topCommands = new TopCommands(userService, settingService, lastFmRepository, updateService, colorService);
  const overviewCommands = new OverviewCommands(userService, overviewService, updateService, colorService);
  const updateSlashCommands = new UpdateSlashCommands(userService, updateService, indexService);
  const updateCommands = new UpdateCommands(userService, updateService, indexService);
  const musicBrainzService = new MusicBrainzService(cache);
  const artistCommands = new ArtistCommands(userService, artistTrackService, musicBrainzService, genreService, spotifySearchApi, lastFmRepository, updateService);
  const artistSlashCommands = new ArtistSlashCommands(userService, artistTrackService, musicBrainzService, genreService, spotifySearchApi, lastFmRepository, updateService);
  const artistInteractions = new ArtistInteractions();

  container.registerInstance(TopSlashCommands, topSlashCommands);
  container.registerInstance(OverviewSlashCommands, overviewSlashCommands);
  container.registerInstance(TopCommands, topCommands);
  container.registerInstance(OverviewCommands, overviewCommands);
  container.registerInstance(UpdateSlashCommands, updateSlashCommands);
  container.registerInstance(UpdateCommands, updateCommands);
  container.registerInstance(MusicBrainzService, musicBrainzService);
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

  const espnFootballProvider = new EspnFootballProvider();
  const egyptianFootballProvider = new EgyptianFootballProvider();
  const apiFootballProvider = new ApiFootballProvider();
  const footballBadgeService = new FootballBadgeService();
  const footballService = new FootballService(
    espnFootballProvider,
    egyptianFootballProvider,
    apiFootballProvider,
    footballBadgeService,
  );
  const footballInteractions = new FootballInteractions(footballService, colorService);
  const footballCommands = new FootballCommands(footballService);
  const footballSlashCommands = new FootballSlashCommands(footballService);

  container.registerInstance(EspnFootballProvider, espnFootballProvider);
  container.registerInstance(EgyptianFootballProvider, egyptianFootballProvider);
  container.registerInstance(ApiFootballProvider, apiFootballProvider);
  container.registerInstance(FootballBadgeService, footballBadgeService);
  container.registerInstance(FootballService, footballService);
  container.registerInstance(FootballInteractions, footballInteractions);
  container.registerInstance(FootballCommands, footballCommands);
  container.registerInstance(FootballSlashCommands, footballSlashCommands);

  const musicHandler = new MusicHandler(client, moonlinkManager, queueService, colorService, voiceChannelStatusService);
  container.registerInstance(MusicHandler, musicHandler);

  container.registerInstance(ClientLogHandler, new ClientLogHandler());
  container.registerInstance(InteractionHandler, new InteractionHandler());
  container.registerInstance(CommandHandler, new CommandHandler());
  container.registerInstance(
    UpdateQueueHandler,
    new UpdateQueueHandler(userUpdateQueue, updateService),
  );
  container.registerInstance(UserEventHandler, new UserEventHandler());

  container.registerInstance(
    StartupService,
    new StartupService(),
  );
};

const configureProcessErrorHandling = (): void => {
  process.on('unhandledRejection', (reason) => {
    Logger.error({ err: reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    Logger.fatal({ err: error }, 'Uncaught exception');
  });

  process.on('SIGINT', () => { void ShutdownService.shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void ShutdownService.shutdown('SIGTERM'); });
  process.on('SIGHUP', () => { void ShutdownService.shutdown('SIGHUP'); });
};

class Startup {
  public static async runAsync(): Promise<void> {
    Logger.banner();
    const settings = ConfigData.Data;
    Logger.info(`tvbot initializing in ${settings.environment} environment...`);

    configureContainer();
    configureProcessErrorHandling();

    await container.resolve(StartupService).startAsync();

    await new Promise(() => undefined);
  }
}

Startup.runAsync().catch((err) => {
  Logger.fatal({ err }, 'Fatal error during startup, exiting...');
  process.exit(1);
});
