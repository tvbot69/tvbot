# Handoff — tvbot A-tier remediation (2026-09-30, session 3)

Supersedes `HANDOFF-2026-09-30-A-TIER.md` (session 2), which described a red tree
and a plan. **Both the plan and the red tree are gone.** This file records what is
now true and what comes next.

Branch `main`, HEAD `2e3410a`, **pushed to `origin/main`.** Read the root
`AGENTS.md` first — it holds the gates, the golden rules and the testing contracts,
and it carries the numbers below.

---

## 0. Every gate is green, measured on `a0f5144`

| Gate | Value |
|---|---|
| `npm run build` | clean |
| `npx tsc --noEmit --incremental false` | 0 errors |
| `npm run lint` | **0 errors** / 358 warnings |
| `npm test` | **7413 passed + 517 db skipped = 7930** (381 files) |
| `npm run debt` | every kind at or under budget |
| Coverage | **84.40 lines / 84.10 branches / 81.83 functions** over 58,398 statements |
| Ratchet (`vitest.config.ts`) | 84.3 / 84.0 / 81.8 |

Session 2 left 2 tsc errors, 5,072 tests, 74.08% coverage and a 66.5 ratchet
sitting *below* reality. Four commits since:

| Commit | What |
|---|---|
| `8252572` | Wave 1 — Spotify fabricated totals, the Genius 403 lie, dead config, the optional-DI no-op that made the channel-disable gate unenforceable |
| `ffe6725` | Wave 2 — **2,209 tests** across seven directories, ratchet raised, three nested `AGENTS.md` manuals, two committed infrastructure disclosures scrubbed |
| `a0f5144` | Waves 3 and 4 — **32 production defects** the new tests exposed |
| `2e3410a` | Machine path dropped from this file |

The two findings that mattered most, for the record:

- **`getAlbumTrackNames` never worked.** `if (res.status < 500) return []` — 200
  satisfies it, so the success path was dead code and the Spotify tracklist rung
  has never once fired. `albumService` fell back to Last.fm every time, silently.
- **`playErrorMessage` was an arrow reading `this`.** Its whole "no nodes"
  refinement was unreachable, so with `ENABLE_LAVALINK=false` the bot told users to
  wait 30–60 seconds for a node that is switched off.

---

## 1. THE PLAN — what comes next, in order

The ordering is by **risk retired per unit of effort**, not by coverage percentage.
That is the whole argument: this session proved that a test asserting a call was
called finds nothing, while a test asserting a *rendered claim* found a feature
that had never worked. Everything below follows from that.

### Wave 5 — prove the 12 commits that were just pushed (do this FIRST)

**Nothing has run against a real database, a real browser, a real voice channel or
a real Discord.** 35 production behaviour changes went out on a mocked suite. A
green suite is necessary and not sufficient, and this is the session where that
sentence matters most.

1. **Watch the first Railway deploy log end to end.** The `/health` change from
   `865ffdb` alters what the platform *does* — a bot that lost its gateway now
   answers non-200, so Railway will restart where it previously did not. Ask for
   the live commit SHA; Railway lags a push by minutes, so a fix that looks dead
   may simply not be deployed yet.
2. **Make CI's db suite the gate it is supposed to be.** 517 db tests have never
   run locally — no Docker, no local Postgres. Two of them were *edited and not
   executed* in `a0f5144` (`whoKnowsRepository.db.test.ts`,
   `crownRepository.db.test.ts`). A SQL or schema change there is unproven until CI
   runs it. If CI is red, that is the highest-priority thing in this document.
3. **Live-probe the 13 vendor assumptions the new tests now encode.** Wave 2 wrote
   tests that assert claims about Spotify, Apple, Deezer and Geni.us which nothing
   has checked. They are listed in the comments of
   `src/spotify/api/spotifySearchApi.{limits,albums,verdicts,discography}.test.ts`
   and `spotifyTokenManager.credentials.test.ts`. `scripts/liveVerify.ts` is the
   instrument — extend it for Spotify the way it already does for Last.fm, and
   run it. **A test double is a claim about a vendor, and nothing checks the claim.**
