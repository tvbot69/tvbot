---
name: tvbot
description: Operating manual for the tvbot Discord music/stats bot (fmbot mirror). Load for playback, Lavalink, chapters, artwork, search ladders, adding commands, handlers, performance, reliability, or debugging. Contains today's real module names, the verification gates, and the incident-derived rules that are not obvious from the code.
---

# tvbot — Senior Engineer Operating Manual

You are the dedicated core engineer on **tvbot**, a private unlimited Discord bot mirroring `fmbot-dev` for a closed friend group. Two pillars: Last.fm statistics/social intelligence, and Lavalink music playback.

`AGENTS.md` is auto-loaded and is the source of truth for rules, the symptom→log-line runbook, the known failure modes and the test-gap analysis. **Read it first.** This file is the operational companion: what the code looks like *today*, how to test it, and how to work here.

**Everything below was verified against `main` on 2026-09-27. If it disagrees with the code, the code is right — and fix this file.**

---

## 1. Verification gates — non-negotiable, in this order

1. `npm run build` — must be clean. **A failed build means the task is not done.**
2. `npm test` — all suites green. **Never weaken or delete a test to make something pass** unless the user approves.
3. Commit only what the task touched (`git add <specific paths>`). Never `git add -A`.
4. Push **only** when asked.

Current baseline: **123 test files / 961 tests.** If that number is wrong, this file is wrong — check `npm test` and correct it here.

Commit style: `feat(music): …`, `fix(music): …`, `refactor(music): …`, `test(music): …`, `chore(cleanup): …`.

---

## 2. How to actually work here

**Read logs before theorising.** Four multi-hour bugs on 2026-09-27 all passed a fully green suite first and all were found by grepping log output. A green suite means the code matches the doubles — nothing more. See `AGENTS.md` §9 for the symptom→log-line table; the highest-value greps are `Chapter art`, `Stale position read`, `fallback rung` and `Text command name collision`.

**Probe the real API rather than reasoning from memory.** When the cause looks like "the provider is wrong", it usually is. Write a throwaway `.mjs`, read keys from `.env`, never print them:

```bash
node -e "const f=require('fs');const e=Object.fromEntries(f.readFileSync('.env','utf8').split(/\r?\n/).filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)]})); …"
```

Two of the biggest bugs this session were confirmed that way in under a minute — and both contradicted what I was confident the API would return.

**Verify dead code before deleting it.** Grep for production *and* test references, then check whether the "caller" is itself reachable. A stub returning `null` makes its caller's branch dead. This session that surfaced 20 dead methods, 3 dead injected dependencies, and a `getArtistForSpotifyId` whose single caller was unreachable.

**Delete scrapped approaches completely.** No flags, no legacy rungs, no commented-out remnants.

**Use `path:line` references** in anything you hand over. Never fabricate a result — if a check was not run, say so.

---

## 3. Playback architecture — as it is today

The music module is a **strict DAG**. Nothing below `musicService.ts` imports it back.

```
src/bot/services/music/
  musicTypes.ts            leaf ports only — imports NOTHING from the module
  musicNodeHealth.ts       isNodeCooling / hasHealthyNode (tolerant of test doubles)
  musicConstants.ts        shared timeouts and tolerances
  musicTrackArtwork.ts     isYoutubeThumb, preCleanArtwork, sanitizeOverride,
                           leadArtist + MusicTrackArtwork (backfill + warmup)
  musicTrackAdoption.ts    adoptMirrorTrack (pure)
  musicSearchLadder.ts     ISRC-first → title → plugin/resolver/soundcloud
  musicPlayerRegistry.ts   getOrCreatePlayer, destroyed guard, FILTER_DEFINITIONS
  musicPlaybackControls.ts pause/resume/seek/previous/volume/filters/loop/24-7
  musicService.ts          composition root — the ONLY registered token
  moonlinkManager.ts       node failover, cooldowns (deliberately cohesive)
  queueService.ts          persisted guild prefs, history, calculatePosition

src/bot/handlers/music/
  musicEventListeners.ts   one method per Moonlink event
  nowPlayingCardPublisher.ts  publishProgress, coalescing, 429 retries
  chapterTimeline.ts       probe, derive, seek swap
  chapterArtController.ts  per-chapter cover, prefetch, retry timer
  karaokeController.ts     lyric window + boundary timer
  alternateTrackFinder.ts  the four fallback rungs
  fallbackBudget.ts        budget Maps + song circuit breaker
  voiceLifecycle.ts        VoiceStateUpdate / ChannelDelete / GuildDelete
  cardFingerprint.ts       pure fingerprint + fallback-query helpers
```

**Play path**: `play()` routes by input kind → `MusicSearchLadder` (Home yt-dlp resolver → SoundCloud) → `MoonlinkManager` (failover) → `enqueueLavalinkTracks` (the single enqueue choke point). Unresolved playlist entries sit in a **just-in-time pending queue** resolved 2 tracks ahead.

