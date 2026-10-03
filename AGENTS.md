# tvbot — AI Assistant Instructions & Workspace Rules

> **MANDATORY CONTEXT: this file is loaded on every turn.**
> You are the dedicated core engineer on **tvbot**, a private unlimited Discord bot mirroring `fmbot` for Last.fm stats and Lavalink music. You do not need to ask what the bot is. This file plus the `tvbot` and `tvbot-reference` skills (`.opencode/skills/`) are the only AI-instruction files in the repo. Keep it that way — duplicated handbooks drift and then actively mislead.

Paths below are **repo-relative**. Do not write absolute `file://` URLs — they break on any machine that isn't the author's.

**This repository is public.** Never commit an infrastructure detail: no hostnames, tunnel or
Funnel URLs, machine paths, tokens, ports or credentials — not in code, not in comments, not in
docs, not in a stray log file. Read them from the environment. The one place a host is allowed is
a placeholder (`https://<machine>.<tailnet>.ts.net` in `src/config/lavalink.ts:53`).

---

## 0. Vision

**tvbot is a private, unlimited, fmbot-class Discord bot**: Last.fm listening intelligence plus
self-hosted Lavalink playback. It matches fmbot on core features and then goes beyond them —
audio analysis, collage charts, social intelligence, crowns.

The bot is for a private friend group, so there are no rate limits and no public API to be gentle
with. The bar is therefore not "does it scale" but **"would I hand this to a stranger without
hesitating"**: no confident wrong answer, no half-built feature that presents itself as working, no
deployment that depends on someone remembering a step.

**The standing goal is A-tier quality**, which in this repo means the bot never tells a user a
plausible falsehood. Concretely, three properties:

- **A1 — no query is silent.** Code that reads the database or Last.fm and cannot read it says so.
  A `.catch(() => [])` on a data path turns an outage into a plausible wrong number, and the user
  cannot tell which they were given.
- **A2 — no dead feature presents itself as working.** A feature either works or is gone.
- **A3 — every query that can run has been run.** An unexecuted query is an untested query.

---

## 1. Project Overview & Technology Stack
- **Name**: `tvbot`
- **Purpose**: Full-featured Discord music + Last.fm statistics bot mirroring `fmbot-dev`, without rate limits.
- **Stack**:
  - **Runtime**: Node.js 22 LTS + TypeScript 5.7 (ES2022 target, `useDefineForClassFields: true`)
  - **Discord**: `discord.js` v14.18 (Gateway Intents, Interactions, Voice Message Flags `8192`)
  - **Persistence**: Prisma 6.5 + PostgreSQL (Railway)
  - **DI**: `tsyringe`, **manual singleton registration** in `src/bot/startup.ts`
  - **Cache**: `ioredis` with automatic in-memory LRU fallback (`src/bot/services/system/cacheService.ts`)
  - **Music**: `moonlink.js` v5 (Lavalink v4, auto-failover) + `fluent-ffmpeg` + `essentia.js` WASM (BPM/key)
  - **Graphics**: `puppeteer` 25.9 (ephemeral in dev, persistent in prod) for chart collages
- **Scale**: <!-- metrics:start -->
| Metric | Count |
|---|---|
| Production files | 395 |
| Production lines | 84668 |
| Slash top-level commands | 76 |
| Text commands | 158 |
| Text triggers + aliases | 575 |
| Test files | 446 |
| Repositories | 19 |
<!-- metrics:end --> See [docs/METRICS.md](docs/METRICS.md) for current counts.

---

## 2. Verification Gates (non-negotiable, in this order)
1. `npm run build` — must be clean. A failed build means the task is **not** done.
2. `npm test` — all suites green. Never weaken or delete a test to make something pass unless the user approves it.
3. `npm run lint` — **0 errors**. Warnings do not fail a build, but the count must not be treated as free.
4. `npm run debt` — every ratchet at or under budget. A ratchet that moves up is a regression, not a note.
5. Commit only files the task touched (`git add <specific paths>`). Never `git add -A`.
6. Push **only** when asked.

