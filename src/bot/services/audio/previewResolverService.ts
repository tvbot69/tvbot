import { AppleMusicSearchApi } from '@applemusic/apis/appleMusicSearchApi';
import { DeezerApi } from '@deezer/apis/deezerApi';
import { SpotifyScraperService } from '../music/spotifyScraperService';
import { CacheService } from '../system/cacheService';
import { matchesTrackTitle } from '../artworkService';
import { Logger } from '@domain/logger';
import type { ITunesSearchResult } from '@applemusic/models/itunesModels';
import type { DeezerTrack } from '@deezer/models/deezerModels';

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
  /**
   * How long a resolved preview may be cached, by the rung that produced it.
   *
   * This used to be a flat 3600 for every source, which was correct for two of
   * the three and wrong for Deezer. Measured live: a Deezer preview URL carries
   * a signed token that **expires in ~907 seconds**, while an Apple
   * (`audio-ssl.itunes.apple.com`) and a Spotify (`p.scdn.co`) preview do not
   * expire at all. So 45 of every 60 cached minutes handed out a URL that 404s
   * on fetch, and the failure surfaces to the user as a preview button that
   * does nothing — an absence with no explanation, which is why the rung's
   * expiry is now part of the cache decision rather than a constant.
   *
   * 600s is deliberately well under the measured 907s. A shorter TTL costs one
   * extra search; a longer one serves a dead URL.
   */
  private static ttlForSource(result: ResolvedPreview): number {
    return result.source === 'deezer' ? PreviewResolverService.DEEZER_TTL_SECONDS : PreviewResolverService.STABLE_TTL_SECONDS;
  }

  private static readonly DEEZER_TTL_SECONDS = 600;
  private static readonly STABLE_TTL_SECONDS = 3600;

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

  /**
   * The track-name half of the chosen-row guard, and the reason a resolver in
   * this repo may not return a song the user did not ask for.
   *
   * The scorer already ranks candidates, and its track scoring runs at `+1000`
   * for a containment and `-1000` for a mismatch. `-1000` cannot push a row
   * below zero: a right-artist row that scores `+2000` for the artist and `-1000`
   * for the title lands at `+1000` and WINS. So `resolve('Radiohead','Creep')`
   * returned `{ trackName: 'Karma Police' }` with a working preview button — a
   * confidently wrong song, playable, presented as the right one.
   *
   * It reuses `artworkService`'s `matchesTrackTitle` rather than a second local
   * predicate, because that predicate is already the repo's calibrated answer to
   * "is this row the recording that was asked for": strict (never substring, so
   * "Song" cannot match "Song 2"), edition-tag-aware, and tolerant of the leading
   * date prefix DJ-pool rips carry. A second, looser copy is how two modules end
   * up disagreeing about the same catalogue row.
   *
   * A row carrying NO title is treated the way `validateArtist` treats an absent
   * artist: not evidence of a mismatch, and the mapping substitutes the requested
   * name. Pinned as characterisation in `previewResolverService.scoring.test.ts`.
   */
  private validateTrack(expected: string, actual: string | undefined, source: string): boolean {
    if (!actual) return true;
    if (matchesTrackTitle(actual, expected)) return true;
    Logger.debug(
      { expected, actual, source },
      '[PreviewResolver] refusing a candidate whose title is not the recording asked for',
    );
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
            // CORRECT AS IS: this whole block is an optional second chance at
            // enriching a preview the scraper already found. Losing the id
            // lookup leaves `sp` as it was, and the outer block either
            // publishes it or falls through to Apple/Deezer below.
          } catch { /* ignore */ }
        }
        if (sp?.previewUrl && !this.validateTrack(track, sp.trackName, 'spotify')) {
          // A preview the scraper attributed to the right artist but the wrong
          // recording. Falling through to Apple/Deezer is strictly better than
          // handing the user a button that plays a different song.
          sp = null;
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
          await this.cache.set(key, result, PreviewResolverService.ttlForSource(result));
          return result;
        }
      } catch {
        // CORRECT AS IS: the Spotify rung failing is the rung failing.
        // Execution continues to the Apple search below and then Deezer,
        // and if BOTH of those come back empty `resolve` returns null,
        // which trackDetailsService renders as "no preview resolved" — an
        // absence, not a claim that the track has no preview anywhere.
      }
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
        // CORRECT AS IS: enrichment of an already-resolved result. A throw
        // leaves previewUrl null, and the cross-provider block right below
        // still runs — so this is a rung being skipped, not a track being
        // reported as having no preview.
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

    if (result) await this.cache.set(key, result, PreviewResolverService.ttlForSource(result));
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
      const scored = data.map((item: ITunesSearchResult, idx: number) => {
        const resTrack = (item.trackName ?? '').toLowerCase();
        const resArt = (item.artistName ?? '').toLowerCase();
        const resColl = (item.collectionName ?? '').toLowerCase();
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
      const valid = scored.filter((r) => r.score >= 0);
      if (valid.length === 0) return null;
      valid.sort((a, b) => b.score - a.score);
      const chosen = valid[0]!.item;
      if (!chosen) return null;
      // Extra guard: reject if artist validation fails
      if (!this.validateArtist(artist, chosen.artistName ?? '')) return null;
      if (!this.validateTrack(track, chosen.trackName, 'apple')) return null;
      return {
        trackName: chosen.trackName ?? track,
        artistName: chosen.artistName ?? artist,
        albumName: chosen.collectionName ?? null,
        // trackTimeMillis is a NUMBER in the iTunes response, measured. The
      // Number() was defensive against a type that did not exist yet.
      durationMs: chosen.trackTimeMillis ?? 0,
        previewUrl: chosen.previewUrl ?? null,
        storeUrl: chosen.trackViewUrl ?? null,
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
      const scored = results.map((item: DeezerTrack) => {
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
      const valid = scored.filter((r) => r.score >= 0);
      if (valid.length === 0) return null;
      valid.sort((a, b) => b.score - a.score);
      const chosen = valid[0]!.item;
      if (!chosen) return null;
      if (!this.validateArtist(artist, chosen.artist?.name ?? '')) return null;
      if (!this.validateTrack(track, chosen.title, 'deezer')) return null;
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