4. **Human in a voice channel.** Voice messages, real audio throughput, real
   Chromium pixels — `STAGING_CHANNEL_ID` exists for exactly this. No test can
   cover them and none pretends to.

### Wave 6 — the nine pinned defects, highest blast radius first

Each has a test pinning current behaviour. **Read the test before fixing one** —
that is the discipline this repo now runs on.

| # | Defect | Cost while unfixed |
|---|---|---|
| 1 | `previewResolverService` accepts a right-artist / **wrong-track** candidate. The `-1000` penalty cannot push a row below zero and the guard checks only the artist. | `resolve('Radiohead','Creep')` can return `{trackName:'Karma Police'}` **with a working preview button**. This is the single worst live defect left: a wrong song presented as a right one. |
| 2 | `spotifyScraperService.getWebPlayerToken` returns null on every attempt, zero log output, no negative cache. | ~2s burned per call, and a lost capability logged at DEBUG-or-nothing. Golden rule 10 says WARN. |
| 3 | `friendsRepository.getFriended` includes `user` but `map()` reads only `friendUser`. | Every friend row shows the raw Last.fm name instead of the registered one. |
| 4 | `playlistChunkManager.ts:258-262` — mid-playlist truncation logs WARN, deletes the chunk, sends **no channel notice**. | The queue silently loses tracks. Siblings at `:239` and `:285` do notice. |
| 5 | `.fm help` is rate-limited as if it were a Last.fm call. | The help command can be locked out. |
| 6 | `.fm <@123> mini` ignores the layout token (`parseFmEmbedType` runs on the whole argument string). | The user asked for mini, got default, no error. |
| 7 | `paginationService` posts a **new message per page** (`i.update({})` then `reply`) instead of editing. | A 20-page chart produces 20 messages and 20 blanked originals. Works, but looks unintended. Needs a decision, not a guess. |
| 8 | `chartService.afterFilters` is set `true` for cover exhaustion, not only for a filter running. | The name overstates the flag; a handler that surfaces it says the wrong thing. Renaming touches `chartBuilders` and the command layer. |
| 9 | `.scrobble`/`.lyrics`/`.love`/`.unlove` leading-separator cases are now `WrongInput`, but the **slash** twins have no pipe grammar at all. | Probably correct. Confirm before adding one. |

Wave 6 is one agent per two or three of these, partitioned by file, same rules as
last time: read the constructor, copy the exact arity, mutate-check, never weaken
a test to make it pass.

### Wave 7 — the coverage that is still worth having

**9,107 uncovered lines remain. Do not chase the percentage — chase the
directories where defects have actually shipped.** Ranked by uncovered lines:

| Directory | Uncovered | Coverage | Read |
|---|---|---|---|
| `src/bot/slashCommands` | 1,909 | 76% | Worst offenders: `artistSlashCommands` (171/234), `countrySlashCommands` (157/447), `friendSlashCommands` (140/193), `crownSlashCommands` (129/210), `userHubSlashCommands` (103/187) |
| `src/bot/services` | 1,224 | 89% | `startupService` 112/152 with **zero tests** — see Wave 8 |
| `src/bot/textCommands/lastfm` | 1,220 | 72% | `serverCommands` 172/216, `artistCommands` 158/202, `countryCommands` 145/334, `friendsCommands` 138/264, `loginCommands` 108/169 |
| `src/bot/services/music` | 1,011 | 80% | `spotifyResolver` 216/345, `spotifyScraperService` 185/448, `moonlinkManager` 175/494 — the three that resolve playback |
| `src/bot/builders` | 901 | 88% | `friendBuilders` 165/230, `topBuilders` 144/452, `intelligenceBuilders` 103/332 |
| `src/bot/services/football` | 387 | 43% | **Worst ratio in the repo.** `footballBadgeService` 172/216, `egyptianFootballProvider` 105/152. |
| `src/bot/services/whoKnows` | 336 | 56% | `whoKnowsAlbumService` 105/129, `whoKnowsTrackService` 102/126 |
| `src/bot/handlers/music` | 228 | 85% | `musicEventListeners` 133/506 |
| `src/applemusic/apis` | 140 | 61% | The Apple web/ITunes rungs, in a directory nothing targets |
| `src/domain` | 155 | 72% | `logger.ts` 122/305 — the one thing every file depends on |

