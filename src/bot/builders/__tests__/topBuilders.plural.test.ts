import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { TopBuilders } from '../topBuilders';
import type { TopBuildersDeps } from '../topBuildersDeps';
import type { TimeSettingsModel } from '@domain/models/timeSettings';
import { TimePeriod } from '@domain/enums/timePeriod';

/**
 * The three top-list footers printed "N different X" whatever N was, so a
 * single-entry result read "1 different artists". Pinned in both directions: an
 * assertion that only checked the singular would also pass on a builder that
 * always printed the singular.
 *
 * `.topartists`, `.topalbums` and `.topttracks` are three separate call sites
 * with three separate templates, so all three are checked — a fix that touched
 * one of them would still leave the defect in the other two.
 */

const deps = (over: Partial<TopBuildersDeps> = {}): TopBuildersDeps =>
  ({
    fetchArtwork: vi.fn(async () => null),
    ...over,
  }) as unknown as TopBuildersDeps;

const settings = {
  timePeriod: TimePeriod.Weekly,
  description: 'Weekly',
  urlParameter: 'LAST_7_DAYS',
} as unknown as TimeSettingsModel;

const artist = (name: string) => ({ name, playcount: 42, imageUrl: undefined });
const album = (name: string) => ({ name, artistName: 'Aphex Twin', playcount: 42, imageUrl: undefined });
const track = (name: string) => ({ name, artistName: 'Aphex Twin', playcount: 42, imageUrl: undefined });

const footer = (response: { embed: { toJSON: () => { footer?: { text?: string } } } }): string =>
  response.embed.toJSON().footer?.text ?? '';

describe('TopBuilders: the noun agrees with the count', () => {
  it('says "1 different artist" for a single artist', async () => {
    const response = await TopBuilders.buildTopArtistsResponse(
      deps(),
      'alice',
      'Alice',
      [artist('Aphex Twin')],
      settings,
      1,
    );
    expect(footer(response)).toContain('1 different artist');
    expect(footer(response)).not.toContain('1 different artists');
  });

  it('still says "different artists" for two', async () => {
    const response = await TopBuilders.buildTopArtistsResponse(
      deps(),
      'alice',
      'Alice',
      [artist('Aphex Twin'), artist('Boards of Canada')],
      settings,
      1,
    );
    expect(footer(response)).toContain('2 different artists');
  });

  it('says "1 different album" for a single album', async () => {
    const response = await TopBuilders.buildTopAlbumsResponse(
      deps(),
      'alice',
      'Alice',
      [album('SAW')],
      settings,
      1,
    );
    expect(footer(response)).toContain('1 different album');
    expect(footer(response)).not.toContain('1 different albums');
  });

  it('says "1 different track" for a single track', async () => {
    const response = await TopBuilders.buildTopTracksResponse(
      deps(),
      'alice',
      'Alice',
      [track('Xtal')],
      settings,
      1,
    );
    expect(footer(response)).toContain('1 different track');
    expect(footer(response)).not.toContain('1 different tracks');
  });

  it('still says "different tracks" for two', async () => {
    const response = await TopBuilders.buildTopTracksResponse(
      deps(),
      'alice',
      'Alice',
      [track('Xtal'), track('Tha')],
      settings,
      1,
    );
    expect(footer(response)).toContain('2 different tracks');
  });
});
