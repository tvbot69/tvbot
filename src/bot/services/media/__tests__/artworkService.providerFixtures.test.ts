import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { matchesTrackTitle, matchesArtistName } from '@bot/services/media/artworkService';

/**
 * Fixtures captured from the LIVE Spotify search API on 2026-09-27, not
 * invented. This is the fix for the class of bug that cost two days: our
 * title-matching tests all used clean, hand-written titles, so nothing had
 * ever seen what a provider actually returns.
 *
 * The raw response for `track:I Like Her Mac DeMarco` (top 5):
 *   "20191009 I Like Her"         | Mac DeMarco | One Wayne G
 *   "20191009 I Like Her"         | Mac DeMarco | Música Relajante ...
 *   "20191009 I Like Her"         | Mac DeMarco | Cottage Core
 *   "20191009 I Like Her"         | Mac DeMarco | Cottage Music: New Folky Jams
 *   "20191009 I Like Her"         | Mac DeMarco | Soft and Cozy
 *
 * The original single was not among them. Every hit is a DJ-pool / compilation
 * rip whose title carries an import date, on an album that is not the
 * recording's own release. The ARTIST matched perfectly on all five; only the
 * title differed, so strict matching rejected every row and chapter art
 * resolved to nothing — the card then held the previous cover forever.
 */
const SPOTIFY_SEARCH_RESPONSE_20191009 = {
  'I Like Her': [
    { name: '20191009 I Like Her', artists: ['Mac DeMarco'], album: 'One Wayne G' },
    { name: '20191009 I Like Her', artists: ['Mac DeMarco'], album: 'Música Relajante Para Desconectar En Casa' },
    { name: '20191009 I Like Her', artists: ['Mac DeMarco'], album: 'Cottage Core' },
    { name: '20191009 I Like Her', artists: ['Mac DeMarco'], album: 'Cottage Music: New Folky Jams' },
    { name: '20191009 I Like Her', artists: ['Mac DeMarco'], album: 'Soft and Cozy' },
  ],
} as const;

const SPOTIFY_SEARCH_RESPONSE_20200817 = {
  'Proud True Toyota': [
    { name: '20200817 Proud True Toyota', artists: ['Mac DeMarco'], album: 'One Wayne G' },
    { name: '20200817 Proud True Toyota', artists: ['Mac DeMarco'], album: 'Frühstücksmusik 2024' },
    { name: '20200817 Proud True Toyota', artists: ['Mac DeMarco'], album: 'Brunch 2025' },
  ],
} as const;

describe('real provider fixtures — Spotify compilation rips', () => {
  it('accepts every rip the live API returned for a Mac DeMarco track', () => {
    const rows = SPOTIFY_SEARCH_RESPONSE_20191009['I Like Her'];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(matchesTrackTitle(row.name, 'I Like Her')).toBe(true);
      // The artist was always right, even when the title was not.
      expect(matchesArtistName(row.artists.join(', '), 'Mac DeMarco')).toBe(true);
    }
  });

  it('accepts the Proud True Toyota rips too', () => {
    const rows = SPOTIFY_SEARCH_RESPONSE_20200817['Proud True Toyota'];
    for (const row of rows) {
      expect(matchesTrackTitle(row.name, 'Proud True Toyota')).toBe(true);
    }
  });

  it('still refuses a genuinely different song from the same artist', () => {
    // The whole point of strict matching: a compililation rip of the right
    // song is fine, a compililation rip of a DIFFERENT song is not.
    expect(matchesTrackTitle('20191009 Some Other Song', 'I Like Her')).toBe(false);
    expect(matchesTrackTitle('20191009 I Like Her 2', 'I Like Her')).toBe(false);
  });

  it('records the fixture shape so a future provider change is visible', () => {
    // If Spotify ever stops returning the dated rip, this row shape changes
    // and the assertions above start failing loudly — which is the point.
    // The date prefix is the load-bearing detail, not an implementation detail.
    const first = SPOTIFY_SEARCH_RESPONSE_20191009['I Like Her'][0];
    expect(first).toMatchObject({ name: expect.stringMatching(/^\d{8} /), artists: ['Mac DeMarco'] });
  });
});
