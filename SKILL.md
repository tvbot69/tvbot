---
name: tvbot
description: Work on tvbot — private Last.fm + Lavalink Discord bot. Use when user mentions tvbot, fm, wk, chart, at, overview, crown, music, trackdetails or wants to add commands.
---

# tvbot Skill

You are the tvbot specialist. tvbot = private fmbot mirror (unlimited). Stack: TypeScript Node20 discord.js14 Prisma PostgreSQL tsyringe ioredis Moonlink v5 Puppeteer Essentia.

## Mandatory context load
1. Read `tvbot.md` fully (master handbook).
2. Read `src/bot/startup.ts` (DI graph), `src/persistence/prisma/schema.prisma` (DB), `plan*.md` if exists.
3. Reference files as `path:line`.

## Workflows

### Add command 1:1 from fmbot-dev
1. Locate fmbot `src/FMBot.Bot/TextCommands/LastFM/*Commands.cs` + `Builders/*Builders.cs` + `Services/*Service.cs`.
2. Create tvbot `src/bot/services/fooService.ts` (Prisma/LastFmRepository/ArtworkService).
3. Create `src/bot/builders/fooBuilders.ts` (ResponseModel embed or ContainerBuilder).
4. Create `src/bot/slashCommands/fooSlashCommands.ts` (SlashCommandBuilder + autocomplete for time-period via SettingService) + `src/bot/textCommands/lastfm/fooCommands.ts` (aliases).
5. If buttons/modals, create `src/bot/interactions/fooInteractions.ts` and route in `src/bot/handlers/interactionHandler.ts`.
6. Wire in `src/bot/startup.ts` (new + registerInstance), add to `src/bot/slashCommands/index.ts` + `src/bot/textCommands/index.ts`.
7. Verify `npm run build` + `npm test`.

### Artwork rule
Never use `track.imageUrl` directly if it may be Last.fm placeholder `2a96cbd8...`. Always `ArtworkService.getAlbumCoverUrl/getTrackCoverUrl/getArtistImageUrl` (Spotify→Deezer→Apple→Last.fm, 3600s cache).

### Music dev
`ENVIRONMENT=local` → `ENABLE_LAVALINK=false` (no nodes, dummy-disabled, 4s shutdown cap). For music test set `ENABLE_LAVALINK=true` and ensure `LAVALINK_NODES` or default 5 public nodes.

### Puppeteer
Dev ephemeral (no .puppeteer lock), prod persistent. Always `page.close()` and `browser.close()` with timeouts (see `src/images/generators/puppeteerService.ts:278`).

### Verification
After edits, run `npm run build` else fail. Check `npm test` (expect 1 pre-existing lavalinkConfig fail).
