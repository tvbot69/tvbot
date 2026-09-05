import { singleton } from 'tsyringe';
import { Logger } from '@domain/logger';

export interface LyricsResult {
  title: string;
  artist: string;
  plainLyrics: string;
  syncedLyrics?: string;
  instrumental: boolean;
  source?: 'lrclib' | 'genius';
}

interface CacheEntry {
  result: LyricsResult | null;
  expiresAt: number;
}

@singleton()
export class LyricsService {
  private static readonly LRCLIB_BASE_URL = 'https://lrclib.net/api';
  private static readonly GENIUS_SEARCH_URL = 'https://genius.com/api/search/multi';
  private static readonly TIMEOUT_MS = 5000;
  private static readonly CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

  private readonly cache = new Map<string, CacheEntry>();

  /**
   * Search for lyrics given a track title and optional artist name.
   * Multi-tier: LRCLIB (synced + plain) -> Genius fallback (full coverage for rap, underground & new releases).
   */
  public async getLyrics(title: string, artist?: string): Promise<LyricsResult | null> {
    const { cleanTitle, cleanArtist, combined } = this.cleanSearchQuery(title, artist);
    const cacheKey = `${cleanArtist.toLowerCase()}:${cleanTitle.toLowerCase()}`;

    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    try {
      // 1. Try LRCLIB exact match
      if (cleanArtist) {
        const exactResult = await this.fetchLrclibExact(cleanTitle, cleanArtist);
        if (exactResult) {
          this.setCache(cacheKey, exactResult);
          return exactResult;
        }
      }

      // 2. Try LRCLIB search query
      const lrclibSearch = await this.fetchLrclibSearch(combined);
      if (lrclibSearch) {
        this.setCache(cacheKey, lrclibSearch);
        return lrclibSearch;
      }

      // 3. Fallback to Genius (covers tracks missing on LRCLIB, like underground rap/indie)
      const geniusResult = await this.fetchGeniusLyrics(combined);
      if (geniusResult) {
        this.setCache(cacheKey, geniusResult);
        return geniusResult;
      }

      // 4. Try title-only on Genius if combined query failed
      if (cleanArtist && cleanTitle !== combined) {
        const geniusTitleResult = await this.fetchGeniusLyrics(cleanTitle);
        if (geniusTitleResult) {
          this.setCache(cacheKey, geniusTitleResult);
          return geniusTitleResult;
        }
      }

      this.setCache(cacheKey, null);
      return null;
    } catch (err) {
      Logger.warn({ err, title, artist }, 'Failed to fetch lyrics');
      return null;
    }
  }

