# src/persistence — operating manual

Prisma repositories, the schema, and the migration history. Read the root `AGENTS.md`
§2 for the gates and §8 for the migration workflow. A-tier §0 and §2.1 are not
repeated here.

## Layout

- `prismaClient.ts` — the singleton. `prisma` is `$extends`-wrapped so **every** model
  operation goes through `withDbRetry` (`:60-68`). `isTransientDbError` (`:5-19`) is the
  allow-list: P1001/P1002/P1017 and four connection messages. Anything else is thrown,
  not retried.
- `prisma/schema.prisma` — the model of record for the **client**, not for the
  database. See "read the live schema" below.
- `prisma/migrations/<timestamp>_<name>/migration.sql` — 19 migrations.
- `repositories/` — 19 repositories. A repository takes `@inject(PrismaClient)` and
  nothing else.
- `domain/models/` — Prisma-adjacent DTOs (`user`, `guild`, `channel`,
  `guildDisabledCommand`). They type every BigInt id as a **string**
  (`domain/models/guild.ts:2`, `channel.ts:2-3`, `user.ts:19`), which is §6 in one
  line.
- The shared db test harness is `src/tests/dbHarness.ts`, not a sibling of the
  repositories, and that placement is load-bearing for the gates: the raw-query ratchet
  skips any path containing `/dbHarness` (its `$executeRawUnsafe` seeds and TRUNCATE are
  test infrastructure, not production queries) and `silent-failure-default` skips
  `/src/tests/` entirely. Move it and both ratchets move under you.

## 1. One statement per `CONCURRENTLY` migration file

**Why:** Prisma decides transaction-wrapping by statement arity. One statement runs
**outside** a transaction so `CREATE INDEX CONCURRENTLY` works. Two statements get
wrapped, and `CONCURRENTLY` then fails with *"cannot run inside a transaction block"*.

The pair that proves it:

- `prisma/migrations/20260928010000_user_plays_dedup_index/migration.sql` — **one**
  statement, `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS` at `:52-59`. The rule is
  written into the file at `:31-36`: *"This file must contain EXACTLY ONE STATEMENT …
  Keep the DELETE in its own migration file."*
- `prisma/migrations/20260928000000_user_plays_dedup_cleanup/migration.sql` — the
  `DELETE`, at `:26-33`, split out **on purpose**. `:21-24` states the arity rule and
  names the sibling file.

**Keep them in two files.** Do not merge them to "tidy up" the history.

Two more constraints in that index file, both load-bearing:

- **Do not cast the `play_source` enum to text** in the index expression. Postgres
  rejects it with SqlState 42P17 because an enum→text conversion goes through
  `enum_out`, which is STABLE (`:3-20`). A `pg_cast` probe returns nothing and proves
  nothing — do not go looking there (`:14-16`).
- **A functional index cannot be expressed in `schema.prisma`.** That file is the
  source of truth for this index. Do not run `prisma migrate dev` expecting parity
  (`:48-50`).

## 2. Never truncate or repoint `DATABASE_URL`

**Why:** `DATABASE_URL` is the production database. A "helpful" edit that appends a
query string or shortens the URL takes the bot's data with it.

**The db suite does not read `DATABASE_URL` at all.** It reads `TEST_DATABASE_URL`
(`src/tests/dbHarness.ts:17-18`), precisely so pointing the real-query suite at
production is not one env var away (`:11-13`). Locally the suite therefore **skips**,
with a stated reason, when `TEST_DATABASE_URL` is absent (`:31-35`) — no Docker, no
local Postgres. CI sets it to a scratch database in a disposable `postgres:16` service.

When it *does* run, it truncates every table it touches
(`dbHarness.ts:143-151`). Three guards stand in front of that, and they are hard
refusals, not warnings:

- The database name must match
  `(^|[_-])(test|tests|ci|scratch|tmp|temp|dev|local)([_-]|$)` (`:29`), else
  `skipReason` returns `'REFUSING to run: database "…" does not look like a scratch
  database'` (`:49-52`).
