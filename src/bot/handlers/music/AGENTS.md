# src/bot/handlers/music — operating manual

This subtree is the **presentation and lifecycle half** of playback. The eight modules
in this directory are collaborators; the host that owns them is one level up, in
`../musicHandler.ts`, and it constructs all eight in its own constructor. The other half
— the search ladder, node health, queue math and the just-in-time pending store — lives
in `src/bot/services/music/`, and several rules below point there.

Read the root `AGENTS.md` §4 for the DAG and §2 for the gates. The A-tier definitions
(§0, §2.1) are not repeated here.

## Contents

- `cardFingerprint.ts` — pure. `fingerprintFor`, `chapterKeyFor`, `clientFailuresText`, `buildFallbackQuery`. Re-exported as private statics on `MusicHandler` (`musicHandler.ts:225-232`) because a test reads them off the class. Keep the aliases.
- `nowPlayingCardPublisher.ts` — `publishProgress`, the fingerprint dirty-check, in-flight coalescing, `msg.edit`, 10008 recovery, 429-aware bounded retries.
- `musicEventListeners.ts` — one named method per Moonlink event; every listener **returns** its promise (`musicEventListeners.ts:96-114`) so the suite can `await` it.
- `chapterTimeline.ts` — `resolveVideoChapters`, `chapterCardFor`, `swapChapterOnSeek`.
- `chapterArtController.ts` — per-chapter cover lookup, upcoming-chapter warm, the dedicated retry timer.
- `voiceLifecycle.ts` — kick grace, empty-channel and inactivity timers, `guildDelete`.
- `karaokeController.ts` — synced-lyric window and its boundary timer.
- `alternateTrackFinder.ts` + `fallbackBudget.ts` — the fallback ladder and its two breakers.

## Invariants that broke in production

### 1. The pending store must hand back the LIVE array

**Why:** `shuffle` and `remove` mutate the pending array **in place**. A port that
returns a copy makes both silently no-ops while every assertion still passes — nothing
fails, the queue just stops obeying the user.

The store is `MusicService.pendingSpotify` (`src/bot/services/music/musicService.ts:114`).
Read it back through the Map, never through a rebuild, and mutate the array you got:
`musicService.ts:1292` (`liveList.splice`) and `musicService.ts:1343` (`list.splice`).
`jumpToCombined` re-reads the list after its `await` and re-checks identity against the
entry it captured (`musicService.ts:1277-1285`) precisely because the array can be
swapped underneath it.

Locked by `src/bot/services/music/pendingStoreIdentity.test.ts` — the identity cases
are at lines 102, 168 and 181.

### 2. A position that moves BACKWARDS is stale data, not a rewind

**Why:** a `queue.position` of 0 captured before a seek's REST landed rewound the card
straight to chapter 0, with no delay and no confirmation. Measured 2026-09-27: `.seek
21:58` correctly showed chapter 8 with resolved art, then one second later the card
reverted to chapter 0.

`chapterTimeline.ts:171-194` refuses the rewind. It requires BOTH a regression past
`CHAPTER_REGRESSION_TOLERANCE_MS` (`musicConstants.ts:44`, 2s) **and** no recorded seek
intent. A genuine backward seek always carries `lastUserSeekAt`/`lastUserSeekPos`.

`seek()` records that intent **before** it awaits the node
(`src/bot/services/music/musicPlaybackControls.ts:96-97`), so a slow REST round-trip
cannot lose it. The intent stays authoritative for `USER_SEEK_INTENT_WINDOW_MS`
(`musicConstants.ts:37`, 30s). The position read itself consumes the same markers at
`queueService.ts:127-141` and `:173-182`.

Tests: `src/bot/handlers/musicChapterRewind.test.ts:84, 100, 115, 129, 140` and
`src/bot/services/music/queuePositionSeek.test.ts:76, 84`.

### 3. A deliberate seek must not pay the settle window

**Why:** the implausible-jump guard exists for **clock drift**, not for listeners. A
`.seek 21:50` across five chapters was logged "Implausible chapter jump" twice and took
~17s to commit.

`chapterTimeline.ts:205-253` checks the same seek intent before the settle path. A jump
the user asked for commits immediately (`:223-228`). Only a jump with no intent behind
it holds the current chapter for `CHAPTER_JUMP_CONFIRM_MS` (`musicConstants.ts:29`, 4s)
and re-derives once (`:230-246`).

### 4. `trackStart` must derive the chapter from the real position

**Why:** a track that starts part-way through (fallback resume, restored session)
otherwise renders chapter 0.

`musicEventListeners.ts:204-207` passes `queueService.calculatePosition(player)`, never
a literal `0`. Any replacement must too.

### 5. A chapter whose art cannot be found HOLDS the previous cover

**Why:** holding beats flashing the wrong image. It is intentional and indefinite.

`resolveDisplayedChapter` (`src/bot/services/music/videoChapters.ts:38-49`) substitutes
`lastCoverUrl` when the chapter has no `artworkUrl`, and falls back through
`lastCoverUrl` before `trackArtworkUrl` even when there is no chapter. The publisher
reads it at `nowPlayingCardPublisher.ts:101-113`.

The consequence you must internalise: **a catalogue miss reads to the user as "the art
is broken".** Fix the *matching* — root `AGENTS.md` §3.2, §3.3 — never the hold. A
mediated/transition chapter retries with the lead song first
(`chapterArtController.ts:61-66`); a genuinely missing cover retries at most every
`CHAPTER_ART_RETRY_MS` (`musicConstants.ts:23`, 30s) on a **dedicated** timer, not on
publishes (`:107-130`), because a paused player otherwise re-swept four artwork
providers every 30s for a cover that does not exist.

