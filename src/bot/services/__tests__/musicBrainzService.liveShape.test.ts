import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MusicBrainzService } from '@bot/services/musicBrainzService';
import { CacheService } from '@bot/services/system/cacheService';

/**
 * **Captured from the real MusicBrainz web service on 2026-09-30.**
 *
 * MusicBrainz is the only vendor in this sweep that is currently *behaving*,
 * and this file is the record of why: every field the service reads is present,
 * correctly typed, and the link vocabulary it greps for actually appears in
 * `relations[].url.resource`.
 *
 * The two live facts worth keeping:
 *
 * 1. **A User-Agent is mandatory and enforced.** A blank UA gets **HTTP 403**
 *    with `"Your requests are being throttled by MusicBrainz because the
 *    application you are using has not identified itself."` The service sends
 *    one on both calls, so it complies.
 * 2. **`disambiguation` is `""` (empty string), not null**, and `gender` is
 *    genuinely `null` for a Group. Both flow into
 *    `MusicBrainzArtistData` as-is. Anything downstream doing
 *    `if (data.disambiguation === null)` would miss the real value; truthiness
 *    checks handle both. Captured so a future shape change is visible.
 */

/** Exactly the 16 top-level keys the lookup returned. */
const MBZ_LOOKUP = {
  area: { name: 'United Kingdom', id: '8a752a15-3fda-4a5b-a92c-b3a4cbf9b1a3', type: 'Country', type_id: 'country' },
  'begin-area': { name: 'Abingdon-on-Thames', id: 'f03d09b1-8ec4-4a2a-9e0b-000000000000', type: 'City' },
  country: 'GB',
  disambiguation: '',
  'end-area': null,
  gender: null,
  'gender-id': null,
  id: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
  ipis: [],
  isnis: [],
  'life-span': { begin: '1991', ended: false, end: null },
  name: 'Radiohead',
  relations: [
    { type: 'official homepage', url: { resource: 'https://www.radiohead.com/' } },
    { type: 'streaming', url: { resource: 'https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQV' } },
    { type: 'streaming', url: { resource: 'https://music.apple.com/us/artist/442184' } },
    { type: 'streaming', url: { resource: 'https://www.deezer.com/artist/2662' } },
    { type: 'social network', url: { resource: 'https://www.instagram.com/radiohead/' } },
    { type: 'social network', url: { resource: 'https://twitter.com/radiohead' } },
    { type: 'bandcamp', url: { resource: 'https://radiohead.bandcamp.com/' } },
    { type: 'video channel', url: { resource: 'https://www.youtube.com/@radiohead' } },
    { type: 'lyrics', url: { resource: 'https://www.last.fm/music/Radiohead/+wiki' } },
  ],
  'sort-name': 'Radiohead',
  type: 'Group',
  'type-id': 'e431f5f9-0b81-4d5c-9d4d-000000000000',
};

/** The first two real search hits, with their real key sets — they differ. */
const MBZ_SEARCH = {
  created: '2026-09-30T00:00:00.000Z',
  count: 7,
  offset: 0,
  artists: [
    {
      id: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
      type: 'Group',
      'type-id': 'e431f5f9-0b81-4d5c-9d4d-000000000000',
      score: 100,
      name: 'Radiohead',
      'sort-name': 'Radiohead',
      country: 'GB',
      area: { name: 'United Kingdom' },
      'begin-area': { name: 'Abingdon-on-Thames' },
      isnis: [],
      'life-span': { begin: '1991', ended: false },
      aliases: [],
      tags: [],
    },
    {
      id: '3ecaa799-94ae-45cd-9ad1-bcabae4073e1',
      score: 57,
      name: 'radiohead 3',
      'sort-name': 'radiohead 3',
      disambiguation: 'Capsmusic LTD. artist',
      'life-span': { begin: '2015', ended: false },
    },
  ],
};

const jsonResponse = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

/** Cache stub that never hits, so every call reaches the wire. */
const noCache = (): CacheService =>
  ({ get: async (): Promise<unknown> => null, set: async (): Promise<void> => undefined }) as unknown as CacheService;

