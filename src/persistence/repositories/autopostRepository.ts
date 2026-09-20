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

  public async countForGuild(guildId: string): Promise<number> {
    return this.prisma.guildAutopost.count({ where: { guildId: BigInt(guildId) } });
  }

  /**
   * Atomic due-claim: stamps lastPosted=now only when the row is still due.
   * Returns the previous lastPosted when this caller won the claim, null when
   * another runner claimed it first (or it is not due). The caller rolls back
   * to the previous value on post failure so the next sweep retries.
   */
  public async claimDueAutopost(id: number, dueBefore: Date): Promise<Date | null | undefined> {
    const current = await this.prisma.guildAutopost.findUnique({
      where: { id },
      select: { lastPosted: true, enabled: true },
    });
    if (!current?.enabled) return null;
    if (current.lastPosted && current.lastPosted > dueBefore) return null;
    const res = await this.prisma.guildAutopost.updateMany({
      where: {
        id,
        enabled: true,
        OR: [{ lastPosted: null }, { lastPosted: { lte: dueBefore } }],
      },
      data: { lastPosted: new Date() },
    });
    return res.count > 0 ? (current.lastPosted ?? undefined) : null;
  }

  public async releaseClaim(id: number, previousLastPosted: Date | null | undefined): Promise<void> {
    await this.prisma.guildAutopost.update({
      where: { id },
      data: { lastPosted: previousLastPosted ?? null },
    }).catch(() => undefined);
  }
}
