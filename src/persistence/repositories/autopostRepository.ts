import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import type { AutopostConfig, AutopostContentType, AutopostSchedule } from '@bot/services/autopostService';

@injectable()
export class AutopostRepository {
  constructor(@inject(PrismaClient) private readonly prisma: PrismaClient) {}

  public async getAutopostsForGuild(guildId: string): Promise<AutopostConfig[]> {
    const records = await this.prisma.guildAutopost.findMany({
      where: { guildId: BigInt(guildId) },
      orderBy: { id: 'asc' },
    });

    return records.map((r) => ({
      id: r.id.toString(),
      guildId: r.guildId.toString(),
      channelId: r.channelId.toString(),
      contentType: r.contentType as AutopostContentType,
      schedule: r.schedule as AutopostSchedule,
      enabled: r.enabled,
      lastPosted: r.lastPosted,
      created: r.created,
    }));
  }

  public async getAllActiveAutoposts(): Promise<AutopostConfig[]> {
    const records = await this.prisma.guildAutopost.findMany({
      where: { enabled: true },
    });

    return records.map((r) => ({
      id: r.id.toString(),
      guildId: r.guildId.toString(),
      channelId: r.channelId.toString(),
      contentType: r.contentType as AutopostContentType,
      schedule: r.schedule as AutopostSchedule,
      enabled: r.enabled,
      lastPosted: r.lastPosted,
      created: r.created,
    }));
  }

  public async getAutopostById(id: number): Promise<AutopostConfig | null> {
    const r = await this.prisma.guildAutopost.findUnique({
      where: { id },
    });
    if (!r) return null;

    return {
      id: r.id.toString(),
      guildId: r.guildId.toString(),
      channelId: r.channelId.toString(),
      contentType: r.contentType as AutopostContentType,
      schedule: r.schedule as AutopostSchedule,
      enabled: r.enabled,
      lastPosted: r.lastPosted,
      created: r.created,
    };
  }

  public async createAutopost(data: {
    guildId: string;
    channelId: string;
    contentType: AutopostContentType;
    schedule: AutopostSchedule;
  }): Promise<AutopostConfig> {
    const r = await this.prisma.guildAutopost.create({
      data: {
        guildId: BigInt(data.guildId),
        channelId: BigInt(data.channelId),
        contentType: data.contentType,
        schedule: data.schedule,
        enabled: true,
      },
    });

    return {
      id: r.id.toString(),
      guildId: r.guildId.toString(),
      channelId: r.channelId.toString(),
      contentType: r.contentType as AutopostContentType,
      schedule: r.schedule as AutopostSchedule,
      enabled: r.enabled,
      lastPosted: r.lastPosted,
      created: r.created,
    };
  }

  public async deleteAutopost(id: number, guildId: string): Promise<boolean> {
    const res = await this.prisma.guildAutopost.deleteMany({
      where: { id, guildId: BigInt(guildId) },
    });
    return res.count > 0;
  }

  public async toggleAutopost(id: number, guildId: string): Promise<AutopostConfig | null> {
    const existing = await this.prisma.guildAutopost.findFirst({
      where: { id, guildId: BigInt(guildId) },
    });
    if (!existing) return null;

    const updated = await this.prisma.guildAutopost.update({
      where: { id },
      data: { enabled: !existing.enabled },
    });

    return {
      id: updated.id.toString(),
      guildId: updated.guildId.toString(),
      channelId: updated.channelId.toString(),
      contentType: updated.contentType as AutopostContentType,
      schedule: updated.schedule as AutopostSchedule,
      enabled: updated.enabled,
      lastPosted: updated.lastPosted,
      created: updated.created,
    };
  }

  public async updateLastPosted(id: number, lastPosted: Date): Promise<void> {
    await this.prisma.guildAutopost.update({
      where: { id },
      data: { lastPosted },
    });
  }
}
