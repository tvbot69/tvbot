# tvbot — Full Parity Plan (fmbot-dev → tvbot 1:1)

> **Goal:** Lift core Last.fm parity `42%` → `68%` (+15 long-tail commands) without touching premium/admin (`globalWk`, `import`, `jumble`, `discogs`, `autopost`). Keep `unlimited` policy (no pruning, no supporter gates). Track progress via `README.md` parity table.

**Current:** `~52%` core (`fm/wk/chart/top/overview/at/taste/crowns/music` 100% loop), `37%` raw. **Done this cycle:** `fm @mention`, `artworkService` star filter + `Spotify→Deezer→Apple` primary, `chart` 1/40 `ArtworkService` forced, `wk` `discord displayName` fetch + footer `Artist - X listeners - Y plays - Z avg` (hidden `1` avg) + `wkt` `getTrackCoverUrl` strict, `top` `200→1000` limit + `weekly→overall` + `1d-6d/2024/march` via `SettingService` + `jump 1-31` modal, `overview` → DB `prisma.userPlay` (fix `403`), `at` split from `o` into `artistTrackService` `Your top tracks for 'zaf'` `10`/page, `puppeteer` ephemeral `4s` cap, `trackdetails` Essentia `140.0 bpm` + `p.scdn.co` via `spotifyScraper` + `Open on Spotify sp:14962971`.

---

## Phase 0 — Foundations (done, keep)

- [x] **DI** `src/bot/startup.ts:103` manual `registerInstance` — single source, no decorators
- [x] **Artwork** `src/bot/services/artworkService.ts` single source (`isPlaceholder 2a96cb…`, `art:*` 3600s, `90d` freshness)
- [x] **Puppeteer** `src/images/generators/puppeteerService.ts:278` `close()` `pages 1.5s` + `browser.close 3s` + `SIGKILL` + `gracefulShutdown 4s` hard cap
- [x] **Lavalink** `src/bot/services/music/moonlinkManager.ts:25` `ENABLE_LAVALINK=false` dev dummy `dummy-disabled` + `lavalink:cooldown:*` Redis persist
- [x] **WhoKnows** `src/bot/services/whoKnows/*` `guild.members.fetch` if not cached for `discordName`

---

## Phase 1 — Highest-value long-tail (15 commands → 42%→68%)

Each item: `fmbot` → `tvbot` files + DB + builder.

### 1. `artistplays` `ap` / `albumplays` `abp` / `trackplays` `tp` - [x] COMPLETED
- **fmbot:** `ArtistCommands.cs:167` `artistplays ap` / `AlbumCommands.cs:67` `albumplays abp` / `TrackCommands.cs:76` `trackplays tp` → `ArtistBuilders.ArtistPlaysAsync` + `PlayService.GetRecentArtist/Album/TrackPlaycounts` + `GetArtist/Album/TrackPlayHistory` (graph) + `CorrectUser*Playcount`
- **tvbot:** Full 1:1 parity implemented in `src/bot/services/playHistoryService.ts`, `src/bot/builders/playcountBuilders.ts`, `src/bot/textCommands/lastfm/playcountCommands.ts`, and `src/bot/slashCommands/playcountSlashCommands.ts`.

### 2. `plays` `p` / `pace` `pc` / `milestone` `m` - [x] COMPLETED
- **fmbot:** `PlayCommands.cs: plays p/scrobbles, pace pc, milestone m/ms` → `PlayBuilders.PaceAsync` (goal projection), `MileStoneAsync` (scrobble `5123`), `PlaysAsync` (time-period count via `user.getInfo` `totalPlayCount` + `GetScrobbleCountFromDate`)
- **tvbot:** Full 1:1 parity implemented in `SettingService.getGoalAmount`, `SettingService.getMilestoneAmount` (with `rnd`/`random` and reroll buttons `milestone:reroll:`), `PlaycountBuilders.buildPaceResponse`, and `PlayHistoryService.getMilestoneScrobble`.

### 3. `discoverydate` `dd` / `lastlistened` `ll` - [x] COMPLETED
- **fmbot:** `PlayCommands.cs: discoverydate dd` + `lastlistened ll` → `PlayService.GetArtistFirstPlayDate` / `GetTrackLastPlayed`
- **tvbot:** Full 1:1 parity implemented in `PlayHistoryService.getDiscoveryDates` and `PlayHistoryService.getLastListenedDates` with 30-day relative timestamp styles (`f` vs `D`) and sub-links.

### 4. `search` `sr` (library search, not music)
- **fmbot:** `PlayCommands.cs: search sr/find` → `PlayBuilders.SearchAsync` cached `prisma` `SearchUserTracks/Albums/Artists/Plays` + `Fergun Paginator` tabs `Tracks/Albums/Artists/Plays`
- **tvbot gap:** `search` currently is music Lavalink, not library.
- **Build:** `src/bot/services/librarySearchService.ts` (`SearchUserTracks/Albums/Artists` via `prisma.$queryRaw` trigram), `src/bot/builders/searchBuilders.ts` (4 tabs, `#[rank]`), `src/bot/textCommands/lastfm/searchCommands.ts` `search/sr` + slash `search`, `src/bot/interactions/searchInteractions.ts` tab switching

