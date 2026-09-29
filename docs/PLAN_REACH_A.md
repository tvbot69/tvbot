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

**Ratchet:** `silent-failure-default` is now **526, budget 604**, and the budget only ever falls.
The 604 count is not deleted from the tooling — it stays as a cheap regression net for new
silent catches — but it is no longer the target. A site leaving it is not a win unless it was on
the user-facing list below. **Never lower the budget to make a check pass**; a lowered budget is
a deliberate act a reviewer has to see.

**Measured so far: 604 to 526**, across `lastFmRepository` (14), `playHistoryService` (6),
`guildAdminService` (2), `trackService` (1), `genreService` + `countryService` + `artistsService`
(22), `musicIntelligenceService` + `albumService` + `overviewService` + `fmFooterResolver` (23),
and the top-list laundering round (13). The count is a side effect, not the work: **the six
laundering sites in the last round each removed one catch while removing a lie, and the four
`// CORRECT AS IS` sites added in the same round removed nothing at all.**

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

### A-tier 1c — `trackService.getLastMonthPlays`, and the first test that *asserted* the bug — **DONE**

The only remaining site in the number-rendering services whose failure produced a literal `0` rather
than an empty list, found by filtering the debt list for `[returns 0]` specifically.

`getLastMonthPlays` fed `lastMonthPlays` into the track footer, and `trackBuilders.ts:145` renders
`**N** last month` whenever the value is `> 0`. So the old `catch { return 0 }` did not print a
confident "0 plays" — it **silently omitted the clause**, so a user who had played a track 12 times
this month was shown a footer with no month figure and no way to know the difference between "I
didn't play it" and "the bot couldn't check". Note the failure mode is the *opposite* direction from
the year chart, which is why filtering by shape was necessary rather than reading top-down: this one
would never have been found by asking "which sites render a zero".

**A test asserted the bug, and said so in its own title:** `trackService.test.ts` had
`it('returns 0 when the database query throws')` asserting `resolves.toBe(0)`. Replaced, not
weakened, with the pair: a failure raises, and a query that *ran* and found no plays still returns 0.

**And a lesson worth recording, because I walked straight into it.** My first mutation here was
wrong in an instructive way: I appended `return 0` *after* the unconditional `throw`, so the new line
was unreachable and the test **passed with the mutation in place**. A mutation that cannot be reached
proves nothing, and had I stopped there I would have "verified" a test that had never been red — the
same failure as a test that cannot fail. The corrected mutation *replaced* the throw and the
assertion went red immediately, with the genuine-zero test staying green.

### A-tier 1d — the ranking services: `genreService`, `countryService`, `artistsService` — **DONE** (`42c7abd`)

Three services, 22 sites, all of the same shape. Every read wrapped a raw aggregate
or a Prisma find in `catch { return [] }` / `catch { return null }`, which made a
dropped connection indistinguishable from a user who has never pressed play:

- `.topgenres` said "you have no genres"
- `.topcountries` said "you have no country data"
- `.whoknowsgenre` / `.whoknowscountry` said "nobody in this server listens to anything"

Same `orDatabaseUnavailable` shape as the sites above: `Logger.error` naming the
query, then `SourceUnavailableError`. No "not found" case needs splitting out the
way Last.fm has one, because every site is a `GROUP BY` aggregate and an aggregate
with no matching rows succeeds with a shorter result rather than erroring — so
empty IS the answer and an error is always an error. That reasoning is in the code,
because it is the non-obvious half.

**Three things this is NOT, each left in place with the reason inline:**

1. `BigInt(guildId)` throws a `SyntaxError` on a non-snowflake. That is a **caller**
   bug, not an outage, and laundering it into "Database unavailable" would send
   whoever reads the log to Postgres instead of to the caller. Guarded before the
   query; the empty answer is returned with **no query issued**.
2. `countryService`'s constructor reads two bundled JSON files and fires a
   preload. Raising there would throw out of a constructor `startup.ts` builds by
   hand and take the whole bot down for a country lookup — the `P3009` shape in
   §10. The **preload latch** was the real bug found in passing: it survived a
   failure, so one dropped connection at boot locked the map empty for the process
   lifetime. Now cleared, so the next caller retries.
