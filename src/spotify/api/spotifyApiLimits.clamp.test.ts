import { describe, it, expect } from 'vitest';
import {
  SPOTIFY_ALBUM_TRACKS_LIMIT_MAX,
  SPOTIFY_ARTIST_ALBUMS_LIMIT_MAX,
  SPOTIFY_SEARCH_LIMIT_MAX,
  SPOTIFY_SEARCH_QUERY_MAX,
  clampSpotifyArtistAlbumsLimit,
  clampSpotifySearchLimit,
} from './spotifyApiLimits';

/**
 * The clamp is TOTAL, and the word doing the work is "total".
 *
 * `spotifySearchApi.limits.test.ts` proves the clamp is applied on the wire. It
 * does NOT prove the clamp is total: a partial clamp (`Math.min(limit, max)`
 * alone) still sends `limit=0` and `limit=-3` and `limit=1.5`, and every one of
 * those was MEASURED returning `400 {"error":{"status":400,"message":"Invalid
 * limit"}}` — see the probe table in `spotifyApiLimits.ts`. A clamp that only
 * guards the upper bound therefore leaves the whole failure mode open at the
 * bottom of the range, and the wire-level tests above would all still pass
 * because every caller happens to pass a positive integer today.
 *
 * VENDOR ASSUMPTION ENCODED HERE (needs re-checking against the live API):
 *   `GET /v1/search`      and  `GET /v1/artists/{id}/albums`
 *     limit=10  -> 200
 *     limit=11  -> 400 "Invalid limit"
 *     limit=0   -> 400 "Invalid limit"   (measured; the "Invalid limit" shape
 *                                         for a non-positive value)
 *     limit=-1  -> 400
 *     limit=1.5 -> 400
 *   Spotify's PUBLISHED Web API reference says the maximum is 50 for both. The
 *   server says 10. This repo deliberately trusts the server. If Spotify ever
 *   relaxes it, `SPOTIFY_SEARCH_LIMIT_MAX` / `SPOTIFY_ARTIST_ALBUMS_LIMIT_MAX`
 *   are the two numbers to raise — and no test here would notice either way,
 *   which is exactly why the constants carry their probe log.
 *
 *   Also encoded: the `q` ceiling of 250 RAW characters (before URL encoding).
 *     q=250 chars -> 200
 *     q=251 chars -> 400 "Query exceeds maximum length"
 */

describe('the measured constants, asserted rather than assumed', () => {
  it('pins both endpoint ceilings at 10, NOT the 50 in Spotify documentation', () => {
    // If someone "restores 50 because the docs say 50", that was the original
    // bug: the server rejects it and `!res.ok` turned the 400 into an empty
    // list, indistinguishable from "this artist has no covers".
    //
    // 2026-10-01: this test was INVERTED to 50 by an agent that reported live
    // measurement, six tests across three files were renamed to agree with it,
    // and every Spotify collage went empty in the process - both collage
    // builders ask for 15. Re-adjudicated on a forward pass and a REVERSE pass
    // over 1, 5, 10, 11, 15, 20, 50, 51, 100: 10 returned 200 with exactly 10
    // items, 11 returned 400, identically in both directions. So the number was
    // right and the probe was wrong. The full record, including the wrong
    // reading, is in `spotifyApiLimits.ts`.
    //
    // Note `/v1/albums/{id}/tracks` is a DIFFERENT endpoint and its ceiling IS
    // 50, measured and honoured. One constant per endpoint, never generalised.
    expect(SPOTIFY_SEARCH_LIMIT_MAX).toBe(10);
    expect(SPOTIFY_ARTIST_ALBUMS_LIMIT_MAX).toBe(10);
    expect(SPOTIFY_ALBUM_TRACKS_LIMIT_MAX).toBe(50);
  });

  it('pins the raw query-length ceiling at 250 characters', () => {
    // Counted BEFORE URL encoding, which is the only way the number is useful.
    expect(SPOTIFY_SEARCH_QUERY_MAX).toBe(250);
  });
});

describe('clampSpotifySearchLimit is total, not partial', () => {
  it.each([
    ['the measured ceiling itself', 10, 10],
    ['one below the ceiling', 9, 9],
    ['the minimum the server accepts', 1, 1],
    ['one above the ceiling', 11, 10],
    ['the value both collage builders send', 15, 10],
    ['the value the method default uses', 20, 10],
    ['the value the docs suggest', 50, 10],
    ['an uncapped caller', 200, 10],
    ['zero, which is a 400 not a default', 0, 1],
    ['negative', -3, 1],
    ['fractional, truncated toward zero', 1.5, 1],
    ['fractional above the ceiling, truncated first', 10.9, 10],
    ['NaN, which a caller computing a limit from data can produce', Number.NaN, 1],
    ['+Infinity', Number.POSITIVE_INFINITY, 1],
    ['-Infinity', Number.NEGATIVE_INFINITY, 1],
  ])('clamps %s (%s) to %s', (_label, input, expected) => {
    expect(clampSpotifySearchLimit(input as number)).toBe(expected as number);
  });

  it('sends an integer in every case, because a fractional limit is a measured 400', () => {
    for (const bad of [0, -3, 1.5, 7.9, Number.NaN, Number.POSITIVE_INFINITY]) {
      const sent = clampSpotifySearchLimit(bad);
      expect(Number.isInteger(sent), `limit ${String(bad)} -> ${String(sent)}`).toBe(true);
      expect(sent).toBeGreaterThanOrEqual(1);
      expect(sent).toBeLessThanOrEqual(SPOTIFY_SEARCH_LIMIT_MAX);
    }
  });
});

describe('clampSpotifyArtistAlbumsLimit shares the same contract', () => {
  it.each([
    ['in range', 7, 7],
    ['at the ceiling', 10, 10],
    ['the 15 the collage builders send', 15, 10],
    ['50, the documented value', 50, 10],
    ['0', 0, 1],
    ['-1', -1, 1],
    ['1.5', 1.5, 1],
    ['NaN', Number.NaN, 1],
  ])('clamps %s', (_label, input, expected) => {
    expect(clampSpotifyArtistAlbumsLimit(input as number)).toBe(expected as number);
  });

  it('agrees with the search clamp on the same input, so the two cannot drift', () => {
    // Both ceilings are 10 today. A future change to one and not the other is
    // plausible and would be invisible, because no caller passes 0 or NaN.
    for (const bad of [0, -1, 1.5, 9, 10, 11, 50, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampSpotifyArtistAlbumsLimit(bad), `input ${String(bad)}`).toBe(
        clampSpotifySearchLimit(bad),
      );
    }
  });
});
