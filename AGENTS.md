# tvbot — AI Assistant Instructions & Workspace Rules

> **MANDATORY CONTEXT: This file is automatically loaded on every turn.**
> You are the dedicated core engineer on **tvbot**, a private, unlimited Discord bot mirroring `fmbot` for Last.fm stats and Lavalink music.
> You do not need to ask the user what the bot is or how it works. Read this document and [tvbot.md](file:///home/moha/Desktop/tvbot/tvbot.md) for full context.

---

## 1. Project Overview & Technology Stack
- **Name**: `tvbot`
- **Purpose**: Full-featured Discord music statistics and audio bot mirroring `fmbot-dev` without rate-limits.
- **Stack**:
  - **Runtime**: Node.js 22 LTS (managed via `fnm` on Arch Linux) + TypeScript 5.7
  - **Discord**: `discord.js` v14.18 (Gateway Intents, Interactions, Voice Message Flags `8192`)
  - **Persistence**: Prisma ORM 6.5 + PostgreSQL (Hosted on Neon serverless)
  - **DI Container**: `tsyringe` manual singleton registration in [startup.ts](file:///home/moha/Desktop/tvbot/src/bot/startup.ts)
  - **Cache**: `ioredis` with automatic in-memory LRU fallback in [cacheService.ts](file:///home/moha/Desktop/tvbot/src/bot/services/cacheService.ts)
  - **Music & Audio**: `moonlink.js` v5 (Lavalink v4 nodes with auto-failover) + `fluent-ffmpeg` / `/usr/bin/ffmpeg` + `essentia.js` WASM DSP (BPM & Key detection)
  - **Graphics**: `puppeteer` 25.9 (ephemeral headless Chrome in dev, persistent in prod) for chart collages (`3x3`, `5x5`, etc.)

---

## 2. Golden Architectural Rules
1. **Dependency Injection**:
   - Every service, repository, command handler, and interaction listener is manually instantiated and registered in `src/bot/startup.ts:configureContainer()`.
   - Never rely on hidden reflection decorators or implicit bindings.
2. **Artwork Resolution**:
   - **Never trust Last.fm's `imageUrl` directly** — it frequently returns the `2a96cbd8b46e442fc41c2b86b821562f` missing image placeholder.
   - Always resolve covers through `ArtworkService` (`Spotify Search API → Deezer API → Apple Music API → Last.fm API`, cached 3600s).
3. **Dual-Mode Commands**:
   - Every command exists both as a Slash command (`src/bot/slashCommands/`) and a text command with prefix `.` (`src/bot/textCommands/`).
   - Both delegate to a common `src/bot/builders/*Builders.ts` which returns a unified `ResponseModel`.
4. **Environment & Lavalink**:
   - In dev (`ENVIRONMENT=local`), `ENABLE_LAVALINK=false` by default to avoid burning public node rate-limits on rapid code reloads.
   - Puppeteer runs in ephemeral mode in dev (no `.puppeteer` directory lock conflicts).
5. **Verification**:
   - Always run `npm run build` and `npm test` after modifying code. All 58 test suites (398 tests) must pass.

---

## 3. Key Directory Map
- `src/bot/startup.ts`: Main application dependency graph and bootstrap.
- `src/bot/configurations/`: Environment validation (`configData.ts`, `envValidator.ts`).
- `src/bot/handlers/`: Discord event dispatchers (`interactionHandler.ts`, `commandHandler.ts`, `musicHandler.ts`).
- `src/bot/services/`: Core logic:
  - `updateService.ts` & `indexService.ts`: Last.fm library synchronization and 1000-page historical indexing.
  - `artworkService.ts`: Multi-source artwork cascade.
  - `whoKnows/`: Guild listener leaderboards (`whoKnowsArtistService.ts`, `whoKnowsAlbumService.ts`, `whoKnowsTrackService.ts`).
  - `crown/crownService.ts`: Crown claiming, stealing, guild seeding, and moderation.
  - `autopostService.ts`: Scheduled recurring leaderboard postings.
  - `audio/`: `essentiaService.ts` (BPM/Key), `previewResolverService.ts` (previews), `voiceMessageService.ts` (Discord voice notes).
  - `music/`: `moonlinkManager.ts` (Lavalink node failover) and `musicService.ts`.
- `src/bot/builders/`: Factory classes constructing embeds, action rows, and interactive buttons (`playBuilders.ts`, `whoKnowsBuilders.ts`, `topBuilders.ts`, `chartBuilders.ts`, etc.).
- `src/bot/interactions/`: Handlers for Discord buttons, select menus, and modals (`nowPlayingInteractions.ts`, `userSettingsInteractions.ts`, `topInteractions.ts`, etc.).
- `src/persistence/`: Prisma schema (`prisma/schema.prisma`) and repository classes (`userRepository.ts`, `playRepository.ts`, `crownRepository.ts`, `autopostRepository.ts`, etc.).
- `src/domain/`: Pure domain interfaces, enums (`commandResponse.ts`, `fmEmbedType.ts`, `coverType.ts`, `responseMode.ts`), and logger.

---

## 4. Workflows & Runbooks
- **Adding a Command (1:1 from fmbot)**:
  1. Check `fmbot-dev` reference implementation.
  2. Implement service method in `src/bot/services/`.
  3. Create response in `src/bot/builders/*Builders.ts`.
  4. Create slash command in `src/bot/slashCommands/` and text command in `src/bot/textCommands/`.
  5. If interactive, add handler in `src/bot/interactions/` and route in `src/bot/handlers/interactionHandler.ts`.
  6. Register in `src/bot/startup.ts` and exports.
  7. Run `npm run build && npm test`.
- **Database Migrations**:
  - Edit `src/persistence/prisma/schema.prisma`.
  - Run `npm run db:generate`.
  - For Neon cloud PostgreSQL, verify with `npx prisma migrate status`.
