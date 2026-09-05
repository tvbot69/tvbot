# tvbot

A feature-rich Discord bot combining Last.fm statistics tracking and Lavalink music playback, built with TypeScript and Discord.js v14.

## Features

- **Last.fm Stats**: Track music history, now playing (`/fm`, `.fm`), who knows (`wk`), crowns, top artists/albums/tracks, custom overview, and chart generators.
- **Dynamic Image Generator**: High-performance Puppeteer-based grid chart generator with album covers and customizable layouts.
- **Discord Components V2**: Modern UI containers, interactive buttons, select menus, and modals.
- **Per-User Color Isolation**: Custom accent colors per user without leaking into other users' embeds.
- **Music & Lyrics**: Multi-source lyrics integration (Genius, AuDD) and music playback support via Lavalink (Moonlink.js).
- **Egyptian & International Football**: Live football fixtures, scores, and standings integration.

## Tech Stack

- **Runtime & Language**: Node.js (v20+), TypeScript
- **Discord Library**: `discord.js` v14 with Components V2 containers
- **Database & ORM**: PostgreSQL with Prisma ORM
- **Cache**: Redis (`ioredis`)
- **Rendering**: Puppeteer (headless browser generation)
- **Dependency Injection**: `tsyringe`
- **Testing**: `vitest`

## Setup & Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/<your-username>/<your-repo-name>.git
   cd tvbot
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Copy the `.env.example` file to `.env` and fill in your credentials:
   ```bash
   cp .env.example .env
   ```

4. **Build and Run:**
   ```bash
   # Development (with hot-reload)
   npm run dev

   # Run tests
   npm test

   # Production Build
   npm run build

   # Start production
   npm start
   ```
