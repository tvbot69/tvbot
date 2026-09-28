/**
 * Gate: the database this history produces must be the database schema.prisma
 * describes. Fail if they have drifted apart.
 *
 * WHY THIS EXISTS
 *
 * The Prisma client is generated FROM schema.prisma, so it is always perfectly
 * in agreement with the schema - and the schema is not evidence about the
 * database. A column can be declared in schema.prisma and created by no
 * migration anywhere in this directory, and everything still looks correct:
 *
 *   - `prisma generate` succeeds, because it only reads the schema.
 *   - `tsc` succeeds.
 *   - `npm test` succeeds, because every test mocks the database.
 *   - `prisma migrate deploy` succeeds, because each migration is valid on its
 *     own terms; nothing checks that the SUM of them is the schema.
 *
 * The client then emits SQL for a column that has never existed, and the first
 * real query dies at runtime:
 *
 *   P2022 The column 'artists.country_code' does not exist in the current database
 *
 * which is exactly what happened. Twenty such columns existed. It was found
 * only when the real-Postgres suite ran in CI for the first time, i.e. it was
 * found by luck. This script is the part that was missing.
 *
 * WHAT IT COMPARES, AND HOW
 *
 * Prisma can answer this precisely, in two shapes:
 *
 *   npx prisma migrate diff --from-empty \
 *       --to-schema-datamodel <schema> --script
 *
 * Emits the full DDL the schema implies. No database needed. It is the source
 * of the twenty-column list above. On its own it only describes ONE side, so it
 * is paired with a reconstruction of the other side (see below).
 *
 *   npx prisma migrate diff --from-migrations <dir> \
 *       --to-schema-datamodel <schema> --shadow-database-url <url> --script
 *
 * Replays the migrations folder into a shadow database and diffs the result
 * against the schema. Strictly better: it is an executed comparison rather than
 * a text one, and it therefore also catches index, unique-constraint, foreign
 * key, enum, type and nullability drift, which the `--from-empty` form cannot
 * see. It needs a throwaway database. When one is unavailable, this script
 * falls back rather than crashing - see FALLBACK below.
 *
 *   npx prisma migrate diff --from-url <url> \
 *       --to-schema-datamodel <schema> --script
 *
 * The same strict comparison against an already-migrated database, with no
 * shadow database. Used when SHADOW_DATABASE_URL is unset but DATABASE_URL
 * points at a database that has already had `migrate deploy` run on it, which
 * is precisely the state of the CI migrations job. Strictly weaker than the
 * shadow form in one respect only: it trusts that the database really is at the
 * migration head rather than proving it by replay.
 *
 * FALLBACK: WHY IT DEGRADES INSTEAD OF CRASHING
 *
 * The weak mode has no database, so it compares the schema's implied DDL
 * against a reconstruction of what the migration files actually create: the
 * column list of every CREATE TABLE, plus every ALTER TABLE ... ADD/DROP
 * COLUMN, plus every index name. That reconstruction is textual and therefore
 * approximate - it cannot see a column created by a DO block or a constraint
 * whose referential action differs.
 *
 * It is still the right thing to do rather than exiting with a stack trace,
 * for a reason that is about humans rather than about coverage: a check that
 * only runs when a Postgres happens to be running is a check that contributors
 * learn to skip, and then CI is the only place anyone looks. The weak mode runs
 * everywhere, including a laptop, and it still catches the entire class of bug
 * that actually bit - an object the schema declares and no migration creates.
 * A crash teaches people to bypass the tool; a labelled weaker answer teaches
 * them where the real answer comes from.
 *
 * The corollary, and it is the load-bearing half of the design: the weak mode
 * must NEVER read as a clean bill of health. It prints which of columns,
 * indexes, constraints, types and nullability it did not check, and it says
 * COLUMNS AND INDEXES in its own summary line. A gate that says "clean" when it
 * only half-checked is worse than no gate, because it launders an unchecked
 * claim into a checked one.
 *
 * THE BASELINE, AND WHY A GATE CAN START AMONGST DRIFT
 *
 * Drift is already known and deliberately unfixed: eight indexes the schema
 * declares that no migration creates, plus `guilds.accent_color` in the history
 * but not in the schema, plus six VARCHAR/TEXT width differences. They are
 * recorded at the bottom of
 * migrations/20260928140000_add_schema_drift_columns/migration.sql.
 *
 * A gate that fails on those is a gate that is red the moment it lands, and a
 * red-from-arrival gate is switched off - which leaves the twenty-column class
 * unprotected, which is the entire point. So KNOWN_DRIFT below is a frozen,
 * explicit allowlist: anything in it is reported and does not fail the run,
 * anything outside it fails immediately. That is the same ratchet shape as
 * scripts/check-import-cycles.ts and scripts/count-debt.ts: a recorded number
 * that may only go down, not a suppression flag.
 *
 * Two properties keep that honest:
 *
 *   - The list is frozen data, NOT computed from the migrations at runtime. A
 *     baseline derived from the same source as the check proves nothing, and
 *     would silently widen to cover new drift.
 *   - It matches on a precise fingerprint (kind + table + object name), so it
 *     cannot absorb an unrelated item on the same table.
 *
 * Every entry carries the reason it is tolerated, so nobody has to guess why
 * the file is long. Shrinking it is the intended way to pay the debt down:
 * add the missing migration, delete the line, watch the count fall.
 *
 * EXIT CODES
 *
 *   0  no drift outside KNOWN_DRIFT
 *   1  drift outside KNOWN_DRIFT
 *   2  the check could not run at all (prisma missing, schema unreadable,
 *      diff invocation failed). NOT 0, and never silently 0.
 *
 * Run: npm run db:verify-schema-drift
 *      npm run db:verify-schema-drift -- --suggest-baseline
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = path.join('src', 'persistence', 'prisma', 'schema.prisma');
const MIGRATIONS = path.join('src', 'persistence', 'prisma', 'migrations');

// ---------------------------------------------------------------------------
// KNOWN_DRIFT - frozen, with reasons. See the header for why this exists and
// why it must not be computed at runtime.
//
// Every fingerprint here is independently evidenced in-repo: the eight index
// names are exactly the set produced by resolving Prisma's deterministic
// index naming (<table>_<col>_<col>_idx) against every `CREATE INDEX` in this
// directory, and the remaining items are transcribed from the record at the
// bottom of the fix migration.
// ---------------------------------------------------------------------------
interface KnownEntry {
  readonly fingerprint: string;
  readonly reason: string;
}

const KNOWN_DRIFT: readonly KnownEntry[] = [
  {
    fingerprint: 'index-missing|users.users_last_update_idx',
    reason: 'documented unfixed: query plan cost, not correctness',
  },
  {
    fingerprint: 'index-missing|user_plays.user_plays_user_id_play_source_idx',
    reason: 'documented unfixed: query plan cost, not correctness',
  },
  {
    fingerprint: 'index-missing|user_artists.user_artists_artist_id_idx',
    reason: 'documented unfixed: query plan cost, not correctness',
  },
  {
    fingerprint: 'index-missing|user_artists.user_artists_name_idx',
    reason: 'documented unfixed: query plan cost, not correctness',
  },
  {
    fingerprint: 'index-missing|user_albums.user_albums_album_id_idx',
    reason: 'documented unfixed: query plan cost, not correctness',
  },
  {
    fingerprint: 'index-missing|user_albums.user_albums_name_idx',
    reason: 'documented unfixed: query plan cost, not correctness',
  },
  {
    fingerprint: 'index-missing|user_tracks.user_tracks_track_id_idx',
    reason: 'documented unfixed: query plan cost, not correctness',
  },
  {
    fingerprint: 'index-missing|user_tracks.user_tracks_name_idx',
    reason: 'documented unfixed: query plan cost, not correctness',
  },
  {
    fingerprint: 'column-extra|guilds.accent_color',
    reason: 'reverse drift: created by 20260926105535, absent from the schema, read by nothing',
  },
  // VARCHAR(255)/VARCHAR(750) in the history, TEXT in the schema. Reads and
  // writes both work; widening or narrowing a live column is not a thing to do
  // as a side effect of a P2022 fix.
  { fingerprint: 'column-type|artists.name', reason: 'VARCHAR in history, TEXT in schema (documented)' },
  { fingerprint: 'column-type|albums.name', reason: 'VARCHAR in history, TEXT in schema (documented)' },
  { fingerprint: 'column-type|tracks.name', reason: 'VARCHAR in history, TEXT in schema (documented)' },
  {
    fingerprint: 'column-type|user_plays.artist_name',
    reason: 'VARCHAR in history, TEXT in schema (documented)',
  },
  { fingerprint: 'column-type|user_albums.name', reason: 'VARCHAR in history, TEXT in schema (documented)' },
  { fingerprint: 'column-type|user_tracks.name', reason: 'VARCHAR in history, TEXT in schema (documented)' },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Severity = 'blocking' | 'known';

/**
 * What kind of drift this is. `kind` is the fingerprint prefix, so renaming a
 * kind silently invalidates baseline entries - which is the correct failure,
 * because it makes the gate louder rather than quieter.
 */
