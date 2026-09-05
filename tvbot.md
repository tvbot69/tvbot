# tvbot — AI Master Handbook
> **Single source of truth for any AI (new chat, new model) to work on tvbot instantly. Read this file first, then act. No forgetting.**

`tvbot` is a **private, unlimited** Discord bot mirroring `fmbot-dev` for a closed friend group. Two pillars: **Last.fm stats** (`/fm`, `wk`, `chart`, `at`, `overview`, `top*`) + **Lavalink music** (`Moonlink.js v5` + `Spotify/YouTube`). `TypeScript + Node 20+ + discord.js 14 + Prisma (PostgreSQL) + tsyringe DI + ioredis + Puppeteer`.

---

## 0. How any AI must work here
1. **Read this file fully** before any edit. This file *is* the context — no need to re-ask.
2. **Reference files as `path:line`** (e.g. `src/bot/startup.ts:103`).
3. **Verify via execution**: `npm run build` + `npm test` after every feature. Never guess outputs — run `node -e` or `tsx`.
4. **Skill:** Load `tvbot` skill when doing tvbot work: `skill(name: "tvbot")` — contains workflows for adding commands/services.
5. **Conventions:** `tsyringe` manual `registerInstance` in `startup.ts`, unified `ContextModel` → `ResponseModel`, `CommandResponse` enum, `artworkService` is single source for covers (never trust Last.fm `imageUrl` directly).
6. Update this file when you add a major pillar.

---

## 1. Quick Start
```bash
npm install
cp .env.example .env # fill DISCORD_TOKEN, DATABASE_URL, LASTFM_API_KEY/SECRET
npm run db:generate && npm run db:deploy
npm run dev      # tsx watch src/bot/index.ts — ephemeral Puppeteer, Lavalink disabled in dev unless ENABLE_LAVALINK=true
npm run build    # tsc + tsc-alias + copy-assets
npm test         # vitest run (9 suites, 1 pre-existing lavalinkConfig fail)
```
Env: `DISCORD_TOKEN`, `DATABASE_URL`, `LASTFM_API_KEY/SECRET` required; `SPOTIFY_CLIENT_ID/SECRET`, `REDIS_URL=redis://localhost:6379`, `LAVALINK_NODES` JSON, `LAVALINK_BACKUP_HOST`, `ENVIRONMENT=local`, `BOT_PREFIX=.`, `ENABLE_LAVALINK=false` in dev, `STAGING_CHANNEL_ID` for chart uploads.

---

## 2. Directory Map — Every File’s Job

### `src/bot/` Application layer
- `index.ts` — bootstrap
- `startup.ts:103` — **DI container** (500+ lines, the `Program.cs`). Manually `new` + `registerInstance` for every service/repo/command/handler. **Add new service here**.
- `configurations/configData.ts` — reads `.env` via `dotenv`, validates required.
- `handlers/` — Discord event routers
  - `commandHandler.ts` — `MessageCreate` → `getTextCommand` → `isBlockedInContext` → `ContextModel.fromMessage` → color → `executeAsync` → `send` (embeds/components)
  - `interactionHandler.ts` — `InteractionCreate` → slash/autocomplete/button/select/modal → `getSlashCommand` / `getAutoCompleteResponder` / `tryHandleModal`. Routes `FM_MODE_PREFIX`, `friends:selecttype:`, `music:filter:`, `chart-edit:`, `track-preview:`, `top*`, `overview:`, `at:` etc. Uses `componentTracker` fallback.
  - `musicHandler.ts` — Lavalink `nodeConnected/Disconnect/playerSwitched` → failover
  - `updateQueueHandler.ts`, `userEventHandler.ts`, `clientLogHandler.ts`
