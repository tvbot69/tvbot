---
name: tvbot
description: Operating manual for the tvbot Discord music/stats bot (fmbot mirror). Load for playback, Lavalink, chapters, artwork, search ladders, adding commands, handlers, tree layout and test conventions, performance, reliability, or debugging. Contains today's real module names, the tree conventions, the verification gates, and the incident-derived rules that are not obvious from the code.
---

# tvbot — Senior Engineer Operating Manual

You are the dedicated core engineer on **tvbot**, a private unlimited Discord bot mirroring `fmbot-dev` for a closed friend group. Two pillars: Last.fm statistics/social intelligence, and Lavalink music playback.

`AGENTS.md` is auto-loaded every turn and is the source of truth for the rules, the verification gates, the tree map and the subsystem map. The symptom→log-line runbook, the known failure modes and the test-gap analysis live in the **`tvbot-reference`** skill, which is loaded on demand. Read both.

**Everything below was verified against `main` at `941ed51` (the tree cleanup) and re-measured 2026-10-01. If it disagrees with the code, the code is right — and fix this file.**

---

## 1. Verification gates — non-negotiable, in this order

1. `npm run build` — must be clean. **A failed build means the task is not done.** It runs `db:generate`, `tsc`, `tsc-alias` and the asset copy.
2. `npm test` — all suites green. **Never weaken or delete a test to make something pass** unless the user approves.
3. `npm run lint` — **0 errors** (warnings do not fail the build, but the count is not free).
4. `npm run debt` — every ratchet at or under budget. A ratchet that moves up is a regression, not a note.
5. Commit only what the task touched (`git add <specific paths>`). Never `git add -A`.
6. Push **only** when asked.

**`npm test` does not typecheck.** A green suite with a bad constructor arity passes vitest and breaks `tsc`. Always run `npm run build` separately — that is not a hypothetical, it has happened five times in this repo.

Measured baseline at `941ed51`:

| Metric | Measured | Gate / budget |
|---|---|---|
| Test files (`npm test`) | **428** (411 passed + 17 skipped) | all green |
| Tests | **9,148** unit passing + **517** db skipped = **9,665** | all green |
| Real-Postgres suite (`npm run test:db`) | **519/519** | skipped unless `TEST_DATABASE_URL` is set |
| Render suite (`npm run test:render`) | **3 files, 9/9** | needs a real Chromium |
| Coverage | **91.61%** lines / **87.17%** branches / **87.71%** functions over 57,294 statements | ratchet 91.5 / 86.9 / 87.5 |
| Lint | **0 errors / 370 warnings** | 0 errors |
| `explicit-any` | **0** | 0 |
| `as-unknown-as` | **75** | budget 101 |
| `silent-failure-default` | **443** | budget 604 |
| `container-resolve-outside-root` | **154** | budget 155 |
| `prisma-client-import-in-bot` | **15** | budget 17 |

If any number here disagrees with a gate you just ran, **the gate is right and this file is stale**.

Commit style: `feat(music): …`, `fix(music): …`, `refactor(music): …`, `test(music): …`, `chore(cleanup): …`.

---

## 2. Tree conventions — one convention, no exceptions

The tree was reorganised in `941ed51` (461 files moved). **Every test lives in a `__tests__/` folder next to the code it tests. Zero test files sit beside production code.**

```
src/bot/builders/albumBuilders.ts
src/bot/builders/__tests__/albumBuilders.pagination.test.ts   <- the only shape
```

- **`src/tests/` no longer exists.** Its harness modules are in **`src/testSupport/`**: `dbHarness.ts`, `dbRawQueryObserver.ts`, `setupEnv.ts`, `uncooperativePlayer.ts`, and `repoRoot.ts` (exports `REPO_ROOT`, `SRC_ROOT`, `SCRIPTS_ROOT`, `DEBT_BUDGET_FILE`, `TSX_CLI`). Import from there.
- **Repo-wide invariant tests live in `src/__tests__/`**, not next to any one subsystem.
- **Never recreate `src/tests/`, and never colocate a test.** `src/__tests__/treeConventions.test.ts` enforces this; a colocated test fails the suite.
- `src/testSupport/**` is excluded from the coverage denominator. Moving harness code back under `src/tests/` would silently re-inflate it at 0%.
- **Moving a production file means moving its tests with it.** If the file is named in `scripts/raw-query-baseline.json`, retarget that key — an orphan key naming no file on disk is a **hard error** in `scripts/count-debt.ts`.

