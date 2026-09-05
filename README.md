<div align="center">

# tvbot

**An open-source fmbot clone, built from scratch in TypeScript.**

[![Discord.js](https://img.shields.io/badge/Discord.js-v14-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.js.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/Tests-134%2F135_passing-4caf50?style=flat-square)](https://vitest.dev/)

</div>

---

## fmbot Feature Parity

| Feature | Progress |
|:---|:---|
| Now Playing `.fm` — 6 embed modes, buttons, artwork | `█████████░` 95% |
| Artwork Engine — Spotify → Deezer → Apple → Last.fm | `██████████` 100% |
| Who Knows `.wk` `.wkt` `.wka` — guild leaderboards | `████████░░` 85% |
| Friends Who Knows `.fwk` `.fwkt` `.fwka` | `████████░░` 85% |
| Guild Crowns — steal logic, thresholds, seeding | `██████████` 100% |
| Grid Charts `.chart` — 3×3 to 10×10, Puppeteer | `██████████` 100% |
| Top Artists / Albums / Tracks — pagination, time periods | `█████████░` 90% |
| Daily Overview — day-by-day scrobble breakdown | `████████░░` 85% |
| Artist Top Tracks | `██████████` 100% |
| Taste & Compatibility | `████████░░` 85% |
| Track Details — BPM, key, audio preview voice message | `██████████` 100% |
| Friend System — add, remove, manage | `█████████░` 90% |
| Delta Sync — background scrobble updates | `██████████` 100% |
| Artist / Album / Track deep-dives | `████░░░░░░` 40% |
| Genre & Country commands | `░░░░░░░░░░` 0% |
| Server billboard (serverartists / topalbums) | `░░░░░░░░░░` 0% |
| Long-tail commands (plays, pace, streak, milestone…) | `░░░░░░░░░░` 0% |
| Guild admin & configuration | `█░░░░░░░░░` 10% |
| **Overall core parity** | **`█████░░░░░` ~52%** |

> Extras not in fmbot at all: Lavalink music playback, football live scores, Essentia audio analysis.

---

## Stack

`TypeScript` · `discord.js v14` · `PostgreSQL + Prisma` · `Redis` · `Puppeteer` · `Moonlink.js v5 (Lavalink)` · `tsyringe` · `Vitest`

## Setup

```bash
git clone https://github.com/tvbot69/tvbot.git && cd tvbot
npm install
cp .env.example .env   # fill in DISCORD_TOKEN, DATABASE_URL, LASTFM_API_KEY/SECRET
npm run db:generate && npm run db:deploy
npm run dev
```
