-- Repairs schema/migration drift: 20 columns that schema.prisma declares and
-- that no migration in this history ever created.
--
-- The evidence is not theoretical. A database built purely from these
-- migrations is missing all twenty, and the first unqualified read of artists
-- fails with
--
--   P2022 The column 'artists.country_code' does not exist in the current database
--
-- which takes out artist.create() and every artist.findMany() along with it.
-- The column list and every type below are Prisma's own implied DDL rather
-- than hand-written:
--
--   npx prisma migrate diff --from-empty \
--     --to-schema-datamodel src/persistence/prisma/schema.prisma --script
--
-- diffed against every file in this directory. A wrong type here is silent
-- data corruption later rather than a loud failure now, so nothing here is
-- approximated.
--
--
-- WHY EVERY STATEMENT IS IF NOT EXISTS / IF EXISTS, WITHOUT EXCEPTION
--
-- Production was created during the `prisma db push` era, so the live database
-- may already have some or all of these columns, and a restore or a rebuild
-- may have the rest. A plain ADD COLUMN would abort `migrate deploy` with
-- 42701 "column that already exists", and per AGENTS.md 10 a failed migration
-- is not a degraded bot, it is a dead one: `npm start` runs
--
--   migrate deploy && node dist/bot/index.js
--
-- so P3009 exits the process before Discord ever connects. The bot going down
-- is a worse outcome than the bug this migration fixes, so the guiding rule
-- here is that this file must be a no-op anywhere the target state already
-- exists, and must never fail because of a surprise. Where Postgres has no
-- IF NOT EXISTS of its own - ADD CONSTRAINT has none - the existence check is
-- done in a DO block instead of being skipped.
--
-- The tables below are all guaranteed to exist by earlier migrations in this
-- history, so they are referenced directly. The seven columns section 2 adds
-- are guaranteed to exist by their own ADD COLUMN IF NOT EXISTS immediately
-- above them, and only columns that pre-date this migration are probed.


-- ---------------------------------------------------------------------------
-- 1. The thirteen straightforward columns.
--
-- Every one of these is either nullable or carries a DEFAULT, and that is
-- exactly what makes ADD COLUMN safe against a table that already has rows:
-- Postgres fills the existing rows from the default instead of rejecting the
-- statement for want of a value. (The NOT NULL ones all have defaults. A bare
-- NOT NULL with no default would fail here, which is the whole reason
-- friends.user_id is handled differently in section 2.)
-- ---------------------------------------------------------------------------

ALTER TABLE "artists" ADD COLUMN IF NOT EXISTS "country_code" VARCHAR(2);

ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "fm_embed_type" INTEGER;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mode" INTEGER;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "who_knows_mode" INTEGER;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "cover_type" INTEGER;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_scrobble_update" TIMESTAMPTZ(6);

ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "fm_embed_type" INTEGER;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "crowns_disabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "crowns_minimum_playcount_threshold" INTEGER DEFAULT 30;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "crowns_activity_threshold_days" INTEGER;

-- crown_roles defaults to an empty array, matching the schema's @default([]).
--
-- No index is created on this column, deliberately. The `::BIGINT[]` cast in
-- the DEFAULT is fine where it stands, because a column default is never
-- evaluated inside an index. The same cast inside an index *expression* is
-- rejected with 42P17 "functions in index expression must be marked
-- IMMUTABLE", which is the failure that bricked this bot once already
-- (AGENTS.md 10). If this column is ever indexed, index it directly:
-- CREATE INDEX ... ON "guilds"("crown_roles") - never coalesce(col::text, '').
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "crown_roles" BIGINT[] DEFAULT ARRAY[]::BIGINT[];

ALTER TABLE "guild_users" ADD COLUMN IF NOT EXISTS "blocked_from_crowns" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "guild_users" ADD COLUMN IF NOT EXISTS "self_block_from_who_knows" BOOLEAN NOT NULL DEFAULT false;


