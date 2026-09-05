import { PrismaClient } from '@prisma/client';
import type { IGuildDisabledCommandRepository } from '@domain/interfaces/iguildDisabledCommandRepository';
import type { GuildDisabledCommand } from '@persistence/domain/models/guildDisabledCommand';

export class GuildDisabledCommandRepository implements IGuildDisabledCommandRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public async getAllForGuild(guildId: string): Promise<GuildDisabledCommand[]> {
    const entities = await this.prisma.guildDisabledCommand.findMany({
      where: { guildId: BigInt(guildId) },
    });
    return entities.map((e) => ({
      guildId: e.guildId.toString(),
      commandName: e.commandName,
    }));
  }

  public async add(guildId: string, commandName: string): Promise<void> {
    await this.prisma.guildDisabledCommand.upsert({
      where: {
        guildId_commandName: { guildId: BigInt(guildId), commandName: commandName },
      },
      update: {},
      create: { guildId: BigInt(guildId), commandName: commandName },
    });
  }

  public async remove(guildId: string, commandName: string): Promise<void> {
    await this.prisma.guildDisabledCommand.deleteMany({
      where: { guildId: BigInt(guildId), commandName: commandName },
    });
  }
}