- `slashCommands/` — one file per domain, each exports `commands: SlashCommandDefinition[]` with `data: SlashCommandBuilder` + `executeAsync`
  - `userSlashCommands.ts` — `/fm` (User+lfm options), `/fmmode`, `/register` — uses `ArtworkService` fallback for `track.imageUrl`
  - `albumSlashCommands.ts` — `/cover`, `/album` → `AlbumService`
  - `chartSlashCommands.ts` — `/chart albums|artists` — delegates to `BotChartService`
  - `whoKnowsSlashCommands.ts` — `/whoknows`, `/wktrack`, `/wkalbum`, `/friendswhoknow` → `WhoKnows*Service` + `ArtworkService`
  - `friendSlashCommands.ts` — `/addfriend` etc.
  - `musicSlashCommands.ts` — `/play` etc. via `MusicService`
  - `topSlashCommands.ts` — `/topartists/topalbums/toptracks` (time-period autocomplete `weekly→overall` via `SettingService`) → `LastFmRepository.getTop*` 1000 limit → `TopBuilders`
  - `overviewSlashCommands.ts` — `/overview` → `OverviewService` (DB `user_plays` group by day, 500 rows, timeZone) → `OverviewBuilders`
  - `artistTrackSlashCommands.ts` — `/at artist?` → `ArtistTrackService` `GetTopTracksForArtist` from DB
  - `trackSlashCommands.ts` — `/trackdetails track?` → `TrackDetailsService` (Essentia BPM/key) → `TrackDetailsBuilders`
  - `crownSlashCommands.ts`, `tasteSlashCommands.ts`, `artistSlashCommands.ts`, `updateSlashCommands.ts` — other domains
- `textCommands/` — mirror of slash for prefix `.`
  - `lastfm/playCommands.ts` — `fm` (25 aliases `np,qm,wm…`) with `lfm:` + `<@mention>` + `parseFmEmbedType`, `cooldown 3s`, uses `ArtworkService`
  - `lastfm/chartCommands.ts`, `loginCommands.ts`, `topCommands.ts`, `overviewCommands.ts`, `artistTrackCommands.ts`, `trackCommands.ts`, `tasteCommands.ts`, `updateCommands.ts`
  - `guild/whoKnowsCommands.ts`, `guild/crownCommands.ts`
  - `music/musicCommands.ts`
- `builders/` — `ResponseModel` factories
  - `playBuilders.ts` — `buildFmResponse` 6 embed types (EmbedMini/Full/Tiny vs Text*), `buildFmModeResponse`
  - `whoKnowsBuilders.ts` — `buildWhoKnowsResponse` embed `crown?` + `👑` + `Artist - X listeners - Y plays - Z avg` footer (genres ` - `), `generatePages` for pagination 10/page
  - `chartBuilders.ts`, `albumBuilders.ts`, `artistBuilders.ts`, `artistTrackBuilders.ts`, `topBuilders.ts`, `overviewBuilders.ts`, `trackDetailsBuilders.ts`, `crownBuilders.ts`, `tasteBuilders.ts`, `updateBuilders.ts`, `footerBuilder.ts`
- `interactions/` — button/select/modal handlers
  - `chartInteractions.ts`, `albumInteractions.ts`, `friendInteractions.ts`, `fmModeInteractions.ts`, `musicInteractions.ts`, `topInteractions.ts` (also handles `overview` jump modal `1-31`), `artistTrackInteractions.ts`, `trackPreviewInteractions.ts` (`track-preview:` → `VoiceMessageService` flags `8192`), `crownInteractions.ts`, `tasteInteractions.ts`, `recentInteractions.ts`
