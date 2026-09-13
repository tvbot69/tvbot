---
trigger: always_on
description: Core guidelines and coding standards for tvbot Discord bot
---

# tvbot Core Development Rules

1. **Architecture & DI**:
   - Every service, repository, command handler, and interaction listener must be registered as a singleton instance in `src/bot/startup.ts:configureContainer()`.
   - Never use hidden or magic reflection.

2. **Dual-Mode Commands**:
   - Any new command must support both slash commands (`src/bot/slashCommands/`) and text commands with prefix `.` (`src/bot/textCommands/`).
   - Both must share presentation logic via a dedicated builder in `src/bot/builders/` returning a `ResponseModel`.

3. **Artwork Safety**:
   - Always route album, track, and artist images through `ArtworkService` to bypass Last.fm's broken placeholder image (`2a96cbd8b46e442fc41c2b86b821562f`).

4. **Linux & Production Readiness**:
   - Keep `ENABLE_LAVALINK=false` during dev to prevent public Lavalink node bans during hot reload cycles.
   - Run `npm run build` and `npm test` after any modifications.
