import { injectable, inject } from 'tsyringe';
import { CacheService } from './cacheService';
import { Logger } from '@domain/logger';

export interface MusicBrainzArtistData {
  mbid?: string;
  location?: string;
  countryCode?: string;
  type?: string;
  gender?: string;
  disambiguation?: string;
  birthDate?: number; // unix epoch timestamp in seconds
  links: {
    spotify?: string;
    appleMusic?: string;
    instagram?: string;
    twitter?: string;
    bandcamp?: string;
    deezer?: string;
    youtube?: string;
    lastfm?: string;
  };
}

const CACHE_TTL_SECONDS = 86400 * 30; // 30 days

@injectable()
export class MusicBrainzService {
  constructor(@inject(CacheService) private readonly cache: CacheService) {}

  public async getArtistData(artistName: string): Promise<MusicBrainzArtistData | null> {
    const cacheKey = `mb:artist:${artistName.toLowerCase()}`;
    const cached = await this.cache.get<MusicBrainzArtistData>(cacheKey);
    if (cached) return cached;

    try {
      // 1) Search artist
      const searchUrl = `https://musicbrainz.org/ws/2/artist?query=artist:${encodeURIComponent(`"${artistName}"`)}&fmt=json&limit=3`;
      const searchRes = await fetch(searchUrl, {
        headers: { 'User-Agent': 'tvbot/1.0.0 ( contact@tvbot.local )', Accept: 'application/json' },
      });

      if (!searchRes.ok) return null;
      const searchJson = (await searchRes.json()) as any;
      const artists = searchJson.artists as any[];
      if (!artists || artists.length === 0) return null;

      const exact = artists.find(a => a.name.toLowerCase() === artistName.toLowerCase()) ?? artists[0]!;
      const mbid = exact.id;

      // 2) Lookup artist with URL relationships
      const lookupUrl = `https://musicbrainz.org/ws/2/artist/${mbid}?inc=url-rels&fmt=json`;
      const lookupRes = await fetch(lookupUrl, {
        headers: { 'User-Agent': 'tvbot/1.0.0 ( contact@tvbot.local )', Accept: 'application/json' },
      });

      if (!lookupRes.ok) return null;
      const lookupJson = (await lookupRes.json()) as any;

      const data: MusicBrainzArtistData = {
        mbid,
        location: lookupJson.area?.name || lookupJson['begin-area']?.name,
        countryCode: lookupJson.country,
        type: lookupJson.type,
        gender: lookupJson.gender,
        disambiguation: lookupJson.disambiguation,
        links: {},
      };

      if (lookupJson['life-span']?.begin) {
        const parsed = new Date(lookupJson['life-span'].begin);
        if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 1800) {
          data.birthDate = Math.floor(parsed.getTime() / 1000);
        }
      }

      const relations = lookupJson.relations as any[];
      if (Array.isArray(relations)) {
        for (const rel of relations) {
          const resource = rel.url?.resource as string;
          if (!resource) continue;

          if (resource.includes('spotify.com/artist/')) data.links.spotify = resource;
          else if (resource.includes('music.apple.com/')) data.links.appleMusic = resource;
          else if (resource.includes('instagram.com/')) data.links.instagram = resource;
          else if (resource.includes('twitter.com/') || resource.includes('x.com/')) data.links.twitter = resource;
          else if (resource.includes('bandcamp.com')) data.links.bandcamp = resource;
          else if (resource.includes('deezer.com/artist/')) data.links.deezer = resource;
          else if (resource.includes('youtube.com/')) data.links.youtube = resource;
          else if (resource.includes('last.fm/music/')) data.links.lastfm = resource;
        }
      }

      await this.cache.set(cacheKey, data, CACHE_TTL_SECONDS);
      return data;
    } catch (err) {
      Logger.debug({ err }, `MusicBrainz lookup failed for ${artistName}`);
      return null;
    }
  }
}
