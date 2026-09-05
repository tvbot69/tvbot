# Crown System — Deep Dive & Remake Plan (tvbot × fmbot-dev)

## 1. What it is

**Crown = per-guild per-artist king**. One active row in `user_crowns` holds the user with highest plays for an artist in that guild. Displayed in `wk` (who knows) embed, in `.fm` footer (optional), and via dedicated `crown` commands. Steal mechanics: overtaking playcount steals the crown, history preserved.

**Invariant (fmbot):** `UNIQUE(guild_id, artist_name) WHERE active=true` — max 1 active crown per artist per guild.

---

## 2. fmbot-dev source of truth

| Layer | File | Role |
|---|---|---|
| **Entity** | `FMBot.Persistence.Domain.Models.UserCrown` + `Guild` fields `CrownsDisabled`, `CrownsMinimumPlaycountThreshold`, `CrownsActivityThresholdDays`, `CrownRoles[]`, `AutomaticCrownSeeder` | DB |
| **SQL** | `FMBot.Persistence.EntityFrameWork/Migrations/*` `user_crowns` `crown_id PK, guild_id FK→guilds, user_id FK→users, artist_name citext, current_playcount int, start_playcount int, created/modified timestamptz, active bool, seeded_crown bool` + index `guild_id+upper(artist_name)` | Storage |
| **Service** | `FMBot.Bot/Services/WhoKnows/CrownService.cs:23` `GetAndUpdateCrownForArtist`, `SeedCrownsForGuild`, `RunAutomaticCrownSeeder`, `GetCrownEligibility`, `HasCrownRole`, `GetCurrentCrownHolder` (Dapper `SELECT * FROM user_crowns WHERE guild_id=@guildId AND active=true AND UPPER(artist_name)=UPPER(@artistName)`) | Heart |
| **Builder** | `FMBot.Bot/Builders/CrownBuilders.cs:30` `CrownAsync`, `CrownOverviewAsync`, `CrownDuelToString`, `CrownToString` | Embeds |
| **Artist wk wiring** | `FMBot.Bot/Builders/ArtistBuilders.cs:51` `CrownService` injected; `WhoKnowsArtistAsync` fetches `WhoKnowsArtistService.GetIndexedUsersForArtist` then `CrownService.GetAndUpdateCrownForArtist(users, guildUsers, guild, artistName)` | Trigger |
| **Commands (text)** | `FMBot.Bot/TextCommands/LastFM/CrownCommands.cs:18` `crown / crowns` ; `Guild/CrownGuildSettingCommands.cs:26` `crownthreshold / crownactivity / crownroles` | UX |
| **Slash** | `FMBot.Bot/SlashCommands/CrownSlashCommands.cs:17` `/crown artist:<autocomplete>` `/crowns` (paginator) | UX |
| **Interactions** | `FMBot.Bot/Interactions/CrownInteractions.cs:18` `crown-overview` select menu | UX |
| **Guild settings** | `FMBot.Bot/Interactions/GuildSettingInteractions.cs:38` `crownRoles` role picker, `crownsDisabled` toggle | Config |
| **Timer** | `FMBot.Bot/Services/TimerService.cs:55` `RunAutomaticCrownSeeder` via `guild.AutomaticCrownSeeder` (daily/weekly/monthly) | Seeder |
| **Model** | `FMBot.Bot/Models/CrownModel.cs:6` `Crown, PreviousCrown, CrownResult, CrownHtmlResult, Stolen, Claimed` + `FMBot.Bot/Models/CrownModels.cs` `CrownSeedDto` | DTO |

---

## 3. Core algorithm — `CrownService.GetAndUpdateCrownForArtist` (`CrownService.cs:31`)

