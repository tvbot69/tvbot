<div align="center">

# tvbot

**A private, unlimited fmbot-class Discord bot — Last.fm music intelligence plus full Lavalink playback. TypeScript, production-hardened.**

[![Discord.js](https://img.shields.io/badge/Discord.js-v14-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.js.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/Tests-635%2F635_passing-4caf50?style=flat-square)](https://vitest.dev/)
[![Prisma](https://img.shields.io/badge/Prisma-6_PostgreSQL-2D3748?style=flat-square)](https://www.prisma.io/)

</div>

---

## What it is

tvbot mirrors fmbot's Last.fm statistics and social features at ~95% core parity, then goes past it: a complete self-hosted music playback stack, audio analysis, and live football — all in one process, deployed on Railway, backed by PostgreSQL.

Every command ships twice (slash + `.` prefix) through a single response pipeline, with per-guild settings, privacy controls, and paginated interactive embeds throughout.

## Listening intelligence

Live Last.fm sync (delta updates with backfill, full historical indexing), guild Who-Knows leaderboards, artist crowns with stealing and thresholds, collage charts (3×3 to 10×10), taste compatibility, playcounts, milestones, server billboards, genre and country breakdowns, scheduled autoposts. Artwork resolves through a multi-provider cascade (Spotify → Deezer → Apple → Last.fm) with placeholder filtering, never raw Last.fm URLs.

## Playback

Lavalink v4 (Moonlink.js) across a self-hosted Home node plus public failover. YouTube plays through a health-gated ladder — plugin first, yt-dlp resolver second, SoundCloud last — guarded by per-node outage and per-song breakers, so a dead source costs one fast skip, never a stall. Cipher solving and per-video token minting run as local sidecar services; the resolver keeps a permanent local audio library, making repeats instant and infrastructure-independent. Track analysis (BPM, musical key, previews as voice messages) runs on-device via Essentia DSP.

## Platform

Manual dependency injection (no decorator magic), Prisma + PostgreSQL, Redis with transparent in-memory fallback, structured logging, background cron (sync, cleanup, autoposts, updates), and a 635-test Vitest suite gating every change (`npm run build` + `npm test` — no exceptions).

## Setup

```bash
git clone https://github.com/tvbot69/tvbot.git && cd tvbot
npm install
cp .env.example .env   # fill in DISCORD_TOKEN, DATABASE_URL, LASTFM_API_KEY/SECRET
npm run db:generate && npm run db:deploy
npm run dev            # production: npm run build && npm start
```
