---
description: Incident reference for tvbot - the symptom-to-log-line runbook (AGENTS.md 9), the known failure modes and scar tissue (10), and the test-gap problem (11). Load when debugging, when a number looks wrong, when a migration or Prisma query is involved, or when a test passes and you suspect it proves nothing. Moved out of AGENTS.md to cut per-turn context from ~7,700 to ~4,400 tokens.
---

# tvbot incident reference

Verbatim extract of AGENTS.md 9-11. Nothing rewritten. If it disagrees with the code, the code is right and this file is wrong.

## 9. Symptom → log line → cause

**This section is the highest-value thing in this file. Read it before changing playback code.**

On 2026-09-27 four separate multi-hour bugs were found by reading logs, and **every one of them passed a fully green test suite first**. A green suite is not evidence that playback works; it is evidence that the code matches the doubles. Grep first, theorise second.

| What the user sees | Grep for | Usual cause |
|---|---|---|
| Chapter title changes, artwork never does | `[Music] Chapter art` with `ok: false` | The artwork cascade returned nothing. Usually a provider title shape the matcher rejects. Check the real provider response before touching the matcher. |
| Card silently snaps back to an earlier song | `Stale position read — refused chapter rewind` (DEBUG) | A position read moved backwards. Either a genuinely stale reader (see §10) or a real bug. Repeated lines every tick = the position reader is persistently wrong, not briefly stale. |
| Card frozen on one chapter for a whole show | `Implausible chapter jump` repeating with **no** `Chapter jump confirmed after settle` | The settle re-derive is not firing, so the guard never resolves. |
| A seek takes ~17s to commit | `Implausible chapter jump` twice, then `confirmed after settle` | The guard treated a user seek as clock drift. Should be instant. |
| Buttons stop responding | `DiscordAPIError[10008]: Unknown Message` from an interactions file | The card was deleted while the press was in flight. `interaction.update` threw instead of degrading. |
| A command silently does the wrong thing | `Text command name collision — later registration wins` | Two commands share a name; one is unreachable. Seen on `.remove` and `.lyrics`. |
| Playlist adds fewer tracks than it has | `Scraper returned no more tracks` | Spotify caps playlist contents at 100 for app-only tokens (§10). The user is told via `partialReason`. |
| Dead air, no error at all | **absence** of `[Music] fallback rung` after `[Music] Track stuck` | The fallback ladder is not firing. This is the scariest class: no error, just silence. |
| Card edit keeps failing | `[Music] Card edit failed` with a `code`/`status` | Discord throttling or a deleted message. `retry_after` is honoured; a fixed 5s backoff is not. |
| No card appears at track start | `Failed to dispatch trackStart Now Playing card` | Channel resolution or post failed. |
| Right song, wrong art, only sometimes | `[art-timing] ... art at render: no` | Cover race: the card rendered before the lookup resolved. Benign if a later `Artwork backfilled` follows. |
| Lyrics/karaoke not advancing | absence of any lyric-line publish | The self-re-arming timer chain died. `clearCardTimers` should stop it; if not, the card is frozen too. |

### How to read the logs
The user runs locally and reads Railway. Ask for the log rather than guessing. Useful greps:
- `Chapter art` — every chapter cover attempt, with `ok` and `artMs`
- `Stale position read` — the rewind guard
- `fallback rung` — one line per rung of the alternate-upload ladder
- `Text command name collision` — printed once at startup; check it every time
- `[art-timing]` — artwork resolve-vs-render correlation, deliberately retained

### Let the log assert on itself
Grepping is a manual loop, and the manual loop is what failed for hours. `src/bot/diagnostics/logInvariants.ts` turns a log into findings:

```
npm run check:log -- bot.log
railway logs 2>&1 | npm run check:log -- -
```

It exits non-zero on any high-severity violation, so it can be dropped into an alias. Six rules, each named after an observed symptom:

| Rule | Severity | Meaning |
|---|---|---|
| `INV-1 chapter jump never settled` | high | A jump was held to confirm and never committed. The settle re-derive is dead, so the card is frozen. |
| `INV-2 position reader persistently stale` | high | ≥5 consecutive refused rewinds from one chapter. Not the catch-up window — a persistently wrong reader. |
| `INV-3 chapter committed backwards without a seek` | high | A confirmed jump moved *backwards*. The guard should make this unreachable; if it appears, the guard failed. |
| `INV-4 chapter artwork never resolves` | medium | One chapter's cover failed ≥3 times. A catalogue miss, so fix the matcher — not the hold. |
| `INV-5 stuck track produced no fallback activity` | high | A stuck track with no fallback rung and no "no alternate" line. The dead-air class: no error, just silence. |
| `INV-6 card edit failing repeatedly` | medium | Sustained same-code edit failure. The card is frozen on its last render. |

The burst thresholds are deliberately above the noise floor. One or two refused rewinds during a seek's catch-up window are **expected by design** and must not be reported — a monitor that cries wolf gets switched off, which is worse than having none.

### Probe the real API before theorising
When the cause looks like "the provider is wrong", **it usually is**. Write a throwaway `.mjs`, read keys from `.env`, never print them, and hit the real endpoint. Two of the biggest bugs this session were confirmed that way in under a minute:
```
node -e "…fetch('https://api.spotify.com/v1/search?q=…')…"   # keys from .env
```
Do not reason about a third party's response shape from memory. Measure it.

---

## 10. Known failure modes (scar tissue)

Each of these cost real time. Re-deriving them is pure waste.

- **A failed Prisma migration bricks the whole bot.** `npm start` is
  `migrate deploy && node dist/bot/index.js`, so `P3009` (found failed migrations)
  means the process exits before Discord connects. The bot is DOWN, not degraded.
  `20260928010000_user_plays_dedup_index` did exactly this on 2026-09-27.
- **`enum_out` is STABLE, not IMMUTABLE**, so an enum may not be cast inside an
  index expression — `coalesce(col::text, '')` fails with `42P17 functions in
  index expression must be marked IMMUTABLE`. Index the enum column directly and
  handle NULLs with `NULLS NOT DISTINCT`. Enum I/O conversion is **not** in
  `pg_cast`, so probe `pg_proc` for `enum_out`, not the cast catalog — a
  `pg_cast` query returns nothing and looks like "no problem".
- **Verify index *expressions* on a temp table before migrating.** A
  syntactically valid migration is not a working one, and the only test of it is
  the production database. `npm run db:verify-index-expr` builds each expression
  on a throwaway table with the real column types. Run it *before* `migrate deploy`.
- **Recovering a failed migration:** `prisma migrate resolve --rolled-back <name>`,
  then fix the file, then `migrate deploy`. `--applied` is only for a migration
  that genuinely took effect. Read what Prisma actually recorded with
  `npm run db:migration-logs` — the `logs` column has the real SQLSTATE, and it
  will contradict whatever the migration's own comment claims.
- **An index existing is not the same as a guarantee holding.**
  `npm run db:verify-constraint` writes a duplicate inside a transaction and
  rolls back, proving `23505`. It also runs a *control* insert one second later,
  which must be accepted — without it, a broken index that rejects everything
  would look like a pass.
- **The dedup identity deliberately excludes `user_play_id`**, so two scrobbles
  of the same track in the same second from the same source are one play. That
  is intended, not a bug, and it surprises anyone who assumes a new id makes a
  row distinct.
- **`user_plays` has no `id` column** — the key is `user_play_id` (BigInt). Raw SQL
  written from muscle memory fails with `42703`.