```
Input: users[] (WhoKnowsObjectWithUser sorted desc), guildUsers map, guild, artistName
1. Filter eligibleUsers:
   - if guild.CrownsActivityThresholdDays set → w.LastUsed >= now - days
   - if any guildUsers.BlockedFromCrowns → exclude those userIds
   - if CrownRolesActive(guild) → keep only w where HasCrownRole(crownRoles, guildUsers[w.UserId].Roles)
2. eligibleUserIds = set(eligibleUsers.userId)
3. topUser = users where userId in eligibleUserIds && playcount >= (guild.CrownsMinimumPlaycountThreshold ?? Constants.DefaultPlaysForCrown (=30)) maxBy playcount
4. currentCrownHolder = Dapper GetCurrentCrownHolder(guildId, artistName) // active=true
5. If topUser == null:
     if currentCrownHolder exists && CrownHolderNoLongerAllowed(currentCrownHolder) → deactivate (Active=false, Modified=now)
     return null
6. If currentCrownHolder exists:
   6a. Same user as topUser → if oldPlaycount < topUser.playcount → update CurrentPlaycount, Modified, SeededCrown=false → return CrownModel{Crown}
   6b. Different user → fetch live playcount for crown holder via dataSourceFactory.GetArtistInfoAsync(artistName, crownUser.UserNameLastFM) → currentPlaycountForCrownHolder (via UpdateService.CorrectUserArtistPlaycount)
        - If IssuesAtLastFm → return CrownResult="stealing disabled"
        - If 0 → fallback to topUser.playcount (temp Last.fm 0 bug)
        - If eligible && currentPlaycountForCrownHolder >= topUser.playcount → update currentCrownHolder.CurrentPlaycount, return it (no steal)
        - Else → deactivate old, insert new UserCrown{UserId=topUser, GuildId, ArtistName, Active=true, StartPlaycount=topUser.playcount, CurrentPlaycount=topUser.playcount, SeededCrown=false} → return CrownModel{Crown=newCrown, PreviousCrown=old, Stolen=true, CrownResult="Crown stolen by X with Y plays! Previous owner: Z"}
7. No currentCrownHolder:
   if topUser.playcount >= minPlaycount → insert new active crown → return Claimed=true "Crown claimed by X!"
   else if topUser.playcount >= minPlaycount/3 → return CrownResult="X needs N more plays to claim"
   else return null
```

**Eligibility helpers:**
- `GetCrownEligibility(guild, guildUsers, userId)` → `Crownblocked` if `BlockedFromCrowns`, `MissingCrownRole` if `CrownRolesActive && !HasCrownRole`, else `Eligible` — used in `CrownBuilders.CrownAsync:106` to set footer.
- `HasCrownRole` checks `guildUsers[userId].Roles` intersection with `guild.CrownRoles`.
- `CrownRolesActive = guild.CrownRoles.Length>0 && PremiumServers.ContainsKey(guildId)` — **fmbot gates crown roles behind premium**. tvbot will drop this gate (unlimited policy).
- `DefaultPlaysForCrown = 30` (`Constants`).

**Live vs cached:** Steal path always re-fetches crown holder's live Last.fm playcount via `GetArtistInfoAsync` then `CorrectUserArtistPlaycount` to avoid cached DB drift. fmbot also enqueues `UpdateUser` for both users.

---

## 4. Seeding

- `SeedCrownsForGuild(guild, existingCrowns)` (`CrownService.cs:391`): SQL `SELECT DISTINCT ON(ua.name) ua.user_id, ua.name, ua.playcount FROM user_artists ua JOIN users u JOIN guild_users gu WHERE gu.guild_id=@guildId AND playcount>=@minPlaycount AND NOT blockedFromCrowns ... ORDER BY ua.name, ua.playcount DESC` → DISTINCT top per artist → deletes old `seeded_crown=true` rows → bulk insert via `PostgreSQLCopyHelper` (`current_playcount=start_playcount=playcount, SeededCrown=true`). Respects `AllowedRoles/BlockedRoles/CrownRoles` if premium guild.
- `RunAutomaticCrownSeeder` (`CrownService.cs:509`): For each premium guild with `AutomaticCrownSeeder` (Daily/Weekly/Monthly), if `LastCrownSeed < cutoff`, do `ExecuteUpdate` claim + `SeedCrownsForGuild`. Called via `TimerService`.

**tvbot decision:** Manual seeding only (`/crownseed` admin) + no premium gate. Keep `seeded_crown` flag to distinguish from natural crowns.

---

## 5. Display & wk wiring

**`wk` (WhoKnows) integration:**
- `ArtistBuilders.WhoKnowsArtistAsync` → after `GetIndexedUsersForArtist` + `FilterWhoKnowsObjects`, it calls `CrownService.GetAndUpdateCrownForArtist` if `filteredUsers.Count>=1`. Side-effect: crown may be created/stolen as part of wk execution.
- `ArtistBuilders.ArtistInfoAsync` shows server listeners/playcount, but crown display lives in `CrownBuilders.CrownAsync` and also in `wk` footer? In fmbot `crownModel.CrownResult` is appended to wk? Actually `CrownService.GetAndUpdateCrownForArtist` returns `CrownModel` with `CrownResult` string like `Crown claimed by X!` which `ArtistBuilders` could surface. In tvbot's `whoKnowsService`, we currently do not call crown service — need to wire.