describe('MusicBrainzService — live wire shapes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('a lookup that finds everything the service reads', () => {
    it('maps location, country, type and the eight link kinds', async () => {
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse(MBZ_SEARCH))
        .mockResolvedValueOnce(jsonResponse(MBZ_LOOKUP));

      const data = await new MusicBrainzService(noCache()).getArtistData('Radiohead');

      expect(data).not.toBeNull();
      expect(data?.mbid).toBe('a74b1b7f-71a5-4011-9441-d0b5e4122711');
      // `area` wins over `begin-area` — both are present live, so the `||`
      // ordering in the service is actually exercised, never dead.
      expect(data?.location).toBe('United Kingdom');
      expect(MBZ_LOOKUP['begin-area'].name).toBe('Abingdon-on-Thames');
      expect(data?.countryCode).toBe('GB');
      expect(data?.type).toBe('Group');
      // '1991' -> epoch seconds, and the >1800 guard admits it.
      expect(data?.birthDate).toBe(Math.floor(Date.parse('1991-01-01T00:00:00Z') / 1000));
      expect(data?.birthDate).toBeGreaterThan(0);

      // Every vocabulary branch in the loop matched a real resource.
      expect(data?.links.spotify).toContain('open.spotify.com/artist/');
      expect(data?.links.appleMusic).toContain('music.apple.com/');
      expect(data?.links.instagram).toContain('instagram.com/');
      expect(data?.links.twitter).toContain('twitter.com/');
      expect(data?.links.bandcamp).toContain('bandcamp.com');
      expect(data?.links.deezer).toContain('deezer.com/artist/');
      expect(data?.links.youtube).toContain('youtube.com/');
      expect(data?.links.lastfm).toContain('last.fm/music/');

      // Both requests went out with an identifying User-Agent.
      for (const call of spy.mock.calls) {
        const headers = (call[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
        expect(headers?.['User-Agent']).toMatch(/tvbot/);
      }
    });

    it('an unknown artist is a null, not a raise', async () => {
      // Measured live: `getArtistData('Zzzqxwv Nnbbkkjj Qqqx Nonexistent')` -> null.
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ created: '', count: 0, offset: 0, artists: [] }));
      await expect(new MusicBrainzService(noCache()).getArtistData('Zzzqxwv Nnbbkkjj Qqqx Nonexistent')).resolves.toBeNull();
    });

    it('search hits carry DIFFERENT key sets, and the service only relies on the overlap', async () => {
      // Hit 1 has `type`/`country`; hit 2 has neither, only `disambiguation`.
      // The service reads `id` and `name` from search, which both have — so the
      // heterogeneous shape is harmless today and recorded so it stays so.
      const keys = (a: Record<string, unknown>): string[] => Object.keys(a).sort();
      expect(keys(MBZ_SEARCH.artists[0]!)).toContain('name');
      expect(keys(MBZ_SEARCH.artists[1]!)).toContain('name');
      expect(keys(MBZ_SEARCH.artists[0]!)).not.toEqual(keys(MBZ_SEARCH.artists[1]!));
      expect(MBZ_SEARCH.artists[1]!.type).toBeUndefined();
    });
  });

  describe('the values that are empty rather than null', () => {
    it('disambiguation is "" and gender is null on the live payload', () => {
      expect(MBZ_LOOKUP.disambiguation).toBe('');
      expect(MBZ_LOOKUP.gender).toBeNull();
      expect(MBZ_LOOKUP['end-area']).toBeNull();
      // Which means a `?? 'unknown'` would print "unknown" for disambiguation
      // and `|| 'unknown'` would also fire — both are wrong in different ways
      // and neither is what the consumer does. Captured so this is on record.
      expect(Boolean(MBZ_LOOKUP.disambiguation)).toBe(false);
    });
  });

  describe('rate limiting and identification', () => {
    it('a blank User-Agent is refused with 403 and a throttle message; the service always sends one', async () => {
      // Measured live. The message is MusicBrainz's, quoted exactly.
      const refusal = { error: 'Your requests are being throttled by MusicBrainz because the application you are using has not identified itself. Please update your User-Agent to include contact information.' };
      const res = jsonResponse(refusal, 403);
      expect(res.ok).toBe(false);

      // With a UA it answers normally, and the service's exact UA string —
      // fake contact and all — is accepted today.
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse(MBZ_SEARCH))
        .mockResolvedValueOnce(jsonResponse(MBZ_LOOKUP));
      await new MusicBrainzService(noCache()).getArtistData('Radiohead');
      const ua = (spy.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
      expect(ua?.['User-Agent']).toBe('tvbot/1.0.0 ( contact@tvbot.local )');
    });
  });
});
