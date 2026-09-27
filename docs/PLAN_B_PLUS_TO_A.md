# Plan: B+ → A

Source: an external review of the repo at commit `af2e95f`, which graded it **B+**.
The repo's own `docs/QUALITY_REVIEW.md` said A−; that review missed the items below.

**Progress is tracked in `PLAN_PROGRESS.md`. Read that first — it is the state of play.**

## Ground rules (apply to every task)

1. **Measure first, then change.** Record the "before" number in the commit body.
2. **Comments: at most 3 lines, explaining *why*.** No essays in code, CI files, or commit messages.
3. **Don't grade your own work** in repo docs. Put metrics in CI output, not prose.
4. **Ratchet, don't mass-fix.** For any count (any-casts, `container.resolve`, coverage), add a CI
   check that fails if the number gets worse, then lower it step by step.
5. Don't change user-facing behaviour unless the task says to.

After every task: `npm run build && npm test && npm run lint`.

---

## Phase 0 — deployment and doc accuracy

### 0.1 Railway never runs migrations (prod bug)
`railway.json` `deploy.startCommand` overrode the Dockerfile `CMD`, the only place that ran
`prisma migrate deploy`. Four start commands existed; the one Railway honoured had no migrate step.
- One definition of the start command, one place migrations run, `RAILWAY.md` documents it.
- Delete `nixpacks.toml` if the Dockerfile builder is the real path.

### 0.2 README accuracy
- "Manual dependency injection (no decorator magic)" is false: 89 files use `@injectable`,
  `startup.ts` has 223 `container.register*` calls, ~300 `container.resolve` calls.
- The "635/635 tests passing" badge is stale. Replace with the real CI badge.
- Last.fm User-Agent points at `github.com/moha/tvbot`; should be `tvbot69/tvbot`.

### 0.3 Repo hygiene
- Move `CLAUDE_ARTWORK_DEBUG.md`, `CLAUDE_HANDOFF.md`, `plan.md`, `plan-harden.md` to `docs/archive/`.
- Add `.gitattributes` (`* text=auto eol=lf`, binaries), then `git add --renormalize .`.
- Remove the duplicated header comment block in `ci.yml`.

---

## Phase 1 — data integrity (highest real risk)

### 1.1 Delta-sync lock is not atomic (race → duplicate plays) — **DONE**
`updateService` and `indexService` both did check-then-set across two awaits. Every command fires
`void updateUser(...)` alongside the cron sweep, so both could pass.
- Add `CacheService.setNX` (`SET key 1 NX EX ttl` + in-memory equivalent). Use for both guards.
- Acceptance: 5 concurrent `updateUser(sameId)` → `performDeltaSync` ran once; mutation-checked.

