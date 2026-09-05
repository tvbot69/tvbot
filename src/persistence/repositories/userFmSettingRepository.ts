import { PrismaClient } from '@prisma/client';
import type { IUserFmSettingRepository, UserFmSetting } from '@domain/interfaces/iuserFmSettingRepository';

export class UserFmSettingRepository implements IUserFmSettingRepository {
  private readonly prisma: PrismaClient;
  constructor(prisma: PrismaClient) { this.prisma = prisma; }

  async get(userId: number): Promise<UserFmSetting | null> {
    const e = await this.prisma.userFmSetting.findUnique({ where: { userId } });
    return e ? this.map(e) : null;
  }
  async getOrCreate(userId: number): Promise<UserFmSetting> {
    const existing = await this.get(userId);
    if (existing) return existing;
    const created = await this.prisma.userFmSetting.create({ data: { userId, embedType: 0, footerOptions: BigInt(16), buttons: BigInt(0) } });
    return this.map(created);
  }
  async setEmbedType(userId: number, embedType: number): Promise<UserFmSetting> {
    await this.getOrCreate(userId);
    const e = await this.prisma.userFmSetting.update({ where: { userId }, data: { embedType, modified: new Date() } });
    return this.map(e);
  }
  async setFooterOptions(userId: number, footerOptions: bigint): Promise<UserFmSetting> {
    await this.getOrCreate(userId);
    const e = await this.prisma.userFmSetting.update({ where: { userId }, data: { footerOptions, modified: new Date() } });
    return this.map(e);
  }
  async setButtons(userId: number, buttons: bigint): Promise<UserFmSetting> {
    await this.getOrCreate(userId);
    const e = await this.prisma.userFmSetting.update({ where: { userId }, data: { buttons, modified: new Date() } });
    return this.map(e);
  }
  async setAccentColor(userId: number, accentColor: number | null, customColor: string | null = null): Promise<UserFmSetting> {
    await this.getOrCreate(userId);
    const e = await this.prisma.userFmSetting.update({ where: { userId }, data: { accentColor, customColor, modified: new Date() } });
    return this.map(e);
  }
  async setSmallTextType(userId: number, smallTextType: number | null): Promise<UserFmSetting> {
    await this.getOrCreate(userId);
    const e = await this.prisma.userFmSetting.update({ where: { userId }, data: { smallTextType, modified: new Date() } });
    return this.map(e);
  }
  async setPrivateButtonResponse(userId: number, value: boolean | null): Promise<UserFmSetting> {
    await this.getOrCreate(userId);
    const e = await this.prisma.userFmSetting.update({ where: { userId }, data: { privateButtonResponse: value, modified: new Date() } });
    return this.map(e);
  }
  private map(e: { userId: number; embedType: number; footerOptions: bigint; buttons: bigint; accentColor: number | null; customColor: string | null; smallTextType: number | null; privateButtonResponse: boolean | null; modified: Date | null }): UserFmSetting {
    return { userId: e.userId, embedType: e.embedType, footerOptions: e.footerOptions, buttons: e.buttons, accentColor: e.accentColor, customColor: e.customColor, smallTextType: e.smallTextType, privateButtonResponse: e.privateButtonResponse, modified: e.modified };
  }
}
