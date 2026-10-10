import type { Track } from 'moonlink.js';
import { cleanTrackTitle, singleArtistName } from '@domain/models/music/musicTrack';
import type { MusicQueueInfo } from '@domain/models/music/musicQueue';

/**
 * Pure helpers for the now-playing card fingerprint and the alternate-track
 * fallback ladder.
 *
 * Extracted from MusicHandler. Nothing here touches state, timers, or the
 * player — which is exactly why it could be lifted out whole with no risk.
 * `MusicHandler` keeps static delegates for both of these so the ~6 existing
 * read sites (including one in the test suite that reads the static off the
 * class) keep working unchanged.
 */

/**
 * Chapter part of the card fingerprint: title + the cover actually being
 * shown. Keying on the chapter title alone was not enough, because a cover
 * swap within one chapter (e.g. a late-resolving cover, or the held cover from
 * the previous song) is a visible change, and keying on `title~hasArt` alone
 * made every art swap look identical to the state already posted — the card
 * kept the previous song's cover indefinitely.
 */
export const chapterKeyFor = (
  chapter: { title: string; artworkUrl?: string | null } | null,
  shownCover: string | null,
): string => {
  if (!chapter) return 'none';
  return `${chapter.title}~${shownCover ?? ''}`;
};

/**
 * Visible card fingerprint: track, pause state, queue shape, karaoke
 * window and chapter. On-demand publishes edit only on change; trackStart
 * syncs it to the posted card so a same-track re-post neither double-
 * publishes identical state nor suppresses the next real change.
 */
export const fingerprintFor = (queue: MusicQueueInfo, lyricKey: string, chapterKey: string): string =>
  [
    queue.current?.identifier ?? queue.current?.uri ?? 'none',
    queue.isPaused ? 'p' : 'r',
    queue.tracks.length,
    queue.loopMode,
    queue.volume,
    lyricKey,
    chapterKey,
  ].join('|');

/**
 * Low-noise "Artist - Title" query for a fallback search. Loud titles
 * "(from GTAVI: The Album)" in the title) and full-noise queries return zero
 * SoundCloud hits. First billed artist + bracket-stripped title matches far better.
 */
export const buildFallbackQuery = (track: Track | null | undefined): string | null => {
  if (!track?.title || !track?.author) return null;
  const firstArtist = singleArtistName(track.author) || track.author;
  const strippedTitle =
    cleanTrackTitle(track.title, track.author)
      .replace(/\s*[([{\u3010].*?[)\]}\u3011]\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim() || track.title;
  return `${firstArtist} - ${strippedTitle}`;
};

/**
 * Compacts a Moonlink track exception into one log line per client
 * ("ANDROID_VR: requires login | WEB: no supported audio streams").
 * The old 300-char truncation hid every client except the first.
 */
export const clientFailuresText = (reason: unknown): string => {
  const text = typeof reason === 'string' ? reason : String(reason ?? '');
  const hits = [...text.matchAll(/Client \[(\w+)\] failed: ([^\r\n]+)/g)].map(
    (m) => `${m[1] ?? '?'}: ${(m[2] ?? '').trim().replace(/\.$/, '')}`,
  );
  return hits.length > 0 ? hits.join(' | ') : text.slice(0, 200);
};
