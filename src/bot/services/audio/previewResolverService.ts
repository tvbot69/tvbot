import { AppleMusicSearchApi } from '@applemusic/apis/appleMusicSearchApi';
import { DeezerApi } from '@deezer/apis/deezerApi';
import { SpotifyScraperService } from '../music/spotifyScraperService';
import { CacheService } from '../cacheService';
import { Logger } from '@domain/logger';

export interface ResolvedPreview {
  trackName: string;
  artistName: string;
  albumName: string | null;
  durationMs: number;
  previewUrl: string | null;
  storeUrl: string | null;
  artworkUrl: string | null;
  source: 'spotify' | 'apple' | 'deezer';
}

export class PreviewResolverService {
  constructor(
    private readonly appleApi: AppleMusicSearchApi,
    private readonly deezerApi: DeezerApi,
    private readonly cache: CacheService,
    private readonly spotifyScraper?: SpotifyScraperService,
    private readonly spotifyApi?: import('@spotify/api/spotifySearchApi').SpotifySearchApi,
  ) {}

  private cacheKey(artist: string, track: string): string {
    return `preview:v3:${artist.toLowerCase()}|${track.toLowerCase()}`;
  }

  private clean(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private validateArtist(expected: string, actual: string): boolean {
    const clean = (n: string) => n.toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}\p{N}]/gu, '');
    const e = clean(expected);
    const a = clean(actual);
    if (e === a) return true;
    if (e.length > 3 && (a.includes(e) || e.includes(a))) return true;
    return false;
  }

  public async resolve(artist: string, track: string, albumHint?: string): Promise<ResolvedPreview | null> {
    const key = this.cacheKey(artist, track);
    const cached = await this.cache.get<ResolvedPreview>(key);
    if (cached) return cached;

    // Spotify scraper first — p.scdn.co preview (silent, no logs)
    if (this.spotifyScraper) {
      try {
        let sp = await this.spotifyScraper.getTrackPreview(artist, track);
        if (!sp?.previewUrl && this.spotifyApi) {
          try {
            const spotifyUrl = await this.spotifyApi.getSpotifyTrackUrl(artist, track);
            const idMatch = spotifyUrl?.match(/track\/([a-zA-Z0-9]+)/);
            if (idMatch?.[1]) sp = await this.spotifyScraper.getPreviewById(idMatch[1]);
          } catch { /* ignore */ }
        }
        if (sp?.previewUrl) {
          const result: ResolvedPreview = {
            trackName: sp.trackName,
            artistName: sp.artistName,
            albumName: null,
            durationMs: sp.durationMs ?? 0,
            previewUrl: sp.previewUrl,
            storeUrl: sp.spotifyUrl ?? `https://open.spotify.com/search/${encodeURIComponent(`${artist} ${track}`)}`,
            artworkUrl: sp.artworkUrl ?? null,
            source: 'spotify',
          };
          await this.cache.set(key, result, 3600);
          return result;
        }
      } catch { /* silent miss */ }
    }

    let result = await this.searchApple(artist, track, albumHint);
    if (!result) result = await this.searchDeezer(artist, track, albumHint);

    if (result && !result.previewUrl && this.spotifyScraper) {
      try {
        let sp = await this.spotifyScraper.getTrackPreview(result.artistName, result.trackName);
        if (!sp?.previewUrl && this.spotifyApi) {
          const u = await this.spotifyApi.getSpotifyTrackUrl(result.artistName, result.trackName);
          const m = u?.match(/track\/([a-zA-Z0-9]+)/);
          if (m?.[1]) sp = await this.spotifyScraper.getPreviewById(m[1]);
        }
        if (sp?.previewUrl) {
          result.previewUrl = sp.previewUrl;
          if (!result.storeUrl) result.storeUrl = sp.spotifyUrl ?? result.storeUrl;
        }
      } catch { /* ignore */ }
    }
    if (result && !result.previewUrl) {
      const fallback = result.source === 'apple'
        ? await this.searchDeezer(result.artistName, result.trackName)
        : await this.searchApple(result.artistName, result.trackName, result.albumName ?? undefined);
      if (fallback?.previewUrl) {
        result.previewUrl = fallback.previewUrl;
        if (!result.storeUrl) result.storeUrl = fallback.storeUrl;
      }
    }

    if (result) await this.cache.set(key, result, 3600);
    return result;
  }

  private async searchApple(artist: string, track: string, albumHint?: string): Promise<ResolvedPreview | null> {
    try {
      const data = await this.appleApi.searchSongs(track, artist);
      if (!data || data.length === 0) return null;
      const cleanArtist = this.clean(artist);
      const cleanTrack = this.clean(track);
      const cleanQuery = this.clean(`${artist} ${track}`);
      const cleanAlbumHint = albumHint ? this.clean(albumHint) : '';
      const scored = data.map((item: any, idx: number) => {
        const resTrack = (item.trackName ?? '').toLowerCase();
        const resArt = (item.artistName ?? '').toLowerCase();
        const resColl = ((item as any).collectionName ?? '').toLowerCase();
        const combined = `${resArt} ${resTrack}`;
        const cResArt = this.clean(resArt);
        const cResTrack = this.clean(resTrack);
        const cCombined = this.clean(combined);
        let score = 0;
        if (cCombined === cleanQuery) score += 5000;
        if (cResTrack === cleanTrack && cResArt === cleanArtist) score += 4000;
        if (cResArt === cleanArtist) score += 2000;
        if (resArt.includes(artist.toLowerCase())) score += 1000;
        let trackMatchScore = 0;
        if (cResTrack === cleanTrack) trackMatchScore += 1000;
        if (resTrack.includes(track.toLowerCase()) || track.toLowerCase().includes(resTrack)) trackMatchScore += 500;
        if (cResTrack.includes(cleanTrack) || cleanTrack.includes(cResTrack)) trackMatchScore += 500;
        score += trackMatchScore;
        if (artist.toLowerCase().includes('baba') && !resArt.includes('baba')) score -= 5000;
        if (cleanArtist && cResArt !== cleanArtist && !resArt.includes(artist.toLowerCase()) && !artist.toLowerCase().includes(resArt)) {
          if (cResTrack !== cleanTrack) return { item, score: -1 };
          score -= 2000;
        }
        if (cleanTrack && trackMatchScore === 0) {
          if (cResArt === cleanArtist) score -= 1000;
          else return { item, score: -1 };
        }
        if (cleanAlbumHint && resColl) {
          const cResColl = this.clean(resColl);
          if (cResColl === cleanAlbumHint) score += 3500;
          else if (cResColl.includes(cleanAlbumHint) || cleanAlbumHint.includes(cResColl)) score += 1500;
        }
        const querySymbols = (artist + track).replace(/[a-z0-9\s]/g, '');
        const resSymbols = (resArt + resTrack + resColl).replace(/[a-z0-9\s]/g, '');
        if (querySymbols && resSymbols.includes(querySymbols)) score += 800;
        score += (15 - idx) * 10;
        return { item, score };
      });
      const valid = scored.filter((r: any) => r.score >= 0);
      if (valid.length === 0) return null;
      valid.sort((a: any, b: any) => b.score - a.score);
      const chosen = valid[0]!.item;
      if (!chosen) return null;
      // Extra guard: reject if artist validation fails
      if (!this.validateArtist(artist, chosen.artistName ?? '')) return null;
      return {
        trackName: chosen.trackName ?? track,
        artistName: chosen.artistName ?? artist,
        albumName: (chosen as any).collectionName ?? null,
        durationMs: Number((chosen as any).trackTimeMillis ?? 0),
        previewUrl: (chosen as any).previewUrl ?? null,
        storeUrl: (chosen as any).trackViewUrl ?? null,
        artworkUrl: chosen.artworkUrl100 ? chosen.artworkUrl100.replace('100x100bb', '600x600bb') : null,
        source: 'apple',
      };
    } catch (err) {
      Logger.debug({ err }, '[PreviewResolver] Apple search failed');
      return null;
    }
  }

  private async searchDeezer(artist: string, track: string, albumHint?: string): Promise<ResolvedPreview | null> {
    try {
      const query = `${artist} ${track}`.trim();
      const results = await this.deezerApi.searchTracks(query, 50);
      if (!results || results.length === 0) return null;
      const cleanArtist = this.clean(artist);
      const cleanTrack = this.clean(track);
      const cleanAlbumHint = albumHint ? this.clean(albumHint) : '';
      const scored = results.map((item: any) => {
        const resTrack = (item.title ?? '').toLowerCase();
        const resArt = (item.artist?.name ?? '').toLowerCase();
        const resColl = (item.album?.title ?? '').toLowerCase();
        const cResArt = this.clean(resArt);
        const cResTrack = this.clean(resTrack);
        const cResColl = this.clean(resColl);
        let score = 0;
        if (cResArt === cleanArtist && cResTrack === cleanTrack) score += 5000;
        if (cResArt === cleanArtist) score += 2000;
        if (resArt.includes(artist.toLowerCase())) score += 1000;
        let trackMatchScore = 0;
        if (cResTrack === cleanTrack) trackMatchScore += 1000;
        if (resTrack.includes(track.toLowerCase()) || track.toLowerCase().includes(resTrack)) trackMatchScore += 500;
        if (cResTrack.includes(cleanTrack) || cleanTrack.includes(cResTrack)) trackMatchScore += 500;
        score += trackMatchScore;
        if (cleanTrack && trackMatchScore === 0) {
          if (cResArt === cleanArtist) score -= 1000;
          else return { item, score: -1 };
        }
        const querySymbols = (artist + track).replace(/[a-z0-9\s]/g, '');
        const resSymbols = (resArt + resTrack + resColl).replace(/[a-z0-9\s]/g, '');
        if (querySymbols && resSymbols.includes(querySymbols)) score += 800;
        if (cleanAlbumHint && cResColl) {
          if (cResColl === cleanAlbumHint) score += 3500;
          else if (cResColl.includes(cleanAlbumHint) || cleanAlbumHint.includes(cResColl)) score += 1500;
        }
        if (artist.toLowerCase().includes('baba') && !resArt.includes('baba')) score -= 5000;
        return { item, score };
      });
      const valid = scored.filter((r: any) => r.score >= 0);
      if (valid.length === 0) return null;
      valid.sort((a: any, b: any) => b.score - a.score);
      const chosen = valid[0]!.item;
      if (!chosen) return null;
      if (!this.validateArtist(artist, chosen.artist?.name ?? '')) return null;
      return {
        trackName: chosen.title ?? track,
        artistName: chosen.artist?.name ?? artist,
        albumName: chosen.album?.title ?? null,
        durationMs: Number(chosen.duration ?? 0) * 1000,
        previewUrl: chosen.preview ?? null,
        storeUrl: chosen.link ?? `https://www.deezer.com/track/${chosen.id}`,
        artworkUrl: chosen.album?.cover_xl ?? chosen.album?.cover_big ?? null,
        source: 'deezer',
      };
    } catch (err) {
      Logger.debug({ err }, '[PreviewResolver] Deezer search failed');
      return null;
    }
  }
}
