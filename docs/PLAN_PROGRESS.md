# Progress: B+ → A

Plan: `PLAN_B_PLUS_TO_A.md`. Read both before starting work.
**Update this file at the end of every task**, before the commit.

## Current numbers (re-measure, don't trust this table)

| Metric | Start | Now | Target |
|---|---|---|---|
| Tests | 1085 | **1373** (149 files) | — |
| Line coverage | 48.5% claimed / **49.00% measured** | **49.82%** | ≥65% |
| Branch coverage | 68.6% claimed | **68.83%** | — |
| `as any` / `as unknown as` / `: any` (prod) | 139 / 116 / 47 | **130 + 106**, see `scripts/count-debt.ts` | <80 combined |
| `catch (err: any)` | 37 | **0** | 0 |
| `container.resolve` outside composition root | ~300 | **155** (0 eager) | informational |
| Import cycles | 4 | **0 runtime** / 3 type-only | 0 runtime |
| Lower layers importing `@bot/*` | 6+ | **0 value** / 4 type-only | 0 value |
| `@ts-ignore` | 0 | **0** | 0 |
| Lint errors | 143 | **0** | 0 |

## Status

### Phase 0 — deployment and doc accuracy: **DONE**
- **0.1** ✅ `408fd6d`. Confirmed real: Railway's `deploy.startCommand` overrode the Dockerfile
  `CMD`, so `prisma migrate deploy` **never ran on Railway**. Four start commands existed.
  Now one (`package.json` start, invoked by `CMD ["npm","start"]`), `railway.json` sets no
  `startCommand`, `nixpacks.toml` deleted, `RAILWAY.md` documents the mechanism.
- **0.2** ✅ `a99b0aa`. DI claim corrected, 635-test badge → real CI badge, User-Agent → `tvbot69/tvbot`.
- **0.3** ✅ `a99b0aa`. Handoffs → `docs/archive/`, `.gitattributes` + renormalised 18 files,
  `ci.yml` duplicate header merged.

### Phase 1 — data integrity
- **1.1** ✅ `5d7640d`. Race was real in **two** places (`updateService`, `indexService`).
  Added `CacheService.setNX`. 12 tests, 3 mutations caught.
  *I introduced a bug writing it* (deleted the lock on exists, not expires) — the real-code
  test caught it; a stub would not have.
