import { injectable } from 'tsyringe';
import { Logger } from '@domain/logger';
import { ConfigData } from '@bot/configurations/configData';
import type { FootballDaySchedule } from '@domain/models/football/footballModels';

export function normalizeTeamSlug(name: string): string {
  // Strip common club prefixes to yield cleaner, recognizable slug names
  let cleaned = name.replace(/^(1\.\s*fc|fc|cf|sc|ac|as|afc|bsc|sv)\s+/i, '').trim();
  if (cleaned.length < 2) cleaned = name;

  const clean = cleaned
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  let base = clean;
  // If clean string is too short or empty (e.g. Arabic characters)
  if (!base || base.length < 2) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    }
    base = `team_${Math.abs(hash).toString(36)}`;
  }

  let slug = `fb_${base}`;
  if (slug.length > 32) {
    slug = slug.substring(0, 32).replace(/_$/, '');
  }
  return slug;
}

@injectable()
export class FootballBadgeService {
  private readonly emojiCache = new Map<string, string>(); // slug -> <:name:id>
  private readonly failedCooldown = new Map<string, number>(); // slug -> expiresAt
  private readonly pendingUploads = new Map<string, Promise<string>>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private getCredentials(): { token: string; applicationId: string } {
    const token = ConfigData.Data.discord.token;
    let appId = ConfigData.Data.discord.applicationId;
    if (!appId || appId === '0') {
      try {
        const firstSegment = token.split('.')[0];
        if (firstSegment) {
          appId = Buffer.from(firstSegment, 'base64').toString('utf8');
        }
      } catch {
        appId = '0';
      }
    }
    return { token, applicationId: appId };
  }

