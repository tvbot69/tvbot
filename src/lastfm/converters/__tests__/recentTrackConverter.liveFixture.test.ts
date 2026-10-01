// Must be first. Sibling converter tests in this directory do the same; nothing
// imported here is tsyringe-decorated, so it is belt-and-braces (AGENTS.md §5).
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TrackConverter } from '@lastfm/converters/recentTrackConverter';
import type { RecentTrackLfm } from '@lastfm/models/recentTracksLfm';

/**
 * Real wire entries, captured 2026-09-30 from
 * `user.getrecenttracks?user=DreadRock&limit=6&format=json`.
 *
 * These are the production bytes, not a hand-written shape. Two of the six
 * entries in that response had the Last.fm placeholder
 * `2a96cbd8b46e442fc41c2b86b821562f` at EVERY size — small, medium, large and
 * extralarge alike — while the other four carried real art. That is the case
 * AGENTS.md golden rule 2 is about, and it is emphatically still true: a
 * placeholder is not a rare fallback, it is what a third of a real six-track
 * response looked like on the day these were captured.
 *
 * The placeholder is served as a DIFFERENT, larger-looking GIF per size
 * (`/u/34s/`, `/u/64s/`, `/u/174s/`, `/u/300x300/`), all four carrying the same
 * hash. So a converter that picked "the largest non-empty `#text`" would hand
 * back a real-looking 300×300 URL for an entity that has no artwork at all, and
 * the card would show a 1×1 GIF stretched across the whole embed. Only
 * `isPlaceholderImageUrl` stops that, which is why it is one shared predicate.
 *
 * The other thing these entries pin, and the reason they are worth more than a
 * synthetic fixture: `artist` and `album` arrive as
 * `{ mbid, "#text": "<name>" }` — the name under the hash-prefixed key, NOT
 * under `name`. `user.gettoptracks` sends the same ref as `{ url, name, mbid }`
 * instead, so BOTH shapes occur in production, from adjacent endpoints, in the
 * same week of data. And a missing MBID is `""`, not `null` and not absent.
 */
const PLACEHOLDER_TRACK = {
  artist: {
    mbid: '477b8c0c-c5fc-4ad2-b5b2-191f0bf2a9df',
    '#text': 'Armin van Buuren',
  },
  streamable: '0',
  image: [
    { size: 'small', '#text': 'https://lastfm-img.freetls.fastly.net/i/u/34s/2a96cbd8b46e442fc41c2b86b821562f.png' },
    { size: 'medium', '#text': 'https://lastfm-img.freetls.fastly.net/i/u/64s/2a96cbd8b46e442fc41c2b86b821562f.png' },
    { size: 'large', '#text': 'https://lastfm-img.freetls.fastly.net/i/u/174s/2a96cbd8b46e442fc41c2b86b821562f.png' },
    { size: 'extralarge', '#text': 'https://lastfm-img.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png' },
  ],
  mbid: 'c1945b02-f276-44f9-88e5-20a585ed5778',
  album: { mbid: '', '#text': 'Dream Dance Vol.48' },
  name: 'Fine Without You',
  url: 'https://www.last.fm/music/Armin+van+Buuren/_/Fine+Without+You',
  date: { uts: '1287702031', '#text': '21 Oct 2010, 23:00' },
} as RecentTrackLfm;

const REAL_ART_TRACK = {
  artist: {
    mbid: '2386cd66-e923-4e8e-bf14-2eebe2e9b973',
    '#text': '3 Doors Down',
  },
  streamable: '0',
  image: [
    { size: 'small', '#text': 'https://lastfm-img.freetls.fastly.net/i/u/34s/056ec23d90254b70b62aa84ce14876aa.png' },
    { size: 'medium', '#text': 'https://lastfm-img.freetls.fastly.net/i/u/64s/056ec23d90254b70b62aa84ce14876aa.png' },
    { size: 'large', '#text': 'https://lastfm-img.freetls.fastly.net/i/u/174s/056ec23d90254b70b62aa84ce14876aa.png' },
    { size: 'extralarge', '#text': 'https://lastfm-img.freetls.fastly.net/i/u/300x300/056ec23d90254b70b62aa84ce14876aa.png' },
  ],
  mbid: '1109f28c-b3cf-4d2a-b3df-8699176e65e1',
  album: { mbid: '1cd11eb6-bd9c-4cb6-98eb-ba06a24b80a5', '#text': 'Away from the Sun' },
  name: 'Going Down in Flames',
  url: 'https://www.last.fm/music/3+Doors+Down/_/Going+Down+in+Flames',
  date: { uts: '1287701742', '#text': '21 Oct 2010, 22:55' },
} as RecentTrackLfm;

/** Same response, but the two scrobbles with no MBID at all: `""`, not null. */
const NO_MBID_TRACK = {
  artist: { mbid: '', '#text': 'Verschiedene Künstler' },
  streamable: '0',
  image: [
    { size: 'small', '#text': 'https://lastfm-img.freetls.fastly.net/i/u/34s/2a96cbd8b46e442fc41c2b86b821562f.png' },
    { size: 'medium', '#text': 'https://lastfm-img.freetls.fastly.net/i/u/64s/2a96cbd8b46e442fc41c2b86b821562f.png' },
    { size: 'large', '#text': 'https://lastfm-img.freetls.fastly.net/i/u/174s/2a96cbd8b46e442fc41c2b86b821562f.png' },
    { size: 'extralarge', '#text': 'https://lastfm-img.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png' },
  ],
  mbid: '',
  album: { mbid: '', '#text': 'Keinohrhasen' },
  name: 'Apologize',
  url: 'https://www.last.fm/music/+noredirect/Verschiedene+K%C3%BCnstler/_/Apologize',
  date: { uts: '1287700959', '#text': '21 Oct 2010, 22:42' },
} as RecentTrackLfm;