**Crown embed (`CrownBuilders.CrownAsync`):**
- Title: `Crown: {artistName}` (`crown.titleFor`)
- Description via `CrownDuelToString`: `👑 holder 100 plays` + `challenger 90 plays` + verdict (`claimed / stolen / keeps / safe / tied / uncontested`). Handles `opponentIsRunnerUp` and `previousHolderLeft`.
- Fields: `Current holder: **[user](userUrl)** — 100 plays` with `Created → Modified` range (`CrownToString`), plus history `Top 10 inactive crowns` + `First holder`.
- Components: `WhoKnows` button `Artist.WhoKnows:{artistId}`.

**Crown overview (`CrownOverviewAsync`):** Paginator `ComponentPaginator` with `StringMenu` `CrownSelectMenu` (view type: playcount vs created vs stolen) — `Fergun.Interactive`.

---

## 6. Guild settings

- `crownsDisabled bool`
- `crownsMinimumPlaycountThreshold int?` (default 30)
- `crownsActivityThresholdDays int?`
- `crownRoles ulong[]`
- `automaticCrownSeeder enum`

Admin commands: `crownthreshold <n>`, `crownactivity <days>`, `crownroles add/remove`.

---

## 7. tvbot remake plan (unlimited, no premium)

### 7.1 DB (Prisma `schema.prisma`)

```prisma
model Guild {
  guildId                        BigInt  @id
  crownsDisabled                 Boolean @default(false)
  crownsMinimumPlaycountThreshold Int?   @default(30)
  crownsActivityThresholdDays    Int?
  crownRoles                     BigInt[] @default([])
  // automaticCrownSeeder optional — skip for v1
}

model UserCrown {
  crownId          Int      @id @default(autoincrement())
  guildId          BigInt
  userId           Int
  artistName       String   @db.Citext
  currentPlaycount Int
  startPlaycount   Int
  created          DateTime @db.Timestamptz(3)
  modified         DateTime @db.Timestamptz(3)
  active           Boolean  @default(true)
  seededCrown      Boolean  @default(false)
  guild            Guild    @relation(fields: [guildId], references: [guildId], onDelete: Cascade)
  user             User     @relation(fields: [userId], references: [userId], onDelete: Cascade)

  @@unique([guildId, artistName], name: "uq_active_crown", map: "@@unique") // partial index via raw SQL: WHERE active=true
  @@index([guildId, artistName])
  @@index([userId])
}
// Raw SQL for partial unique: CREATE UNIQUE INDEX uq_active_crown ON "user_crowns"(guild_id, UPPER(artist_name)) WHERE active=true;
```

Migration: `prisma migrate dev --name add_crowns`

### 7.2 Repositories

- `ICrownRepository` / `CrownRepository` (Prisma + raw Dapper-style for `UPPER(citext)` queries):
  - `getCurrentCrown(guildId, artistName): Promise<UserCrown|null>` (`SELECT * WHERE guild_id=@ AND active=true AND UPPER(artist_name)=UPPER(@)`)
  - `upsertCrown`, `deactivateCrown`, `getCrownsForArtist(guildId, artistName)`, `getCrownsForUser(guildId, userId, viewType)`, `seedCrowns(guildId, rows)`, `deleteSeeded(guildId)`

### 7.3 Service `src/bot/services/crown/crownService.ts`

Port `CrownService` 1:1 minus premium gates:
- `getAndUpdateCrownForArtist(users, guildUsers, guild, artistName): Promise<CrownModel|null>` (steps §3, with `LastFmRepository.getArtistInfo` + `PlayRepository.correctArtistPlaycount`)
- `getCrownEligibility` / `hasCrownRole` / `crownHolderNoLongerAllowed` pure static
- `seedCrownsForGuild(guild)` — raw SQL `SELECT DISTINCT ON(ua.name) ... FROM user_artists` via `prisma.$queryRaw`
- `getCurrentCrownHolderWithName` for display
- Constants: `DEFAULT_PLAYS_FOR_CROWN = 30` in `domain/constants.ts`

DI: `container.registerInstance(CrownService, new CrownService(prisma, lastFmRepository, playRepository, cache))` in `startup.ts:193` (like `GenreService`).

### 7.4 Builders `src/bot/builders/crownBuilders.ts`

