import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';
import { LastfmApi } from './lastfmApi';
import { LastfmErrorRateTracker } from '@domain/lastfmErrorRateTracker';

describe('LastfmApi', () => {
  beforeEach(() => {
    container.registerInstance(LastfmErrorRateTracker, new LastfmErrorRateTracker());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully calls Last.fm and returns parsed JSON', async () => {
    const mockData = { user: { name: 'alice', playcount: '100' } };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => mockData,
      } as any;
    });

    const api = new LastfmApi();
    const result = await api.call<{ user: { name: string; playcount: string } }>('user.getInfo', {
      user: 'alice',
    });

    expect(result).toEqual(mockData);
  });

  it('retries on transient 503 errors and succeeds if next attempt succeeds', async () => {
    let callCount = 0;
    const mockData = { artist: { name: 'Radiohead' } };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 503,
          json: async () => ({}),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => mockData,
      } as any;
    });

    const api = new LastfmApi();
    const result = await api.call<{ artist: { name: string } }>('artist.getInfo', {
      artist: 'Radiohead',
    });

    expect(callCount).toBe(2);
    expect(result).toEqual(mockData);
  });
});