### 5. `profile` / `stats` / `user`
- **fmbot:** `UserCommands.cs: profile/stats/user` → `UserBuilder.ProfileAsync` (playcount, registered, country, recent top)
- **Build:** `src/bot/builders/profileBuilders.ts` + `src/bot/slashCommands/profileSlashCommands.ts`

### 6. `streak` `str` / `streaks` `strs`
- **fmbot:** `PlayCommands.cs: streak str` + `streaks` → `PlayService.GetStreak` + `UserStreak` DB (`streak_id, user_id, artist_name, start, end, count`)
- **Build:** Add `prisma/schema.prisma` `model UserStreak`, `src/bot/services/streakService.ts`, `src/bot/builders/streakBuilders.ts`

---

## Phase 2 — Server scope (guild billboards)

- **fmbot:** `serverartists sa`, `serveralbums sab`, `servertracks st/bb`, `servergenres sg` → `GuildService.GetTopAllTimeForGuild` + `PlayService.GetGuildTop*` + `GuildBuilders`
- **tvbot gap:** `guildService` exists but no `server*` commands; `GuildRankingSettings` missing.
- **Build:** `src/bot/services/guildRankingService.ts` (`prisma.userPlay.groupBy` where `userId in guildUserIds` + time `StartDateTime`), `src/bot/builders/serverBuilders.ts`, `src/bot/textCommands/guild/serverCommands.ts` + slash `serverSlashCommands.ts` (4 subs)

---

## Phase 3 — Genre / Country (services orphaned)

- **Current:** `src/bot/services/genreService.ts` + `countryService.ts` exist but no `GenreBuilders`/`CountryBuilders` or commands.
- **Build:** `src/bot/builders/genreBuilders.ts` + `countryBuilders.ts` (use existing `artistsService` + `genreService.getTopGenresForTopArtists`), `src/bot/textCommands/lastfm/genreCommands.ts` `topgenres gl, genre g, wkgenre wg, friendwhoknowgenre fwg`, `src/bot/textCommands/lastfm/countryCommands.ts` `topcountries cl, country, countrychart cc`

---

## Phase 4 — Loved / Scrobble (Last.fm OAuth, not premium)

- **fmbot:** `love l, unlove ul, loved lt, scrobble sb` → `TrackBuilders.LoveTrackAsync` (`dataSourceFactory.LoveTrackAsync` signed), `ScrobbleAsync` (`ScrobbleAsync` with `sk`)
- **tvbot gap:** OAuth flow `LoginService` exists (`/login`), but no `love/scrobble` wiring.
- **Build:** `src/bot/services/loveService.ts` (wrap `LastFmRepository` signed), `src/bot/textCommands/lastfm/loveCommands.ts` + slash, reuse `loginService.confirmLogin` session.

---

## Phase 5 — Polish (no new commands)

- [ ] **Text `search` vs music `search` conflict** — rename music `search` to `musicsearch` or keep `search` for library and `play search` for music (fmbot uses `search` for library, youtube separate `youtube y`).
- [ ] **Settings parity** — `fmmode` already, add `responsemode/wkmode`, `covermode`, `privacy`, `mode` central picker (`UserBuilder.ModePick`) — low priority.
- [ ] **Guild admin** — `configuration/ss`, `members/mb`, `block/unblock`, `autoposts` — skip for private bot (keep `settings` minimal as now).

---

## Execution order (make it work first try)

1. **Week 1:** Phase 1 `#1-#3` (`ap/abp/tp` + `p/pc/m` + `dd/ll`) — 8 commands, single `playHistoryService` + 1 builder `playcountBuilders`. Verify `npm run build` + `ta` still `Page 1/40` + `at` `Your top tracks for 'zaf'` + `overview` daily DB group (fix 403 already done: `getUserRecentTracksWithMetadata` 100 fallback).
2. **Week 2:** Phase 1 `#4-#6` (`search` library + `profile` + `streak` DB) — `UserStreak` migration, `librarySearchService`.
3. **Week 3:** Phase 2 `server*` + Phase 3 `genre/country` — wire orphaned services, 5 builders, `GuildRankingService`.
4. **Week 4:** Phase 4 `love/scrobble` (requires testing `sk` 403 handling already fixed via `RecentTracks` unsigned fallback).
5. Each phase: create `service → builder → slash+text → interaction → startup DI → slash/index + text/index + interactionHandler route → build + test + manual slash/text in dev guild`.

**Verify each phase:** `npm run build` + `npm test` (expect 1 pre-existing `lavalinkConfig` fail) + `npm run dev` `ENABLE_LAVALINK=false` manual `.ap zaf` `ap` `p weekly` `search zaf` `profile` `streak` `serverartists weekly`.

---

## Intentionally Skip (premium/admin)

`globalwhoknows` `gw*` (18 aliases), `import` `spotifyimport/appleimport` (file import), `discoveries/gaps` supporter upsell, `jumble/pixel` game, `discogs`, `eurovision`, `autopost`, `premiumserver/botbranding/servershortcuts/allowedroles`, `featured/rym/botscrobbling`, `admin` `banguild/leaveserver`.