<!-- metrics:start -->
| Metric | Count |
|---|---|
| Production files | 395 |
| Production lines | 84668 |
| Slash top-level commands | 76 |
| Text commands | 158 |
| Text triggers + aliases | 575 |
| Test files | 446 |
| Repositories | 19 |
<!-- metrics:end -->
See [docs/METRICS.md](docs/METRICS.md) for current counts. `npm run debt` reads `explicit-any 0`,
`as-unknown-as 75/101`, `silent-failure-default 443/604`, `container-resolve-outside-root 154/155`,
`prisma-client-import-in-bot 15/17`, and every other kind at budget. If the generated numbers drift
from reality, **the generator is wrong** — check the gate output and fix `scripts/generate-metrics.ts`.

The db suite reads `TEST_DATABASE_URL`, not `DATABASE_URL`, and `dbHarness` **refuses** to run
against any database whose name is not a scratch one. It skips locally (no Docker, no local
Postgres) and runs in CI against a disposable `postgres:16`. Never point either variable at
production, and never truncate a connection string — see `src/persistence/AGENTS.md`.

`npm test` does not typecheck. Always run `npm run build` too — otherwise a bad constructor arity passes vitest and breaks the build. It is not a hypothetical: writing the log monitor, the suite reported 1212/1212 green while `tsc` rejected three lines, and five separate batches since have produced the same shape. CI (`.github/workflows/ci.yml`) runs the build first and blocking for exactly this reason.

**A test double is a claim about a vendor, and nothing checks the claim.** 4,900+ green mocked tests once missed eleven live bugs — Last.fm judging HTTP status before reading the body, a Spotify collage limit that is 10 and not 50, ffmpeg resolving to a Linux binary on Windows, a BPM that was wrong rather than absent. When a bug looks like "the provider is wrong", it usually is: **probe the real API** (`npx tsx scripts/liveVerify.ts`) instead of reasoning from memory, and never print a key while doing it.

**Run it**: `npm install` → `npm run db:generate` → `npm run dev` (tsx watch, ephemeral Puppeteer, Lavalink off). Production is `npm run build` then `npm start`.

---

## 2.1 The A-tier quality bar

These are the rules that decide whether a change is finished. They are not aspirations; each one
exists because breaking it shipped a real bug.

- **Nothing is done until `npm run build`, `npm test` and `npm run lint` all pass.** A green suite
  without a green build is not a green suite. If a gate was not run, say so — do not imply it.
- **Every command ships twice**, as a slash command and as a `.`-prefixed text command, both through
  the shared response pipeline in `src/bot/builders/`. One family alone is a half-feature.
- **Playback failures degrade to a fast skip, never a stall.** Respect the per-node and per-song
  breakers. A dead source costs one skip; it must never leave a guild sitting in silence waiting
  on a track that will not resolve.
- **Artwork always resolves through `ArtworkService`.** Never a raw Last.fm `imageUrl` — the
  placeholder is common and the cascade is what filters it (§3.2).
- **New behaviour gets tests, and the tests are mutation-checked.** A test that cannot fail proves
  nothing, and a mutation appended after a `throw` is unreachable and proves nothing either. Where
  a fix and a bug are opposites, test **both directions** — a failure raises *and* a genuine empty
  result still returns empty.
- **Small focused diffs. No drive-by refactors.** Touch what the task needs. A refactor bundled
  into a bug fix is a refactor nobody reviews.
- **Prefer the existing DI pattern**: `@injectable()` on the class, composition root in
  `src/bot/startup.ts`. Do not introduce a second way of resolving a service.
- **Never commit secrets** — and in this public repo, never an infrastructure detail either (see
  the header). `.env` is never read, printed or copied into a test fixture.
- **New code ships A-tier only.** No silent failures on data paths — raise or say
  unavailable. No dead paths presenting as working. Every new branch gets a test
  that fails without the fix. Gates green (build/test/lint/debt) before reporting
  done.

---

## 3. Golden Architectural Rules

1. **Dependency injection is manual.** Every service, repository, command handler and interaction listener is constructed by hand and registered in `src/bot/startup.ts`. Never rely on reflection or implicit bindings. Positional constructor calls in `startup.ts` are load-bearing — reordering a constructor is a breaking change.

2. **Never trust Last.fm's `imageUrl`.** It frequently returns the placeholder `2a96cbd8b46e442fc41c2b86b821562f`. All artwork goes through `ArtworkService` (Spotify → Deezer → Apple → Last.fm). The placeholder check lives in exactly one predicate, `isPlaceholderImageUrl`, in `src/domain/lastfm/lastfmPlaceholder.ts` (re-exported from `artworkService` for the ~20 existing call sites) — call it, never re-inline the hash. It lives in `domain`, not `bot/services`, so lower layers can ask the question without importing the artwork cascade.

