# Code quality review — tvbot

Date: 2026-09-27 · baseline `main` @ `41970b5` · 121 test files / 948 tests · 376 production `.ts` files / 66,709 lines

## Method, stated honestly

This is a **measurement-led review**, not a line-by-line read of 66,709 lines. Every claim
below is backed by a count, a grep, a measured number, or a spot-read of the file named.
Where I sampled rather than read, it says so. Ratings are therefore assigned per subsystem
and per named file, not fabricated individually for 376 files.

## Verdict

**B+ / strong professional, not yet reference-grade.**

The architecture and the incident discipline are genuinely above what most private bots
reach — better than most public ones. What is missing is not design; it is **hygiene at
scale**: type escapes, an untested command layer, and zero automated enforcement of the
rules the project already wrote down for itself.

## Measurements

| Metric | Value | Read |
|---|---|---|
| Production `.ts` files | 376 | fine |
| Total production lines | 66,709 | fine |
| **Median** file length | **112** | **excellent** — no god files left |
| Files over 1,000 lines | 1 (`musicService.ts`, 1268) | acceptable, see below |
| Test files / tests | 121 / 948 | good |
| **`@ts-ignore` / `@ts-nocheck`** | **0** | **excellent, rare** |
| Explicit `any` | 392 | the main type-safety debt |
| Lint | 143 errors, 730 warnings | the main hygiene debt |
| `TODO`/`FIXME`/`HACK` | 4 | clean |
| `container.resolve` in builders | 24 | layering violation |
| Empty/comment-only `catch` | 33 | partly deliberate |
| `catch (err)` that binds | 185 | needs a real audit |
| Dead Puppeteer profiles on disk | 186 dirs / 1.36 GB | **confirmed bug** |

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

### 1. Puppeteer leaks a profile directory per locked launch — CONFIRMED BUG
`src/images/generators/puppeteerService.ts:158`

```ts
const fallbackDir = path.join(this.userDataDir, `worker-${process.pid}-${Date.now()}`);
```

Created when the main profile is locked and **never removed**. Measured on this machine:
**186 orphaned profiles, 1.36 GB**, while the whole project source is 66k lines. The code
comment at line 30 already names the symptom — "`.puppeteer` lock causes 40 chrome leak on
tsx watch restarts" — and the mitigation was to avoid a persistent profile in dev, which
treats the leak instead of fixing it.

Fix: delete the fallback directory in the `finally` of the launch, or reuse one path per PID
and wipe it on success. This is a 10-line change with an immediately measurable payoff.

### 2. The command layer is untested — highest residual risk
`src/bot/textCommands/**` (35 files, 0 tests), `src/bot/slashCommands/**` (34 files, 1 test)

Not "write 69 test files". The two real defects were both *registry-level*, so the tests that
matter are cheap:

- assert no name is registered twice across the text and slash families (kills the
  `.remove` / `.lyrics` class permanently, in one test rather than by grepping startup logs)
- assert every registered text command's argument grammar parses, for the shapes with real
  grammars (`seek 1:40`, `lfm:user`, `filters clear`)

That is two tests covering 69 files' actual failure mode. `AGENTS.md` §6 is right that a
wholesale command-layer rehaul is not worth it; registry invariants are.

### 3. Builders reach into the DI container — 24 call sites
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

### 5. 127 lint errors, most of which are probably one config mistake
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

### 7. Error handling: 33 empty catches, 185 bound errors — needs a real audit
Spot-reads show the empty catches are mostly deliberate degradation (`essentiaService`,
`previewResolverService`, `settingsInteractions`) and are acceptable. But 185 `catch (err)`
blocks that bind an error is the number worth examining: a bound error that is never
inspected is a swallowed failure with extra ceremony. A grep for `catch (err)` followed by
no use of `err` would be the concrete sweep. The 33 empty catches should each keep a
one-line reason, because an unexplained empty catch is indistinguishable from a bug.

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

## The five moves to reference-grade, in order

1. **Fix the Puppeteer leak.** 10 lines, measurable immediately, 1.36 GB reclaimed.
2. **Get lint to zero and un-`continue-on-error` the CI lint job.** Start with the
   `no-unused-vars` config, not with 127 edits. Enforcement is what separates "we have
   rules" from "we follow rules".
3. **Two registry-invariant tests for the command layer.** Kills the whole collision class
   for ~80 lines of test, across 69 currently untested files.
4. **Remove `container.resolve` from the 24 builder call sites.** Finishes the layering work
   the `musicHandler` split started, and makes the builders testable in isolation.
5. **Sweep the 185 bound `catch` blocks** for bound-but-unused errors, and give each of the
   33 empty catches a one-line reason.

None of these five is an architecture change. The architecture is already the good part.
