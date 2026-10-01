/**
 * MEASURED ceilings for the Spotify parameters this bot builds by hand.
 *
 * Read this before changing any number below. Every one of them was measured
 * against the live API, never read from Spotify's published Web API reference,
 * and the last author to write this file measured them WRONG by 5x. So the rule
 * is that a change here needs a fresh probe behind it, not a better memory: run
 * `scripts/liveVerify.ts`, which asks the vendor and exits non-zero when a claim
 * in this file turns out to be false.
 *
 * ## What the wrong probe cost
 *
 * An earlier version of this file (2026-09-30, an earlier run) concluded that
 * `/v1/search` and `/v1/artists/{id}/albums` reject `limit=11`, and it set both
 * ceilings to 10 under the sentence "The published docs say 50. The server says
 * 10. Trust the server." The docs were right and the probe was wrong. The
 * consequence was silent: the clamp turned every caller-supplied limit into 10,
 * so `getArtistDiscographyCovers('Radiohead', undefined, 15)` returned 10 covers
 * while both collage builders (`whoKnowsImageBuilder.ts:317`, `topBuilders.ts:86`)
 * ask for 15, and every Spotify search in the bot asked for at most 10 of the
 * results it could have had. Nothing above DEBUG said so. Two test files then
 * pinned the wrong number by NAME, which is how a confidently wrong constant
 * outlives the session that introduced it.
 *
 * ## OBSERVED 2026-09-30 — live, `https://api.spotify.com`, client-credentials
 *
 *   GET /v1/search?q=...&type=track
 *     limit=5   -> 200, 5 items       limit=10  -> 200, 10 items
 *   ...RE-ADJUDICATED 2026-10-01, and this record is what the re-measurement
 *   contradicted. Kept deliberately, because "we were wrong about this, here is
 *   exactly what we claimed and here is what the server does" is the only thing
 *   that stops the next person re-deriving it. Forward pass then REVERSE pass:
 *
 *     limit=1  -> 200, 1 item       limit=5   -> 200, 5 items
 *     limit=10 -> 200, 10 items     limit=11  -> 400 "Invalid limit"
 *     limit=15 -> 400 "Invalid limit"
 *     limit=20 -> 400 "Invalid limit"
 *     limit=50 -> 400 "Invalid limit"
 *     limit=51 -> 400 "Invalid limit"
 *     limit=100-> 400 "Invalid limit"
 *
 *   ...identical in both directions. 11/15/20/50 each produced a 400 four times
 *   across the two passes. The reverse pass matters: a rate-limit ramp
 *   degrades monotonically in one direction, and running the ladder backwards is
 *   what distinguishes a real ceiling from a ramp that happened to look like one.
 *
 *   The claim this replaces, which was WRONG:
 *     limit=11  -> 200, 11 items      limit=15  -> 200, 15 items
 *     limit=20  -> 200, 20 items      limit=50  -> 200, 50 items
 *     limit=51  -> 400 "Invalid limit"
 *   Six tests across three files asserted that version by name, which is how a
 *   wrong vendor claim survives a fully green suite: the tests agreed with the
 *   mistake, so nothing could contradict anything.

 *   GET /v1/artists/{id}/albums?include_groups=album,single,appears_on
 *     artist 4Z8W4fKeB5YxbusRsdQVPb (Radiohead), 60 releases in total
 *     limit=5  -> 200, 5 items       limit=9   -> 200, 9 items
 *     limit=10 -> 200, 10 items      limit=11  -> 400 "Invalid limit"
 *
 *   ...which is the ORIGINAL reading, and the only one this endpoint has ever
 *   returned twice. The claim that 15/20/50 were accepted came from the same
 *   probe run that got `/v1/search` wrong. The 2026-10-01 re-measurement could
 *   not reach this endpoint at all — every request came back 429
 *   QUOTA_EXCEEDED — so it is left at the value known to be accepted rather than
 *   the value last claimed, and flagged as needing a re-measurement.
 *
 *   GET /v1/albums/{id}/tracks   (a 199-track album)
 *     limit=50       -> 200, 50 items, "total": 199 — accepted AND honoured
 *     limit=100      -> 400 "Invalid limit"
 *     limit=0        -> 400 "Invalid limit"
 *     offset=999999  -> 200, 0 items, "next": null. Paging past the end is an
 *                       EMPTY PAGE, never a rejection, so an empty tracklist is
 *                       not evidence of a bad offset.
 *
 *   GET /v1/search — `q` length in RAW characters, before URL encoding
 *     250 -> 200
 *     251 -> 400 {"error":{"status":400,"message":"Query exceeds maximum length
 *             of 250 characters"}}
 *
 *   The values that must never be sent, measured on `/v1/search` and, for
 *   0 / -1 / 1.5, on `/v1/artists/{id}/albums` as well: `0`, `-1`, `1.5`, `abc`,
 *   `NaN` and `Infinity` each return 400 "Invalid limit". That is why the clamp
 *   below is TOTAL and not a `Math.min`: every one of those is a request we
 *   would build ourselves.
 *
 * ## What is NOT claimed here
 *
 * Nothing. Every number above came off the wire on the date named. If Spotify
 * changes one, `scripts/liveVerify.ts` will contradict this comment, which is the
 * intended failure mode — a comment that cannot be contradicted is a memory.
 */

