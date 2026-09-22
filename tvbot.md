# tvbot — AI Master Handbook
> **Single source of truth for any AI (new chat, new model, fresh session) to work on tvbot instantly. Read this file first, then act. No forgetting.**

`tvbot` is a **private, unlimited** Discord bot mirroring `fmbot-dev` for a closed friend group. Two main pillars: **Last.fm statistics & social music intelligence** (`/fm`, `wk`, `chart`, `at`, `overview`, `top*`, `taste`, `crown`, `autopost`, `settings`) + **Lavalink music playback & audio analysis** (`Moonlink.js v5` + `Spotify/YouTube` + `Essentia DSP/WASM` for BPM/key/voice messages). 

Stack: `TypeScript + Node 22 (fnm) + discord.js 14 + Prisma 6 (Railway PostgreSQL) + tsyringe DI + ioredis (with in-memory fallback) + Puppeteer (Headless Chrome) + fluent-ffmpeg`.

---

## 0. Golden Rules for AI Working Here
1. **Never guess or ask basic questions**: This document, `src/bot/startup.ts`, and `src/persistence/prisma/schema.prisma` contain the complete architectural reality.
2. **Reference files as `path:line`** (e.g. `src/bot/startup.ts:103`).
3. **Verify via execution**: Run `npm run build` and `npm test` after any feature or modification.
4. **Artwork Rule**: Never use Last.fm `imageUrl` directly (it frequently returns the `2a96cb...` placeholder). Always route through `ArtworkService` (`Spotify → Deezer → Apple Music → Last.fm`, cached 3600s).
5. **DI Rule**: No hidden magic decorators. Everything is manually instantiated and registered in `src/bot/startup.ts` using `tsyringe.registerInstance`.
6. **Dev vs Prod**:
   - `ENVIRONMENT=local`: `ENABLE_LAVALINK=false` by default (prevents public Lavalink rate-limits during hot reloads). Puppeteer runs in ephemeral mode (no `.puppeteer` profile lock).
   - Redis: Remote or local `redis://localhost:6379`. If Redis is offline, `CacheService` seamlessly falls back to in-memory LRU without failing.

---

## 1. Quick Start & Environment (Arch Linux)
```bash
# Node & Dependencies
npm install
npm run db:generate    # Prisma Client generation for Linux
npm run build          # tsc + tsc-alias + copy-assets
npm test               # vitest run (58 test files, 398 tests)

# Running
npm run dev            # tsx watch src/bot/index.ts (ephemeral Puppeteer, Lavalink disabled)
npm start              # node dist/bot/index.js (production build)
```

### Environment Variables (`.env`)
- **Required**:
  - `DISCORD_TOKEN`: Discord bot authentication token.
  - `DATABASE_URL`: PostgreSQL connection string (Hosted on Railway PostgreSQL).
  - `LASTFM_API_KEY` & `LASTFM_API_SECRET`: Last.fm API credentials.
- **Integrations & Audio**:
  - `SPOTIFY_CLIENT_ID` & `SPOTIFY_CLIENT_SECRET`: Metadata & cover art resolution.
  - `GENIUS_CLIENT_*`: Lyrics integration.
  - `AUDD_API_TOKEN`, `YOUTUBE_API_KEY`, `DISCOGS_KEY/SECRET`: Music recognition and fallback searches.
  - `STAGING_CHANNEL_ID`: Discord channel for temporary chart uploads.
  - `REDIS_URL`: `redis://localhost:6379` (falls back to memory if down).
  - `ENABLE_LAVALINK`: `false` in dev, `true` in prod / when testing music.
  - `FFMPEG_PATH`: Uses system `/usr/bin/ffmpeg` and `/usr/bin/ffprobe` on Arch Linux.

---

## 2. Architecture & Subsystems

