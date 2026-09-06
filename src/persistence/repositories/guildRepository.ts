import { PrismaClient, Guild as GuildEntity } from '@prisma/client';
import type { IGuildRepository } from '@domain/interfaces/iguildRepository';
import type { Guild } from '@persistence/domain/models/guild';

export class GuildRepository implements IGuildRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public async getGuild(guildId: string): Promise<Guild | null> {
    const entity = await this.prisma.guild.findUnique({
      where: { guildId: BigInt(guildId) },
    });
    return entity ? this.map(entity) : null;
  }

  public async addOrUpdateGuild(guildId: string, guildName: string): Promise<Guild> {
    const entity = await this.prisma.guild.upsert({
      where: { guildId: BigInt(guildId) },
      update: { guildName: guildName },
      create: { guildId: BigInt(guildId), guildName: guildName },
    });
    return this.map(entity);
  }

  public async setPrefix(guildId: string, prefix: string | null): Promise<void> {
    await this.prisma.guild.update({
      where: { guildId: BigInt(guildId) },
      data: { prefix: prefix },
    });
  }

  public async setCommandsDisabled(guildId: string, disabled: boolean): Promise<void> {
    await this.prisma.guild.update({
      where: { guildId: BigInt(guildId) },
      data: { commandsDisabled: disabled },
    });
  }

  public async setAccentColor(guildId: string, color: number | null): Promise<void> {
    await this.prisma.guild.update({
      where: { guildId: BigInt(guildId) },
      data: { accentColor: color },
    });
  }
  public async setFmEmbedType(guildId: string, fmEmbedType: number | null): Promise<void> {
    await this.prisma.guild.update({ where: { guildId: BigInt(guildId) }, data: { fmEmbedType } });
  }
  public async setLastCommand(guildId: string, date: Date): Promise<void> {
    await this.prisma.guild.update({
      where: { guildId: BigInt(guildId) },
      data: { lastCommand: date },
    });
  }

  public async setCrownsThreshold(guildId: string, threshold: number): Promise<void> {
    await this.prisma.guild.update({
      where: { guildId: BigInt(guildId) },
      data: { crownsMinimumPlaycountThreshold: threshold },
    });
  }

  public async setCrownsActivityThreshold(guildId: string, days: number | null): Promise<void> {
    await this.prisma.guild.update({
      where: { guildId: BigInt(guildId) },
      data: { crownsActivityThresholdDays: days },
    });
  }

  public async setCrownsDisabled(guildId: string, disabled: boolean): Promise<void> {
    await this.prisma.guild.update({
      where: { guildId: BigInt(guildId) },
      data: { crownsDisabled: disabled },
    });
  }

  private map(entity: GuildEntity): Guild {
    return {
      guildId: entity.guildId.toString(),
      guildName: entity.guildName,
      prefix: entity.prefix ?? undefined,
      accentColor: entity.accentColor ?? undefined,
      fmEmbedType: (entity as unknown as { fmEmbedType?: number | null }).fmEmbedType ?? undefined,
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
