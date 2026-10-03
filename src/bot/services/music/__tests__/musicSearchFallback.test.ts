import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { MusicService } from '@bot/services/music/musicService';

describe('MusicService.fallbackSearchQuery', () => {
  it('strips featured artists to the lead artist', () => {
    expect(
      MusicService.fallbackSearchQuery("ZAF, Omar Taa'i - cashwekaas", {
        title: 'cashwekaas',
        artist: "ZAF, Omar Taa'i",
      }),
    ).toBe('ZAF - cashwekaas');
    expect(
      MusicService.fallbackSearchQuery('ZAF, Mahib Sleat - dopaminee', {
        title: 'dopaminee',
        artist: 'ZAF, Mahib Sleat',
      }),
    ).toBe('ZAF - dopaminee');
  });

  it('returns null when there is no distinct fallback', () => {
    expect(MusicService.fallbackSearchQuery('ZAF - cashwekaas', { title: 'cashwekaas', artist: 'ZAF' })).toBeNull();
    expect(MusicService.fallbackSearchQuery('anything', undefined)).toBeNull();
    expect(MusicService.fallbackSearchQuery('anything', {})).toBeNull();
    expect(MusicService.fallbackSearchQuery('ZAF - cashwekaas', { title: '', artist: 'ZAF' })).toBeNull();
  });

  it('carries the TITLE through verbatim, punctuation and all', () => {
    // The fallback exists to be searched. A title that got truncated, stripped
    // of its bracketed part or re-cased is a different query, and one that finds
    // nothing — which is exactly the state this function is called from.
    expect(
      MusicService.fallbackSearchQuery("ZAF, Omar Taa'i - cashwekaas (Remix)", {
        title: 'cashwekaas (Remix)',
        artist: "ZAF, Omar Taa'i",
      }),
    ).toBe('ZAF - cashwekaas (Remix)');
    expect(
      MusicService.fallbackSearchQuery('Daft Punk & Justice - One More Time', {
        title: 'One More Time',
        artist: 'Daft Punk & Justice',
      }),
    ).toBe('Daft Punk - One More Time');
  });

  it('strips a channel suffix from the lead artist before searching', () => {
    // A "- Topic" / VEVO channel name is not an artist, and a fallback carrying
    // it back to YouTube poisons the retry exactly like the second billing did.
    expect(
      MusicService.fallbackSearchQuery('ZAF - Topic, Omar Taa\'i - cashwekaas', {
        title: 'cashwekaas',
        artist: 'ZAF - Topic, Omar Taa\'i',
      }),
    ).toBe('ZAF - cashwekaas');
    // VEVO on a single-artist string still yields a DISTINCT query, so it is
    // not refused as "no fallback" — the lead no longer equals the billing.
    expect(
      MusicService.fallbackSearchQuery('ZAF VEVO - cashwekaas', { title: 'cashwekaas', artist: 'ZAF VEVO' }),
    ).toBe('ZAF - cashwekaas');
  });

  it('refuses a fallback that differs from the original only in case', () => {
    // Two attempts of the same search is one wasted search budget and, worse, a
    // second "we looked and there was nothing" reported to the user. Casing is
    // not a distinct query.
    expect(
      MusicService.fallbackSearchQuery('zaf - cashwekaas', { title: 'cashwekaas', artist: 'ZAF, Omar Taa\'i' }),
    ).toBeNull();
    // Surrounding whitespace is likewise not a distinct query.
    expect(
      MusicService.fallbackSearchQuery('  ZAF - cashwekaas  ', { title: 'cashwekaas', artist: 'ZAF, Omar' }),
    ).toBeNull();
  });
});