### Where things live

```
src/
├── __tests__/            repo-wide invariant tests
├── testSupport/          dbHarness, setupEnv, dbRawQueryObserver,
│                         uncooperativePlayer, repoRoot
├── bot/
│   ├── startup.ts        the dependency graph — read first when tracing wiring
│   ├── handlers/         interactionHandler, commandHandler, musicHandler, …
│   │   └── music/        musicHandler + the card/chapter/lifecycle cluster
│   ├── services/         32 loose domain services (artworkService, chartService, …)
│   │   ├── system/       cache, color, telemetry, healthServer, startupService,
│   │   │                 shutdownService, paginationService, componentPaginatorService,
│   │   │                 componentInteractionTracker, rateLimitService, ttlStore,
│   │   │                 abuseFilterService, settingService, fmSettingService,
│   │   │                 fmFooterResolver, genericEmbedService, imageUploadService
│   │   ├── lastfm/       indexService, updateService, timerService, reconcileService,
│   │   │                 userUpdateQueueService, userIndexQueueService
│   │   ├── music/        playback DAG (§4)
│   │   ├── audio/ crown/ guild/ whoKnows/
│   ├── builders/         40 files — embed/action-row factories returning ResponseModel
│   ├── slashCommands/    33 files (+ AGENTS.md)
│   ├── textCommands/     guild, lastfm, meta, music, thirdParty, user (+ AGENTS.md).
│   │                     helpCommands.ts and staticCommands.ts live in meta/
│   ├── interactions/     buttons, select menus, modals
│   ├── models/           ContextModel, ResponseModel, command/chart/whoKnows models
│   ├── configurations/   envValidator, configData
│   ├── diagnostics/      logInvariants.ts (npm run check:log)
│   └── autoCompleteHandlers/ resources/
├── persistence/          prisma/ (schema + client), repositories/ (19), domain/
├── lastfm/  spotify/  applemusic/  deezer/  images/
├── domain/               enums, extensions, interfaces, models, types
└── config/  types/       lavalink, runtimeEnv, musicEnv; ambient.d.ts
```

`builders/`, `interactions/`, `slashCommands/`, `handlers/` (except `handlers/music`), `domain/`, `persistence/`, `lastfm/`, `spotify/`, `applemusic/`, `deezer/` and `images/` did **not** move in the cleanup — but their tests did.

---

## 3. How to actually work here

**Read logs before theorising.** Several multi-hour bugs passed a fully green suite first and all were found by grepping log output. A green suite means the code matches the doubles — nothing more. See the **tvbot-reference** skill §9 for the symptom→log-line table; the highest-value greps are `Chapter art`, `Stale position read`, `fallback rung` and `Text command name collision`.

**Probe the real API rather than reasoning from memory.** When the cause looks like "the provider is wrong", it usually is. Run `npx tsx scripts/liveVerify.ts`, read keys from `.env`, never print them. Two of the biggest bugs here were confirmed that way in under a minute — and both contradicted what the author was confident the API would return.

**Verify dead code before deleting it.** Grep for production *and* test references, then check whether the "caller" is itself reachable. A stub returning `null` makes its caller's branch dead. This repo has real dynamic dispatch — modal handlers key on a string prefix, `ComponentInteractionTracker` on an exact `customId`, `interactionHandler` on a literal table, and `container.resolve` at runtime — so a method with no grep caller may still be reached. Name the mechanism, or say you found none.

**Delete scrapped approaches completely.** No flags, no legacy rungs, no commented-out remnants.

**Use `path:line` references** in anything you hand over. Never fabricate a result — if a check was not run, say so.

---

## 4. Playback architecture — as it is today

The music module is a **strict DAG**. Nothing below `musicService.ts` imports it back.