3. **Artwork title matching must survive real catalogue shapes.** Matching is deliberately strict (never substring — `"Song"` must not match `"Song 2"`), and it must tolerate a **leading date prefix**, because DJ-pool and compilation rips are often the *only* thing a provider returns: Mac DeMarco's "I Like Her" comes back as `20191009 I Like Her` on "Cottage Core"-style albums. Without the prefix strip, correct-artist/right-recording rows get rejected and the card holds the previous cover forever. See `matchesTrackTitle` in `artworkService.ts` and `artworkService.datePrefix.test.ts` in `src/bot/services/media/__tests__/`.

4. **Dual-mode commands.** Every command exists as a slash command (`src/bot/slashCommands/`) *and* a text command (`src/bot/textCommands/`, prefix `.`). Both delegate to a shared `src/bot/builders/*Builders.ts` returning a `ResponseModel`. **Command names must be globally unique across both families** — the registry logs a collision and silently lets the later registration win, making the other unreachable. This has already bitten `.remove` (account unlink vs queue remove) and `.lyrics`.

5. **YouTube ids are exactly 11 chars.** Gate every outbound id with `/^[\w-]{11}$/`.

6. **Chapter/artwork state is only decoration.** Chapter logic must never break playback, and must never trip the audio resolver's pause/alert machinery.

7. **Environment**: in dev (`ENVIRONMENT=local`) `ENABLE_LAVALINK=false` by default, to avoid burning public node rate limits on reload.
8. **Delete scrapped approaches completely.** No flags, no legacy rungs, no commented-out remnants of a removed feature — unless the user explicitly asks to keep a path behind a flag. Piped chapters and fake-Spotify presence were both fully deleted, as were the AI judge (`.judge`/`.roast`/`.compliment` — three hardcoded templates with `Math.random()` for the score, never AI), number formatting, `/recap` and `/librarysearch`. **Do not restore them.**
9. **Type-only imports across music modules** (`import type { X } from './ytResolver'`) — this is what keeps the playback DAG acyclic. A value import there closes a cycle.
10. **`Logger.debug` for internal degradation paths.** The user reads Railway logs, and INFO-level noise hides the lines that matter. An expected-but-notable outcome is DEBUG; a lost capability is WARN.
11. **There IS dynamic dispatch in this bot.** Modal handlers dispatch by string prefix (`registerModalHandler`), `ComponentInteractionTracker` is keyed by exact `customId`, `interactionHandler` routes on a literal table, and `container.resolve` builds a graph at runtime. **A method reached by any of those has no static caller.** Never call code dead on a grep alone — check startup registration, `container.resolve`, string-keyed lookups, event-listener and cron registration, and then say which mechanism reaches it, or say you found none.

12. **One test convention: `__tests__/`, never colocated.** Every test file sits in a `__tests__/` folder inside the area it covers (`src/bot/builders/library/__tests__/albumBuilders.pagination.test.ts`). Zero test files sit beside their source, and the old `src/tests/` tree is gone — do not recreate it. Shared harness code (`dbHarness.ts`, `setupEnv.ts`, `dbRawQueryObserver.ts`, `uncooperativePlayer.ts`, `repoRoot.ts`) lives in `src/testSupport/`; repo-wide invariant tests live in `src/__tests__/`. New subsystem folder names come from the existing vocabulary in the tree map (§7) — do not invent a synonym for a folder that already exists. **Moving a production file means moving its tests with it**, and if the file is named in `scripts/raw-query-baseline.json` you must retarget that key: an orphan key naming no file on disk is a **hard error** in `scripts/count-debt.ts`, not a warning.

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

**Card publishing**: `musicHandler.publishProgress` is **event-driven, with no polling timer**. `musicEventListeners` calls it on every relevant Moonlink event (track start, pause, seek, volume, filter change) and `scheduleImmediateProgress` (300ms debounce) coalesces the bursts. Each publish is guarded by a fingerprint dirty-check, so an event that changes nothing renders nothing.

