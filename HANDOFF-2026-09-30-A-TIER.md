# Handoff — tvbot A-tier remediation (2026-09-30, session 3)

Supersedes `HANDOFF-2026-09-30-A-TIER.md` (session 2), which described a red tree
and a plan. **Both the plan and the red tree are gone.** This file records what is
now true, and only what is still open.

Repo `C:\Users\moha\Desktop\tvbot1`, branch `main`, HEAD `a0f5144`,
**10 commits ahead of `origin/main`, NOT pushed.** Read the root `AGENTS.md` first —
it holds the gates, the golden rules and the testing contracts, and it was updated
with the numbers below.

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

Session 2 left 2 tsc errors, 5072 tests and 74.08% coverage. Three commits since:

| Commit | What |
|---|---|
| `8252572` | Wave 1 — Spotify fabricated totals, the Genius 403 lie, dead config, the optional-DI no-op that made the channel-disable gate unenforceable |
| `ffe6725` | Wave 2 — **2,209 tests** across seven directories, the ratchet raised, three nested `AGENTS.md` manuals, two committed infrastructure disclosures scrubbed |
| `a0f5144` | Waves 3 and 4 — **32 production defects** the new tests exposed |

---

## 1. The two findings worth knowing about

**`getAlbumTrackNames` never worked.** It ended in `if (res.status < 500) return []`,
which 200 satisfies. The success path below it was unreachable, the method answered
`[]` for every successful response, and `albumService` fell back to Last.fm every
time with nothing logged. Now `=== 404`, and a non-2xx below 500 raises.

**`playErrorMessage` was an arrow reading `this`.** Its whole "no nodes" refinement
was unreachable, so with `ENABLE_LAVALINK=false` the bot told users to wait 30-60
seconds for a node that is switched off. Now a bound instance method, all three
call sites routed through it.

Both were found by tests that characterise behaviour rather than call counts, which
is the only reason they were found at all. That is the argument for the way these
tests are written; do not let it drift back toward `toHaveBeenCalled`.

---

## 2. Fixed in `a0f5144` — 32 defects

Grouped so nothing reads as a drive-by list. Every one was pinned by a
characterising test first, the test was inverted rather than deleted, and the whole
set was mutation-checked by reverting each production file to HEAD and confirming
the new tests go red.

- **Dead features.** The Spotify tracklist rung above. `albumBuilders` and
  `trackBuilders` built a `Section` with no accessory when there was no cover, and
  discord.js `SectionBuilder.toJSON()` parses a non-optional accessory — so the
  card **could not be sent** for any album or track without a cover.
- **Numbers that were not numbers.** Unread `userPlaycount` / `totalPlayCount`
  printed as 0; an off-the-end page printed `6/2` beside `0 unique tracks`; a
  failed `members.fetch` printed `Scanned 0`; `/music volume` printed 100% for a
  player that does not exist; the chart Edit button carried `undefined` as its
  creator so it refused everyone including the creator. All now omit, clamp or
  refuse. `voiceMessageService` was sending Discord a 100-byte buffer of
  `Math.random()` — the field is now omitted, because a flat bar is truthful.
- **The wrong person.** `.gaps lfm:x` and `.discoveries lfm:x` kept the caller's
  `userId`, so they ran the caller's SQL under the stranger's name. A mention that
  resolved to nobody was silently dropped and answered with the caller's own data.
  `.affinity` rendered a fabricated table of named people at 0%. All three refuse;
  `.iceberg lfm:` still works because it never read a user id.
- **Search for the wrong song.** `/track` composed `track | artist` while
  `trackService.searchTrack` splits `artist | track`.
- **Outages recorded as facts.** A 5-second DNS blip made `getArtistById` return
  null, which `artworkService` cached as "this artist has no cover". An artwork
  cascade leg that threw killed the whole cascade and was recorded as a clean
  `miss`. An Apple cover that matched perfectly was discarded for an artist with no
  DB row — then cached as "no cover exists". An album provider outage re-queried the
  whole catalogue on every chart render.