**Chapters** (`>20 min` only): description timestamps from one Data API call, parsed and cached. `ChapterTimeline.chapterCardFor` derives the card; `ChapterArtController` resolves covers behind an 8s race with a dedicated 30s retry; `swapChapterOnSeek` handles seeks.

**Card publishing**: `publishProgress` on-demand only (no polling) with a fingerprint dirty-check, plus `scheduleImmediateProgress` (300ms debounce) for event-driven edits.

### The rules that are not visible in the code

- **Never trust `current.position` / `current.time`.** Moonlink owns them and rewrites them from the *pre-seek* position for seconds after a seek. `queueService.calculatePosition` treats a recent `lastUserSeekAt`/`lastUserSeekPos` as authoritative, forward-only.
- **The pending store must hand back the LIVE array.** `shuffle` reorders and `remove` splices in place; a copying port silently turns both into no-ops while every assertion still passes.
- **A backwards position is stale data, not a rewind** — unless a recorded seek intent explains it.
- **A chapter whose art genuinely cannot be found holds the previous cover** indefinitely. That is intentional (it beats flashing the wrong image), but it is why a catalogue miss reads as "art is broken". Fix the matching, not the hold.
- **Timeout→node-cooldown is load-bearing**, from a real uplink-stall incident. Do not "simplify" it away.
- **The Redis FIFO warning is expected.** Write-then-trim ordering is consistent and failure replay is intentional.

Full list with incidents: `AGENTS.md` §10.

---

## 4. Testing patterns — copy these, do not invent

- Vitest. `reflect-metadata` must be the **first import** in any test touching a `tsyringe` module.
- Build a `MusicHandler` with stub objects, then cast to reach privates. `vi.spyOn(handler, 'publishProgress')`.
- Mock network with `vi.spyOn(globalThis, 'fetch')`; assert URLs from `spy.mock.calls`.
- Module-level Maps persist within a test file — use a distinct 11-char id per test.
- Fresh module state: `vi.resetModules()` + dynamic `await import(...)`.
- `npm test` does **not** typecheck. Run `npm run build` too, or a test file with a bad constructor arity will pass vitest and break the build.

### Two contract facts that shape what you may extract

1. **Never add constructor parameters to `MusicHandler`** — the suite builds it positionally with 3 args (`client`, `{getManager}`, `{getQueueInfo, is247}`). Construct collaborators *inside* the existing constructor body, or extract free functions.
2. **Tests reach privates via casts and replace methods on the instance.** So any extracted member must still be reachable on the original object (delegate, not removal), and every cross-cluster call must go **through the host instance** — never a sibling collaborator — or `vi.spyOn` and own-property shadows stop working. Services that tests reassign after construction (`artworkService`, `colorService`) must be read live through the host, never captured by value.

`AGENTS.md` §5 has the full list.

### What the suite cannot do

It did not catch the date-prefix artwork bug, the seek-position bug, or the chapter rewind — all because our tests were written against our own abstraction. The fixes are in `AGENTS.md` §11: real provider fixtures, invariant tests over event sequences, and **deliberately uncooperative doubles** (the last one is still open). Prefer a test that drives the real Moonlink interface over one that asserts on our abstraction — that is the one pattern that *did* catch a regression.

---

## 5. Adding a command (1:1 from fmbot)

1. Read the C# reference in `fmbot-dev/` (`TextCommands/`, `Builders/`, `Services/`).
2. Service method in `src/bot/services/`.
3. Response in `src/bot/builders/*Builders.ts` returning `ResponseModel`.
4. Slash command in `src/bot/slashCommands/` (+ `index.ts`) **and** text command in `src/bot/textCommands/` (+ `index.ts`).
5. Check the name is **unique across both families** — the registry silently lets the later registration win and the other becomes unreachable. It logs `Text command name collision` at startup; check it every time.
6. Interactive pieces → `src/bot/interactions/` + a route in `handlers/interactionHandler.ts`.
7. Wire singletons in `src/bot/startup.ts:configureContainer()`. Positional constructor calls there are load-bearing.
8. `npm run build && npm test`.

**Database changes**: edit `src/persistence/prisma/schema.prisma` → `npm run db:generate` → verify with `npx prisma migrate status`.

---

## 6. When you are asked "is it working / perfect?"

Answer honestly and separate the two things:

- **Verified**: anything a test asserts, and anything you measured. Say which.
- **Not verified**: voice connection, audio throughput, FFmpeg, and real Discord behaviour. No test covers these.

A refactor that is *supposed* to be invisible succeeding is the goal, not proof of health. The only real evidence is the user playing the bot and reading the log — which is how every real bug this session was found.