There is deliberately **no `setInterval` tick**. An earlier version of this file claimed a "5s tick"; that was wrong and the tvbot skill had it right. A poll would republish the same card every five seconds forever — Discord rate limits, needless API calls — and the fingerprint made it pointless anyway.

### 4.1 Invariants that broke in production — do not regress these
Read `src/bot/handlers/music/AGENTS.md` before touching playback. It carries each of these with a
`file:line` reference, the "why", and the test that locks it. Summary only:
- **`shuffle` and `remove` mutate the pending array in place**, so the pending store must hand back the **live** array, never a copy.
- **A position that moves BACKWARDS is stale data, not a rewind.** A real backward seek carries `lastUserSeekAt`/`lastUserSeekPos`, recorded by `seek()` *before* it awaits the node.
- **Deliberate seeks must not pay the settle window** — the implausible-jump guard exists for clock drift, not for listeners.
- **`trackStart` must derive the chapter from the real position**, never a hardcoded `0`.
- **A chapter whose art genuinely cannot be found holds the previous cover.** Fix the matching, not the hold.
- **Timeout→node-cooldown is load-bearing.** A search timeout must keep cooling the node.
- **The Redis write-then-trim protocol is expected.** The trim is the acknowledgement, so failure replay is intentional. Do not "fix" it. (`cacheService` emits no FIFO warning; that claim in an earlier revision of this file was wrong.)

---

## 5. Testing Contracts (violating these breaks the suite)

- **Never add constructor parameters to `MusicHandler`.** Tests build it positionally with 3 args: `new MusicHandler(client, {getManager}, {getQueueInfo, is247})`. Extract collaborators by constructing them *inside* the existing constructor body, or as free functions taking deps as arguments.
- **Never add constructor parameters to `MusicService`** either — over 20 test call sites build it positionally with 3–5 args. Keep the signature and add collaborators internally.
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

**The facade pattern is the tool that works here.** Extract behaviour, keep the public surface as one-line delegates on the original class, and the registered token plus every existing call site keep compiling. This is how `musicService` went 2317 → ~1400 lines with **zero changes to any pre-existing test**.

