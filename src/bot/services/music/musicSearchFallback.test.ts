import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { MusicService } from './musicService';

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
});
