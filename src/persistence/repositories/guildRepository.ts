import { PrismaClient, Guild as GuildEntity } from '@prisma/client';
import type { IGuildRepository } from '@domain/interfaces/iguildRepository';
import type { Guild } from '@persistence/models/guild';

/**
 * The ONLY `BigInt()` call in this file. `guild.guild_id` is a `BigInt @id` and
 * every entry point receives a string, so this is where a guild id becomes a
 * key — and `BigInt('abc')` THROWS a `SyntaxError`, which used to escape eight of
 * the nine methods below while `getGuild` answered `null` for the same input.
 *
 * A malformed id is a CALLER bug, and every method here returns the empty
 * answer rather than raising: there is no such guild, so it has no prefix, no
 * thresholds and no row to write. Same shape and same reasoning as
 * `crownRepository.safeBigInt`, which is the guard of record for this directory.
 */
const toGuildId = (guildId: string): bigint | null => {
  if (!guildId || !/^\d+$/.test(guildId)) return null;
  try {
    return BigInt(guildId);
  } catch {
    // Defence in depth: the regex already rejects everything `BigInt` refuses.
    return null;
  }
};

export class GuildRepository implements IGuildRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public async getGuild(guildId: string): Promise<Guild | null> {
    const gid = toGuildId(guildId);
    if (!gid) return null;

    const entity = await this.prisma.guild.findUnique({
      where: { guildId: gid },
    });
    return entity ? this.map(entity) : null;
  }

  public async addOrUpdateGuild(guildId: string, guildName: string): Promise<Guild> {
    const gid = toGuildId(guildId);
    if (!gid) {
      throw new TypeError(
        `guildRepository.addOrUpdateGuild: guildId must be a decimal string, got ${JSON.stringify(String(guildId).slice(0, 32))}`,
      );
    }

    const entity = await this.prisma.guild.upsert({
      where: { guildId: gid },
      update: { guildName: guildName },
      create: { guildId: gid, guildName: guildName },
    });
    return this.map(entity);
  }

  public async setPrefix(guildId: string, prefix: string | null): Promise<void> {
    const gid = toGuildId(guildId);
    if (!gid) return;

    await this.prisma.guild.update({
      where: { guildId: gid },
      data: { prefix: prefix },
    });
  }

  public async setCommandsDisabled(guildId: string, disabled: boolean): Promise<void> {
    const gid = toGuildId(guildId);
    if (!gid) return;

    await this.prisma.guild.update({
      where: { guildId: gid },
      data: { commandsDisabled: disabled },
    });
  }

  public async setFmEmbedType(guildId: string, fmEmbedType: number | null): Promise<void> {
    const gid = toGuildId(guildId);
    if (!gid) return;

    await this.prisma.guild.update({ where: { guildId: gid }, data: { fmEmbedType } });
  }

  public async setLastCommand(guildId: string, date: Date): Promise<void> {
    const gid = toGuildId(guildId);
    if (!gid) return;

    await this.prisma.guild.update({
      where: { guildId: gid },
      data: { lastCommand: date },
    });
  }

  public async setCrownsThreshold(guildId: string, threshold: number): Promise<void> {
    const gid = toGuildId(guildId);
    if (!gid) return;

    await this.prisma.guild.update({
      where: { guildId: gid },
      data: { crownsMinimumPlaycountThreshold: threshold },
    });
  }

  public async setCrownsActivityThreshold(guildId: string, days: number | null): Promise<void> {
    const gid = toGuildId(guildId);
    if (!gid) return;

    await this.prisma.guild.update({
      where: { guildId: gid },
      data: { crownsActivityThresholdDays: days },
    });
  }

  public async setCrownsDisabled(guildId: string, disabled: boolean): Promise<void> {
    const gid = toGuildId(guildId);
    if (!gid) return;

    await this.prisma.guild.update({
      where: { guildId: gid },
      data: { crownsDisabled: disabled },
    });
  }

  private map(entity: GuildEntity): Guild {
    return {
      guildId: entity.guildId.toString(),
      guildName: entity.guildName,
      prefix: entity.prefix ?? undefined,
      fmEmbedType: entity.fmEmbedType ?? undefined,
      guildCreatedOn: entity.guildCreatedOn,
      lastCommand: entity.lastCommand ?? undefined,
      commandsDisabled: entity.commandsDisabled,
      emotesDisabled: entity.emotesDisabled,
      crownsDisabled: entity.crownsDisabled,
      crownsMinimumPlaycountThreshold: entity.crownsMinimumPlaycountThreshold,
      crownsActivityThresholdDays: entity.crownsActivityThresholdDays,
      crownRoles: entity.crownRoles?.map(r => r.toString()) ?? [],
    };
  }
}
