import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TrackService } from '@bot/services/library/trackService';

/**
 * Tombstone for `getAverageTrackAudioFeaturesForTopTracks`.
 *
 * It selected `danceability, energy, valence, tempo, acousticness` FROM
 * `tracks`. No migration ever created those columns, so the query failed 42703
 * on 100% of calls, and its own `.catch(() => [])` turned that into an
 * all-zeros "overview" - a feature that had never worked and never said so.
 *
 * A test that pinned the zeros read like a spec and would have convinced the
 * next reader it was intended. There is no such test now. These two are the
 * replacement: they are cheap, they need no database, and they go red the
 * moment the broken query comes back.
 */

/** The five columns the deleted query selected. */
const PHANTOM_COLUMNS = ['danceability', 'energy', 'valence', 'tempo', 'acousticness'] as const;

const schema = readFileSync(join(process.cwd(), 'src/persistence/prisma/schema.prisma'), 'utf8');
const trackServiceSource = readFileSync(join(process.cwd(), 'src/bot/services/library/trackService.ts'), 'utf8');

/** Field names declared on `model Track`, @map targets included. */
const trackModelBody = (() => {
  const start = schema.indexOf('\nmodel Track {');
  expect(start, 'schema.prisma no longer declares `model Track`').toBeGreaterThan(-1);
  return schema.slice(start, schema.indexOf('\n}', start));
})();

describe('the audio-feature columns that were never there', () => {
  it('are not on the Track model, because nothing in this codebase writes them', () => {
    const declared = trackModelBody
      .split('\n')
      .map((line) => /^\s*(\w+)\s+\w+/.exec(line)?.[1])
      .filter((f): f is string => Boolean(f));

    for (const column of PHANTOM_COLUMNS) {
      expect(
        declared.includes(column),
        `Track now declares \`${column}\`. Nothing fetches Spotify audio features anywhere in this tree, ` +
          'so a column alone is a feature that still does nothing. Add the writer and restore the feature ' +
          'deliberately, or drop the column again - do not let a query read a permanently-NULL column.',
      ).toBe(false);
    }
  });

  it('are not selected by any raw query left in trackService', () => {
    // The strongest half of the tombstone: `tracks` was the only table the
    // deleted query read, so no raw query in this service may name it. A real
    // query against `tracks` one day is legitimate - delete this assertion then.
    expect(
      /FROM\s+tracks\b/i.test(trackServiceSource),
      'trackService.ts has a raw query against `tracks` again. If it reads audio-feature columns, ' +
        'it is failing on every call behind a silent catch. If it does not, delete this assertion.',
    ).toBe(false);
  });

  it('have no method left on TrackService to consume them', () => {
    expect(
      Object.getOwnPropertyNames(TrackService.prototype),
      'TrackService grew a method for the deleted audio-feature query. Read the header of this file first.',
    ).not.toContain('getAverageTrackAudioFeaturesForTopTracks');
  });
});
