# Code quality review — tvbot

Date: 2026-09-27 · baseline `main` · 123 test files / 961 tests · 376 production `.ts` files / 66,709 lines

## Verdict

**A−, trending A.** The architecture and the incident discipline are genuinely above what
most private bots reach — better than most public ones. What was missing was **hygiene at
scale**: type escapes, an untested command layer, and zero automated enforcement of the
rules the project already wrote down for itself.

Since the first pass of this review the following are done:

- **Puppeteer profile leak fixed** (was 186 orphaned profiles / 1.36 GB) with a
  mutation-checked test.
- **ESLint errors: 143 → 0**, and the CI lint job is now blocking instead of
  `continue-on-error`. Diagnosis mattered more than the count: of 127 unused-vars, 104 were
  imports, 2 were correct idioms the *rule* was wrong about, 2 were a real latent bug
  (`PrivacyLevel.Global === PrivacyLevel.Default` was **true**), and the rest were scattered.
- **Command registry invariants added** — 8 tests that make the silent `.remove` / `.lyrics`
  collision class impossible, mutation-checked to prove they can fail.
- Remaining for a full **A**: item 4 below (the builder service-locator cleanup) is the one
  piece not done, and it is deliberately not done blind — see the note there.

## Method, stated honestly

This is a **measurement-led review**, not a line-by-line read of 66,709 lines. Every claim
below is backed by a count, a grep, a measured number, or a spot-read of the file named.
Where I sampled rather than read, it says so. Ratings are therefore assigned per subsystem
and per named file, not fabricated individually for 376 files.

## Measurements

| Metric | Value | Read |
|---|---|---|
| Production `.ts` files | 376 | fine |
| Total production lines | 66,709 | fine |
| **Median** file length | **112** | **excellent** — no god files left |
| Files over 1,000 lines | 1 (`musicService.ts`, 1268) | acceptable, see below |
| Test files / tests | 123 / 961 | good |
| **`@ts-ignore` / `@ts-nocheck`** | **0** | **excellent, rare** |
| Explicit `any` | 392 | the main type-safety debt |
| Lint | **0 errors**, 731 warnings | enforced in CI now |
| `TODO`/`FIXME`/`HACK` | 4 | clean |
| `container.resolve` in builders | 45 | layering violation (remaining item) |
| `catch` clauses | 589 | 0 bound-but-unused; degradation is quiet by design |
| Dead Puppeteer profiles on disk | 0 (was 186 / 1.36 GB) | fixed |

## Test coverage by subsystem — the real gap

| Subsystem | Source files | Test files | Note |
|---|---|---|---|
| `src/bot/builders` | 37 | 24 | healthy |
| `src/bot/services` | 101 | 54 | healthy |
| `src/bot/services/music` | 24 | 17 | healthy |
| `src/bot/handlers` | 16 | 6 | thin, but the hard parts are covered |
| `src/persistence/repositories` | 17 | 3 | thin |
| `src/lastfm` | 12 | **1** | thin |
| `src/bot/slashCommands` | 34 | **1** | **uncovered** |
| `src/bot/textCommands` | 35 | **0** | **uncovered** |

69 command files with one test between them. This matters more than the raw ratio suggests,
because the command layer is where the **name-collision** bugs lived (`.remove`, `.lyrics`),
and those ship silently — the registry logs a warning and lets the later registration win.

## Ranked findings

### 1. ~~Puppeteer leaks a profile directory per locked launch~~ FIXED
`src/images/generators/puppeteerService.ts:158` created `worker-<pid>-<timestamp>` and never
removed it. Measured on this machine: **186 orphaned profiles, 1.36 GB**, one per tsx-watch
restart that hit the profile lock.

Fixed: one path per process (so a restart reuses rather than accumulates) and removal when
the browser that owns it disconnects or the process exits. Cleanup swallows its own errors �
a locked file must not take down a screenshot or the exit path � and only ever touches the
fallback, never the primary profile. Five tests cover reuse, cleanup, primary-profile
survival, the locked relaunch, and dev rethrowing instead of degrading; mutation-checked, so
restoring the old behaviour fails 2 of the 5.

The original code comment blamed "the `.puppeteer` lock", which described the trigger rather
than the defect.

### 2. ~~The command layer is untested~~ ADDRESSED
Was 35 text files with 0 tests and 34 slash files with 1.

`src/tests/commandRegistryInvariants.test.ts` now reads the definitions from source via the
TypeScript AST � no container, no network � and asserts: no two text commands share a name,
no name or alias contains a dot or space, the top-level slash names are unique, and the
historically-stolen names are owned by the right modules.

The test **counts what it found and throws if any name is not a string literal**, because a
source-scraping test that matches nothing passes for the wrong reason � the exact trap that
made the old chapter invariant test worthless. That guard fired on its first run and caught
two false-positive shapes.

Two live findings are **pinned, not silently fixed**, because both are behaviour decisions:

- **`np` and `rm` are each an alias of two commands** � the Last.fm `fm` command and the
  music `nowplaying` / `remove`. Which wins is decided by module order in
  `textCommands/index.ts`, not by intent, so `.rm` may currently be answering as the Last.fm
  `fm` command. Worth the maintainer's decision.
- **`countryInteractions:66` and `genreInteractions:61` parse a `pageIndex` out of the
  button customId and never use it.** If those buttons are meant to paginate, they always
  show page 0.
- **`topSlashCommands:79` reads the `user` option into `rawUser` and never uses it.** That
  option may be doing nothing.

### 3. Builders reach into the DI container - 45 call sites, NOT DONE
`src/bot/builders/topBuilders.ts` (13), `src/bot/builders/whoKnowsImageBuilder.ts` (11)

