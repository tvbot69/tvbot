# tvbot — AI Assistant Instructions & Workspace Rules

> **MANDATORY CONTEXT: this file is loaded on every turn.**
> You are the dedicated core engineer on **tvbot**, a private unlimited Discord bot mirroring `fmbot` for Last.fm stats and Lavalink music. You do not need to ask what the bot is. This file plus the `tvbot` and `tvbot-reference` skills (`.opencode/skills/`) are the only AI-instruction files in the repo. Keep it that way — duplicated handbooks drift and then actively mislead.

Paths below are **repo-relative**. Do not write absolute `file://` URLs — they break on any machine that isn't the author's.

---

## 1. Project Overview & Technology Stack
- **Name**: `tvbot`
- **Purpose**: Full-featured Discord music + Last.fm statistics bot mirroring `fmbot-dev`, without rate limits.
- **Stack**:
  - **Runtime**: Node.js 22 LTS + TypeScript 5.7 (ES2022 target, `useDefineForClassFields: true`)
  - **Discord**: `discord.js` v14.18 (Gateway Intents, Interactions, Voice Message Flags `8192`)
  - **Persistence**: Prisma 6.5 + PostgreSQL (Railway)
  - **DI**: `tsyringe`, **manual singleton registration** in `src/bot/startup.ts`
  - **Cache**: `ioredis` with automatic in-memory LRU fallback (`src/bot/services/cacheService.ts`)
  - **Music**: `moonlink.js` v5 (Lavalink v4, auto-failover) + `fluent-ffmpeg` + `essentia.js` WASM (BPM/key)
  - **Graphics**: `puppeteer` 25.9 (ephemeral in dev, persistent in prod) for chart collages
- **Scale**: ~470 TypeScript files, ~82k lines. Commands are dual-mode: ~146 slash entries and ~570 text triggers over shared builders.

---

## 2. Verification Gates (non-negotiable, in this order)
1. `npm run build` — must be clean. A failed build means the task is **not** done.
2. `npm test` — all suites green. Never weaken or delete a test to make something pass unless the user approves it.
3. Commit only files the task touched (`git add <specific paths>`). Never `git add -A`.
4. Push **only** when asked.

Current baseline: **236 test files / 4013 unit passing + 516 db skipped = 4529** (the db suite skips
locally: no Docker, no local Postgres, and `DATABASE_URL` is production Railway). If the numbers in
this file drift from reality, the file is wrong — check `npm test` output and fix the number here.

`npm test` does not typecheck. Always run `npm run build` too — otherwise a bad constructor arity passes vitest and breaks the build. It is not a hypothetical: writing the log monitor, the suite reported 1212/1212 green while `tsc` rejected three lines. CI (`.github/workflows/ci.yml`) runs the build first and blocking for exactly this reason, and the lint job is now blocking too — `npm run lint` must stay at **0 errors** (731 warnings is the accepted baseline; warnings do not fail a build).

**Run it**: `npm install` → `npm run db:generate` → `npm run dev` (tsx watch, ephemeral Puppeteer, Lavalink off). Production is `npm run build` then `npm start`.

---

## 3. Golden Architectural Rules

1. **Dependency injection is manual.** Every service, repository, command handler and interaction listener is constructed by hand and registered in `src/bot/startup.ts`. Never rely on reflection or implicit bindings. Positional constructor calls in `startup.ts` are load-bearing — reordering a constructor is a breaking change.

2. **Never trust Last.fm's `imageUrl`.** It frequently returns the placeholder `2a96cbd8b46e442fc41c2b86b821562f`. All artwork goes through `ArtworkService` (Spotify → Deezer → Apple → Last.fm). The placeholder check lives in exactly one predicate, `isPlaceholderImageUrl`, in `src/domain/lastfmPlaceholder.ts` (re-exported from `artworkService` for the ~20 existing call sites) — call it, never re-inline the hash. It lives in `domain`, not `bot/services`, so lower layers can ask the question without importing the artwork cascade.

3. **Artwork title matching must survive real catalogue shapes.** Matching is deliberately strict (never substring — `"Song"` must not match `"Song 2"`), and it must tolerate a **leading date prefix**, because DJ-pool and compilation rips are often the *only* thing a provider returns: Mac DeMarco's "I Like Her" comes back as `20191009 I Like Her` on "Cottage Core"-style albums. Without the prefix strip, correct-artist/right-recording rows get rejected and the card holds the previous cover forever. See `matchesTrackTitle` in `artworkService.ts` and `artworkService.datePrefix.test.ts`.