3. Autocomplete suggesters, collage cover hydration and artwork lookups stay as
   they are. No suggestions is a *working* autocomplete response, and a missing
   cover is the designed state. Raising would blank a leaderboard over one
   thumbnail.

**Four existing tests asserted the bug** — the swallow was the subject, not an
accident of it — and each was replaced with the pair: *a failure raises* AND *a
query that RAN and found nothing still returns empty*. Asserting only the happy
half cannot distinguish the fix from the bug.

### A-tier 1e — `musicIntelligenceService`, `albumService`, `overviewService`, `fmFooterResolver` — **DONE** (`8dce609`)

Twenty-three sites across four files. **The finding worth keeping is that this set
could not be triaged by shape** — reading the list for "which sites render a wrong
number" produced the wrong answer on the worst one.

**`.iceberg` fabricated data, it did not merely lose it.** `artist.findMany` failing
emptied the popularity map, `hasDbPopularity` went false, and the rank-ratio
fallback then **invented a popularity score per artist from playcount position** —
so an outage rendered a complete, confident, entirely fictional five-tier iceberg.
The fallback itself STAYS (it is honest when the query ran and answered "these
artists are unscored") and raising is what separates the two cases. There is a
test pinning that the fallback still runs on an empty result, because a "fix" that
also raised on empty would break a real feature.

**`.affinity` is the `guildAdminService` class one layer out, and its worst site is
not the obvious one:**

- an empty **candidate** list renders "*Could not find indexed users with a similar
  music taste in this server*"
- an empty **target user-artist** list does not render empty at all — it empties
  `targetArtistMap`, which zeroes `artistScore` and therefore `totalPercentage` for
  every neighbour. A full affinity table of **real people, every number wrong,
  sorted by those wrong numbers**.
- the genre/country enrichment is the **partial-success** case: `artistPercentage`
  is real and only the middle two columns were never measured, so the table looks
  trustworthy right up to the columns that are not.

**`albumService`: the catch that returned the unfiltered list.** Its own comment
called empty-vs-degraded "the correct amount of deception". Raised.
`getTopTracksForAlbum`'s method-wide catch was separately laundering a
deliberately raised `LastFmUnavailableError` back into `[]`, silently, one layer
up — now re-thrown, with genuine failures still degrading because it is rung 1 of a
four-rung ladder.

**`fmFooterResolver` logs and does NOT raise — and that is a decision, not an
omission.** Raising would delete the entire Now Playing card over one clause:
`footerBuilder` has no "could not load" affordance to render into, and both callers
build the card on the next statement. That is a worse lie in the other direction.
All eight catches now log at ERROR naming **the exact fields the failure cost** —
narrowed against what the result actually holds, so a failure after `isLoved`
landed reports `trackPlays` alone rather than both. Recorded as the half of A1 this
file alone cannot close.

**Five of the raises are in methods with zero production callers** (verified by
grep; there is no dynamic dispatch in the bot). Raised anyway, because the lie is a
property of the code and not of the caller graph, and raising from a dead method
costs nothing. `filterAlbumsToReleasePeriod` still returns its input **unfiltered**
on failure — a live trap for whoever wires it up, and the comment says so, which is
not enforcement.

**Twelve tests were replaced, not weakened.** The clearest was
`musicIntelligenceService.db.test.ts`'s *"falls back to an empty array when the
database genuinely rejects the query"* — titled for the defect, asserting
`resolves.toEqual([])` against a real 42P01, using the one client in the repo that
can produce a genuine SQL error. Asserting only the raise cannot tell the fix from
a method that always throws, so every site is tested as a **pair**.

**Mutation-checked, and one mutation of the two was invalid on the first attempt.**
Replacing the helper's `throw` with `return [] as unknown as T` turned exactly the
9 raise tests red and left all 13 honest-empty/fallback tests green. The *first*
version appended the `return` **after** the unconditional `throw` — it passed, and
proved nothing. That is the unreachable-code trap from §A-tier 1c and it nearly
became a "verified" test.

**A third bug the suite caught:** an inline multi-line generic
(`$queryRawUnsafe<Array<{ ... }>>`) parses under `tsc` and **fails under esbuild**,
so the whole file failed to collect while `tsc --noEmit` was clean. Row shapes are
named at module scope now. A green typecheck and a green test suite are still two
different claims.

### A-tier 1f/1g — the top-list reads, and the laundering above them

Six `lastFmRepository` sites and one `playRepository` site, and the finding that matters is
not any of them. **Six of the changed sites were not lying at all — they were catching
somebody else's raise and putting it back.**

**`lastFmRepository`'s six remaining top-list reads** (`getTopArtists`, `getTopAlbums`,
`getTopTracks`, and the three `getweekly*chart` variants) each ended `Logger.warn(...); return
[]`. An empty top-artists list is not an absence, it is a claim about a person — "you have no
taste." Same conversion as the eight methods already done, so `orUnavailable`, so a genuine
not-found code still returns the empty answer and only a real outage raises.