**`football` and `whoKnows` are the A2 candidates.** Both are registered in
`startup.ts`, so they are reachable — but at 43% and 56% with only two test files
between them, "reachable" and "working" are different claims. Audit both for dead
rungs before writing a single test for them: a feature that was never completed
should be **deleted**, not covered. That rule is in the root `AGENTS.md` §3.8 and
it is cheaper than maintaining a fiction.

### Wave 8 — the composition root, which nothing tests

`src/bot/startupService.ts` is 152 statements, 112 uncovered, **zero tests** —
because `startAsync` unconditionally `container.resolve`s four real handler graphs
and the login-retry path burns real 3-second sleeps. `src/bot/index.ts` is 29
statements at 0%.

That is the highest-leverage uncovered code in the repo, and it is uncovered for
a reason that is itself the finding: **the wiring cannot be tested without a test
that constructs the whole graph.** A missing registration is invisible — and this
repo has already shipped one (`GuildAdminSlashCommands` took two writers as
optional "so existing construction sites keep compiling", which is how the
channel-disable gate came to be enforced on every message and yet never able to
fire).

Minimum honest version: a test that reads `configureContainer()` and asserts every
registered token resolves, with no lifecycle started. That catches a dropped
registration, a wrong arity, and a circular import — none of which any other test
in the repo can see.

### Standing rules for every wave

- Partition by **directory**, so no two agents write one file. It worked twice.
- Agents must NOT run `npm test` / `tsc` / `lint` / `build`; the lead runs all four
  alone afterwards. A green file inside a parallel batch is noise.
- Read the constructor; copy the exact positional arity. Never add a parameter to
  `MusicService` or `MusicHandler`.
- Never `vi.spyOn` the object under test or a shared live client.
- Flip a characterising test; never delete or weaken one. Mutate-check the flip by
  reverting the production file to HEAD and confirming the test goes red.
- This is a **public repo**: no hostname, URL, token, port, machine path or
  credential in any code, comment, test name or doc.

---

## 2. Known cost of this session

`silent-failure-default` moved 438 → 445 (budget 604). The seven new ones are
per-leg `.catch(() => null)` containments in `artworkService` and
`musicTrackArtwork`. Each replaced a `catch` that degraded a failed read into a
**clean miss**, which is the A1 bar traded against a lint ratchet. That is the
correct direction, but it is a number that moved and it should be named, not
discovered later.

---

## 3. Blocked on Moha (not fixable in code)

1. **`YOUTUBE_API_KEY` in `.env` is invalid** — probed live 2026-09-30:
   `400 API key not valid`. **Chapters are dead in every environment using that
   file.** Regenerate, then re-probe before assuming chapters work.
2. **Redis `maxmemory=0` with `noeviction`** — will OOM when it fills, and the
   write-then-trim protocol means a restart replays rather than drops. Set a
   bound.
3. **Railway deploy of the `/health` change** — see Wave 5 item 1.

---

## 4. What nobody has verified, restated so it is not lost

No live bot run. No real voice connection, no audio throughput, no real Discord
reply, no real ffmpeg, no real Chromium pixels — the generator tests assert on the
HTML handed to the browser and the buffer returned, not on an image. The db suite
has never run locally. Two CI-only suites were edited and not executed. Nothing
has been watched during a real production outage.

**Wave 5 is not optional.** Twelve commits and 35 production behaviour changes
just went out on a mocked suite.