4. **Dual-mode commands.** Every command exists as a slash command (`src/bot/slashCommands/`) *and* a text command (`src/bot/textCommands/`, prefix `.`). Both delegate to a shared `src/bot/builders/*Builders.ts` returning a `ResponseModel`. **Command names must be globally unique across both families** — the registry logs a collision and silently lets the later registration win, making the other unreachable. This has already bitten `.remove` (account unlink vs queue remove) and `.lyrics`.

5. **YouTube ids are exactly 11 chars.** Gate every outbound id with `/^[\w-]{11}$/`.

6. **Chapter/artwork state is only decoration.** Chapter logic must never break playback, and must never trip the audio resolver's pause/alert machinery.

7. **Environment**: in dev (`ENVIRONMENT=local`) `ENABLE_LAVALINK=false` by default, to avoid burning public node rate limits on reload.
8. **Delete scrapped approaches completely.** No flags, no legacy rungs, no commented-out remnants of a removed feature — unless the user explicitly asks to keep a path behind a flag. Piped chapters and fake-Spotify presence were both fully deleted.
9. **Type-only imports across music modules** (`import type { X } from './ytResolver'`) — this is what keeps the playback DAG acyclic. A value import there closes a cycle.
10. **`Logger.debug` for internal degradation paths.** The user reads Railway logs, and INFO-level noise hides the lines that matter. An expected-but-notable outcome is DEBUG; a lost capability is WARN.

---

## 4. Playback Architecture

The music module is a **strict DAG**. Nothing below imports `MusicService` back.

```
musicTypes.ts          leaf interfaces + ports (PendingEntry, PlayerProvider,
                       QueueInfoProvider, PendingQueueView) — imports NOTHING
                       from the music module, which is what keeps the DAG acyclic
  ├── musicNodeHealth.ts    isNodeCooling / hasHealthyNode (tolerant of test doubles)
  ├── musicTrackArtwork.ts  isYoutubeThumb, preCleanArtwork, sanitizeOverride,
  │                         leadArtist, MusicTrackArtwork (backfill + warmup)
  ├── musicTrackAdoption.ts adoptMirrorTrack (pure function)
  ├── musicPlayerRegistry.ts PlayerRegistry + FILTER_DEFINITIONS
  ├── musicSearchLadder.ts   ISRC-first, title, plugin/resolver/soundcloud rungs
  ├── musicPlaybackControls.ts pause/resume/seek/previous/volume/filters/loop/24-7
  └── musicService.ts        composition root — the ONLY registered token
```

**Play path**: `play()` routes by input kind → `MusicSearchLadder` (Home yt-dlp resolver → SoundCloud) → `MoonlinkManager` (node failover) → `enqueueLavalinkTracks` (the single enqueue choke point). Unresolved playlist entries sit in a **just-in-time pending queue** resolved 2 tracks ahead.

**Chapters** (`>20 min` videos only): description timestamps via one Data API call (`descriptionChapters.ts`), parsed and cached. `chapterCardFor` derives the displayed card; `resolveChapterArt` races an 8s cascade with a 30s retry; `swapChapterOnSeek` handles explicit seeks.

**Card publishing**: `musicHandler.publishProgress` on a 5s tick with a fingerprint dirty-check, plus `scheduleImmediateProgress` (300ms debounce) for event-driven edits.

### 4.1 Invariants that broke in production — do not regress these
- **`shuffle` and `remove` mutate the pending array in place.** The pending store must hand back the **live** array, never a copy. A copying port silently turns both into no-ops while every assertion still passes. `pendingStoreIdentity.test.ts` locks this.
- **A position that moves BACKWARDS is stale data, not a rewind.** There is a guard for implausible forward jumps (drifting node clock); a backward read with no recorded seek intent must be refused, or the card snaps back to chapter 0. A real backward seek carries `lastUserSeekAt`/`lastUserSeekPos`, recorded by `seek()` *before* it awaits the node.
- **Deliberate seeks must not pay the settle window.** The implausible-jump guard exists for clock drift, not for listeners.
- **`trackStart` must derive the chapter from the real position**, never a hardcoded `0`.
- **A chapter whose art genuinely cannot be found holds the previous cover.** That is intentional (it beats flashing the wrong image), but it is why a catalogue miss reads as "art is broken". Fix the matching, not the hold.
- **Timeout→node-cooldown is load-bearing.** A search timeout must keep cooling the node; that behaviour came from a real uplink-stall incident. Only the collateral migration damage was softened.
- **The Redis FIFO warning is expected.** Write-then-trim ordering is consistent and failure replay is intentional. Do not "fix" it.