**Which then exposed the actual shape of the debt.** Those methods have ~40 call sites and
almost none were written to receive a throw. Every one of them already had a `.catch(() => [])`
of its own, so the raise would have been caught, converted straight back to `[]`, and the layer
below would never have known. **The new raise was inert on arrival.** Fixed in six files:

- **`tasteService.getTasteData`** is the worst instance, and it is the shape to look for from
  now on. Two `.catch(() => [])` on `getTopArtists` did not merely lose a list: `[]` zeroed
  `artists.totalCount`, made the genre and country percentages divide by the **fabricated
  `Math.max(1, 0)` = 1**, and made `formatTasteTable` print "No artists matches found" for a
  user with 1000 top artists. The payload was then cached under **both** the `taste:` and the
  `taste-session:` key for 600s, and `tasteInteractions` serves all three button tabs out of
  that session. **One Last.fm 5xx became ten minutes of three confident wrong cards.** Both
  cache writes sit below the read, so nothing is written on the failure path, and a test pins
  that — a raise plus a cache write is a lie with a longer fuse.
- **`aiJudgeService`**: the same `[]` was the *punchline* of `.judge`. During an outage every
  user was rated "0 / 10 — Ghost Town Scrobbles" and told to go and listen to some records.
- **`featuredService.pickNewFeatured`**: the entry is pushed onto `historyLog` and rendered
  with a named person's real Discord handle, so the `[]` published a permanent record saying
  that person featured "Unknown Artist" with 0 plays.
- **`countrySlashCommands` (x2) and `countryCommands` (x2)**: caught the raise, set
  `countries = []`, and the next line answered **"No country data found for <name>"** —
  byte-identical to a user whose country genuinely is unknown. Now narrowed to
  `if (isSourceUnavailable(err)) throw err;`, because a genuine country-mapping failure still
  degrades. Both directions are pinned: a test that only asserts the raise passes happily
  against a blanket `rethrow`, which would break every real query failure.
- **`tasteSlashCommands` / `tasteCommands`**: catch `isSourceUnavailable` and reply "Could not
  load taste for <name> — Last.fm/the database is unreachable", and **re-throw anything else**,
  because dressing a `TypeError` up as a transient outage tells the user to retry a request
  that can never succeed and hides the bug from the log.

**`playRepository.getEntityTotalPlaycount`** was the last literal `0` in a user-facing number,
found by filtering the debt list for `[returns 0]` rather than reading it top-down.
`catch { return 0 }` is the worst value that method could return: an empty *list* is an honest
absence, a `0` renders as a fact. It feeds the artist/album/track playcount footers through
`playHistoryService`, so a dropped connection printed "0 plays" for a user who may well have
played that artist four hundred times. Wrapped in `orDatabaseUnavailable` — same shape, method
label only, because a `count` over `user_plays` with no matching rows **succeeds with `0`**, so
raising here does not break the genuine-zero case. **Only the query is inside the guard:**
building the predicate cannot fail, and a bug there must not be logged as "Database
unavailable" and sent chasing Postgres.