describe('TrackConverter over live user.getrecenttracks entries (captured 2026-09-30)', () => {
  describe('the Last.fm placeholder, which golden rule 2 depends on', () => {
    it('yields NO image at all when every size is the placeholder', () => {
      // The assertion that matters. `undefined`, never the 300x300 placeholder
      // URL: a truthy 1x1 GIF stretched over a whole embed looks like real
      // artwork, and every caller downstream cannot tell it from a cover.
      const converted = TrackConverter.convertRecentTrack(PLACEHOLDER_TRACK);

      expect(converted.imageUrl).toBeUndefined();
    });

    it('rejects the placeholder per size, not just once the array is whole', () => {
      // Last.fm serves a DIFFERENT url per size (`/u/34s/`, `/u/64s/`, `/u/174s/`,
      // `/u/300x300/`) behind the one hash, so a filter that only inspected the
      // first or last entry would let three of the four through. One array per
      // size, so each is judged on its own.
      const sizes = PLACEHOLDER_TRACK.image ?? [];
      expect(sizes.length).toBe(4);
      for (const image of sizes) {
        expect(image['#text']).toContain('2a96cbd8b46e442fc41c2b86b821562f');
        expect(TrackConverter.pickLargestImage([image])).toBeUndefined();
      }
    });

    it('still takes the largest real size when the entry has real art', () => {
      // The control. Without it, a `pickLargestImage` that returned `undefined`
      // unconditionally would satisfy every assertion in the block above.
      const converted = TrackConverter.convertRecentTrack(REAL_ART_TRACK);

      expect(converted.imageUrl).toBe(
        'https://lastfm-img.freetls.fastly.net/i/u/300x300/056ec23d90254b70b62aa84ce14876aa.png',
      );
    });
  });

  describe('the `#text` name shape, which user.getrecenttracks actually sends', () => {
    it('reads the artist name from `#text`, not `name`', () => {
      // `user.gettoptracks` sends `{ url, name, mbid }` for the same ref. Both
      // shapes are in production, from adjacent endpoints, so a converter that
      // only read `name` would render an empty artist on every recent-track
      // card and still pass a fixture written as `{ name }`.
      expect(TrackConverter.convertRecentTrack(PLACEHOLDER_TRACK).artistName).toBe('Armin van Buuren');
      expect(TrackConverter.convertRecentTrack(REAL_ART_TRACK).artistName).toBe('3 Doors Down');
    });

    it('reads the album name from `#text`', () => {
      expect(TrackConverter.convertRecentTrack(PLACEHOLDER_TRACK).albumName).toBe('Dream Dance Vol.48');
    });

    it('keeps a non-ASCII artist name intact', () => {
      const converted = TrackConverter.convertRecentTrack(NO_MBID_TRACK);

      expect(converted.artistName).toBe('Verschiedene Künstler');
      expect(converted.albumName).toBe('Keinohrhasen');
    });
  });

  describe('a missing MBID is an empty string on the wire', () => {
    it('turns "" into undefined rather than persisting it', () => {
      const converted = TrackConverter.convertRecentTrack(NO_MBID_TRACK);

      expect(converted.trackMbid).toBeUndefined();
      expect(converted.artistMbid).toBeUndefined();
    });
  });

  describe('the fields the rest of the bot reads off a converted track', () => {
    it('parses the string `uts` into a Date', () => {
      // `uts` is a STRING in JSON, not a number. The expected value is UTC, so
      // it is written from the epoch and does not move with the machine's zone.
      const converted = TrackConverter.convertRecentTrack(REAL_ART_TRACK);

      expect(converted.timePlayed).toBeInstanceOf(Date);
      expect(converted.timePlayed?.getTime()).toBe(1_287_701_742_000);
      expect(converted.timePlayed?.toISOString()).toBe('2010-10-21T22:55:42.000Z');
    });

    it('reads now-playing as false when `@attr` is absent', () => {
      // Last.fm omits `@attr` entirely on a finished scrobble rather than
      // sending `@attr: { nowplaying: "0" }`. A truthiness check on a missing
      // key is false, so this is the shape that must not become `true`.
      expect(TrackConverter.convertRecentTrack(REAL_ART_TRACK).nowPlaying).toBe(false);
    });

    it('reads now-playing as true for the "1" Last.fm sends', () => {
      const nowPlaying = {
        ...REAL_ART_TRACK,
        '@attr': { nowplaying: 'true' },
      } as RecentTrackLfm;

      expect(TrackConverter.convertRecentTrack(nowPlaying).nowPlaying).toBe(true);
    });

    it('carries the scrobble name and url through unchanged', () => {
      const converted = TrackConverter.convertRecentTrack(REAL_ART_TRACK);

      expect(converted.name).toBe('Going Down in Flames');
      expect(converted.trackMbid).toBe('1109f28c-b3cf-4d2a-b3df-8699176e65e1');
      expect(converted.artistMbid).toBe('2386cd66-e923-4e8e-bf14-2eebe2e9b973');
    });
  });
});
