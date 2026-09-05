-- CreateTable
CREATE TABLE "channels" (
    "channel_id" BIGINT NOT NULL,
    "guild_id" BIGINT NOT NULL,
    "toggled_commands" TEXT[],
    "who_knows_whitelisted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("channel_id")
);

-- CreateTable
CREATE TABLE "guild_disabled_commands" (
    "guild_id" BIGINT NOT NULL,
    "command_name" VARCHAR(50) NOT NULL,

    CONSTRAINT "guild_disabled_commands_pkey" PRIMARY KEY ("guild_id","command_name")
);

-- CreateIndex
CREATE INDEX "channels_guild_id_idx" ON "channels"("guild_id");

-- CreateIndex
CREATE INDEX "guild_disabled_commands_command_name_idx" ON "guild_disabled_commands"("command_name");

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guilds"("guild_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guild_disabled_commands" ADD CONSTRAINT "guild_disabled_commands_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guilds"("guild_id") ON DELETE RESTRICT ON UPDATE CASCADE;