- `services/`
  - `updateService.ts` — **delta sync heart** (900 lines, mirrors fmbot `UpdateService.cs`): `OVERLAP_HOURS=3`, `FALLBACK 14d`, `getUserRecentTracksWithMetadata` with retry `500,2500,5000,10000,25000`, dedup `timePlayed ms` equality, `applyIncrementalTopLists` if `<200` else `recalculateTopLists`, `genreService` warm.
  - `indexService.ts` — full re-index: `deleteAllPlays` → fetch 1000×1000 → flush every 10 pages → `recalculateTopLists` GROUP BY
  - `chartService.ts` — `ArtworkService` primary (`Spotify→Deezer→Apple→Last.fm`, `isPlaceholder 2a96cb…`), `BotChartService` orchestration, `PuppeteerService` screenshot, `ImageUploadService` staging
  - `artworkService.ts` — `getAlbumCoverUrl/getArtistImageUrl/getTrackCoverUrl` with `sanitizeMusicName`, `isPlaceholder`, `FRESHNESS 90d`, cache `art:*` 3600s, DB persist
  - `audio/` — `essentiaService.ts` (WASM `RhythmExtractor2013` BPM + `KeyExtractor`), `audioSignalService.ts` (`ffmpeg-static` decode to `Float32Array`), `previewResolverService.ts` (`spotifyScraper→Apple→Deezer` scored `5000/4000/2000`, `preview:v3:` cache), `trackDetailsService.ts`, `voiceMessageService.ts` (`p.scdn.co` `MP3_96` → `libopus ogg` `flags:8192` `waveform` base64, `previewMap`)
  - `music/` — `moonlinkManager.ts` (5 public nodes + `LAVALINK_NODES` env, `retryAmount:0` custom failover, `cooldown 10-15s`, `healthCheck 10s`, `ENABLE_LAVALINK=false` dev no-connect + Redis `lavalink:cooldown:*` persist), `musicService.ts` (`play/skip/stop/filters`), `spotifyResolver.ts` + `spotifyScraperService.ts` (HTML `__NEXT_DATA__` + `spclient.wg.spotify.com` + `getPreviewById` embed), `queueService.ts`, `playlistChunkManager.ts`
  - `whoKnows/` — `whoKnowsService.ts` (14-cap list, `nameWithLink` uses `discordName`), `whoKnowsArtistService.ts`/`Track`/`Album`/`PlayService.ts` (fetch `discord displayName` via `guild.members.fetch` if not cached)
  - `crown/crownService.ts` — `GetAndUpdateCrownForArtist` (eligibility `BlockedFromCrowns`, `CrownRoles`, `30` plays, steal logic with live `getArtistInfo`), `SeedCrownsForGuild`
  - `overviewService.ts` — **DB** `prisma.userPlay.findMany take 500` grouped by `YYYY-MM-DD` (UTC) → `DailyBlock` (date, playCount, duration `210s` est, topArtist/Album/Track, genres via `GenreService`)
  - `artistTrackService.ts` — `getTopTracksForArtist(userId, artist, Weekly=7d else all)` groupBy `trackName` from `user_plays`
  - `timerService.ts` — cron `*/5` update queue, `*/2` index queue, `0 6,14` enqueue outdated (`lastUpdate<48h`), `0 8` stale index, `0 4` privacy, `*/10` log
  - `cacheService.ts` — `ioredis` + in-memory fallback, `get/set/delete` JSON
  - `colorService.ts`, `genreService.ts`, `friendsService.ts`, `loginService.ts`, `settingService.ts` (`getTimePeriod` weekly→overall + `1d-6d` + `YYYY` + `MMMM` via `PeriodAliases`), `topListSettings`, `localizationService.ts`, `componentInteractionTracker.ts`, `paginationService.ts`
  - `guild/` — `guildService.ts`, `guildUserService.ts`, `disabledChannelService.ts`, etc.
- `models/` — `contextModel.ts` (unified slash/text), `responseModel.ts` (`embed` + `content` + `componentsV2Container` + `isComponentsV2`), `commandModels.ts`, `chartModels.ts`, `whoKnowsModels.ts`
- `resources/discordConstants.ts` — colors, emojis (`sp:1496297132381048995`, `dez:1496297153717473311`, `am:1496297174869479548`, `fmbot_playpreview:1305607890941378672`)

### `src/domain/` Zero-deps shared
- `enums/` — `commandResponse`, `fmEmbedType` (0-5), `fmFooterOption` (28 flags bigint), `fmButton`, `fmAccentColor`, `whoKnowsMode`, `updateType`, `privacyLevel`, `friendType`
- `interfaces/` — `IUserRepository`, `IPlayRepository`, `IArtistRepository`, `IAlbumRepository`, `ITrackRepository`, `ILastfmRepository`, `IFriendRepository`, `IWhoKnowsRepository`, etc.
- `models/` — `recentTrack.ts`, `lastFmUser.ts`, `botSettings.ts`, `musicTrack.ts`, `timeSettings.ts`, `topLists.ts`
- `logger.ts` (pino), `statistics.ts`, `lastfmErrorRateTracker.ts`, `constants.ts`