  /**
   * Initializes application emoji cache by querying Discord REST API
   */
  public async initializeAsync(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const { token, applicationId } = this.getCredentials();
        if (!token || !applicationId || applicationId === '0') {
          this.initialized = true;
          return;
        }

        const res = await fetch(`https://discord.com/api/v10/applications/${applicationId}/emojis`, {
          headers: { Authorization: `Bot ${token}` },
          signal: AbortSignal.timeout(6000),
        });

        if (res.ok) {
          const data = await res.json();
          const items: any[] = data.items || [];
          for (const item of items) {
            if (item.name && item.id && item.name.startsWith('fb_')) {
              this.emojiCache.set(item.name, `<:${item.name}:${item.id}>`);
            }
          }
          Logger.info(`[FootballBadgeService] Loaded ${this.emojiCache.size} football club badges into cache.`);
        } else {
          Logger.warn(`[FootballBadgeService] HTTP ${res.status} preloading application emojis.`);
        }
      } catch (err: any) {
        Logger.warn(`[FootballBadgeService] Failed to preload application emojis: ${err.message}`);
      } finally {
        this.initialized = true;
      }
    })();

    return this.initPromise;
  }

  /**
   * Resolves or uploads an application emoji badge for the given team name and logo URL.
   * Returns a Discord emoji tag like "<:fb_union_berlin:1545538307297910984>" or "" if unavailable.
   */
  public async getBadgeAsync(teamName: string, logoUrl?: string): Promise<string> {
    if (!this.initialized) {
      await this.initializeAsync();
    }

    const slug = normalizeTeamSlug(teamName);

    // 1. In-memory cache hit
    if (this.emojiCache.has(slug)) {
      return this.emojiCache.get(slug)!;
    }

    // 2. Cooldown check for previously failed uploads (15 mins)
    const cooldown = this.failedCooldown.get(slug);
    if (cooldown && cooldown > Date.now()) {
      return '';
    }

    // 3. No logo URL available
    if (!logoUrl) {
      return '';
    }

    // 4. In-flight upload de-duplication
    if (this.pendingUploads.has(slug)) {
      return this.pendingUploads.get(slug)!;
    }

    const uploadPromise = (async (): Promise<string> => {
      try {
        const { token, applicationId } = this.getCredentials();
        if (!token || !applicationId || applicationId === '0') return '';

        // Check if application emoji capacity limit reached (max 450 safety ceiling)
        if (this.emojiCache.size >= 450) {
          Logger.warn('[FootballBadgeService] Application emoji limit approaching ceiling (450), skipping upload');
          return '';
        }

        // Fetch image buffer (clean backslashes and encode spaces)
        const cleanUrl = encodeURI(logoUrl.replace(/\\/g, '/'));
        const imgRes = await fetch(cleanUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            Accept: 'image/png,image/jpeg,image/webp,image/*,*/*',
          },
          signal: AbortSignal.timeout(5000),
        });

        if (!imgRes.ok) {
          this.failedCooldown.set(slug, Date.now() + 15 * 60 * 1000);
          return '';
        }

        const buffer = Buffer.from(await imgRes.arrayBuffer());
        // Discord emoji max file size is 256 KB
        if (buffer.length === 0 || buffer.length > 256 * 1024) {
          this.failedCooldown.set(slug, Date.now() + 15 * 60 * 1000);
          return '';
        }

        const contentType = imgRes.headers.get('content-type') || 'image/png';
        const mimeType = contentType.includes('jpeg') || contentType.includes('jpg')
          ? 'image/jpeg'
          : contentType.includes('webp')
          ? 'image/webp'
          : 'image/png';

        const dataUri = `data:${mimeType};base64,${buffer.toString('base64')}`;

        // Upload to Discord Application Emojis
        const uploadRes = await fetch(`https://discord.com/api/v10/applications/${applicationId}/emojis`, {
          method: 'POST',
          headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: slug,
            image: dataUri,
          }),
          signal: AbortSignal.timeout(6000),
        });

        if (uploadRes.status === 201) {
          const emojiData = await uploadRes.json();
          const emojiTag = `<:${emojiData.name}:${emojiData.id}>`;
          this.emojiCache.set(slug, emojiTag);
          Logger.info(`[FootballBadgeService] Successfully registered badge for ${teamName} as ${emojiTag}`);
          return emojiTag;
        }

        // On failure, set cooldown
        const errText = await uploadRes.text().catch(() => '');
        Logger.warn(`[FootballBadgeService] Upload failed for ${teamName} (${slug}) HTTP ${uploadRes.status}: ${errText}`);
        this.failedCooldown.set(slug, Date.now() + 15 * 60 * 1000);
        return '';
      } catch (err: any) {
        Logger.warn(`[FootballBadgeService] Failed to upload badge for ${teamName}: ${err.message}`);
        this.failedCooldown.set(slug, Date.now() + 15 * 60 * 1000);
        return '';
      } finally {
        this.pendingUploads.delete(slug);
      }
    })();

    this.pendingUploads.set(slug, uploadPromise);
    return uploadPromise;
  }

  private readonly uploadQueue: { teamName: string; logoUrl: string; slug: string }[] = [];
  private isProcessingQueue = false;

  private enqueueBackgroundUpload(teamName: string, logoUrl?: string): void {
    if (!logoUrl) return;
    const slug = normalizeTeamSlug(teamName);
    if (this.emojiCache.has(slug)) return;
    if (this.pendingUploads.has(slug)) return;
    const cooldown = this.failedCooldown.get(slug);
    if (cooldown && cooldown > Date.now()) return;
    if (this.emojiCache.size >= 450) return;

    if (this.uploadQueue.some((q) => q.slug === slug)) return;
    this.uploadQueue.push({ teamName, logoUrl, slug });

    void this.processUploadQueue();
  }

  private async processUploadQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.uploadQueue.length > 0) {
      const item = this.uploadQueue.shift();
      if (!item) break;

      if (!this.emojiCache.has(item.slug)) {
        await this.getBadgeAsync(item.teamName, item.logoUrl).catch(() => '');
        // Throttled delay between background uploads to prevent Discord 429 rate-limiting
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Resolves all team badges in a day schedule.
   * Cached badges are applied instantly (0ms).
   * Uncached teams are scheduled via background queue without freezing user UI.
   */
  public async resolveScheduleBadgesAsync(schedule: FootballDaySchedule): Promise<void> {
    if (!schedule.matches || schedule.matches.length === 0) return;

    if (!this.initialized) {
      await this.initializeAsync();
    }

    for (const match of schedule.matches) {
      const homeSlug = normalizeTeamSlug(match.homeTeam.name);
      if (this.emojiCache.has(homeSlug)) {
        match.homeTeam.badge = this.emojiCache.get(homeSlug);
      } else if (match.homeTeam.logo) {
        this.enqueueBackgroundUpload(match.homeTeam.name, match.homeTeam.logo);
      }

      const awaySlug = normalizeTeamSlug(match.awayTeam.name);
      if (this.emojiCache.has(awaySlug)) {
        match.awayTeam.badge = this.emojiCache.get(awaySlug);
      } else if (match.awayTeam.logo) {
        this.enqueueBackgroundUpload(match.awayTeam.name, match.awayTeam.logo);
      }
    }
  }
}
