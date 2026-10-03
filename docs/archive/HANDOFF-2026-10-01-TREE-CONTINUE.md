# Handoff — tree cleanup session, continue here

This is a continuation handoff for another app/session. It describes the repo state,
the unfinished render-agent work, and the exact next verification steps.

## Current repo state

- Branch: `main`
- HEAD:
  - `0075c5b` — tree conventions enforced/documented
  - `941ed51` — tree refactor, 461 files moved
  - `0eeefc8` — earlier live-bug/logger/voice-message work
- Tree commits after `0eeefc8` are local work; do not push unless explicitly asked.
- `IDEA.md` is untracked and unrelated; leave it alone.

### Tree conventions now in force

- Every test lives under an area-local `__tests__/` folder.
- No test files colocated with production files.
- Shared harness lives in `src/testSupport/`.
- Repo-wide invariant tests live in `src/__tests__/`.
- The old `src/tests/` tree is gone.
- `src/bot/services/` uses subsystem folders, including new `system/` and `lastfm/`.
- `src/bot/textCommands/` has no loose files; help/static are under `meta/`.
- A new `src/__tests__/treeConventions.test.ts` enforces these rules and is mutation-checked.

### Working-tree state at handoff

Tracked and modified, uncommitted:

- `src/applemusic/api/appleMusicSearchApi.ts`
- `src/applemusic/api/__tests__/appleMusicSearchApi.honesty.test.ts`
- `src/applemusic/models/itunesModels.ts`
- `src/bot/services/media/appleMusicService.ts`
- `src/bot/services/media/__tests__/appleMusicService.status.test.ts`
- `src/bot/textCommands/thirdParty/streamingCommands.ts`
- `src/bot/textCommands/thirdParty/__tests__/streamingCommands.links.test.ts`
- `src/bot/slashCommands/streamingSlashCommands.ts`
- `src/bot/slashCommands/__tests__/streamingSlashCommands.test.ts`

Untracked and relevant:

- `src/testSupport/renderPixelAssert.ts`
- `src/images/generators/__tests__/zzMeasure.render.test.ts`
- `IDEA.md` — unrelated, ignore.

## Gates and commands

Run in this order when verifying:

1. `npm run build`
2. `npx tsc --noEmit --incremental false`
3. `npm test`
4. `npm run lint`
5. `npm run debt`
6. Real Postgres separately: `npm run test:db`
7. Render separately: `npm run test:render`
8. Coverage when needed: `npm run test:coverage`

Important operational notes:

- `npm test` excludes `*.render.test.ts`; render tests need the separate render config.
- `TEST_DATABASE_URL` and `SHADOW_DATABASE_URL` must be supplied per command, not left in `.env`.
- The harness env file may contain surrounding quotes; strip them before exporting.
- Never print secrets or credentials.
- Keep production database variables away from local runs.
- If a build fails on a locked Prisma engine/DLL, stop the local bot first, then rebuild.
- Prefer early-exit log polling over fixed long sleeps.
- Do not run full gates inside parallel agent batches; one lead should run them.
- Never weaken or delete tests to make them pass.
- Mutation-check behavior fixes where feasible.
- Do not restore deleted legacy paths or features.

## Scratch tooling

Useful one-shot scripts already exist under `scratch/`:

- `scratch/genmoves.mjs`
- `scratch/moves.json`
- `scratch/relocate.mjs`
- `scratch/verify-specifiers.mjs`
- `scratch/startbot.ps1`
- `scratch/docker-compose.local.yml`
- `scratch/env.production.backup`
- `scratch/env.local.harness.txt`

`scratch/` is ignored; do not commit it. `token.txt` is also ignored; never print it.

## Finished but uncommitted: Apple/iTunes consolidation

A subagent reported that the suspected duplication was not in
`src/applemusic/api/appleMusicSearchApi.ts`. The actual problem was in
`src/bot/services/media/appleMusicService.ts`: three hand-rolled iTunes fetches that
returned `null` on non-OK responses, making upstream failures look like
"No Apple Music release found."

Reported outcome:

- One iTunes request path through `AppleMusicSearchApi`.
- New `ITunesUnavailableError` behavior for non-2xx/network failures.
- `null` reserved for genuine no-match.
- New `AppleLookup` discriminant: `found` / `miss` / `failed`.
- Command layers render `failed` as `Error` and `miss` as `NotFound`.
- `startup.ts` constructor shape reportedly untouched.
- New/changed tests reportedly pass in the four touched files.
- Mutation test reportedly fails correctly when a silent empty result is reintroduced.

Still required:

- Inspect the full diff.
- Run targeted Apple/streaming tests.
- Run all gates above.
- Verify artwork/preview consumers of `AppleMusicSearchApi`.
- Commit only after gates pass.

## Unfinished and currently stuck: render blind-spot work

The render suite historically passed while being unable to detect a blank chart.
A render agent began adding pixel-content assertions.

Current problem:

- These untracked files may belong to that incomplete attempt:
  - `src/testSupport/renderPixelAssert.ts`
  - `src/images/generators/__tests__/zzMeasure.render.test.ts`
- `src/testSupport/renderPixelAssert.ts` was reported to have TypeScript errors involving `sharp` and an implicit `any`.
- The following command floods output and appears to hang:

```powershell
npx vitest run --config vitest.render.config.ts 2>&1 | Select-String -Pattern "MEASURE|Test Files|Tests |Duration|FAIL" | ForEach-Object { $_.Line }
```

Observed behavior before hanging:

- Repeated render stdout lines.
- `MEASURE` lines for chart and whoknows images.
- A Spotify credential/config failure logged by the app.
- Output stalls after whoknows measurements.

Do not rerun that exact broad pipeline as the first step.

Recommended recovery:

1. Run `npx tsc --noEmit --incremental false` first.
2. Read both untracked render files and decide whether they contain any unique assertion worth keeping.
3. Treat `zzMeasure.render.test.ts` as a probe unless proven otherwise; do not promote it into the committed suite without review.
4. If pixel assertions are needed, implement them in the real render tests and mutation-prove:
   - blank output must fail;
   - non-blank but wrong output must also be caught where practical.
5. Revert every temporary mutation.
6. Ensure `git diff` shows only intended test changes before committing.

## Other open defect

Key detection remains unsound: Essentia can reportedly return a key for white noise
with high strength, while strength is dropped downstream. This needs a real-music
corpus and threshold/design decision, not a guessed fix.

## Immediate resume checklist

1. Confirm clean/dirty tree with `git status --short`.
2. Typecheck before running anything long.
3. Quarantine or finish the two untracked render files.
4. Finish Apple/iTunes verification and gates.
5. Revisit key-detection design.
6. Commit only touched paths.
7. Push only if explicitly requested.