```
src/bot/services/music/
  musicTypes.ts            leaf ports only — imports NOTHING from the module
  musicNodeHealth.ts       isNodeCooling / hasHealthyNode (tolerant of test doubles)
  musicConstants.ts        shared timeouts and tolerances
  musicTrackArtwork.ts     isYoutubeThumb, preCleanArtwork, sanitizeOverride,
                           leadArtist + MusicTrackArtwork (backfill + warmup)
  musicTrackAdoption.ts    adoptMirrorTrack (pure)
  musicSearchLadder.ts     ISRC-first → title → plugin/resolver/soundcloud
  musicPlayerRegistry.ts   getOrCreatePlayer, destroyed guard, FILTER_DEFINITIONS
  musicPlaybackControls.ts pause/resume/seek/previous/volume/filters/loop/24-7
  musicService.ts          composition root — the ONLY registered token
  moonlinkManager.ts       node failover, cooldowns (deliberately cohesive)
  queueService.ts          persisted guild prefs, history, calculatePosition
  descriptionChapters.ts   description-timestamp parsing for >20 min videos
  videoChapters.ts  syncedLyrics.ts  lyricsService.ts
  ytResolver.ts  spotifyResolver.ts  deezerResolver.ts  appleMusicResolver.ts
  spotifyScraperService.ts  playlistChunkManager.ts  youtubeHealth.ts
  botScrobblingService.ts  voiceChannelStatusService.ts  moonlinkTypes.ts

src/bot/handlers/music/
  musicEventListeners.ts   one method per Moonlink event
  nowPlayingCardPublisher.ts  publishProgress, coalescing, 429 retries
  chapterTimeline.ts       probe, derive, seek swap
  chapterArtController.ts  per-chapter cover, prefetch, retry timer
  karaokeController.ts     lyric window + boundary timer
  alternateTrackFinder.ts  the four fallback rungs
  fallbackBudget.ts        budget Maps + song circuit breaker
  voiceLifecycle.ts        VoiceStateUpdate / ChannelDelete / GuildDelete
  cardFingerprint.ts       pure fingerprint + fallback-query helpers
```

**Play path**: `play()` routes by input kind → `MusicSearchLadder` (Home yt-dlp resolver → SoundCloud) → `MoonlinkManager` (failover) → `enqueueLavalinkTracks` (the single enqueue choke point). Unresolved playlist entries sit in a **just-in-time pending queue** resolved 2 tracks ahead.

**Chapters** (`>20 min` only): description timestamps from one Data API call, parsed and cached. `ChapterTimeline.chapterCardFor` derives the card; `ChapterArtController` resolves covers behind an 8s race with a dedicated 30s retry; `swapChapterOnSeek` handles seeks.

**Card publishing**: `publishProgress` is **event-driven, with no polling timer** — `musicEventListeners` calls it and `scheduleImmediateProgress` (300ms debounce) coalesces bursts. A fingerprint dirty-check means an event that changes nothing renders nothing. There is deliberately no `setInterval` tick.

### The rules that are not visible in the code

- **Never trust `current.position` / `current.time`.** Moonlink owns them and rewrites them from the *pre-seek* position for seconds after a seek. `queueService.calculatePosition` treats a recent `lastUserSeekAt`/`lastUserSeekPos` as authoritative, forward-only.
- **The pending store must hand back the LIVE array.** `shuffle` reorders and `remove` splices in place; a copying port silently turns both into no-ops while every assertion still passes.
- **A backwards position is stale data, not a rewind** — unless a recorded seek intent explains it.
- **A deliberate seek must not pay the settle window.** The implausible-jump guard exists for clock drift, not for listeners.
- **`trackStart` must derive the chapter from the real position**, never a hardcoded `0`.
- **A chapter whose art genuinely cannot be found holds the previous cover** indefinitely. That is intentional (it beats flashing the wrong image), but it is why a catalogue miss reads as "art is broken". Fix the matching, not the hold.
- **Timeout→node-cooldown is load-bearing**, from a real uplink-stall incident. Do not "simplify" it away.
- **The Redis FIFO warning is expected.** Write-then-trim ordering is consistent and failure replay is intentional.

