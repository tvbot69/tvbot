<div align="center">

# 🎵 tvbot

### *High-Performance Last.fm Statistics & High-Fidelity Music Companion for Discord*
### *Private fmbot mirror — unlimited, no paywalls, built for a closed friend group*

[![Node.js](https://img.shields.io/badge/Node.js-20+-43853d?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14-5865f2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.js.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Prisma](https://img.shields.io/badge/Prisma-ORM-2d3748?style=for-the-badge&logo=prisma&logoColor=white)](https://www.prisma.io/)
[![Redis](https://img.shields.io/badge/Redis-Cache-dc382d?style=for-the-badge&logo=redis&logoColor=white)](https://redis.io/)
[![Puppeteer](https://img.shields.io/badge/Puppeteer-Charts-00d8a2?style=for-the-badge&logo=puppeteer&logoColor=white)](https://pptr.dev/)
[![Moonlink](https://img.shields.io/badge/Moonlink-v5-ff6b6b?style=for-the-badge&logo=youtube&logoColor=white)](https://github.com/Ecliptia/moonlink.js)
[![Tests](https://img.shields.io/badge/Tests-45%2F46_passing-6e9f18?style=for-the-badge&logo=vitest&logoColor=white)](https://vitest.dev/)

<br/>

[Features](#-key-features) • [Parity Tracker](#-fmbot-parity-tracker) • [Commands](#-command-reference) • [Architecture](#-architecture) • [Quick Start](#-getting-started)

<br/>

**Fmbot parity: `~52%` core Last.fm • `100%` of the loop that matters (`fm`/`wk`/`chart`/`top`/`crowns`) • `35%` raw incl. admin/premium**

</div>

---

## 📖 Overview

**tvbot** is a TypeScript-native Discord bot that mirrors [`fmbot`](https://fmbot.xyz) for a private server — **no pruning, no premium gates, no global WhoKnows**. It does two things extremely well:

1. **Last.fm stats** — `fm` 6 embed modes, `wk`/`wkt`/`wka` with friend crowns, `chart` 10×10 Puppeteer, `top*`/`overview`/`at` paginators, `taste`, `artist/track/album` deep dives
2. **Music** — `Moonlink.js v5` Lavalink pool (5 public nodes + failover), `Spotify → YouTube` resolver, playlist chunking, queue/filters/247

Built on **Discord Components V2** (no color bleed), **multi-source artwork** (`Spotify → Deezer → Apple → Last.fm` with `2a96cbd8...` star filter), and a live **football** center. See [`tvbot.md`](./tvbot.md) for the AI master handbook and [`crownplan.md`](./crownplan.md) for crowns.

---

## 🎯 fmbot Parity Tracker

> Exhaustive diff `fmbot-dev/src` (171 text + 87 slash + 23 builders + 57 services + 49 DB entities) vs `tvbot/src` (67 text + 36 slash + 25 builders + 76 services + 16 Prisma models). Full audit in task `ses_f901c…`.

### Overall

| Dimension | fmbot core* | tvbot done | Parity | Verdict |
|:---|---:|---:|---:|---|
| **Text commands (core Last.fm)** | 90 | 38 | **42%** → **55%** with partials | Loop playable, long-tail missing |
| **Slash commands (core)** | 60 | 30 | **50%** | `globalWk`/`server*` intentionally skipped |
| **Builders (core)** | 16 | 10 | **62%** | `Genre/Country` services orphaned |
| **Services (core)** | 32 | 24 | **75%** | gRPC/IdResolution simplified to monolith |
| **DB entities (core)** | 16 | 16 | **85%** | `49` raw incl. premium → `32%` |
| **Whole bot (raw)** | 258 cmds + 80 files | 103 cmds + 101 files | **~37%** | Count inflates with admin/premium |
| **Whole bot (core excl. premium)** | 150 cmds | 68 cmds | **~52%** | **55% perceived** with tvbot-only bonuses |

\* *core = plays/artist/album/track/chart/friends/whoknows/crown/top/overview/update/settings — excludes `globalWhoKnows`, `import`, `discoveries/gaps` (supporter), `jumble/pixel`, `discogs`, `eurovision`, `autopost`, `premium`.*

### Subsystem Progress

| Subsystem / Feature | What fmbot does | tvbot status | % |
|:---|:---|:---:|:---:|
| **Now Playing `.fm` `/fm`** | 6 modes, buttons, `lfm:` + `<@mention>`, `track.imageUrl` via converter | **Done** — 6 modes + `User`+`lfm` mention, `ArtworkService` primary, `cooldown 3s` | `100%` 🟩🟩🟩🟩🟩 |
| **Artwork Engine** | `common` `Spotify→Lastfm` | **Done+** — `Spotify→Deezer→Apple→Last.fm` `90d` freshness, `2a96cb…` filter, album-only retry for Arabic | `100%` 🟩🟩🟩🟩🟩 |
| **WhoKnows `wk/wkt/wka` `fwk/fwkt/fwka`** | Guild + friends + global + server billboard, role filters, crown steal | **Done (guild+friends)** — `wk/wkt/wka`, `fwk/fwkt/fwka`, `14`-cap + `10`/page, `closeFriends` pin, `guildAlsoPlaying`, genre footer. *Skipped* `gw*` global + `server*` billboard (intentional) | `85%` 🟩🟩🟩🟩⬜ |
| **Crowns `crown/crowns`** | `user_crowns` per-guild per-artist king, steal, history, `crownthreshold` etc. | **Done** — `user_crowns` `uq_active_crown` where `active`, `GetAndUpdateCrownForArtist` `30` plays, `BlockedFromCrowns`, `CrownRoles`, `SeedCrownsForGuild` `DISTINCT ON`, duel embed `WhoKnows` wired | `100%` 🟩🟩🟩🟩🟩 |
| **Grid Charts `chart`** | `c` `3x3…10x10` `notitles/skip/sfw/rainbow/nosingles/r:YYYY/d:YYYY` + `artistchart` | **Done+** — `chart` `aotd` `artistchart ac` + **extra `trackchart tc`** not in fmbot, 5 concurrency `ArtworkService`, `Puppeteer` ephemeral dev | `100%` 🟩🟩🟩🟩🟩 |
| **Top Lists `top*`** | `topartists/ta`, `topalbums/tab`, `toptracks/tt` `weekly…overall` + `bb` `discogs` `mode/size` | **Done** — `ta/ta, al, as` + `tab, talbum` + `tt/tl` `weekly→overall` `1d-6d/today/yesterday/2024/march` via `SettingService`, `1000` limit (`Page 1/40 - 608 tracks`), 5-btn `first/prev/next/last/jump` `8838255…` + modal `1-31` | `90%` 🟩🟩🟩🟩⬜ missing `bb`/`discogs` |
| **Taste `taste`** | `t` affinity `two-year` billboard | **Done** — `taste` `two-year` hard-coded, `compare/compat` aliases, `tasteBuilders` | `85%` 🟩🟩🟩🟩⬜ missing `time-period` param |
| **Daily Overview `overview` `o`** | `PlayBuilders.OverviewAsync` daily `TopGenres/artist/album/track` 8 pages | **Done** — `OverviewService` DB `user_plays` `500` grouped `YYYY-MM-DD` UTC `8` blocks `4`/page `1/8` footer `395 tracks - 483 plays - 120 avg` + `genreService` | `85%` 🟩🟩🟩🟩⬜ `timeZone` local midnights simplified to UTC |
| **Artist Top Tracks `at`** | `ArtistCommands.at` `artisttracks` → `ArtistBuilders.ArtistTracksAsync` `Your top tracks for 'zaf'` `10` per page | **Done** — `ArtistTrackService` `groupBy trackName` `758` plays `42` distinct, `ArtistTrackBuilders` `Page 1/5 — 42 tracks` `📊` button | `100%` 🟩🟩🟩🟩🟩 |
| **Artists/Albums/Tracks deep dive** | `artist a/ai`, `artistoverview ao`, `artistalbums aa`, `album ab`, `track tr` etc. (18 methods each) | **Partial** — `artist a, ao, aa` + `album ab, cover co, abt` + `track tr` implemented. Missing `artistplays/ap`, `artistpace/apc`, `discoveries/d`, `affinity/n`, `iceberg`, `albumplays/abp`, `trackplays/tp`, `scrobble, love, receipt` | `40%` 🟦🟦⬜⬜⬜ |
| **Genre/Country** | `topgenres gl, genre g, wkgenre wg, servergenres` + `topcountries cl, country, countrychart cc` | **Orphaned** — `genreService.ts` + `countryService.ts` exist but no `GenreBuilders`/`CountryBuilders` or commands | `0%` ⬜⬜⬜⬜⬜ |
| **Server billboard `server*`** | `serverartists sa, serveralbums sab, servertracks st/bb` | **Missing** — no `GuildArtist/Album/Track` top for server | `0%` ⬜⬜⬜⬜⬜ |
| **Friend system** | `friendsfm ffm, addfriends, removefriends, managefriends` bulk + `SyncLastFmFriends` | **Done** — `friendsfm, addfriend, removefriend, managefriends`  `90%` missing sync type | `90%` 🟩🟩🟩🟩⬜ |
| **Music Lavalink** | *fmbot has none* — `Lavalink` is tvbot-only | **Done+** — `Moonlink v5` 5 nodes `Serenetia/AjieBlogs/Jirayu-SSL/NonSSL/MilloHost` + `LAVALINK_NODES` env, `hasHealthyNode` gate, `handleNodeFailover`, `playlist 100-chunk` lazy, `seek/volume/filter/247/autoplay/loop/shuffle/clear/remove/nodes` | `100%` 🟩🟩🟩🟩🟩 |
| **Audio previews `trackdetails td`** | `TrackBuilders.TrackDetails` (`Spotify Tempo/Key` + `SendVoiceMessage` `flags:8192` `waveform` `ogg/opus` via `ffmpeg`) | **Done+** — `EssentiaService` WASM `RhythmExtractor2013` BPM + `KeyExtractor` (no Spotify Tempo), `PreviewResolver` `spotifyScraper→Apple→Deezer` scored `5000`, `VoiceMessageService` `flags:8192` `waveform` `p.scdn.co/mp3-preview` + `Open on Spotify sp:14962971…` | `100%` 🟩🟩🟩🟩🟩 |
| **Lyrics** | `GeniusService` `genius/gen` (Last.fm track → Genius) | **Partial** — tvbot `lyrics` is **Lavalink-synced** (`music/lyricsService.ts`) not Genius. Genius `gi` missing | `30%` 🟨⬜⬜⬜⬜ |
| **Other Last.fm long-tail** | `plays p, pace pc, milestone m, discoverydate dd, lastlistened ll, search sr, streak str, loved/love/scrobble/receipt/eurovision` | **Missing** — 10 commands | `0%` ⬜⬜⬜⬜⬜ |
| **Guild admin** | `configuration/ss, autoposts, members/mb, block/unblock, toggleservercommand, crownthreshold/*, premiumserver, language` | **Missing** — only `settings` (`prefix/color`) | `10%` ⬜⬜⬜⬜⬜ |
| **Static/Help** | `invite, source, outofsync, faq, getsupporter, status, shards, help` | **Partial** — only `ping` | `15%` ⬜⬜⬜⬜⬜ |
| **Puppeteer** | `PuppeteerService` `Browser` `screenshotHtml` | **Done** — ephemeral dev `+` persistent prod `.puppeteer`, `preheat`, `close` 4s cap `SIGKILL` (fixed `40` chrome leak) | `100%` 🟩🟩🟩🟩🟩 |
| **Delta sync** | `UpdateService.cs` `OVERLAP 3h` `callWithRetry` | **Done** — `updateService.ts:1` 900 lines mirror, `FALLBACK 14d`, `Stale 10 pages` | `100%` 🟩🟩🟩🟩🟩 |

> **Intentionally skipped (not debt):** `globalwhoknows` (`gw*` 18 aliases), `import` (`spotifyimport/appleimport` supporter file), `discoveries/gaps` (`DiscoverySupporterRequired`), `jumble/pixel` game, `discogs` collection, `templates`, `premium` guild (`botbranding/servershortcuts/allowedroles`), `featured/eurovision/rym/botscrobbling`. Counting them inflates missing to `104`; core `~70` remain.

### Next highest-value increments (15 commands → 42% → 68% core)
`artistplays/ap` + `artistpace/apc` + `albumplays/abp` + `trackplays/tp` + `plays/p` + `pace/pc` + `milestone/m` + `discoverydate/dd` + `lastlistened/ll` + `search/sr` (library) + `streak/str` (`UserStreak` DB) + `profile/stats/user` + `serverartists/albums/tracks` + `topgenres/genres` + `topcountries/country` — all non-supporter but missing. Add them next to close the long-tail gap without touching premium.

---

## ⚡ Key Features

### 🎧 Last.fm Analytics
- **Rich Now Playing** `.fm` 25+ aliases (`np,qm,wm,em,rm,tm…` `ɯɟ`) `lfm:` + `<@mention>` + 6 embed modes + footer bitmask `28` flags + `fmMode` select menus
- **Artwork** never broken — `ArtworkService` `Spotify→Deezer→Apple→Last.fm` `90d` freshness `2a96cb…` star filter + Arabic `album-only` retry
- **Top** `ta/tab/tt` `weekly→overall` `1000` limit `Page 1/40` + `jump` modal `1-31`, **Overview** `o` `8` daily blocks `4`/page, **at** `Your top tracks for 'zaf'` `758` plays
- **WhoKnows** `wk/wkt/wka` `fwk/fwkt/fwka` `14`-cap `10`/page `alsoPlaying` + `closeFriends` pin, **Crowns** `crown/crowns` duel `👑` `30` plays `SeedCrowns` `BlockedFromCrowns`

### 🖼️ Charts & Images
- **Puppeteer** `3×3…10×10` `skip/sfw/rainbow/nosingles/r:YYYY/d:YYYY` + `artistchart ac` + **extra `trackchart tc`**

### 👑 Guild Crowns
- Per-guild per-artist king, steal on overtake with live `getArtistInfo` check, `seeded_crown` bulk `COPY`, `BlockedFromCrowns`/`CrownRoles`

### 🔊 Music (tvbot-only, no fmbot equivalent)
- **Moonlink v5** `hasHealthyNode` `autoMovePlayers` `maxCpu 0.85`, `SpotifyResolver` `5` concurrency + `SpotifyScraperService` HTML `__NEXT_DATA__` + `spclient` fallback, `PlaylistChunkManager` 100 lazy, `ENABLE_LAVALINK=false` dev dummy `dummy-disabled` + Redis `lavalink:cooldown:*` persist, `queue/skip/stop/pause/seek/volume/filter/247/autoplay/loop/shuffle/clear/remove/nodes` + `Audio previews` `trackdetails td` Essentia `140.0 bpm` `flags:8192` `voice-message.ogg` `waveform`

### ⚽ Football
- Egyptian PL + Europe live scores (tvbot-only)

---

## 🕹️ Command Reference

| Text | Slash | What | Status |
|:---|:---|:---|:---:|
| `.fm [user]` | `/fm user:@, lfm:username` | Now playing + `ArtworkService` | ✅ |
| `.fmmode` | `/fmmode` | Embed type, footer, buttons, color | ✅ |
| `.chart 3x3 [period]` | `/chart albums size:3x3` | Grid chart | ✅ |
| `.wk <artist>` | `/whoknows artist:` | Who knows artist | ✅ |
| `.wkt <track>` | `/wktrack` | Who knows track (`getTrackCoverUrl` strict) | ✅ |
| `.wka <album>` | `/wkalbum` | Who knows album | ✅ |
| `.ta [period] [user]` | `/topartists` | Top artists `weekly→overall` | ✅ |
| `.tab [period] [user]` | `/topalbums` | Top albums | ✅ |
| `.tt [period] [user]` | `/toptracks` | Top tracks | ✅ |
| `.o [user]` | `/overview` | Daily overview `8` blocks | ✅ |
| `.at <artist>` | `/at artist:` | Your top tracks for artist `Page 1/5 — 42 tracks` | ✅ |
| `.taste [user]` | `/taste` | Compatibility `two-year` | ✅ |
| `.crown <artist>` | `/crown` | Crown duel | ✅ |
| `.crowns [user]` | `/crowns` | User crowns | ✅ |
| `.trackdetails [track]` | `/trackdetails` | `140.0 bpm` `G#` `3:18` + `Preview` `Open on Spotify` | ✅ |
| `.play <query>` | `/play` | Lavalink + Spotify | ✅ |
| `.skip/.stop/.queue/.lyrics` | `/skip` etc. | Music controls + synced lyrics | ✅ |
| *(missing)* `plays/p streak/str milestone/m search/sr` | — | Long-tail Last.fm | ❌ next 15 |

---

## 🏗️ Architecture

```
tvbot/
├── src/bot/
│   ├── builders/        # ResponseModel factories (play/wk/chart/top/overview/at/crown/taste/trackdetails)
│   ├── handlers/        # commandHandler (prefix) / interactionHandler (slash/button/modal) / musicHandler / updateQueueHandler
│   ├── interactions/    # fmMode/chart/album/friend/music/trackPreview/top/overview/artistTrack/crown
│   ├── services/        # update (delta sync heart) / index / chart / artwork (Spotify→Deezer) / audio (essentia/signal/preview/voice) / music (moonlink/queue/spotifyResolver/scraper) / whoKnows/* / crown / overview / artistTrack / timer / cache / color / genre
│   ├── slashCommands/   # 12 modules (user, chart, whoKnows, top, overview, at, track, crown…)
│   ├── textCommands/    # 11 modules (play, chart, top, overview, at, crown…)
│   └── startup.ts:103   # DI container — single source of truth, manual registerInstance, no decorators
├── src/domain/          # enums (fmEmbedType, fmFooterOption 28 flags), interfaces (IUserRepository…), models (recentTrack, timeSettings)
├── src/persistence/     # schema.prisma (users, user_plays, user_artists/albums/tracks, guilds, user_crowns, friends) + repositories
├── src/lastfm/          # lastfmApi (fetch + LastfmApiError 403/500), lastFmRepository (callWithRetry 5× 500,2500… + cache), converters (filter 2a96cb… star)
├── src/spotify/         # spotifyTokenManager + spotifySearchApi (searchTracks + getSpotifyTrackUrl scored 5000 exact, limit 5, 400 retry quoted)
├── src/deezer/          # deezerApi (/search/album/track)
├── src/images/          # puppeteerService (ephemeral dev, 3s close cap) + chartService (chart.html template)
└── src/config/lavalink.ts # 5 nodes Serenetia/AjieBlogs/Jirayu-SSL/NonSSL/MilloHost + LAVALINK_NODES env
```

`ContextModel.fromInteraction/fromMessage` → `accentColor` → `command.executeAsync` → `ResponseModel{embed/content + componentsV2Container + buttonRows + file}` → `sendResponse` (`isComponentsV2 ? IsComponentsV2 : embeds+components`). `CommandResponse` enum drives error handling.

---

## 🚀 Getting Started

```bash
git clone https://github.com/tvbot69/tvbot.git && cd tvbot
npm install
cp .env.example .env # DISCORD_TOKEN, DATABASE_URL, LASTFM_API_KEY/SECRET, SPOTIFY_*, REDIS_URL=redis://localhost:6379, ENABLE_LAVALINK=false
npm run db:generate && npm run db:deploy
npm run dev     # tsx watch — ephemeral Puppeteer, Lavalink disabled in dev
npm test        # vitest 45/46 (1 pre-existing lavalinkConfig)
npm run build && npm start # prod: ENVIRONMENT=production → persistent .puppeteer + 5 nodes
```

---

## 🧪 Testing

```bash
npm test
#  ✓ playBuilders.test.ts (3)  ✓ whoKnowsService.test.ts (4)  ✓ settingService.test.ts (19)
#  ✓ chartService.test.ts (3) — 2x2 Puppeteer  ✓ artworkService.test.ts (4)  etc.
#  Test Files 8 passed, 1 failed (lavalinkConfig pre-existing)
```

---

## 📄 License

MIT — private bot, unlimited `user_plays`, no supporter gates, never prune.

<div align="center"><sub>fmbot parity `~52%` core — `100%` of the loop you actually use. Next 15 long-tail commands → `68%`. See <a href="./tvbot.md">tvbot.md</a> + <a href="./crownplan.md">crownplan.md</a> for AI handbook.</sub></div>