-- ---------------------------------------------------------------------------
-- 2. friends. This one table is not a plain "add a column" job.
--
-- What the history created in 20260825191327, and nothing has touched it since:
--
--   id              SERIAL  NOT NULL    <- primary key
--   scribe_user_id  INTEGER NOT NULL    <- the owner of the friend list
--   friend_user_id  INTEGER NOT NULL
--
-- What the schema declares:
--
--   friend_id         SERIAL NOT NULL                 <- primary key
--   user_id           INTEGER NOT NULL                 <- the owner, renamed
--   last_fm_user_name VARCHAR(255) NOT NULL
--   friend_user_id    INTEGER                          <- now nullable
--   last_fm_friend    BOOLEAN NOT NULL DEFAULT false
--   friend_type       INTEGER NOT NULL DEFAULT 1
--   created           TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP
--   modified          TIMESTAMPTZ(6)
--
-- Three consequences, in the order they would bite:
--
--   a) ADD COLUMN "user_id" INTEGER NOT NULL would FAIL on a friends table
--      that has rows, because NOT NULL with no default leaves every existing
--      row with nothing to satisfy it. So the column is added nullable,
--      backfilled, and only then tightened.
--
--   b) friend_id carries a SERIAL, which is a type *and* a nextval default.
--      The default is what lets the ADD succeed against existing rows; the
--      sequence it creates is what lets insert work afterwards. Both matter.
--
--   c) scribe_user_id is NOT NULL with no default, and Prisma never sends it
--      - the column is not in the schema, so it is not in any INSERT. Every
--      friends insert would fail with 23502 even once the new columns exist.
--      It cannot simply be left nullable either, because then the table has
--      two columns claiming to be the owner and nothing says which is real.
--      It is copied into user_id and then retired.
-- ---------------------------------------------------------------------------

-- Added nullable first, per (a). friend_id is the exception: SERIAL supplies
-- the nextval default that makes ADD COLUMN legal against a populated table,
-- and the NOT NULL is the one the implied DDL declares - the same
-- `"crown_id" SERIAL NOT NULL` form 20260825191327 already uses, which is
-- proof the parser accepts it. The guarded pass below then re-asserts it for
-- the case where the column already existed without it.
ALTER TABLE "friends" ADD COLUMN IF NOT EXISTS "friend_id" SERIAL NOT NULL;

-- user_id and last_fm_user_name are deliberately NOT NULL-less here. They are
-- declared NOT NULL with no default, and Postgres cannot satisfy that for rows
-- that already exist, so the constraint is applied after the backfill instead.
ALTER TABLE "friends" ADD COLUMN IF NOT EXISTS "user_id" INTEGER;
ALTER TABLE "friends" ADD COLUMN IF NOT EXISTS "last_fm_user_name" VARCHAR(255);
ALTER TABLE "friends" ADD COLUMN IF NOT EXISTS "last_fm_friend" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "friends" ADD COLUMN IF NOT EXISTS "friend_type" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "friends" ADD COLUMN IF NOT EXISTS "created" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "friends" ADD COLUMN IF NOT EXISTS "modified" TIMESTAMPTZ(6);

-- Backfill before anything is retired, so no data is dropped on the floor.
--
-- The two reads below are guarded because "id" and "scribe_user_id" only exist
-- on a database built from this migration history. On one built from the
-- schema they are already gone, and naming them unguarded would be a 42703
-- "column does not exist" that fails the deploy.
DO $$
BEGIN
    -- friend_id is the same surrogate key that id was, so reuse the value
    -- rather than letting the sequence hand out a fresh ordering. Any friend
    -- id already persisted in a Discord customId keeps pointing at the same
    -- friend, which a renumbering would silently break.
    IF EXISTS (SELECT 1 FROM pg_attribute
                WHERE attrelid = to_regclass('friends')
                  AND attname = 'id' AND attisdropped = false) THEN
        UPDATE "friends" SET "friend_id" = "id" WHERE "friend_id" IS DISTINCT FROM "id";
    END IF;

    -- user_id is the renamed scribe_user_id: the owner of the list. This is a
    -- copy of the only meaningful value the old column held.
    IF EXISTS (SELECT 1 FROM pg_attribute
                WHERE attrelid = to_regclass('friends')
                  AND attname = 'scribe_user_id' AND attisdropped = false) THEN
        UPDATE "friends" SET "user_id" = "scribe_user_id" WHERE "user_id" IS NULL;
    END IF;

    -- last_fm_user_name is the tracked friend's Last.fm username, which the old
    -- shape stored nowhere. Where friend_user_id points at a registered user,
    -- that user's own user_name_last_fm is the same string, so this is a real
    -- backfill rather than an invented placeholder. It cannot collide: the old
    -- UNIQUE (scribe_user_id, friend_user_id) made the pairs distinct, and
    -- users.user_name_last_fm is UNIQUE (20260825191327), so two distinct
    -- friends cannot derive the same name.
    --
    -- Rows with no registered friend keep NULL and are reported by the next
    -- block rather than filled in with a guess.
    UPDATE "friends" f
       SET "last_fm_user_name" = u."user_name_last_fm"
      FROM "users" u
     WHERE u."user_id" = f."friend_user_id"
       AND f."last_fm_user_name" IS NULL;
END $$;

-- Point the sequence past every value now sitting in the column.
--
-- ADD COLUMN ... SERIAL evaluates nextval once per existing row, so the
-- sequence ought to be ahead of them already, but that behaviour is not worth
-- betting a primary key on: if it were left at 1, the first insert after this
-- migration would collide with a row that already holds friend_id 1. Guarded
-- on the sequence existing, because a database that already had friend_id may
-- have no sequence attached to it.
DO $$
BEGIN
    IF pg_get_serial_sequence('friends', 'friend_id') IS NOT NULL THEN
        PERFORM setval(
            pg_get_serial_sequence('friends', 'friend_id'),
            COALESCE((SELECT MAX("friend_id") FROM "friends"), 0) + 1,
            false
        );
    END IF;
