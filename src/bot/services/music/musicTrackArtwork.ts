import type { Track } from 'moonlink.js';
import { Logger } from '@domain/logger';
import { isYoutubeThumbUrl } from '@domain/models/music/musicTrack';
import type { ArtworkService } from '@bot/services/artworkService';
import { extractArtistFromTitle } from './videoChapters';
import { SpotifySearchApi } from '@spotify/api/spotifySearchApi';
import type { SpotifyResolver } from './spotifyResolver';
import type { PendingQueueView } from './musicTypes';

/** Artwork backfill must never stall resolution: cold provider cascades take seconds. */
export const ARTWORK_TIMEOUT_MS = 6000;
/** Background paths (JIT top-up, warmup) can afford to wait out slow cascades. */
export const BACKGROUND_ARTWORK_TIMEOUT_MS = 10000;

/** True for raw YouTube-family thumbnails (never correct on adopted tracks). */
export const isYoutubeThumb = (url: string | null | undefined): boolean => isYoutubeThumbUrl(url);

/**
 * Artwork pre-clean (single choke point, also used by the direct URL
 * path): stamp a known-good cover, or drop a raw YouTube thumbnail so a
 * later backfill cascade fills real art instead of skipping on it. Only
 * long-form content (>20min) additionally stashes the video thumbnail —
 * that stash is the sole entry into the long-form video-art system
 * (square rug crop → card paint). Short tracks never enter it: no video
 * thumb, no crop downloads — cascade art only.
 *
 * A YouTube thumbnail passed AS the trusted cover (search picks carry the
 * Lavalink hit's ytimg art as their override) is treated as absent: it is
 * never stamped, so backfill/enrichment still run. Stamping it would
 * permanently paint the card with a video frame instead of the song cover.
 */
export const preCleanArtwork = (
  track: { artworkUrl?: string | null; duration?: number | null },
  artworkUrl?: string | null,
): void => {
  if (artworkUrl && !isYoutubeThumb(artworkUrl)) track.artworkUrl = artworkUrl;
  else if (isYoutubeThumb(track.artworkUrl)) track.artworkUrl = null;
};

/**
 * Drops a YouTube-thumbnail artworkUrl from a play override. Overrides are
 * trusted downstream (they skip backfill AND Spotify enrichment), so a
 * ytimg URL smuggled in as "known art" — the +search select path — would
 * paint video frames on the card forever. Applied once at play() entry so
 * every downstream path (ladder, adopt, backfill, domain) treats the art
 * as unknown and resolves the real cover.
 */
export const sanitizeOverride = <T extends { artworkUrl?: string } | undefined>(override: T): T => {
  if (override?.artworkUrl && isYoutubeThumb(override.artworkUrl)) {
    Logger.debug('[Music] Dropping YouTube-thumbnail override art — resolving the real cover instead');
    const { artworkUrl: _dropped, ...rest } = override;
    return rest as T;
  }
  return override;
};

/**
 * First billed artist for profile-picture fallback ("A, B & C feat. D" →
 * "A"). Channel suffixes ("X - Topic", "X VEVO") are stripped — uploads
 * come from auto-generated topic channels as often as from the artist.
 * Mirrors the fallback-query artist logic.
 */
export const leadArtist = (artist: string): string => {
  const first = artist.split(/[,/&]/)[0] ?? '';
  return first
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*VEVO$/i, '')
    .replace(/\s+(feat\.?|ft\.?|featuring|with|x)\s+.*$/i, '')
    .trim();
};

/**
 * Artwork backfill, cascade lookup and upcoming-track warmup.
 *
 * Extracted from MusicService. Owns only its own dedupe set plus the
 * card-refresh notifier; it reads the pending queue through the injected
 * port so it never needs a reference to the playback service itself.
 */
export class MusicTrackArtwork {
  /** Upcoming entries with a warmup cascade already in flight (dedupes overlap). */
  private readonly artWarmKeys = new Set<string>();
  /** Wired at startup — repaints the event-driven card when backfill lands art. */
  private cardRefreshNotifier: ((guildId: string) => void) | null = null;

  private readonly artworkService: ArtworkService | undefined;

  public constructor(
    artworkService: ArtworkService | undefined,
    private readonly spotifyResolver: SpotifyResolver,
    private readonly pending: PendingQueueView,
  ) {
    this.artworkService = artworkService;
  }

  /** Wired at startup — repaints the event-driven card when backfill lands art. */
  public setCardRefreshNotifier(notifier: (guildId: string) => void): void {
    this.cardRefreshNotifier = notifier;
  }

  private notifyCardArt(guildId?: string): void {
    if (!guildId) return;
    try {
      this.cardRefreshNotifier?.(guildId);
    } catch {
      // A card repaint must never break the resolution that triggered it.
    }
  }