---

## 5. Testing Contracts (violating these breaks the suite)

- **Never add constructor parameters to `MusicHandler`.** Tests build it positionally with 3 args: `new MusicHandler(client, {getManager}, {getQueueInfo, is247})`. Extract collaborators by constructing them *inside* the existing constructor body, or as free functions taking deps as arguments.
- **Never add constructor parameters to `MusicService`** either — 20 test call sites build it positionally with 3–5 args. Keep the signature and add collaborators internally.
- **Tests reach privates via `as unknown as {...}` casts and replace methods/spies on the instance.** Therefore:
  - Any extracted member must still be reachable on the original object (delegate, not removal).
  - Every cross-cluster call must go **through the host instance** (`this.publishProgress(...)`), never a sibling collaborator, or `vi.spyOn` / own-property shadowing stops working.
  - Services that tests **reassign after construction** (`artworkService`, `colorService`) must be read **live through the host**, never captured by value into a collaborator.
- **State Maps that tests read must stay owned by the host and be passed in by reference.** A copied Map breaks both the tests and `forgetGuild` sweeps.
- `musicHandler` static helpers are read off the *class* in tests; keep static delegates.
- Network: `vi.spyOn(globalThis, 'fetch')`. Module-level Maps persist within a test file — use a distinct 11-char id per test.
- `reflect-metadata` must be the first import in any test that touches a `tsyringe` module.

---

## 6. Refactoring This Codebase

**The facade pattern is the tool that works here.** Extract behaviour, keep the public surface as one-line delegates on the original class, and the registered token plus every existing call site keep compiling. This is how `musicService` went 2317 → ~1240 lines with **zero changes to any pre-existing test**.

