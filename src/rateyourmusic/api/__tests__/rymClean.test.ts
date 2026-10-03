import { describe, expect, it } from 'vitest';
import {
  absoluteUrl,
  artistSlugFromUrl,
  cleanText,
  parseCount,
  parseRating,
  parseYear,
  releaseSlugFromUrl,
  releaseTypeFromUrl,
} from '../rymClean';

describe('cleanText', () => {
  it('unescapes entities and collapses whitespace', () => {
    expect(cleanText('  Foo &amp; Bar&nbsp;&nbsp;Baz ')).toBe('Foo & Bar Baz');
  });

  it('returns empty string for empty input', () => {
    expect(cleanText('')).toBe('');
  });
});

describe('parseYear', () => {
  it('extracts a 4-digit year', () => {
    expect(parseYear('21 March 1988')).toBe(1988);
  });

  it('returns null when no year present', () => {
    expect(parseYear('n/a')).toBeNull();
  });
});

describe('parseRating', () => {
  it('parses a decimal rating', () => {
    expect(parseRating('4.38')).toBe(4.38);
    expect(parseRating('4.38 / 5')).toBe(4.38);
  });

  it('returns null for garbage', () => {
    expect(parseRating('none')).toBeNull();
  });
});

describe('parseCount', () => {
  it('expands k and m suffixes', () => {
    expect(parseCount('106k')).toBe(106000);
    expect(parseCount('1.2k')).toBe(1200);
    expect(parseCount('2m')).toBe(2000000);
  });

  it('strips commas', () => {
    expect(parseCount('49,576')).toBe(49576);
  });

  it('returns null for empty', () => {
    expect(parseCount('')).toBeNull();
  });
});

describe('slug extractors', () => {
  it('releaseSlugFromUrl', () => {
    expect(releaseSlugFromUrl('https://rateyourmusic.com/release/album/radiohead/ok-computer/')).toBe('radiohead/ok-computer');
    expect(releaseSlugFromUrl('/release/ep/artist/title/')).toBe('artist/title');
    expect(releaseSlugFromUrl('https://rateyourmusic.com/artist/radiohead')).toBe('');
  });

  it('releaseTypeFromUrl', () => {
    expect(releaseTypeFromUrl('https://rateyourmusic.com/release/ep/a/b/')).toBe('ep');
    expect(releaseTypeFromUrl('nope')).toBe('album');
  });

  it('artistSlugFromUrl', () => {
    expect(artistSlugFromUrl('https://rateyourmusic.com/artist/radiohead')).toBe('radiohead');
    expect(artistSlugFromUrl('')).toBe('');
  });
});

describe('absoluteUrl', () => {
  it('handles protocol-relative and relative urls', () => {
    expect(absoluteUrl('//e.snmc.io/x.jpg')).toBe('https://e.snmc.io/x.jpg');
    expect(absoluteUrl('/release/album/a/b/')).toBe('https://rateyourmusic.com/release/album/a/b/');
    expect(absoluteUrl('')).toBe('');
  });
});