**Five sites were left alone, each with the reason inline** (`// CORRECT AS IS`): the mosaic
cover hunt in `topBuilders` (rung 4 of 4, decorative, nowhere to render a "could not load");
`featuredService`'s user pick (returns `[]` as `null`, a true statement about what is
rendered); `profileService`'s sentinel `0` (never rendered — the card re-derives it from
`userArtist`); `indexService`'s three top-list blocks (each already has its own try/catch
setting `stats.error`, which is the path that keeps the stale-index sweep picking them back up
— `touchLastIndexed` is gated on `!stats.error`, so a raise that aborted the method would have
left the user looking neither indexed nor failed and never retried); and `playRepository`'s
raw-query fallback, whose catch **re-asks the same question** as an independent `findMany` and
propagates untouched if that throws too.

**Two tests asserted the bug and were replaced with the pair**, not weakened:
`tasteService.test.ts` had *"degrades to an empty comparison when a top-artists query fails"*
and *"still returns user 1 when only user 2 fails"* — both titled for the defect, both
asserting `resolves.toEqual([])`. They are now *a failure raises* AND *a query that RAN and
found nothing still returns the empty comparison*, plus *renders 0 for a genuine zero*. The
one-sided case is pinned in both directions too: with user 1 loaded and user 2 empty every row
is missing and the surviving total describes only one side, so the table reads "you share
nothing" about a pair who share plenty. **There is no partial answer.**

**Five mutations, re-run by the lead this round** rather than taken on trust. Recorded because
the *pair* staying green is the part that matters — a test that cannot fail and a mutation that
catches nothing are the same defect.

| Mutation | Result |
|---|---|
| `orDatabaseUnavailable`'s `throw` → `return 0 as unknown as T` | **1 red**, 41 green — the genuine-zero test correctly unaffected |
| `tasteService`'s `throw err` → both artists set to `[]` | **6 red**, 54 green — both honest-empty tests unaffected |
| `countrySlashCommands`' `if (isSourceUnavailable(err))` → `if (false && ...)` | **3 red**, 9 green — both "still degrades a genuine query failure" tests unaffected |
| `getTopArtists`' `orUnavailable(...)` → `return []` | **3 red**, 123 green — the genuine-empty test unaffected |
| residue sweep for `LEAD MUTATION` | none — the tree is byte-identical to the pre-mutation diff |

**Honest limits, unchanged.** Every one of these paths is verified by mocked tests only. No
test here has ever seen a dead Last.fm, a dead socket or a real Discord reply. "A Last.fm 5xx
now produces a visible error instead of an empty taste table" is a claim about code; confirming
it in production means watching the Railway log during an actual outage. The memory peak is
still not measured. The 516 db tests still skip locally.

### A-tier 1h — the laundering audit, and the boundary that ate the fix

The queue above kept saying "the raise was inert on arrival", which is a question about a
**call graph**, not about a file. So: build the list of everything that can now throw
deliberately (48 methods across 17 files), find every call site of each, and classify what each
site does with the throw. The instrument was a throwaway AST sweep — a `try` whose catch has no
`throw` in it, or a chained `.catch()` whose handler returns a default, is a laundering site.
**235 call sites: 59 candidates, 160 already propagate, 16 re-throw.** It was deleted rather
than committed — the receiver filter was a name regex and one bug in it (a lowercase path
segment) silently truncated the roster to 12 methods, which is the same class of defect as a
detector that reports zero.

**The tally is not the finding. The finding is that the three worst sites were in files no debt
list would ever have shown, and one of them wrote to the database.**

- **`crownService.getHolderLivePlaycount` — the worst. A Last.fm outage permanently dethroned a
  real person.** `getArtistInfo` returning a throw was caught and turned into `null`, and `null`
  reads as "the holder is not ahead", so `replaceCrown` ran and the store got a row naming the
  **challenger** as holder and the **real holder** as dethroned — announced, in a card, in their
  names. The `errorRateTracker` kill switch does not cover it: it needs 20+ tracked calls and
  25% errors, so one scoped `artist.getinfo` failure sails past it. This is the only site found
  this round whose failure is not merely rendered but **persisted**.