### `src/persistence/` Prisma + repos
- `prisma/schema.prisma` 298 lines — `users`, `user_fm_settings` (PK `user_id`, `embed_type`, `footer_options bigint`, `buttons bigint`), `guilds`, `channels`, `guild_users`, `artists`, `artist_genres`, `albums`, `tracks`, `user_plays` (bigint PK, `time_played timestamptz`), `user_artists/albums/tracks`, `friends`, `user_crowns` (guild+artist unique where active)
- `repositories/` — `userRepository.ts`, `playRepository.ts`, `artistRepository.ts`, `albumRepository.ts`, `trackRepository.ts`, `whoKnowsRepository.ts`, `crownRepository.ts`, `guildRepository.ts`, etc.
- `prismaClient.ts` singleton

### `src/lastfm/`, `src/spotify/`, `src/deezer/`, `src/applemusic/`, `src/discogs/`
- `lastfm/api/lastfmApi.ts` (fetch `ws.audioscrobbler.com/2.0?method=`, `LastfmApiError` handling, `call`/`callSigned`), `repositories/lastFmRepository.ts` (`callWithRetry` 5 retries `500,2500…`), `converters/recentTrackConverter.ts` (`pickLargestImage` filters `2a96cb…` placeholder), `topListConverter.ts`, `infoConverter.ts`
- `spotify/api/spotifyTokenManager.ts`, `spotifySearchApi.ts` (`searchTracks` + `getSpotifyTrackUrl` scored `5000` exact), `deezer/apis/deezerApi.ts` (`/search/album/track`), `applemusic/apis/appleMusicWebApi.ts` + `appleMusicSearchApi.ts` (`upscaleArtwork`)

### `src/images/` Puppeteer
- `generators/puppeteerService.ts` — singleton `Browser` (ephemeral dev, persistent prod `.puppeteer`), `preheatAsync`, `screenshotHtml`/`WithRainbowSort`, `close()` with `pages` 1.5s + `browser.close` 3s cap + `SIGKILL`, `registerProcessCleanup` for `SIGINT/TEXT/beforeExit`
- `generators/chartService.ts` — builds `chart.html` template + `screenshotHtml`, `pages/chart.html`

### `src/config/lavalink.ts`
5 public nodes `Serenetia`, `AjieBlogs`, `Jirayu-SSL`, `MilloHost`, `Jirayu-NonSSL` + `LAVALINK_NODES`/`LAVALINK_BACKUP_HOST` env override

---

## 3. DB Schema Hot Columns
- `users`: `user_id`, `discord_user_id`, `user_name_last_fm`, `last_update`, `last_indexed`, `last_scrobble_update`, `total_play_count`, `session_key`, `privacy_level`
- `user_plays`: `(user_id,time_played)` indexed, `artist_name`, `album_name`, `track_name`, `play_source`
- `user_fm_settings`: `embed_type`, `footer_options`, `buttons`, `accent_color`, `custom_color`, `small_text_type`
- `guilds`: `prefix`, `accent_color`, `fm_embed_type`, `commands_disabled`

## 4. Core Patterns

### Request Flow
```
Discord → InteractionHandler (slash) / CommandHandler (text)
 → isBlockedInContext (guild/channel/command)
 → ContextModel.fromInteraction/fromMessage
 → accentColor = colorService.getAccentColorAsync(guildId)
 → command.executeAsync(context) → ResponseModel
 → sendResponse: if isComponentsV2 → ComponentsV2 else embed+components (+content for trackdetails)
```

### DI
All `registerInstance` in `startup.ts:103`. No decorators. Add new service → `new` + `registerInstance` + add to `slashCommands/index.ts` + `textCommands/index.ts` + `interactionHandler.ts` route.

