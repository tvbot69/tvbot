import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TopListConverter } from '@lastfm/converters/topListConverter';
import type { WeeklyArtistChartResponseLfm } from '@lastfm/models/topListsLfm';

/**
 * The `@attr` keys below (`from`, `user`, `to`) and the outer envelope shape
 * were measured against the live API with a real key, not guessed:
 *
 *   user.getweeklyartistchart ->
 *   { weeklyartistchart: { artist: array, '@attr': { from, user, to } } }
 *
 * See `probe-weekly.mjs`. The item-level fixtures are trimmed from that same
 * response, so the field names the converter reads are the ones Last.fm sends.
 */
const measuredAttrs = { user: 'someone', from: '1704067200', to: '1704672000' };

describe('TopListConverter weekly charts', () => {
  describe('convertWeeklyArtistChart', () => {
    it('converts a multi-entry chart', () => {
      const response: WeeklyArtistChartResponseLfm = {
        weeklyartistchart: {
          '@attr': measuredAttrs,
          artist: [
            { name: 'Radiohead', playcount: '40', mbid: 'a74b1b7f', url: 'https://last.fm/music/Radiohead' },
            { name: 'Boards of Canada', playcount: '12' },
          ],
        },
      };

      expect(TopListConverter.convertWeeklyArtistChart(response)).toEqual([
        { name: 'Radiohead', playcount: 40, mbid: 'a74b1b7f', url: 'https://last.fm/music/Radiohead' },
        { name: 'Boards of Canada', playcount: 12, mbid: undefined, url: undefined },
      ]);
    });

    it('returns an empty list for a measured empty chart, not a throw', () => {
      // The probe returned `artist: array(0)` for a user with no weekly plays.
      const response: WeeklyArtistChartResponseLfm = {
        weeklyartistchart: { '@attr': measuredAttrs, artist: [] },
      };
      expect(TopListConverter.convertWeeklyArtistChart(response)).toEqual([]);
    });

    it('accepts a single-entry chart delivered as a bare object', () => {
      // Last.fm returns the object, not a one-element array, when a chart holds
      // exactly one entry. I could NOT reproduce this with the usernames I
      // tried, so this documents the branch as defensive rather than confirmed.
      // What matters here is that the type permits the shape and the converter
      // does not throw on it - if someone narrows the type back to an array,
      // this test starts failing to type-check, which is the point.
      const response = {
        weeklyartistchart: { artist: { name: 'Only One', playcount: '7' } },
      } as WeeklyArtistChartResponseLfm;

      expect(TopListConverter.convertWeeklyArtistChart(response)).toEqual([
        { name: 'Only One', playcount: 7, mbid: undefined, url: undefined },
      ]);
    });

    it('returns an empty list when the chart is absent, as on an error response', () => {
      // The optional chain in the converter is load-bearing, not defensive
      // noise: Last.fm replies `{ error: 6, message: ... }` for an unknown user
      // and the caller caches on `result.length > 0`, so a throw here would
      // take down the whole weekly command rather than degrade it.
      const response: WeeklyArtistChartResponseLfm = { error: 6, message: 'User not found' };
      expect(TopListConverter.convertWeeklyArtistChart(response)).toEqual([]);
      expect(TopListConverter.convertWeeklyArtistChart({})).toEqual([]);
    });

    it('coerces a non-numeric playcount to 0 instead of NaN', () => {
      // `playcount` is typed as a string, so this is a contract violation. NaN
      // would render as "NaN plays" in the embed, which is worse than 0.
      const response = {
        weeklyartistchart: { artist: [{ name: 'Odd', playcount: 'not-a-number' }] },
      } as WeeklyArtistChartResponseLfm;
      const [first] = TopListConverter.convertWeeklyArtistChart(response);
      expect(first).toBeDefined();
      expect(first?.playcount).toBe(0);
    });
  });

  describe('convertWeeklyAlbumChart', () => {
    it('converts albums and keeps the largest cover', () => {
      const response = {
        weeklyalbumchart: {
          album: [
            {
              name: 'Kid A',
              playcount: '9',
              artist: { name: 'Radiohead' },
              image: [
                { '#text': 'https://last.fm/small.png', size: 'small' },
                { '#text': 'https://last.fm/exlarge.png', size: 'extralarge' },
              ],
            },
          ],
        },
      } as unknown as import('@lastfm/models/topListsLfm').WeeklyAlbumChartResponseLfm;

      const [album] = TopListConverter.convertWeeklyAlbumChart(response);
      expect(album).toBeDefined();
      expect(album?.name).toBe('Kid A');
      expect(album?.artistName).toBe('Radiohead');
      expect(album?.playcount).toBe(9);
      expect(album?.imageUrl).toBe('https://last.fm/exlarge.png');
    });

    it('reads an artist delivered as a bare string', () => {
      // `artist` is `{...} | string` in the type. This is the branch that makes
      // `extractArtistName` a union check rather than an optimisation.
      const response = {
        weeklyalbumchart: { album: [{ name: 'X', playcount: '1', artist: 'Solo' }] },
      } as unknown as import('@lastfm/models/topListsLfm').WeeklyAlbumChartResponseLfm;

      const [album] = TopListConverter.convertWeeklyAlbumChart(response);
      expect(album).toBeDefined();
      expect(album?.artistName).toBe('Solo');
    });
  });

  describe('convertWeeklyTrackChart', () => {
    it('converts tracks and reads a string artist', () => {
      const response = {
        weeklytrackchart: {
          track: [{ name: 'Everything In Its Right Place', playcount: '5', artist: 'Radiohead' }],
        },
      } as unknown as import('@lastfm/models/topListsLfm').WeeklyTrackChartResponseLfm;

      const [track] = TopListConverter.convertWeeklyTrackChart(response);
      expect(track).toBeDefined();
      expect(track?.name).toBe('Everything In Its Right Place');
      expect(track?.artistName).toBe('Radiohead');
      expect(track?.playcount).toBe(5);
    });
  });
});
