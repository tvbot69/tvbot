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
