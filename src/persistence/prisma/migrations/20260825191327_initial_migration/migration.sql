-- CreateEnum
CREATE TYPE "privacy_level" AS ENUM ('Default', 'Hide');

-- CreateTable
CREATE TABLE "users" (
    "user_id" SERIAL NOT NULL,
    "user_name_last_fm" VARCHAR(255) NOT NULL,
    "discord_user_id" BIGINT NOT NULL,
    "registered_on" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "privacy_level" "privacy_level" NOT NULL DEFAULT 'Default',
    "last_update" TIMESTAMPTZ(6),
    "last_indexed" TIMESTAMPTZ(6),
    "total_play_count" INTEGER,

    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "guilds" (
    "guild_id" BIGINT NOT NULL,
    "guild_name" VARCHAR(100) NOT NULL,
    "prefix" VARCHAR(10),
    "guild_created_on" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_command" TIMESTAMPTZ(6),
    "commands_disabled" BOOLEAN NOT NULL DEFAULT false,
    "emotes_disabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "guilds_pkey" PRIMARY KEY ("guild_id")
);

-- CreateTable
CREATE TABLE "guild_users" (
    "guild_id" BIGINT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "who_knows_whitelisted" BOOLEAN NOT NULL DEFAULT false,
    "who_knows_banned" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "guild_users_pkey" PRIMARY KEY ("guild_id","user_id")
);

-- CreateTable
CREATE TABLE "friends" (
    "id" SERIAL NOT NULL,
    "scribe_user_id" INTEGER NOT NULL,
    "friend_user_id" INTEGER NOT NULL,

    CONSTRAINT "friends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_user_name_last_fm_key" ON "users"("user_name_last_fm");

-- CreateIndex
CREATE UNIQUE INDEX "users_discord_user_id_key" ON "users"("discord_user_id");

-- CreateIndex
CREATE INDEX "guild_users_user_id_idx" ON "guild_users"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "friends_scribe_user_id_friend_user_id_key" ON "friends"("scribe_user_id", "friend_user_id");

-- AddForeignKey
ALTER TABLE "guild_users" ADD CONSTRAINT "guild_users_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guilds"("guild_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guild_users" ADD CONSTRAINT "guild_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friends" ADD CONSTRAINT "friends_scribe_user_id_fkey" FOREIGN KEY ("scribe_user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friends" ADD CONSTRAINT "friends_friend_user_id_fkey" FOREIGN KEY ("friend_user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