type FindingKind =
  | 'table-missing'
  | 'table-extra'
  | 'column-missing'
  | 'column-extra'
  | 'column-type'
  | 'column-nullability'
  | 'column-default'
  | 'index-missing'
  | 'index-extra'
  | 'constraint-missing'
  | 'constraint-extra'
  | 'enum-missing'
  | 'enum-extra'
  | 'other';

interface Finding {
  readonly kind: FindingKind;
  readonly object: string;
  /** Empty when the finding is not table-scoped (an enum, say). */
  readonly table: string;
  readonly detail: string;
  readonly fingerprint: string;
  readonly severity: Severity;
}

const KNOWN_BY_FINGERPRINT = new Map(KNOWN_DRIFT.map((k) => [k.fingerprint, k]));

const finding = (
  kind: FindingKind,
  table: string,
  object: string,
  detail: string,
): Finding => {
  const fingerprint = `${kind}|${table}.${object}`;
  return {
    kind,
    table,
    object,
    detail,
    fingerprint,
    severity: KNOWN_BY_FINGERPRINT.has(fingerprint) ? 'known' : 'blocking',
  };
};

/**
 * What a single ALTER TABLE action does, independent of which side produced it.
 *
 * Shared deliberately. The migrations in this repo are mostly Prisma-generated,
 * and Prisma emits MULTIPLE actions in one statement with only the first one
 * prefixed by ALTER TABLE:
 *
 *   ALTER TABLE "users" ADD COLUMN     "data_source" "data_source" NOT NULL DEFAULT 'LastFm',
 *   ADD COLUMN     "dm_channel_id" BIGINT,
 *   ADD COLUMN     "time_zone" VARCHAR(50);
 *
 * A regex that only looks for `ALTER TABLE ... ADD COLUMN` therefore sees one
 * column out of four, and reports the other three as missing. That bug is in
 * this script's first draft, and it is the exact shape of false positive that
 * gets baselined and then hides the next real one.
 */