### A. DI Container & Startup (`src/bot/startup.ts`)
The entire application graph is wired in `src/bot/startup.ts:configureContainer()`.
Every repository, service, command handler, and interaction listener is instantiated and registered as a singleton instance via `container.registerInstance(Class, instance)`.
When adding a new feature:
1. Implement the repository / service.
2. Instantiate and register it in `startup.ts`.
3. Register commands in `src/bot/slashCommands/index.ts` and `src/bot/textCommands/index.ts`.
4. Route interactions in `src/bot/handlers/interactionHandler.ts`.

### B. Command Framework (Dual-Mode: Slash + Text)
- **Prefix**: Defaults to `.` (e.g., `.fm`, `.wk`, `.chart`, `.ta`, `.tt`, `.at`, `.o`, `.crown`).
- **Slash**: Mirror of text commands registered globally on Discord.
- **Unified Context**: `ContextModel` (`src/bot/models/contextModel.ts`) normalizes `Message` (text) and `ChatInputCommandInteraction` / `ButtonInteraction` into a single API (`context.reply()`, `context.userId`, `context.guildId`, `context.options`).
- **Response Format**: Builders return `ResponseModel` (`src/bot/models/responseModel.ts`) containing embeds, buttons, select menus, or Discord Components V2 containers.

### C. Database & Prisma (`src/persistence/`)
PostgreSQL managed via Prisma (`src/persistence/prisma/schema.prisma`):
- `User`: Discord ID, Last.fm username, session key (for scrobble/love OAuth actions), privacy levels, mode, cover type, who knows mode.
- `UserFmSetting`: Custom embed types (Mini, Full, Tiny, Text), footer flags (28 bitwise flags), button settings, custom colors.
- `Guild`, `GuildUser`, `Channel`: Guild configuration, whitelisting, crown blocks, self-block from who-knows (`self_block_from_who_knows`), toggled commands.
- `UserPlay`: Indexed user scrobble history with composite index on `(user_id, time_played)`.
- `Artist`, `Album`, `Track`, `ArtistGenre`: Cached metadata and cover URLs.
- `UserCrown`: Tracks active server crown holders per artist with minimum play thresholds.
- `GuildAutopost`: Configuration for scheduled recurring chart / crown posts.

### D. Last.fm Synchronization (`src/bot/services/`)
- `updateService.ts`: Delta sync with 3-hour overlap window, 14-day fallback, exponential retry backoff (`500, 2500, 5000, 10000, 25000 ms`), deduplication on `timePlayed`, incremental top list updates.
- `indexService.ts`: Full historical library indexing across up to 1,000 pages (1,000,000 tracks) with batch commits every 10 pages.
- `timerService.ts`: Background cron runner for sync queues, cleanup, autoposts, and index jobs.

### E. Artwork Engine (`src/bot/services/artworkService.ts`)
Single source of truth for all artwork across the bot:
1. Checks memory & Redis cache (`art:*`, 3600s TTL).
2. Checks DB cache (`artists.image_url`, `albums.image_url`, `tracks.image_url`) if fresher than 90 days.
3. Fallback cascade: **Spotify Search API → Deezer API → Apple Music API → Last.fm API**.
4. Filters out Last.fm's missing artwork placeholder hash (`2a96cbd8b46e442fc41c2b86b821562f`).
5. Persists resolved artwork back to DB and cache.

### F. Social Intelligence & WhoKnows (`src/bot/services/whoKnows/`)
- `whoKnowsArtistService.ts`, `whoKnowsAlbumService.ts`, `whoKnowsTrackService.ts`: Computes rankings of top listeners within the guild.
- Queries indexed local database plays + fetches live caller play count from Last.fm to ensure real-time accuracy.
- Respects `privacy_level`, guild bans, and user `self_block_from_who_knows`.
- Embed footer displays listeners, total plays, and average plays.