### 1.2 `user_plays` has no uniqueness, so `skipDuplicates` does nothing
Only unique key is autoincrement `userPlayId`. Dedup is app-side; `ReconcileService` heals drift
afterwards. The chunk-insert retry can double-insert if a commit succeeds but the ack times out.
- **Step 1 (measure, don't change):** `scripts/count-duplicate-plays.ts` reporting duplicates by
  `(user_id, time_played, lower(artist_name), coalesce(lower(track_name),''), play_source)`.
  Report counts before deleting anything.
- **Step 2:** raw-SQL migration deleting duplicates (keep min `user_play_id`) then
  `CREATE UNIQUE INDEX CONCURRENTLY` on that expression. 1-line comment in the schema.
- Acceptance: integration test inserts the same batch twice → N rows, not 2N.

---

## Phase 2 — test where the product actually lives

The self-review counted test *files*, which hides the truth. Core data path was untested.

| File | Lines | Was |
|---|---|---|
| lastfm/repositories/lastFmRepository.ts | 654 | 8.9% |
| persistence/repositories/crownRepository.ts | 305 | 8.2% |
| bot/services/trackService.ts | 428 | 7.7% |
| bot/services/albumService.ts | 656 | 9.9% |
| bot/services/artistsService.ts | 419 | 11.9% |
| bot/services/music/spotifyResolver.ts | 343 | 10.8% |
| persistence/repositories/* (all) | 2054 | 17.6% |
| bot/interactions/* (all) | 4103 | 22.0% |

### 2.1 Coverage in CI with a ratchet — **DONE**
`@vitest/coverage-v8`, `test:coverage` script, thresholds at the measured baseline,
`reportOnFailure: true`, CI runs it. Raise thresholds after each task below.

### 2.2 Characterization tests for the core — **IN PROGRESS**
Use recorded Last.fm/Spotify JSON fixtures. Cover `lastFmRepository` (paging, now-playing,
error 6/8/29), `trackService`, `albumService`, `artistsService`, `crownRepository` (steal,
threshold, tie), `spotifyResolver`.
- Acceptance: each file ≥60% lines, global threshold raised to ≥60%.

### 2.3 Real-Postgres repository tests
28 `$queryRawUnsafe` calls: injection-safe but untyped — a column rename breaks them at runtime
with a green build.
- `postgres:16` service container in CI, `prisma migrate deploy`, `*.db.test.ts` in a separate
  vitest project. Test every raw query at least once (whoKnows, crowns, guildRanking, playHistory,
  genre, country). Prefer `$queryRaw` tagged templates.

### 2.4 Make the unit suite run without Chrome
7 tests in `images/generators/*.test.ts` and `bot/services/chartService.test.ts` launch a real
Puppeteer browser. Rename to `*.render.test.ts`, exclude from the default suite, own CI job that
installs Chromium.

---

## Phase 3 — architecture

### 3.1 Zero import cycles, enforced
`madge --circular` finds 4:
1. `userService.ts` ↔ `commandDispatcher.ts`
2. `autopostService.ts` ↔ `autopostRepository.ts`
3. `ytResolver.ts` ↔ `descriptionChapters.ts`
4. `musicService.ts` ↔ `playlistChunkManager.ts`

Fix all 4, add `madge --circular` as a blocking CI step.

### 3.2 Lower layers must not import `@bot/*`
Violations: `persistence/prismaClient.ts`, `autopostRepository.ts`, `lastfm/api/lastfmApi.ts`,
`lastfm/converters/recentTrackConverter.ts`, `lastfm/repositories/lastFmRepository.ts`,
`images/generators/{iceberg,whoKnows,worldMap}Generator.ts`.
- Move ConfigData to `src/config`. Shared types to `src/domain`. `ICache`/`ITelemetry` into domain
  and injected. `isPlaceholderImageUrl` to a domain util.
- ESLint `no-restricted-imports` overrides for the lower layers.

### 3.3 One DI style: constructor injection, composition root only
Hybrid today: `@injectable` + 223 manual registrations + ~300 `container.resolve`.
Top offenders: interactionHandler (39), textCommands/index (34), slashCommands/index (33),
timerService (17), startupService (15), fmFooterResolver (13), commandHandler (11), lastfmApi.
- Allowed for `container.resolve`: `startup.ts`, `textCommands/index.ts`, `slashCommands/index.ts`.
- `scripts/count-debt.ts` printing any-casts, `as unknown as`, `container.resolve` outside the
  allowlist, `process.env` outside `src/config`. CI fails if any count goes up. **Target: <30.**
- Remove module-scope side effects: `dns.setDefaultResultOrder` → `bot/index.ts`;
  `prismaClient` should not validate env on import.

### 3.4 Services calling Prisma directly
20+ files in `bot/services`/`bot/interactions` use `prisma.` directly. Don't mass-move. When you
touch one, move it into the matching repository with a typed row interface. New code must not add
direct Prisma calls in `bot/`.

### 3.5 One HTML escaper
`escapeHtml` copy-pasted 4 times in `images/generators` and the copies have drifted — two don't
escape `'`. Create `src/images/html.ts` with a tested `escapeHtml` and `safeUrl` (https only).

---

## Phase 4 — type safety (ratchet)

Baseline: `as any` 139, `as unknown as` 116, `: any` 47, 485 `no-explicit-any` warnings,
`@ts-ignore` 0 (keep at 0).
- Hotspots: `artistBuilders.ts` (10), `crownInteractions.ts` (8), `artistInteractions.ts` (7),
  `topInteractions.ts` (6), `trackSlashCommands.ts` (6). Most are Prisma results → use
  `Prisma.XGetPayload<>` or typed row interfaces.
- One `music/moonlinkTypes.ts` adapter holding the unavoidable casts. `as unknown as` allowed only
  there (`musicEventListeners` 10, `musicBuilders` 9, `musicHandler` 7).
- `no-explicit-any` as `error` via ESLint override for any directory that reaches 0.
- Target: combined escapes under 80, 0 outside the moonlink adapter + documented allowlist.

---

## Phase 5 — security and ops hardening

### 5.1 Puppeteer
Launches with `--no-sandbox --disable-web-security` and renders HTML containing user-controlled
names and remote image URLs. Escaping is correct, so this is defence in depth.
- Remove `--disable-web-security` unless a test proves it needed. If needed, say why in 1 line.
- `page.setRequestInterception(true)`: allow only `data:` and https image CDNs (Spotify, Deezer,
  Apple, Last.fm, Discord). Block `file:`, `http:`, localhost, RFC1918, `169.254.169.254`.

### 5.2 Config discipline
27 `process.env` reads across 12 files outside the config module (ytResolver 7, audioSignalService 4,
puppeteerService 3, logger 3, ...). Move them into the validated config.

### 5.3 Memory
`--max-old-space-size=384` runs in the same process as Puppeteer (plus Chromium child), Essentia
WASM, and Lavalink clients. Log RSS and heap at the hourly timer; document the measured peak in
`RAILWAY.md`.

---

## Definition of done for "A"

- [ ] Migrations run on every Railway deploy. One start command.
- [ ] Sync lock is atomic. `user_plays` has a DB-level unique key. Duplicate count is 0.
- [ ] Line coverage ≥ 65% and core files ≥ 60%, enforced in CI.
- [ ] Real-Postgres tests cover every raw SQL query.
- [ ] Unit suite passes without Chrome.
- [ ] 0 import cycles and 0 `@bot/*` imports from lower layers, both enforced.
- [ ] `container.resolve` outside the composition root < 30.
- [ ] Type escapes < 80, with a ratchet in CI.
- [ ] README claims match reality. Root has no agent handoff files.