interface AlterAction {
  readonly op:
    | 'add-column'
    | 'drop-column'
    | 'alter-column-type'
    | 'alter-column-notnull'
    | 'alter-column-default'
    | 'add-constraint'
    | 'drop-constraint'
    | 'unknown';
  readonly column: string;
  readonly type: string;
  readonly name: string;
}

const UNKNOWN_ACTION: AlterAction = { op: 'unknown', column: '', type: '', name: '' };

const parseAlterAction = (action: string): AlterAction => {
  let m = /^(?:ADD\s+)?COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s*([\s\S]*)$/i.exec(action);
  if (m) {
    const type = (m[2] ?? '')
      .replace(/\s+(?:NOT\s+NULL|NULL|DEFAULT|UNIQUE|PRIMARY\s+KEY|REFERENCES|CHECK|GENERATED).*$/i, '')
      .trim();
    return { op: 'add-column', column: m[1] as string, type, name: m[1] as string };
  }

  m = /^DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/i.exec(action);
  if (m) return { op: 'drop-column', column: m[1] as string, type: '', name: m[1] as string };

  m = /^ALTER\s+COLUMN\s+"([^"]+)"\s+(?:SET\s+DATA\s+)?TYPE\s+([\s\S]+)$/i.exec(action);
  if (m) return { op: 'alter-column-type', column: m[1] as string, type: (m[2] ?? '').trim(), name: m[1] as string };

  m = /^ALTER\s+COLUMN\s+"([^"]+)"\s+(SET|DROP)\s+NOT\s+NULL/i.exec(action);
  if (m) return { op: 'alter-column-notnull', column: m[1] as string, type: m[2] as string, name: m[1] as string };

  m = /^ALTER\s+COLUMN\s+"([^"]+)"\s+(SET|DROP)\s+DEFAULT/i.exec(action);
  if (m) return { op: 'alter-column-default', column: m[1] as string, type: m[2] as string, name: m[1] as string };

  m = /^ADD\s+CONSTRAINT\s+"([^"]+)"/i.exec(action);
  if (m) return { op: 'add-constraint', column: '', type: '', name: m[1] as string };

  m = /^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/i.exec(action);
  if (m) return { op: 'drop-constraint', column: '', type: '', name: m[1] as string };

  return UNKNOWN_ACTION;
};

// ---------------------------------------------------------------------------
// Prisma invocation
// ---------------------------------------------------------------------------

/**
 * `prisma migrate diff` EXITS 0 when it finds a difference. Measured on
 * prisma 6.19.3: a diff that emits `ALTER TABLE "artists" ADD COLUMN
 * "country_code"` returned exit code 0, identical to the empty-diff case. So
 * the exit code is useless here and stdout is the only signal - which is
 * precisely the trap this script exists to avoid, and the reason there is no
 * `if (result.status !== 0) fail()` shortcut anywhere below.
 */