Full list with incidents and the test that locks each one: **tvbot-reference** §10, and `AGENTS.md` §4.1.

---

## 5. Testing patterns — copy these, do not invent

- Vitest. `reflect-metadata` must be the **first import** in any test touching a `tsyringe` module.
- **Test files go in `__tests__/`.** See §2.
- Build a `MusicHandler` with stub objects, then cast to reach privates. `vi.spyOn(handler, 'publishProgress')`.
- Mock network with `vi.spyOn(globalThis, 'fetch')`; assert URLs from `spy.mock.calls`.
- Module-level Maps persist within a test file — use a distinct 11-char id per test.
- Fresh module state: `vi.resetModules()` + dynamic `await import(...)`.
- `npm test` does **not** typecheck. Run `npm run build` too.
- The db suite reads `TEST_DATABASE_URL`, never `DATABASE_URL`, and `dbHarness` refuses any database whose name is not a scratch one. It skips locally and runs in CI against a disposable `postgres:16`.

### Two contract facts that shape what you may extract

1. **Never add constructor parameters to `MusicHandler`** — the suite builds it positionally with 3 args (`client`, `{getManager}`, `{getQueueInfo, is247}`). Construct collaborators *inside* the existing constructor body, or extract free functions. Same rule for `MusicService`, built positionally with 3–5 args at 20+ test call sites.
2. **Tests reach privates via casts and replace methods on the instance.** So any extracted member must still be reachable on the original object (delegate, not removal), and every cross-cluster call must go **through the host instance** — never a sibling collaborator — or `vi.spyOn` and own-property shadows stop working. Services that tests reassign after construction (`artworkService`, `colorService`) must be read live through the host, never captured by value. State Maps that tests read must stay owned by the host and be passed in by reference.

`AGENTS.md` §5 has the full list.

### What the suite cannot do

It did not catch the date-prefix artwork bug, the seek-position bug, or the chapter rewind — all because the tests were written against our own abstraction. Prefer a test that drives the real Moonlink interface over one that asserts on our abstraction. See **tvbot-reference** §11 for the full gap analysis and the uncooperative-double pattern.

---

## 6. Adding a command (1:1 from fmbot)

1. Read the C# reference in `fmbot-dev/` (`TextCommands/`, `Builders/`, `Services/`).
2. Service method in `src/bot/services/` — the subsystem folder that owns the domain (`music/`, `lastfm/`, `system/`, `audio/`, `crown/`, `guild/`, `whoKnows/`), or a loose file beside them. **Do not invent a new folder name.**
3. Response in `src/bot/builders/*Builders.ts` returning `ResponseModel`.
4. Slash command in `src/bot/slashCommands/` **and** text command in `src/bot/textCommands/<area>/` (both registered in that folder's `index.ts`). Both delegate to the same builder.
5. Check the name is **unique across both families** — the registry silently lets the later registration win and the other becomes unreachable. It logs `Text command name collision` at startup; check it every time. This has bitten `.remove` and `.lyrics`.
6. Interactive pieces → `src/bot/interactions/` + a route in `src/bot/handlers/interactionHandler.ts`.
7. Wire singletons in `src/bot/startup.ts:configureContainer()`. Positional constructor calls there are load-bearing.
8. **Tests in the area's `__tests__/` folder** — `src/bot/builders/__tests__/`, `src/bot/services/<subsystem>/__tests__/`, etc. Never beside the source.
9. `npm run build && npm test && npm run lint && npm run debt`.

**Database changes**: edit `src/persistence/prisma/schema.prisma` → `npm run db:generate` → verify with `npx prisma migrate status`.

---

## 7. When you are asked "is it working / perfect?"

Answer honestly and separate the two things:

- **Verified**: anything a test asserts, and anything you measured. Say which.
- **Not verified**: voice connection, audio throughput, FFmpeg, and real Discord behaviour. No test covers these.

A refactor that is *supposed* to be invisible succeeding is the goal, not proof of health. The only real evidence is the user playing the bot and reading the log — which is how every real bug here was found.