- Prefer **pure function modules** (no state, no timers) — those are free to move.
- Prefer **collaborators constructed inside an existing constructor** over new DI wiring.
- Introduce a **port interface in a leaf module** when two modules need the same capability; that is what prevents import cycles.
- **Do not split for the sake of line count.** `moonlinkManager` (679 lines), `interactionHandler` (a routing table), `musicBuilders` (independent cards) and `playRepository` (one per-user aggregate) are all long *and* cohesive; splitting them raises fan-in and makes the code harder to work in, not easier.
- **Do not deduplicate the slash/text command layer wholesale.** The shared response layer (`src/bot/builders/`) is already single-copy and tested. What remains duplicated is argument parsing, and the two argument models are genuinely different (typed Discord options vs hand-written string grammars like `seek 1:40`, `lfm:user`, `filters clear`). 13 of 33 pairs are under 50% overlap and would need bespoke specs. Fix concrete drift instead.
- **Verify dead code before deleting it**: grep for both production *and* test references, and check whether the "caller" is itself reachable (a stub returning `null` makes its caller's branch dead code).

---

## 7. Key Directory Map
- `src/bot/startup.ts` — the dependency graph. Read it first when tracing wiring.
- `src/bot/handlers/` — event dispatchers (`interactionHandler.ts`, `commandHandler.ts`, `musicHandler.ts`).
- `src/bot/services/music/` — playback (see §4).
- `src/bot/services/artworkService.ts` — the artwork cascade and title/artist matching rules.
- `src/bot/services/whoKnows/`, `crown/`, `audio/` — leaderboards, crowns, audio analysis.
- `src/bot/builders/` — embed/action-row factories returning `ResponseModel`.
- `src/bot/interactions/` — buttons, select menus, modals.
- `src/persistence/` — Prisma schema and repositories.
- `src/domain/` — pure interfaces, enums, logger.

---

## 8. Workflows

**Adding a command (1:1 from fmbot)**
1. Check the `fmbot-dev` reference implementation.
2. Service method in `src/bot/services/`.
3. Response in `src/bot/builders/*Builders.ts`.
4. Slash **and** text command (check the name is unique across both — §3.4).
5. If interactive: handler in `src/bot/interactions/` + route in `handlers/interactionHandler.ts`.
6. Register in `src/bot/startup.ts`.
7. `npm run build && npm test`.

**Database migrations**
1. Edit `src/persistence/prisma/schema.prisma`.
2. `npm run db:generate`.
3. Verify with `npx prisma migrate status`.

**Before reporting success**
State what was *verified* and what was *not*. A green suite is necessary, not sufficient: voice connection, audio throughput, FFmpeg and real Discord behaviour are not covered by any test. Say so plainly rather than implying everything works.

---

## 9-11. Incident reference - moved to the 	vbot-reference skill

The symptom-to-log-line runbook, the known failure modes and scar tissue, and
the test-gap analysis are now in .opencode/skills/tvbot-reference/SKILL.md.
**Load that skill** when debugging, when a number looks wrong, when a migration
or a Prisma query is involved, or when a test passes and you suspect it proves
nothing. It is a verbatim extract, so nothing was lost.

They were ~3,300 tokens on every single turn, for material that matters on
perhaps one turn in ten. Same knowledge, fetched on demand.
## 12. Environment variables

`src/bot/configurations/envValidator.ts` validates these at boot; `.env.example` is the reference copy.

| Variable | Used for |
|---|---|
| `DISCORD_TOKEN` | Bot authentication. Nothing works without it. |
| `DATABASE_URL` | Railway PostgreSQL connection string. |
| `REDIS_URL` | `redis://localhost:6379`. `CacheService` falls back to an in-memory LRU if Redis is down — it does not fail. |
| `LASTFM_API_KEY` / `LASTFM_API_SECRET` | Every Last.fm read: scrobbles, library, top lists, who-knows. |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Search + cover art. **Client-credentials scope only — see §10 for what that cannot do.** |
| `GENIUS_CLIENT_ID` / `GENIUS_CLIENT_SECRET` | Lyrics lookup. |
| `YOUTUBE_API_KEY` | Chapter timestamps via one `videos.list?part=snippet` call. |
| `HOME_RESOLVER_URL` / `HOME_RESOLVER_TOKEN` | The user PC's yt-dlp resolver. The first rung of the search ladder. |
| `HOME_LADDER_MODE` | Which rungs the ladder is allowed to use. |
| `AUDD_API_TOKEN`, `DISCOGS_KEY` / `DISCOGS_SECRET` | Song recognition and last-resort search. |
| `ENABLE_LAVALINK` | `false` in dev, `true` in prod. |
| `FFMPEG_PATH` | System ffmpeg/ffprobe, used for previews, voice messages and BPM/key analysis. |
| `STAGING_CHANNEL_ID` | Scratch channel for temporary chart uploads. |

---

## 13. Subsystem map

Where each pillar of the bot actually lives. Read the file before editing it.

- **DI container** — `src/bot/startup.ts:configureContainer()`. The entire graph is constructed by hand and registered with `container.registerInstance`. No reflection.
- **Command framework** — `ContextModel` (`src/bot/models/contextModel.ts`) normalises a `Message`, a `ChatInputCommandInteraction` and a `ButtonInteraction` behind one API. Builders return a `ResponseModel` (embeds, buttons, or Components V2 containers).
- **Persistence** — `src/persistence/prisma/schema.prisma`. `UserPlay` is the indexed scrobble history; `Artist`/`Album`/`Track` are cached metadata; `UserArtist`/`UserAlbum`/`UserTrack` are per-user denormalised rollups all keyed `(userId, <id>)`; `UserCrown` tracks guild crown holders; `GuildAutopost` holds scheduled-post config.
- **Last.fm sync** — `updateService.ts` (delta sync, 3h overlap, 14-day fallback, backoff `500/2500/5000/10000/25000ms`), `indexService.ts` (full history, up to 1000 pages, batch commits every 10), `timerService.ts` (cron).
- **Artwork engine** — `artworkService.ts`. Memory + Redis cache (1h positive / 10min definitive-none / 90s inconclusive), then a DB row if fresher than 90 days, then the cascade Spotify → Deezer → Apple → Last.fm, then persist. See §3.2 and §3.3.
- **Social intelligence** — `src/bot/services/whoKnows/`. Ranks top listeners per artist/album/track from indexed plays plus a live Last.fm count, respecting `privacy_level`, guild bans and `self_block_from_who_knows`.
- **Crowns** — `src/bot/services/crown/crownService.ts`. Claim/steal with a play threshold, dynamic re-evaluation against live scrobbles, bulk seeding, moderation.
- **Autoposts** — `src/bot/services/autopostService.ts`. Scheduled leaderboard/crown posts on a 15-minute cron sweep.
- **OAuth actions** — `.love`/`.unlove`/`.scrobble` live in the track command modules and now-playing interactions, and use the user's `session_key`.
- **Audio analysis** — `src/bot/services/audio/`: `previewResolverService` (30s previews), `audioSignalService` (ffmpeg → PCM), `essentiaService` (WASM BPM + key), `voiceMessageService` (Opus OGG with `flags: 8192` and a base64 waveform).