const prismaDiff = (args: readonly string[]): string => {
  const cli = require.resolve('prisma/build/index.js');
  const full = ['migrate', 'diff', ...args, '--script'];
  const result = spawnSync(process.execPath, [cli, ...full], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(
      `could not run prisma: ${result.error.message}. Run \`npm ci\` first.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `prisma migrate diff failed (exit ${result.status})\n` +
        `  args: prisma ${full.join(' ')}\n` +
        `  ${(result.stderr || '').trim()}`,
    );
  }
  return result.stdout ?? '';
};

const stripComments = (sql: string): string =>
  sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');

/**
 * Split on top-level semicolons and commas, respecting (), [], '', "" and $$.
 *
 * Needed because Prisma emits multi-action statements:
 *
 *   ALTER TABLE "artists" DROP COLUMN "driftedColumn",
 *   ADD COLUMN     "country_code" VARCHAR(2),
 *   ADD COLUMN     "last_fm_url" VARCHAR(500);
 *
 * and a naive `split(',')` also cuts `VARCHAR(255)` and `DECIMAL(10,2)`.
 *
 * Dollar-quoted bodies ($$ ... $$) are kept whole. The fix migration is full of
 * `DO $$ BEGIN ... END $$;` blocks whose bodies contain semicolons and their own
 * ALTER TABLE statements; splitting inside them yields fragments that look like
 * real statements and produce phantom findings. Keeping them opaque means this
 * parser UNDERSEES what a DO block creates - which is stated in the mode banner
 * and called out per-finding in the report, and is the right direction to err
 * in: a missed object is visible, a phantom object is baselined and forgotten.
 */
const splitTopLevel = (input: string, separator: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let dollarTag: string | null = null;
  let current = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;

    if (dollarTag) {
      current += input.slice(i, i + dollarTag.length);
      if (input.startsWith(dollarTag, i)) {
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      i += 1;
      continue;
    }

    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(input.slice(i));
      if (tag) {
        dollarTag = tag[0];
        current += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === separator && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) out.push(trimmed);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  const trimmed = current.trim();
  if (trimmed) out.push(trimmed);
  return out;
};

const statements = (sql: string): string[] =>
  splitTopLevel(stripComments(sql).replace(/;\s*$/, ''), ';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** The balanced (...) block that follows `marker`, or null. */
const parenBlock = (sql: string, start: number): { body: string; end: number } | null => {
  const open = sql.indexOf('(', start);
  if (open === -1) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < sql.length; i += 1) {
    const ch = sql[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { body: sql.slice(open + 1, i), end: i };
    }
  }
  return null;
};

/** Prisma always quotes identifiers it emits. */

// ---------------------------------------------------------------------------
// Parsing the STRICT differential (the output of `migrate diff --script`)
// ---------------------------------------------------------------------------

const parseDifferential = (sql: string, schema?: SchemaFacts): Finding[] => {
  const findings: Finding[] = [];

  for (const stmt of statements(sql)) {
    // CREATE TABLE "t" (...)  - the database has no such table at all.
    let m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/i.exec(stmt);
    if (m) {
      findings.push(finding('table-missing', m[1] as string, m[1] as string, 'table does not exist in the migrations'));
      continue;
    }

    m = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/i.exec(stmt);
    if (m) {
      findings.push(finding('table-extra', m[1] as string, m[1] as string, 'table exists in the migrations but not in the schema'));
      continue;
    }

    // CREATE [UNIQUE] INDEX "n" ON "t" (...)
    m = /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s+ON\s+"([^"]+)"/i.exec(
      stmt,
    );
    if (m) {
      findings.push(
        finding(
          'index-missing',
          m[3] as string,
          m[2] as string,
          `${m[1] ? 'unique ' : ''}index declared by the schema, no migration creates it`,
        ),
      );
      continue;
    }

    m = /^DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/i.exec(stmt);
    if (m) {
      const name = m[1] as string;
      // DROP INDEX carries no table name. Resolved against the schema's own
      // `ON "t"` map when possible; left unscoped otherwise rather than guessed
      // at from the index name, because a wrong table in the fingerprint means a
      // baseline entry that silently matches nothing.
      findings.push(
        finding(
          'index-extra',
          schema?.indexTable.get(name) ?? '',
          name,
          'index created by the migrations but not declared by the schema',
        ),
      );
      continue;
    }

    m = /^CREATE\s+TYPE\s+"([^"]+)"\s+AS\s+ENUM/i.exec(stmt);
    if (m) {
      findings.push(finding('enum-missing', '', m[1] as string, 'enum declared by the schema, no migration creates it'));
      continue;
    }

    m = /^DROP\s+TYPE\s+"([^"]+)"/i.exec(stmt);
    if (m) {
      findings.push(finding('enum-extra', '', m[1] as string, 'enum created by the migrations but not declared by the schema'));
      continue;
    }

    // ALTER TYPE "n" ADD VALUE 'x'  - an enum the migrations define is short a
    // value the schema has, which surfaces to the client as an invalid cast.
    m = /^ALTER\s+TYPE\s+"([^"]+)"\s+ADD\s+VALUE/i.exec(stmt);
    if (m) {
      findings.push(
        finding('enum-missing', '', m[1] as string, 'enum in the migrations is missing a value the schema declares'),
      );
      continue;
    }

    // ALTER TABLE "t" <action>, <action>, ...
    m = /^ALTER\s+TABLE\s+(?:ONLY\s+)?"([^"]+)"\s+([\s\S]+)$/i.exec(stmt);
    if (m) {
      const table = m[1] as string;
      for (const action of splitTopLevel(m[2] as string, ',')) {
        findings.push(actionToFinding(table, action));
      }
      continue;
    }

    // Anything not recognised is reported rather than dropped. A silent
    // `continue` here is how a real drift class hides.
    findings.push(finding('other', '', '', `unrecognised differential statement: ${stmt.replace(/\s+/g, ' ').slice(0, 160)}`));
  }

  return findings;
};

/** Turn one ALTER TABLE action from a differential into a Finding. */
const actionToFinding = (table: string, action: string): Finding => {
  const a = parseAlterAction(action);
  switch (a.op) {
    case 'add-column':
      return finding(
        'column-missing',
        table,
        a.column,
        `schema declares ${a.column} ${a.type} - no migration creates it`,
      );
    case 'drop-column':
      return finding('column-extra', table, a.column, 'migrations create it, the schema does not declare it');
    case 'alter-column-type':
      return finding(
        'column-type',
        table,
        a.column,
        `column type differs: the migrations have ${a.type}, the schema declares something else`,
      );
    case 'alter-column-notnull':
      return finding(
        'column-nullability',
        table,
        a.column,
        `nullability differs: the migrations have ${a.type.toUpperCase()} NOT NULL`,
      );
    case 'alter-column-default':
      return finding('column-default', table, a.column, 'column default differs between the migrations and the schema');
    case 'add-constraint':
      return finding('constraint-missing', table, a.name, 'constraint declared by the schema, no migration creates it');
    case 'drop-constraint':
      return finding('constraint-extra', table, a.name, 'constraint created by the migrations, absent from the schema');
    default:
      return finding('other', table, '', `unrecognised ALTER TABLE action: ${action.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
};

// ---------------------------------------------------------------------------
// The DATABASE-FREE half: what the migration files actually create
// ---------------------------------------------------------------------------

interface MigrationFacts {
  /** table -> columns added or created */
  readonly columns: Map<string, Set<string>>;
  /** table -> columns dropped */
  readonly dropped: Map<string, Set<string>>;
  /** every index / unique / primary-key name created anywhere */
  readonly indexes: Set<string>;
  readonly tables: Set<string>;
  /** every column name appearing anywhere, for the DO-block hint below */
  readonly anyMention: Set<string>;
  readonly files: number;
}

/**
 * Reconstruct the migrations side from the migration files' own text.
 *
 * This is the part that runs with no database at all, and the part that catches
 * the bug this script exists for: an object the schema declares and no
 * migration file mentions. It is deliberately conservative - if it cannot see
 * something it does not invent it, because a false report here trains people to
 * ignore the tool.
 */
const readMigrationFacts = (): MigrationFacts => {
  const columns = new Map<string, Set<string>>();
  const dropped = new Map<string, Set<string>>();
  const indexes = new Set<string>();
  const tables = new Set<string>();
  const anyMention = new Set<string>();

  const addColumn = (table: string, column: string): void => {
    const set = columns.get(table) ?? new Set<string>();
    set.add(column);
    columns.set(table, set);
    anyMention.add(column);
  };

  const dirs = fs.existsSync(MIGRATIONS)
    ? fs
        .readdirSync(MIGRATIONS, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];

  const files: string[] = [];
  for (const dir of dirs) {
    const file = path.join(MIGRATIONS, dir, 'migration.sql');
    if (fs.existsSync(file)) files.push(file);
  }

  for (const file of files) {
    const sql = fs.readFileSync(file, 'utf8');

    // Index names, whether created as an index or declared inline on the table.
    // Scanned as raw text rather than per statement because an index created
    // inside a DO block still counts.
    for (const m of sql.matchAll(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi,
    )) {
      indexes.add(m[1] as string);
    }
    for (const m of sql.matchAll(/CONSTRAINT\s+"([^"]+)"\s+(?:PRIMARY\s+KEY|UNIQUE)/gi)) {
      indexes.add(m[1] as string);
    }

    // Drops are scanned as raw text for the same reason, and because a DROP
    // COLUMN may sit inside a DO block where the statement parser cannot see it.
    // The fix migration retires friends.id and friends.scribe_user_id exactly
    // that way, and without this they would both read as reverse drift forever.
    for (const m of sql.matchAll(
      /ALTER\s+TABLE\s+(?:ONLY\s+)?"([^"]+)"\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi,
    )) {
      const set = dropped.get(m[1] as string) ?? new Set<string>();
      set.add(m[2] as string);
      dropped.set(m[1] as string, set);
    }

    // Adds are parsed per statement, because Prisma emits them as multi-action
    // ALTER TABLE where only the first carries the ALTER TABLE prefix:
    //
    //   ALTER TABLE "users" ADD COLUMN "data_source" ...,
    //   ADD COLUMN "dm_channel_id" BIGINT,
    //   ADD COLUMN "time_zone" VARCHAR(50);
    for (const stmt of statements(sql)) {
      // CREATE TABLE "t" ( "col" TYPE, ..., CONSTRAINT ... )
      const create = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s*\(/i.exec(stmt);
      if (create) {
        const table = create[1] as string;
        tables.add(table);
        const block = parenBlock(stmt, create[0].length - 1);
        if (!block) continue;
        for (const line of splitTopLevel(block.body, ',')) {
          const c = /^"([^"]+)"\s+\S/.exec(line);
          if (c) addColumn(table, c[1] as string);
        }
        continue;
      }

      const alter = /^ALTER\s+TABLE\s+(?:ONLY\s+)?"([^"]+)"\s+([\s\S]+)$/i.exec(stmt);
      if (!alter) continue;
      const table = alter[1] as string;
      for (const action of splitTopLevel(alter[2] as string, ',')) {
        const a = parseAlterAction(action);
        if (a.op === 'add-column') addColumn(table, a.column);
        else if (a.op === 'add-constraint') indexes.add(a.name);
      }
    }
  }

  return { columns, dropped, indexes, tables, anyMention, files: files.length };
};

