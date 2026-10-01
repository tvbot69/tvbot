import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { matchesTrackTitle } from '../artworkService';

/**
 * Regressions for the two-day chapter-art bug, found from a local test log on
 * 2026-09-27: `Chapter art { idx: 8, song: 'I Like Her', ok: false }`.
 *
 * Root cause, measured against the live Spotify catalogue: Mac DeMarco's
 * "I Like Her" and "Proud True Toyota" are not returned as their originals at
 * all — every hit is a compilation/DJ-pool rip whose title carries a leading
 * import date ("20191009 I Like Her", "20200817 Proud True Toyota"). The artist
 * matched perfectly, the title did not, so strict matching rejected all of them
 * and the card fell back to holding the previous cover forever.
 */
describe('matchesTrackTitle — date-prefixed compilation rips', () => {
  it('matches a rip whose title is prefixed with a compact date', () => {
    expect(matchesTrackTitle('20191009 I Like Her', 'I Like Her')).toBe(true);
    expect(matchesTrackTitle('20200817 Proud True Toyota', 'Proud True Toyota')).toBe(true);
  });

  it('matches a rip whose title is prefixed with a dashed or dotted date', () => {
    expect(matchesTrackTitle('2019-10-09 I Like Her', 'I Like Her')).toBe(true);
    expect(matchesTrackTitle('2020.08.17 Proud True Toyota', 'Proud True Toyota')).toBe(true);
    expect(matchesTrackTitle('17/08/2020 Proud True Toyota', 'Proud True Toyota')).toBe(true);
  });

  it('is symmetric — a dated target still matches a plain candidate', () => {
    expect(matchesTrackTitle('I Like Her', '20191009 I Like Her')).toBe(true);
  });

  it('strips only a LEADING date, so numeric titles survive', () => {
    // "1989" is a real album/song title, not a date to be stripped away.
    expect(matchesTrackTitle('1989', '1989')).toBe(true);
    expect(matchesTrackTitle('2001', '2001')).toBe(true);
    // A date in the middle is not a prefix and must not be silently removed.
    expect(matchesTrackTitle('Song 20191009 Remix', 'Song')).toBe(false);
  });

  it('never turns a prefix match into a substring match', () => {
    // The whole point of strict matching: "Song" must not match "Song 2".
    expect(matchesTrackTitle('20191009 Song 2', 'Song')).toBe(false);
    expect(matchesTrackTitle('Song 2', 'Song')).toBe(false);
  });

  it('still refuses edition tags and mismatched artists (unchanged behaviour)', () => {
    expect(matchesTrackTitle('20191009 I Like Her (Remix)', 'I Like Her')).toBe(false);
    expect(matchesTrackTitle('20191009 Totally Different Song', 'I Like Her')).toBe(false);
  });

  it('still tolerates bracketed noise on a dated rip', () => {
    expect(matchesTrackTitle('20191009 I Like Her (Official Video)', 'I Like Her')).toBe(true);
  });
});
