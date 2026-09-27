/**
 * iTunes Search API response shapes.
 *
 * The field list was measured against the live endpoint rather than assumed:
 * `GET /itunes.apple.com/search?entity=song` returns 31 fields, listed in
 * ITunesSearchResult below. Only the ones this bot reads are declared, but the
 * names are exactly what the API sends.
 */

/** One `results[]` entry from a song (or album/artist) search. */
export interface ITunesSearchResult {
  artistId?: number;
  artistName?: string;
  artistViewUrl?: string;
  trackName?: string;
  /** Present on album results, absent on some song results. */
  collectionName?: string;
  collectionViewUrl?: string;
  trackViewUrl?: string;
  artworkUrl100?: string;
  wrapperType?: string;
  kind?: string;
  /**
   * The 30-second AAC preview URL, when Apple offers one.
   *
   * Added because the preview resolver reads it and the type did not have it,
   * which is why that call site was `any`. It is genuinely optional: a large
   * share of catalogue entries have no preview at all, and some are region
   * locked, so `undefined` is the normal case rather than an edge case.
   */
  previewUrl?: string;
  /**
   * Track length in MILLISECONDS - a number, not a string.
   *
   * Worth stating because every other count in this codebase arrives from an
   * XML or JSON API as a string and needs coercing, so the instinct is to wrap
   * this in `Number()` too. Harmless, but it hid the fact that the declared
   * type was missing.
   */
  trackTimeMillis?: number;
  trackCount?: number;
  discCount?: number;
  primaryGenreName?: string;
  releaseDate?: string;
  country?: string;
  isStreamable?: boolean;
}

/** The envelope: `results` plus the count. */
export interface ITunesSearchResponse {
  resultCount?: number;
  results?: ITunesSearchResult[];
}