/** Columns and index names the schema's own implied DDL declares. */
interface SchemaFacts {
  readonly columns: Map<string, Set<string>>;
  readonly indexes: Set<string>;
  readonly tables: Set<string>;
  readonly columnCount: number;
  readonly indexCount: number;
  /** index name -> table it belongs to, read from the DDL's own `ON "t"` */
  readonly indexTable: Map<string, string>;
}

const readSchemaFacts = (ddl: string): SchemaFacts => {
  const columns = new Map<string, Set<string>>();
  const indexes = new Set<string>();
  const indexTable = new Map<string, string>();
  const tables = new Set<string>();
  let columnCount = 0;
  let indexCount = 0;

  for (const stmt of statements(ddl)) {
    let m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s*\(/i.exec(stmt);
    if (m) {
      const table = m[1] as string;
      tables.add(table);
      const set = new Set<string>();
      const block = parenBlock(stmt, m[0].length - 1);
      if (block) {
        for (const line of splitTopLevel(block.body, ',')) {
          const c = /^"([^"]+)"\s+\S/.exec(line);
          if (c) {
            set.add(c[1] as string);
            columnCount += 1;
          }
        }
      }
      columns.set(table, set);
      continue;
    }

    m = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"(?:\s+ON\s+"([^"]+)")?/i.exec(stmt);
    if (m) {
      indexes.add(m[1] as string);
      // Captured rather than derived from the name. Prisma's index names embed
      // the table name, so `name.split('_').slice(0, -2)` looks like it works -
      // and returns `user_plays_user_id_play` for `user_plays_..._idx`, because
      // the COLUMN names contain underscores too. Guessing here put the wrong
      // table in a fingerprint, which would make a baseline entry match nothing.
      if (m[2]) indexTable.set(m[1] as string, m[2] as string);
      indexCount += 1;
    }
  }

  return { columns, indexes, indexTable, tables, columnCount, indexCount };
};

