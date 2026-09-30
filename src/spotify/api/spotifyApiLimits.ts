/**
 * MEASURED ceilings for the Spotify parameters this bot builds by hand.
 *
 * Read this before changing any number below. All three contradict Spotify's
 * published Web API reference, and every one of them was found the same way: an
 * over-limit request came back as a *plausible* result rather than an obvious
 * error, so a real capability was missing with nothing red in the logs.
 *
 * Measured live against `https://api.spotify.com` with client-credentials on
 * 2026-09-30, using artist `4Z8W4fKeB5YxbusRsdQVPb`:
 *
 *   GET /v1/artists/{id}/albums?include_groups=album,single,appears_on
 *     limit=9  -> 200, 9 items
 *     limit=10 -> 200, 10 items
 *     limit=11 -> 400 {"error":{"status":400,"message":"Invalid limit"}}
 *     limit=15 -> 400 "Invalid limit"
 *     limit=50 -> 400 "Invalid limit"
 *   The published docs say 50. The server says 10. Trust the server.
 *   `include_groups=album,single,appears_on` was probed separately at limit=10
 *   -> 200, so the 400 is the limit alone and the group filter is valid.
 *
 *   GET /v1/search?q=...&type=track
 *     limit=9  -> 200
 *     limit=10 -> 200
 *     limit=11 -> 400 "Invalid limit"
 *     limit=15 -> 400 "Invalid limit"
 *     limit=50 -> 400 "Invalid limit"
 *
 *   GET /v1/search q length, RAW characters before URL encoding, limit=5
 *     250 -> 200
 *     251 -> 400 {"error":{"status":400,"message":"Query exceeds maximum length"}}
 *
 * Why this mattered: `getArtistDiscographyCovers` sent limit=15, and both
 * collage builders (`whoKnowsImageBuilder` and `topBuilders`) ask for 15. Every
 * Spotify rung of every artist mosaic the bot has ever rendered therefore got a
 * 400 and then answered `[]` — byte-identical to "this artist has no covers".
 *
 * Do not "restore" 50 because the documentation says 50. That was the bug.
 */

/** `/v1/search` — the largest `limit` the server accepts. */
export const SPOTIFY_SEARCH_LIMIT_MAX = 10;

/** `/v1/artists/{id}/albums` — the largest `limit` the server accepts. */
export const SPOTIFY_ARTIST_ALBUMS_LIMIT_MAX = 10;

/** `/v1/search` — the largest raw `q` length, counted before URL encoding. */
export const SPOTIFY_SEARCH_QUERY_MAX = 250;

/**
 * A clamp that is TOTAL, because a partial one reproduces the bug it prevents.
 * Measured: limit=0, limit=-1, limit=1.5 and limit=abc each return 400 "Invalid
 * limit", so every int-ish input is a rejection waiting to happen. NaN and
 * Infinity included, since a caller computing a limit from data can produce both.
 */
const clampLimit = (limit: number, max: number): number => {
  if (!Number.isFinite(limit)) return 1;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
};

/** Clamps a `/v1/search` `limit` into the range the server accepts. */
export const clampSpotifySearchLimit = (limit: number): number =>
  clampLimit(limit, SPOTIFY_SEARCH_LIMIT_MAX);

/** Clamps a `/v1/artists/{id}/albums` `limit` into the range the server accepts. */
export const clampSpotifyArtistAlbumsLimit = (limit: number): number =>
  clampLimit(limit, SPOTIFY_ARTIST_ALBUMS_LIMIT_MAX);