### 6. Timeout → node-cooldown is load-bearing. Do not "fix" it.

**Why:** a hung search keeps cooling the node. That behaviour came from a real
uplink-stall incident.

`searchWithTimeout` calls `noteRestFailure` on both a null return and a throw
(`src/bot/services/music/musicSearchLadder.ts:113-121`), which arms the cooldown in
`moonlinkManager.ts:217-218`. A **genuine miss** — an answered search with zero tracks
— must NOT cool anything; an empty result is a success, not a failure.

Pinned both ways: `src/bot/handlers/musicFallback.test.ts:2212` ("treats a hung node
(timeout-null) like a throw — the incident shape") and `:2223` ("never cools a node for
a genuine miss"). Only the **migration** half is gated: one sighting cools the node, a
second inside the window is what migrates players, because migrating re-seeks every
other guild's playback mid-song (`moonlinkManager.ts:200-231`).

### 7. The durable Redis FIFO mirror is write-then-trim, and that is the design

This one lives outside this subtree, in `src/bot/services/`. Do not reorder it.

`CacheService` exposes the list as push / pop-count / length
(`src/bot/services/system/cacheService.ts:211`, `:219`, `:235`). `pump` writes first, runs the
processor, and only then trims — **the trim is the acknowledgement**
(`src/bot/services/lastfm/userUpdateQueueService.ts:125-135`, and the index twin at
`src/bot/services/lastfm/userIndexQueueService.ts:113-121`). A failed trim replays the batch
after a restart, and the processor is an idempotent delta sync, so the replay costs
work and no correctness. That is deliberate, and the code says so in as many words at
`userUpdateQueueService.ts:128-133`.

The `Logger.warn` you will see for a *rehydrate* mismatch is a real signal, not noise:
`listPopCount` cannot reject, so `backlog.length < before` is the only **proven** loss
and it is reported as an error (`userUpdateQueueService.ts:75-82`). `before === 0` stays
silent on purpose — it proves nothing. Leave the two apart.

## Constructor contract

**Never add a constructor parameter to `MusicHandler` or `MusicService`.** Both are built
positionally across the whole suite; adding a required parameter breaks every call site
at build time, and adding an optional one still breaks the argument order in
`startup.ts`.

- `MusicHandler` — `musicHandler.ts:68-77`: `(client, moonlinkManager, queueService, colorService?, voiceChannelStatusService?, botScrobblingService?, lyricsService?, artworkService?)`. Tests pass **exactly the first three** (`musicFallback.test.ts:2249-2252`).
- `MusicService` — `musicService.ts:168-175`: `(moonlinkManager, spotifyResolver, queueService, playlistChunkManager?, artworkService?)`. Tests pass the first three (`pendingStoreIdentity.test.ts:73-77`).

Add collaborators by constructing them **inside** the existing constructor body
(`musicHandler.ts:87-139`) or as free functions taking deps as arguments.

Three rules that follow from how this suite reaches in:

- **Extracted members must stay reachable on the host.** Tests cast with
  `as unknown as {...}` and replace methods on the instance. A delegate
  (`musicHandler.ts:153-180`, `:416-426`) keeps every call site compiling; removal
  breaks the spy.
- **Every cross-cluster call goes through the host instance** — `this.publishProgress(...)`,
  `this.host.scheduleImmediateProgress(...)`, never `sibling.foo(...)`. A sibling call
  is invisible to `vi.spyOn` and to own-property shadowing, so the card silently
  freezes instead of failing. Stated at `nowPlayingCardPublisher.ts:34-38`.
- **State Maps stay owned by the host and are passed in by reference.** A copied Map
  breaks both the tests that read it and the `forgetGuild` sweep (`musicHandler.ts:555-574`).
  Each collaborator's constructor comment says so — `chapterArtController.ts:19-22`,
  `nowPlayingCardPublisher.ts:29-32`, `musicHandler.ts:249-251`, `:411-413`, `:449-451`.
- **Services tests reassign after construction** (`artworkService`, `colorService`) are
  read **live through the host**, never captured into a collaborator field
  (`chapterArtController.ts:24-31`).

## Do not reintroduce

- **No polling timer.** There is no `setInterval` tick. Chapter and lyric advances are
  one-shot boundary timers armed to the next boundary (`musicHandler.ts:288-316`,
  `armKaraokeTimer`); everything else is event-driven through `musicEventListeners`.
  `refreshGuildCard` (`musicHandler.ts:359-378`) exists because the chapter timer is the
  only thing advancing chapters on a long set and a single swallowed throw inside
  `armChapterTimer` would freeze the card for the rest of the show.
- **Chapter logic never breaks playback.** Every chapter path is sync-only and
  try/caught: `musicHandler.ts:306-308`, `:313-315`, `chapterTimeline.ts:287-297`,
  `:360-362`, `chapterArtController.ts:102-104`, `:190-199`. Keep it that way, and keep
  it out of the resolver's pause/alert path (root `AGENTS.md` §3.6).
- **A failed art cascade is a rung finding nothing, not "this song has no artwork."**
  `chapterArtController.ts:54-58` — the `null` goes to the hold, and nothing is ever
  reported to the listener as a fact about the catalogue.
- **A malformed guild id is a caller bug, not a source failure.** Report it as
  `Logger.debug`, not as "database unavailable" — `musicHandler.ts:398-403` models the
  reasoning for a courtesy one-liner.