/**
 * The database-free reconciliation: schema DDL vs what the migration files say
 * they create. Run in every mode, because it needs nothing and it is the check
 * that catches the twenty-column bug class directly.
 */
const reconcileTextually = (schema: SchemaFacts, migrations: MigrationFacts): Finding[] => {
  const findings: Finding[] = [];

  for (const table of [...schema.columns.keys()].sort()) {
    const want = schema.columns.get(table) as Set<string>;
    const have = migrations.columns.get(table) ?? new Set<string>();

    for (const column of [...want].sort()) {
      if (have.has(column)) continue;
      // Distinguish "no migration mentions this at all" from "a migration
      // mentions it somewhere this parser cannot see, i.e. inside a DO block".
      // The first is real drift and must be written up. The second is a
      // limitation of the weak mode, and saying so is the difference between a
      // finding someone fixes and a finding someone quietly baselines.
      const detail = migrations.anyMention.has(column)
        ? 'no migration creates it as a statement this check can see; the name DOES appear ' +
          'somewhere in the migration files - check whether a DO block adds it'
        : 'schema declares it; no migration file mentions this column at all';
      findings.push(finding('column-missing', table, column, detail));
    }

    const gone = migrations.dropped.get(table) ?? new Set<string>();
    for (const column of [...have].sort()) {
      if (!want.has(column) && !gone.has(column)) {
        findings.push(
          finding('column-extra', table, column, 'a migration creates it; the schema does not declare it'),
        );
      }
    }
  }

  for (const name of [...schema.indexes].sort()) {
    if (migrations.indexes.has(name)) continue;
    const table = schema.indexTable.get(name) ?? '';
    findings.push(
      finding(
        'index-missing',
        table,
        name,
        'schema declares it; no CREATE INDEX or inline CONSTRAINT in any migration file creates it',
      ),
    );
  }

  return findings;
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const LABEL_WIDTH = 18;

const label = (kind: FindingKind): string => kind.replace(/-/g, ' ').padEnd(LABEL_WIDTH);

const describeMode = (mode: 'shadow' | 'live' | 'none'): string => {
  if (mode === 'shadow') {
    return [
      'STRICT - migrations folder vs schema.prisma, executed in a shadow database',
      '        prisma migrate diff --from-migrations <dir> --to-schema-datamodel <schema>',
      '                 --shadow-database-url $SHADOW_DATABASE_URL --script',
      '        checks: tables, columns, column types, nullability, defaults, indexes,',
      '                unique constraints, foreign keys, enums',
    ].join('\n');
  }
  if (mode === 'live') {
    return [
      'STRICT - already-migrated database vs schema.prisma, no shadow database',
      '        prisma migrate diff --from-url $DATABASE_URL --to-schema-datamodel <schema> --script',
      '        checks: tables, columns, column types, nullability, defaults, indexes,',
      '                unique constraints, foreign keys, enums',
      '        weaker than the shadow form in one respect only: it trusts that the',
      '        database is at the migration head rather than proving it by replay.',
    ].join('\n');
  }
  return [
    'DEGRADED - COLUMNS AND INDEXES ONLY. No database was reachable, so this is the',
    '             weak fallback and NOT a full check.',
    '        prisma migrate diff --from-empty --to-schema-datamodel <schema> --script,',
    '                compared against the migration files read as text',
    '        NOT CHECKED: column types, nullability, defaults, foreign keys, enums,',
    '                    and anything a DO block creates rather than a plain statement.',
    '        A clean result here does NOT mean the database matches the schema. It means',
    '        no migration file omits an object the schema declares.',
  ].join('\n');
};

const printFindings = (findings: readonly Finding[]): void => {
  const blocking = findings.filter((f) => f.severity === 'blocking');
  const known = findings.filter((f) => f.severity === 'known');

  if (known.length > 0) {
    console.log(`\nKNOWN BACKLOG - ${known.length} item(s), not failing this run\n`);
    for (const f of known) {
      const reason = KNOWN_BY_FINGERPRINT.get(f.fingerprint)?.reason ?? '';
      console.log(`  ${label(f.kind)} ${f.table}.${f.object}`);
      console.log(`  ${' '.repeat(LABEL_WIDTH)} ${reason}`);
    }
    console.log(
      `\n  Each of these is a documented, deliberate omission. Shrinking KNOWN_DRIFT in\n` +
        `  scripts/verify-schema-drift.ts is how the debt gets paid - add the migration,\n` +
        `  delete the entry, watch the count fall.`,
    );
  }

  if (blocking.length > 0) {
    console.log(`\nBLOCKING DRIFT - ${blocking.length} item(s)\n`);
    for (const f of blocking) {
      console.log(`  ${label(f.kind)} ${f.table ? `${f.table}.` : ''}${f.object}`);
      console.log(`  ${' '.repeat(LABEL_WIDTH)} ${f.detail}`);
    }
    console.log(`\n  Every item above is a table or column the schema declares and no`);
    console.log(`  migration creates, or the reverse. The Prisma client is generated FROM`);
    console.log(`  the schema, so it will emit SQL for it and the query will fail at runtime`);
    console.log(`  with P2022 - long after the build, the unit suite and the typecheck have`);
    console.log(`  all passed green. Write the migration. Do not touch KNOWN_DRIFT.`);
  }

  if (blocking.length === 0 && known.length === 0) {
    console.log('\n  nothing to report');
  }
};

// ---------------------------------------------------------------------------
// Self-test
//
// WHY THIS IS HERE
//
// The strict mode is the mode that runs in CI, and it cannot be run without a
// Postgres. That leaves its PARSER unverifiable by ordinary use, which is not
// acceptable - a parser that silently stops recognising a statement reports
// "clean" forever, and that is the exact failure this script was written to
// stop.
//
// Every fixture below is captured from real `prisma migrate diff --script`
// output on prisma 6.19.3, not written to suit the parser. Two details in the
// first fixture are exactly why that matters:
//
//   - `ADD COLUMN     "country_code"` is Prisma's own output, with five spaces.
//     A hand-written fixture would have one space and a regex tuned to it would
//     then break on the real thing.
//   - Three actions share one ALTER TABLE with only the first carrying the
//     prefix. Reading the migrations with a per-statement regex sees one column
//     out of four, and reports the other three as missing drift - a false
//     positive that gets baselined, which is worse than no check.
//
// Fixtures marked INFERRED were not observable on this machine (no database).
// They are here so that when CI first runs the strict path with a real shadow
// database, a shape nobody has seen produces an `other` finding naming the
// statement rather than vanishing.
//
// Run: npm run db:verify-schema-drift -- --selftest
// ---------------------------------------------------------------------------

const SELFTEST: readonly { name: string; sql: string; expect: readonly string[] }[] = [
  {
    name: 'multi-action ALTER TABLE (verbatim Prisma output)',
    sql: `-- AlterTable
ALTER TABLE "artists" DROP COLUMN "driftedColumn",
ADD COLUMN     "country_code" VARCHAR(2),
ADD COLUMN     "last_fm_url" VARCHAR(500);

-- CreateIndex
CREATE INDEX "users_last_update_idx" ON "users"("last_update");
`,
    expect: [
      'column-extra|artists.driftedColumn',
      'column-missing|artists.country_code',
      'column-missing|artists.last_fm_url',
      'index-missing|users.users_last_update_idx',
    ],
  },
  {
    name: 'unique index created for a @@unique',
    sql: '-- CreateIndex\nCREATE UNIQUE INDEX "artists_name_key" ON "artists"("name");\n',
    expect: ['index-missing|artists.artists_name_key'],
  },
  {
    name: 'empty differential is not a finding',
    sql: '-- This is an empty migration.\n',
    expect: [],
  },
  {
    name: 'INFERRED: drop index',
    sql: '-- DropIndex\nDROP INDEX "users_last_update_idx";\n',
    expect: ['index-extra|.users_last_update_idx'],
  },
  {
    name: 'INFERRED: missing table',
    sql: '-- CreateTable\nCREATE TABLE "widgets" (\n    "id" SERIAL NOT NULL\n);\n',
    expect: ['table-missing|widgets.widgets'],
  },
  {
    name: 'INFERRED: column type change',
    sql: '-- AlterTable\nALTER TABLE "artists" ALTER COLUMN "name" SET DATA TYPE TEXT;\n',
    expect: ['column-type|artists.name'],
  },
  {
    name: 'INFERRED: nullability change',
    sql: '-- AlterTable\nALTER TABLE "artists" ALTER COLUMN "mbid" SET NOT NULL;\n',
    expect: ['column-nullability|artists.mbid'],
  },
  {
    name: 'INFERRED: missing enum',
    sql: '-- CreateEnum\nCREATE TYPE "mood" AS ENUM (\'Ok\');\n',
    expect: ['enum-missing|.mood'],
  },
  {
    name: 'INFERRED: a statement shape nobody has seen is reported, not dropped',
    sql: '-- SomethingNew\nALTER TABLE "artists" CLUSTER ON "name";\n',
    expect: ['other|artists.'],
  },
  {
    name: 'a DO block is opaque, so nothing inside it is invented',
    sql: 'DO $$ BEGIN ALTER TABLE "artists" ADD COLUMN "sneaky" TEXT; END $$;\n',
    expect: ['other|.'],
  },
];

const runSelftest = (): void => {
  console.log('selftest: differential parser\n');
  let failures = 0;
  for (const t of SELFTEST) {
    const got = parseDifferential(t.sql)
      .map((f) => f.fingerprint)
      .sort();
    const want = [...t.expect].sort();
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${t.name}`);
    if (!ok) {
      console.log(`        want: ${JSON.stringify(want)}`);
      console.log(`        got:  ${JSON.stringify(got)}`);
    }
  }
  console.log(`\n${SELFTEST.length - failures}/${SELFTEST.length} passed`);
  if (failures > 0) process.exitCode = 1;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = (): void => {
  if (!fs.existsSync(SCHEMA)) throw new Error(`${SCHEMA} not found - run this from the repo root`);

  if (process.argv.includes('--selftest')) {
    runSelftest();
    return;
  }

  const suggest = process.argv.includes('--suggest-baseline');

  console.log('schema / migration drift gate');
  console.log('='.repeat(72));

  // Step 1: the schema's own implied DDL. Always available, always needed as
  // the "want" side of the database-free comparison.
  const fromEmpty = prismaDiff(['--from-empty', '--to-schema-datamodel', SCHEMA]);
  const schema = readSchemaFacts(fromEmpty);
  console.log(
    `\n  schema.prisma implies ${schema.tables.size} tables, ` +
      `${schema.columnCount} columns, ${schema.indexCount} indexes/keys`,
  );

  // Step 2: the migrations side, read from the migration files.
  const migrations = readMigrationFacts();
  console.log(`  ${migrations.files} migration file(s) read from ${MIGRATIONS}`);
  if (migrations.files === 0) {
    throw new Error(`no migration files under ${MIGRATIONS} - refusing to report a clean database`);
  }

  // Step 3: the strict comparison, when a database can be reached.
  const shadowUrl = process.env.SHADOW_DATABASE_URL?.trim();
  const liveUrl = process.env.DATABASE_URL?.trim();
  let mode: 'shadow' | 'live' | 'none' = 'none';
  const findings: Finding[] = [];

  if (shadowUrl) {
    mode = 'shadow';
    findings.push(
      ...parseDifferential(
        prismaDiff([
          '--from-migrations',
          MIGRATIONS,
          '--to-schema-datamodel',
          SCHEMA,
          '--shadow-database-url',
          shadowUrl,
        ]),
        schema,
      ),
    );
  } else if (liveUrl) {
    mode = 'live';
    findings.push(
      ...parseDifferential(
        prismaDiff(['--from-url', liveUrl, '--to-schema-datamodel', SCHEMA]),
        schema,
      ),
    );
  }

  console.log(`\n  ${describeMode(mode)}\n`);

  // Step 4: the database-free reconciliation, in every mode. Redundant with
  // the strict pass when a database exists, and that is the point: it is the
  // pass that runs everywhere, so the class of bug it catches can never be
  // introduced on a machine without a Postgres and only noticed in production.
  findings.push(...reconcileTextually(schema, migrations));

  const deduped = new Map<string, Finding>();
  for (const f of findings) {
    const existing = deduped.get(f.fingerprint);
    if (!existing) deduped.set(f.fingerprint, f);
  }
  const all = [...deduped.values()].sort((a, b) =>
    a.fingerprint === b.fingerprint ? 0 : a.fingerprint.localeCompare(b.fingerprint),
  );

  printFindings(all);

  const blocking = all.filter((f) => f.severity === 'blocking');
  const known = all.filter((f) => f.severity === 'known');

  if (suggest) {
    console.log('\nsuggested KNOWN_DRIFT entries (paste into scripts/verify-schema-drift.ts):\n');
    for (const f of blocking) {
      console.log(`  {\n    fingerprint: '${f.fingerprint}',\n    reason: 'FILL IN' ,\n  },`);
    }
    if (blocking.length === 0) console.log('  (none - nothing outside the baseline)');
  }

  console.log('\n' + '='.repeat(72));

  if (blocking.length > 0) {
    console.log(
      `FAILED: ${blocking.length} blocking drift item(s), ${known.length} known-baselined, mode ${mode === 'none' ? 'DEGRADED (columns+indexes only)' : 'STRICT'}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `OK: no drift outside the ${known.length} known-baselined item(s). Mode: ${
      mode === 'none' ? 'DEGRADED (columns+indexes only - types, nullability, keys and enums NOT checked)' : 'STRICT'
    }`,
  );
};

try {
  main();
} catch (error: unknown) {
  console.error('\nFAILED: the drift check could not run.');
  console.error(error instanceof Error ? error.message : error);
  console.error(
    '\nThis is deliberately NOT a pass. A check that cannot run must not report\n' +
      'success, so the exit code is 2 rather than 0.',
  );
  process.exitCode = 2;
}