A builder that calls `container.resolve` is doing service-locator work inside what should be
a pure formatting function. This is why `whoKnowsImageBuilder` is still 387 lines and still
writes to the database from a builder. It also makes those builders untestable without a
container.

Fix: pass resolved services in as parameters (builders already receive data from callers),
or introduce a thin `WhoKnowsImageDeps` bundle. This is the same facade move that took
`musicHandler` from 2,115 to 565 lines.

### 4. Type-safety debt: 392 explicit `any`
`@typescript-eslint/no-explicit-any` accounts for 730 of the warnings. Most are at
`moonlink` boundaries where the upstream types are genuinely incomplete — defensible. But
zero `@ts-ignore` while carrying 392 `any` means the escapes are at least visible and
localised, which is the good version of this problem. Do not mass-fix; fix them where a real
type is cheap, and leave a comment where the upstream type is the real blocker.

### 5. ~~127 lint errors~~ RESOLVED - 0 errors
`@typescript-eslint/no-unused-vars` (127), `prefer-const` (12),
`no-duplicate-enum-values` (2), `no-require-imports` (2)

127 unused-vars is not plausibly 127 real dead variables — handlers implementing an
interface signature will produce unused parameters by design. Configure
`argsIgnorePattern: '^_'` and `varsIgnorePattern`, re-measure, and only then fix what is
genuinely dead. `prefer-const` and the rest are `--fix`-able today. **Do this before any
other lint work**, because a 143-error baseline is why CI lint has to be
`continue-on-error`, and a job that always fails is a job nobody reads.

### 6. `musicService.ts` at 1,268 lines — acceptable, do not split again
The remaining content is cohesive play-path orchestration: `play`, the five input-kind
branches, `enqueueLavalinkTracks` (the single enqueue choke point), the pending-queue
top-up, and `getQueueInfo`. Splitting further would raise fan-in for no behavioural gain,
which is exactly what `AGENTS.md` §6 warns against. Leave it.

### 7. Error handling — measured, and better than this review first claimed
The first version of this review said "185 `catch (err)` blocks that bind an error but never inspect it" and ranked it as a top-five item. **That was wrong**, and the audit says so:

| Population (589 production catch clauses) | Count |
|---|---|
| Bind an error, and every one inspects it | 225 |
| **Bind an error and never use it** | **0** |
| Bind nothing (`catch {`), of which only 2 log | 364 |
| — of those, comment-only blocks (deliberate) | 178 |

So the failure mode I predicted does not exist, and the real shape is different: the
codebase degrades *quietly by design* rather than by accident. A missing cover falls back,
a failed lookup returns `null`. That is largely correct behaviour.

The actionable part is enforcement, not rewriting: `no-empty` is now a lint warning so a
newly-introduced truly-empty catch is flagged, and the reasoning is recorded in
`eslint.config.mjs`. **Deliberately not done:** adding logging to the ~180 unlogged
degradation paths. AGENTS.md golden rule 10 exists because INFO noise hides the greps in
§9; hundreds of DEBUG lines per normal request would destroy the runbook this project
depends on.

## What is genuinely excellent — do not regress it

- **Zero `@ts-ignore`/`@ts-nocheck` across 66,709 lines.** Most projects have hundreds.
- **Median file length 112 lines.** The god-file problem is actually solved.
- **The playback module is a strict DAG** with type-only imports at the cycle boundaries.
- **The incident record is written down**: `AGENTS.md` §9/§10/§11 encode real root causes
  with the log line to grep and the date measured. That is rarer and more valuable than any
  amount of new architecture.
- **A test proved it had teeth by mutation-testing a rival test into uselessness** and the
  weaker test was deleted rather than kept.
- **`README`/run commands, `.env.example` and a boot-time env validator** exist, so a new
  machine can actually run the thing.

## The five moves, and where they stand

| # | Move | Status |
|---|---|---|
| 1 | Fix the Puppeteer leak | **done** — 1.36 GB reclaimed, mutation-checked |
| 2 | Lint to zero, un-`continue-on-error` CI lint | **done** — start with the rule config, not 127 edits |
| 3 | Registry invariants for the command layer | **done** — mutation-checked, loud-failure design |
| 4 | Remove `container.resolve` from the builders | **not done, deliberately** — see below |
| 5 | Audit the `catch` blocks | **done, and it overturned the premise** — see finding 7 |

### Why move 4 is not done blind

45 `container.resolve` / `isRegistered` call sites across `topBuilders.ts` (11) and
`whoKnowsImageBuilder.ts` (12), each wrapped in an `isRegistered` guard so the builders work
without a full container.

Threading eight-plus services through every builder signature and updating every call site
is a large change to code whose only real verification is a live browser, a network round trip
and a Puppeteer render. There is no test that can tell a working image builder from a
subtly broken one, and the existing coverage for both files is a smoke test. The project's
own rule — *measure, then optimise; do not refactor speculatively* — argues against doing it
unverified.

**Safe intermediate step if you want progress without risk:** the pattern is uniform
(`if (container.isRegistered(X)) { const x = container.resolve(X); ... }`). Extracting a
single `tryResolve(X)` helper into a leaf module changes no behaviour, makes the service-locator
usage one file instead of 45 call sites, and turns the eventual real refactor into a mechanical
one. That is worth doing. The refactor itself needs a live run to verify.

## Where this leaves the grade

**A−, and the remaining gap is a single well-understood architectural item plus a judgement
call on three findings that need the maintainer, not a coder.** None of the remaining work is
mystery — each has a measurement, a cause and a plan attached, which is the actual difference
between an A and a B+.