- **`exposedService` — a fabricated acquittal, and a fabricated claim about the search itself.**
  Every read ended `catch { return null }`, and `null` renders
  `Status: Cleared`: "dug through the database, cross-referenced the genre tables, and found
  zero secret guilty pleasures" — to a real, named person, during an outage. It also fabricates
  the *process*, which is worse than fabricating the result. Its `genreService` calls are
  deliberately left **unwrapped**, because that service already raises and wrapping it would
  relabel a caller bug as an outage; only the raw `db.*`/`playRepo` reads are wrapped.
- **`friendsCommands.addFriends` — "Could not find N users on Last.fm."** The loop filed the
  outage into `notFound`, and the builder heads that list exactly that way. A confident claim
  that real people do not exist, made while Last.fm was down and nobody had asked it. Different
  from the previous commit's fix of the same loop, which correctly stopped a throw aborting the
  loop mid-way but filed the failure as an absence. **Both properties now hold**: the loop
  finishes, and the failure is not reported as "not found".
- **`countrySlashCommands:376` / `countryCommands:254` — the two handlers the last commit
  missed.** `buildArtistCountryInfoResponse` prints its "You have N plays" clause only when
  `userPlaycount > 0`, so the outage card was byte-identical to the card for someone who has
  never played the artist. All six catches in those two files now agree.
- **Dead buttons.** `topInteractions`, `artistInteractions` and `playcountInteractions` each had
  one catch covering their whole handler; pressing a nav arrow or a reroll button produced no
  movement and no word, in Discord or in Railway. Narrowed.

**And then the fix had a hole in it, which the audit's own author found and did not paper
over.** The re-throws land in `interactionHandler`'s catch-all, which gated on
`!interaction.replied && !interaction.deferred` — and `deferred` is set by `deferUpdate()`, which
**every paginator and nav button calls before it reads anything**, precisely so a slow source
cannot blow the 3s acknowledgement window. So the gate silently discarded the throw in exactly
the case it existed to report: a slow outage, on a button. The three interaction files had traded
"silent" for "logged", and the user still saw nothing. The boundary now uses `followUp` once
deferred, and names the source: "Could not reach Last.fm/the database. Please try again", with
a defect still reading as a defect. Six tests, and the load-bearing one is
`expect(followUp).toHaveBeenCalled()` — which fails against the old gate for the right reason,
the handler re-threw correctly in both versions.

**Two bugs the agents found in their own work, and reported rather than hidden**, which is worth
more than the fixes: a mutation on `globalListeners ?? 0` **passed** because every test supplied
both figures, so the branch the mutation touched never executed — the unreachable-mutation trap
for the third time in this repo, and the cure was a new test case rather than a deleted
assertion. And a crown boundary test passed *under mutation* because a `null` guild made the
block unreachable.

**A latent crash, found because a new code path could finally reach it.**
`FriendBuilders.buildAddFriendsResultResponse` throws `Invalid string length` when handed three
empty lists — `setContent('')` is rejected by discord.js. It was unreachable because every
argument used to land in exactly one of the three buckets; the fourth bucket in `.addfriends`
made it reachable. Fixed in the builder rather than worked around in the one caller, because
`friendSlashCommands` can still reach it. Mutation-checked: removing the guard is 2 red / 2 green.

**Nine `// CORRECT AS IS` sites adjudicated, and two of the claims in the plan were FALSE** —
recorded because being wrong about a site you are *not* changing is the failure mode this
section is for. `topBuilders` was never catching a Last.fm raise: `getTopTracksForArtistGlobal`
is a Postgres aggregate, so the source was mislabelled. And the sweep's one apparent
`genreService` laundering site is a `SpotifySearchApi` call. `fmFooterResolver`'s class comment
also **overstates its own blast radius** — it argues a user would lose their whole Now Playing
card, but both callers already `await getUserInfo` upstream, so a pure Last.fm outage kills that
card regardless. The real trigger for those three catches is the DB aggregate, not Last.fm.