### Artwork
Single source `ArtworkService` (`Spotify→Deezer→Apple→Last.fm`, placeholder `2a96cb…` filtered, 3600s cache, 90d freshness). Chart `resolveAlbumCovers` now forces `ArtworkService` first. `fm` enriches `track.imageUrl` via `getAlbumCoverUrl` + `getTrackCoverUrl` before `PlayBuilders`.

### WhoKnows
`whoKnowsArtistService.getFilteredUsersForArtist` → `guildUsers` map `userId→FullGuildUserDetails` → `whoKnowsRepository.getIndexedUsersForArtist` → map to `WhoKnowsUser{userId,playcount,lastFmUsername,discordName: member.displayName ?? lastFmUsername, discordUserId}` via `guild.members.fetch` if not cached → `addOrReplaceUserToIndexList` (inject caller live playcount) → `filterWhoKnowsObjects` (blocked/banned) → `WhoKnowsBuilders.buildWhoKnowsResponse` (embed `crown`? + `Artist - X listeners - Y plays - Z avg` footer where avg hidden if `1` listener).

**wkt artwork bug fixed:** was `getAlbumCoverUrl(albumName ?? trackName)` → now `getTrackCoverUrl(track, artist)` for strict track cover.

---

## 5. Top / Overview / At
- **Top** (`ta`/`tt`/`tab`): `SettingService.getTimePeriod` (weekly→overall + `1d-6d/yesterday/today/2024/march` as chart) + `LastFmRepository.getTopArtists/Albums/Tracks(…,1000)` → `TopBuilders` paginator (10/page, 5 btns `first/prev/next/last/jump` `8838255…/11388496…`, customId `topartists:next:0:Moha504:weekly`, `top-jump` modal `Page number (1-31)`). Limit bumped 200→1000 to match `Page 1/40 - 608 tracks` (was `1/20`).
- **Overview** (`o`): `OverviewService.getOverview` now **DB** `prisma.userPlay.findMany take 500 orderBy timePlayed desc` grouped `YYYY-MM-DD` UTC (fmbot uses `timeZone` local midnights — tvbot uses UTC for simplicity, 500 rows covers ~7d for 483 plays/week) → 4 blocks/page, `8` pages, footer `1/8 - Top genres…` `395 unique tracks - 483 total plays - 120 avg`. Fixes `403` from `user.getRecentTracks` signed (stale `sk`). `at` is **not** overview: `artistTrackService` `+at` → `ArtistTrackService.getTopTracksForArtist(userId, artist)` groupBy `trackName` from DB, builder `Your top tracks for 'zaf'` `10` per page `📊` button `artist-overview:Id:…`.
- Interaction `TopInteractions` handles `top*`/`overview:` buttons + `top-jump`/`overview-jump` modals.

## 6. Trackdetails Voice Preview (Essentia)
`TrackDetailsService` → `PreviewResolverService` (`spotifyScraper.getTrackPreview` HTML `__NEXT_DATA__` `p.scdn.co/mp3-preview/...` **first**, fallback `Apple → Deezer` scored `5000` + `getPreviewById` via `SpotifySearchApi.getSpotifyTrackUrl` limit `5` + `baba` penalty) → `audioSignalService.getAudioSignalAndSr` (`ffmpeg-static` decode to `Float32`) → `EssentiaService` `RhythmExtractor2013` BPM + `KeyExtractor` → `TrackDetailsBuilders` `**TRACK** by **ARTIST** has \`140.0\` bpm, is in key \`G#\` and lasts \`3:18\`` + row `Preview` `track-preview:Id:` `fmbot_playpreview:1305607890941378672` + `Open on Spotify sp:1496297132381048995` / `Deezer dez:1496297153717473311` / `Apple am:1496297174869479548` (source-aware). `VoiceMessageService` `sendViaWebhook`/`sendViaChannel` with `flags:8192` `waveform` base64 100 bytes + `duration_secs` `audio/ogg` `libopus` via `fluent-ffmpeg`.

