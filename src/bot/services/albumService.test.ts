import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AlbumService } from './albumService';

/**
 * The pure helpers on AlbumService, which sits at 9.9% of 656 lines.
 *
 * These take raw user input - a pasted URL, a typed album name - so they are
 * where a wrong answer becomes a visibly wrong command rather than an internal
 * error. `resolveAlbumFromLink` is the sharpest example: the user pastes a
 * Last.fm URL and expects the artist and album extracted, and the return shape
 * differs per provider, so a wrong branch is not an error but a null and an
 * unhelpful "could not find that album".
 *
 * No network and no repositories: these are all pure functions on the instance,
 * so the tests construct the service with doubles and never touch anything else.
 */

const makeService = () => {
  const s = Object.create(AlbumService.prototype) as AlbumService;
  return s;
};

describe('AlbumService.resolveAlbumFromLink', () => {
  let svc: AlbumService;
  beforeEach(() => { svc = makeService(); });

  it('extracts artist and album from a Last.fm music URL', () => {
    // The shape users actually paste.
    expect(svc.resolveAlbumFromLink('https://www.last.fm/music/Radiohead/OK+Computer')).toEqual({
      artistName: 'Radiohead',
      albumName: 'OK Computer',
    });
  });

  it('decodes percent-encoding in a Last.fm URL', () => {
    // Album names with punctuation arrive percent-encoded. Dropping this gives
    // "Kid A%2C 1993" and a failed lookup.
    expect(svc.resolveAlbumFromLink('https://www.last.fm/music/Radiohead/Kid+A%2C+1993')).toEqual({
      artistName: 'Radiohead',
      albumName: 'Kid A, 1993',
    });
  });

  it('decodes + as a space in the ARTIST segment too, not just the album', () => {
    // Added after mutation: removing the + replacement from the artist half
    // left every test green, because the fixtures only ever had a + in the
    // album segment. Last.fm encodes spaces as + in BOTH segments, so a band
    // with a space in its name is the ordinary case, not the exotic one.
    const r = svc.resolveAlbumFromLink('https://www.last.fm/music/Bj%C3%B6rk+ish/Human+Behaviour');
    expect(r?.artistName).toBe('Björk ish');
  });

  it('strips a query string and trailing slash from a Last.fm URL', () => {
    const r = svc.resolveAlbumFromLink('https://www.last.fm/music/Bj%C3%B6rk/Homogen%C3%ADc?album=1');
    expect(r).not.toBeNull();
    expect(r?.albumName).toBe('Homogeníc');
    expect(r?.albumName).not.toContain('?');
  });

  it('returns only the album id for a Spotify URL, with no artist', () => {
    // Spotify IDs carry no name, so artistName must be absent rather than
    // empty - an empty string would read as "artist is ''" downstream and fail
    // the search differently from "no artist given".
    expect(svc.resolveAlbumFromLink('https://open.spotify.com/album/4LH4d3cOWNNXdsqFd42wum')).toEqual({
      albumName: '4LH4d3cOWNNXdsqFd42wum',
    });
  });

  it('handles the localised Spotify path', () => {
    // Spotify serves /intl-de/album/... and /intl-pt/album/... to users outside
    // the default region. Without the optional group the regex misses and the
    // command reports "not a Spotify album".
    expect(svc.resolveAlbumFromLink('https://open.spotify.com/intl-de/album/4LH4d3cOWNNXdsqFd42wum')).toEqual({
      albumName: '4LH4d3cOWNNXdsqFd42wum',
    });
  });

  it('turns Apple Music dashes into spaces', () => {
    expect(svc.resolveAlbumFromLink('https://music.apple.com/us/album/ok-computer/1109714933')).toEqual({
      albumName: 'ok computer',
    });
  });

  it('returns null for input that is not a URL at all', () => {
    // The common case: the user typed a plain album name.
    expect(svc.resolveAlbumFromLink('OK Computer')).toBeNull();
    expect(svc.resolveAlbumFromLink('')).toBeNull();
  });

  it('returns null for a string that merely contains "http"', () => {
    // The `includes('http')` guard is defensive, not load-bearing: no provider
    // regex can match without a host segment, so a non-URL string falls through
    // to the same null. Removing the guard therefore changes no observable
    // behaviour, which is why there is no mutation that catches it. Asserted
    // here so the guard's purpose is recorded rather than assumed.
    expect(svc.resolveAlbumFromLink('http')).toBeNull();
    expect(svc.resolveAlbumFromLink('see http://example.com for more')).toBeNull();
  });

  it('returns null for a URL from a provider it does not know', () => {
    // Better a null the caller can report than a wrong artist/album guess.
    expect(svc.resolveAlbumFromLink('https://bandcamp.com/album/some-album')).toBeNull();
    expect(svc.resolveAlbumFromLink('https://deezer.com/album/123')).toBeNull();
  });

  it('prefers the Last.fm branch when a string somehow contains two providers', () => {
    // Order is load-bearing: Last.fm is checked first, so a pasted URL with a
    // Last.fm path wins over anything later in the string.
    const r = svc.resolveAlbumFromLink('https://www.last.fm/music/Radiohead/OK+Computer?src=spotify.com/album/abc123');
    expect(r?.artistName).toBe('Radiohead');
  });
});

