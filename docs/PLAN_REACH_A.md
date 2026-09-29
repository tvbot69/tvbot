# Plan: Reach A tier

Replaces `PLAN_B_PLUS_TO_A.md`. That plan is kept for history, not followed.

## Why this plan exists

The previous plan defined A tier as a checklist of ratchet counts and ended at 8/9 boxes
ticked with the work still incomplete. Two things went wrong:

1. **The headline metric was bad.** `silent-failure-default = 604` counts catch blocks, not
   bugs. Cutting it to 400 by grouping catches scores identically to cutting it to 100, and
   the first version is cosmetic. Optimising it would have been worse than not doing it.
2. **It was not a plan, it was a progress report.** It measured what had been done rather
   than deciding what to do next, so the number never moved and two days produced no
   movement on the scoreboard even though real bugs were being fixed.

This plan does the opposite. It names defects that make the bot lie to a user, orders them
by how much a user is hurt, and deletes the 604 entirely rather than pretending to reduce it.

## What "A tier" means here

The bot never tells a user a confident falsehood. Three concrete properties, each
independently checkable:

- **A1. No query is silent.** Code that reads the database and cannot read it says so.
  No `.catch(() => [])` on a data path.
- **A2. No dead feature presents itself as working.** A feature either works or is gone.
- **A3. Every query that can run has been run.** A query that has never executed against a
  real database is a query that has never been tested.

A3 is already true: `raw-query-without-db-test = 0`. That was Phase 6.1 and it is done.

## The work, in order of how much a user is hurt

### A-tier 1 — A1, the silent-failure queue (the real work)

The 604 sites are not equal. The ones that matter share one shape: **a failure becomes a
plausible wrong answer rather than an absence.** An empty list is honest; a chart showing
`0` plays is a lie, and the user cannot tell which they got.

Ranked by blast radius:

1. **`lastFmRepository` — 10 sites where a Last.fm 5xx becomes "this user does not exist."**
   Worst class in the repo. A timeout is indistinguishable from a deleted account, and the
   bot will confidently tell someone their friend is gone. Every one of these must distinguish
   "Last.fm failed" from "Last.fm said no."
2. **`playHistoryService.getYearOverview` — 6 raw queries, each becoming a confident zero.**
   The year chart renders as all-zeros after any database error, with no indication that
   anything failed. A user looking at a year chart has no way to know they are looking at
   nothing.
3. **`streakService` and the leaderboard services** — same shape, smaller surface.

Each fix: log the error at WARN, and make the failure visible to the caller rather than
defaulting it away. Not "log and still return a default" — that keeps the lie. Return a
distinguishable failure, or render an explicit error state.

**Ratchet:** `silent-failure-default` is now **595, budget 595**, and it only falls. The 604
count is not deleted from the tooling — it stays as a cheap regression net for new silent
catches — but it is no longer the target. A site leaving it is not a win unless it was on the
user-facing list below.

**Measured so far: 604 to 595.** The 9 removed are all in `lastFmRepository`, and they are the
highest-value sites in the repo.

**A-tier 1 progress — `lastFmRepository`, done.**

Every read method returned `null` or `[]` for both "Last.fm says no such thing" and "Last.fm
is down", so a bad minute at Last.fm was indistinguishable from a deleted account. New
`orUnavailable` helper: a real not-found code (6, 7, 8) is returned as the empty answer it
is; anything else is logged at ERROR and raised as `LastFmUnavailableError`.

Converted 9 methods: `getUserInfo`, `getArtistInfo`, `getAlbumInfo`, `getTrackInfo`,
`searchArtists`, `searchAlbums`, `searchTracks`, `getUserFriends`, and the session lookup.
`getAuthToken` was left alone deliberately — a failed token fetch has no "user" to lie about
and its caller already handles `null`.

**Four tests asserted the bug and were replaced, not weakened.** They said "returns null
rather than throwing when the call fails" and threw a bare `Error`, which pinned the defect.
Each is now a pair: a not-found code returns the empty answer, and a transport failure raises.
Asserting only the happy half cannot tell the fix from the bug, so both directions are tested.

**Call-safety verified, not assumed.** 41 call sites across 17 files now receive a throw
where they previously received a lie. `commandHandler` catches at the message boundary and
`interactionHandler` catches and replies "something went wrong", so a Last.fm outage cannot
crash a command or leave an interaction unacknowledged — it downgrades from a confident wrong
answer to a visible error. This was the main risk of the change and it was checked rather than
hoped for.

**Next:** `playHistoryService.getYearOverview` — 6 raw queries, each becoming a confident zero.

#### An audit of the throw found three things I had wrong

A subagent audited every call site of the 9 converted methods. My own claim of "41 call sites
across 17 files" was **undercounted by half** — the real number is 82, because grepping on the
method name misses sites that use a different receiver name (`lastfmRepo` rather than
`lastfmRepository`). 81 are safe, 1 was not, and the audit corrected two of my statements:

1. **I claimed 9 methods converted; it was 8.** The auth-session lookup was not converted. The
   message was wrong, and converting it *would* have been a bug: its only caller sits inside a
   retry loop that depends on a `null` return. Left unchanged deliberately, and now documented
   as such rather than left to look like an oversight.

2. **I claimed `getUserFriends` was telling users their friend had been removed. It has zero
   production callers** — the friends UI reads `friendsRepository`, not Last.fm. The fix is
   still correct, but the impact I described for it was not real.

3. **The one genuinely unsafe site:** `friendsCommands.ts:192` did a Last.fm lookup, then a
   database write, inside a loop over `.addfriends a b c` arguments. A throw between them
   aborted the loop *after earlier arguments were already committed*, so the user got a generic
   error and no confirmation of friends that had in fact been added. Now caught per-argument.

`indexService` was the other real risk and it is fixed: the `getUserInfo` call sat outside its
try/catch, so a throw would have skipped `touchLastIndexed` entirely — the run would look
neither successful nor failed and the user would never be retried. It now has its own
try/catch that sets `stats.error`, which is the path that triggers a retry.

**A mutation survived in `artworkService`, and that was informative.** I had added
`if (!isLastFmUnavailable(err)) answered = true` to three catch blocks, believing it stopped an
outage being cached as "no artwork exists". Mutating it to `|| true` changed nothing, because
those methods decide the cache from `attempts.length`, and every catch already pushes an
attempt. The flag was dead for that decision in all three places. Rather than keep a guard
that looks protective and is not, I removed all three and left a comment saying why the flag is
deliberately not set. The file's own header already states the rule: "Inconclusive runs
(throws, rate-limits) are never cached." The behaviour was never wrong; my guard was a
comment pretending to be a fix.


**A-tier 1 progress — `playHistoryService.getYearOverview`, done.**

`getYearOverview` ran six raw queries, each carrying `.catch(() => [])`, so a dropped connection
produced `{ totalPlays: 0, topArtists: [], monthlyPlays: [0 x 12] }` — byte-identical to a user who
never pressed play. Both callers then took `totalPlays === 0` and said **"No plays found in 2023."**

The six are now wrapped in `orDatabaseUnavailable`, which logs at ERROR and raises
`SourceUnavailableError`. There is no "not found" case to split out the way Last.fm has one: all six
are aggregates over `user_plays`, and an aggregate with no matching rows succeeds with a shorter
result rather than erroring. So empty IS the answer and an error is always an error. That reasoning is
in the code comment, because it is the non-obvious half of the change.

**`LastFmUnavailableError` was re-parented onto a new `SourceUnavailableError`** rather than left as
the root of the idea — the same argument applies to our own Postgres. `name` and the message text are
unchanged, so `isLastFmUnavailable` and every `instanceof` keep working, and
`isSourceUnavailable` tells the two apart by name. That separation is load-bearing: `artworkService`
treats a Last.fm failure as "do NOT cache this as a definitive no-artwork answer", and a database
outage must not be swept into that branch by accident.

**Both callers were given a visible failure, not a generic one.** The service now raises, so
`yearSlashAsync` and `yearAsync` each catch `isSourceUnavailable` and return
`CommandResponse.Error` — "Could not load **2023** for <name> — the database is unreachable" —
instead of letting the command boundary render a generic "something went wrong". A genuine empty year
still returns `NotFound`; both directions are pinned, because a fix that only handles the outage case
would trade one wrong answer for the other. The catch re-throws anything that is not a source
unavailable, so a real `TypeError` is not dressed up as a transient connectivity problem.

**Definition of done for this tier:** a Last.fm 5xx in a test produces a visible error, and
the year chart says "could not load" instead of "0 plays." — **met for both sites.**

### A-tier 2 — A2, the orphaned audio-features feature — **DONE**

`trackService.getAverageTrackAudioFeaturesForTopTracks` selected five columns that do not
exist on `tracks`, behind `.catch(() => [])`, so it returned zeros to every user silently
since it was written.

**Measured, and this changed the decision:** the query is already gone. What remained was
`audioFeatureAnalysisComparisonString`, a pure formatter, and it has **zero production
callers** — only its own unit test. So this was not "add five columns or repair the query."
The feature was already dead code that was never wired up.

Decision: **deleted.** The formatter, the `AudioFeaturesOverview` interface, and its three
tests. Adding a migration and five columns to serve a feature with no caller is a net loss.
This satisfies A2 at lower cost than the old plan assumed, and the old plan's framing here
was simply wrong.

### A-tier 3 — the A-class site — **DONE**

`friendsRepository.removeFriend` caught a failed delete, returned `false`, logged nothing, and
`friendInteractions.ts:230` discarded the result. A friend removal that failed re-rendered the
list, which still showed the friend — the user saw their own click do nothing, with no error.

Fixed at both ends: the repository now logs at ERROR, and the caller replies "Could not remove
that friend" and does not rebuild the list, because showing an unchanged list implies success.
Mutation-checked: disabling the caller's check turns the new test red.

### A-tier 1b — the same shape in `guildAdminService.getMembersOverview` — **DONE**