END $$;

-- Tighten to the schema's declared NOT NULL, one column at a time, and only
-- where the data allows it. This is the step ADD COLUMN could not do.
--
-- A column that still holds NULL is left nullable and reported, because
-- inventing a value for it - an empty string, a placeholder - would be worse
-- than the drift it fixes: it would be wrong data that reads as real. The
-- notice lands in the deploy log rather than failing the deploy.
DO $$
DECLARE
    v_nulls bigint;
BEGIN
    SELECT count(*) INTO v_nulls FROM "friends" WHERE "friend_id" IS NULL;
    IF v_nulls = 0 THEN
        ALTER TABLE "friends" ALTER COLUMN "friend_id" SET NOT NULL;
    ELSE
        RAISE NOTICE 'friends.friend_id still has % NULL row(s); left nullable', v_nulls;
    END IF;

    SELECT count(*) INTO v_nulls FROM "friends" WHERE "user_id" IS NULL;
    IF v_nulls = 0 THEN
        ALTER TABLE "friends" ALTER COLUMN "user_id" SET NOT NULL;
    ELSE
        RAISE NOTICE 'friends.user_id still has % NULL row(s); left nullable', v_nulls;
    END IF;

    SELECT count(*) INTO v_nulls FROM "friends" WHERE "last_fm_user_name" IS NULL;
    IF v_nulls = 0 THEN
        ALTER TABLE "friends" ALTER COLUMN "last_fm_user_name" SET NOT NULL;
    ELSE
        RAISE NOTICE 'friends.last_fm_user_name still has % NULL row(s); left nullable', v_nulls;
    END IF;
END $$;

-- Move the primary key from the retired id column onto friend_id. This is the
-- part that needs care.
--
-- friends_pkey currently sits on id, and a table cannot have two primary
-- keys, so the old constraint has to be dropped before the new one is added.
-- Nothing depends on it: friends references users and is referenced by nothing
-- (there is no REFERENCES "friends" anywhere in this history), so dropping the
-- constraint orphans no foreign key and no cascade.
--
-- Guarded twice. If any friend_id is still NULL, ADD PRIMARY KEY would fail
-- with 23502, so the swap is skipped. And if the constraint is already a
-- single-column primary key on friend_id - the case on any database that
-- already has the new shape - the whole block is skipped: re-adding a
-- constraint that is already correct is not an error, but it is a needless
-- full index rebuild under an ACCESS EXCLUSIVE lock, and this migration has to
-- be a no-op wherever it can be.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "friends" WHERE "friend_id" IS NULL) THEN
        RAISE NOTICE 'friends.friend_id has NULL row(s); friends_pkey left where it is';
    ELSIF NOT EXISTS (
        SELECT 1
          FROM pg_constraint c
          JOIN pg_attribute a
            ON a.attrelid = c.conrelid
           AND a.attnum = ANY (c.conkey)
         WHERE c.conrelid = to_regclass('friends')
           AND c.contype = 'p'
           AND a.attname = 'friend_id'
           AND array_length(c.conkey, 1) = 1
    ) THEN
        ALTER TABLE "friends" DROP CONSTRAINT IF EXISTS "friends_pkey";
        ALTER TABLE "friends" ADD CONSTRAINT "friends_pkey" PRIMARY KEY ("friend_id");
    END IF;
END $$;

-- Retire the two legacy columns. Both are fully represented by now:
-- id -> friend_id and scribe_user_id -> user_id, each copied above.
--
-- Nothing reads either column: scribe_user_id appears nowhere outside the
-- migration that created it, and no column in the schema or the application
-- refers to friends.id. No view in this repository depends on friends.
--
-- Dropping scribe_user_id also drops what the old migration hung off it -
-- friends_scribe_user_id_fkey and friends_scribe_user_id_friend_user_id_key -
-- because Postgres removes the indexes and constraints that involve a dropped
-- column on its own. That retires the old unique index, which is correct: the
-- schema's uniqueness rule is (user_id, last_fm_user_name), not
-- (scribe_user_id, friend_user_id).
ALTER TABLE "friends" DROP COLUMN IF EXISTS "scribe_user_id";