- **`current.position` / `current.time` are moonlink's, not ours.** The node rewrites them from the *pre-seek* position for several seconds after a seek lands. Never trust them alone; `queueService.calculatePosition` treats a recent `lastUserSeekAt`/`lastUserSeekPos` as authoritative, forward-only. This was the true cause of a chapter rewind that took two days to find.
- **Spotify playlist contents are 403 for app-only tokens.** `/v1/playlists/{id}/tracks` is forbidden; `/v1/playlists/{id}` returns metadata with no `tracks`; the anonymous `open.spotify.com/get_access_token` endpoint now returns XML; the main playlist HTML no longer ships `__NEXT_DATA__`; the embed page returns the same first 100 tracks regardless of `?offset`. 100 is a hard ceiling. Extended quota — the only route past it — is granted solely to organisations with 250k+ MAU, so it is not available here. Do not build a chunker that pages past 100.
- **Catalogue title shapes break strict matching.** DJ-pool and compilation rips prefix a date (`20191009 I Like Her`, `20200817 Proud True Toyota`) and are often the *only* rows a provider returns. Matching must strip a LEADING date, while staying strict: `"Song"` must never match `"Song 2"`, and `1989` is a title, not a date.
- **The Redis FIFO warning is expected.** Write-then-trim ordering is consistent and failure replay is intentional. Do not "fix" it.
- **A search timeout must keep cooling the node.** That came from a real uplink-stall incident. Only the collateral migration damage was softened.
- **TrackStart swallows errors behind a `try/catch`.** It logs a warning, but a missing method on a test double once failed silently for a full test run. When a card mysteriously does not appear, check the log for that warning before anything else.
- **Moonlink can raise `trackStuck` and `trackException` for the same track.** Both handlers claim `inFlightFallbacks` before acting; without that claim the same alternate gets enqueued twice and the track is skipped twice.
- **`Moonlink v5 restart()` re-sends a voice payload without `channelId`**, which Lavalink 4.2.2 rejects with a 400. Resume after a rejoin uses `connect()` + `resume()` + explicit seek instead. Do not "simplify" it back.

---

## 11. The test-gap problem, stated honestly

This session found four multi-hour bugs. The suite was green for all four. The reason is consistent and worth remembering:

> **Every bug lived in the gap between our abstraction and reality, and our tests are written against our abstraction.**

- The date-prefix bug: `matchesTrackTitle` had tests, but every fixture title was invented. None had seen a real provider response.
- The seek-position bug: no test existed, and every player double set `current.position` *correctly* — our double agreed with our code's assumption, modelling away the exact thing that broke.
- The chapter rewind: the tests were single-step; the bug needed a sequence (seek, then a stale read).
- The listener-wrapper regression: **caught**, because that test drives the real Moonlink interface and awaits it rather than testing our abstraction of it.

Three fixes, in priority order:
1. **Fixtures captured from real provider responses**, replayed in tests. A recorded Spotify/Last.fm/YouTube payload kills this whole class. — **done**
2. **Invariant tests over event sequences**, not examples. "For any sequence of seeks, stalls and track changes, the displayed chapter never moves backwards without a recorded seek" covers the rewind, the stall path, and whatever is next. Examples cannot express this; properties can. — **done, but see the trap below**
3. **Doubles that are deliberately uncooperative** — a double whose `current.position` *disagrees* with the recorded seek intent. Cooperation between double and code is what hid the bug. — **done**: `src/tests/musicBot/uncooperativePlayer.ts`

### The trap that fix 2 fell into, and the rule that replaced it

The first attempt at fix 2 re-implemented the chapter indexing **locally in the test** and asserted against that model. It passed 6/6 — and it also passed **6/6 with `calculatePosition`'s seek-awareness deleted from production code**. A test that cannot fail when the feature is removed is not a test; it is a comment that runs.

The replacement, `src/tests/musicBot/chapterInvariant.uncooperative.test.ts`, drives the **real** `QueueService.calculatePosition` and the **real** `ChapterTimeline.chapterCardFor`, over a hand-moved node clock that is wrong on purpose. The model-based file was deleted rather than kept as a second, weaker claim on the same invariant.

> **Rule: a test that re-implements the logic it is testing is decoration. Import the production function.** If you cannot import it, that is a design finding — extract the logic, do not copy it.

### Mutation-check anything load-bearing

A new test is not finished until you have seen it fail. The cheapest proof is to break the feature and watch the test catch it:
```
# disable seek-awareness in queueService.calculatePosition, run the new test, expect failure, then revert
(Get-Content src/bot/services/music/queueService.ts -Raw) -replace 'seekPos > basePos &&','false &&' | Set-Content src/bot/services/music/queueService.ts -NoNewline
git checkout -- src/bot/services/music/queueService.ts
```
Do this for any test guarding an incident. A test that has never been seen red is an assumption.

And the honest limit: **no test can catch "Spotify changed their API"**, because that is a fact about the world. Only watching the real thing catches it — which is why §9 exists, and why reading the log is part of the job rather than a fallback.

---