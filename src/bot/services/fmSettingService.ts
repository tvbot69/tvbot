import type { IUserFmSettingRepository, UserFmSetting } from '@domain/interfaces/iuserFmSettingRepository';
import { CacheService } from './cacheService';

export class FmSettingService {
  private readonly repo: IUserFmSettingRepository;
  private readonly cache: CacheService;
  constructor(repo: IUserFmSettingRepository, cache: CacheService) {
    this.repo = repo; this.cache = cache;
  }
  private key(userId: number) { return `fm-setting:${userId}`; }
  async get(userId: number): Promise<UserFmSetting | null> {
    const cached = await this.cache.get<UserFmSetting>(this.key(userId));
    if (cached) return cached;
    const s = await this.repo.get(userId);
    if (s) await this.cache.set(this.key(userId), s, 120);
    return s;
  }
  async getOrCreate(userId: number): Promise<UserFmSetting> {
    const s = await this.repo.getOrCreate(userId);
    await this.cache.set(this.key(userId), s, 120);
    return s;
  }
  async setEmbedType(userId: number, t: number) { const r = await this.repo.setEmbedType(userId, t); await this.cache.set(this.key(userId), r, 120); return r; }
  async setFooterOptions(userId: number, v: bigint) { const r = await this.repo.setFooterOptions(userId, v); await this.cache.set(this.key(userId), r, 120); return r; }
  async setButtons(userId: number, v: bigint) { const r = await this.repo.setButtons(userId, v); await this.cache.set(this.key(userId), r, 120); return r; }
  async setAccentColor(userId: number, c: number | null, hex?: string | null) { const r = await this.repo.setAccentColor(userId, c, hex ?? null); await this.cache.set(this.key(userId), r, 120); return r; }
  async setSmallTextType(userId: number, v: number | null) { const r = await this.repo.setSmallTextType(userId, v); await this.cache.set(this.key(userId), r, 120); return r; }
  async setPrivateButtonResponse(userId: number, v: boolean | null) { const r = await this.repo.setPrivateButtonResponse(userId, v); await this.cache.set(this.key(userId), r, 120); return r; }
  async invalidate(userId: number) { await this.cache.delete(this.key(userId)); }
}