- Prefer **pure function modules** (no state, no timers) — those are free to move.
- Prefer **collaborators constructed inside an existing constructor** over new DI wiring.
- Introduce a **port interface in a leaf module** when two modules need the same capability; that is what prevents import cycles.
- **Do not split for the sake of line count.** `moonlinkManager` (679 lines), `interactionHandler` (a routing table), `musicBuilders` (independent cards) and `playRepository` (one per-user aggregate) are all long *and* cohesive; splitting them raises fan-in and makes the code harder to work in, not easier.
- **Do not deduplicate the slash/text command layer wholesale.** The shared response layer (`src/bot/builders/`) is already single-copy and tested. What remains duplicated is argument parsing, and the two argument models are genuinely different (typed Discord options vs hand-written string grammars like `seek 1:40`, `lfm:user`, `filters clear`). 13 of 33 pairs are under 50% overlap and would need bespoke specs. Fix concrete drift instead.
- **Verify dead code before deleting it**: grep for both production *and* test references, and check whether the "caller" is itself reachable (a stub returning `null` makes its caller's branch dead code).

---

## 7. Source tree map

Every folder below is real. `__tests__/` is omitted from the drawing — see rule 12 (§3.12).

```
src/
├── __tests__/            repo-wide invariant tests (13 files)
├── testSupport/          dbHarness, setupEnv, dbRawQueryObserver,
│                         uncooperativePlayer, repoRoot
├── bot/
│   ├── startup.ts        the dependency graph — read first when tracing wiring
│   ├── handlers/         event dispatch, sorted by concern; no loose files
│   │   ├── commands/      commandHandler, commandDispatcher
│   │   ├── interactions/  interactionHandler
│   │   ├── music/         musicHandler + the 9 playback collaborators, AGENTS.md
│   │   ├── logs/          clientLogHandler
│   │   ├── queues/        updateQueueHandler
│   │   └── users/         userEventHandler
│   ├── services/           EVERY service is in a subsystem folder; there are no
│   │                       loose files. `startup.ts` is the index.
│   │   ├── music/          playback DAG (§4)
│   │   ├── library/        catalogue reads: album, artists, artistTrack, track,
│   │   │                   genre, country, overview, playHistory, taste, featured,
│   │   │                   musicIntelligence, librarySearch, import, albumEnrichment
│   │   ├── system/         cache, color, setting, rateLimit, pagination, healthServer,
│   │   │                   shutdown, startup, telemetry, ttlStore, abuseFilter, …
│   │   ├── user/           user, login, profile, prefix, shortcut, streak
│   │   ├── media/          artwork, appleMusic, deezerCoverIndexer, musicBrainz
│   │   ├── lastfm/         index, update, timer, reconcile, *Queue services
│   │   ├── guild/          guild-scoped services, guildAdmin, guildRanking, game
│   │   ├── charts/         chartService, autopostService
│   │   ├── social/         friends, exposed
│   │   ├── whoKnows/       leaderboards
│   │   ├── crown/          crowns
│   │   └── audio/          previewResolver, audioSignal, essentia, voiceMessage,
│   │                       lyricStatus
│   ├── builders/         embed/action-row factories returning ResponseModel
│   ├── slashCommands/    33 files (+ AGENTS.md)
│   ├── textCommands/     guild, lastfm, meta, music, thirdParty, user
│   ├── interactions/     buttons, select menus, modals
│   ├── models/           ContextModel, ResponseModel, command/chart/whoKnows models
│   ├── configurations/   envValidator, configData
│   ├── autoCompleteHandlers/  diagnostics/  resources/
├── persistence/          prisma/ (schema + client), repositories/ (19),
│                         models/ (row shapes: channel, guild, guildDisabledCommand,
│                         user) — NOT a second `domain/`
├── lastfm/               api/, converters/, models/, repositories/
├── spotify/  applemusic/  deezer/   images/ (generators, pages, models)
├── domain/               the shared kernel; nothing here imports upward
│   ├── logging/          logger, errorFeed, adminAudit
│   ├── text/             textNormalize, date, statistics, markdown, stringExtensions
│   ├── http/             fetchWithTimeout
│   ├── lastfm/           lastfmErrorRateTracker, lastfmPlaceholder
│   ├── errors/           discordErrors
│   ├── diagnostics/      memoryReport
│   ├── enums/            14, all command/response enums
│   ├── interfaces/       ports/ (repository + queue contracts), discord/ (shapes)
│   └── models/           shared DTOs, plus models/errors/ and models/music/
└── config/  types/       lavalink, runtimeEnv, musicEnv; ambient.d.ts
```

**One domain vocabulary, applied to every command family.** `builders/`,
`slashCommands/` and `interactions/` each used to be a flat alphabetical list of
41 / 33 / 28 files, so one feature's three files were scattered across three
directories. They are now sorted by the SAME domain nouns — `library/`, `user/`,
`social/`, `music/`, `guild/`, `charts/`, `crown/`, `whoknows/`,
`intelligence/`, `common/`, `meta/` — so a domain is a column you can read down
instead of three rows you have to join. `index.ts` stays in each root: it is a
barrel, not a loose module.

**`domain/` must not import upward.** It is the layer every other folder imports,
so a `domain/` file reaching into `bot/`, `persistence/` or a provider package
turns the kernel into a cycle. Six `interfaces/ports/*` files `import type`
row shapes from `@persistence/models/`; that predates the re-sort and is a type
only, but it is the shape to watch for.

**A test that walks a folder must walk it RECURSIVELY.** Three repo-invariant
tests scan `builders/` or `interactions/` from disk, and a non-recursive
`readdirSync` after the re-sort sees only the barrel — which turns a real scan
into a vacuous pass. `customIdParity.test.ts` and `componentsV2Guard.test.ts`
both use `{ recursive: true, encoding: 'utf8' }` now. Check this before adding
another folder-wide invariant.

**Provider folders share one shape.** `spotify/`, `applemusic/`, `deezer/` and
`lastfm/` are `api/`, `models/`, plus whatever else that provider needs
(`converters/`, `repositories/`). The `api/` folder is SINGULAR in all four: it was
`deezer/apis` and `applemusic/apis` against `spotify/api` and `lastfm/api`, and
the odd ones out were wrong. A folder holding one file is a seam, not noise —
`deezer/models/deezerModels.ts` is the shape a reader learns once and reuses.

**Every alias in `tsconfig.json` and `vitest.config.ts` must name a folder that
exists.** `@discogs/*` survived the deletion of Discogs and pointed at nothing for
months — the exact "you configured something that does not exist" bug AGENTS.md
§12 calls the purest example of. The two alias lists are hand-maintained and
drift silently; check both when adding a top-level package.

---

## 8. Workflows

**Adding a command (1:1 from fmbot)**
1. Check the `fmbot-dev` reference implementation.
2. Service method in `src/bot/services/` - pick the subsystem folder that owns the domain. There are no loose files there and no new folder names (§3.12).

3. Response in `src/bot/builders/*Builders.ts`.
4. Slash **and** text command (check the name is unique across both — §3.4). Text commands live in
   `src/bot/textCommands/<area>/`, including `meta/` for help and static triggers.
5. If interactive: handler in `src/bot/interactions/` + route in `handlers/interactionHandler.ts`.
6. Register in `src/bot/startup.ts`.
7. Tests in the area's `__tests__/` folder — never beside the source.
8. `npm run build && npm test`.

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
| `YOUTUBE_API_KEY` | Chapter timestamps via one `videos.list?part=snippet` call. |
| `HOME_RESOLVER_URL` / `HOME_RESOLVER_TOKEN` | The user PC's yt-dlp resolver. The first rung of the search ladder. |
| `HOME_LADDER_MODE` | Which rungs the ladder is allowed to use. |
| `AUDD_API_TOKEN`, `DISCOGS_KEY` / `DISCOGS_SECRET` | **Removed as dead config.** Song recognition and Discogs were never built, and these were validated at boot while read nowhere — the purest "you configured something that does not exist" bug. Do not re-add them to `.env.example`. |
| `ENABLE_LAVALINK` | `false` in dev, `true` in prod. |
| `FFMPEG_PATH` | System ffmpeg/ffprobe, used for previews, voice messages and BPM/key analysis. |
| `STAGING_CHANNEL_ID` | Scratch channel for temporary chart uploads. |

---

## 13. Subsystem map

Where each pillar of the bot actually lives. Read the file before editing it.

- **DI container** — `src/bot/startup.ts:configureContainer()`. The entire graph is constructed by hand and registered with `container.registerInstance`. No reflection.
- **Command framework** — `ContextModel` (`src/bot/models/contextModel.ts`) normalises a `Message`, a `ChatInputCommandInteraction` and a `ButtonInteraction` behind one API. Builders return a `ResponseModel` (embeds, buttons, or Components V2 containers).
- **Persistence** — `src/persistence/prisma/schema.prisma`. `UserPlay` is the indexed scrobble history; `Artist`/`Album`/`Track` are cached metadata; `UserArtist`/`UserAlbum`/`UserTrack` are per-user denormalised rollups all keyed `(userId, <id>)`; `UserCrown` tracks guild crown holders; `GuildAutopost` holds scheduled-post config.
- **Last.fm sync** — `src/bot/services/lastfm/updateService.ts` (delta sync, 3h overlap, 14-day fallback, backoff `500/2500/5000/10000/25000ms`), `indexService.ts` (full history, up to 1000 pages, batch commits every 10), `timerService.ts` (cron).
- **Artwork engine** — `src/bot/services/media/artworkService.ts`. Memory + Redis cache (1h positive / 10min definitive-none / 90s inconclusive), then a DB row if fresher than 90 days, then the cascade Spotify → Deezer → Apple → Last.fm, then persist. See §3.2 and §3.3.
- **Social intelligence** — `src/bot/services/whoKnows/`. Ranks top listeners per artist/album/track from indexed plays plus a live Last.fm count, respecting `privacy_level`, guild bans and `self_block_from_who_knows`.
- **Crowns** — `src/bot/services/crown/crownService.ts`. Claim/steal with a play threshold, dynamic re-evaluation against live scrobbles, bulk seeding, moderation.
- **Autoposts** — `src/bot/services/charts/autopostService.ts`. Scheduled leaderboard/crown posts on a 15-minute cron sweep.
- **OAuth actions** — `.love`/`.unlove`/`.scrobble` live in the track command modules and now-playing interactions, and use the user's `session_key`.
- **Audio analysis** — `src/bot/services/audio/`: `previewResolverService` (30s previews), `audioSignalService` (ffmpeg → PCM), `essentiaService` (WASM BPM + key), `voiceMessageService` (Opus OGG with `flags: 8192` and a base64 waveform).