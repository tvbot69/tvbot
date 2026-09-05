import { Logger } from '@domain/logger';
import { EssentiaService } from './essentiaService';
import { getAudioSignalAndSr } from './audioSignalService';
import { PreviewResolverService, type ResolvedPreview } from './previewResolverService';
import type { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import { previewMap } from './voiceMessageService';

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatKey(key: string): string {
  const map: Record<string, string> = { A: 'A', Bb: 'A#', B: 'B', C: 'C', Db: 'C#', D: 'D', Eb: 'D#', E: 'E', F: 'F', Gb: 'F#', G: 'G', Ab: 'G#' };
  return map[key] ?? key;
}

export interface TrackDetailsResult {
  trackName: string;
  artistName: string;
  durationMs: number;
  durationFormatted: string;
  bpm: number | null;
  key: string | null;
  previewUrl: string | null;
  storeUrl: string | null;
  artworkUrl: string | null;
  spotifyUrl: string | null;
  resolved: ResolvedPreview | null;
}

export class TrackDetailsService {
  constructor(
    private readonly previewResolver: PreviewResolverService,
    private readonly essentia: EssentiaService,
    private readonly spotifyApi?: SpotifySearchApi,
  ) {}

  public async getDetails(artist: string, track: string, uniqueId: string, albumHint?: string): Promise<TrackDetailsResult> {
    const resolved = await this.previewResolver.resolve(artist, track, albumHint);
    if (!resolved) {
      return { trackName: track, artistName: artist, durationMs: 0, durationFormatted: '0:00', bpm: null, key: null, previewUrl: null, storeUrl: null, artworkUrl: null, spotifyUrl: null, resolved: null };
    }

    if (resolved.previewUrl && uniqueId) {
      previewMap.set(uniqueId, resolved.previewUrl);
    }

    let bpm: number | null = null;
    let key: string | null = null;

    if (resolved.previewUrl && this.essentia.isAvailable()) {
      try {
        const { signal } = await getAudioSignalAndSr(uniqueId, resolved.previewUrl);
        const feats = this.essentia.analyze(signal);
        if (feats) {
          bpm = feats.bpm;
          key = feats.key !== 'N/A' ? formatKey(feats.key) : null;
        }
      } catch (err) {
        Logger.warn({ err }, '[TrackDetails] essentia analysis failed');
      }
    }

    // Resolve Spotify URL via Spotify service (single responsibility) — prefer scraper's spotifyUrl if source=spotify
    let spotifyUrl: string | null = null;
    if (resolved.source === 'spotify' && resolved.storeUrl?.includes('spotify.com')) {
      spotifyUrl = resolved.storeUrl;
    } else if (this.spotifyApi) {
      spotifyUrl = await this.spotifyApi.getSpotifyTrackUrl(resolved.artistName, resolved.trackName);
    }
    if (!spotifyUrl && resolved.storeUrl?.includes('spotify.com')) spotifyUrl = resolved.storeUrl;

    return {
      trackName: resolved.trackName,
      artistName: resolved.artistName,
      durationMs: resolved.durationMs ?? 0,
      durationFormatted: formatDuration(resolved.durationMs ?? 0),
      bpm,
      key,
      previewUrl: resolved.previewUrl,
      storeUrl: resolved.storeUrl,
      artworkUrl: resolved.artworkUrl,
      spotifyUrl,
      resolved,
    };
  }
}