## 7. Crown System (`crownplan.md`)
- Table `user_crowns` `guild_id+artist` unique where active, `seeded_crown` flag.
- `CrownService.getAndUpdateCrownForArtist` steal/claim (`30` plays default, `BlockedFromCrowns`, `CrownRoles`, live `getArtistInfo` check, `IssuesAtLastFm` guard) + `SeedCrownsForGuild` (`DISTINCT ON(ua.name)` bulk `COPY`).
- `CrownBuilders` duel embed + `WhoKnows` wiring (call inside `whoKnowsArtistService` after filter, append `Crown claimed by moha!` to footer).
- Commands `crown`, `crowns`, slash `/crown`, interaction `crown-overview`.

## 8. Music
`MoonlinkManager` singleton, `hasHealthyNode()` gate, `handleNodeFailover` migrates players. `MusicService.play()` → `SpotifyResolver` (playlist → YouTube search `5` concurrency) → `manager.search` → `queue.add` → `player.play()` → `PlaylistChunkManager` lazy 100. Nodes: `Serenetia`, `AjieBlogs`, `Jirayu-SSL/NonSSL`, `MilloHost`. Dev `ENABLE_LAVALINK=false` skips (dummy `dummy-disabled`). Prod `ENVIRONMENT=production` + Redis `lavalink:cooldown:*` persist.

## 9. Puppeteer
`PuppeteerService` ephemeral dev (no `userDataDir` lock → 40 chrome leak fixed), persistent prod `.puppeteer`, `preheatAsync`, `close()` with `pages` 1.5s + `browser.close` 3s cap + `SIGKILL`, `gracefulShutdown` 4s hard cap (`startup.ts:496`).

## 10. How to Add a Command (1:1 fmbot)

1. **Service** `src/bot/services/fooService.ts` (e.g. `TasteService`, `OverviewService`) — query `prisma`/`LastFmRepository`/`ArtworkService`.
2. **Builder** `src/bot/builders/fooBuilders.ts` — `static buildXResponse(): ResponseModel` (embed vs `ContainerBuilder`).
3. **Slash** `src/bot/slashCommands/fooSlashCommands.ts` — `new SlashCommandBuilder().setName('foo').addStringOption(...setAutocomplete(true))` + `executeAsync` (`SettingService.getTimePeriod` + `UserService` mention/`lfm:` + builder).
4. **Text** `src/bot/textCommands/lastfm/fooCommands.ts` — `name: 'foo', aliases: ['f']` + `parseArgs` + same builder.
5. **Interaction** `src/bot/interactions/fooInteractions.ts` if buttons/selects/modals (`preview:`, `top:jump:`).
6. **Wire** `src/bot/startup.ts:110` imports + `new FooService(...)` + `registerInstance` + `src/bot/slashCommands/index.ts:17` + `src/bot/textCommands/index.ts:16` + `src/bot/handlers/interactionHandler.ts:28` route.
7. **Verify** `npm run build` + `npm test` + manual `npm run dev` slash `+o`/`ta` paginator + `#` modal `1-31`.

## 11. Skill: tvbot

When you work on tvbot, you are `Muse Spark` with tvbot skill loaded. Follow `tvbot.md` §10, use `file:line` refs, verify via execution, keep `artworkService` primary, `ENABLE_LAVALINK=false` in dev, and update this file after major pillars.

**Invocation:** User says `build X` → read `tvbot.md` + `plan-*.md` + `schema.prisma` + `startup.ts`, then scaffold service→builder→commands→interactions→DI in one turn, marking `TodoWrite` progress, verifying `build`.

---

### File Reference (full list `src/**/*.ts` 180+ files)
See `src/bot/startup.ts` for complete DI graph. Key files: `updateService.ts`, `indexService.ts`, `artworkService.ts`, `chartService.ts`, `whoKnowsService.ts`, `crownService.ts`, `overviewService.ts`, `artistTrackService.ts`, `essentiaService.ts`, `previewResolverService.ts`, `voiceMessageService.ts`, `moonlinkManager.ts`, `puppeteerService.ts`, `playBuilders.ts`, `whoKnowsBuilders.ts`, `topBuilders.ts`, `overviewBuilders.ts`, `trackDetailsBuilders.ts`.