  private setCache(key: string, result: LyricsResult | null): void {
    // Limit cache size
    if (this.cache.size > 200) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { result, expiresAt: Date.now() + LyricsService.CACHE_TTL_MS });
  }

  private async fetchLrclibExact(title: string, artist: string): Promise<LyricsResult | null> {
    try {
      const url = new URL(`${LyricsService.LRCLIB_BASE_URL}/get`);
      url.searchParams.set('track_name', title);
      url.searchParams.set('artist_name', artist);

      const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(LyricsService.TIMEOUT_MS),
        headers: { 'User-Agent': 'tvbot-discord-music-bot/1.0' },
      });

      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      return this.mapToLyricsResult(data, 'lrclib');
    } catch {
      return null;
    }
  }

  private async fetchLrclibSearch(query: string): Promise<LyricsResult | null> {
    try {
      const url = new URL(`${LyricsService.LRCLIB_BASE_URL}/search`);
      url.searchParams.set('q', query);

      const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(LyricsService.TIMEOUT_MS),
        headers: { 'User-Agent': 'tvbot-discord-music-bot/1.0' },
      });

      if (!res.ok) return null;
      const results = (await res.json()) as Array<Record<string, unknown>>;
      if (!Array.isArray(results) || results.length === 0) return null;

      const match = results.find(
        (r) => (typeof r.plainLyrics === 'string' && r.plainLyrics.trim().length > 0) || r.instrumental === true,
      ) ?? results[0];

      if (!match) return null;
      return this.mapToLyricsResult(match, 'lrclib');
    } catch {
      return null;
    }
  }

  /**
   * Fetches lyrics from Genius by querying its multi-search API and scraping the lyrics container.
   */
  public async fetchGeniusLyrics(query: string): Promise<LyricsResult | null> {
    try {
      const searchUrl = `${LyricsService.GENIUS_SEARCH_URL}?q=${encodeURIComponent(query)}`;
      const searchRes = await fetch(searchUrl, {
        signal: AbortSignal.timeout(LyricsService.TIMEOUT_MS),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      if (!searchRes.ok) return null;
      const data = (await searchRes.json()) as {
        response?: {
          sections?: Array<{
            type: string;
            hits: Array<{ result: { title: string; artist_names: string; url: string } }>;
          }>;
        };
      };

      const songSection = data.response?.sections?.find((s) => s.type === 'song');
      const hit = songSection?.hits?.[0]?.result;
      if (!hit || !hit.url) return null;

      const lyricsRes = await fetch(hit.url, {
        signal: AbortSignal.timeout(LyricsService.TIMEOUT_MS),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (!lyricsRes.ok) return null;
      const html = await lyricsRes.text();

      const regex = /<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g;
      let match: RegExpExecArray | null;
      let rawLyrics = '';
      while ((match = regex.exec(html)) !== null) {
        const chunk = match[1]!
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1')
          .replace(/<[^>]+>/g, '')
          .trim();
        rawLyrics += chunk + '\n\n';
      }

      if (!rawLyrics.trim()) return null;

      // Clean Genius header metadata & embed artifacts
      const plain = this.cleanGeniusLyrics(rawLyrics);
      if (plain.length < 20) return null;

      return {
        title: hit.title,
        artist: hit.artist_names,
        plainLyrics: plain,
        instrumental: false,
        source: 'genius',
      };
    } catch {
      return null;
    }
  }

  private cleanGeniusLyrics(text: string): string {
    return text
      .replace(/^\s*\d+\s*Contributors[\s\S]*?(?:Lyrics\s*|\n(?=\[|[A-Z]))/i, '')
      .replace(/\d*Embed$/i, '')
      .trim();
  }

  private mapToLyricsResult(data: Record<string, unknown>, source: 'lrclib' | 'genius'): LyricsResult | null {
    const isInstrumental = Boolean(data.instrumental);
    const plain = typeof data.plainLyrics === 'string' ? data.plainLyrics.trim() : '';
    const synced = typeof data.syncedLyrics === 'string' ? data.syncedLyrics.trim() : undefined;

    if (!plain && !isInstrumental) return null;

    return {
      title: String(data.name || data.trackName || 'Unknown Title'),
      artist: String(data.artistName || 'Unknown Artist'),
      plainLyrics: isInstrumental ? '🎵 This track is instrumental (no lyrics).' : plain,
      syncedLyrics: synced,
      instrumental: isInstrumental,
      source,
    };
  }

  /**
   * Sanitizes title and artist, stripping YouTube cruft, topic suffixes, and visualizer tags.
   */
  public cleanSearchQuery(title: string, artist?: string): { cleanTitle: string; cleanArtist: string; combined: string } {
    const cleanArtist = (artist || '')
      .replace(/\s*-\s*Topic$/i, '')
      .replace(/\s*VEVO$/i, '')
      .trim();

    let cleanTitle = title
      .replace(new RegExp(`^${cleanArtist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*-\\s*`, 'i'), '')
      .replace(/\s*[([].*?(official|video|audio|lyrics|remastered|version|hd|4k|visualizer|explicit|prod\.).*?[)\]]/gi, '')
      .replace(/\s*(?:feat\.|ft\.|featuring)\s+.*$/i, '')
      .trim();

    if (!cleanTitle) {
      cleanTitle = title.trim();
    }

    const combined = cleanArtist ? `${cleanArtist} ${cleanTitle}`.trim() : cleanTitle;
    return { cleanTitle, cleanArtist, combined };
  }

  public cleanTitle(title: string): string {
    return this.cleanSearchQuery(title).cleanTitle;
  }
}