Port `CrownBuilders.CrownAsync` + `CrownOverviewAsync` to discord.js `EmbedBuilder`:
- `buildCrownResponse(guild, artistName, crownModel, currentCrown, history, usersMap)` → title, description via `CrownDuelToString` (i18n ready, but plain string for tvbot), fields `Current holder: **[moha](last.fm/user/Moha504)** — 1902 plays (from 2024-01-01 to 2026-08-29)` + history 10 rows, `WhoKnows` button `wk:{artistId}`.
- `buildCrownListResponse(user, crowns, viewType): Paginator` via `PaginationService` (10 per page, `ComponentPaginator`).

### 7.5 Commands

- `src/bot/textCommands/guild/crownCommands.ts` `crown / crowns` (text aliases `c`, `crown`): `crown` without arg → recent track's artist; with `artist | @user` challenger path (pass challengerSettings).
- `src/bot/slashCommands/crownSlashCommands.ts` `/crown artist:<autocomplete> user:<@>` + `/crowns view:playcount|created|stolen` + `/crownseed` (admin).
- `src/bot/interactions/crownInteractions.ts` `crown-overview` select menu.

### 7.6 wk wiring (critical)

Modify `src/bot/services/whoKnows/whoKnowsArtistService.ts:62` after `addOrReplaceUserToIndexList`:

```ts
let crownModel: CrownModel | null = null;
if (filteredUsers.length >= 1 && guild) {
  crownModel = await crownService.getAndUpdateCrownForArtist(filteredUsers, guildUsers, guild, resolvedName);
}
return { ... , crownModel };
```

Modify `src/bot/slashCommands/whoKnowsSlashCommands.ts:208` and `src/bot/textCommands/guild/whoKnowsCommands.ts:135`:
- After `await whoKnowsArtistService.getFilteredUsersForArtist(...)`, capture `crownModel`.
- Pass `crownModel` into `WhoKnowsBuilders.buildWhoKnowsResponse(context, title, url, imgUrl, filteredUsers, filterStats, alsoPlaying, genres, closeFriends, mode, crownModel?.crownResult)` — add new param `crownLine?: string` appended to footer (or description prefix `👑`).
- In `whoKnowsBuilders.ts:20` `buildWhoKnowsResponse` add `crownResult?: string` to `footerLines` (first line) with `👑` handling, and optionally bold holder in list (already does `**` for requester, now also `👑` for crown holder at rank 1).

**fmbot parity:** Without this wire, `wk` will not steal/claim crowns. The call must be inside wk, not only in `crown` command.

### 7.7 Timer & events

- `TimerService` daily `crownSeeder` optional — skip for private bot; manual `/crownseed` suffices.
- `UserEventHandler` on `guildMemberRemove` → `crownService.removeAllCrownsFromDiscordUser(discordUserId, guildId)` (already in fmbot).

### 7.8 Verification

- `npm run db:generate` + `prisma migrate dev`
- Unit: `CrownService.GetCrownEligibility` (blocked, missing role, eligible) + `GetAndUpdateCrownForArtist` steal/claim/0-playcount temp fix.
- Manual: In test guild with 3 users, `wk jnhygs` with plays 1902/137/5 → embed footer shows crown line, `crown jnhygs` shows duel, `crown jnhygs @Imam` shows challenger view, steal by overtaking playcount → `Crown stolen` message.

---

## 8. Unlimited policy deltas vs fmbot

- Drop `CrownRolesActive` premium check (`PublicProperties.PremiumServers`).
- No `IsSupporter` gate in seeding.
- Keep `seeded_crown` flag but allow unlimited `user_crowns` rows.
- No `IssuesAtLastFm` steal disable — keep but make it a soft warn.

---

## 9. File checklist for copy

- `src/persistence/prisma/schema.prisma` (add models)
- `src/bot/services/crown/crownService.ts` (new, 500+ lines port)
- `src/bot/builders/crownBuilders.ts` (new)
- `src/bot/textCommands/guild/crownCommands.ts` (new)
- `src/bot/slashCommands/crownSlashCommands.ts` (new)
- `src/bot/interactions/crownInteractions.ts` (new)
- Patch `src/bot/services/whoKnows/whoKnowsArtistService.ts`, `src/bot/builders/whoKnowsBuilders.ts`, `src/bot/slashCommands/whoKnowsSlashCommands.ts`, `src/bot/textCommands/guild/whoKnowsCommands.ts`, `src/bot/startup.ts` (DI).