describe('AlbumService single filtering', () => {
  let svc: AlbumService;
  beforeEach(() => { svc = makeService(); });

  it('drops releases whose albumType is single', () => {
    const r = svc.filterAlbumsThatAreSingles([
      { name: 'OK Computer', albumType: 'album' },
      { name: 'Lucky', albumType: 'single' },
    ]);
    expect(r.map((a) => a.name)).toEqual(['OK Computer']);
  });

  it('drops singles detected from the NAME when no albumType is present', () => {
    // Last.fm often omits albumType, so the name is the only signal. Case
    // matters: "Lucky - Single" and "lucky - single" are both real.
    const r = svc.filterAlbumsThatAreSingles([
      { name: 'Hikaru - Single' },
      { name: 'wonder - EP' },
      { name: 'SINGLE' },
      { name: 'Kid A' },
    ]);
    expect(r.map((a) => a.name)).toEqual(['Kid A']);
  });

  it('keeps an EP, because an EP is not a single', () => {
    // Only "single" is filtered. Treating EP as a single would delete real
    // albums from a user's top list.
    const r = svc.filterAlbumsThatAreSingles([{ name: 'Fallout 3' }]);
    expect(r).toHaveLength(1);
  });

  it('handles an empty list', () => {
    expect(svc.filterAlbumsThatAreSingles([])).toEqual([]);
  });
});

describe('AlbumService release-period filtering', () => {
  let svc: AlbumService;
  beforeEach(() => { svc = makeService(); });

  const withDates = [
    { name: 'Kid A', releaseDate: new Date('2000-10-02T00:00:00Z') },
    { name: 'OK Computer', releaseDate: new Date('1997-05-21T00:00:00Z') },
    { name: 'Unknown', releaseDate: undefined },
  ];

  it('keeps only the requested year', () => {
    const r = svc.filterAlbumToReleaseYear(withDates, 2000);
    expect(r.map((a) => a.name)).toEqual(['Kid A']);
  });

  it('drops releases with no date rather than treating them as year 0', () => {
    // `a.releaseDate &&` is what excludes an undated release. The mutant
    // `(a.releaseDate?.getUTCFullYear() ?? 0) === year` is behaviourally
    // EQUIVALENT for every realistic year, since no album is from year 0, so
    // no test can distinguish them. Asserted directly: an undated release is
    // not in the result for the years anyone asks for.
    for (const year of [1997, 2000, 2026]) {
      const r = svc.filterAlbumToReleaseYear(withDates, year);
      expect(r.map((a) => a.name)).not.toContain('Unknown');
    }
  });

  it('keeps a whole decade, inclusive of both ends', () => {
    const r = svc.filterAlbumToReleaseDecade(withDates, 1990);
    // 1997 and 2000 both fall in 1990-1999 or 2000-2009; 1990-1999 gives 1997.
    expect(r.map((a) => a.name)).toEqual(['OK Computer']);
  });

  it('includes the LAST year of the decade', () => {
    // Added after mutation: `decade + 8` instead of `decade + 9` left every
    // other test green, because the fixtures had no album in the boundary
    // year. 1999 must be in the 1990s - a decade that drops its final year
    // silently loses an album from every decade-filtered command.
    const r = svc.filterAlbumToReleaseDecade(
      [
        { name: 'OK Computer', releaseDate: new Date('1997-05-21T00:00:00Z') },
        { name: 'The Bends', releaseDate: new Date('1999-02-22T00:00:00Z') },
        { name: 'Kid A', releaseDate: new Date('2000-10-02T00:00:00Z') },
      ],
      1990,
    );
    expect(r.map((a) => a.name)).toEqual(['OK Computer', 'The Bends']);
  });

  it('excludes the first year of the NEXT decade', () => {
    const r = svc.filterAlbumToReleaseDecade(
      [
        { name: 'The Bends', releaseDate: new Date('1999-02-22T00:00:00Z') },
        { name: 'Kid A', releaseDate: new Date('2000-10-02T00:00:00Z') },
      ],
      1990,
    );
    expect(r.map((a) => a.name)).not.toContain('Kid A');
  });

  it('spans a decade boundary when asked for one that includes it', () => {
    const r = svc.filterAlbumToReleaseDecade(withDates, 2000);
    expect(r.map((a) => a.name)).toEqual(['Kid A']);
  });

  it('returns an empty list rather than throwing on empty input', () => {
    expect(svc.filterAlbumToReleaseYear([], 2000)).toEqual([]);
    expect(svc.filterAlbumToReleaseDecade([], 2000)).toEqual([]);
  });
});