- **1.2** ✅ **FIXED AND APPLIED. Production is unblocked and the guarantee is proven.**
  - *Step 1* `scripts/count-duplicate-plays.ts` (`npm run db:count-duplicates`), read-only.
    **Measured 2026-09-28: 303,424 plays, 0 duplicate keys, 0 extra rows, 0 users affected.**
  - *Step 2* the migration had **failed** (SqlState 42P17), and because `npm start` is
    `migrate deploy && node dist/bot/index.js`, **P3009 took the whole bot down**. It was DOWN, not
    degraded — the process exited before Discord connected.
  - **Root cause, measured not guessed:** `select provolatile from pg_proc where proname='enum_out'`
    returns **`s` (STABLE)**. `play_source` is a Postgres ENUM, and the index cast it with
    `coalesce("play_source"::text, '')`. An enum→text conversion goes through `enum_out`, which is
    STABLE, so Postgres rejects it in an index expression. It is **not** in `pg_cast` — I/O
    conversions are not catalogued as casts — so the earlier `pg_cast` probe returned nothing and
    proved nothing. Do not look there.
  - **The migration's own comment was wrong about the cause.** It blamed Prisma's statement-arity
    transaction rule and predicted 25001; the real error was 42P17. The arity rule is still worth
    keeping, but it was never the cause, and the comment said so at length.
  - ✅ **Fix:** index the enum column **directly** (`"play_source"`), and handle NULLs with the
    `NULLS NOT DISTINCT` that was already there — `play_source` is nullable, so deleting the
    coalesce without it would have let every NULL through and made the guarantee partial in exactly
    the cases most likely to be real. `lower()` is IMMUTABLE and `coalesce()` is a SQL construct, so
    neither is a problem.
  - ✅ **Dry-run before migrating:** `npm run db:verify-index-expr` builds each expression on a
    throwaway table with the real column types. It reproduces the exact 42P17 on the old expression
    and builds the new one. A syntactically valid migration is not a working one.
  - ✅ Applied: `migrate resolve --rolled-back` → `migrate deploy` → *"All migrations have been
    successfully applied."*
  - ✅ **Proven, not assumed** — `npm run db:verify-constraint` writes inside a transaction and
    rolls back. Control (identity shifted 1 second) **accepted**; exact duplicate **REJECTED with
    23505**. Both rolled back; 303,424 rows unchanged.
  - ⚠️ The control was rejected on the first attempt because the test assumed a new `user_play_id`
    would make a row distinct. It does not — the identity deliberately excludes the id, so two
    scrobbles of the same track in the same second are one play **whatever their ids**. That is
    the intended trade-off, and the test now documents it instead of hiding it.
  - `20260928000000_user_plays_dedup_cleanup` — the DELETE. A no-op on current data; kept so a
    drifted copy can be repaired by the same file.
  - `20260928010000_user_plays_dedup_index` — `CREATE UNIQUE INDEX CONCURRENTLY ... NULLS NOT DISTINCT`
  - `** THAT FILE MUST HOLD EXACTLY ONE STATEMENT. Prisma decides transaction-wrapping by statement
    arity: one statement runs outside a transaction so `CONCURRENTLY` works; two statements get
    wrapped and it fails with 25001 "cannot run inside a transaction block". The DELETE is in its own
    file for exactly this reason, and the index file says so at the top.
  - `NULLS NOT DISTINCT` is load-bearing, not decorative: without it NULLs are distinct, so a null
    `track_name` or `play_source` would slip past and the guarantee would be partial in exactly the
    cases most likely to be real. Host is PostgreSQL 18.6.
  - ⚠️ **Comment in the index file is misleading and should be corrected when it is fixed.** It
    claims the single-statement rule is the load-bearing thing and that failure would be 25001
    "cannot run inside a transaction block". The real error was **42P17**, not 25001. The
    single-statement rule is still worth keeping, but it is not what broke.

  Two things the script had to get right, both found by running it rather than reading it:
  - a plain string interpolated into a `$queryRaw` tagged template is bound as a **parameter**,
    not inlined, so the fragment must go through `Prisma.raw` or the query dies on a syntax error
  - Postgres rejects aggregating `user_id` when it only appears inside a larger `GROUP BY`
    expression, so the detail queries group in a subquery; and an aggregate over an empty derived
    table returns one all-null row, which reads like a data problem rather than its absence

### Phase 2 — test where the product lives
- **2.1** ✅ `f062fc9` + `1d46170`. Real coverage is **49.00%**, not the 48.5% claimed — and not
  the 46.5% I first measured either. Two config bugs: `all` defaults to false, and the exclude
  globs used `/` so on Windows **141 test files were counted as untested product code**.
  A third: **14 deleted files** survived as source-map sources under `dist/` and were scored 0%.
  Ratchet verified to block. Thresholds now lines/statements 49, branches 68.5, functions 50.
- **2.2** 🔄 **This session: 3 core files, 154 tests, all mutation-checked.**
  - `lastFmRepository.contract.test.ts` — **85 tests. 11.92% → 93.57% lines, 12% → 100% functions.**
    Covers auth, user info, the retry path, info lookups, search, friends, all three top-list
    families (both the period and weekly-chart branches), scrobble counts, milestones, loved
    tracks and the three signed writes. Also lifted the three converters it exercises:
    `infoConverter` 8.33→91.66, `topListConverter` 60.43→94.5, `userConverter` 17.39→95.65.
  - `playcountCommands.target.test.ts` — **20 tests. 18.33% → 28.96% lines.** The text target
    grammar: `<@id>` and `lfm:name` mentions, the `userId: 0` sentinel for an unregistered
    target, mention-beats-lfm precedence, and the whitespace collapse. **4 mutations, all caught.**
  - `whoKnowsCommands.guard.test.ts` — **24 tests. 16.44% → 35.73% lines.** Guild-only guards,
    the documented `whoKnowsArtistForName` verbatim-name entry point (the "Page" band incident),
    the `img`/`nf` grammar, and `splitArtistTitle`. **2 of 3 mutations caught; the third is
    provably equivalent** — `byIndex > 0` → `>= 0` is unreachable because the inner
    `if (title && artist)` already rejects the empty title that `slice(0, 0)` produces.
  - ⚠️ **Two of my own tests were wrong and the real API proved it** (AGENTS.md §11).
    I asserted `album.getinfo` durations were milliseconds; probed live, they are **seconds**
    (`Airbag` = `284`, a number) while `track.getinfo` is milliseconds (`"284000"`, a string).
    `infoConverter` divides only on the track path, so both conversions are correct and a
    "make them uniform" refactor would break the album one. The test now documents the
    asymmetry so nobody tidies it into a bug.
  - ⚠️ **I claimed the 13-arg constructor made a swapped stub a TS2345. It does not.**
    `deps` is `Record<string, unknown>`, so every position accepts every stub. Injecting the
    swap compiled clean and was caught by **12 tests** instead. Comment corrected to say so.
  - Remaining: `crownInteractions`, `countryInteractions`, and the rest of the 34-file
    text-command layer, which still has **zero** test files. Target ≥60% per file, global ≥60%.
- **2.3** ⬜ Not started.
- **2.4** ✅ Split the suite so the unit run needs no browser. Measured rather than trusted: the
  plan said 7 browser tests, and **3 files** actually launch Chromium —
  `chartService.render.test.ts` (x2) and `whoKnowsGenerator.render.test.ts`. The two
  `puppeteer*.test.ts` files **mock** `launchBrowser`, so they stay in the unit suite.
  - `npm test` = 1203 unit tests, no Chromium. `npm run test:render` = 9 render tests.
  - New `render` CI job, so a missing browser fails that job and not everything else.
  - **Coverage consequence, handled deliberately:** excluding the render files dropped the
    measured baseline a full point, because they cover real product code. The ratchet is now set
    on the unit-only figure (lines 48.21%) and the comment says why, so it stays reproducible on
    a machine with no Chromium. `vitest --render` is not a real flag; the separate
    `vitest.render.config.ts` is what works.

### Phase 3 — architecture
- **3.1** ✅ **DONE — and the plan's premise was wrong.** `npm run deps:cycles` + a blocking
  `deps` CI job, both budgets mutation-checked. `scripts/cycle-budget.json` is written each run.
  - **Runtime cycles: 0.** Budget 0. **All-cycles: 4.** Budget 4.
  - The plan said "4 circular dependencies to break". Measured: **all 4 have an `import type`
    on one side**, which TypeScript erases. They are type-level coupling, not load-order risk.
    Evidence: `commandDispatcher`→`userService`, `autopostRepository`→`autopostService`,
    `descriptionChapters`→`ytResolver`, `musicService`→`playlistChunkManager` are all `import type`.
  - A type edge is legal and normal when a DTO lives beside the implementation that produces it
    (e.g. `VideoChapterDto` in `ytResolver`). Refactoring these would be churn, not a fix.
  - **So there is no 4-cycle problem to solve.** The real constraint is the zero-runtime-cycle
    budget, which holds. The 4 are a separate, softer number, ratcheted so they cannot grow.
  - Mutation-checked: injecting a real value-import cycle takes runtime 0→1 and the check FAILS;
    lowering the total budget to 3 FAILS. Restored, it passes.
- **3.2** ✅ ESLint `no-restricted-imports` overrides written, scoped to exactly the two boundaries
  that caused pain: the music DAG (§9 rule 9) and leaf `musicTypes`. Deliberately NOT a
  repo-wide ban on `commandDispatcher` — the `userService`↔`commandDispatcher` edge is a
  type-only edge that is already correct; banning it would force churn for no safety gain.
  `lint` 0 errors.
- **3.3** ✅ `scripts/count-debt.ts` + `npm run debt` + blocking `debt` CI job.
  One number per debt kind against a recorded budget that may only go down.
  - `explicit-any` 136 (budget 136), `typed-catch` 0 (budget 0). AST-based via
    `ts.Program`, so a string containing `: any` is not counted and test files
    are excluded (tests legitimately cast).
  - Note: the AST count is **136**, not the 140 quoted from the earlier regex
    count. The regex over-counted. Budget set to the real number — a budget that
    is aspirational is the same failure as no budget.
  - Mutation-checked both ways: injecting one `export const x: any` → 137, FAILS.
    Restored → 136, passes.
  - `ts.isAnyKeyword` is internal and not exported by every TS version; the
    check uses `ts.SyntaxKind.AnyKeyword` after that threw.
- **3.2 (plan's 3.2) — lower layers must not import `@bot/*`** ✅ **Value imports 4 → 0.**
  Type-only imports remain (4, below) and are enforced by test.
  - ✅ `isPlaceholderImageUrl` → `src/domain/lastfmPlaceholder.ts`. `recentTrackConverter` was
    pulling in the whole artwork cascade — Spotify, Deezer, Apple, Prisma, cache — to ask
    whether a string was a known hash. `artworkService` re-exports it, so **20 call sites
    changed zero lines** (the §6 facade pattern). A test asserts **identity**, not behaviour:
    `expect(as.isPlaceholderImageUrl).toBe(p)`. Behaviour tests would pass with two copies,
    which is the exact failure rule 2 prevents.
  - ✅ `ICache` port (`get`/`set` only — the consumer calls nothing else) + `ICACHE` string
    token. `CacheService implements ICache`; binding made once in `startup.ts`.
    ⚠️ `LastFmRepository` is **only** container-resolved, never constructed directly — so a
    missing binding throws in production and no unit test notices. One test registers the
    token itself and therefore passes even with the binding deleted; a **second** test reads
    `startup.ts` and fails if the line goes. That second one is the load-bearing one.
  - ✅ `ITelemetry` port. `lastfmApi` was doing `container.isRegistered(TelemetryService)` then
    `container.resolve(...)` **from a lower layer at a call site** — the exact hybrid DI the
    plan's 3.3 targets. Now constructor-injected. `LastfmErrorRateTracker` likewise.
    ⚠️ tsyringe 4.10 has **no `@optional()` decorator**; it infers optionality from `?` in
    the type. Writing `@optional()` is a compile error in this version.
  - ✅ `ConfigData` → `src/config/configData.ts`, imported as `@config/configData`. 11 bot-layer
    files keep the old path via a one-line re-export shim; rewriting 11 working imports buys
    nothing.
  - ✅ Removed a **module-scope side effect**: `lastfmApi.ts` opened with
    `dns.setDefaultResultOrder(...)` inside a `try`, which is a global mutation firing on
    import — including in tests that import the module for unrelated reasons. `bot/index.ts`
    already did it properly as an entrypoint.
  - ⬜ 4 `import type` remain (autopostRepository, iceberg/whoKnows/worldMap generators). Erased
    at compile time, same finding as the 3.1 cycles. Now **excluded** from the invariant test
    rather than silently ignored.
- **3.3 (plan's 3.3) — one DI style** 🔄 **Eager `container.resolve` is now 0.** Total outside
  the composition roots: 296 → **155**, all of it lazy and method-level.
  - ✅ Budgets, all CI-blocking via `npm run debt`:
    `container-resolve-in-constructor` **0** · `container-resolve-outside-root` **155** ·
    `explicit-any` **136** · `typed-catch` **0**
  - ✅ Converted: `interactionHandler` 37, `commandHandler` 11, `artistInteractions` 7,
    `startupService` 6, `topInteractions` 3, `userEventHandler` 2, `artistTrackInteractions` 2,
    `clientLogHandler` 3, `trackPreviewInteractions` 1, `imageUploadService` 1.
    All now `@injectable()` + `@inject()` parameter properties, resolved by `startup.ts`.
  - ✅ Two debt kinds, not two scripts — the whole reason `count-debt.ts` exists. It **refused
    to invent a budget** for each new kind and demanded `--set`.
  - ✅ `--where` prints offenders. A ratchet you cannot locate is a ratchet you cannot act on,
    and it is what found the two leftover resolves described below.
  - ✅ Module-scope `dns.setDefaultResultOrder` removed from `lastfmApi`; only the 3 real
    entrypoints keep it (`index`, `shardManager`, `shardWorker` — the last two are forked).
  - ✅ **3.3 target decision, made and settled.** The plan's `<30` for `container.resolve` is
    **not** the right target, and measurement is why. Ratchet the **eager** count at **0** (done) and
    treat the 155 lazy total as **informational**. Converting lazily-resolved services would *cost*
    startup work for features that may never run — `fmFooterResolver` resolves `PrismaClient` only
    when the "artist plays" footer is on. The debt the plan described (eager construction hiding the
    wiring graph) is gone; driving the total to 30 anyway would be a number, not an improvement.
- **Phase 4 — type safety** 🔄 Baselines now measured and ratcheted, all CI-blocking:
  `explicit-any` **135** · `as-unknown-as` **106** · `typed-catch` **0** → **combined 241**
  (plan's baseline was ~302, target < 80).
  - ✅ `as unknown as` is a first-class debt kind, not a grep. AST-based, so a cast inside a
    string or comment does not count.
  - ✅ `src/domain/interfaces/discordChannel.ts` — one checked narrowing boundary
    (`replyChannel` / `typingChannel` / `fetchableChannel`) replacing **11** inline casts in
    `commandHandler` + `commandDispatcher`. Those casts existed so tests could pass `{ send: vi.fn() }`
    instead of a channel — production code contorted to suit the double, AGENTS.md §11. Downstream
    callers now get a real type, so a payload-key typo is a compile error.
  - ✅ A test caught a bug in the new helper: `has(ch, 'messages')` failed every real channel,
    because `messages` is an object and the helper only knew how to test functions.
  - ⬜ Remaining hotspots per the plan: `artistBuilders` 10, `crownInteractions` 8,
    `artistInteractions` 7, `topInteractions` 6, `trackSlashCommands` 6. Most are Prisma results →
    `Prisma.XGetPayload<>` or a typed row interface. Of the 106 `as unknown as`, 72 are under
    `src/bot/services/music` and `handlers/music`, where the plan permits them (moonlink's published
    types do not match its runtime payloads); the honest next move is to consolidate those into the
    one `music/moonlinkTypes.ts` adapter the plan asks for, not to delete them.
- **3.4** ⬜ Not started. Measured: Prisma is called directly in 20+ files under `bot/`, and the
  plan explicitly says **not** to mass-move. This is enforced going forward instead.
- **3.5** ✅ `src/images/html.ts` with a tested `escapeHtml` and `safeUrl`. 15 tests.
  - 4 drifted copies collapsed to 1: `chartService`, `whoKnowsGenerator` (free functions removed)
    and `icebergGenerator` (its method now delegates to the shared one).
  - **Honest severity, not inflated:** the gap was **latent, not live**. All current attributes
    are double-quoted (`src="${...}"`), so the three copies that stopped at `"` could not be
    broken out of. The drift only becomes stored XSS the day someone writes `href='${...}'`.
    Consolidating removes the question; it did not fix an exploit.
  - `safeUrl` is **not** "https only" as the plan specified, because https-only breaks this
    codebase: `receiptGenerator` builds `data:image/png;base64,...` at runtime and the render
    tests feed 1x1 `data:image/gif`. So: https, or `data:image/(png|jpe?g|gif|webp)`.
    `data:image/svg+xml` and `data:text/html` rejected — SVG carries script.
    Plain `http` rejected as mixed content.
  - A test caught a real gap on first run: `https://ok.example https://evil.example` passed a
    naive `startsWith('https://')` while smuggling a second absolute URL. `safeUrl` now rejects
    any URL containing whitespace. Mutation-checked — removing the guard fails the test.
### Phase 4 — type safety: 🔄 earlier work took `any` 392 → **136** (AST-measured, see 3.3)
### Phase 5 — security and ops: ⬜ nothing started

## Definition of done: see the checklist at the bottom of `PLAN_B_PLUS_TO_A.md`.

## Bugs found and fixed so far

| Bug | How it was found |
|---|---|
| Migrations never ran on Railway | Reading 4 start commands; `startCommand` overrides `CMD` |
| Weekly charts rendered "NaN plays" | New test; converters had **zero** coverage |
| 5 unguarded Components V2 payloads posting `[undefined]` | Asking why an `as any` existed |
| Paginator jump left a permanent spinner | New test; same `[undefined]` class, never generalised |
| `crownInteractions` put a button in the *slash* context field | Suspicious cast; would throw on any `.options` read |
| Pool timeouts never retried | Test used the **real** Prisma string; `"Timed out"` vs `includes('timed out')` |
| Delta-sync + index locks raced | Reading the guard; both were check-then-set |
| Dead-air class had no invariant test | Reading `onTrackStuck`'s 8 exit paths |
| Both page-jump modals raced Discord's 3s window | Reading the handler; they awaited Last.fm first |
| Production has **0 duplicate plays** in 303,424 rows | Task 1.2 measurement — the premise was right, the data is clean |
| The 4 import "cycles" were **0 runtime cycles** | madge counted `import type` edges; 3 were type-only, the 1 real one was a constant imported from the wrong module |
| `safeUrl` accepted `https://a https://b` | A hostile-input test written before the guard — not by reading the code |
| Two "cycles" below `bot/` were one predicate in the wrong layer | Plan 3.2 named the file; reading the import showed a whole artwork cascade pulled in to test a hash |
| `lastfmApi` mutated DNS on **import** | Writing the side-effect invariant; `bot/index.ts` already did it at the entrypoint |
| A missing `ICACHE` binding would have thrown in production only | `LastFmRepository` is container-resolved, never constructed — so a test registering the token passes even with the binding deleted |
| `shardManager`/`shardWorker` also set DNS order | Invariant caught them; they are real forked-process entrypoints, allowlisted by name with the reason |
| `commandDispatch.test.ts` passed with its 11 constructor args **in the wrong order** | Swapping two stubs left it 2/2 green — the inline `as never` literals made every argument mutually assignable. Fixed by naming each stub with its real type, so a swap is now TS2345 |
| A codemod reported "converted 37" having removed nothing | Signature rewrite succeeded, assignment-removal regex matched nothing, and the result still compiled. The debt ratchet was the only thing that noticed |
| Two files I had *just* converted still had a `container.resolve` in the constructor | `--where` on the ratchet. Assigning to a parameter property compiles, so the build stayed green both times |
| A new ratchet kind reported 6 eager resolves; **one was a false positive** | `topInteractions` registers an async modal handler *inside* its constructor, so a resolve inside that arrow runs on click, not at construction. Added a function boundary the traversal will not cross |
| **Production migration FAILED** — `user_plays_identity_uniq` never created | `prisma migrate status` said "Following migration have failed". Probed the live DB to confirm the index was genuinely missing rather than just unrecorded |
| The dedup index failed with **42P17**, not the 25001 the file's comment predicted | Reading Prisma's own `_prisma_migrations.logs` via `npm run db:migration-logs`. The comment's transaction theory was wrong |
| The P3009 **took the whole bot down**, not just the migration | `npm start` is `migrate deploy && node dist/bot/index.js` — a non-zero exit from the first half never reaches Discord. Diagnosing "a migration failed" understated it |
| A control insert in the constraint test was rejected | Assumed a new `user_play_id` makes a row distinct. The identity deliberately excludes the id, so it does not. The test now shifts the *identity* instead |
| `album.getinfo` and `track.getinfo` disagree on the duration unit, and the code is right | A new test asserted both were ms. Probed the live API: album `284` (number, seconds), track `"284000"` (string, ms). A "unify these" cleanup would have introduced a real bug |
| `artworkService` had 3 lint errors nobody ran | `--quiet` in the gates after a new ESLint rule |

## Mistakes I made, so they are not repeated

1. **Claimed modals have no `update()`.** They do — it exists on the runtime prototype, just not
   in the typings. My *test double* was the lie. Read the runtime, not just the type.
2. **Mutation script reported "all caught" for mutations that never applied.** It parsed stdout
   vitest writes to the *terminal*. Read exit codes, and treat `SKIP` as "not tested", not
   "not applicable".
3. **A fixture I invented contradicted production.** I assumed `nowplaying === '1'`; Last.fm sends
   `"true"`. The code was right, the test was wrong. Check the vendor spec.
4. **Set a ratchet on a number produced by broken coverage config** (34.67% vs the real 49%).
5. **Left a half-finished change that broke the build**, then had to revert. Do not start a
   refactor I cannot finish in the current budget.
6. **Unanchored mutation anchors silently prove nothing** — a `SKIP` reads as "not applicable".
   Dump the real substring first, then paste it.
7. **Anchors guessed from memory missed** because of indentation and line endings. Normalise and
   copy verbatim.
8. **A green suite with exit code 1** (unhandled rejection) — chased it instead of rerunning.
9. **Read the log, not the exit code you captured.** `%ERRORLEVEL%` inside a `cmd /c` chain is the pre-run value. This is mistake 1 again, and it nearly made me report a working ratchet as broken.
10. **A comment asserting a safety property is a claim, not a fact.** I wrote "a swapped stub is a TS2345" and only tested it because I was suspicious. It compiled clean.

## Rules that worked

- Measure, then change. Twice the "bug" was in my measurement, not the code.
- Test the **real** class, never a stub that pretends to be the thing under test. That is what
  caught the `setNX` delete-on-exist bug.
- Mutation-check every new test. Roughly a third of my first drafts were decoration.
- When a mutation is genuinely equivalent, **document it as equivalent** instead of inventing a
  test that cannot distinguish it.
- **`cmd /c "... & echo %ERRORLEVEL% > f"` reports the WRONG exit code.** The variable expands at parse time, before the command runs, so a failing coverage ratchet read as exit 0 and I nearly "proved" the ratchet does not block. Use `cmd /v:on` with `!ERRORLEVEL!`, or read the vitest log for the threshold error.
- A passing `vitest` run and a passing `tsc` are different claims. The new test files were green on all 1373 tests and still failed the build 4 times (optional `aliases`, a non-tuple spread, `args` required). `npm run build` is not optional.
- Per-file sweep with revert-on-error beats one batch. A single 15-site batch reported "5 errors"
  and would have discarded 10 real wins over 5 deliberate casts.
