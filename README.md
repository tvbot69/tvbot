<div align="center">

<br/>

# 🎵 tvbot

**A feature-rich Discord bot for Last.fm music lovers.**  
Track your listening history, see who knows your favorite artists, generate album charts, and play music — all in one place.

<br/>

[![Node](https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.js.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Tests](https://img.shields.io/badge/Tests-134%2F135_passing-4caf50?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

<br/>

[Features](#-features) · [Commands](#-commands) · [Setup](#-getting-started) · [Tech Stack](#-tech-stack)

<br/>

</div>

---

## ✨ Features

### 🎧 Last.fm Integration
Connect your Last.fm account and unlock a full suite of music tracking commands. See what you're listening to right now, explore your most-played artists and albums across any time range, and dive into daily listening overviews with per-day breakdowns.

### 🖼️ Album & Artist Charts
Generate beautiful grid collages of your top albums or artists — from 3×3 all the way up to 10×10. Charts are rendered with high-quality artwork pulled from Spotify, Apple Music, and Deezer so you never get a broken image tile.

### 👑 Who Knows & Crowns
Find out who in your server listens to any artist, album, or track the most. The player with the most plays holds the **Crown** for that artist — and it can be stolen at any time. Compete with your friends to own your favorites.

### 🎵 Music Playback
Play music directly in your voice channel via Spotify links, YouTube, or search terms. Supports full queue management, filters, volume control, shuffle, loop, and autoplay.

### 🎙️ Track Details & Audio Previews
Get detailed info on any track — BPM, musical key, duration — and send a real 30-second audio preview directly in chat as a voice message.

### ⚽ Football Scores
Live match scores, fixtures, and standings for Egyptian Premier League and major European competitions.

---

## 🕹️ Commands

Both text prefix (`.`) and slash commands (`/`) are fully supported.

### Last.fm

| Command | Description |
|:---|:---|
| `.fm` · `/fm` | Shows what you're currently listening to (or your last scrobble) |
| `.fmmode` · `/fmmode` | Customize your `.fm` display — layout style, footer info, buttons, and accent color |
| `.login <username>` · `/register` | Link your Last.fm account to your Discord profile |
| `.update` · `/update` | Sync your latest scrobbles from Last.fm |
| `.chart 4x4 [period]` · `/chart` | Generate an album or artist chart image |
| `.ta [period]` · `/topartists` | Your top artists for any time period |
| `.tab [period]` · `/topalbums` | Your top albums |
| `.tt [period]` · `/toptracks` | Your top tracks |
| `.o` · `/overview` | A day-by-day breakdown of your recent listening |
| `.at <artist>` · `/at` | Your personal top tracks for a specific artist |
| `.taste [@user]` · `/taste` | Compare your music taste with another user |
| `.trackdetails` · `/trackdetails` | BPM, key, duration, and a 30s audio preview |

### Who Knows

| Command | Description |
|:---|:---|
| `.wk <artist>` · `/whoknows` | Who in the server has the most plays for an artist |
| `.wkt <track>` · `/wktrack` | Who knows a specific track |
| `.wka <album>` · `/wkalbum` | Who knows a specific album |
| `.fwk/.fwkt/.fwka` · `/friendswhoknow` | Same as above but filtered to your friends |

### Crowns

| Command | Description |
|:---|:---|
| `.crown <artist>` · `/crown` | See who holds the crown for an artist in this server |
| `.crowns [@user]` · `/crowns` | See all crowns a user holds |

### Music

| Command | Description |
|:---|:---|
| `.play <song or URL>` · `/play` | Play a track or playlist (Spotify, YouTube, search) |
| `.skip` · `/skip` | Skip the current track |
| `.stop` · `/stop` | Stop playback and clear the queue |
| `.queue` · `/queue` | View the current queue |
| `.pause / .resume` | Pause or resume playback |
| `.volume <0-100>` | Set the volume |
| `.loop / .shuffle` | Loop or shuffle the queue |

### Football

| Command | Description |
|:---|:---|
| `.football` · `/football` | Live match scores and fixtures |

---

## 🚀 Getting Started

### Requirements

- **Node.js** v20 or higher
- **PostgreSQL** v14 or higher
- **Redis** v6 or higher
- A [Discord Bot Token](https://discord.com/developers/applications)
- A [Last.fm API key](https://www.last.fm/api/account/create)

### Installation

```bash
# 1. Clone the repo
git clone https://github.com/tvbot69/tvbot.git
cd tvbot

# 2. Install dependencies
npm install

# 3. Set up your environment
cp .env.example .env
```

Open `.env` and fill in your credentials:

```env
DISCORD_TOKEN=your_discord_bot_token
DATABASE_URL=postgresql://user:password@localhost:5432/tvbot
LASTFM_API_KEY=your_lastfm_api_key
LASTFM_API_SECRET=your_lastfm_api_secret
REDIS_URL=redis://localhost:6379
```

```bash
# 4. Set up the database
npm run db:generate
npm run db:deploy

# 5. Start the bot
npm run dev       # Development with hot reload
npm run build     # Build for production
npm start         # Start in production
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|:---|:---|
| Language | TypeScript 5.x on Node.js 20+ |
| Discord Library | discord.js v14 with Components V2 |
| Database & ORM | PostgreSQL + Prisma |
| Cache | Redis (ioredis) |
| Dependency Injection | tsyringe |
| Chart Rendering | Puppeteer (headless Chromium) |
| Music Playback | Moonlink.js v5 (Lavalink) |
| Audio Analysis | Essentia WASM (BPM & Key detection) |
| Testing | Vitest |

---

## 📄 License

MIT