**Gates, lead alone: `tsc --noEmit` clean, 4244 passed + 516 db skipped = 4760 (256 files), lint
0 errors / 351 warnings, `silent-failure-default` 523 against budget 604.** Two lint errors and
20 typecheck errors came out of the batch and were fixed by the lead, not by the agents that
wrote them — the agents were told not to run the gates, and **`npm test` does not typecheck**.

**Not verified.** No live bot, no real Discord, no real Last.fm outage, no real database
failure. The re-thrown errors render through `interactionHandler` and `commandDispatcher`, both
read but neither exercised end to end. The 516 db tests still skip locally. The `crownService`
re-throw means a who-knows card shows **no crown at all** during a scoped Last.fm failure —
an honest absence rather than a wrong crown, and strictly better than the alternative, but it is
a visible regression for that card and the lead's call to confirm.

### A-tier 1i — the remaining 500, in four clusters

The laundering audit could only see callers of methods that **raise**. The other ~520 sites wrap
raw Prisma calls, so they never raise and nothing above them can save them. Four agents, four
disjoint file sets, ranked by blast radius. **Of roughly 150 sites adjudicated, 13 were fixed
and the rest were left alone with the reason inline** — which is the expected ratio by this point
in the phase, and the reason the count is not the target.

**Two more lies the debt list could not rank, both found by reading rather than counting:**

- 🐛 **`crownInteractions`: a failed artist lookup rendered a card for an artist called "42".**
  `buildCrownDuelResponse` writes `artist-whoknows:${artistId}` — a bare numeric Artist row id,
  not a name — and the catch "fell back to `decodeURIComponent`". Decoding `"42"` yields `"42"`.
  The who-knows card was then built for an artist literally named 42, and **that wrong name was
  stamped into the Crown button's `customId`**, where it survives every later press of a message
  that is never re-rendered. Permanent, in a file no debt list pointed at.
- 🐛 **`componentPaginatorService`: the cursor was committed before the page was fetched.** So a
  failed render left the session claiming a page the message was not showing, and the next press
  computed its target from the phantom page — **silently skipping a page of real rows.** The
  assignment moved below `update()`. The page the user is looking at is still never destroyed on
  a failed fetch; that part was already the recorded correct trade.

**`userService`: seven identical `[returns null]` setters, and the worst shape in the set.** A
failed settings write replied **"Timezone updated to Europe/London"** over a row that was never
written, and the previous value stayed live from cache for the full 300s TTL — so it goes
*stale* rather than merely wrong, and nothing errors or logs. The seven differed in exactly two
ways (column, echoed value) and are now one `writeUserSetting`. The one test that pinned it was
titled *"returns the requested value and skips the eviction when the write fails"* and its
comment called the swallow deliberate. **That was the bug.**

**`playHistoryService:234` resolved the open question of which direction a `[returns 0]` site
fails in — this one is the confident zero, not the omitted clause.** `buildArtistPaceResponse`
*divides* by the result and then prints "No plays found on <artist> in the last 30 days", a
statement about what the user did, for someone who may have played the artist 400 times. The two
guild leaderboards rendered `[]` as **"No members found with plays in this server yet"** — a
claim about every member of a real server. Its helper was generalised from `(label, run)` to
`(method, label, run)` because a log line saying "while building the year overview" about a guild
leaderboard is itself a confident wrong diagnosis. The six `getYearOverview` labels are
byte-identical afterwards.

**The boundary asymmetry, confirmed and closed.** The component boundary named its source
(`interactionHandler.ts:370`); **neither command boundary did**, so the same outage produced
"Could not reach Last.fm" for a button and a generic "something went wrong" for `.top`, asking
the user to retry a command that cannot succeed. Both text and slash now name it. And the
`!interaction.deferred` gate that the previous commit removed had **travelled with the pattern
into three more files** — `albumInteractions`, `friendInteractions`, and (a different shape) the
crown resolver — all reproduced verbatim. One of the two friend catches is a **write**
(`removeFriend`), and its neighbour already carried a comment saying a failed delete must not
look like a successful one: true for `false`, false for a throw.

**The music module: 108 sites reviewed, 4 claims false, 4 real defects, 104 left alone.** The
adjudication prompts predicted most would be correct — chapter state is decoration, a ladder rung
returns `null` for the next rung, teardown errors arrive after Discord already decided the
outcome. That held. The four that did not:

1. **`musicService`: a pasted YouTube URL with every node down became `loadType:'empty'`, and
   the user was told "No tracks found for: <url>".** The SoundCloud branch 20 lines above already
   had the correct `null → 'error'` / `tracks: [] → 'empty'` pair, with two tests naming the
   contract. The URL path had no such pair, so the asymmetry was the bug.
2. **`cacheService`: a `redis.ttl()` failure between GET and TTL produced a permanent
   in-process cache entry.** The file's own comment describes that exact promotion as the bug
   that once froze negative artwork markers "for the life of the process" — and the guard had a
   hole on its own failure path. Now a three-state return: finite, genuinely no expiry, unknown.
3. **`lyricsService`: a 10-second provider outage froze "no lyrics" for an hour.** A negative
   cache entry is now written only if a provider actually answered. The existing 404 test (all
   legs say "no") is a real answer and must still cache — it does.
4. **`musicInteractions`: `seek()` returns `null` for four different reasons**, and the reply said
   "No track is currently playing" for all of them. The old assertion **encoded the lie**.

**One more defect found and deliberately NOT fixed**, because the fix is not in the file: a
`guild.members.fetch` failure leaves `WhoKnowsUser.roles` undefined, `crownService` reads that as
"no roles", and **a transient Discord failure can hand the crown to the next user down** — the
same class as the Last.fm live-recheck lie already fixed, on the Discord side. Raising would
delete a complete leaderboard of real people, and the dominant reason that catch fires is a
member who genuinely left, which is an absence. A correct fix needs a tri-state on
`WhoKnowsUser.roles` ("no roles" vs "roles unknown") plus a matching change in `crownService`,
and it needs to distinguish Discord's unknown-member from a 5xx by error code, which could not be
verified from source. **Documented in place so the seam is visible.** The same agent also flagged
`prefixService.getPrefix`, which swallows and returns `.`, so during an outage a guild with a
custom prefix sees "Unknown command `.foo`" — a plausible wrong answer at the very top of the text
path, in a file nobody owned.

**Gates, lead alone: `tsc --noEmit` clean, 4334 passed + 516 db skipped = 4850 (263 files), lint
0 errors / 351 warnings, `silent-failure-default` 513 against budget 604.** The batch produced 13
typecheck errors and 1 lint error, all fixed by the lead: 6 were `interaction.followUp(payload)`
failing on the discord.js overload — an extracted `payload` variable loses contextual typing
while the inline literal the rest of each file already uses compiles clean — and 7 were the
**zero-arg-mock tuple trap**, now hit for the third time in this project: `mock.calls[0][1]` on a
`vi.fn(async () => …)` is a compile error that vitest never reports.

**And I used the one tool the handoff says corrupts files.** Fixing those 7 test errors I reached
for PowerShell `-replace` + `Set-Content` rather than the edit tool. Verified afterwards rather
than assumed: 196 lines unchanged, no BOM, LF, trailing newline present, and exactly the 4
intended sites matched. It was fine this time, and the handoff's warning is about a different
occasion. **The correct move is still the edit tool, and the correct response to having used the
wrong one is to prove the file is intact, not to hope.**

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
- **A-tier 1 is not finished, and the remaining queue is not the interesting part.** 526
  `silent-failure-default` sites remain, but the count is not the target and most of what is
  left is decoration, autocomplete, background enrichment and cache warming — the categories
  the plan says to leave alone with a `// CORRECT AS IS` comment. The queue that *is*
  interesting is the one the last round found by asking a different question: **which callers
  launder a raise their layer below now throws.** Six of them, and none of them were in any
  debt list, because none of them was where the failure was invented.
- **A raise is only worth what the layers above it do with it.** The six `lastFmRepository`
  conversions would have been inert had the laundering not been fixed in the same round. A
  test that only proves "the repository raises" is a test that cannot fail if the user still
  sees an empty card.

## Progress

Tracked in `PLAN_PROGRESS.md`. Metrics that are re-measured, never carried forward on trust.
