/**
 * The Last.fm no-image placeholder, in one place.
 *
 * AGENTS.md golden rule 2 is explicit that this hash must never be re-inlined:
 * "The placeholder check lives in exactly one exported predicate -
 * isPlaceholderImageUrl - call it, never re-inline the hash."
 *
 * It lives here rather than in `artworkService` so that LOWER layers can call it
 * without importing `@bot/*`. `src/lastfm/converters/recentTrackConverter` was
 * reaching up into the artwork cascade - which drags in Spotify, Deezer, Apple,
 * the DB and the cache - purely to ask whether a string is a placeholder. That
 * is the dependency inversion the plan's 3.2 is about.
 *
 * `artworkService` re-exports this, so the ~20 existing call sites keep working
 * unchanged. One implementation, one predicate, no churn.
 */

/**
 * The cover Last.fm returns when an artist, album or track has no image.
 * A 1x1 GIF, identical for every such entity.
 */
const LASTFM_PLACEHOLDER_HASH = '2a96cbd8b46e442fc41c2b86b821562f';

/**
 * True when the URL is absent or is the Last.fm placeholder.
 *
 * Returns `true` for null/undefined/empty rather than `false`, so that callers
 * written as `!isPlaceholderImageUrl(url)` reject a missing URL instead of
 * treating it as real artwork. That asymmetry is deliberate and is the whole
 * reason this is one shared predicate.
 */
export const isPlaceholderImageUrl = (url?: string | null): boolean => {
  if (!url) return true;
  return url.includes(LASTFM_PLACEHOLDER_HASH);
};
