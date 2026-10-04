import 'reflect-metadata';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SRC_ROOT } from '../../../testSupport/repoRoot';

/**
 * The composition root, and the boot sequence it hands off to.
 *
 * WHY THIS FILE IS THE ONE THAT MATTERS MOST
 * ------------------------------------------
 * Every other test in this repo builds its subject directly, so the whole
 * repository would stay green with `startup.ts` wiring the graph into a knot:
 * a token registered under the wrong class, two constructors given their
 * arguments in the wrong order, a dependency nobody registered, a class that
 * is constructed and then thrown away. None of those is visible from anywhere
 * else, because nothing else constructs the graph.
 *
 * This repo has already shipped that class of defect. `GuildAdminSlashCommands`
 * took two collaborators as OPTIONAL "so the existing 4- and 5-argument
 * construction sites keep compiling", and the per-channel command-disable gate
 * came to be enforced on every message while being structurally unable to fire.
 * Golden rule 1 calls the positional constructor calls in `startup.ts`
 * load-bearing — which is only true if something checks them. This file is that
 * something.
 *
 * WHAT IT ASSERTS, in descending order of value
 * ---------------------------------------------
 *  1. the exact token set — a dropped registration is invisible everywhere else;
 *  2. that every token resolves, and every class token to an instance of that
 *     class (a token bound to the wrong object is the same failure as a missing
 *     one);
 *  3. that each hand-built class holds, on the field it names, the collaborator
 *     that field is supposed to hold — this is what pins argument ORDER, which
 *     TypeScript cannot check when two arguments share a type;
 *  4. that the post-construction setters landed (a deleted setter is a silently
 *     dead notice);
 *  5. that the source constructs nothing it forgets to register;
 *  6. that StartupService's boot sequence and slash-command publication behave.
 *
 * WHAT IS ASSERTED INSTEAD OF RESOLVED, AND WHY
 * ---------------------------------------------
 * Nothing needs the exception, and the reason is worth stating so the next
 * person does not add one by accident:
 *  - `ioredis` is mocked, so `CacheService` takes its documented in-memory
 *    fallback instead of opening a socket to whatever `REDIS_URL` happens to
 *    hold on the machine running the suite;
 *  - `@persistence/prismaClient` is mocked, so `ArtistRepository`'s constructor
 *    preload cannot query a real database. `.env` exists on developer machines
 *    and `DATABASE_URL` in it points at production;
 *  - `ENABLE_LAVALINK=false` (set by `src/testSupport/setupEnv.ts`) is what keeps
 *    `MoonlinkManager` from arming node health checks;
 *  - `PuppeteerService`'s constructor only registers process cleanup handlers.
 *    `launchBrowser` is never reached, so no Chromium is started;
 *  - `HealthServer.start()` and `StartupService.startAsync()` are NOT called
 *    here. The first opens a listening socket; the second logs the bot in.
 *    StartupService is exercised below through doubles instead.
 */

// A zero-arg `vi.fn()` infers a `[]` call tuple, so reading `mock.calls[0][1]`
// is a compile error vitest never reports. Every double that a test inspects
// takes `..._args: unknown[]`.
vi.mock('ioredis', () => {
  class FakeRedis {
    public status = 'ready';
    public on(): this { return this; }
    public once(): this { return this; }
    public async connect(): Promise<void> { /* no socket, by design */ }
    public async get(): Promise<string | null> { return null; }
    public async set(): Promise<null> { return null; }
    public async del(): Promise<number> { return 1; }
    public async ttl(): Promise<number> { return 60; }
    public async quit(): Promise<'OK'> { return 'OK'; }
    public disconnect(): void { /* no socket, by design */ }
  }
  return { default: FakeRedis, Redis: FakeRedis };
});

vi.mock('@persistence/prismaClient', () => ({
  prisma: {
    $transaction: vi.fn(async (..._args: unknown[]) => undefined),
    $queryRaw: vi.fn(async (..._args: unknown[]) => []),
    $queryRawUnsafe: vi.fn(async (..._args: unknown[]) => []),
    $executeRawUnsafe: vi.fn(async (..._args: unknown[]) => 0),
    $connect: vi.fn(async (..._args: unknown[]) => undefined),
    $disconnect: vi.fn(async (..._args: unknown[]) => undefined),
  },
  isTransientDbError: () => false,
  withDbRetry: async (operation: () => Promise<unknown>) => operation(),
  checkDatabaseHealth: async () => ({ healthy: true, latencyMs: 1 }),
}));

