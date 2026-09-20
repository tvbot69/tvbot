# tvbot — World-Class Hardening Plan (no new commands)

> **Goal:** make tvbot strictly more correct, more reliable, and more scalable than
> `fmbot` — zero new commands, zero new features. Every phase below is
> independently shippable, each ends with `npm run build && npm test` green.
>
> **Scale math:** Discord forces sharding at 2,500 guilds/connection → 1M guilds ≈
> **400 shards**. Everything architectural assumes 400 Node processes + a Lavalink
> pool + Postgres. Correctness phases pay off at 1 server; scale phases unlock growth.
>
> **Assumptions:** Postgres stays (Neon → pooled, see Phase 2); Redis becomes
> mandatory in prod; self-hosted Lavalink pool for music (Phase 3); hosting moves
> off single-container Railway when approaching ~2k guilds (Phase 2/5 notes).
> Non-goals: new commands, new providers, UI redesigns (mosaic work stays as-is).
>
> **Budget: $0.** Every item is tagged FREE (code/tests/free tiers only) or
> NEEDS-$ (deferred until funded — a free mitigation ships instead where one
> exists). Free tiers we will use: Upstash Redis (free), Sentry (free),
> GitHub Actions (free), Neon (free). Explicitly **won't-do: censor/NSFW
> scoring** — no moderation budget/tooling; official provider artwork + Discord's
> own explicit-content handling is the backstop.
>
> **Progress log:**
> - 2026-09-19: Phase 0.2 (slash register once), 0.5 (delta composite dedup +
>   hole escalation + sane failure backoff), 0.4 (crown live recheck + atomic
>   steal + outage kill-switch), 0.3 (privacy read-path in wk/crown/guild
>   rankings + full purge + `users.privacy_level` index) — implemented, 464
>   tests green. 0.1 (migrate deploy): prod baseline recorded 2026-09-19, boot
>   paths converted.
> - 2026-09-19: Phase 1.1 (imports persist + dedupe + recalc + honest counts),
>   1.2 (batched counter deltas, single-query crown leaderboard, dead 5000-row
>   reader deleted), 1.3 (ingest name normalization), 1.4 (2.5s button
>   auto-defer safety net), 1.5 (`fetchWithTimeout` across Deezer/iTunes/Apple
>   Web/Spotify API+scraper+token paths; Last.fm + lyrics already covered) —
>   implemented, 474 tests green.
> - 2026-09-19: Phase 3.1/3.2 FREE halves (public pool live-probed: 8 candidates
>   dead/hung, keeping the 2 verified nodes + verification procedure documented;
>   per-node retry preserved; healthy-count in /nodes; fallback budgets
>   3-per-track/5-per-guild with tried-id loop protection; playlist fan-out
>   per-track 8s race + SoundCloud second chance + partial flag; typed play
>   errors) — implemented, 482 tests green. Self-hosted pool stays NEEDS-$.
> - 2026-09-19: Phase 2.1 (ShardingManager + worker entry, off by default),
>   2.3 (single-owner global jobs), 2.4 (hot-path index migration, applied
>   live; pooling documented, directUrl deliberately deferred) — implemented,
>   484 tests green. 2.2 core (durable queues) + Redis rate limits + shared
>   TtlStore for all five interaction session caches (server/genre/country/
>   library-search/music-search, with Date revive) — implemented, 499 tests
>   green. Paginator render-closures stay in-memory by design (not serializable).
> - 2026-09-20: Phase 3.3/3.4 (kick rejoin grace, text/guild-delete cleanup,
>   split timer maps, chunk destroy-guards + chain cap, failover state restore,
>   skip/previous semantics proven, durable 247/prefs/opt-ins via migration,
>   15s dirty-checked progress edits, voice-status 429 backoff) — implemented,
>   509 tests green, migration applied live.
> - 2026-09-20: Phase 5 FREE parts (livez/readyz + readiness gates, 30s
>   graceful drain with queue/player/lavalink teardown, render semaphore(2) +
>   identical-render cache, misleading Lavalink-disabled message fixed,
>   Discord-webhook error feed instead of Sentry) — implemented, 521 tests
>   green. Sentry dropped: account/trial unwanted; webhook is free forever.
> - 2026-09-20: Phase 4 batch A (abuse_flags table + nightly velocity scan +
>   WK/crown/leaderboard enforcement, 5-per-name alt cap at login, autopost
>   atomic claim/rollback + 10-per-guild cap, admin gates on all read paths,
>   audit trail on destructive mutations) — implemented, 516 tests green,
>   migration applied live.
> - 2026-09-20: Phase 2.2 core (CacheService list/set/NX primitives, durable
>   update+index queues with restart rehydrate, REDIS_URL required in prod) —
>   implemented, 488 tests green. Rate-limit + session stores next.