  /** Spotify track ID from a spotify: URI or open.spotify URL (track type only). */
  public spotifyTrackId(uri?: string | null): string | undefined {
    if (!uri) return undefined;
    try {
      const parsed = this.spotifyResolver.parseSpotifyUrl(uri);
      return parsed?.type === 'track' ? parsed.id : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Backfills a missing track cover through ArtworkService (Spotify →
   * Deezer → Apple → Last.fm cascade, strict artist+title matching).
   * Only fires when NEITHER the raw track NOR the known Spotify art has a
   * URL — hot paths (API tracks with art, YouTube hits with thumbs) return
   * synchronously free. Timeout-guarded and catch-all: art must never break
   * or stall playback resolution.
   */
  public async maybeBackfillArt(
    track: Track,
    knownArtworkUrl?: string,
    title?: string,
    artist?: string,
    timeoutMs: number = ARTWORK_TIMEOUT_MS,
    spotifyUri?: string | null,
    notifyGuildId?: string,
  ): Promise<void> {
    try {
      if (!track || track.artworkUrl || knownArtworkUrl) return;
      const t = (title || track.title)?.trim();
      const a = (artist || track.author)?.trim();
      if (!t || !a) return;
      const started = Date.now();
      const trackRec = track as unknown as Record<string, unknown>;
      trackRec._artLookupStartedAt = started;
      const dur = track.duration || 0;
      const svc = this.artworkService;
      if (!svc) {
        Logger.debug('[Music] Artwork backfill skipped — no artwork service wired');
        return;
      }
      Logger.info(
        { title: t, artist: a, timeoutMs, durationMs: dur },
        '[Music] Artwork lookup start',
      );
      // Never-rejecting lookup: exact by-ID first (no matching risk), then
      // the name cascade, then the artist profile picture. One slow leg
      // can't hang the race.
      const lookup: Promise<string | null> = (async () => {
        try {
          const id = this.spotifyTrackId(spotifyUri);
          if (id) {
            const byId = await svc.getTrackCoverBySpotifyId(id);
            if (byId) return byId;
          }
          const cover = await svc.getTrackCoverUrl(t, a);
          if (cover) return cover;
          // Artist fallback (live sets, bootlegs, cover-less tracks): the
          // artist's profile picture beats a blank card. When the title
          // names the performer ("EsDeeKid - Live...") THAT is the search
          // target and the uploader channel is skipped entirely — channels
          // ("gloss") can strictly match same-named wrong artists.
          // Otherwise the billed author is tried as before.
          const titleLead = extractArtistFromTitle(t);
          const candidates =
            titleLead && titleLead.toLowerCase() !== leadArtist(a).toLowerCase() ? [titleLead] : [leadArtist(a)];
          for (const lead of candidates) {
            if (!lead) continue;
            const pic = await svc.getArtistImageUrl(lead, t).catch(() => null);
            if (pic) return pic;
          }
          return null;
        } catch {
          return null;
        }
      })();
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        });
        const url = await Promise.race([lookup, timeout]);
        if (url) {
          track.artworkUrl = url;
          trackRec._artLookupResolvedAt = Date.now();
          trackRec._artLookupOutcome = 'hit';
          Logger.info(
            { title: t, artist: a, resolveMs: Date.now() - started },
            '[Music] Artwork backfilled',
          );
          this.notifyCardArt(notifyGuildId);
        } else {
          trackRec._artLookupOutcome = 'miss';
          Logger.debug(
            { title: t, artist: a, resolveMs: Date.now() - started },
            '[Music] Artwork backfill miss',
          );
          // Late attach: the race abandons slow lookups but doesn't cancel
          // them — the cascade still finishes and caches. If art arrives
          // after the timeout and the track is still bare, take it and
          // refresh the event-driven card so it shows up.
          void lookup
            .then((late) => {
              if (late && !track.artworkUrl) {
                track.artworkUrl = late;
                const lateMs = Date.now() - started;
                trackRec._artLookupResolvedAt = Date.now();
                trackRec._artLookupOutcome = 'late-hit';
                Logger.info({ title: t, artist: a, resolveMs: lateMs }, '[Music] Artwork late-attached');
                this.notifyCardArt(notifyGuildId);
              }
            })
            .catch(() => undefined);
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch {
      // ignore — playback without art beats no playback
    }
  }

  /**
   * Warms the artwork memory cache for the next couple of unresolved entries
   * so their resolve-time backfill usually hits cache instead of racing
   * providers. Bounded, deduped in-flight, timeout-guarded, silent — and
   * skipped entirely while Spotify is rate-limited, so warmup never spends
   * quota the resolvers need.
   */
  public warmUpcomingArt(guildId: string): void {
    if (!this.artworkService) return;
    if (SpotifySearchApi.isRateLimited()) return;
    const pending = this.pending.get(guildId);
    if (!pending || pending.length === 0) return;
    for (const entry of pending.slice(0, 2)) {
      // Entries that already carry art need no lookup — adoption sets it.
      if (entry.spTrack.artworkUrl || entry.override?.artworkUrl) continue;
      const key = `${entry.spTrack.artist} - ${entry.spTrack.name}`.toLowerCase();
      if (this.artWarmKeys.has(key)) continue;
      this.artWarmKeys.add(key);
      void (async () => {
        let timer: NodeJS.Timeout | undefined;
        try {
          const svc = this.artworkService!;
          const run: Promise<string | null> = (async () => {
            try {
              const id = this.spotifyTrackId(entry.spTrack.spotifyUri);
              if (id) {
                const byId = await svc.getTrackCoverBySpotifyId(id);
                if (byId) return byId;
              }
              return await svc.getTrackCoverUrl(entry.spTrack.name, entry.spTrack.artist);
            } catch {
              return null;
            }
          })();
          const timeout = new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), BACKGROUND_ARTWORK_TIMEOUT_MS);
          });
          await Promise.race([run, timeout]);
        } catch {
          // ignore — resolve-time backfill remains the safety net
        } finally {
          if (timer) clearTimeout(timer);
          this.artWarmKeys.delete(key);
        }
      })();
    }
  }
}
