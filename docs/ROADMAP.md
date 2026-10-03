# tvbot Roadmap — open work only

Background lives in the archive. Read it before changing any item below:

- `docs/archive/HANDOFF-2026-09-30-A-TIER.md` — Wave 5 verification queue (Wave 5) and Wave 6 defect pins (Wave 6).
- `docs/archive/HANDOFF-2026-10-01-TREE-CONTINUE.md` — tree-continue state: Apple/iTunes consolidation, render blind spot, key detection.
- `docs/archive/2026-10-02-PLAN_B_PLUS_TO_A.md` — original B+ to A plan (history).
- `docs/archive/2026-10-02-PLAN_REACH_A.md` — A-tier rounds (history).
- `docs/archive/2026-10-02-PLAN_PROGRESS.md` — per-round progress log (history).
- `docs/QUALITY_REVIEW.md` — dated snapshot, kept in place (history).

Conventions: `AGENTS.md` §2 (gates), §3 (golden rules), §5 (testing contracts). No build/test was run to produce this file.

## 0. Phase 0 — truth items (prove in production, not in mocks)

- [ ] Railway deploy runs migrations on every deploy. Area: `railway.json`, `Dockerfile`, `RAILWAY.md`, `src/persistence/prisma/`. Confirm: watch one deploy log end to end, `/health` behaviour on gateway loss.
- [ ] CI db suite is green against disposable `postgres:16`. Area: `vitest.db.config.ts`, `src/testSupport/dbHarness.ts`. Confirm: full `npm run test:db` in CI, not per-file only.
- [ ] Vendor assumptions live-probed. Area: `scripts/liveVerify.ts`, `src/spotify/api/`, `src/applemusic/api/`, `src/deezer/api/`, `src/lastfm/api/`. Confirm: extend probe coverage for Spotify/Apple/Deezer claims encoded in test doubles.
- [ ] Human in a voice channel. Area: `src/bot/services/audio/voiceMessageService.ts`, `src/images/generators/`, `STAGING_CHANNEL_ID`. Confirm: voice messages, audio throughput, real Chromium pixels.
- [ ] `YOUTUBE_API_KEY` valid; chapters live. Area: `src/bot/services/music/descriptionChapters.ts`, `src/bot/configurations/envValidator.ts`. Confirm: re-probe before assuming chapters work.
- [ ] Redis bounded (`maxmemory`, eviction) for write-then-trim protocol. Area: `src/bot/services/system/cacheService.ts`. Confirm: bound set, restart replay observed.

## 1. Wave 6 — 9 known user-facing defects (highest blast radius first)

Each has a test pinning current behaviour. Read the test before fixing.

| # | Defect | Area |
|---|---|---|
| 1 | `previewResolverService` accepts right-artist / wrong-track candidate; penalty cannot push row below zero, guard checks artist only | `src/bot/services/audio/previewResolverService.ts` |
| 2 | `getWebPlayerToken` returns null on every attempt, zero log output, no negative cache | `src/bot/services/music/spotifyScraperService.ts` |
| 3 | `getFriended` includes `user` but map reads only `friendUser`; rows show raw Last.fm name | `src/persistence/repositories/friendsRepository.ts` |
| 4 | Mid-playlist truncation logs WARN, deletes chunk, sends no channel notice | `src/bot/services/music/playlistChunkManager.ts` |
| 5 | `.fm help` rate-limited as if it were a Last.fm call | `src/bot/textCommands/`, `src/bot/services/system/rateLimitService.ts` |
| 6 | `.fm <@id> mini` ignores layout token (`parseFmEmbedType` runs on whole arg string) | `src/bot/textCommands/lastfm/`, `src/bot/builders/` |
| 7 | Paginator posts a new message per page instead of editing (needs decision, not guess) | `src/bot/services/system/paginationService.ts` |
| 8 | `afterFilters` set true for cover exhaustion, not only for a running filter (rename touches builders + command layer) | `src/bot/services/charts/chartService.ts`, `src/bot/builders/` |
| 9 | `.scrobble` / `.lyrics` / `.love` / `.unlove` leading-separator cases are `WrongInput`; slash twins have no pipe grammar (confirm before adding) | track command modules in `src/bot/textCommands/lastfm/`, `src/bot/slashCommands/` |

## 2. True A1 risks (failure becomes a plausible wrong answer)

Fix pattern: log at ERROR/WARN, raise or render an explicit error state. Never log-and-return-default.

- [ ] `trackService` silent `[]` paths on DB failure read as "no data". Area: `src/bot/services/library/trackService.ts`.
- [ ] `genreService` write-failure cached as `[]` reads as "you have no genres". Area: `src/bot/services/library/genreService.ts`.
- [ ] `countryService` partial map on failure reads as "no country data". Area: `src/bot/services/library/countryService.ts`.
- [ ] `featuredService` null on failure publishes "Unknown Artist" history entry. Area: `src/bot/services/library/featuredService.ts`.
- [ ] `friendsService` privacy bypass on failure exposes hidden rows. Area: `src/bot/services/social/friendsService.ts`, `src/persistence/repositories/friendsRepository.ts`.
- [ ] `autopostService` Top stub posts confident wrong leaderboard on failure. Area: `src/bot/services/charts/autopostService.ts`.

## 3. Carried from tree-continue handoff (verify, then close)

- [ ] Apple/iTunes consolidation: single request path, `ITunesUnavailableError` vs genuine miss. Area: `src/applemusic/api/appleMusicSearchApi.ts`, `src/bot/services/media/appleMusicService.ts`.
- [ ] Render blind spot: pixel-content assertions, blank chart must fail. Area: `src/testSupport/`, `src/images/generators/__tests__/`.
- [ ] Key detection unsound on noise; needs corpus + threshold decision, not a guessed fix. Area: `src/bot/services/audio/`.