---

## Phase 0 — Stop the bleeding (prod safety, days)

Small, surgical, highest regret-if-skipped. Ship first.

### 0.1 Versioned migrations, kill `db push --accept-data-loss` on boot
- **Refs:** `package.json:13`, `Dockerfile:81`, `nixpacks.toml:11`,
  `src/persistence/prisma/migrations/*` (exist, never applied).
- **Work:** boot/start becomes `prisma migrate deploy` (fail closed on error);
  remove `db push` from all three paths; add `directUrl` for migrations;
  one-time prod baseline (`migrate resolve --applied` to current state).
- **Done when:** 3 consecutive deploys apply zero unexpected DDL; `accept-data-loss`
  appears nowhere in boot paths.

### 0.2 Slash commands register once, not per shard per boot
- **Refs:** `src/bot/services/startupService.ts:110-117`.
- **Work:** hash-compare payloads, `set()` only on diff; shard-0-only (or CI script);
  staging-guild commands for canary via existing `BASE_SERVER_ID`.
- **Done when:** deploy logs show `commands unchanged, skipping` on steady state.

### 0.3 Privacy enforced at read time, not just purge time
- **Refs:** `src/bot/services/whoKnows/whoKnowsService.ts:43-96`,
  `src/bot/services/crown/crownService.ts:33-53`,
  `src/bot/services/guildRankingService.ts:268-580`,
  `src/persistence/repositories/guildUserRepository.ts:48-71`.
- **Work:** filter `Hide` + `self_block_from_who_knows` + `blockedFromCrowns` in WK /
  crown / server-ranking queries (join `users.privacy_level`); add
  `@@index([privacyLevel])` (`schema.prisma:41` has none). Complete the purge job
  (`timerService.ts:113-125`): plays + artists/albums/tracks + crowns + topartist
  cache keys, chunked, transactional.
- **Done when:** hidden/self-blocked user is unrankable in wk/top/server/crowns
  immediately after opting out (test with unit + staging check).

### 0.4 Crown steal re-checks live playcounts + Last.fm-outage kill switch
- **Refs:** `src/bot/services/crown/crownService.ts:28-110` (steal `:79-98`),
  `src/domain/lastfmErrorRateTracker.ts` (never gates anything).
- **Work:** fresh holder-playcount fetch before dethrone; derive health flag from
  the error-rate tracker and block steals/index-backfill/autoposts while elevated;
  wrap steal deactivate+create in one `$transaction` (+ partial unique index
  `UNIQUE(guild_id, LOWER(artist_name)) WHERE active`).
- **Done when:** steal under simulated stale data cannot dethrone; kill-switch test.

### 0.5 Delta sync stops trusting timestamps alone
- **Refs:** `src/bot/services/updateService.ts:296-330` (timestamp-keyed dedup),
  `214-232` (1–2 page cap silently truncates >400 scrobbles then advances cursor).
