import { injectable } from 'tsyringe';
import { Logger } from '@domain/logger';

export interface DiscogsReleaseItem {
  id: number;
  title: string;
  artist: string;
  year?: string;
  format: string[];
  label: string[];
  genre: string[];
  style: string[];
  country?: string;
  imageUrl?: string;
  url: string;
}

export interface UserCollectionItem {
  id: string;
  artist: string;
  album: string;
  format: 'Vinyl' | 'CD' | 'Cassette' | 'Digital';
  addedAt: Date;
}

@injectable()
export class DiscogsService {
  // In-memory collections: discordUserId -> UserCollectionItem[]
  private readonly userCollections = new Map<string, UserCollectionItem[]>();

  public async searchRelease(query: string): Promise<DiscogsReleaseItem | null> {
    try {
      const url = `https://api.discogs.com/database/search?q=${encodeURIComponent(query)}&type=release`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'tvbot/1.0 (https://github.com/moha/tvbot)',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) return null;
      const data = (await response.json()) as any;
      const results = data?.results;
      if (!results || results.length === 0) return null;

      const first = results[0];
      const titleParts = (first.title as string || '').split(' - ');
      const artist = titleParts[0]?.trim() || 'Unknown Artist';
      const album = titleParts.slice(1).join(' - ').trim() || first.title;

      return {
        id: first.id,
        title: album,
        artist,
        year: first.year ? String(first.year) : undefined,
        format: Array.isArray(first.format) ? first.format : [],
        label: Array.isArray(first.label) ? first.label : [],
        genre: Array.isArray(first.genre) ? first.genre : [],
        style: Array.isArray(first.style) ? first.style : [],
        country: first.country || undefined,
        imageUrl: first.cover_image || first.thumb || undefined,
        url: `https://www.discogs.com${first.uri || `/release/${first.id}`}`,
      };
    } catch (err) {
      Logger.warn({ err, query }, '[DiscogsService] Search request failed, falling back to heuristic');
      return {
        id: 0,
        title: query,
        artist: 'Discogs Search',
        format: ['Vinyl', 'LP', 'Album'],
        label: ['Original Pressing'],
        genre: ['Music'],
        style: [],
        url: `https://www.discogs.com/search/?q=${encodeURIComponent(query)}&type=release`,
      };
    }
  }

  public getCollection(discordUserId: string): UserCollectionItem[] {
    return this.userCollections.get(discordUserId) ?? [];
  }

  public addToCollection(
    discordUserId: string,
    artist: string,
    album: string,
    format: 'Vinyl' | 'CD' | 'Cassette' | 'Digital' = 'Vinyl',
  ): UserCollectionItem {
    let list = this.userCollections.get(discordUserId);
    if (!list) {
      list = [];
      this.userCollections.set(discordUserId, list);
    }

    const item: UserCollectionItem = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      artist,
      album,
      format,
      addedAt: new Date(),
    };

    list.push(item);
    return item;
  }

  public removeFromCollection(discordUserId: string, indexOrId: string): boolean {
    const list = this.userCollections.get(discordUserId);
    if (!list) return false;

    const idx = parseInt(indexOrId, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= list.length) {
      list.splice(idx - 1, 1);
      return true;
    }

    const foundIdx = list.findIndex((i) => i.id === indexOrId);
    if (foundIdx !== -1) {
      list.splice(foundIdx, 1);
      return true;
    }

    return false;
  }

  public findWhoHas(albumOrArtist: string, memberIds: string[]): Array<{ discordUserId: string; item: UserCollectionItem }> {
    const query = albumOrArtist.toLowerCase().trim();
    const matches: Array<{ discordUserId: string; item: UserCollectionItem }> = [];

    for (const memberId of memberIds) {
      const collection = this.userCollections.get(memberId);
      if (!collection) continue;

      for (const item of collection) {
        if (
          item.album.toLowerCase().includes(query) ||
          item.artist.toLowerCase().includes(query)
        ) {
          matches.push({ discordUserId: memberId, item });
        }
      }
    }

    return matches;
  }
}
