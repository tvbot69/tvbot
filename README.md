<div align="center">

# tvbot

**Last.fm listening intelligence and self-hosted music playback, as a Discord bot.**

[![CI](https://github.com/tvbot69/tvbot/actions/workflows/ci.yml/badge.svg)](https://github.com/tvbot69/tvbot/actions/workflows/ci.yml)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.js.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-22_LTS-5FA04E?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Prisma](https://img.shields.io/badge/Prisma-PostgreSQL-2D3748?style=flat-square)](https://www.prisma.io/)
[![Vitest](https://img.shields.io/badge/tests-passing-brightgreen?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/)

</div>

---

A complete alternative to [fmbot](https://github.com/derpie/fmbot) for Last.fm
statistics, plus a full music player that fmbot does not have. Every feature
ships as both a slash command and a `.`-prefixed text command.

<!-- metrics:start -->
| Metric | Count |
|---|---|
| Production files | 395 |
| Production lines | 84385 |
| Slash top-level commands | 76 |
| Text commands | 158 |
| Text triggers + aliases | 575 |
| Test files | 442 |
| Repositories | 19 |
<!-- metrics:end -->
See [docs/METRICS.md](docs/METRICS.md) for current counts.

---

## Features

### Listening statistics
Full Last.fm history indexed and kept in sync incrementally. Now-playing embeds,
per-user and per-guild play counts, listen streaks, milestones, pace tracking,
top lists, listening-time leaderboards, and artist/album/track gap reports.

### Who Knows
Per-guild leaderboards for any artist, album, track, genre or country. Ranked
from indexed plays and reconciled against a live playcount, respecting each
user's privacy setting, guild bans, and self-blocking.

### Crowns
Guild crowns for artists and albums, with claim, steal, configurable play
thresholds, activity thresholds, role gating, bulk seeding, and live
re-evaluation against fresh scrobbles.

### Charts
Collage images from 3×3 up to 10×10, in multiple themes, as a slash command, a
text command, or a scheduled autopost. Rendered headlessly with Chromium.

### Taste
Compatibility scoring between two users, with a jumble mode for finding
unexpected overlap.

### Artwork
A Spotify → Deezer → Apple → Last.fm cascade, cached in memory and Redis, with
placeholder filtering and strict title matching that still tolerates
date-prefixed compilation rips.

### Playback
Lavalink v4 with automatic node failover. A health-gated search ladder
(self-hosted resolver first, SoundCloud as fallback) behind per-node and
per-song breakers, so a dead source costs one skip rather than a stall.
Queue, shuffle, seek, filters, loop, 24/7 mode, and re-enqueue. Chapter cards
for long videos.

### Audio
On-device BPM and musical-key detection via Essentia WASM. 30-second previews.
Opus voice messages with a generated waveform.

### Account
Link a Last.fm account, set a per-guild prefix, configure default settings and
shortcuts, and manage connections.

---

## Quick start

```bash
git clone https://github.com/tvbot69/tvbot.git && cd tvbot
npm install
cp .env.example .env      # fill in the values below
npm run db:generate && npm run db:deploy
npm run dev
```

Requires Node 22 and a PostgreSQL database. Playback additionally needs a
reachable Lavalink node and `ffmpeg` on `PATH` (or `FFMPEG_PATH` set).

---

## Configuration

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN` | Bot token. Required. |
| `DATABASE_URL` | PostgreSQL connection string. Required. |
| `LASTFM_API_KEY` / `LASTFM_API_SECRET` | From your Last.fm API account. Required. |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Artwork and search. Optional. |
| `REDIS_URL` | Caching. Falls back to in-memory if unreachable. Optional. |
| `HOME_RESOLVER_URL` / `HOME_RESOLVER_TOKEN` | Your resolver for the playback search ladder. |
| `HOME_LADDER_MODE` | `resolver-first` (default) or `plugin-first-test`. |
| `HOME_PLUGIN_RUNG` | `on` to enable the experimental YouTube-plugin rung. |
| `ENABLE_LAVALINK` | `false` disables playback entirely. |
| `YOUTUBE_API_KEY` | Chapter timestamps for long videos. |
| `FFMPEG_PATH` | ffmpeg binary, if not on `PATH`. |
| `STAGING_CHANNEL_ID` | Channel for temporary chart uploads. |
| `RESOLVER_ALERT_WEBHOOK_URL` | Where to post when your resolver goes offline. |

`HOME_RESOLVER_URL` must be publicly reachable — Discord fetches artwork and
audio through its own crawler, so a LAN address will not serve images.

---

## Commands

<details>
<summary><b>All canonical commands</b></summary>

**Now playing** — `fm` `np` `nowplaying` `lastlistened` `mode` `fmmode`
`scrobble` `love` `unlove` `lyric` `lyrics` `refresh`

**Counts** — `plays` `pace` `milestone` `timeleaderboard` `playleaderboard`
`streak` `streaks` `taste` `jumble` `affinity`

**Library** — `album` `artist` `track` `artisttracks` `albumtracks`
`artistalbums` `genre` `country` `overview` `topalbums` `topartists` `toptracks`
`topgenres` `topcountries` `search` `librarysearch` `import` `update`
`discoveries` `featured` `iceberg` `gaps`

**Who Knows** — `whoknows` `whoknowsalbum` `whoknowstrack` `whoknowsgenre`
`whoknowscountry` `friendwhoknows` `friendwhoknowsalbum`

**Crowns** — `crown` `crowns` `crownlb` `crownthreshold` `crownactivitythreshold`
`crownroles` `crownseed` `crownblock` `crownunblock` `crownblockedusers`
`togglecrowns` `killallcrowns` `killcrown` `removeusercrowns`

**Guild** — `serveralbums` `serverartists` `servergenres` `servertracks`
`serversettings` `refreshmembers` `members` `chart` `autoposts` `pixel`
`disabledchannel` `disabledcommands` `channeltogglecommand` `togglecommand`

**Social** — `friends` `addfriends` `managefriends` `removefriends`
`friended` `block` `unblock` `blockedusers` `selfblock` `selfunblock` `exposed`
`botscrobbling` `bottrack`

**Playback** — `play` `pause` `resume` `skip` `skipto` `previous` `seek`
`queue` `remove` `shuffle` `volume` `filters` `clear` `loop` `247` `join`
`leave` `move` `stop` `nodes` `autoplay` `replay` `chapters` `karaoke`
`covermode`

**Links** — `spotify` `spotifyalbum` `spotifyartist` `applemusic`
`applemusicalbum` `applemusicartist` `youtube` `receipt` `trackdetails`

**Account** — `user` `profile` `login` `logout` `unlink` `register` `settings`
`shortcuts` `prefix`

**Meta** — `help` `ping`

</details>

Aliases are also registered — `ap` for `artistplays`, `abp` for
`albumplays`, `tp` for `trackplays`, `ryw` for `rateyourmusic`, and so on. See
[docs/METRICS.md](docs/METRICS.md) for the current alias count. Run
`/help` in Discord for the full list.

---

## Architecture

```
src/
├── domain/            shared kernel: logging, text, http, errors, enums, ports
├── bot/
│   ├── startup.ts     composition root — every service built by hand
│   ├── services/      13 subsystem folders
│   ├── builders/      response factories
│   ├── slashCommands/ ├── interactions/   one shared domain vocabulary
│   ├── textCommands/  the `.`-prefixed family
│   └── handlers/      commands, interactions, music, logs, queues, users
├── persistence/       Prisma schema, 19 repositories
├── lastfm/ spotify/ applemusic/ deezer/ images/    provider clients
└── __tests__/         repo-wide invariant tests
```

Dependency injection is a hybrid. Services carry `@injectable()` and
`reflect-metadata` stays imported, but there is no container scanning:
almost every service is constructed positionally with `new` in
`src/bot/startup.ts` and registered via `container.registerInstance`,
then read back with `container.resolve` (a handful of handler/interaction
tokens are resolved via reflection). Playback is a
strict DAG, enforced by `npm run deps:cycles`.

---

## Development

```bash
npm run build          # typecheck and compile
npm test               # unit tests, see docs/METRICS.md for current count
npm run lint
npm run test:db        # real PostgreSQL, see docs/METRICS.md for current count
npm run test:render    # headless Chromium, real pixels
npm run test:coverage
npm run debt           # code-quality ratchets
```

Coverage is tracked in [docs/METRICS.md](docs/METRICS.md). The Postgres and render suites are split out because
they need a real database and a real browser respectively.

[`AGENTS.md`](./AGENTS.md) is the engineering manual: architectural rules, the
verification gates, the playback invariants and the tree conventions. Read it
before contributing.