/**
 * `/v1/search` — the largest `limit` the server accepts.
 *
 * TEN, and this has now been measured four times over two days by two
 * independent agents that disagreed, which is why the record below is so long.
 * An earlier probe concluded 50 and this constant was raised to match; that
 * reading was WRONG, and the cost was real: both collage builders ask for 15,
 * so every Spotify mosaic column rendered empty while the mocked suite agreed
 * with the mistake. Re-adjudicated 2026-10-01 with a forward pass and a reverse
 * pass over 1, 5, 10, 11, 15, 20, 50, 51 and 100: 10 returns 200 with exactly
 * 10 items and 11 returns 400 `{"error":{"status":400,"message":"Invalid
 * limit"}}`, in BOTH directions. A reverse pass is what separates a real ceiling
 * from a rate-limit ramp, and it is why the probe repeats itself backwards.
 *
 * Do not raise this without a probe that reports the ITEM COUNT, not just the
 * status. "200 with 50 items" and "200 with a cached body" look identical in a
 * log, and that is how a wrong number survived two agents.
 */
export const SPOTIFY_SEARCH_LIMIT_MAX = 10;

/**
 * `/v1/artists/{id}/albums` — the largest `limit` the server accepts.
 *
 * TEN, and on this one the evidence is WEAKER, so it is recorded as such. It
 * was measured as 10 on two passes on 2026-09-30 and as 50 by the same probe run
 * that got `/v1/search` wrong. The re-adjudication on 2026-10-01 could not settle
 * it: every request to this endpoint returned 429 `QUOTA_EXCEEDED`, so no 400 was
 * ever observed and no 200 either. Ten is kept because it is the only value known
 * to be accepted on this endpoint, and because the two endpoints are documented
 * to share the same ceiling. Re-measure this one before relying on it.
 */
export const SPOTIFY_ARTIST_ALBUMS_LIMIT_MAX = 10;

/**
 * `/v1/albums/{id}/tracks` — the largest `limit` the server accepts.
 *
 * FIFTY, and this is the one endpoint where 50 was measured AND honoured: a
 * 199-track album returned exactly 50 items at limit=50, and 100 was rejected.
 * It is also the endpoint that was dead until a few days ago - `getAlbumTrackNames`
 * returned `[]` for every successful response - so this constant is the first
 * thing that has ever actually governed it.
 */
export const SPOTIFY_ALBUM_TRACKS_LIMIT_MAX = 50;

/** `/v1/search` — the largest raw `q` length, counted before URL encoding. */
export const SPOTIFY_SEARCH_QUERY_MAX = 250;

/**
 * A clamp that is TOTAL, because a partial one reproduces the bug it prevents.
 * Measured: limit=0, limit=-1, limit=1.5 and limit=abc each return 400 "Invalid
 * limit", so every int-ish input is a rejection waiting to happen. NaN and
 * Infinity included, since a caller computing a limit from data can produce both
 * — and they reach the wire as the literal strings "NaN" and "Infinity", both of
 * which were measured returning 400 as well.
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

/**
 * Clamps a `/v1/albums/{id}/tracks` `limit` into the range the server accepts.
 *
 * This method used to inline `Math.min(limit, 50)`, which is a PARTIAL clamp: it
 * has the ceiling right (measured 2026-09-30: 50 accepted and honoured, 100
 * rejected) and no floor at all, so a caller passing 0 or NaN built a request
 * the server refuses. Every other limit this module sends routes through a
 * measured clamp, and this is the one that did not.
 */
export const clampSpotifyAlbumTracksLimit = (limit: number): number =>
  clampLimit(limit, SPOTIFY_ALBUM_TRACKS_LIMIT_MAX);
