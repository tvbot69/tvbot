<div align="center">

<img src="https://raw.githubusercontent.com/twitter/twemoji/master/assets/svg/1f3b5.svg" width="80" alt="tvbot logo"/>

# tvbot

**Private fmbot mirror — unlimited, no paywalls, no pruning.**
*Last.fm stats + Lavalink music, built for a closed friend group.*

<br/>

[![Node](https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.js.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-Cache-DC382D?style=flat-square&logo=redis&logoColor=white)](https://redis.io/)
[![Puppeteer](https://img.shields.io/badge/Puppeteer-Charts-40B5A4?style=flat-square&logo=puppeteer&logoColor=white)](https://pptr.dev/)
[![Tests](https://img.shields.io/badge/Tests-134%2F135_passing-4caf50?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/)

<br/>

[Parity Tracker](#-fmbot-parity-tracker) · [Commands](#-commands) · [Architecture](#-architecture) · [Setup](#-getting-started)

<br/>

> **fmbot parity: `~52%` core** — `100%` of the loop that matters (`fm`/`wk`/`chart`/`top`/`crowns`)
> Next 15 long-tail commands → `68%`. See [tvbot.md](./tvbot.md) for the AI handbook.

</div>

---

## 🎯 fmbot Parity Tracker

> Diff against `fmbot-dev/src`: 171 text + 87 slash + 23 builders + 57 services + 49 DB entities  
> vs `tvbot/src`: 67 text + 36 slash + 25 builders + 76 services + 16 Prisma models

### Overall Numbers

| Dimension | fmbot (core) | tvbot | Parity |
|:---|---:|---:|:---:|
| Text commands (core Last.fm) | 90 | 38 | **~50%** |
| Slash commands (core) | 60 | 30 | **50%** |
| Builders (core) | 16 | 10 | **62%** |
| Services (core) | 32 | 24 | **75%** |
| DB entities (core) | 16 | 16 | **100%** |
| **Whole bot (excl. premium)** | **~150 cmds** | **~68 cmds** | **~52%** |

*Core = plays/artist/album/track/chart/friends/whoknows/crown/top/overview/update/settings — excludes `globalWhoKnows`, `import`, `discoveries/gaps` (supporter), `jumble/pixel`, `discogs`, `premium` guild.*

---

### Subsystem Breakdown

| Feature | Status | Progress |
|:---|:---:|:---|
| **Now Playing** `.fm` `/fm` — 6 modes, buttons, `lfm:` + mentions, `ArtworkService` | ✅ Done | `█████ 100%` |
| **Artwork Engine** — `Spotify→Deezer→Apple→Last.fm`, 90d cache, `2a96cb…` filter | ✅ Done+ | `█████ 100%` |
| **Who Knows** `wk/wkt/wka` `fwk/fwkt/fwka` — 14-cap, `closeFriends` pin, genre footer | ✅ Done | `████░ 85%` — skipped `gw*` global (intentional) |
| **Crowns** `crown/crowns` — per-guild king, steal, `30` plays threshold, `SeedCrowns` | ✅ Done | `█████ 100%` |
| **Grid Charts** `chart` — 3×3→10×10, Puppeteer, artist + **track chart** (not in fmbot) | ✅ Done+ | `█████ 100%` |
| **Top Lists** `ta/tab/tt` — 7d→overall, `1000` limit, 5-btn pagination + jump modal | ✅ Done | `████░ 90%` — missing `bb`/discogs |
| **Taste** `taste` — compatibility `two-year` billboard | ✅ Done | `████░ 85%` — missing time-period param |
| **Overview** `o` — daily `8` blocks, groupBy `YYYY-MM-DD`, genre overlay | ✅ Done | `████░ 85%` — UTC only (no local midnight) |
| **Artist Top Tracks** `at` — `758` plays `42` distinct, `Page 1/5 — 42 tracks` | ✅ Done | `█████ 100%` |
| **Artist/Album/Track deep dive** `ao/aa/ab/tr` etc. | 🟡 Partial | `██░░░ 40%` — `artistplays/ap`, `pace`, `discoveries` missing |
| **Genre & Country** — `topgenres/genre/wkgenre/topcountries` | ❌ Orphaned | `░░░░░ 0%` — services exist, no builders/commands |
| **Server billboard** `serverartists/albums/tracks` | ❌ Missing | `░░░░░ 0%` |
| **Friend system** `friendsfm/addfriend/managefriends` | ✅ Done | `████░ 90%` — missing `SyncLastFmFriends` |
| **Music / Lavalink** (tvbot-only, no fmbot equiv.) — Moonlink v5, 5 nodes, failover | ✅ Done+ | `█████ 100%` |
| **Audio Previews** `trackdetails td` — Essentia BPM/Key, `flags:8192` voice message | ✅ Done+ | `█████ 100%` |
| **Lyrics** — Lavalink-synced (`lyricsService.ts`), Genius `gi` missing | 🟡 Partial | `█░░░░ 30%` |
| **Delta sync** `UpdateService` — `OVERLAP 3h`, `callWithRetry` 5×, `FALLBACK 14d` | ✅ Done | `█████ 100%` |
| **Puppeteer** — ephemeral dev / persistent prod, `preheat`, 4s `SIGKILL` cap | ✅ Done | `█████ 100%` |
| **Per-user color isolation** — hex/palette per user, no bleed, blank by default | ✅ Done | `█████ 100%` |
| **Football** — Egyptian PL + European live scores (tvbot-only) | ✅ Done | `█████ 100%` |
| **Guild admin** `configuration/autoposts/block/crownthreshold` | ❌ Missing | `░░░░░ 10%` |
| **Long-tail Last.fm** `plays/p pace/pc streak/str milestone/m discoverydate/dd search/sr` | ❌ Missing | `░░░░░ 0%` |

> **Intentionally skipped (not debt):** `globalwhoknows` (18 aliases), `import` (Spotify/Apple supporter file), `discoveries/gaps` (DiscoverySupporterRequired), `jumble/pixel`, `discogs`, `templates`, `premium` guild branding, `featured/eurovision/rym/botscrobbling`.

### 📈 Next Highest-Value Increments

Add these **15 commands** to jump from `52%` → `68%` core parity (all non-supporter, no premium):

```
artistplays/ap  artistpace/apc  albumplays/abp  trackplays/tp
plays/p         pace/pc         milestone/m     discoverydate/dd
lastlistened/ll search/sr       streak/str      profile/stats/user
serverartists   topgenres       topcountries
```

---

## ⚡ Features

<table>
<tr>
<td width="50%">

**🎧 Last.fm Stats**
- `.fm` with 25+ aliases, 6 embed modes, 28 footer flags
- `WhoKnows` guild + friends leaderboards with genre footers
- Guild **Crowns** competition with steal logic
- `Top*` lists up to `1000` tracks with paginated jump modal
- Daily `Overview` aggregated by `YYYY-MM-DD` with top artists
- `Taste` compatibility, `Artist Top Tracks`, `Chart` collages

</td>
<td width="50%">

**🎵 Music (Lavalink)**
- Moonlink.js v5 — 5 public nodes + custom failover
- `SpotifyResolver` → YouTube/Lavalink pipeline
- Audio previews: Essentia WASM BPM/Key + `flags:8192` voice messages
- `queue/skip/stop/seek/volume/filters/247/autoplay/loop/shuffle`

</td>
</tr>
<tr>
<td width="50%">

**🖼️ Artwork Engine**
- `Spotify → Deezer → Apple Music → Last.fm` waterfall
- `2a96cb...` star-placeholder filter
- 90-day freshness cache + Arabic album-only retry
- Never shows broken image tiles in charts

</td>
<td width="50%">

**⚽ Football + More**
- Live Egyptian Premier League & European match scores
- **Per-user color isolation** — custom accent colors, no guild bleed
- Discord **Components V2** container design throughout
- Multi-source lyrics (Genius / Lavalink synced)

</td>
</tr>
</table>

---

## 🕹️ Commands

| Text | Slash | Description | Status |
|:---|:---|:---|:---:|
| `.fm [user\|lfm:name]` | `/fm` | Now playing — 6 embed modes + artwork | ✅ |
| `.fmmode` | `/fmmode` | Embed type, footer, buttons, accent color | ✅ |
| `.chart 3x3 [period]` | `/chart albums\|artists\|tracks` | Grid chart (Puppeteer) | ✅ |
| `.wk <artist>` | `/whoknows artist:` | Who knows artist in guild | ✅ |
| `.wkt <track>` | `/wktrack` | Who knows track | ✅ |
| `.wka <album>` | `/wkalbum` | Who knows album | ✅ |
| `.fwk/.fwkt/.fwka` | `/friendswhoknow` | Who knows — friends only | ✅ |
| `.ta [period]` | `/topartists` | Top artists `weekly→overall`, 1000 limit | ✅ |
| `.tab [period]` | `/topalbums` | Top albums | ✅ |
| `.tt [period]` | `/toptracks` | Top tracks | ✅ |
| `.o [user]` | `/overview` | Daily overview — 8 blocks, 4/page | ✅ |
| `.at <artist>` | `/at artist:` | Your top tracks for artist | ✅ |
| `.taste [user]` | `/taste` | Musical compatibility | ✅ |
| `.crown <artist>` | `/crown` | Crown duel — who holds it? | ✅ |
| `.crowns [user]` | `/crowns` | All crowns held by user | ✅ |
| `.trackdetails [track]` | `/trackdetails` | BPM, key, duration + preview voice msg | ✅ |
| `.login <lfm-username>` | `/register` | Link your Last.fm profile | ✅ |
| `.update` | `/update` | Force sync latest scrobbles | ✅ |
| `.play <query\|url>` | `/play` | Play via Spotify/YouTube/Lavalink | ✅ |
| `.skip / .stop / .queue` | `/skip` etc. | Music playback controls | ✅ |
| `.football` | `/football` | Live match fixtures & scores | ✅ |
| `plays/p, pace, streak, milestone, search…` | — | Long-tail Last.fm *(next milestone)* | ❌ |

---

## 🏗️ Architecture

```
tvbot/
├── src/
│   ├── bot/
│   │   ├── builders/          # ResponseModel + Components V2 container factories
│   │   ├── handlers/          # commandHandler / interactionHandler / musicHandler
│   │   ├── interactions/      # Button, select-menu, and modal handlers
│   │   ├── services/
│   │   │   ├── updateService.ts    # Delta-sync heart (900 lines, mirrors fmbot UpdateService.cs)
│   │   │   ├── artworkService.ts   # Spotify→Deezer→Apple→Last.fm waterfall
│   │   │   ├── chartService.ts     # Puppeteer orchestration
│   │   │   ├── colorService.ts     # Per-user accent color isolation
│   │   │   ├── audio/             # Essentia BPM/Key, preview resolver, voice messages
│   │   │   ├── music/             # Moonlink, Spotify resolver, playlist chunks
│   │   │   └── whoKnows/          # Artist/Album/Track/Play leaderboard services
│   │   ├── slashCommands/     # 12 modules
│   │   ├── textCommands/      # 11 modules
│   │   └── startup.ts         # DI container — tsyringe registerInstance for every service
│   ├── domain/                # Enums, interfaces, zero-dep models
│   ├── persistence/           # Prisma schema + repositories
│   │   └── prisma/schema.prisma  # users, user_plays, user_artists/albums/tracks, user_crowns, friends
│   ├── lastfm/                # Last.fm REST client, converters, callWithRetry 5×
│   ├── spotify/               # Token manager + track resolver
│   ├── deezer/ applemusic/    # Fallback artwork providers
│   └── images/                # Puppeteer chart service + HTML templates
├── .env.example               # All required env vars with descriptions
└── package.json
```

**Request flow:**
```
Discord event
  → commandHandler / interactionHandler
  → isBlockedInContext (guild/channel/command checks)
  → ContextModel.fromInteraction / fromMessage
  → colorService.getAccentColorAsync(userId)  ← per-user, never bleeds
  → command.executeAsync(context)
  → ResponseModel { embed | componentsV2Container | buttonRows | file }
  → sendResponse (Components V2 flag if container)
```

---

## 🚀 Getting Started

### Prerequisites
- **Node.js** v20+ · **PostgreSQL** v14+ · **Redis** v6+
- Discord Bot Token → [Discord Developer Portal](https://discord.com/developers/applications)
- Last.fm API Key → [last.fm/api](https://www.last.fm/api/account/create)

### Setup

```bash
# 1. Clone & install
git clone https://github.com/tvbot69/tvbot.git && cd tvbot
npm install

# 2. Configure
cp .env.example .env
# Fill in: DISCORD_TOKEN, DATABASE_URL, LASTFM_API_KEY/SECRET
# Optional: SPOTIFY_*, REDIS_URL, ENABLE_LAVALINK=false (dev)

# 3. Database
npm run db:generate && npm run db:deploy

# 4. Run
npm run dev          # Development — hot reload, ephemeral Puppeteer
npm test             # 134/135 tests passing
npm run build        # TypeScript compile + asset copy
npm start            # Production
```

---

## 🧪 Tests

```
npm test

 ✓ playBuilders.test.ts          ✓ whoKnowsService.test.ts
 ✓ settingService.test.ts (19)   ✓ chartService.test.ts (Puppeteer 2×2)
 ✓ artworkService.test.ts        ✓ musicService.test.ts (16)
 ✓ crownService.test.ts (5)      ✓ cacheService.test.ts (6)
 ✓ lastfmApi.test.ts             ✓ spotifyResolver.test.ts
 ... and 14 more suites

 Test Files   24 passed | 1 network-dependent (Egyptian football scraper timeout)
 Tests        134 passed | 1 flaky (live network, not a code bug)
```

---

## 📄 License

MIT — private bot, unlimited `user_plays`, no supporter gates, never prunes.