-- "id" needs a guard that the others do not. If the primary key swap above was
-- skipped - which happens when friend_id still holds a NULL - then friends_pkey
-- is still sitting on "id", and a bare DROP COLUMN would fail with 2BP01
-- "cannot drop column id because other objects depend on it". That is exactly
-- the kind of failure that turns a bug fix into an outage, so the drop is
-- conditional on the key having actually moved. A leftover id column is inert:
-- nothing in the schema selects it and no constraint would reference it.
DO $$
BEGIN
    IF EXISTS (SELECT 1
                 FROM pg_constraint c
                 JOIN pg_attribute a
                   ON a.attrelid = c.conrelid
                  AND a.attnum = ANY (c.conkey)
                WHERE c.conrelid = to_regclass('friends')
                  AND a.attname = 'id'
                  AND c.contype = 'p') THEN
        RAISE NOTICE 'friends.id still carries the primary key; left in place';
    ELSE
        ALTER TABLE "friends" DROP COLUMN IF EXISTS "id";
    END IF;
END $$;

-- friend_user_id is Int? in the schema: a tracked friend need not be a
-- registered user, and addFriend() passes null for one. The column created in
-- 20260825191327 is NOT NULL, so that insert fails with 23502 today. Guarded
-- because this is the only statement above that would hard-fail on an
-- unexpected column set rather than merely do nothing.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_attribute
                WHERE attrelid = to_regclass('friends')
                  AND attname = 'friend_user_id' AND attisdropped = false) THEN
        ALTER TABLE "friends" ALTER COLUMN "friend_user_id" DROP NOT NULL;
    END IF;
END $$;

-- Foreign keys, to the exact rules the schema declares.
--
-- ADD CONSTRAINT has no IF NOT EXISTS in Postgres, so both are guarded by
-- name in a DO block rather than skipped: on a database that already has the
-- new shape these constraints exist under these names, and a bare ADD would
-- be a 42710 "already exists" that fails the deploy.
--
-- The friend_user_id key is *replaced* rather than merely added, because the
-- history created it ON DELETE RESTRICT and the schema wants ON DELETE SET
-- NULL. Left as RESTRICT, prisma.user.delete() fails for anyone who has been
-- friended by the user being deleted, which is the reverse of what the schema
-- promises. confdeltype 'n' is SET NULL, so the replace is skipped when the
-- rule is already right.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = to_regclass('friends')
                      AND conname = 'friends_user_id_fkey') THEN
        ALTER TABLE "friends"
            ADD CONSTRAINT "friends_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("user_id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = to_regclass('friends')
                  AND conname = 'friends_friend_user_id_fkey'
                  AND confdeltype IN ('a', 'r')) THEN
        ALTER TABLE "friends" DROP CONSTRAINT "friends_friend_user_id_fkey";
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = to_regclass('friends')
                      AND conname = 'friends_friend_user_id_fkey') THEN
        ALTER TABLE "friends"
            ADD CONSTRAINT "friends_friend_user_id_fkey"
            FOREIGN KEY ("friend_user_id") REFERENCES "users"("user_id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- Indexes. The unique one is not optional.
--
-- FriendsRepository.addFriend() upserts on where: { userId_lastFmUserName },
-- which Prisma implements as ON CONFLICT ("user_id", "last_fm_user_name").
-- Without this index addFriend() cannot work, so it is part of fixing the
-- drift and not a performance nicety. The other two are the schema's
-- @@index([userId]) and @@index([friendUserId]).
--
-- Created after the backfill and the NOT NULL pass, so the unique index sees
-- final values. IF NOT EXISTS for the reason in the header.
CREATE UNIQUE INDEX IF NOT EXISTS "friends_user_id_last_fm_user_name_key"
    ON "friends"("user_id", "last_fm_user_name");

CREATE INDEX IF NOT EXISTS "friends_user_id_idx" ON "friends"("user_id");

CREATE INDEX IF NOT EXISTS "friends_friend_user_id_idx" ON "friends"("friend_user_id");


-- ---------------------------------------------------------------------------
-- Still outstanding after this migration, found by the same diff and NOT
-- addressed here because it is outside the scope of this fix. Recorded so the
-- next person does not read a closed drift report as a closed drift.
--
--   * 8 non-unique indexes the schema declares that no migration creates:
--     users_last_update_idx, user_plays_user_id_play_source_idx,
--     user_artists_artist_id_idx, user_artists_name_idx,
--     user_albums_album_id_idx, user_albums_name_idx,
--     user_tracks_track_id_idx, user_tracks_name_idx. These cost query plans,
--     not correctness.
--   * guilds.accent_color exists in 20260826105535 but not in the schema, so
--     it is the reverse drift: the history has a column the model does not.
--   * artists.name, albums.name, tracks.name, user_plays.artist_name,
--     user_albums.name, user_tracks.name are VARCHAR(255)/VARCHAR(750) in the
--     migrations and TEXT in the schema. Reads and writes both work; the
--     difference is a length limit, and narrowing or widening it on a live
--     table is not something to do as a side effect of a P2022 fix.
-- ---------------------------------------------------------------------------
