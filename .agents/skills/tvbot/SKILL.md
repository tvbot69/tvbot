---
name: tvbot
description: Comprehensive workflow and architectural guide for tvbot (Discord music stats & Lavalink bot mirroring fmbot). Load when working on tvbot, adding commands, modifying handlers, managing Last.fm sync, or debugging audio/image generators.
---

# tvbot Specialist Skill

You are the dedicated senior software architect and pair programmer on **tvbot**.
`tvbot` is a private, unlimited Discord bot mirroring `fmbot-dev` without rate-limits.

## Key Stack Reference
- **Runtime**: TypeScript + Node.js 22 LTS (via `fnm` on Arch Linux)
- **Framework**: `discord.js` v14.18, `Prisma` 6.5 (Railway PostgreSQL), `tsyringe` DI
- **External Services**: Last.fm API, Spotify Search/Scraper, Deezer API, Apple Music API, Moonlink.js v5 (Lavalink), Puppeteer (Headless Chrome), Essentia WASM DSP, system FFmpeg (`/usr/bin/ffmpeg`)
- **Master Handbook**: Always refer to `tvbot.md` and `src/bot/startup.ts`.

---

## Standard Workflows

### 1. Adding a New Command (Mirroring fmbot 1:1)
1. **Locate Reference**: Inspect the original C# code in `fmbot-dev` (`FMBot.Bot/TextCommands/`, `Builders/`, `Services/`).
2. **Service Layer**:
   - Create or extend `src/bot/services/fooService.ts`.
   - Query Prisma repositories or Last.fm APIs.
   - For any track/album/artist artwork, use `ArtworkService` (`getAlbumCoverUrl`, `getTrackCoverUrl`, `getArtistImageUrl`).
3. **Builder Layer**:
   - Create `src/bot/builders/fooBuilders.ts`.
   - Return a `ResponseModel` containing embeds, components, or Discord Components V2 containers.
4. **Slash Command**:
   - Create `src/bot/slashCommands/fooSlashCommands.ts`.
   - Define command parameters with `SlashCommandBuilder` (support time-period autocomplete via `SettingService`).
   - Register in `src/bot/slashCommands/index.ts`.
5. **Text Command**:
   - Create `src/bot/textCommands/lastfm/fooCommands.ts`.
   - Configure command name, aliases, description, and prefix argument parsing.
   - Register in `src/bot/textCommands/index.ts`.
6. **Interactions (If applicable)**:
   - Create `src/bot/interactions/fooInteractions.ts` for buttons, select menus, or modals.
   - Route custom IDs in `src/bot/handlers/interactionHandler.ts`.
7. **Wire Dependency Injection**:
   - In `src/bot/startup.ts:configureContainer()`, instantiate the new service, commands, and interaction handlers.
   - Register instances via `container.registerInstance(Class, instance)`.
8. **Verification**:
   - Run `npm run build` (ensures clean TypeScript compilation and asset copying).
   - Run `npm test` (ensures all 58 test suites pass).

---

## Architectural Rules

### Artwork Cascade
Never use `track.imageUrl` or raw Last.fm image links directly. They frequently return the generic star placeholder (`2a96cbd8b46e442fc41c2b86b821562f`). Always call:
- `ArtworkService.getAlbumCoverUrl(albumName, artistName)`
- `ArtworkService.getTrackCoverUrl(trackName, artistName)`
- `ArtworkService.getArtistImageUrl(artistName)`
Cascade order: Spotify Search → Deezer API → Apple Music API → Last.fm API (cached in Redis / memory for 3600s and DB for 90 days).

### WhoKnows & Social Stats
- Local DB indexed scrobbles (`UserPlay`) are combined with live Last.fm scrobble lookups for the calling user.
- Respect user privacy levels (`PrivacyLevel`) and guild-specific settings (`self_block_from_who_knows`, `blocked_from_crowns`, `who_knows_banned`).

### Development Environment & Lavalink
- `ENVIRONMENT=local` runs with `ENABLE_LAVALINK=false` by default to prevent node bans during hot reloads.
- Puppeteer uses ephemeral browser sessions in dev to avoid `.puppeteer` profile lock issues across `tsx watch` restarts.
- Redis falls back to an in-memory LRU cache if the Redis server is not running.
