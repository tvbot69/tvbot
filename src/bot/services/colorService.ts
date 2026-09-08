import { inject, injectable } from 'tsyringe';
import sharp from 'sharp';
import crypto from 'crypto';
import { CacheService } from './cacheService';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { Logger } from '@domain/logger';

const COLOR_CACHE_TTL_SECONDS = 86400; // 24 hours
const MAX_SAMPLE_SIZE = 64;
const QUANTIZE_SHIFT = 5;

export interface ColorExtractionBin {
  r: number;
  g: number;
  b: number;
  count: number;
}

@injectable()
export class ColorService {
  private readonly cache: CacheService;

  constructor(
    @inject(CacheService) cache: CacheService,
  ) {
    this.cache = cache;
  }

  /**
   * Translates BitmapExtensions.cs GetAccentColor() from fmbot-dev into TypeScript.
   * Quantizes pixels into 512 bins and selects the dominant vibrant color.
   */
  public extractAccentColorFromRgba(pixels: Uint8Array | Buffer, _width: number, _height: number): number {
    const bins = new Map<number, ColorExtractionBin>();
    let totalPixels = 0;

    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i] ?? 0;
      const g = pixels[i + 1] ?? 0;
      const b = pixels[i + 2] ?? 0;
      const a = pixels[i + 3] ?? 0;

      // Skip transparent or near-transparent pixels (matches Skia Alpha < 10)
      if (a < 10) continue;

      const key = ((r >> QUANTIZE_SHIFT) << 16) | ((g >> QUANTIZE_SHIFT) << 8) | (b >> QUANTIZE_SHIFT);
      const existing = bins.get(key);
      if (existing) {
        existing.r += r;
        existing.g += g;
        existing.b += b;
        existing.count += 1;
      } else {
        bins.set(key, { r, g, b, count: 1 });
      }
      totalPixels++;
    }

    if (totalPixels === 0) {
      return DiscordConstants.LastFmColorRed;
    }

    let bestKey = -1;
    let bestScore = -1.0;

    for (const [key, bin] of bins.entries()) {
      const avgR = bin.r / bin.count;
      const avgG = bin.g / bin.count;
      const avgB = bin.b / bin.count;

      const max = Math.max(avgR, avgG, avgB);
      const min = Math.min(avgR, avgG, avgB);
      const chroma = (max - min) / 255.0;

      const proportion = bin.count / totalPixels;
      const score = proportion * (1.0 + chroma * 3.0);

      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }

    const best = bins.get(bestKey);
    if (!best) {
      return DiscordConstants.LastFmColorRed;
    }

    const finalR = Math.round(best.r / best.count);
    const finalG = Math.round(best.g / best.count);
    const finalB = Math.round(best.b / best.count);

    return (finalR << 16) | (finalG << 8) | finalB;
  }

  /**
   * Extracts accent color directly from image buffer using sharp.
   */
  public async extractAccentColor(imageBuffer: Buffer): Promise<number> {
    try {
      const { data, info } = await sharp(imageBuffer)
        .resize(MAX_SAMPLE_SIZE, MAX_SAMPLE_SIZE, { fit: 'inside', withoutEnlargement: false })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      return this.extractAccentColorFromRgba(data, info.width, info.height);
    } catch (err) {
      Logger.warn({ err }, 'Failed to extract accent color from image buffer');
      return DiscordConstants.LastFmColorRed;
    }
  }

  /**
   * Resolves the accent color from an image URL with high-performance Redis/memory caching.
   * Matches fmbot-dev behavior: downloads artwork, extracts vibrant color, falls back to Last.fm Red.
   */
  public async getColorFromImageUrl(imageUrl?: string | null): Promise<number> {
    if (!imageUrl || typeof imageUrl !== 'string' || imageUrl.trim().length === 0) {
      return DiscordConstants.LastFmColorRed;
    }

    const cleanUrl = imageUrl.trim();

    // Check placeholder URLs (e.g. Last.fm default star placeholder)
    if (cleanUrl.includes('2a96cbd8b46e442fc41c2b86b821562f')) {
      return DiscordConstants.LastFmColorRed;
    }

    const hash = crypto.createHash('md5').update(cleanUrl).digest('hex');
    const cacheKey = `accent-color:image:${hash}`;

    const cached = await this.cache.get<number>(cacheKey);
    if (cached !== null && cached !== undefined && typeof cached === 'number' && cached !== DiscordConstants.LastFmColorRed) {
      return cached;
    }

    try {
      // Process Last.fm Fastly image URLs for faster downloads matching fmbot-dev
      let processedUrl = cleanUrl;
      if (processedUrl.includes('fastly.net')) {
        if (/\/(34s|64s|174s|770x0)\//.test(processedUrl)) {
          processedUrl = processedUrl.replace(/\/(34s|64s|174s|770x0)\//, '/300x300/');
        } else if (!processedUrl.includes('/300x300/')) {
          processedUrl = processedUrl.replace('/i/u/', '/i/u/300x300/');
        }
      } else if (processedUrl.includes('{w}x{h}')) {
        processedUrl = processedUrl.replace('{w}x{h}', '300x300');
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const resp = await fetch(processedUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'tvbot/0.1.0 (+https://github.com/tvbot)',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        return DiscordConstants.LastFmColorRed;
      }

      const arrayBuffer = await resp.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const color = await this.extractAccentColor(buffer);

      if (color !== DiscordConstants.LastFmColorRed) {
        await this.cache.set(cacheKey, color, COLOR_CACHE_TTL_SECONDS);
      }
      return color;
    } catch (err) {
      Logger.warn({ err, url: cleanUrl }, 'Error fetching image for accent color extraction');
      return DiscordConstants.LastFmColorRed;
    }
  }

  /**
   * Compatibility method: if imageUrl is passed, extracts color from it;
   * otherwise returns Last.fm red. Database lookups are completely removed.
   */
  public async getAccentColorAsync(_targetId?: string | null, imageUrl?: string | null): Promise<number> {
    if (imageUrl) {
      return this.getColorFromImageUrl(imageUrl);
    }
    return DiscordConstants.LastFmColorRed;
  }
}