- **Writes with no guard.** `.love` and `.unlove` had no half-filled-pipe guard at
  all, so `.love Radiohead | ` wrote a track with a blank title. `.affinity` and
  `/blocklist list` had no permission check.
- **Internal inconsistency.** A receipt counted plays from the period start to now
  while its own link was bounded (both twins). A chart cache key treated
  `Radiohead` and `radiohead` as two artists. A Discord outage and a deleted
  channel were the same autopost error forever. Four crown methods and eight guild
  writers called `BigInt()` raw while their siblings guarded. A non-numeric crown
  role silently wiped the config. The friends queries omitted the abuse-flag clause
  the leaderboard queries carry. The Spotify outage breaker did not gate the shared
  search path its own comment claims it gates.

---

## 3. Still open

**Deliberately unfixed — each has a test pinning current behaviour, read the note
before touching one:**

1. `previewResolverService` accepts a right-artist / **wrong-track** candidate. The
   `-1000` penalty cannot push a row below zero and the final guard checks only the
   artist. `resolve('Radiohead','Creep')` can return `{trackName: 'Karma Police'}`.
2. `friendsRepository.getFriended` includes `user` but `map()` reads only
   `friendUser`, so the friend row always shows the raw Last.fm name. Which side is
   wrong is a judgement call; `friendsRepository.includeMismatch.test.ts` pins the
   cross-method contrast.
3. `.fm help` is rate-limited as if it were a Last.fm call.
4. `.fm <@123> mini` ignores the layout token — `parseFmEmbedType` runs on the whole
   argument string and only matches a bare token.
5. `spotifyScraperService.getWebPlayerToken` returns null on every attempt with zero
   log output and no negative cache, so ~2s is burned per call.
6. `playlistChunkManager.ts:258-262` — a mid-playlist truncation logs WARN and
   deletes the chunk but sends no channel notice, unlike its siblings.
7. `.scrobble`/`.lyrics`/`.love`/`.unlove` leading-separator cases are now
   `WrongInput`, but the **slash** twins have no pipe grammar at all — confirm that
   is intended before adding one.
8. `paginationService` posts a **new message per page** instead of editing in place
   (`i.update({})` then `reply`). Functionally correct, but a 20-page chart produces
   20 messages and 20 blanked originals. Worth a decision.
9. `chartService.afterFilters` is set `true` for cover exhaustion, not only for a
   filter running. The name overstates it. Renaming touches `chartBuilders` and the
   command layer, so it was not done mid-wave.

**Known cost of this session:** `silent-failure-default` moved 438 → 445 (budget
604). The seven new ones are the per-leg `.catch(() => null)` containments in
`artworkService` and `musicTrackArtwork` — each one replaced a `catch` that
degraded a failed read into a clean miss, which is the trade the A1 bar asks for.

---

## 4. Blocked on Moha

1. **`YOUTUBE_API_KEY` in `.env` is invalid** — probed live 2026-09-30:
   `400 API key not valid`. **Chapters are dead in every environment using that
   file.** Regenerate.
2. **Redis `maxmemory=0` with `noeviction`** — will OOM when it fills.
3. **Nothing is pushed.** 10 commits ahead. Railway lags a push by minutes — ask for
   the live commit SHA before concluding a fix failed. **Watch the first deploy log
   after push: the `/health` change alters what Railway does.**

---

## 5. What nobody has verified

No live bot run in this session. No real voice connection, no audio throughput, no
real Discord reply, no real ffmpeg, no real Chromium pixels — the generator tests
assert on the HTML handed to the browser and the buffer returned, not on an image.

Two CI-only suites were **edited but not executed**: `whoKnowsRepository.db.test.ts`
and `crownRepository.db.test.ts`. The db suite has never run locally. Those two
files are reasoned, not run, and a schema or SQL change there is unproven until CI.

The real-Azure gap that a human has to close: nothing in this repo proves the bot
can connect to a voice channel, stream audio, or reply to a message that Discord
accepts. Every one of those is mocked.