- An explicit non-`public` `?schema=` is itself an isolation boundary and is accepted
  outright (`:47-48`).
- The guard is tested with no database at all, including a refusal case per non-scratch
  name — a guard that only looks right in the source is not a guard
  (`src/tests/dbHarness.test.ts:24-53`).

**If you seed a table in a db test, add it to `resetTables`** (`:140-141`). A per-file
`deleteMany` is a workaround only the file that remembered it gets; a missing entry
leaked a live `abuse_flags` row forward and cost CI seven failing tests
(`:132-138`).

**Cast your bind parameters.** Prisma sends `$1` as an **untyped** parameter and
Postgres cannot resolve an untyped parameter in an `INSERT VALUES list` — the uncast
form fails with 42804 while the identical query with literals succeeds. That is why
`seedUser` and `seedPlays` spell out `::int4`, `::varchar`, `::int8`, `::timestamptz`
and `::"PlaySource"` (`:78-127`). It is the most common failure in this suite.

## 3. Read the live schema, not the Prisma model

**Why:** the client is generated *from* `schema.prisma`, so it is always in perfect
agreement with it — and the schema is not evidence about the database. A column can be
declared in the schema and created by no migration anywhere, and everything still looks
correct: `prisma generate` succeeds, `tsc` succeeds, `npm test` succeeds (every test
mocks the database), `prisma migrate deploy` succeeds (each migration is valid on its
own terms; nothing checks that the **sum** of them is the schema). The client then emits
SQL for a column that has never existed and the first real query dies with `P2022`.

That is not hypothetical — **twenty** such columns existed, and they were found only
when the real-Postgres suite first ran in CI, i.e. by luck
(`scripts/verify-schema-drift.ts:1-25`).

Run the drift gate when you touch the schema or a migration:

```
npm run db:verify-schema-drift
```

It prefers the executed comparison — replay the migrations folder into a shadow
database and diff the result against the schema, which also catches index, constraint,
foreign-key, enum, type and nullability drift. It falls back to `--from-url` when
`SHADOW_DATABASE_URL` is unset, and degrades to a textual reconstruction rather than
crashing when no database is available (`verify-schema-drift.ts:27-70`). The degradation
is deliberate: a check that only runs when a Postgres happens to be running is a check
contributors learn to skip.

Corollary: a **migration file** can outrank the Prisma model. Trust the SQL, and trust
`migrate diff` over your reading of the schema.

## 4. A repository method is a claim about the SCHEMA

**Why:** a `$queryRaw` string is not typechecked. Prisma hands it to Postgres as
written, and the error arrives at runtime, in production, as a plausible wrong number.

`albumService.getUserAllTimeTopAlbumsByReleasePrefix` selected columns that do not
exist — `user_albums` has no `artist_name` (the name lives on `artists`, reachable only
through `albums.artist_id`), `albums` has no `type` (it is `spotify_album_type`), and
`$2` arrives as bigint so `left(text, bigint)` does not exist (42703 / 42883). **Its
catch returned the UNFILTERED all-time list**, so a query that threw on every single
call produced a confident embed with a decade filter that had done nothing. The method
is now wrapped in `orDatabaseUnavailable(...)` and raises
(`src/bot/services/albumService.ts:763-813`; the history is in the comment at
`:768-779`).

**Say this plainly: a `catch` that turns a failed read into `[]`, `null` or `0` is a
machine for a confident wrong answer.** The user cannot tell which they were given, and
that is what A1 (`AGENTS.md` §0) exists to stop. The sibling defect makes the point
twice as hard: `getAverageTrackAudioFeaturesForTopTracks` selected five columns that no
migration creates, behind a `.catch(() => [])`, and so returned **all zeros** for the
life of the feature — total failure rendering as success, with a green suite approving
of it (`scripts/count-debt.ts:409-419`).

