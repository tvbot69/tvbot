<div align="center">

# 🎵 tvbot

### *High-Performance Last.fm Statistics & High-Fidelity Music Companion for Discord*

[![Node Version](https://img.shields.io/badge/Node.js-20+-43853d?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14-5865f2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.js.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Prisma](https://img.shields.io/badge/Prisma-ORM-2d3748?style=for-the-badge&logo=prisma&logoColor=white)](https://www.prisma.io/)
[![Redis](https://img.shields.io/badge/Redis-Cache-dc382d?style=for-the-badge&logo=redis&logoColor=white)](https://redis.io/)
[![Puppeteer](https://img.shields.io/badge/Puppeteer-Screenshots-00d8a2?style=for-the-badge&logo=puppeteer&logoColor=white)](https://pptr.dev/)
[![Tests](https://img.shields.io/badge/Vitest-Passing%20(25%2F25)-6e9f18?style=for-the-badge&logo=vitest&logoColor=white)](https://vitest.dev/)

<br/>

[Features](#-key-features) • [Parity Tracker](#-fmbot-parity--roadmap) • [Command Reference](#-command-reference) • [Architecture](#-architecture) • [Getting Started](#-getting-started)

<br/>

</div>

---

## 📖 Overview

**tvbot** is an all-in-one Discord bot engineered in TypeScript, delivering full-featured **Last.fm statistics tracking**, high-res **Puppeteer chart generation**, **guild crowns competition**, and **Lavalink audio streaming**. Built natively with modern **Discord Components V2** containers, it features strict per-user color isolation, multi-source metadata resolution (Apple Music, Spotify, Deezer), and a live football score system.

---

## 🎯 .fmbot Parity & Roadmap

Tracking our implementation progress and feature parity against [.fmbot](https://fmbot.cc):

| Subsystem / Feature | Description | Parity Status | Completion |
|:---|:---|:---:|:---:|
| **Now Playing (`.fm`, `/fm`)** | 6 embed modes (Mini, Full, Tiny, Compact), custom buttons, live previews, play states | Completed | `100%` 🟩🟩🟩🟩🟩 |
| **Artwork Engine** | Multi-tier fallback (`Spotify → Deezer → Apple Music → Last.fm`) with 90d freshness | Completed | `100%` 🟩🟩🟩🟩🟩 |
| **Who Knows (`.wk`, `/whoknows`)** | Guild listener rankings for artists, albums, tracks, and friends leaderboards | Completed | `100%` 🟩🟩🟩🟩🟩 |
| **Crowns System (`.crowns`, `.crown`)** | Guild crown tracking, crown stealing, minimum play thresholds, and leaderboards | Completed | `100%` 🟩🟩🟩🟩🟩 |
| **Grid Charts (`.chart`, `/chart`)** | High-performance Puppeteer renderer (3x3, 4x4, 5x5, 10x10), custom text & titles | Completed | `100%` 🟩🟩🟩🟩🟩 |
| **Top Lists (`.top*`, `/top*`)** | Top Artists, Albums, and Tracks across 7d, 1m, 3m, 6m, 1y, and overall time periods | Completed | `100%` 🟩🟩🟩🟩🟩 |
| **Taste & Compatibility (`.taste`)** | User vs user musical overlap, shared artist lists, and compatibility scoring | Completed | `100%` 🟩🟩🟩🟩🟩 |
| **Daily Overview (`.overview`)** | Aggregated daily scrobbles, top tracks/albums, and estimated listening time | Completed | `100%` 🟩🟩🟩🟩🟩 |
| **Artist Top Tracks (`.at`)** | User-specific top tracks for any queried artist with plays and ranks | Completed | `100%` 🟩🟩🟩🟩🟩 |
| **Components V2 Design** | Discord Container embeds, interactive menus, modals, and zero color bleeding | Completed | `100%` 🟩🟩🟩🟩🟩 |
| **Per-User Color Isolation** | Custom hex/palette accent colors stored per user with blank/neutral defaults | Completed | `100%` 🟩🟩🟩🟩🟩 |
| **Music Streaming & Lavalink** | Moonlink.js v5 with 5 public nodes, failover, queue management, volume, filters | Completed | `100%` 🟩🟩🟩🟩🟩 |
| **Audio Previews & Waveforms** | 30s voice-message preview clips with genuine base64 waveforms | Completed | `100%` 🟩🟩🟩🟩🟩 |
| **Multi-Source Lyrics** | Multi-engine lyrics fetcher (Genius, AuDD) with smart title sanitization | Completed | `100%` 🟩🟩🟩🟩🟩 |
| **Football Engine** | Live Egyptian Premier League & European matches, scores, and standings | Completed | `100%` 🟩🟩🟩🟩🟩 |
| **Live Scrobble Updates** | Delta-sync engine (`UpdateService`) syncing background plays with retry policies | Completed | `100%` 🟩🟩🟩🟩🟩 |

---

## ⚡ Key Features

### 🎧 Last.fm Analytics & Scrobble Insights
- **Rich Now Playing**: `.fm` with 25+ aliases (`np`, `qm`, `wm`, etc.), supporting Last.fm username overrides (`lfm:username`) and user mentions.
- **Dynamic Embed Styles**: 6 distinct layouts including Full, Mini, and Compact with configurable footer options (scrobble count, date, genre tags).
- **Customizable Action Buttons**: Jump to Last.fm, preview audio snippet, who knows lookup, and Spotify links right on the message.

### 🖼️ Puppeteer Chart Generator
- **Ultra-Fast Rendering**: Uses an optimized headless Chromium instance to generate beautiful album & artist collage grids.
- **Customizable Sizes**: 3×3, 4×4, 5×5, and 10×10 grids with toggleable album titles, play counts, and period ranges.
- **Artwork Fallback**: Never displays broken image placeholders — automatically pulls high-res covers from Apple Music or Deezer if Last.fm's CDN lacks them.

### 👑 Guild Crowns Competition
- **Crown Stealing**: Earn crowns for having the most plays of an artist in your Discord server.
- **Role Integration**: Server-wide leaderboards, eligibility checks, and automatic crown updates on scrobble sync.

### 🎨 Modern Components V2 & Color Isolation
- **Discord Container UI**: Modern Discord design using container builder components.
- **Per-User Color Isolation**: Custom user colors never leak to friends or servers. Unset users receive sleek, neutral embeds by default.

### 🔊 High-Fidelity Music (Lavalink)
- **Moonlink.js v5 Engine**: Multi-node connection pool with automatic failover across 5 public nodes.
- **Universal Resolver**: Play directly via Spotify links, YouTube, SoundCloud, or search terms.

### ⚽ Football Center
- **Egyptian Premier League**: Comprehensive fixture lists, live match status, and standings.
- **European Leagues**: Real-time scores and league tables.

---

## 🕹️ Command Reference

Both standard prefix (default `.`) and Slash commands (`/`) are fully supported:

| Text Command | Slash Command | Description |
|:---|:---|:---|
| `.fm [user]` | `/fm` | Displays currently playing track or latest scrobble |
| `.fmmode` | `/fmmode` | Configures your personal `.fm` layout, buttons, and colors |
| `.login <username>` | `/login` | Links your Last.fm profile to your Discord account |
| `.chart [size] [period]` | `/chart` | Generates a grid image chart (e.g. `.chart 3x3 1m`) |
| `.wk <artist>` | `/whoknows` | Shows who in the server listens to an artist the most |
| `.wkt <track>` | `/wktrack` | Shows who knows a specific track in the guild |
| `.wka <album>` | `/wkalbum` | Shows who knows a specific album in the guild |
| `.crowns [user]` | `/crowns` | Displays all crowns held by a user in the server |
| `.crown <artist>` | `/crown` | Checks who holds the crown for a given artist |
| `.topartists [period]` | `/topartists` | Leaderboard of your most-played artists |
| `.topalbums [period]` | `/topalbums` | Leaderboard of your most-played albums |
| `.toptracks [period]` | `/toptracks` | Leaderboard of your most-played tracks |
| `.overview` | `/overview` | Day-by-day scrobble overview with top artists/albums |
| `.at <artist>` | `/at` | Shows your top tracks for a specific artist |
| `.taste <user>` | `/taste` | Compares your musical compatibility with another user |
| `.update` | `/update` | Manually syncs your latest scrobbles from Last.fm |
| `.lyrics [song]` | `/lyrics` | Fetches synchronized or plain lyrics (Genius / AuDD) |
| `.play <query>` | `/play` | Plays a track or playlist in your voice channel |
| `.skip`, `.stop`, `.queue`| `/skip`, `/stop` | Controls Lavalink playback and queue |
| `.football` | `/football` | Live fixtures, scores, and standings for leagues |

---

## 🏗️ Architecture

```
tvbot/
├── src/
│   ├── bot/
│   │   ├── builders/        # ResponseModel & Components V2 container factories
│   │   ├── handlers/        # Discord message & interaction routers
│   │   ├── interactions/    # Button, select menu, and modal handlers
│   │   ├── services/        # Business logic (update, chart, crowns, lyrics, football)
│   │   ├── slashCommands/   # Discord Slash command implementations
│   │   ├── textCommands/    # Prefix command implementations
│   │   └── startup.ts       # Dependency injection container (tsyringe)
│   ├── domain/              # Zero-dependency models, enums, and interfaces
│   ├── images/              # Puppeteer chart generator & HTML templates
│   ├── lastfm/              # Last.fm REST API client & response converters
│   ├── persistence/         # Prisma ORM schema, migrations, and repositories
│   ├── spotify/             # Spotify Web API token manager & track resolver
│   ├── deezer/              # Deezer search API & metadata fallback
│   └── tests/               # Vitest test suites (25 suites, 135+ tests)
├── .env.example             # Template for required environment variables
├── .gitignore               # Protection against committing secrets or node_modules
└── package.json             # Scripts & dependencies
```

---

## 🚀 Getting Started

### Prerequisites
- **Node.js**: v20.x or higher
- **PostgreSQL**: v14+ (Local or Hosted instance)
- **Redis**: v6+ (Local or cloud instance)
- **Discord Bot Token**: From [Discord Developer Portal](https://discord.com/developers/applications)
- **Last.fm API Key**: From [Last.fm API Accounts](https://www.last.fm/api/account/create)

### 1. Clone the Repository
```bash
git clone https://github.com/tvbot69/tvbot.git
cd tvbot
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Configuration
Copy `.env.example` to `.env` and fill in your keys:
```bash
cp .env.example .env
```

```env
DATABASE_URL="postgresql://user:password@localhost:5432/tvbot"
LASTFM_API_KEY="your_lastfm_api_key"
LASTFM_API_SECRET="your_lastfm_api_secret"
DISCORD_TOKEN="your_discord_bot_token"
REDIS_URL="redis://localhost:6379"
ENVIRONMENT="development"
ENABLE_LAVALINK=false
```

### 4. Database Setup
Run Prisma migrations to initialize your database schema:
```bash
npm run db:generate
npm run db:deploy
```

### 5. Running the Bot
```bash
# Start in development mode with live reload
npm run dev

# Run unit and integration tests
npm test

# Build for production
npm run build

# Start production server
npm start
```

---

## 🧪 Testing

The codebase includes automated tests powered by **Vitest**:
```bash
npm test
```
```
 ✓ src/tests/musicBot/musicTrack.test.ts (11 tests)
 ✓ src/tests/musicBot/musicBuilders.test.ts (8 tests)
 ✓ src/tests/musicBot/spotifyResolver.test.ts (6 tests)
 ✓ src/tests/musicBot/lyricsService.test.ts (7 tests)
 ✓ src/images/generators/chartService.test.ts (5 tests)
 ✓ src/lastfm/api/lastfmApi.test.ts (9 tests)
 ...
 Test Files  25 passed (25)
      Tests  135 passed (135)
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