### G. Crown System (`src/bot/services/crown/crownService.ts`)
- Allows members to claim or steal the "Crown" for an artist within a Discord guild (default threshold: 30 plays).
- Evaluates crown stealing dynamically against live Last.fm scrobble counts and guild members' local plays.
- Supports guild seeding (`SeedCrownsForGuild`) to populate all active crowns in bulk from user scrobble data.
- Includes moderation commands: block user from crowns, reset crowns, set minimum play thresholds.

### H. Autopost System (`src/bot/services/autopostService.ts`)
- Automatically schedules and posts leaderboard charts or crown summaries to designated channels.
- Supports `Daily`, `Weekly`, and `Monthly` intervals for `TopArtists`, `TopAlbums`, `TopTracks`, and `ServerCrowns`.
- Managed through `.autopost add/remove/list/toggle` commands and runs on a 15-minute cron sweep.

### I. User Settings & OAuth Actions
- `src/bot/interactions/userSettingsInteractions.ts`: Interactive menus for configuring embed style, cover art priority, response mode, and footer display options.
- OAuth Actions (`src/bot/textCommands/lastfm/trackCommands.ts` & `nowPlayingInteractions.ts`):
  - `.love` / `/love`: Loves the currently playing or specified track on Last.fm.
  - `.unlove` / `/unlove`: Removes love status.
  - `.scrobble`: Manually scrobbles a track to Last.fm.
  - Uses the authenticated user's `session_key`.

### J. Audio Analysis & Voice Previews (`src/bot/services/audio/`)
- `previewResolverService.ts`: Extracts 30-second audio previews (Spotify scraper `__NEXT_DATA__` first, fallback Deezer/Apple Music).
- `audioSignalService.ts`: Decodes MP3/M4A to PCM `Float32Array` using `/usr/bin/ffmpeg`.
- `essentiaService.ts`: Runs WASM Essentia DSP (`RhythmExtractor2013` and `KeyExtractor`) to detect BPM and musical key.
- `voiceMessageService.ts`: Converts audio to Opus OGG and uploads as Discord native voice messages (`flags: 8192` with 100-byte base64 waveform).

### K. Music & Lavalink (`src/bot/services/music/`)
- `moonlinkManager.ts`: Manages Lavalink v4 nodes (Serenetia, AjieBlogs, Jirayu, MilloHost).
- Automatic failover: Detects node disconnection, switches active players without dropping streams, and applies temporary cooldowns to unstable nodes.
- In development (`ENVIRONMENT=local`), Lavalink connections are disabled by default unless `ENABLE_LAVALINK=true` is set.

### L. Image Generation & Puppeteer (`src/images/`)
- Generates high-resolution collage charts (`3x3`, `5x5`, `10x10`, etc.) using Puppeteer and HTML/CSS templates.
- In dev: Uses ephemeral browser instances to prevent Chrome process locks.
- In prod: Uses persistent browser profile with preheating for sub-second chart rendering.
- Uploads images to Discord directly or via `ImageUploadService` in the staging channel.

---

## 3. Workflow: Adding a New Feature (1:1 fmbot Mirror)
When adding or modifying a feature:
1. **Locate fmbot counterpart**: Check `fmbot-dev` (`FMBot.Bot/TextCommands/`, `Builders/`, `Services/`).
2. **Service**: Create or extend `src/bot/services/fooService.ts`.
3. **Builder**: Create `src/bot/builders/fooBuilders.ts` returning `ResponseModel`.
4. **Commands**:
   - Slash: `src/bot/slashCommands/fooSlashCommands.ts`
   - Text: `src/bot/textCommands/lastfm/fooCommands.ts` (with aliases and `.prefix` parsing)
5. **Interactions**: If buttons/menus/modals are used, add `src/bot/interactions/fooInteractions.ts` and link in `src/bot/handlers/interactionHandler.ts`.
6. **Register in DI**: Add to `src/bot/startup.ts`, export in `slashCommands/index.ts` and `textCommands/index.ts`.
7. **Verification**: Run `npm run build` and `npm test` to guarantee 100% build and test pass rate.