Raise `SourceUnavailableError` (`src/domain/models/sourceUnavailableError.ts:21-33`) —
or, on a path where raising is wrong, log at WARN with a message that names the shape.
`albumService.filterAlbumsToReleasePeriod` (`:835-847`) is the worked counter-example: it
still returns the input **unfiltered**, keeps the WARN, and is only acceptable because it
has zero production callers.

Read `src/persistence/repositories/crownRepository.reads.test.ts:23-38` before you add
a read here. It states the property outright — *"A FAILED READ IS NOT AN EMPTY READ"* —
and its closing block fails the suite if a `catch { return [] }` appears. That is the
shape to copy: **test both directions.** A genuine empty result IS empty, and a database
failure is NOT.

## 5. Every `$queryRaw` needs a `*.db.test.ts` that parses

The `raw-query-without-db-test` ratchet is at **0** (`scripts/debt-budget.json:9`), and
`scripts/raw-query-baseline.json` is the list that keeps it there: a per-file **allowance**
of raw-query count, for the 19 files that already have a matching `*.db.test.ts`.

The rule is **overflow, not presence**, and the arithmetic is three lines
(`scripts/count-debt.ts:399-404`):

```
allowed = hasDbTest(basename) ? (baseline[rel] ?? 0) : 0
over    = count - allowed
```

The first version of this check asked only "does this file have a test", and a
brand-new untested query added to an already-covered file still reported 0 — which is
precisely how coverage regresses, and the check was decoration. Because the allowance is
only consulted **when** the test exists, a file with no test contributes its **full**
query count, so deleting a `*.db.test.ts` is caught immediately.

Sharp edge: `hasDbTest` matches on **basename anywhere under `src`**, not on the
sibling path. 18 of the 19 baseline entries have a real sibling
`*.db.test.ts`; the nineteenth, `persistence/prismaClient.ts`, is satisfied by
`prisma/prismaClient.db.test.ts` in a different directory. Two same-named modules in
different directories would satisfy each other.

So: **raise the allowance deliberately when you add a query, in the same commit, with
the test that justifies it.** Never just bump it to make the gate green.

Two detector traps, both fixed, both worth remembering. A bare `p.$queryRaw\`…\`` is a
`CallExpression`, but `p.$queryRaw<T>\`…\`` — a tagged template carrying a type
argument, which is how almost every call in this repo is written — is a
`TaggedTemplateExpression`, and `isCallExpression` is false for it. The first version
checked only `CallExpression` and reported **zero** raw queries in a file holding five.
A ratchet that reports zero is worse than no ratchet.

`vitest.db.config.ts` splits these out into their own config: they open a socket, and
everything else in the repo mocks the database — which is why 28 `$queryRawUnsafe` calls
once sat there unexecuted. Run them with `npm run test:db`. They are serial
(`fileParallelism: false`) because they share one schema.

## 6. BigInt is not decoration, and the guards are not optional

`BigInt` columns in the schema: `users.discordUserId` and `.dmChannelId`;
`user_fm_settings.footerOptions` / `.buttons`; `guild.guild_id`; `channel.channel_id`
and `.guild_id`; `guild_disabled_command.guild_id`; the Deezer id columns on `artists`
and `albums`; `user_plays.user_play_id`; `guild_user.guild_id`; `user_crowns.guild_id`;
`guild_music_settings.guild_id`; `bot_scrobble_opt_in.discord_user_id`; and
`guild_autopost.guild_id` / `.channel_id` (`schema.prisma:35, 44, 72, 73, 84, 108, 109,
121, 143, 179, 211, 287, 323, 343, 356, 373, 374`).

Every guild id and Discord id arrives from the interaction layer as a **string**, and
`BigInt('abc')` **throws** `SyntaxError`. So:

- **Guard every external id before it reaches a query.** `crownRepository.safeBigInt`
  (`repositories/crownRepository.ts:18-33`) validates with `/^\d+$/` and returns `null`,
  and its callers return an empty answer. `guildRepository` has the same guard as a
  module-level `toGuildId` (`repositories/guildRepository.ts:11-24`), and both files
  contain exactly ONE `BigInt()` call — inside the guard — so a new writer has no
  second conversion to reach for by accident. `albumService.parseDiscordUserId`
  (`src/bot/services/albumService.ts:73-80`) is the same shape and says why in the
  comment: a malformed id is a **caller** bug, and laundering it into "database
  unavailable" sends the operator to look at Postgres instead of at the caller. Same
  reasoning as `parseGuildId` in `genreService` / `musicIntelligenceService` and
  `toGuildId` in `countryService`.
- **A method with an empty answer returns it; a method that must produce a row
  raises.** That is the whole rule for a malformed id, and it is why `killCrown`,
  `removeUserCrowns` and `setCrownBlock` answer `false` / `0` / do-nothing while
  `createCrown` and `replaceCrown` raise a `TypeError` that names the ARGUMENT.
  `replaceCrown` must not answer `null`: that value already means "a concurrent
  steal got there first", and reusing it for a bad argument would send the caller
  round the re-read loop for a crown that was never written
  (`crownRepository.reads.test.ts:940-1023`).
- **A raw bigint column is not a JS number.** Raw queries cast explicitly —
  `c.guild_id::text as "guildId"` and `u.discord_user_id::text as "discordUserId"`
  (`crownRepository.ts:33, 43, 197, 207, 232, 263, 273, 409`) — and every `map` then
  runs `Number(...)` on the value (`whoKnowsRepository.ts:36`, `trackService.ts:370,
  403, 517`). Drop the `Number()` and a leaderboard entry becomes the string `"200"`
  and is compared and sorted as text.

Which runtime type a raw bigint actually arrives as is not something a mock can pin:
Prisma `$queryRaw` yields a JS `BigInt`, while one scoped-reads fixture builds a
`string` on the node-postgres rule (`whoKnowsRepository.scopedReads.test.ts:24-29`) and
another declares the type `bigint` (`whoKnowsRepository.db.test.ts:632`). Keep the
`Number()` — the real-DB suite asserts the *outcome*, `typeof playcount === 'number'`
(`trackService.db.test.ts:200-206`), which is the assertion that survives either.

## 7. Two named error classes you will meet

- **Prisma codes.** `P2022` — a column that does not exist (§3). `P2025` — an
  `update` against a missing primary key; swallowing it tells the caller the crown is
  deactivated when it never was (`crownRepository.reads.test.ts:893-898`).
- **`SourceUnavailableError`** (`src/domain/models/sourceUnavailableError.ts`) and its
  subclass `LastFmUnavailableError`. Distinguish with `isSourceUnavailable`, which
  matches on `err.name` rather than `instanceof` **on purpose**: the same class is loaded
  through several module specifiers here, and an `instanceof` against one copy silently
  misses the others — which is how a "handled" failure becomes a silent one again
  (`:35-45`).

## 8. Probes, not memory

A test double is a claim about Postgres and nothing checks the claim. When a number
looks wrong or a query behaves oddly, **probe the real database** rather than reasoning
from memory — the scripts in `scripts/` exist for exactly this, and the history in
their headers is a list of things that were wrong before. The offline ones:
`verify-schema-drift.ts`, `replay-migrations-fresh.ts`, `check-user-plays-index.ts`,
`verify-dedup-constraint.ts`, `verify-dedup-index-expr.ts`, `count-duplicate-plays.ts`.
`build-missing-tables-migration.ts` and `verify-missing-tables-migration.ts` document
that this history was once produced by `db push`, not by migrations.

Never print a connection string, and never let a probe touch `DATABASE_URL`. This is a
public repository — no hostnames, no ports, no machine paths, in code, comments, docs or
stray logs (root `AGENTS.md`, header).