The next-highest-blast-radius site of the same class, found by reading the debt list for *plausible
wrong numbers* rather than chasing the count. Two queries, each `.catch(() => [])`:

- `user.findMany` for playcounts
- `userCrown.groupBy` for crown counts

A dropped connection therefore produced a **members table in which every member had 0 plays and 0
crowns** — and then sorted by those zeros, so the heaviest listener in the server sank to the bottom
of the list. This is the worst instance of the class found so far: the shape is a real table of real
people, every number in it is wrong, and an admin cannot distinguish it from a server where nobody
listens to anything. They might act on it.

Fixed with the same `orDatabaseUnavailable` pattern. Both callers (`guildAdminSlashCommands`,
`guildAdminCommands`) are command handlers, and `commandHandler.ts:243` catches at the message
boundary and replies — verified by reading it, not assumed from the Last.fm work.

**Three tests, and the third is the one that matters:** a playcount failure raises; a *crowns-only*
failure raises (partial success is the more insidious case — the playcounts are real, so the table
looks trustworthy right up to the column that is not); and a member who genuinely has no row still
renders a real `0`. Mutation-checked: turning the throw back into `return []` while keeping the
`Logger.error` call — the exact "log and still return a default" the plan calls the non-fix — turns
both raise assertions red and leaves the genuine-zeros test green.

### A-tier 4 — A3, the last unexecuted query — **DONE**

`raw-query-without-db-test` reads 0, but that number was only as good as the audit behind it. Two
known gaps from earlier rounds:

- The `$queryRaw` **tagged templates** were missed by the first audit (35 raw queries once already).
- The detector itself was unproven.

**The blind spot is closed in code, not in a comment.** The detector now walks both
`CallExpression` and `TaggedTemplateExpression` receivers and matches `$queryRaw`, `$queryRawUnsafe`,
`$executeRaw` and `$executeRawUnsafe`. The baseline is **per file**, not per coverage: a file that
already has a `*.db.test.ts` still reports the *overflow* past its recorded allowance, because
"a covered file grows a new query" is exactly how this debt grows.

**Mutation-checked, and it is the load-bearing claim in this tier.** Adding one
`$queryRawUnsafe<T>` tagged template to `playHistoryService` — a file that already has a db test —
reported `1 > 0 WORSE` and failed the build. Restored, it reads 0 again. A ratchet that reports zero
is worse than no ratchet, because it looks like coverage.

**A detector test was using the bug as its own fixture.** `countDebtSilentFailure.test.ts` asserted
the tagged-template shape by pointing at the six `.catch(() => [])` chains in `getYearOverview` — so
fixing that bug turned the detector's own regression test red, and the tempting fix was to delete the
assertion. That inverts the ratchet: **a detector check must not depend on the bug it detects still
existing.**

Replaced with a synthetic throwaway project. The script resolves its `ts.Program` from
`process.cwd()`, so the test writes a temp `tsconfig.json`, a seeded `debt-budget.json` (a missing
kind entry throws in `loadBudgets`, and a throw looks exactly like "0 findings" to the caller), and
`raw-query-baseline.json` (also read relative to cwd), then runs the real script against one fixture
file. Four fixtures: tagged template, plain `.catch`, a catch that **logs** (must report 0), and no
catch at all (must report 0). The negative two matter — without them, a detector that returned 1 for
any file would pass the positive assertions.

Mutation-checked by making `isCatchCallee` reject tagged-template receivers, reproducing the
historical blindness: exactly the tagged-template assertion went red, the plain one stayed green.

**Not closed:** `dbHarness` itself is still untested against a real connection pool. That needs CI's
disposable postgres and is not a static-analysis question.

## What is explicitly not in this plan

- **The 604 count is deleted, not reduced.** It measured catch blocks. Chasing it would be
  motion. Replaced by a smaller, honest count of the sites that actually lie.
- **`as unknown as` (76), `container.resolve` (155), the 15 bot-to-Prisma files.** All
  ratcheted, all non-increasing, all architecturally fine. Not a user-facing risk. Leave them.
- **Coverage percentage.** 66.73% lines, ratcheted, above target. It has never once found a
  bug in this repo that the DB suite did not find faster.
- **Lint warnings** (351). Zero errors, ratcheted, non-blocking by design.

## Honest limits

- **Nothing here has run against the live bot.** No voice, no audio, no ffmpeg, no real
  Discord. The memory peak is still NOT YET MEASURED. Every claim in this plan is about
  code, verified by tests, not about production behaviour.
- **The DB suite is green per-file but the full 518-test run needs CI's disposable
  postgres:16.** A hosted pooler wedges on it (per-file client pools plus a truncate per
  test exhaust the pooler and Prisma blocks with no error). That CI run is the gate for
  every claim in this plan.
- **A-tier 1 will not finish in a day.** It is roughly 17 sites in `lastFmRepository` plus 6
  in `getYearOverview`, and each needs a test that proves a 5xx no longer becomes a wrong
  answer. This is the work that was always there. The old plan hid it inside a count.

## Progress

Tracked in `PLAN_PROGRESS.md`. Metrics that are re-measured, never carried forward on trust.
