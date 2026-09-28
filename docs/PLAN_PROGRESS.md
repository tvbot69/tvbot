# Progress: B+ → A

Plan: `PLAN_B_PLUS_TO_A.md`. Read both before starting work.
**Update this file at the end of every task**, before the commit.

## Current numbers (re-measure, don't trust this table)

| Metric | Start | Now | Target |
|---|---|---|---|
| Tests | 1085 | **1212** | — |
| Line coverage | 48.5% claimed / **49.00% measured** | **49.26%** | ≥65% |
| Branch coverage | 68.6% claimed | **68.72%** | — |
| `as any` / `as unknown as` / `: any` (prod) | 139 / 116 / 47 | see `scripts/count-debt.ts` | <80 combined |
| `catch (err: any)` | 37 | **0** | 0 |
| `container.resolve` outside composition root | ~300 | not yet measured | <30 |
| Import cycles | 4 | not yet measured | 0 |
| Lower layers importing `@bot/*` | 6+ | not yet measured | 0 |
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
- **1.2** 🔄 **Step 1 DONE, step 2 WRITTEN (not applied).**
  *Step 1:* `scripts/count-duplicate-plays.ts` (`npm run db:count-duplicates`), read-only.
  **Measured against production 2026-09-28: 303,424 plays, 0 duplicate keys, 0 extra rows,
  0 users affected.** So no cleanup data fix is needed and the unique index can go in directly.
  *Step 2:* two migration files, ready but **NOT applied** — apply deliberately:
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
- **2.2** 🔄 6 files done. Remaining: `lastFmRepository` (14%), the text-command layer
  (`playcountCommands` 18%, `whoKnowsCommands` 16%), `crownInteractions`, `countryInteractions`.
  Target ≥60% per file, global ≥60%.
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
- **3.4** ⬜ Not started.
- **3.5** ⬜ Not started.
### Phase 4 — type safety: ⬜ nothing started (note: separate earlier work took `any` 392 → 140)
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

## Rules that worked

- Measure, then change. Twice the "bug" was in my measurement, not the code.
- Test the **real** class, never a stub that pretends to be the thing under test. That is what
  caught the `setNX` delete-on-exist bug.
- Mutation-check every new test. Roughly a third of my first drafts were decoration.
- When a mutation is genuinely equivalent, **document it as equivalent** instead of inventing a
  test that cannot distinguish it.
- Per-file sweep with revert-on-error beats one batch. A single 15-site batch reported "5 errors"
  and would have discarded 10 real wins over 5 deliberate casts.