import { createHash } from 'node:crypto';
import { container } from 'tsyringe';
import { Client, Events } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import { configureContainer } from '@bot/startup';
import { StartupService } from '@bot/services/system/startupService';
import { TimerService } from '@bot/services/lastfm/timerService';
import { HealthServer } from '@bot/services/system/healthServer';
import { CacheService } from '@bot/services/system/cacheService';
import { SettingService } from '@bot/services/system/settingService';
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
import { WhoKnowsRepository } from '@persistence/repositories/whoKnowsRepository';
import { FriendsRepository } from '@persistence/repositories/friendsRepository';
import { CrownRepository } from '@persistence/repositories/crownRepository';
import { GuildMusicSettingsRepository } from '@persistence/repositories/guildMusicSettingsRepository';
import { ArtistGenreRepository } from '@persistence/repositories/artistGenreRepository';
import { MusicHistoryRepository } from '@persistence/repositories/musicHistoryRepository';
import { FmSettingService } from '@bot/services/system/fmSettingService';
import { LastfmApi } from '@lastfm/api/lastfmApi';
import { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import { SpotifyTokenManager } from '@spotify/api/spotifyTokenManager';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { DeezerApi } from '@deezer/api/deezerApi';
import { AppleMusicWebApi } from '@applemusic/api/appleMusicWebApi';
import { AppleMusicSearchApi } from '@applemusic/api/appleMusicSearchApi';
import { PuppeteerService } from '@images/generators/puppeteerService';
import { ChartService as ImageChartService } from '@images/generators/chartService';
import { WhoKnowsGenerator } from '@images/generators/whoKnowsGenerator';
import { WorldMapGenerator } from '@images/generators/worldMapGenerator';
import { ReceiptGenerator } from '@images/generators/receiptGenerator';
import { IcebergGenerator } from '@images/generators/icebergGenerator';
import { ChartService as BotChartService } from '@bot/services/charts/chartService';
import { ClientLogHandler } from '@bot/handlers/logs/clientLogHandler';
import { InteractionHandler } from '@bot/handlers/interactions/interactionHandler';
import { CommandHandler } from '@bot/handlers/commands/commandHandler';
import { UpdateQueueHandler } from '@bot/handlers/queues/updateQueueHandler';
import { UserEventHandler } from '@bot/handlers/users/userEventHandler';
import { MusicHandler } from '@bot/handlers/music/musicHandler';
import { AbuseFilterService } from '@bot/services/system/abuseFilterService';
import { CrownService } from '@bot/services/crown/crownService';
import { GenreService } from '@bot/services/library/genreService';
import { ArtistTrackService } from '@bot/services/library/artistTrackService';
import { FriendsService } from '@bot/services/social/friendsService';
import { CountryService } from '@bot/services/library/countryService';
import { TasteService } from '@bot/services/library/tasteService';
import { ProfileService } from '@bot/services/user/profileService';
import { StreakService } from '@bot/services/user/streakService';
import { LibrarySearchService } from '@bot/services/library/librarySearchService';
import { GuildRankingService } from '@bot/services/guild/guildRankingService';
import { GameService } from '@bot/services/guild/gameService';
import { MusicIntelligenceService } from '@bot/services/library/musicIntelligenceService';
import { GuildAdminService } from '@bot/services/guild/guildAdminService';
import { BotScrobblingService } from '@bot/services/music/botScrobblingService';
import { FeaturedService } from '@bot/services/library/featuredService';
import { ShortcutService } from '@bot/services/user/shortcutService';
import { ImportService } from '@bot/services/library/importService';
import { AppleMusicService } from '@bot/services/media/appleMusicService';
import { ExposedService } from '@bot/services/social/exposedService';
import { MusicBrainzService } from '@bot/services/media/musicBrainzService';
import { OverviewService } from '@bot/services/library/overviewService';
import { PlayHistoryService } from '@bot/services/library/playHistoryService';
import { LyricStatusService } from '@bot/services/music/lyricStatusService';
import { LyricsService } from '@bot/services/music/lyricsService';
import { MoonlinkManager } from '@bot/services/music/moonlinkManager';
import { SpotifyResolver } from '@bot/services/music/spotifyResolver';
import { SpotifyScraperService } from '@bot/services/music/spotifyScraperService';
import { DeezerResolver } from '@bot/services/music/deezerResolver';
import { AppleMusicResolver } from '@bot/services/music/appleMusicResolver';
import { PlaylistChunkManager } from '@bot/services/music/playlistChunkManager';
import { QueueService } from '@bot/services/music/queueService';
import { MusicService } from '@bot/services/music/musicService';
import { VoiceChannelStatusService } from '@bot/services/music/voiceChannelStatusService';
import { EssentiaService } from '@bot/services/audio/essentiaService';
import { PreviewResolverService } from '@bot/services/audio/previewResolverService';
import { TrackDetailsService } from '@bot/services/audio/trackDetailsService';
import { VoiceMessageService } from '@bot/services/audio/voiceMessageService';
import { WhoKnowsArtistService } from '@bot/services/whoKnows/whoKnowsArtistService';
import { WhoKnowsTrackService } from '@bot/services/whoKnows/whoKnowsTrackService';
import { WhoKnowsAlbumService } from '@bot/services/whoKnows/whoKnowsAlbumService';
import { WhoKnowsPlayService } from '@bot/services/whoKnows/whoKnowsPlayService';
import { UserSlashCommands } from '@bot/slashCommands/user/userSlashCommands';
import { ChartSlashCommands } from '@bot/slashCommands/charts/chartSlashCommands';
import { LoginSlashCommands } from '@bot/slashCommands/user/loginSlashCommands';
import { AlbumSlashCommands } from '@bot/slashCommands/library/albumSlashCommands';
import { WhoKnowsSlashCommands } from '@bot/slashCommands/whoknows/whoKnowsSlashCommands';
import { FriendSlashCommands } from '@bot/slashCommands/social/friendSlashCommands';
import { TopSlashCommands } from '@bot/slashCommands/library/topSlashCommands';
import { OverviewSlashCommands } from '@bot/slashCommands/library/overviewSlashCommands';
import { CrownSlashCommands } from '@bot/slashCommands/crown/crownSlashCommands';
import { UpdateSlashCommands } from '@bot/slashCommands/music/updateSlashCommands';
import { ArtistSlashCommands } from '@bot/slashCommands/library/artistSlashCommands';
import { TrackSlashCommands } from '@bot/slashCommands/library/trackSlashCommands';
import { TasteSlashCommands } from '@bot/slashCommands/social/tasteSlashCommands';
import { StreakSlashCommands } from '@bot/slashCommands/user/streakSlashCommands';
import { PlaycountSlashCommands } from '@bot/slashCommands/library/playcountSlashCommands';
import { ProfileSlashCommands } from '@bot/slashCommands/user/profileSlashCommands';
import { LibrarySearchSlashCommands } from '@bot/slashCommands/library/librarySearchSlashCommands';
import { ServerSlashCommands } from '@bot/slashCommands/guild/serverSlashCommands';
import { GenreSlashCommands } from '@bot/slashCommands/library/genreSlashCommands';
import { CountrySlashCommands } from '@bot/slashCommands/library/countrySlashCommands';
import { GameSlashCommands } from '@bot/slashCommands/guild/gameSlashCommands';
import { IntelligenceSlashCommands } from '@bot/slashCommands/intelligence/intelligenceSlashCommands';
import { GuildAdminSlashCommands } from '@bot/slashCommands/guild/guildAdminSlashCommands';
import { UserHubSlashCommands } from '@bot/slashCommands/user/userHubSlashCommands';
import { SettingsSlashCommands } from '@bot/slashCommands/user/settingsSlashCommands';
import { ExposedSlashCommands } from '@bot/slashCommands/social/exposedSlashCommands';
import { MusicSlashCommands } from '@bot/slashCommands/music/musicSlashCommands';
import { TrackCommands } from '@bot/textCommands/lastfm/trackCommands';
import { PlayCommands } from '@bot/textCommands/lastfm/playCommands';
import { ChartCommands } from '@bot/textCommands/lastfm/chartCommands';
import { LoginCommands } from '@bot/textCommands/lastfm/loginCommands';
import { SettingsCommands } from '@bot/textCommands/user/settingsCommands';
import { AlbumCommands } from '@bot/textCommands/lastfm/albumCommands';
import { WhoKnowsCommands } from '@bot/textCommands/guild/whoKnowsCommands';
import { FriendsCommands } from '@bot/textCommands/lastfm/friendsCommands';
import { CrownCommands } from '@bot/textCommands/guild/crownCommands';
import { TopCommands } from '@bot/textCommands/lastfm/topCommands';
import { OverviewCommands } from '@bot/textCommands/lastfm/overviewCommands';
import { UpdateCommands } from '@bot/textCommands/lastfm/updateCommands';
import { ArtistCommands } from '@bot/textCommands/lastfm/artistCommands';
import { TasteCommands } from '@bot/textCommands/lastfm/tasteCommands';
import { StreakCommands } from '@bot/textCommands/lastfm/streakCommands';
import { PlaycountCommands } from '@bot/textCommands/lastfm/playcountCommands';
import { ProfileCommands } from '@bot/textCommands/lastfm/profileCommands';
import { LibrarySearchCommands } from '@bot/textCommands/lastfm/librarySearchCommands';
import { ServerCommands } from '@bot/textCommands/guild/serverCommands';
import { GenreCommands } from '@bot/textCommands/lastfm/genreCommands';
import { CountryCommands } from '@bot/textCommands/lastfm/countryCommands';
import { GameCommands } from '@bot/textCommands/lastfm/gameCommands';
import { IntelligenceCommands } from '@bot/textCommands/lastfm/intelligenceCommands';
import { GuildAdminCommands } from '@bot/textCommands/guild/guildAdminCommands';
import { UserHubCommands } from '@bot/textCommands/user/userHubCommands';
import { ImportCommands } from '@bot/textCommands/thirdParty/importCommands';
import { StreamingCommands } from '@bot/textCommands/thirdParty/streamingCommands';
import { RateMyCommands } from '@bot/textCommands/thirdParty/rateMyCommands';
import { RateMySlashCommands } from '@bot/slashCommands/music/rateMySlashCommands';
import { RymTransport } from '@rateyourmusic/api/rymTransport';
import { ExposedCommands } from '@bot/textCommands/lastfm/exposedCommands';
import { MusicCommands } from '@bot/textCommands/music/musicCommands';
import { SettingsInteractions } from '@bot/interactions/user/settingsInteractions';
import { UserSettingsInteractions } from '@bot/interactions/user/userSettingsInteractions';
import { ChartInteractions } from '@bot/interactions/charts/chartInteractions';
import { FmModeInteractions } from '@bot/interactions/common/fmModeInteractions';
import { AlbumInteractions } from '@bot/interactions/library/albumInteractions';
import { FriendInteractions } from '@bot/interactions/social/friendInteractions';
import { HelpInteractions } from '@bot/interactions/meta/helpInteractions';
import { MusicInteractions } from '@bot/interactions/music/musicInteractions';
import { TrackPreviewInteractions } from '@bot/interactions/library/trackPreviewInteractions';
import { TopInteractions } from '@bot/interactions/library/topInteractions';
import { ArtistTrackInteractions } from '@bot/interactions/library/artistTrackInteractions';
import { ArtistInteractions } from '@bot/interactions/library/artistInteractions';
import { CountryInteractions } from '@bot/interactions/library/countryInteractions';
import { TasteInteractions } from '@bot/interactions/library/tasteInteractions';
import { RecentInteractions } from '@bot/interactions/library/recentInteractions';
import { CrownInteractions } from '@bot/interactions/crown/crownInteractions';
import { PlaycountInteractions } from '@bot/interactions/library/playcountInteractions';
import { ProfileInteractions } from '@bot/interactions/user/profileInteractions';
import { LibrarySearchInteractions } from '@bot/interactions/library/librarySearchInteractions';
import { ServerInteractions } from '@bot/interactions/guild/serverInteractions';
import { GenreInteractions } from '@bot/interactions/library/genreInteractions';
import { GameInteractions } from '@bot/interactions/guild/gameInteractions';
import { IntelligenceInteractions } from '@bot/interactions/intelligence/intelligenceInteractions';
import { UserHubInteractions } from '@bot/interactions/user/userHubInteractions';
import { LastfmErrorRateTracker } from '@domain/lastfm/lastfmErrorRateTracker';
import { RateLimitService } from '@bot/services/system/rateLimitService';
import { getSlashCommandPayloads } from '@bot/slashCommands';
import { Logger } from '@domain/logging/logger';

/* -------------------------------------------------------------------------- */
/* Container access                                                            */
/* -------------------------------------------------------------------------- */

/**
 * tsyringe exposes no public way to enumerate registrations — `isRegistered`
 * and `resolve` both need a token you already have, which is exactly the
 * information this file is trying to discover. So the registry is read
 * directly. This is a read of private state, not a replacement of it: the
 * container is never patched, mocked or spied on, because `mockRestore` leaves
 * an own property set to `undefined` and every later test in the file dies
 * silently.
 *
 * `configureContainer` is a module-level function operating on the global
 * singleton, so the whole graph is built once. Nothing here mutates it except
 * the one suite that swaps tokens out and puts them back.
 */
interface RegistryView {
  entries(): IterableIterator<[unknown, unknown[]]>;
}

const registryEntries = (): Array<{ token: unknown; registrations: unknown[] }> => {
  const internal = container as unknown as { _registry: RegistryView };
  return [...internal._registry.entries()].map(([token, registrations]) => ({ token, registrations }));
};

const tokenName = (token: unknown): string =>
  typeof token === 'function' ? (token as { name: string }).name : String(token);

/** The single `as unknown as` this file needs to read private fields. */
const priv = <T>(target: object, key: string): T =>
  (target as unknown as Record<string, T | undefined>)[key] as T;

/* -------------------------------------------------------------------------- */
/* Positional wiring spec                                                       */
/* -------------------------------------------------------------------------- */

/** Marks a collaborator that `startup.ts` builds but deliberately does NOT
 *  register — an internal dependency of another service. Asserting the class
 *  rather than a container resolution is what keeps the orphan audit honest
 *  about the difference. */
class Unregistered {
  constructor(readonly ctor: new (...args: never[]) => unknown) {}
}

/** Sentinel for a slot `startup.ts` fills with a closure rather than a token. */
const A_FUNCTION = Symbol('a function');

/**
 * Parenthesised deliberately. `new (...args: never[]) => unknown | Unregistered`
 * parses as a function whose RETURN type is the union, which collapses the whole
 * alias to `unknown` and then rejects every value assigned to it. The parens are
 * what make this a union of four alternatives.
 */
type Expectation = (new (...args: never[]) => unknown) | Unregistered | string | typeof A_FUNCTION;

interface Pin {
  /** The class as `startup.ts` constructs it. */
  readonly ctor: new (...args: never[]) => unknown;
  /** Declared parameter count. Optional parameters count; defaults do not. */
  readonly arity: number;
  /** `[fieldName, what that field must hold]`, in constructor order. */
  readonly slots: ReadonlyArray<readonly [string, Expectation]>;
}

const W = (ctor: new (...args: never[]) => unknown): Unregistered => new Unregistered(ctor);

/**
 * Every class the composition root builds by hand, with the collaborator each
 * constructor slot must end up holding. Swapping two arguments of the same type
 * compiles, passes every other test in the repository, and sends the bot to the
 * wrong object at runtime; a swapped slot here fails immediately.
 *
 * `arity` is asserted separately from `slots` because a few classes declare
 * optional parameters `startup.ts` deliberately omits (`ArtistsService` passes
 * an explicit `undefined` for artwork so `colorService` lands in the right
 * slot; the Crown command classes resolve their color/artwork lazily from the
 * container instead of taking them).
 */
const PINS: readonly Pin[] = [
  { ctor: ArtworkService, arity: 10, slots: [
    ['spotifyApi', SpotifySearchApi],
    ['deezerApi', DeezerApi],
    ['appleMusicWebApi', AppleMusicWebApi],
    ['appleMusicApi', AppleMusicSearchApi],
    ['artistRepository', ArtistRepository],
    ['albumRepository', AlbumRepository],
    ['trackRepository', TrackRepository],
    ['lastfmRepository', LastFmRepository],
    ['cache', CacheService],
    ['lastFmErrorTracker', LastfmErrorRateTracker],
  ] },
  { ctor: AlbumService, arity: 10, slots: [
    ['lastfmRepository', LastFmRepository],
    ['artistRepository', ArtistRepository],
    ['albumRepository', AlbumRepository],
    ['userRepository', UserRepository],
    ['guildUserRepository', GuildUserRepository],
    ['artworkService', ArtworkService],
    ['spotifyApi', SpotifySearchApi],
    ['prisma', PrismaClient],
    ['cache', CacheService],
    ['colorService', ColorService],
  ] },
  { ctor: TrackService, arity: 7, slots: [
    ['lastfmRepository', LastFmRepository],
    ['artistRepository', ArtistRepository],
    ['trackRepository', TrackRepository],
    ['whoKnowsRepository', WhoKnowsRepository],
    ['artworkService', ArtworkService],
    ['cache', CacheService],
    ['prisma', PrismaClient],
  ] },
  { ctor: AlbumEnrichmentService, arity: 4, slots: [
    ['spotifyApi', SpotifySearchApi],
    ['artistRepository', ArtistRepository],
    ['albumRepository', AlbumRepository],
    ['cache', CacheService],
  ] },
  { ctor: ArtistsService, arity: 5, slots: [
    ['lastfmRepository', LastFmRepository],
    ['cache', CacheService],
    // Slot 3 is an explicit `undefined` in startup.ts; asserting the slot to its
    // RIGHT is what proves the omission was deliberate and not a lost argument.
    ['colorService', ColorService],
  ] },
  { ctor: WhoKnowsArtistService, arity: 5, slots: [
    ['whoKnowsRepository', WhoKnowsRepository],
    ['guildUserRepository', GuildUserRepository],
    ['guildService', GuildService],
    ['genreService', GenreService],
    ['crownService', CrownService],
  ] },
  { ctor: WhoKnowsTrackService, arity: 5, slots: [
    ['whoKnowsRepository', WhoKnowsRepository],
    ['guildUserRepository', GuildUserRepository],
    ['guildService', GuildService],
    ['trackRepository', TrackRepository],
    ['artistRepository', ArtistRepository],
  ] },
  { ctor: WhoKnowsAlbumService, arity: 5, slots: [
    ['whoKnowsRepository', WhoKnowsRepository],
    ['guildUserRepository', GuildUserRepository],
    ['guildService', GuildService],
    ['albumRepository', AlbumRepository],
    ['artistRepository', ArtistRepository],
  ] },
  { ctor: CrownService, arity: 5, slots: [
    ['crownRepository', CrownRepository],
    ['userService', UserService],
    ['lastfmRepository', LastFmRepository],
    ['errorRateTracker', LastfmErrorRateTracker],
    ['abuseFilter', AbuseFilterService],
  ] },
  { ctor: GenreService, arity: 5, slots: [
    ['cache', CacheService],
    ['artistGenreRepo', ArtistGenreRepository],
    ['artistRepo', ArtistRepository],
    ['lastfmRepo', LastFmRepository],
    ['prisma', PrismaClient],
  ] },
  { ctor: AutopostService, arity: 8, slots: [
    ['artistsService', ArtistsService],
    ['albumService', AlbumService],
    ['trackService', TrackService],
    ['crownService', CrownService],
    ['telemetryService', TelemetryService],
    ['guildRepository', GuildRepository],
    ['autopostRepository', AutopostRepository],
    ['guildRankingService', GuildRankingService],
  ] },
  { ctor: UpdateService, arity: 9, slots: [
    ['userRepository', UserRepository],
    ['playRepository', PlayRepository],
    ['lastfmRepository', LastFmRepository],
    ['cache', CacheService],
    ['recalculateTopLists', A_FUNCTION],
    ['artistRepository', ArtistRepository],
    ['albumRepository', AlbumRepository],
    ['trackRepository', TrackRepository],
    ['genreService', GenreService],
  ] },
  { ctor: IndexService, arity: 8, slots: [
    ['indexQueue', UserIndexQueueService],
    ['cache', CacheService],
    ['userRepository', UserRepository],
    ['artistRepository', ArtistRepository],
    ['albumRepository', AlbumRepository],
    ['trackRepository', TrackRepository],
    ['playRepository', PlayRepository],
    ['lastfmRepository', LastFmRepository],
  ] },
  { ctor: LoginService, arity: 5, slots: [
    ['lastfmRepository', LastFmRepository],
    ['userService', UserService],
    ['userRepository', UserRepository],
    ['cache', CacheService],
    ['indexService', IndexService],
  ] },
  { ctor: PrefixService, arity: 2, slots: [['cache', CacheService], ['guildRepository', GuildRepository]] },
  { ctor: DisabledChannelService, arity: 2, slots: [['cache', CacheService], ['channelRepository', ChannelRepository]] },
  { ctor: ChannelToggledCommandService, arity: 2, slots: [['cache', CacheService], ['channelRepository', ChannelRepository]] },
  { ctor: GuildDisabledCommandService, arity: 2, slots: [['cache', CacheService], ['repository', GuildDisabledCommandRepository]] },
  { ctor: GuildUserService, arity: 2, slots: [['guildUserRepository', GuildUserRepository], ['userRepository', UserRepository]] },
  { ctor: GuildService, arity: 2, slots: [['guildRepository', GuildRepository], ['cache', CacheService]] },
  { ctor: FmSettingService, arity: 2, slots: [['repo', UserFmSettingRepository], ['cache', CacheService]] },
  { ctor: FriendsService, arity: 2, slots: [['friendsRepository', FriendsRepository], ['userRepository', UserRepository]] },
  { ctor: LastFmRepository, arity: 2, slots: [['api', LastfmApi]] },
  { ctor: LastfmApi, arity: 2, slots: [
    ['errorTracker', LastfmErrorRateTracker],
  ] },
  { ctor: SpotifyResolver, arity: 2, slots: [['tokenManager', SpotifyTokenManager], ['scraper', W(SpotifyScraperService)]] },
  { ctor: QueueService, arity: 2, slots: [
    ['historyRepo', MusicHistoryRepository],
    ['settingsRepo', GuildMusicSettingsRepository],
  ] },
  { ctor: MusicService, arity: 5, slots: [
    ['moonlinkManager', MoonlinkManager],
    ['spotifyResolver', SpotifyResolver],
    ['queueService', QueueService],
    ['playlistChunkManager', W(PlaylistChunkManager)],
    ['artworkService', ArtworkService],
  ] },
  { ctor: MusicHandler, arity: 8, slots: [
    ['client', Client],
    ['moonlinkManager', MoonlinkManager],
    ['queueService', QueueService],
    ['colorService', ColorService],
    ['voiceChannelStatusService', VoiceChannelStatusService],
    ['botScrobblingService', BotScrobblingService],
    ['lyricsService', LyricsService],
    ['artworkService', ArtworkService],
  ] },
  { ctor: MusicCommands, arity: 4, slots: [
    ['musicService', MusicService], ['colorService', ColorService],
    ['lyricsService', LyricsService], ['musicInteractions', MusicInteractions],
  ] },
  { ctor: MusicSlashCommands, arity: 4, slots: [
    ['musicService', MusicService], ['colorService', ColorService],
    ['lyricsService', LyricsService], ['musicInteractions', MusicInteractions],
  ] },
  { ctor: MusicInteractions, arity: 3, slots: [
    ['musicService', MusicService], ['colorService', ColorService], ['lyricsService', LyricsService],
  ] },
  { ctor: NowPlayingInteractions, arity: 4, slots: [
    ['userRepository', UserRepository], ['lastfmRepository', LastFmRepository],
    ['trackService', TrackService], ['lyricsService', LyricsService],
  ] },
  { ctor: GuildAdminService, arity: 4, slots: [
    ['guildUserRepository', GuildUserRepository], ['userRepository', UserRepository],
    ['guildService', GuildService], ['prisma', PrismaClient],
  ] },
  { ctor: GuildAdminCommands, arity: 8, slots: [
    ['guildService', GuildService], ['guildAdminService', GuildAdminService],
    ['userService', UserService], ['prefixService', PrefixService],
    ['guildDisabledCommandService', GuildDisabledCommandService], ['colorService', ColorService],
    ['channelToggledCommandService', ChannelToggledCommandService],
    ['disabledChannelService', DisabledChannelService],
  ] },
  { ctor: GuildAdminSlashCommands, arity: 7, slots: [
    ['guildService', GuildService], ['guildAdminService', GuildAdminService],
    ['userService', UserService], ['prefixService', PrefixService],
    ['colorService', ColorService], ['channelToggledCommandService', ChannelToggledCommandService],
    ['disabledChannelService', DisabledChannelService],
  ] },
  { ctor: PlaycountCommands, arity: 10, slots: [
    ['userService', UserService], ['settingService', SettingService],
    ['playHistoryService', PlayHistoryService], ['artistsService', ArtistsService],
    ['albumService', AlbumService], ['trackService', TrackService],
    ['artworkService', ArtworkService], ['lastfmRepository', LastFmRepository],
    ['colorService', ColorService], ['receiptGenerator', ReceiptGenerator],
  ] },
  { ctor: PlaycountSlashCommands, arity: 10, slots: [
    ['userService', UserService], ['settingService', SettingService],
    ['playHistoryService', PlayHistoryService], ['artistsService', ArtistsService],
    ['albumService', AlbumService], ['trackService', TrackService],
    ['artworkService', ArtworkService], ['lastfmRepository', LastFmRepository],
    ['colorService', ColorService], ['receiptGenerator', ReceiptGenerator],
  ] },
  { ctor: IntelligenceCommands, arity: 7, slots: [
    ['userService', UserService], ['settingService', SettingService],
    ['lastfmRepository', LastFmRepository], ['intelligenceService', MusicIntelligenceService],
    ['colorService', ColorService], ['icebergGenerator', IcebergGenerator],
  ] },
  { ctor: IntelligenceSlashCommands, arity: 7, slots: [
    ['userService', UserService], ['settingService', SettingService],
    ['lastfmRepository', LastFmRepository], ['intelligenceService', MusicIntelligenceService],
    ['colorService', ColorService], ['icebergGenerator', IcebergGenerator],
  ] },
  { ctor: UserHubCommands, arity: 7, slots: [
    ['userService', UserService], ['botScrobblingService', BotScrobblingService],
    ['featuredService', FeaturedService], ['shortcutService', ShortcutService],
    ['prefixService', PrefixService], ['lastFmRepository', LastFmRepository],
    ['colorService', ColorService],
  ] },
  { ctor: UserHubSlashCommands, arity: 7, slots: [
    ['userService', UserService], ['botScrobblingService', BotScrobblingService],
    ['featuredService', FeaturedService], ['shortcutService', ShortcutService],
    ['prefixService', PrefixService], ['lastFmRepository', LastFmRepository],
    ['colorService', ColorService],
  ] },
  { ctor: WhoKnowsCommands, arity: 13, slots: [
    ['userService', UserService], ['settingService', SettingService],
    ['artworkService', ArtworkService], ['artistsService', ArtistsService],
    ['albumService', AlbumService], ['trackService', TrackService],
    ['friendsService', FriendsService], ['whoKnowsArtistService', WhoKnowsArtistService],
    ['whoKnowsTrackService', WhoKnowsTrackService], ['whoKnowsAlbumService', WhoKnowsAlbumService],
    ['whoKnowsPlayService', WhoKnowsPlayService], ['lastfmRepository', LastFmRepository],
    ['updateService', UpdateService],
  ] },
  { ctor: WhoKnowsSlashCommands, arity: 12, slots: [
    ['userService', UserService], ['artworkService', ArtworkService],
    ['artistsService', ArtistsService], ['albumService', AlbumService],
    ['trackService', TrackService], ['friendsService', FriendsService],
    ['whoKnowsArtistService', WhoKnowsArtistService], ['whoKnowsTrackService', WhoKnowsTrackService],
    ['whoKnowsAlbumService', WhoKnowsAlbumService], ['whoKnowsPlayService', WhoKnowsPlayService],
    ['lastfmRepository', LastFmRepository], ['updateService', UpdateService],
  ] },
  { ctor: TopSlashCommands, arity: 6, slots: [
    ['userService', UserService], ['settingService', SettingService],
    ['lastfmRepository', LastFmRepository],
    ['updateService', UpdateService], ['colorService', ColorService],
    ['artworkService', ArtworkService],
  ] },
  { ctor: TopCommands, arity: 6, slots: [
    ['userService', UserService], ['settingService', SettingService],
    ['lastfmRepository', LastFmRepository],
    ['updateService', UpdateService], ['colorService', ColorService],
    ['artworkService', ArtworkService],
  ] },
  { ctor: TopInteractions, arity: 3, slots: [
    ['lastfmRepository', LastFmRepository], ['settingService', SettingService], ['colorService', ColorService],
  ] },
  { ctor: ChartSlashCommands, arity: 5, slots: [
    ['chartService', BotChartService], ['userService', UserService],
    ['settingService', SettingService], ['updateService', UpdateService], ['colorService', ColorService],
  ] },
  { ctor: BotChartService, arity: 7, slots: [
    ['artworkService', ArtworkService], ['lastfmRepository', LastFmRepository],
    ['userService', UserService], ['enrichmentService', AlbumEnrichmentService],
    ['imageChartService', ImageChartService], ['imageUploadService', ImageUploadService],
    ['cache', CacheService],
  ] },
  { ctor: ImageChartService, arity: 1, slots: [['puppeteer', PuppeteerService]] },
  { ctor: PreviewResolverService, arity: 5, slots: [
    ['appleApi', AppleMusicSearchApi], ['deezerApi', DeezerApi], ['cache', CacheService],
    ['spotifyScraper', W(SpotifyScraperService)], ['spotifyApi', SpotifySearchApi],
  ] },
  { ctor: TrackDetailsService, arity: 3, slots: [
    ['previewResolver', PreviewResolverService], ['essentia', EssentiaService], ['spotifyApi', SpotifySearchApi],
  ] },
  { ctor: CountryService, arity: 3, slots: [
    ['prisma', PrismaClient], ['musicBrainzService', MusicBrainzService], ['cache', CacheService],
  ] },
  { ctor: TasteService, arity: 4, slots: [
    ['lastfmRepo', LastFmRepository], ['genreService', GenreService],
    ['countryService', CountryService], ['cache', CacheService],
  ] },
  { ctor: PlayHistoryService, arity: 5, slots: [
    ['playRepository', PlayRepository], ['lastfmRepository', LastFmRepository],
    ['prisma', PrismaClient], ['genreService', GenreService], ['countryService', CountryService],
  ] },
  { ctor: PlaycountInteractions, arity: 5, slots: [
    ['userService', UserService], ['playHistoryService', PlayHistoryService],
    ['artworkService', ArtworkService], ['colorService', ColorService],
    ['lastfmRepo', 'ILastfmRepository'],
  ] },
  { ctor: StreakService, arity: 1, slots: [['lastfmRepo', LastFmRepository]] },
  { ctor: StreakCommands, arity: 3, slots: [
    ['userService', UserService], ['streakService', StreakService], ['colorService', ColorService],
  ] },
  { ctor: ProfileService, arity: 2, slots: [['lastfmRepo', LastFmRepository], ['friendsRepo', FriendsRepository]] },
  { ctor: ExposedService, arity: 3, slots: [
    ['genreService', GenreService], ['playRepo', PlayRepository], ['prisma', PrismaClient],
  ] },
  { ctor: ImportService, arity: 1, slots: [['prisma', PrismaClient]] },
  { ctor: ImportCommands, arity: 4, slots: [
    ['userService', UserService], ['importService', ImportService],
    ['prefixService', PrefixService], ['colorService', ColorService],
  ] },
  { ctor: StreamingCommands, arity: 6, slots: [
    ['userService', UserService], ['spotifySearchApi', SpotifySearchApi],
    ['appleMusicService', AppleMusicService], ['prefixService', PrefixService],
    ['lastFmRepository', LastFmRepository], ['colorService', ColorService],
  ] },
  { ctor: RateMyCommands, arity: 6, slots: [
    ['userService', UserService], ['rymTransport', RymTransport],
    ['prefixService', PrefixService], ['lastFmRepository', LastFmRepository],
    ['artworkService', ArtworkService], ['colorService', ColorService],
  ] },
  { ctor: RateMySlashCommands, arity: 6, slots: [
    ['userService', UserService], ['rymTransport', RymTransport],
    ['prefixService', PrefixService], ['lastFmRepository', LastFmRepository],
    ['artworkService', ArtworkService], ['colorService', ColorService],
  ] },
  { ctor: BotScrobblingService, arity: 3, slots: [
    ['lastFmRepository', LastFmRepository], ['userRepository', UserRepository],
    ['settingsRepo', GuildMusicSettingsRepository],
  ] },
  { ctor: FeaturedService, arity: 2, slots: [['lastFmRepository', LastFmRepository], ['prisma', PrismaClient]] },
  { ctor: MusicIntelligenceService, arity: 2, slots: [
    ['prisma', PrismaClient], ['countryService', CountryService],
  ] },
  { ctor: OverviewService, arity: 1, slots: [['genreService', GenreService]] },
  { ctor: ReconcileService, arity: 1, slots: [['indexService', IndexService]] },
  { ctor: GuildRankingService, arity: 1, slots: [['prisma', PrismaClient]] },
  { ctor: PaginationService, arity: 1, slots: [['tracker', ComponentInteractionTracker]] },
  { ctor: ImageUploadService, arity: 1, slots: [['client', Client]] },
  { ctor: MusicBrainzService, arity: 1, slots: [['cache', CacheService]] },
  { ctor: WhoKnowsPlayService, arity: 1, slots: [['cache', CacheService]] },
  { ctor: UserUpdateQueueService, arity: 1, slots: [['cache', CacheService]] },
  { ctor: UserIndexQueueService, arity: 1, slots: [['cache', CacheService]] },
  { ctor: WorldMapGenerator, arity: 1, slots: [['puppeteerService', PuppeteerService]] },
  { ctor: ReceiptGenerator, arity: 1, slots: [['puppeteerService', PuppeteerService]] },
  { ctor: IcebergGenerator, arity: 1, slots: [['puppeteerService', PuppeteerService]] },
  { ctor: WhoKnowsGenerator, arity: 1, slots: [['puppeteer', PuppeteerService]] },
  { ctor: GameService, arity: 1, slots: [['puppeteerService', PuppeteerService]] },
  { ctor: VoiceChannelStatusService, arity: 1, slots: [['client', Client]] },
  { ctor: LyricStatusService, arity: 3, slots: [
    ['client', Client], ['lyricsService', LyricsService], ['prisma', PrismaClient],
  ] },
  { ctor: HelpInteractions, arity: 2, slots: [['prefixService', PrefixService], ['colorService', ColorService]] },
  { ctor: SettingsInteractions, arity: 1, slots: [['prefixService', PrefixService]] },
  { ctor: SettingsSlashCommands, arity: 3, slots: [
    ['prefixService', PrefixService], ['colorService', ColorService], ['userService', UserService],
  ] },
  { ctor: UserSettingsInteractions, arity: 3, slots: [
    ['userService', UserService], ['fmSettingService', FmSettingService], ['prefixService', PrefixService],
  ] },
  { ctor: FmModeInteractions, arity: 2, slots: [
    ['userService', UserService], ['fmSettingService', FmSettingService],
  ] },
  { ctor: FriendInteractions, arity: 3, slots: [
    ['friendsService', FriendsService], ['userService', UserService], ['colorService', ColorService],
  ] },
  { ctor: AlbumInteractions, arity: 3, slots: [
    ['albumService', AlbumService], ['userService', UserService], ['colorService', ColorService],
  ] },
  { ctor: ChartInteractions, arity: 3, slots: [
    ['chartService', BotChartService], ['userService', UserService], ['colorService', ColorService],
  ] },
  { ctor: CountryInteractions, arity: 3, slots: [
    ['countryService', CountryService], ['worldMapGenerator', WorldMapGenerator], ['userService', UserService],
  ] },
  { ctor: GenreInteractions, arity: 2, slots: [['genreService', GenreService], ['userService', UserService]] },
  { ctor: GameInteractions, arity: 2, slots: [['gameService', GameService], ['colorService', ColorService]] },
  { ctor: TasteInteractions, arity: 2, slots: [['tasteService', TasteService], ['colorService', ColorService]] },
  { ctor: RecentInteractions, arity: 3, slots: [
    ['lastfmRepo', LastFmRepository], ['userService', UserService], ['colorService', ColorService],
  ] },
  { ctor: CrownInteractions, arity: 3, slots: [
    ['crownService', CrownService], ['userService', UserService], ['colorService', ColorService],
  ] },
  { ctor: ProfileInteractions, arity: 3, slots: [
    ['userService', UserService], ['profileService', ProfileService], ['colorService', ColorService],
  ] },
  { ctor: LibrarySearchInteractions, arity: 2, slots: [
    ['searchService', LibrarySearchService], ['colorService', ColorService],
  ] },
  { ctor: ServerInteractions, arity: 2, slots: [
    ['guildRankingService', GuildRankingService], ['colorService', ColorService],
  ] },
  { ctor: IntelligenceInteractions, arity: 4, slots: [
    ['intelligenceService', MusicIntelligenceService], ['userService', UserService],
    ['colorService', ColorService],
  ] },
  { ctor: UserHubInteractions, arity: 3, slots: [
    ['botScrobblingService', BotScrobblingService], ['userService', UserService], ['colorService', ColorService],
  ] },
  { ctor: ArtistTrackInteractions, arity: 2, slots: [
    ['artistTrackService', ArtistTrackService], ['colorService', ColorService],
  ] },
  { ctor: ArtistInteractions, arity: 7, slots: [
    ['artistTrackService', ArtistTrackService], ['musicBrainzService', MusicBrainzService],
    ['genreService', GenreService], ['userService', UserService], ['colorService', ColorService],
    ['spotifySearchApi', SpotifySearchApi], ['lastfmRepository', LastFmRepository],
  ] },
  { ctor: TrackPreviewInteractions, arity: 1, slots: [['voiceService', VoiceMessageService]] },
  { ctor: ArtistCommands, arity: 8, slots: [
    ['userService', UserService], ['artistTrackService', ArtistTrackService],
    ['musicBrainzService', MusicBrainzService], ['genreService', GenreService],
    ['spotifySearchApi', SpotifySearchApi], ['lastfmRepository', LastFmRepository],
    ['updateService', UpdateService], ['artistsService', ArtistsService],
  ] },
  { ctor: ArtistSlashCommands, arity: 7, slots: [
    ['userService', UserService], ['artistTrackService', ArtistTrackService],
    ['musicBrainzService', MusicBrainzService], ['genreService', GenreService],
    ['spotifySearchApi', SpotifySearchApi], ['lastfmRepository', LastFmRepository],
    ['updateService', UpdateService],
  ] },
  { ctor: AlbumCommands, arity: 3, slots: [
    ['userService', UserService], ['albumService', AlbumService], ['updateService', UpdateService],
  ] },
  { ctor: AlbumSlashCommands, arity: 4, slots: [
    ['userService', UserService], ['albumService', AlbumService],
    ['updateService', UpdateService], ['colorService', ColorService],
  ] },
  { ctor: TrackCommands, arity: 7, slots: [
    ['userService', UserService], ['trackService', TrackService],
    ['trackDetailsService', TrackDetailsService], ['lastfmRepository', LastFmRepository],
    ['updateService', UpdateService], ['lyricsService', LyricsService], ['colorService', ColorService],
  ] },
  { ctor: TrackSlashCommands, arity: 6, slots: [
    ['userService', UserService], ['trackService', TrackService],
    ['trackDetailsService', TrackDetailsService], ['lastfmRepository', LastFmRepository],
    ['updateService', UpdateService], ['colorService', ColorService],
  ] },
  { ctor: UpdateCommands, arity: 3, slots: [
    ['userService', UserService], ['updateService', UpdateService], ['indexService', IndexService],
  ] },
  { ctor: UpdateSlashCommands, arity: 3, slots: [
    ['userService', UserService], ['updateService', UpdateService], ['indexService', IndexService],
  ] },
  { ctor: LoginCommands, arity: 3, slots: [
    ['loginService', LoginService], ['userService', UserService],
  ] },
  { ctor: LoginSlashCommands, arity: 3, slots: [
    ['loginService', LoginService], ['userService', UserService],
  ] },
  { ctor: UserSlashCommands, arity: 3, slots: [
    ['userService', UserService], ['lastfmRepository', LastFmRepository],
  ] },
  { ctor: PlayCommands, arity: 3, slots: [
    ['userService', UserService], ['lastfmRepository', LastFmRepository],
  ] },
  { ctor: FriendsCommands, arity: 3, slots: [
    ['userService', UserService], ['friendsService', FriendsService],
  ] },
  { ctor: FriendSlashCommands, arity: 3, slots: [
    ['userService', UserService], ['friendsService', FriendsService],
  ] },
  { ctor: ChartCommands, arity: 5, slots: [
    ['chartService', BotChartService], ['userService', UserService],
    ['settingService', SettingService], ['updateService', UpdateService], ['colorService', ColorService],
  ] },
  { ctor: SettingsCommands, arity: 4, slots: [
    ['prefixService', PrefixService], ['colorService', ColorService],
    ['userService', UserService], ['guildService', GuildService],
  ] },
  { ctor: ProfileCommands, arity: 3, slots: [
    ['userService', UserService], ['profileService', ProfileService], ['colorService', ColorService],
  ] },
  { ctor: ProfileSlashCommands, arity: 3, slots: [
    ['userService', UserService], ['profileService', ProfileService], ['colorService', ColorService],
  ] },
  { ctor: ExposedCommands, arity: 2, slots: [['userService', UserService], ['exposedService', ExposedService]] },
  { ctor: ExposedSlashCommands, arity: 2, slots: [['userService', UserService], ['exposedService', ExposedService]] },
  { ctor: GenreCommands, arity: 5, slots: [
    ['userService', UserService], ['settingService', SettingService],
    ['lastfmRepository', LastFmRepository], ['genreService', GenreService], ['colorService', ColorService],
  ] },
  { ctor: GenreSlashCommands, arity: 5, slots: [
    ['userService', UserService], ['settingService', SettingService],
    ['lastfmRepository', LastFmRepository], ['genreService', GenreService], ['colorService', ColorService],
  ] },
  { ctor: CountryCommands, arity: 6, slots: [
    ['userService', UserService], ['settingService', SettingService],
    ['lastfmRepository', LastFmRepository], ['countryService', CountryService],
    ['worldMapGenerator', WorldMapGenerator], ['colorService', ColorService],
  ] },
  { ctor: CountrySlashCommands, arity: 6, slots: [
    ['userService', UserService], ['settingService', SettingService],
    ['lastfmRepository', LastFmRepository], ['countryService', CountryService],
    ['worldMapGenerator', WorldMapGenerator], ['colorService', ColorService],
  ] },
  { ctor: GameCommands, arity: 5, slots: [
    ['userService', UserService], ['lastfmRepository', LastFmRepository],
    ['gameService', GameService], ['colorService', ColorService], ['artworkService', ArtworkService],
  ] },
  { ctor: GameSlashCommands, arity: 5, slots: [
    ['userService', UserService], ['lastfmRepository', LastFmRepository],
    ['gameService', GameService], ['colorService', ColorService], ['artworkService', ArtworkService],
  ] },
  { ctor: OverviewCommands, arity: 4, slots: [
    ['userService', UserService], ['overviewService', OverviewService],
    ['updateService', UpdateService], ['colorService', ColorService],
  ] },
  { ctor: OverviewSlashCommands, arity: 4, slots: [
    ['userService', UserService], ['overviewService', OverviewService],
    ['updateService', UpdateService], ['colorService', ColorService],
  ] },
  { ctor: TasteCommands, arity: 4, slots: [
    ['userService', UserService], ['tasteService', TasteService],
    ['lastfmRepo', LastFmRepository], ['updateService', UpdateService],
  ] },
  { ctor: TasteSlashCommands, arity: 3, slots: [
    ['userService', UserService], ['tasteService', TasteService], ['updateService', UpdateService],
  ] },
  { ctor: ServerCommands, arity: 2, slots: [
    ['guildRankingService', GuildRankingService], ['colorService', ColorService],
  ] },
  { ctor: ServerSlashCommands, arity: 2, slots: [
    ['guildRankingService', GuildRankingService], ['colorService', ColorService],
  ] },
  { ctor: LibrarySearchCommands, arity: 3, slots: [
    ['userService', UserService], ['searchService', LibrarySearchService], ['colorService', ColorService],
  ] },
  { ctor: LibrarySearchSlashCommands, arity: 3, slots: [
    ['userService', UserService], ['searchService', LibrarySearchService], ['colorService', ColorService],
  ] },
  { ctor: StreakSlashCommands, arity: 3, slots: [
    ['userService', UserService], ['streakService', StreakService], ['colorService', ColorService],
  ] },
  { ctor: CrownCommands, arity: 7, slots: [
    ['userService', UserService], ['crownService', CrownService],
    ['lastfmRepo', 'ILastfmRepository'], ['artistsService', ArtistsService],
    ['updateService', UpdateService],
  ] },
  { ctor: CrownSlashCommands, arity: 7, slots: [
    ['userService', UserService], ['crownService', CrownService],
    ['lastfmRepo', 'ILastfmRepository'], ['artistsService', ArtistsService],
    ['updateService', UpdateService],
  ] },
  { ctor: UpdateQueueHandler, arity: 2, slots: [
    ['queue', UserUpdateQueueService], ['updateService', UpdateService],
  ] },
  { ctor: UserEventHandler, arity: 3, slots: [
    ['client', Client], ['userService', UserService], ['guildUserService', GuildUserService],
  ] },
  { ctor: ClientLogHandler, arity: 3, slots: [
    ['client', Client], ['guildService', GuildService], ['guildUserService', GuildUserService],
  ] },
  { ctor: CommandHandler, arity: 11, slots: [
    ['client', Client], ['prefixService', PrefixService], ['guildService', GuildService],
    ['disabledChannelService', DisabledChannelService], ['guildDisabledCommands', GuildDisabledCommandService],
    ['channelToggledCommands', ChannelToggledCommandService], ['userService', UserService],
    ['guildUserService', GuildUserService], ['colorService', ColorService],
    ['gameService', GameService], ['rateLimitService', RateLimitService],
  ] },
  { ctor: StartupService, arity: 6, slots: [
    ['client', Client], ['timerService', TimerService], ['puppeteerService', PuppeteerService],
    ['guildService', GuildService], ['moonlinkManager', MoonlinkManager], ['healthServer', HealthServer],
  ] },
  { ctor: InteractionHandler, arity: 36, slots: [
    ['client', Client], ['helpInteractions', HelpInteractions],
    ['nowPlayingInteractions', NowPlayingInteractions], ['userSettingsInteractions', UserSettingsInteractions],
    ['guildService', GuildService], ['disabledChannelService', DisabledChannelService],
    ['guildDisabledCommands', GuildDisabledCommandService], ['channelToggledCommands', ChannelToggledCommandService],
    ['componentTracker', ComponentInteractionTracker], ['componentPaginatorService', ComponentPaginatorService],
    ['colorService', ColorService], ['userService', UserService],
    ['guildUserService', GuildUserService], ['settingsInteractions', SettingsInteractions],
    ['chartInteractions', ChartInteractions], ['albumInteractions', AlbumInteractions],
    ['fmModeInteractions', FmModeInteractions], ['friendInteractions', FriendInteractions],
    ['musicInteractions', MusicInteractions], ['trackPreviewInteractions', TrackPreviewInteractions],
    ['topInteractions', TopInteractions], ['artistTrackInteractions', ArtistTrackInteractions],
    ['artistInteractions', ArtistInteractions], ['tasteInteractions', TasteInteractions],
    ['recentInteractions', RecentInteractions], ['crownInteractions', CrownInteractions],
    ['playcountInteractions', PlaycountInteractions], ['profileInteractions', ProfileInteractions],
    ['librarySearchInteractions', LibrarySearchInteractions], ['serverInteractions', ServerInteractions],
    ['genreInteractions', GenreInteractions], ['countryInteractions', CountryInteractions],
    ['gameInteractions', GameInteractions], ['userHubInteractions', UserHubInteractions],
    ['intelligenceInteractions', IntelligenceInteractions], ['rateLimitService', RateLimitService],
  ] },
];

/** `ArtistTrackService` is built by `startup.ts` and passed straight into
 *  consumers; it is registered too, so the consumers are pinned to it by
 *  identity in the test below rather than through this table. */

/*
 * ONE graph build for the whole file.
 *
 * tsyringe's registry APPENDS on every 
egister, and 
esolve returns the first
 * entry, so calling configureContainer() more than once leaves a Frankenstein graph:
 * run N's hand-built objects paired with run 1's registrations for any token registered
 * after the reflection resolves. The result looks like a wiring bug and is not one.
 */

beforeAll(() => {
  configureContainer();
});

/* -------------------------------------------------------------------------- */
/* 1 + 2. the token set, and that every token resolves                          */
/* -------------------------------------------------------------------------- */

describe('composition root — the registered token set', () => {
  it('registers every token the bot is documented to resolve', () => {
    // The exact set, not a count: a count cannot name the token that was
    // dropped, and a dropped registration is a feature nothing can reach. The
    // duplicate `ChartService` is deliberate and load-bearing — two unrelated
    // classes share that name and are registered under two different tokens, so
    // a name-keyed assertion would silently collapse them.
    const expected = [
      'AbuseFilterService', 'AbuseFlagRepository', 'AlbumCommands', 'AlbumEnrichmentService',
      'AlbumInteractions', 'AlbumRepository', 'AlbumService', 'AlbumSlashCommands', 'AppleMusicResolver',
      'AppleMusicSearchApi', 'AppleMusicService', 'AppleMusicTokenScraper', 'AppleMusicWebApi',
      'ArtistCommands', 'ArtistGenreRepository', 'ArtistInteractions', 'ArtistRepository',
      'ArtistSlashCommands', 'ArtistTrackCommands', 'ArtistTrackInteractions', 'ArtistTrackService',
      'ArtistTrackSlashCommands', 'ArtistsService', 'ArtworkService', 'AutopostRepository',
      'AutopostService', 'BotScrobblingService', 'CacheService', 'ChannelRepository',
      'ChannelToggledCommandService', 'ChartCommands', 'ChartInteractions', 'ChartService',
      'ChartService', 'ChartSlashCommands', 'Client', 'ClientLogHandler', 'ColorService',
      'CommandHandler', 'ComponentInteractionTracker', 'ComponentPaginatorService', 'CountryCommands',
      'CountryInteractions', 'CountryService', 'CountrySlashCommands', 'CrownCommands',
      'CrownInteractions', 'CrownRepository', 'CrownService', 'CrownSlashCommands', 'DeezerApi',
      'DeezerResolver', 'DisabledChannelService', 'EssentiaService', 'ExposedCommands',
      'ExposedService', 'ExposedSlashCommands', 'FeaturedService', 'FmFooterRepository',
      'FmModeInteractions', 'FmSettingService', 'FriendInteractions', 'FriendSlashCommands',
      'FriendsCommands', 'FriendsRepository', 'FriendsService', 'GameCommands', 'GameInteractions',
      'GameService', 'GameSlashCommands', 'GenreCommands', 'GenreInteractions', 'GenreService',
      'GenreSlashCommands', 'GuildAdminCommands', 'GuildAdminService', 'GuildAdminSlashCommands',
      'GuildDisabledCommandRepository', 'GuildDisabledCommandService', 'GuildMusicSettingsRepository',
      'GuildRankingService', 'GuildRepository', 'GuildService', 'GuildUserRepository',
      'GuildUserService', 'HealthServer', 'HelpCommands', 'HelpInteractions', 'HelpSlashCommands',
      'ICache', 'IGuildRepository', 'ILastfmRepository', 'ITelemetry', 'IUserRepository',
      'IcebergGenerator', 'ImageUploadService', 'ImportCommands', 'ImportService',
      'ImportSlashCommands', 'IndexService', 'IntelligenceCommands', 'IntelligenceInteractions',
      'IntelligenceSlashCommands', 'InteractionHandler', 'LastFmRepository', 'LastfmApi',
      'LastfmErrorRateTracker', 'LibrarySearchCommands', 'LibrarySearchInteractions',
      'LibrarySearchService', 'LibrarySearchSlashCommands', 'LoginCommands', 'LoginService',
      'LoginSlashCommands', 'LyricStatusService', 'LyricsService', 'MoonlinkManager',
      'MusicBrainzService', 'MusicCommands', 'MusicHandler', 'MusicHistoryRepository',
      'MusicIntelligenceService', 'MusicInteractions', 'MusicService', 'MusicSlashCommands',
      'NowPlayingInteractions', 'OverviewCommands', 'OverviewService', 'OverviewSlashCommands',
      'PaginationService', 'PlayCommands', 'PlayHistoryService', 'PlayRepository',
      'PlaycountCommands', 'PlaycountInteractions', 'PlaycountSlashCommands', 'PrefixService',
      'PreviewResolverService', 'ProfileCommands', 'ProfileInteractions', 'ProfileService',
      'ProfileSlashCommands',       'PuppeteerService', 'QueueService', 'RateLimitService', 'RateMyCommands',
      'RateMySlashCommands', 'ReceiptGenerator', 'RecentInteractions', 'ReconcileService', 'RymTransport',
      'ServerCommands',
      'ServerInteractions', 'ServerSlashCommands', 'SettingService', 'SettingsCommands',
      'SettingsInteractions', 'SettingsSlashCommands', 'ShortcutService', 'SpotifyResolver',
      'SpotifySearchApi', 'SpotifyTokenManager', 'StartupService', 'StaticCommands',
      'StaticSlashCommands', 'StreakCommands', 'StreakService', 'StreakSlashCommands',
      'StreamingCommands', 'StreamingSlashCommands', 'TasteCommands', 'TasteInteractions',
      'TasteService', 'TasteSlashCommands', 'TelemetryService', 'TimerService', 'TopCommands',
      'TopInteractions', 'TopSlashCommands', 'TrackCommands', 'TrackDetailsService',
      'TrackPreviewInteractions', 'TrackRepository', 'TrackService', 'TrackSlashCommands',
      'UpdateCommands', 'UpdateQueueHandler', 'UpdateService', 'UpdateSlashCommands',
      'UserEventHandler', 'UserFmSettingRepository', 'UserHubCommands', 'UserHubInteractions',
      'UserHubSlashCommands', 'UserIndexQueueService', 'UserRepository', 'UserService',
      'UserSettingsInteractions', 'UserSlashCommands', 'UserUpdateQueueService',
      'VoiceChannelStatusService', 'VoiceMessageService', 'WhoKnowsAlbumService',
      'WhoKnowsArtistService', 'WhoKnowsCommands', 'WhoKnowsGenerator', 'WhoKnowsPlayService',
      'WhoKnowsRepository', 'WhoKnowsSlashCommands', 'WhoKnowsTrackService', 'WorldMapGenerator',
    ];

    // The Prisma client token is the generated class, whose `name` is a build
    // artefact. It is matched by identity instead, and asserted on its own.
    const actual = registryEntries()
      .filter((entry) => entry.token !== PrismaClient)
      .map((entry) => tokenName(entry.token));

    expect(actual.slice().sort()).toEqual(expected);
  });

  it('registers the database client under the PrismaClient token', () => {
    expect(container.isRegistered(PrismaClient)).toBe(true);
    // Not `instanceof`: `prisma` is `$extends`-wrapped, so the registered value
    // is the extended client rather than the raw generated class. What matters
    // is that every repository got the SAME object.
    const prisma = container.resolve(PrismaClient);
    expect(prisma).toBeDefined();
    // Written out rather than looped: an array of four repository classes infers
    // a UNION of constructor types, and `resolve` then wants one specific token
    // per element. Four lines beat a cast that hides which repository is which.
    expect(priv<UserRepository>(container.resolve(UserRepository), 'prisma')).toBe(prisma);
    expect(priv<GuildRepository>(container.resolve(GuildRepository), 'prisma')).toBe(prisma);
    expect(priv<PlayRepository>(container.resolve(PlayRepository), 'prisma')).toBe(prisma);
    expect(priv<CrownRepository>(container.resolve(CrownRepository), 'prisma')).toBe(prisma);
  });

  it('resolves every registered token to a real value', () => {
    // Nothing here opens a socket or logs in: every registration in this graph
    // is a value provider built by hand, so `resolve` is a lookup. The list of
    // tokens that could not be resolved and were therefore only asserted as
    // REGISTERED is empty — that is the point of stating it.
    const unresolvable: string[] = [];
    const falsy: string[] = [];
    for (const { token } of registryEntries()) {
      let resolved: unknown;
      try {
        resolved = container.resolve(token as never);
      } catch {
        unresolvable.push(tokenName(token));
        continue;
      }
      if (resolved === undefined || resolved === null) falsy.push(tokenName(token));
    }
    expect({ unresolvable, falsy }).toEqual({ unresolvable: [], falsy: [] });
  });

  it('resolves every class token to an instance of that class', () => {
    // A token bound to the wrong object fails exactly like a missing one, from
    // every caller's point of view. PrismaClient is excluded for the
    // `$extends` reason stated above and is covered by identity instead.
    const wrongClass = registryEntries()
      .filter((entry) => typeof entry.token === 'function' && entry.token !== PrismaClient)
      .filter((entry) => !(container.resolve(entry.token as never) instanceof (entry.token as never)))
      .map((entry) => tokenName(entry.token));

    expect(wrongClass).toEqual([]);
  });

  it('binds every narrow port to the same singleton as its implementation', () => {
    // A port bound to a SECOND instance is the subtlest wiring bug available
    // here: both resolve, both work, and the two halves of a feature silently
    // stop sharing state.
    expect(container.resolve('ICache' as never)).toBe(container.resolve(CacheService));
    expect(container.resolve('ITelemetry' as never)).toBe(container.resolve(TelemetryService));
    expect(container.resolve('IGuildRepository' as never)).toBe(container.resolve(GuildRepository));
    expect(container.resolve('IUserRepository' as never)).toBe(container.resolve(UserRepository));
    expect(container.resolve('ILastfmRepository' as never)).toBe(container.resolve(LastFmRepository));
  });

  it('shares one rate limiter between the two handlers that consult it', () => {
    // `RateLimitService` is the only token in the graph `startup.ts` never
    // registers: it carries `@singleton()`, so tsyringe binds it on first
    // resolve. That works — and it is invisible, which is why it is asserted.
    // Golden rule 1 says the graph is hand-registered; this one is not.
    const fromCommandHandler = priv(container.resolve(CommandHandler), 'rateLimitService');
    const fromInteractionHandler = priv(container.resolve(InteractionHandler), 'rateLimitService');
    expect(fromCommandHandler).toBeInstanceOf(RateLimitService);
    expect(fromInteractionHandler).toBe(fromCommandHandler);
  });

  it('registers the four handlers it resolves by reflection', () => {
    // `container.resolve(X)` cannot find an unregistered `@inject` token: it
    // throws. So the fact that these four are RESOLVED rather than constructed
    // by hand means every one of their dependencies was registered first.
    // `configureContainer()` running at all is that proof; this test names it.
    // Written out rather than looped, for the reason in the test above.
    expect(container.isRegistered(ClientLogHandler)).toBe(true);
    expect(container.isRegistered(InteractionHandler)).toBe(true);
    expect(container.isRegistered(CommandHandler)).toBe(true);
    expect(container.isRegistered(UserEventHandler)).toBe(true);
    expect(container.resolve(ClientLogHandler)).toBeInstanceOf(ClientLogHandler);
    expect(container.resolve(InteractionHandler)).toBeInstanceOf(InteractionHandler);
    expect(container.resolve(CommandHandler)).toBeInstanceOf(CommandHandler);
    expect(container.resolve(UserEventHandler)).toBeInstanceOf(UserEventHandler);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. positional wiring                                                        */
/* -------------------------------------------------------------------------- */

describe('composition root — positional construction lands each argument on the field it names', () => {
  it.each(PINS.map((pin) => [pin.ctor.name, pin] as const))(
    '%s',
    (_name, pin) => {
      // Arity first. A constructor that grew a parameter without
      // `startup.ts` following is the load-bearing break golden rule 1 warns
      // about, and `Function.length` counts declared parameters including
      // optional ones while ignoring defaults — which is exactly the number a
      // hand-written call site has to match.
      expect((pin.ctor as { length: number }).length).toBe(pin.arity);

      const instance = container.resolve(pin.ctor as never) as object;
      for (const [field, expected] of pin.slots) {
        const actual = priv<unknown>(instance, field);
        if (expected === A_FUNCTION) {
          expect(typeof actual, `${pin.ctor.name}.${field}`).toBe('function');
          continue;
        }
        if (expected instanceof Unregistered) {
          expect(actual, `${pin.ctor.name}.${field}`).toBeInstanceOf(expected.ctor);
          continue;
        }
        // A bare string is a string token: `'ILastfmRepository'` and friends are
        // bound by name in `startup.ts` precisely so a lower layer need not
        // import the class.
        expect(actual, `${pin.ctor.name}.${field}`).toBe(container.resolve(expected as never));
      }
    },
  );

  it('pins the classes whose collaborators are built but not registered', () => {
    // These two are internal collaborators handed to another service rather
    // than exposed as tokens. Asserting them by class is what stops that from
    // quietly becoming "constructed and forgotten" (see the orphan audit).
    const music = container.resolve(MusicService);
    expect(priv(music, 'playlistChunkManager')).toBeInstanceOf(PlaylistChunkManager);
    expect(priv(music, 'deezerResolver')).toBe(container.resolve(DeezerResolver));
    expect(priv(music, 'appleMusicResolver')).toBe(container.resolve(AppleMusicResolver));
    expect(priv(container.resolve(SpotifyResolver), 'scraper')).toBeInstanceOf(SpotifyScraperService);
    expect(priv(container.resolve(PreviewResolverService), 'spotifyScraper')).toBe(
      priv(container.resolve(SpotifyResolver), 'scraper'),
    );
  });

  it('gave every artist command family the one artist-track service', () => {
    // Three consumers, one instance. A second `new ArtistTrackService()` would
    // satisfy every test in the repo and split the artist-track cache in two.
    const scoped = container.resolve(ArtistTrackService);
    expect(priv(container.resolve(ArtistInteractions), 'artistTrackService')).toBe(scoped);
    expect(priv(container.resolve(ArtistCommands), 'artistTrackService')).toBe(scoped);
    expect(priv(container.resolve(ArtistSlashCommands), 'artistTrackService')).toBe(scoped);
    expect(priv(container.resolve(ArtistTrackInteractions), 'artistTrackService')).toBe(scoped);
  });

  it('left the deliberately-omitted optional slots empty rather than misaligned', () => {
    // `ArtistsService` is given `(lastFmRepository, cache, undefined, colorService)`.
    // If that `undefined` were ever dropped, `colorService` would move into the
    // artwork slot and the missing collaborator would be invisible.
    const artists = container.resolve(ArtistsService);
    expect(priv(artists, 'colorService')).toBe(container.resolve(ColorService));
    expect(priv(artists, 'artworkService')).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* 4. post-construction wiring                                                 */
/* -------------------------------------------------------------------------- */

describe('composition root — the setters and notifiers that follow construction', () => {
  it('routes every playback notice into the one card publisher', () => {
    // Four separate wiring steps, and each one is invisible when it is missing:
    // a skipped track is never announced, a queue cap is never shown, a karaoke
    // toggle never refreshes the card. `setKaraokeToggleNotifier` and
    // `setCardRefreshNotifier` delegate into collaborators rather than storing
    // the closure themselves, so the field to read is on the collaborator.
    const music = container.resolve(MusicService);
    const handler = container.resolve(MusicHandler);
    const chunkManager = priv<{ unavailableNotifier: ((g: string, m: string) => void) | null }>(
      music, 'playlistChunkManager',
    );
    const controls = priv<{ karaokeToggleNotifier: ((g: string) => void) | null }>(music, 'controls');
    const artwork = priv<{ cardRefreshNotifier: ((g: string) => void) | null }>(music, 'artwork');

    const unavailable = priv<((g: string, m: string) => void) | null>(music, 'unavailableNotifier');
    const chunkNotice = chunkManager.unavailableNotifier;
    const karaoke = controls.karaokeToggleNotifier;
    const refresh = artwork.cardRefreshNotifier;

    for (const [name, notifier] of [
      ['MusicService.unavailableNotifier', unavailable],
      ['PlaylistChunkManager.unavailableNotifier', chunkNotice],
      ['MusicPlaybackControls.karaokeToggleNotifier', karaoke],
      ['MusicTrackArtwork.cardRefreshNotifier', refresh],
    ] as ReadonlyArray<readonly [string, unknown]>) {
      expect(typeof notifier, `${name} was never set`).toBe('function');
    }

    // Calling them is the assertion. A notifier left `null` is not a loud
    // failure: the optional call at the use site is simply skipped, and the
    // user sees nothing. Own properties on the HOST are replaced rather than
    // spied: the production closures captured the real method at wiring time, so
    // the double has to be in place before it runs, and `vi.spyOn` plus
    // `mockRestore` would leave the instance property `undefined` for every
    // later test in this file.
    const host = handler as unknown as Record<string, unknown>;
    const seen: string[] = [];
    const original = { send: host.sendSystemMusicNotice, card: host.refreshGuildCard };
    host.sendSystemMusicNotice = (guildId: string, content: string) => {
      seen.push(`notice:${String(guildId)}:${content}`);
    };
    host.refreshGuildCard = (guildId: string) => {
      seen.push(`card:${String(guildId)}`);
    };
    try {
      (unavailable as (g: string, m: string) => void)('g1', 'skipped');
      (chunkNotice as (g: string, m: string) => void)('g1', 'capped');
      (karaoke as (g: string) => void)('g1');
      (refresh as (g: string) => void)('g1');
    } finally {
      host.sendSystemMusicNotice = original.send;
      host.refreshGuildCard = original.card;
    }

    expect(seen).toContain('notice:g1:skipped');
    expect(seen).toContain('notice:g1:capped');
    expect(seen.filter((entry) => entry === 'card:g1')).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. the shared Last.fm error tracker                                          */
/* -------------------------------------------------------------------------- */

describe('composition root — one Last.fm error tracker, not two', () => {
  it('gives LastfmApi the tracker the rest of the bot reads', () => {
    // The writer and the readers must be the same object.
    //
    // `startup.ts` used to build `new LastfmApi(new LastfmErrorRateTracker())`,
    // a second instance that nothing else could reach. `LastfmApi` is the only
    // thing in the repo that calls `trackSuccess`/`trackError`, so the
    // registered tracker stayed at zero forever: `CrownService.isElevated()`
    // answered false through every Last.fm outage (the crown-steal kill switch
    // could not fire), and the ten-minute `logAndReset()` early-returned on a
    // permanent zero, so the error-rate report never appeared in a log.
    const tracker = container.resolve(LastfmErrorRateTracker);
    expect(priv(container.resolve(LastfmApi), 'errorTracker')).toBe(tracker);
    expect(priv(container.resolve(CrownService), 'errorRateTracker')).toBe(tracker);
    expect(priv(container.resolve(ArtworkService), 'lastFmErrorTracker')).toBe(tracker);
  });

  it('lets the tracker actually count a call', () => {
    // The direction nobody tests: a genuine zero must still read as "not
    // elevated", and one recorded failure must move the number.
    const tracker = container.resolve(LastfmErrorRateTracker);
    expect(tracker.isElevated()).toBe(false);
    for (let i = 0; i < 25; i += 1) tracker.trackSuccess();
    expect(tracker.isElevated()).toBe(false);
    for (let i = 0; i < 25; i += 1) {
      tracker.trackError(new Error('boom') as never);
    }
    expect(tracker.isElevated()).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. orphan audit, read off the source                                         */
/* -------------------------------------------------------------------------- */

const SRC = SRC_ROOT;
const STARTUP_SOURCE = readFileSync(join(SRC, 'bot', 'startup.ts'), 'utf8');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const constructedClasses = (source: string): string[] => {
  const out: string[] = [];
  for (const match of source.matchAll(/\bnew\s+([A-Z][\w$]*)\s*\(/g)) {
    const name = match[1] as string;
    if (name !== 'Promise') out.push(name);
  }
  return [...new Set(out)];
};

const tokenArguments = (source: string): string[] => {
  const out: string[] = [];
  // Multi-line `registerInstance(\n  Token,\n  ...)` is the dominant shape in
  // this file, so the token cannot be matched on the same line as the call.
  for (const match of source.matchAll(/registerInstance(?:<[^>]*>)?\(\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))/g)) {
    out.push((match[1] ?? match[2]) as string);
  }
  for (const match of source.matchAll(/container\.resolve\(\s*([A-Za-z_$][\w$]*)/g)) {
    out.push(match[1] as string);
  }
  return [...new Set(out)];
};

describe('composition root — nothing is constructed and forgotten', () => {
  it('registers or resolves every class it constructs', () => {
    // The direction that produces a feature nothing can reach. Both sets are
    // read from the source because that is the only place a construct-and-forget
    // is observable at all — by the time the container exists, the discarded
    // object is already gone.
    const tokens = new Set(tokenArguments(STARTUP_SOURCE));
    const orphans = constructedClasses(STARTUP_SOURCE).filter((name) => !tokens.has(name));

    // Exactly two, both deliberate: internal collaborators of another service,
    // reachable only through their holder. A third name here is a bug.
    expect(orphans.sort()).toEqual(['PlaylistChunkManager', 'SpotifyScraperService']);
  });

  it('names every token bound to something it did not construct', () => {
    // The reverse direction: a token whose value comes from a module import or
    // an alias rather than a local `new`. These are the ones a reader cannot
    // check by reading the call, so they are worth pinning.
    const constructed = new Set(constructedClasses(STARTUP_SOURCE));
    const resolved = new Set(
      [...STARTUP_SOURCE.matchAll(/container\.resolve\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1] as string),
    );
    const external = tokenArguments(STARTUP_SOURCE)
      .filter((token) => !constructed.has(token) && !resolved.has(token))
      .sort();

    expect(external).toEqual([
      'ICACHE', 'IGuildRepository', 'ILastfmRepository', 'ITELEMETRY',
      'IUserRepository', 'PrismaClient',
    ]);
  });

  it('resolves the reflection-dependent tokens it promises to construct', () => {
    // `ImageUploadService`, `TopInteractions`, `TrackPreviewInteractions`,
    // `ArtistTrackInteractions` and `ArtistInteractions` are resolved rather
    // than built by hand, which means every `@inject` token they declare has to
    // be registered BEFORE the resolve on the line above it. Asserting the
    // instances exist is the observable form of that ordering requirement.
    expect(container.resolve(ImageUploadService)).toBeInstanceOf(ImageUploadService);
    expect(container.resolve(TopInteractions)).toBeInstanceOf(TopInteractions);
    expect(container.resolve(TrackPreviewInteractions)).toBeInstanceOf(TrackPreviewInteractions);
    expect(container.resolve(ArtistTrackInteractions)).toBeInstanceOf(ArtistTrackInteractions);
    expect(container.resolve(ArtistInteractions)).toBeInstanceOf(ArtistInteractions);
  });
});

/* -------------------------------------------------------------------------- */
/* 7. nothing football-shaped survived                                         */
/* -------------------------------------------------------------------------- */

describe('the deleted football feature left nothing behind', () => {
  // This file is excluded from its own scan: it necessarily names the feature
  // and the prefix it is looking for. A guard that matched its own regex
  // literals would pass only by ignoring itself, which is worse than useless —
  // it would report "clean" no matter what the rest of the tree contained.
  const SELF = 'startupService.test.ts';

  const files = (): string[] => walk(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith(SELF));

  it('scans the whole source tree, not an empty one', () => {
    // The positive control. A walk that silently matched nothing would make both
    // tests below pass forever, which is the failure mode of every
    // "nothing is left" guard: it reports clean when it is broken. The count is
    // a floor, not a ratchet — it only has to be large enough that a tree this
    // size cannot be a false negative.
    expect(files().length).toBeGreaterThan(300);
  });

  it('has no football-shaped file left in the tree', () => {
    // The vocabulary is deliberately narrow. `fixture` was tried first and
    // matched `artworkService.providerFixtures.test.ts`, which has nothing to
    // do with sport — a deletion guard that fires on unrelated files trains
    // people to delete the guard.
    const offenders = walk(SRC).filter(
      (file) =>
        !file.endsWith(SELF) &&
        /football|scoreline|league/i.test(file.replace(/\\/g, '/')),
    );
    expect(offenders).toEqual([]);
  });

  it('has no football token, class or `fb:` customId left in any source file', () => {
    // A deleted feature that leaves a registration behind is worse than one
    // that was never removed: the token resolves, the commands answer, and the
    // data behind them has been deleted. Scanned across every `.ts` file
    // because a leftover in a module nothing imports is invisible to a grep of
    // the graph and invisible at runtime.
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (!file.endsWith('.ts') || file.endsWith(SELF)) continue;
      const rel = file.replace(/\\/g, '/').split('/src/')[1] ?? file;
      const source = readFileSync(file, 'utf8');
      if (/['"`]fb:/.test(source)) offenders.push(`${rel}: fb: customId prefix`);
      if (/\bFootball[A-Za-z0-9_]*/.test(source)) offenders.push(`${rel}: Football identifier`);
    }
    expect(offenders).toEqual([]);
  });

  it('registers no football token', () => {
    expect(registryEntries().map((e) => tokenName(e.token)).filter((n) => /football/i.test(n))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 8. StartupService — the boot sequence                                       */
/* -------------------------------------------------------------------------- */

interface GuildDouble {
  id: string;
  name: string;
  memberCount: number;
}

const guildCache = (guilds: GuildDouble[]) => ({
  size: guilds.length,
  reduce: <T>(fn: (acc: T, guild: GuildDouble) => T, initial: T): T =>
    guilds.reduce(fn, initial),
  values: () => guilds[Symbol.iterator](),
});

const readyEvent = (guilds: GuildDouble[]) => ({
  guilds: { cache: guildCache(guilds) },
  user: { tag: 'tvbot#0001' },
});

interface Doubles {
  client: FakeClient;
  timerService: { startAsync: ReturnType<typeof vi.fn> };
  puppeteerService: { preheatAsync: ReturnType<typeof vi.fn> };
  guildService: { ensureGuildExists: ReturnType<typeof vi.fn> };
  moonlinkManager: { init: ReturnType<typeof vi.fn> };
  healthServer: { start: ReturnType<typeof vi.fn> };
  queue: { loadPersistedState: ReturnType<typeof vi.fn> };
  optIns: { loadOptIns: ReturnType<typeof vi.fn> };
  abuse: { refresh: ReturnType<typeof vi.fn> };
  lyrics: { updateLyricStatusAsync: ReturnType<typeof vi.fn> };
  cache: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
}

interface FakeClient {
  once: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  user: { setPresence: ReturnType<typeof vi.fn> };
  application: { commands: { set: ReturnType<typeof vi.fn> } } | null;
  shard: { ids: number[] } | undefined;
}

/**
 * `StartupService` takes six declared parameters, so TypeScript only accepts a
 * spread into a rest parameter. Going through this alias is the one cast that
 * lets the service be built positionally — and building it positionally is the
 * point, because the alternative is to hand it a named bag of doubles and assert
 * nothing about which collaborator landed where.
 */
const StartupServiceCtor = StartupService as unknown as new (
  client: FakeClient,
  timerService: Doubles['timerService'],
  puppeteerService: Doubles['puppeteerService'],
  guildService: Doubles['guildService'],
  moonlinkManager: Doubles['moonlinkManager'],
  healthServer: Doubles['healthServer'],
) => StartupService;

/** `startup.ts` already built the graph, so this constructs the graph, not a
 *  socket. */
const makeDoubles = (): Doubles => ({
  client: {
    once: vi.fn(async (..._args: unknown[]) => undefined),
    on: vi.fn(async (..._args: unknown[]) => undefined),
    login: vi.fn(async (..._args: unknown[]) => 'token'),
    user: { setPresence: vi.fn((..._args: unknown[]) => undefined) },
    application: null,
    shard: undefined,
  },
  timerService: { startAsync: vi.fn(async (..._args: unknown[]) => undefined) },
  puppeteerService: { preheatAsync: vi.fn(async (..._args: unknown[]) => undefined) },
  guildService: { ensureGuildExists: vi.fn(async (..._args: unknown[]) => undefined) },
  moonlinkManager: { init: vi.fn(async (..._args: unknown[]) => undefined) },
  healthServer: { start: vi.fn((..._args: unknown[]) => undefined) },
  queue: { loadPersistedState: vi.fn(async (..._args: unknown[]) => undefined) },
  optIns: { loadOptIns: vi.fn(async (..._args: unknown[]) => undefined) },
  abuse: { refresh: vi.fn(async (..._args: unknown[]) => undefined) },
  lyrics: { updateLyricStatusAsync: vi.fn(async (..._args: unknown[]) => undefined) },
  cache: {
    get: vi.fn(async (..._args: unknown[]) => null as string | null),
    set: vi.fn(async (..._args: unknown[]) => undefined),
  },
});

/**
 * Swap a token out and put the previous value back.
 *
 * Not `vi.spyOn(container, ...)`: `mockRestore` leaves an own property set to
 * `undefined`, and every later test in the file then reads a container that no
 * longer resolves. This restores the exact prior instance, so the suite is
 * order-independent.
 */
const stubTokens = (stubs: ReadonlyArray<[new (...args: never[]) => unknown, object]>): (() => void) => {
  const restore = stubs.map(([token, stub]) => {
    const had = container.isRegistered(token as never);
    const prior = had ? container.resolve(token as never) : undefined;
    container.registerInstance(token as never, stub as never);
    return () => {
      if (had) container.registerInstance(token as never, prior as never);
    };
  });
  return () => { for (const undo of restore) undo(); };
};

describe('StartupService.startAsync', () => {
  let doubles: Doubles;
  let service: StartupService;
  let unstub: () => void;

  beforeEach(() => {
    doubles = makeDoubles();
    // Positionally, exactly as the container does. Six declared parameters, so
    // a seventh would be a compile error here and a silent `undefined` in
    // production.
    // `StartupService` declares six parameters, so TypeScript will only accept
    // a spread into a rest parameter. This alias is the one cast that lets it be
    // built POSITIONALLY, which is the entire point: the alternative is to hand
    // the service a bag of doubles keyed by name and assert nothing about order.
    service = new StartupServiceCtor(
      doubles.client,
      doubles.timerService,
      doubles.puppeteerService,
      doubles.guildService,
      doubles.moonlinkManager,
      doubles.healthServer,
    );
    unstub = stubTokens([
      [ClientLogHandler, { resolved: true }],
      [InteractionHandler, { resolved: true }],
      [CommandHandler, { resolved: true }],
      [MusicHandler, { resolved: true }],
      [QueueService, doubles.queue],
      [BotScrobblingService, doubles.optIns],
      [AbuseFilterService, doubles.abuse],
      [LyricStatusService, doubles.lyrics],
      [CacheService, doubles.cache],
    ]);
    vi.spyOn(Logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger, 'ready').mockImplementation(() => undefined);
  });

  afterEach(() => {
    unstub();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The `ClientReady` handler `startAsync` registered on the client double. */
  const fireReady = async (guilds: GuildDouble[] = []): Promise<void> => {
    const listener = doubles.client.once.mock.calls.find(
      (call) => call[0] === Events.ClientReady,
    )?.[1] as ((event: unknown) => Promise<void>) | undefined;
    expect(listener, 'no ClientReady listener was registered').toBeDefined();
    await listener?.(readyEvent(guilds));
  };

  it('starts the health server, preheats Puppeteer and logs in', async () => {
    await service.startAsync();

    expect(doubles.healthServer.start).toHaveBeenCalledTimes(1);
    expect(doubles.puppeteerService.preheatAsync).toHaveBeenCalledTimes(1);
    expect(doubles.client.login).toHaveBeenCalledTimes(1);
  });

  it('registers its gateway listeners before logging in', async () => {
    await service.startAsync();

    expect(doubles.client.once.mock.calls.map((c) => c[0])).toContain(Events.ClientReady);
    expect(doubles.client.on.mock.calls.map((c) => c[0])).toContain(Events.GuildCreate);
    // Registration order is the point: a listener added after `login` misses the
    // events it exists to handle.
    const readyIndex = doubles.client.once.mock.calls.length;
    expect(doubles.client.on.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(readyIndex).toBeGreaterThan(0);
  });

  it('retries a failed login three times and then gives up loudly', async () => {
    vi.useFakeTimers();
    doubles.client.login.mockRejectedValue(new Error('gateway 502'));

    const booting = service.startAsync();
    // The rejection handler is attached BEFORE the clock advances. Attaching it
    // afterwards leaves a window in which the promise is rejected and nothing is
    // listening, which Node reports as an unhandled rejection and vitest
    // attributes to whichever test happened to be running.
    const settled = expect(booting).rejects.toThrow('gateway 502');
    await vi.advanceTimersByTimeAsync(10000);
    await settled;

    expect(doubles.client.login).toHaveBeenCalledTimes(3);
    expect(Logger.warn).toHaveBeenCalled();
  });

  it('stops retrying as soon as a login succeeds', async () => {
    vi.useFakeTimers();
    doubles.client.login
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValueOnce('token');

    const booting = service.startAsync();
    await vi.advanceTimersByTimeAsync(5000);
    await booting;

    expect(doubles.client.login).toHaveBeenCalledTimes(2);
  });

  describe('on ClientReady', () => {
    it('announces the guild and user counts, sets presence and starts music', async () => {
      await service.startAsync();
      await fireReady([
        { id: 'g1', name: 'One', memberCount: 10 },
        { id: 'g2', name: 'Two', memberCount: 5 },
      ]);

      expect(Logger.ready).toHaveBeenCalledWith(expect.stringContaining('15 users'));
      expect(doubles.client.user.setPresence).toHaveBeenCalledTimes(1);
      expect(doubles.moonlinkManager.init).toHaveBeenCalledTimes(1);
    });

    it('registers every guild it is already serving', async () => {
      // A guild that fails to register has no settings row, and every
      // guild-scoped read afterwards behaves as if the guild were unconfigured.
      await service.startAsync();
      await fireReady([
        { id: 'g1', name: 'One', memberCount: 1 },
        { id: 'g2', name: 'Two', memberCount: 1 },
      ]);

      expect(doubles.guildService.ensureGuildExists).toHaveBeenCalledTimes(2);
      expect(doubles.guildService.ensureGuildExists).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'g2' }),
      );
    });

    it('logs a guild registration failure instead of reporting a clean boot', async () => {
      doubles.guildService.ensureGuildExists.mockRejectedValue(new Error('db down'));
      await service.startAsync();
      await fireReady([{ id: 'g1', name: 'One', memberCount: 1 }]);

      expect(Logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ guildId: 'g1' }),
        expect.stringContaining('Failed to register guild'),
      );
    });

    it('keeps booting when the music manager refuses to initialise', async () => {
      doubles.moonlinkManager.init.mockRejectedValue(new Error('no nodes'));
      await service.startAsync();
      await fireReady();

      expect(Logger.error).toHaveBeenCalledWith(
        expect.anything(),
        'Failed to initialize MoonlinkManager',
      );
      expect(doubles.timerService.startAsync).toHaveBeenCalledTimes(1);
    });

    it('keeps booting when slash-command publication fails', async () => {
      // The whole text-command surface still works, so taking the process down
      // here would be the more destructive choice.
      doubles.client.application = {
        commands: { set: vi.fn(async (..._args: unknown[]) => { throw new Error('429'); }) },
      };
      await service.startAsync();
      await fireReady();

      expect(Logger.error).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Failed to register slash commands'),
      );
      expect(doubles.timerService.startAsync).toHaveBeenCalledTimes(1);
    });

    it('restores durable state and flags before starting the timers', async () => {
      await service.startAsync();
      await fireReady();

      expect(doubles.queue.loadPersistedState).toHaveBeenCalledTimes(1);
      expect(doubles.optIns.loadOptIns).toHaveBeenCalledTimes(1);
      expect(doubles.abuse.refresh).toHaveBeenCalledTimes(1);
      expect(doubles.timerService.startAsync).toHaveBeenCalledTimes(1);
    });

    it('keeps booting when restoring durable state throws', async () => {
      doubles.queue.loadPersistedState.mockRejectedValue(new Error('table gone'));
      doubles.optIns.loadOptIns.mockRejectedValue(new Error('table gone'));
      doubles.abuse.refresh.mockRejectedValue(new Error('table gone'));
      await service.startAsync();
      await fireReady();

      expect(Logger.warn).toHaveBeenCalled();
      expect(doubles.timerService.startAsync).toHaveBeenCalledTimes(1);
    });

    it('refreshes the lyric presence without letting it fail the boot', async () => {
      await service.startAsync();
      await fireReady();

      expect(doubles.lyrics.updateLyricStatusAsync).toHaveBeenCalledTimes(1);
    });
  });

  it('registers a guild it is invited to after boot', async () => {
    await service.startAsync();
    const listener = doubles.client.on.mock.calls.find((call) => call[0] === Events.GuildCreate)
      ?.[1] as ((guild: GuildDouble) => void) | undefined;
    expect(listener).toBeDefined();

    const guild = { id: 'g9', name: 'New', memberCount: 3 };
    listener?.(guild);

    expect(doubles.guildService.ensureGuildExists).toHaveBeenCalledWith(guild);
  });

  describe('slash-command publication', () => {
    const setCommands = (): ReturnType<typeof vi.fn> => {
      const set = vi.fn(async (..._args: unknown[]) => undefined);
      doubles.client.application = { commands: { set } };
      doubles.client.shard = { ids: [0] };
      return set;
    };

    const publish = async (): Promise<void> => {
      await service.startAsync();
      await fireReady();
    };

    it('publishes when the stored payload hash is absent', async () => {
      const set = setCommands();
      await publish();

      expect(set).toHaveBeenCalledTimes(1);
      expect(doubles.cache.set).toHaveBeenCalledWith(
        'slash-commands-payload-hash',
        expect.any(String),
        expect.any(Number),
      );
    });

    it('publishes nothing when the payload is byte-identical to the last boot', async () => {
      const set = setCommands();
      const hash = createHash('sha256')
        .update(JSON.stringify(getSlashCommandPayloads()))
        .digest('hex');
      doubles.cache.get.mockResolvedValue(hash);

      await publish();

      expect(set).not.toHaveBeenCalled();
      expect(Logger.info).toHaveBeenCalledWith(expect.stringContaining('unchanged'));
    });

    it('publishes unconditionally when the cache cannot answer', async () => {
      // "Cache unavailable" has to mean re-publish, not "publish nothing": a
      // redundant PUT beats a stale command set.
      const set = setCommands();
      doubles.cache.get.mockRejectedValue(new Error('redis down'));

      await publish();

      expect(set).toHaveBeenCalledTimes(1);
    });

    it('publishes nothing before the client has an application', async () => {
      doubles.client.application = null;
      await publish();

      expect(Logger.ready).toHaveBeenCalled();
    });

    it('never publishes from a non-zero shard', async () => {
      // N shards × every boot is N times the global-command PUT budget.
      const set = setCommands();
      doubles.client.shard = { ids: [1] };

      await publish();

      expect(set).not.toHaveBeenCalled();
    });

    it('honours SKIP_SLASH_REGISTER', async () => {
      const previous = process.env.SKIP_SLASH_REGISTER;
      process.env.SKIP_SLASH_REGISTER = 'true';
      try {
        const set = setCommands();
        await publish();
        expect(set).not.toHaveBeenCalled();
      } finally {
        if (previous === undefined) delete process.env.SKIP_SLASH_REGISTER;
        else process.env.SKIP_SLASH_REGISTER = previous;
      }
    });
  });
});
