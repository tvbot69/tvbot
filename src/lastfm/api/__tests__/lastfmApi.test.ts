import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';
import { LastfmApi } from '@lastfm/api/lastfmApi';
import { LastfmErrorRateTracker } from '@domain/lastfm/lastfmErrorRateTracker';

describe('LastfmApi', () => {
  beforeEach(() => {
    container.registerInstance(LastfmErrorRateTracker, new LastfmErrorRateTracker());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully calls Last.fm and returns parsed JSON', async () => {
    const mockData = { user: { name: 'alice', playcount: '100' } };

    // A real `Response`, not a hand-written stand-in: `lastfmApi` reads the body
    // with `response.text()`, not `response.json()`, so that the body stays
    // available when the status is not ok. A double offering only `json` cannot
    // express that, and a cast would not constrain it either.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(mockData), { status: 200 }));

    const api = new LastfmApi(new LastfmErrorRateTracker());
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
        return new Response('{}', { status: 503 });
      }
      return new Response(JSON.stringify(mockData), { status: 200 });
    });

    const api = new LastfmApi(new LastfmErrorRateTracker());
    const result = await api.call<{ artist: { name: string } }>('artist.getInfo', {
      artist: 'Radiohead',
    });

    expect(callCount).toBe(2);
    expect(result).toEqual(mockData);
  });
});