- **Work:** dedup/remove keys on `PlayRepository.playKey()` (`time|artist|track`,
  already added for index); when `totalScrobbles - stored > fetched`, enqueue a
  full `IndexService` run instead of dropping history; never advance `lastUpdate`
  on empty fetch unless zero-delta is confirmed; distinguish Last.fm error
  17/26 (private/deleted → flag, don't 46h-silence) from 429 (backoff 15m/1h).
- **Done when:** 500-scrobble burst + same-second double scrobble + private-profile
  cases covered by tests; no holes after forced scenarios.

---

## Phase 1 — Correctness hardening (weeks, still single-process safe)

### 1.1 `.import` actually imports
- **Refs:** `src/bot/services/importService.ts:153-159` (parses, bumps counter,
  persists nothing).
- **Work:** `batchInsertPlays` with `SpotifyImport/AppleMusicImport` source +
  `recalculateTopLists` in one `$transaction`; test asserts row counts.
- **Done when:** imported scrobbles appear in wk/at/top; counter equals rows.

### 1.2 Kill N+1s and unbounded reads (hot paths first)
- **Refs:** `playRepository.ts:351-421` (per-delta findUnique loop),
  `crownService.ts:168-179` (per-holder `getUserById`),
  `playRepository.ts:141-183` (unlimited `groupBy` → OOM at 384MB heap),
  `playService.ts:527-544` (5000 full rows → aggregate in JS),
  `playRepository.ts:478-481` (month materialized to count),
  `src/bot/services/whoKnows/*Service.ts` (`members.fetch` per row).
- **Work:** batch `findMany({in})` + bulk writes (or raw `INSERT…ON CONFLICT`);
  `take`-guard every `groupBy`/`findMany` (recalc reads aggregates, not raw plays);
  SQL-side `COUNT/GROUP BY`; `members.cache`-first, single chunked fetch for the
  missing, resolve display names only for the rendered slice.
- **Done when:** p95 wk/top latency halved on a 50k-play test user; heap flat.

### 1.3 Index hygiene for non-ASCII and compilations
- **Refs:** `genreService.ts:100-108` (`$`/`s` hacks), album/track artist matching.
- **Work:** canonical-name resolution at ingest (Last.fm autocorrect once, store
  canonical), album/track cover matching already strict — extend the same
  `matchesArtistName`/`matchesTrackTitle` discipline to any remaining
  first-result trust; Various-Artists handling (never attribute comp tracks to
  "Various Artists" as a real artist in WK/crowns).
- **Done when:** Mond-class collisions + Arabic transliterations covered by tests.

### 1.4 Interaction robustness pass
- **Refs:** `src/bot/handlers/interactionHandler.ts:381-548`,
  button handlers doing DB/API before `deferUpdate`, `customId` free-text embeds
  (`topInteractions.ts:24,56`, `nowPlayingInteractions.ts:45-149`).
- **Work:** defer-first in every slash/button/select path; opaque short customIds
  (`nanoid(12)` + payload store, 15m TTL) instead of embedded names (also fixes the
  100-char truncation route failures); `10062` vs real-error split everywhere;
  kill the `sendTyping` loops.
- **Done when:** slow-path (cold artwork + Puppeteer) commands never 10062;
  long artist/track names paginate fine.

### 1.5 Timeouts on every outbound fetch
- **Refs:** all `src/lastfm|spotify|deezer|applemusic` fetch sites; lyrics/Genius
  scrapes; scraper token refresh on 401-then-retry-once
  (`spotifyScraperService.ts:131`, `playlistChunkManager.ts:106-110` truncates at
  100 silently → surface "truncated, re-run", fix hardcoded total `:462`).
- **Work:** `AbortController` timeouts per provider class (reads 8s, scrapes 15s);
  no floating promises without callers handling rejection; token refresh parity
  between API and scraper paths.
- **Done when:** chaos test (blackholed provider) degrades in seconds, never hangs.

---

## Phase 2 — Scale architecture (the 1M-server unlock)

### 2.1 Sharding
- **Refs:** `src/bot/startup.ts:222-237,978-995`, `src/bot/index.ts:14-23`,
  `startup.ts:242-254` (single-process `ws.broadcast` patch — delete).
- **Work:** `shardManager.ts` (`ShardingManager`, `totalShards:'auto'`) +
  `shardWorker.ts` (current boot); shard id/count via env; voice stays on the
  guild-owning shard (already true via `DiscordJs` connector — assert in test).
- **Done when:** 2-shard staging boots, commands work on guilds pinned to each.

### 2.2 Redis mandatory; externalize all cross-shard state
- **Refs:** `cacheService.ts` (local-first), `userUpdateQueueService`,
  `userIndexQueueService` (10k cap, local, restart-volatile),
  `componentInteractionTracker`, `componentPaginatorService`,
  search/interaction caches, `rateLimitService` maps, `commandDispatcher` maps,
  `trackService` scrobble maps, `shortcutService`, `userService.blockedUsers`,
  `gameService` sessions, `autopostService` map, `spotifyTokenManager` caches,
  `telemetryService` counters.
- **Work:** `REDIS_URL` required in prod (`envValidator`); Redis-backed queues
  (BullMQ or LIST+SADD+TTL) replacing both in-mem queues; Redis sliding-window
  rate limits unified text+slash; Redis payload store for paginators/customIds;
  Redis pub/sub invalidation with local LRU as short-TTL L1 only; token manager
  single-flight via Redis lock; telemetry → OTel/Prom aggregation.
- **Done when:** rolling restart loses zero queue/session/rate-limit state (test).

### 2.3 Single-owner global jobs (stop 400× side effects)
- **Refs:** `timerService.ts:19-65`, `startupService.ts:76`,
  `autopostService.ts:226-262`, `enqueueOutdatedUsers`, lyric presence flapping.
- **Work:** leader election (shard-0 or Redis Redlock lease) for autoposts,
  queue pumps, lyric status, stats; partition user/index sweeps by
  `userId % totalShards`; autopost claim (`WHERE id AND lastPosted`) + rollback +
  per-guild cap (fmbot: 10/guild).
- **Done when:** 3-shard staging posts each autopost exactly once.

### 2.4 Postgres for 400 writers
- **Refs:** `src/persistence/prismaClient.ts:54-68`, `schema.prisma:5-8`.
- **Work:** pooled `DATABASE_URL` (`pgbouncer=true&connection_limit=2-5`,
  `pool_timeout=20`) + `DIRECT_URL` for `migrate deploy`; one client per process;
  functional indexes (`UPPER(name)`, trigram GIN for autocomplete/search,
  `guild_users(guild_id,user_id)`, play aggregation composites); read-replica for
  leaderboard scans; `withDbRetry` reads-only (never inside `$transaction`);
  chunked `createMany` (1–5k) with 120s tx budget on index path only.
- **Done when:** migration + index plan reviewed; pool math documented
  (400 shards × 2 conns < Neon cap).

### 2.5 Gateway posture for verification
- **Refs:** `startup.ts:223-229` (privileged `GuildMembers`+`MessageContent`).
- **Work:** justify each privileged intent for verification; kill full-guild
  `members.fetch` (`guildAdminCommands:160`) and per-row fetches (Phase 1.2);
  `ensureGuildExists`/`trackActivity` → batched fire-and-forget writer, 1h
  command throttle; drop `MessageContent` when prefix finally sunsets (keep both
  modes until then — no command changes, just intent readiness).
- **Done when:** verification paperwork unblocked; ready-loop completes without
  sequential 1M-upsert stall (batched `upsertMany`).

---

## Phase 3 — Music at scale (reliability, then capacity)

### 3.1 Lavalink resilience (NEEDS-$ pool deferred; FREE mitigations now)
- **Refs:** `src/config/lavalink.ts:13-32`, `moonlinkManager.ts:59-98`.
- **Work (FREE):** widen the public-node list (more free nodes configured, cooldown
  logic already handles bad ones); per-node retry config preserved (fix override
  at `moonlinkManager.ts:72-73`); `/nodes` shows `getHealthyNodeCount()`;
  search-429 puts nodes on cooldown; document `LAVALINK_NODES` JSON override.
- **Deferred (NEEDS-$):** `docker-compose.lavalink.yml` self-hosted pool + HPA.
- **Done when:** node flaps never stall a queue (fallback budgets in 3.2 carry it).

### 3.2 Fallback budgets (no retry storms, no infinite loops)
- **Refs:** `musicHandler.ts:139-386` (2 searches per failure, no counters),
  SC branch missing `identifier !== failedId` exclusion.
- **Work:** per-track tried-`encoded` set (cap 5), ≤3 fallbacks/track,
  ≤5/guild/60s then skip; exclude failed id in SC branch too; per-track 8s race
  in playlist fan-out (`musicService.ts:322-384`) with YT→SC per track +
  `partial:true` result flag; typed `PlayResult.errorReason`.
- **Done when:** 10-poison-track playlist skips through in seconds, nodes healthy.

### 3.3 State that survives restarts/kicks/failover
- **Refs:** `queueService.ts:7` (247 Set), `botScrobblingService.ts:18-19`
  (opt-ins), `playlistChunkManager.ts:27` + missing `clear()` on destroy/kick,
  `musicHandler.ts` timer-map collisions (queueEnd vs empty-channel sharing one
  map), `transferNode` dropping volume/filters/loop (`moonlinkManager.ts:365`),
  `getOrCreatePlayer` resetting prefs (`musicService.ts:44-70`).
- **Work:** persist 247/opt-ins/prefs (volume/loop/autoplay/filters) in DB/Redis,
  re-apply on create + after `transferNode` (+ seek to position); split timer
  maps, always delete on fire/destroy/stop; `clear()` chunk state on destroy,
  kick, channel-delete; kick → 3-min grace rejoin instead of instant wipe;
  text-channel-delete + guild-delete cleanup; `previous()` index-pointer rewrite;
  verify `skipto`/`skip(amount)` bounds against Moonlink semantics with tests;
  loop-aware skips.
- **Done when:** restart mid-queue resumes prefs; kick-rejoin keeps queue; tests
  for skip/skipto/previous/loop interplay.

### 3.4 Chatter discipline (stop 429ing Discord)
- **Refs:** progress updater 5s edits (`musicHandler.ts:41-88`), per-track
  `channels.fetch`, per-song voice-status PUTs.
- **Work:** 15s interval, edit-only-if-dirty, cached accent color, 429 backoff;
  coalesce voice-status updates; sparse autopost-style batching.
- **Done when:** 100-player soak shows zero 429s from music paths.

---

## Phase 4 — Abuse, trust & safety (better than fmbot)

- **WK abuse filter (fmbot parity+):** nightly trailing-8d scan (plays/day,
  ms-played sanity) → flag table → honored in WK/crown/top paths
  (`whoKnowsService.filterWhoKnowsObjects`, crown eligibility).
- **Alt/sybil caps:** max N Discord rows per Last.fm name at login (owner
  override); persist `Blocked` in DB + cached lookup (not the restart-volatile
  `userService.ts:25` Set).
- **Censor/NSFW: WON'T-DO** (no moderation budget/tooling — dropped per owner).
- **Autopost hardening:** DB-backed claim + rollback, 10/guild cap, single owner
  (with Phase 2.3).
- **Admin tiers + audit:** `ManageGuild` on read paths, owner-only destructive
  ops, audit log for mutations (`guildAdminCommands`, crown blocks).
- **Alias hygiene:** canonical names resolved once at ingest (Last.fm
  redirect/autocorrect), replacing per-render `$`/`s` hacks.
- **Done when:** abuse-simulation suite (bot-loop scrobbler, name-collision
  registrations, NSFW names) passes without polluting leaderboards.

---

## Phase 5 — Observability & ops (prove "perfect")

- **Truthful health:** `/livez` vs `/readyz` (Discord ready + ≥1 Lavalink node +
  DB p99 <2s + shard list); 503-during-drain; per-shard port binding.
- **Graceful shutdown:** 30s drain (players, queue pumps, autopost leases,
  `moonlinkManager.stop()`), then exit — no more mid-index kills.
- **Render safety (FREE; farm deferred NEEDS-$):** in-process concurrency cap +
  result cache `(user,period,size,hash)` 1h + existing 4s kill-switch — kills the
  OOM class without new infra. Dedicated render workers only if funded.
- **Error tracking + dashboards:** Discord-webhook error feed for unhandled
  paths (free forever, no accounts — `ERROR_WEBHOOK_URL`), RED metrics per
  command, Last.fm/Spotify/Discord 429 dashboards, index-lag gauge (the
  Mond-class metric: `totalScrobbles - stored`). Sentry explicitly rejected
  (account/trial unwanted).
- **Load + chaos suite:** k6/gatling for wk/top/autocomplete at 100 rps;
  blackholed-provider chaos (already survivable per Phase 1.5 — prove it);
  500k-play user soak for index/memory.
- **Done when:** staging dashboard shows p95/p99 per command, zero unhandled
  rejections over 7 days, deploy = zero failed interactions.

---

## Sequencing & rules of engagement

1. Phase 0 → 1 → 3.1/3.2 → 2 → 3.3/3.4 → 4 → 5. (Music capacity needs Phase 2
   sharding context; correctness first.)
2. Every change: `npm run build && npm test`, plus a targeted regression test —
   the suite is the definition of "no single bug".
3. No migrations without a rollback note; no boot-path changes without 3 green
   deploys; no Discord-behavior change without staging proof.
4. This file tracks the plan; check off phases here as they land.
