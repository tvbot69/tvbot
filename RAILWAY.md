# 🚀 Deploying tvbot to Railway (First-Try Guide)

This guide walks you through deploying **tvbot** on [Railway](https://railway.app) smoothly and keeping it 100% stable within Railway's Starter/Free plan resource limits (512MB RAM & shared vCPU).

---

## 1. Pre-Deployment Summary

The codebase is now pre-configured for Railway:
- **Node.js 22 (single source of truth: `.nvmrc`)**: `package.json` engines
  require `>=22 <23`, `.npmrc` sets `engine-strict=true`, CI reads
  `node-version-file: .nvmrc`, and both Dockerfile stages use
  `node:22-bookworm-slim` (tag only, no digest pinned).
- **Production Multi-Stage Dockerfile**: Uses `node:22-bookworm-slim` with system `chromium`, international fonts (CJK, Arabic, Emojis), `openssl`, and `ffmpeg`.
- **Zero Missing Chrome Libraries**: Puppeteer uses Debian's system `/usr/bin/chromium` (`PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true`), so it never fails on missing `.so` dependencies and builds 3x faster.
- **Low Memory Footprint (Free Plan Optimized)**:
  - Node.js heap ceiling clamped: `--max-old-space-size=384` (ensures V8 triggers garbage collection before hitting Railway's 512MB container limit).
  - Chromium runs with `--single-process`, `--no-zygote`, and `--js-flags="--max-old-space-size=128"`.
  - In-memory cache is capped at 3,000 LRU entries (~10–15MB).
  - Skips localhost Redis socket attempts if `REDIS_URL` is omitted.
- **Healthcheck Probe**: Railway checks `http://localhost:$PORT/health`. That endpoint
  returns 503 when the database is down, when the process is draining, **and — after a
  3-minute boot grace window — when the Discord gateway is not `ready`.** The grace
  window matters: a cold start has no gateway for a while (migrations run before the
  process even starts), and failing every check during boot would report a slow start
  as a failed deploy.

---

## 2. Step-by-Step Deployment

### Step A: Push to GitHub
Ensure your latest changes are pushed to your GitHub repository.

### Step B: Create New Project on Railway
1. Log into [Railway.app](https://railway.app).
2. Click **"New Project"** $\rightarrow$ **"Deploy from GitHub repo"**.
3. Select your `tvbot` repository.
4. Railway will automatically detect the [`railway.json`](railway.json) and [`Dockerfile`](Dockerfile).

### Step C: Add Environment Variables in Railway Dashboard
Before the first deployment boots up, navigate to the **Variables** tab in your Railway service and add the following:

#### Required Variables
| Variable Name | Value / Description |
| :--- | :--- |
| `DISCORD_TOKEN` | Your Discord bot token from Discord Developer Portal |
| `DATABASE_URL` | Your Railway PostgreSQL connection string (`postgresql://...`) |
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

## 2b. Migrations and the start command

**Migrations run automatically on every deploy.** `npm start` applies
`prisma migrate deploy` before launching the bot, and it fails closed — if a
migration errors, the process exits and Railway restarts it rather than running
against an out-of-date schema.

There is deliberately **exactly one** definition of how the bot boots:

| What | Where |
|---|---|
| start + migrate | `package.json` → `scripts.start` |
| what the image runs | `Dockerfile` → `CMD ["npm", "start"]` |
| what Railway runs | `railway.json` → *nothing* |

`railway.json` sets no `startCommand` on purpose. A `startCommand` there
**overrides the Dockerfile `CMD`**, which is how migrations stopped running on
Railway: the override was a bare `node dist/bot/index.js` with no migrate step.
If you add one back, migrations silently stop running again.

`nixpacks.toml` was removed for the same reason — `railway.json` uses
`builder: DOCKERFILE`, so the nixpacks config was never read.

**After changing `schema.prisma`:** commit the generated SQL under
`src/persistence/prisma/migrations/` and let the deploy apply it. Never edit an
already-applied migration; add a new one instead.

---

## 3. How It Stays Under Free Plan Limits

### System-vs-bundled media

Prod uses Debian system `chromium` (`PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`)
and system `ffmpeg`/`ffprobe` (`FFMPEG_PATH`/`FFPROBE_PATH`). Bundled npm builds
(Puppeteer download skipped via `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true`,
`ffmpeg-static`/`ffprobe-static`) are local-dev/Windows fallbacks only. `sharp`
stays in `dependencies` because prod accent-color extraction needs it after
`npm prune --omit=dev`.

1. **Memory Cap**: The Node process will not exceed ~384MB heap. It is logged hourly — see [§4 Memory Observability](#4-memory-observability), which also records what is *not* measured.
2. **Chromium Sandboxing**: Chromium runs in single-process mode, consuming ~60MB RAM only when generating image collages (`.c`, `.top`, `.wk`), releasing memory immediately when done.
3. **No Database Polling**: The bot does not run 24/7 heavy database loops; all stats and exposure features trigger on event or via spaced cron schedules.

---

## 4. Memory Observability

### 4.1 The constraint

Railway's Starter container is **512MB**, and the Node heap is deliberately
clamped below it:

```
npm start → node --max-old-space-size=384 dist/bot/index.js
```

The 384MB is a **V8 old-space ceiling for the Node process only**. It is not a
budget for the container, and the container is not just Node:

| Resident in the same 512MB | What it costs | Is it in `process.memoryUsage()`? |
|---|---|---|
| Node process (Discord.js, Prisma, caches, the 3k-entry LRU) | the 384MB clamp, plus buffers off-heap | **yes** — that is what the log line reports |
| Chromium (Puppeteer child process) | ~60MB while a collage renders, released after | **no** — separate OS process |
| Essentia WASM (`essentia.js`) | inside the heap + `arrayBuffers` | partially, as `arrayBuffers` |
| Lavalink / Moonlink clients | sockets + decoded-track metadata in the heap | yes, as part of `heapUsed` |

So read RSS as the **Node floor**, never as the container total. A container
sitting near 512MB with `rss` reading 300MB is normal and expected: the
difference is Chromium.

### 4.2 The log line

`src/domain/memoryReport.ts` samples the process, and `TimerService` fires it
as the `memory-sample` job on the cron **`0 * * * *`** — once an hour, at the
top of the hour, through the same `registerJob` machinery as every other sweep
(no second interval). It is deliberately **not** an `onlyOwner` job: on a sharded
deploy each shard has its own heap and only that shard can see it.

Grep for it with:

```
railway logs 2>&1 | grep "Memory sample"
```

A real line (captured from a bare local `tsx` process, i.e. a floor with no
Discord.js, Prisma or Lavalink loaded — the bot reads much higher):

```
[  ] INFO Memory sample {
  rssMb: 53.2,
  heapTotalMb: 12.5,
  heapUsedMb: 8.1,
  heapUsedPctOfCap: 2.11,
  heapCapMb: 384,
  externalMb: 3.6,
  arrayBuffersMb: 1.2,
  uptimeSeconds: 0.1449756,
  uptime: '0s'
}
```

How to read it:

| Field | Meaning | What a bad number looks like |
|---|---|---|
| `rssMb` | Resident set of **this** process, excluding Chromium | climbing line by line across hours = a leak that GC is not reclaiming |
| `heapUsedMb` | JS objects actually in use | a sawtooth is normal (GC); a rising floor is not |
| `heapUsedPctOfCap` | `heapUsedMb` as a share of the 384MB clamp | sustained >80% means V8 will start GC-thrashing before Railway OOM-kills |
| `heapTotalMb` | Heap V8 has *reserved* | normally larger than `heapUsedMb`; the gap is uncollected garbage |
| `externalMb` / `arrayBuffersMb` | Buffers outside the JS heap — audio, images, WASM | rising with `arrayBuffersMb` means decoded media or PNG buffers are being retained |
| `uptime` | `2d4h11m` — matches the `uptime` in a Docker restart | a young uptime plus high `rssMb` means "big at boot", not a leak |

Two honest limits on these numbers:

- `heapUsedPctOfCap` **can exceed 100**. `--max-old-space-size` bounds old space
  only, while `heapUsed` also counts new space and the code space. Over 100 is
  not a broken calculation.
- The sample is a **point sample**, not a peak. A leak that spikes and is
  collected between the hour marks will not appear here. That is the price of
  keeping the volume at one line an hour.

### 4.3 Measured peak: NOT YET MEASURED

**There is no measured production peak yet.** The sampling ships in code, but it
has not run on Railway, so no peak figure is recorded here — any number would be
a guess presented as data.

To fill this in after the first deploy that includes the sampler:

1. Let the bot run at least 24 hours across its normal traffic (a weekday
   evening and the 04:00–09:00 cron window matter most; that is when the index
   queue and privacy purge run).
2. `railway logs 2>&1 | grep "Memory sample"` and take the **maximum
   `rssMb`** and **maximum `heapUsedPctOfCap`** across the window — those
   maxima, not the last line, are the peak.
3. Replace this paragraph with the real figures, the date range they cover, and
   whether Chromium was rendering during the peak.

Until then, treat the 384MB clamp and the 512MB container limit as design
constraints, not as measurements. If Railway ever reports an OOM kill, the
hourly samples in the preceding deploy are the first thing to read: a `rssMb`
that climbed linearly says leak, a flat `rssMb` at a high value says the cap is
simply too small for this workload.

---

## 5. Strict Postgres checks on a laptop (`docker-compose.test.yml`)

`scripts/verify-schema-drift.ts` runs STRICT only with a database: `SHADOW_DATABASE_URL`
set means shadow replay (same as CI), `DATABASE_URL` alone means live diff, neither
means DEGRADED columns-and-indexes only with types/constraints UNVERIFIED. Schema drift
was once found by luck on the first real-Postgres run — this compose file gives a laptop
the same strict answer as CI via a disposable `postgres:16`.

Scratch names only (`tvbot_ci_test`, `tvbot_ci_shadow` — both pass the `dbHarness`
scratch-name guard). Never point these at production; the shadow check RESETS its database.

```
docker compose -f docker-compose.test.yml up -d
docker compose -f docker-compose.test.yml exec postgres-test psql -U tvbot -d tvbot -c "CREATE DATABASE tvbot_ci_shadow"
docker compose -f docker-compose.test.yml exec postgres-test psql -U tvbot -d tvbot -c "CREATE DATABASE tvbot_ci_test"
$env:DATABASE_URL = "postgresql://tvbot:tvbot@localhost:5432/tvbot_ci_test?schema=public"
npx prisma migrate deploy --schema src/persistence/prisma/schema.prisma
$env:SHADOW_DATABASE_URL = "postgresql://tvbot:tvbot@localhost:5432/tvbot_ci_shadow?schema=public"
npm run db:verify-schema-drift -- --selftest
npm run db:verify-schema-drift
$env:TEST_DATABASE_URL = "postgresql://tvbot:tvbot@localhost:5432/tvbot_ci_test?schema=public"
npm run test:db
docker compose -f docker-compose.test.yml down -v
```

(Bash equivalent: prefix each command with `VAR=value`, e.g.
`SHADOW_DATABASE_URL=... npm run db:verify-schema-drift`.)
