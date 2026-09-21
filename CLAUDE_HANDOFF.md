# Handoff: tvbot music playback — home Lavalink vs YouTube (for Claude)

> Moha pastes this file to you as full context. Please read all of it before
> proposing changes. Correct me where I'm wrong — especially on the SABR theory.

## 1. What this project actually is (please don't assume Shoukaku)

- **tvbot**: TypeScript Node.js Discord bot (`discord.js` v14), Last.fm stats +
  Lavalink music. Repo: `github.com/tvbot69/tvbot`, branch `main`.
- **Music stack: `moonlink.js` v5 → Lavalink v4 REST/WS.** There is NO Shoukaku,
  NO `Promise.any()` node racing, NO LavaSrc plugin anywhere. Any retry/fallback
  design must target `src/bot/handlers/musicHandler.ts` + `src/bot/services/music/musicService.ts`.
- **Spotify links are resolved bot-side** (`SpotifyResolver` → Spotify API for
  metadata → Lavalink `ytsearch:`). The node never sees `spotify:` URIs, so
  LavaSrc provider ordering does not apply. A SoundCloud-first swap for Spotify
  links belongs in `musicService.ts` (`playSpotify` + `resolvePlaylistTrack`),
  not in node config.
- **Node pool** (`src/config/lavalink.ts`): 2 public nodes (MilloHost,
  Serenetia-SSL) + 1 self-hosted home node (`Home`, first in list = preferred
  under least-load). Failover via Moonlink `transferNode` with state restore.
- **Resilience code that ALREADY EXISTS (do not duplicate):**
  - `musicHandler.ts` — `trackException`/`trackStuck` handlers with
    alternate-YouTube-upload retry (duration-gated ±30s, drops wrong-song
    matches), SoundCloud second chance, guarded `skip()`/`play()` advancement,
    null-track guards (Moonlink emits null tracks for late failures).
  - Fallback budgets: max 3 retries per track-encoded, max 5 per guild per 60s
    (`checkFallbackBudget`/`recordFallbackAttempt`), tried-upload exclusion.
  - **Song-identity circuit breaker** (latest commit): same artist+title failing
    3× in 10 min → abandon song, skip with zero new searches
    (`isSongExhausted`). This already implements "allow one retry per track,
    then stop" — verify it holds before adding another cap.
  - Current `main` HEAD as of writing: `f5de040`
    ("fix(music): song-identity circuit breaker ends poison-song retry loops").
- **Recurring trap:** Railway deploys lag pushes by minutes; we twice debugged
  stale releases thinking they were current. Always ask Moha for the live
  commit SHA (Railway → Deployments) before concluding a fix didn't work.

## 2. The home node (self-hosted Lavalink)

- Host: Windows 10 Pro tower, wired Ethernet, 16 GB RAM, residential ISP
  (Telecom Egypt). Egress `197.43.250.134`, then `197.43.207.158` after a
  router reboot — **same failures on both**, so this is not one flagged DHCP lease.
- Lavalink **4.2.2** + `youtube-plugin` **1.18.2** (latest release; verified via
  GitHub API 2026-09-21). Runs as an NSSM Windows service, binds
  `127.0.0.1:2333`, exposed via **Tailscale Funnel** (`https`, valid cert).
  Bot connects `wss://` with password auth — connectivity proven (node shows
  connected, searches return results).
