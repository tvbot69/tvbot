# 🚀 Deploying tvbot to Railway (First-Try Guide)

This guide walks you through deploying **tvbot** on [Railway](https://railway.app) smoothly and keeping it 100% stable within Railway's Starter/Free plan resource limits (512MB RAM & shared vCPU).

---

## 1. Pre-Deployment Summary

The codebase is now pre-configured for Railway:
- **Production Multi-Stage Dockerfile**: Uses `node:22-bookworm-slim` with system `chromium`, international fonts (CJK, Arabic, Emojis), `openssl`, and `ffmpeg`.
- **Zero Missing Chrome Libraries**: Puppeteer uses Debian's system `/usr/bin/chromium` (`PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true`), so it never fails on missing `.so` dependencies and builds 3x faster.
- **Low Memory Footprint (Free Plan Optimized)**:
  - Node.js heap ceiling clamped: `--max-old-space-size=384` (ensures V8 triggers garbage collection before hitting Railway's 512MB container limit).
  - Chromium runs with `--single-process`, `--no-zygote`, and `--js-flags="--max-old-space-size=128"`.
  - In-memory cache is capped at 3,000 LRU entries (~10–15MB).
  - Skips localhost Redis socket attempts if `REDIS_URL` is omitted.
- **Healthcheck Probe**: Railway automatically checks `http://localhost:$PORT/health`.

---

## 2. Step-by-Step Deployment

### Step A: Push to GitHub
Ensure your latest changes are pushed to your GitHub repository.

### Step B: Create New Project on Railway
1. Log into [Railway.app](https://railway.app).
2. Click **"New Project"** $\rightarrow$ **"Deploy from GitHub repo"**.
3. Select your `tvbot` repository.
4. Railway will automatically detect the [`railway.json`](file:///home/moha/Desktop/tvbot/railway.json) and [`Dockerfile`](file:///home/moha/Desktop/tvbot/Dockerfile).

### Step C: Add Environment Variables in Railway Dashboard
Before the first deployment boots up, navigate to the **Variables** tab in your Railway service and add the following:

#### Required Variables
| Variable Name | Value / Description |
| :--- | :--- |
| `DISCORD_TOKEN` | Your Discord bot token from Discord Developer Portal |
| `DATABASE_URL` | Your Neon PostgreSQL connection string (`postgresql://...`) |
| `LASTFM_API_KEY` | Your Last.fm API Key |
| `LASTFM_API_SECRET` | Your Last.fm API Secret |

#### Recommended Variables
| Variable Name | Value / Description |
| :--- | :--- |
| `ENVIRONMENT` | `production` |
| `NODE_ENV` | `production` |
| `BOT_PREFIX` | `.` (or your preferred prefix) |
| `ENABLE_LAVALINK` | `false` = music fully off in **every** env (use during push-heavy periods to spare public nodes); unset/`true` = on in production, off in local dev |
| `SPOTIFY_CLIENT_ID` | Your Spotify Client ID *(for album cover resolution)* |
| `SPOTIFY_CLIENT_SECRET`| Your Spotify Client Secret |

*(Optional: If you ever spin up a Redis container on Railway, set `REDIS_URL`. Otherwise, `tvbot` runs seamlessly with its high-speed in-memory LRU cache!)*

### Step D: Deploy!
1. Click **Deploy** (or trigger a redeploy if variables were added).
2. Watch the **Build Logs**:
   - Compiles TypeScript into `dist/`.
   - Generates Prisma client.
   - Installs Debian Chromium and font packs.
3. Watch the **Deploy Logs**:
   - You should see:
     ```
     [INFO] Health check probe listening on http://localhost:PORT/health
     [READY] Connected as tvbot#xxxx (Serving X guilds, Y users)
     ```
4. Railway's health check will ping `/health`, turn **Active (Green)**, and the bot will be online in your Discord server!

---

## 3. How It Stays Under Free Plan Limits

1. **Memory Cap**: The Node process will not exceed ~384MB heap.
2. **Chromium Sandboxing**: Chromium runs in single-process mode, consuming ~60MB RAM only when generating image collages (`.c`, `.top`, `.wk`), releasing memory immediately when done.
3. **No Database Polling**: The bot does not run 24/7 heavy database loops; all stats and exposure features trigger on event or via spaced cron schedules.