- `application.yml` clients order: `ANDROID_VR, ANDROID_MUSIC, TV, TVHTML5_SIMPLY,
  IOS, WEB, MWEB, WEBEMBEDDED, MUSIC`. OAuth enabled with a **throwaway**
  Google account refresh token (never Moha's own); token refresh verified in
  logs. No PO token, no remote cipher, no proxies (all deliberately avoided
  so far).
- A scratch test node on port 2334 exists at `C:\lavalink-test\` (NOT in git)
  for experiments that need restarts without touching the service.

## 3. Evidence (all verified, not guessed)

For **every** video tried (explicit rap, Daft Punk, NCS copyright-free,
TV Girl lyric video), playback dies ~2s in with:

```
dev.lavalink.youtube.AllClientsFailedException: (yts.version: 1.18.2)
  ANDROID_VR / ANDROID_MUSIC: "This video requires login."
  TVHTML5 (OAuth-linked): "The page needs to be reloaded."
  TVHTML5_SIMPLY: "Sign in to confirm you're not a bot"
  WEB / MWEB: "Must find sig function from script: .../player_embed.vflset/ar_EG/base.js"
  WEB_EMBEDDED_PLAYER: "Video player configuration error"
```

Additional facts:
- Search/metadata ALWAYS works (25-result `ytsearch` responses, correct titles).
- Direct video URLs load track data; only the audio-stream step fails.
- Snapshot plugin build `2be8e54` (post-1.18.2, incl. Sept-17 cipher commit):
  same cipher failure. JVM locale override (`en-US`) changed nothing; the
  `ar_EG` player script comes from IP geolocation.
- Public nodes historically played some of this content via the bot's
  SoundCloud fallback, so bot-side code paths work — the home node is the
  variable under test.

## 4. What I need from you (Claude)

1. **Assess the SABR-only theory** against section 3: does "YouTube serving
   SABR-only responses since early September" explain the cipher failure AND
   the login walls together, or are these two independent walls (cipher lag +
   IP flag)? If SABR-only is real, what client/config actually plays SABR
   responses in youtube-source 1.18.2 — or is there truly no config fix until
   upstream ships?
2. **PO token vs remote cipher vs OAuth verdict**, given the evidence: which
   single next step has the highest probability of producing audio, and why?
   (OAuth is already linked and TV still fails — say plainly if that rules it out.)
3. **If you propose a bot-side retry cap or SoundCloud swap**, show it as a
   diff against the existing code named above (the caps may already exist —
   check first, don't duplicate). Moonlink API only: `player.skip()`,
   `player.play()`, `manager.search({query, source})`, `player.queue.unshift`.
4. **yt-dlp fallback feasibility**: `yt-dlp -F <url>` lists audio formats from
   this PC — if that works where the plugin fails, sketch how you'd wire a
   yt-dlp-based audio source into a moonlink/Lavalink-v4 setup with minimal
   moving parts (no Docker on this machine, $0 budget, Windows).

## 5. Hard constraints (non-negotiable)

- $0. No paid services, no paid tunnels, no trials needing a card.
- No router port changes (Funnel only). No VPN routing for node traffic.
- Never Moha's personal Google account. Throwaway only, and flag anything
  that risks getting the throwaway terminated.
- Secrets (node password, OAuth tokens) live in `C:\lavalink\secrets.env`
  (ACL-locked) and Railway variables ONLY. Never print them, never commit them.
- Windows PC, no Docker, no Python/Deno installed (portable tools OK if you
  justify them). Prefer config changes over new services; new services need
  an NSSM-compatible start story.
- Don't rewrite bot architecture. Small diffs to the files named in section 1.

## 6. Updates since f5de040 (2026-09-21, all merged to main, all verified live)

Commits after `f5de040`: `5ed8b49`, `80c2145`, `76326c5`, `783aa40`, `c4793b6`.
Test suite: 91 files / 548 tests green. `npm run build` green.

### 6a. yt-dlp resolver: built, running, and now the PRIMARY path (not a sketch)

- Server: `C:\ytres\resolver.ts` (Deno single exe, NSSM service `YtResolver`,
  start=Auto). `GET /?id={11-char-video-id}` + `authorization: <token>` header →
  `200 {path}` / `502` per-video miss / `401`. Concurrency 2, download kill at
  60s, cache `C:\ytres\cache` TTL 24h, format `ba[ext=webm]/ba`, 60M cap,
  live videos rejected. Binds `127.0.0.1:2335`, exposed via second Funnel
  (`https://<machine>.<tailnet>.ts.net:8443` → `127.0.0.1:2335`).
- Bot client: `src/bot/services/music/ytResolver.ts`. `502` = miss for that
  video (no penalty); anything else (tunnel down, PC asleep) pauses the
  resolver rung 2 min. Fetch timeout 65s — deliberately covers a full
  cold-cache download (server kills at 60s); unreachable still fails fast at
  connect. Verified: correct-host + correct-token → `200 {"path":...}`;
  wrong token → `401`; wrong tailnet name → DNS NXDOMAIN (we hit both
  misconfigurations live before fixing).
- Lavalink `application.yml`: `sources.local: true` (built-in `youtube: false`;
  the plugin still provides `ytsearch`, which ALWAYS worked — only the
  audio-stream step was walled).
- Railway vars required: `HOME_RESOLVER_URL`, `HOME_RESOLVER_TOKEN`
  (exact bytes of the server's `RESOLVER_TOKEN`), `HOME_NODE_ENABLED=true`,
  plus the existing `HOME_LAVALINK_URL/PASSWORD/SECURE`.

### 6b. Playback ladder is now resolver-first (commit c4793b6)

`YoutubeHealth.ladder()` healthy order on Home changed
`plugin → resolver → soundcloud` ⇒ **`resolver → plugin → soundcloud`**.
Down order unchanged (`resolver → soundcloud`); public nodes unchanged
(`plugin → soundcloud`, no resolver there). All three consumers
(single play `searchTrackWithLadder`, playlist `resolvePlaylistTrack`,
failure fallback `findAlternatePlayableTrack`) share `ladder()`, so one edit
moved everything. Rationale: the plugin's audio step fails ~100% (section 3
walls), so leading with it bought only a doomed attempt + ~2s dead air. The
shared `ytsearch` still runs first (needed for the video id); the resolver
rung materializes that id. Plugin stays second rung so a resolver miss
(502, pause, size cap, live filter) still gets a playback chance.

### 6c. Breakers and detection (already in code, verify before duplicating)

- Per-node YouTube outage breaker (`youtubeHealth.ts`): 3 DISTINCT songs with
  outage signatures (`requires login|sign in to confirm|not a bot|all clients
  failed|no supported audio|sig function|page needs reload|player config
  error`) in 120s → down 10 min. Same song ×3 does NOT count. Non-outage
  (private/unavailable/no-audio) never trips. One plugin probe per 60s slot
  after expiry; failed probe re-arms; any track surviving 15s clears
  immediately (okTimer, cleared on trackEnd/trackStuck/trackException/
  playerDestroy).
- Song-identity breaker (`musicHandler.ts`): same artist+title failing 3× in
  10 min → abandon song, skip with zero new searches.
- Preview-cut detection: SoundCloud "finishes" under 60s of a 90s+ track count
  as failures toward the song breaker (major-label 30s preview streams with
  full-length metadata).
- Fallback budgets unchanged: max 3 retries per track-encoded, max 5 per guild
  per 60s, tried-upload exclusion, local failed tracks never re-resolve.

### 6d. Observability (commit 783aa40)

- `clientFailuresText()`: compacts the exception to one `CLIENT: reason | …`
  line (`ANDROID_VR: requires login | WEB: no supported audio streams`) —
  the old 300-char truncation hid every client past the first. Full exception
  still reaches the classifier; only the log line was truncated.
- `[Music] fallback ladder` (node/outage/rungs/track) + `[Music] fallback
  rung` (rung + ok true/false) on every fallback. Outage failures log
  "looking for a fallback", one-offs keep "looking for an alternate upload".
- Logger (`src/domain/logger.ts`) preserves all context fields and full
  stacks; previously context objects were dropped.

### 6e. Live proof (Lavalink spring.log, 2026-09-21, Home node)

- 13:55:55 `ytsearch:Rich Amiri - STORMI DANIELS` → 13:56:03
  `Got request to load "C:\ytres\cache\a-VuL3qYgfU.webm"` →
  `Loaded track` → `PATCH .../players/...` same second. Zero plugin attempt,
  zero exception.
- 13:59:06 second song (`Hoes Mad` → `uexn88mjvLk.webm`): 5s search-to-load,
  playing same second.
- Zero timestamped ERRORs after 12:54. All `AllClientsFailedException` traces
  in the log predate the resolver deploy. (One 10:35 SoundCloud preview-cut
  playback error is what motivated the 6c preview detection.)

### 6f. Open questions for Claude

1. Plugin rung on Home: keep as second rung, or delete entirely? It has never
   produced audio (section 3); its only value is a hypothetical recovery.
2. Cold-start UX: up to ~60s "loading" on uncached songs (one pass) vs 30s
   abort + fallback pass. Right call, or shorten?
3. yt-dlp maintenance: nightly `--update-to` scheduled task on the PC — enough
   against YouTube breakage, or pin + alert on 502-rate instead?
4. Public nodes' role now: pure failover when Home dies, or should some
   traffic stay on them to spare the residential uplink?
