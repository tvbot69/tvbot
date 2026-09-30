/**
 * `ArtistTrackBuilders.buildArtistTopTracksResponse` — the artist top-tracks
 * card, which is the other half of the artist overview navigation.
 *
 * Two behaviours here are worth pinning on their own:
 *
 *  1. `partialIndexNotice` is the card's honesty valve. A library that is still
 *     indexing renders a shorter list, and the ONLY thing that tells the user
 *     the list is short is that extra line. Losing it turns "we have not finished
 *     counting" into "these are your top ten", so both directions are asserted.
 *  2. The paginator clamps its `page` before slicing, exactly like its album
 *     sibling — see the last describe block.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ComponentType } from 'discord.js';
import { ArtistTrackBuilders } from './artistTrackBuilders';
import type { ResponseModel } from '@bot/models/responseModel';

interface Cv2Component {
  type: number;
  content?: string;
  components?: Cv2Component[];
  emoji?: string | { id?: string; name?: string };
  custom_id?: string;
  label?: string;
  disabled?: boolean;
}

const json = (response: ResponseModel) =>
  response.componentsV2Container!.toJSON() as unknown as { components: Cv2Component[]; accent_color?: number };

const texts = (response: ResponseModel): string[] =>
  json(response).components.filter(c => c.type === ComponentType.TextDisplay).map(c => c.content ?? '');

const buttons = (response: ResponseModel): Cv2Component[] =>
  json(response).components.filter(c => c.type === ComponentType.ActionRow).flatMap(c => c.components ?? []);

const body = (response: ResponseModel): string => texts(response).join('\n');

const tracks = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `Track ${i + 1}`, playcount: i + 1 }));

const card = (
  list: Array<{ name: string; playcount: number }>,
  over: {
    page?: number;
    totalArtistPlays?: number;
    distinctCount?: number;
    accentColor?: number;
    artistId?: string | number;
    targetUserId?: string;
    authorUserId?: string;
    partialIndexNotice?: boolean;
  } = {},
) =>
  ArtistTrackBuilders.buildArtistTopTracksResponse(
    'Radiohead',
    'Tester',
    list,
    over.totalArtistPlays ?? 1500,
    over.distinctCount ?? list.length,
    over.page ?? 0,
    over.accentColor,
    over.artistId,
    over.targetUserId,
    over.authorUserId,
    over.partialIndexNotice ?? false,
  );

describe('ArtistTrackBuilders.buildArtistTopTracksResponse', () => {
  it('claims one page of one for an artist with no tracks, and says so in words', () => {
    const response = card([]);
    const text = body(response);
    expect(text).toContain('Page 1/1 — 0 different tracks');
    expect(text).toContain('No tracks found.');
    expect(response.isComponentsV2).toBe(true);
    expect(json(response).components.length).toBeGreaterThan(0);
  });

  it('carries the whole track list and totals on the response so any page can be re-rendered', () => {
    // `_atData` is what the next page is built from. If it held the SLICE, page 2
    // would be built from page 1 and quietly lose tracks.
    const response = card(tracks(25), { page: 1 });
    expect(response._atData).toEqual({
      artistName: 'Radiohead',
      tracks: tracks(25),
      totalArtistPlays: 1500,
      distinctCount: 25,
    });
  });

  it('keeps ranking continuous across pages', () => {
    const text = body(card(tracks(25), { page: 1 }));
    expect(text).toContain('Page 2/3 — 25 different tracks');
    expect(text).toContain('11. **Track 11** - *11 plays*');
    expect(text).not.toContain('1. **Track 1**');
  });

  it('singularises a single play and a single total artist play', () => {
    const one = body(card([{ name: 'Weird Fishes', playcount: 1 }], { totalArtistPlays: 1 }));
    expect(one).toContain('1. **Weird Fishes** - *1 play*');
    expect(one).toContain('Tester has 1 total artist play\n');
  });

  it('warns that results are partial only when the caller says the index is unfinished', () => {
    const indexing = body(card(tracks(3), { partialIndexNotice: true }));
    const settled = body(card(tracks(3), { partialIndexNotice: false }));

    expect(indexing).toContain('Library still indexing — showing partial results, run this again in a bit');
    expect(settled).not.toContain('Library still indexing');
    // Both still carry the standing caveat about the 6000-item chart ceiling.
    expect(settled).toContain('Some tracks outside of top 6000 might not be visible');
  });

  it('falls back to a URL-encoded artist name and user id 0 when no ids were supplied', () => {
    // This is the path a bare internal caller takes. The buttons must still be
    // routable rather than carrying "undefined" into a custom id.
    const ids = buttons(card(tracks(25))).map(b => b.custom_id);
    expect(ids).toContain('at:first:0:Radiohead:0:0');
    expect(ids).toContain('artist-overview:Radiohead:0:0');
    expect(JSON.stringify(ids)).not.toContain('undefined');
  });

  it('uses the supplied ids verbatim when the caller has them', () => {
    const ids = buttons(card(tracks(25), { page: 2, artistId: 7, targetUserId: 't', authorUserId: 'a' })).map(
      b => b.custom_id,
    );
    expect(ids).toContain('at:next:2:7:t:a');
    expect(ids).toContain('at:first:2:7:t:a');
    expect(ids).toContain('artist-overview:7:t:a');
  });

  it('disables ◀️ on page 0 and ▶️ on the last page', () => {
    const first = buttons(card(tracks(25), { page: 0, artistId: 7, targetUserId: 't', authorUserId: 'a' }));
    const last = buttons(card(tracks(25), { page: 2, artistId: 7, targetUserId: 't', authorUserId: 'a' }));

    expect(first.find(b => b.custom_id === 'at:prev:0:7:t:a')?.disabled).toBe(true);
    expect(first.find(b => b.custom_id === 'at:next:0:7:t:a')?.disabled).toBe(false);
    expect(last.find(b => b.custom_id === 'at:next:2:7:t:a')?.disabled).toBe(true);
    expect(last.find(b => b.custom_id === 'at:prev:2:7:t:a')?.disabled).toBe(false);
  });

  it('disables both directions when the whole list fits on one page', () => {
    const single = buttons(card(tracks(4), { artistId: 7, targetUserId: 't', authorUserId: 'a' }));
    expect(single.find(b => b.custom_id === 'at:first:0:7:t:a')?.disabled).toBe(true);
    expect(single.find(b => b.custom_id === 'at:last:0:7:t:a')?.disabled).toBe(true);
  });

  it('sets the container accent only when one was supplied', () => {
    expect(json(card(tracks(1), { accentColor: 0x445566 })).accent_color).toBe(0x445566);
    expect(json(card(tracks(1))).accent_color).toBeUndefined();
  });
});

/**
 * The paginator CLAMPS. `totalPages` is computed and `page` is pinned into
 * `[0, totalPages - 1]` before the slice is taken, so an out-of-range index
 * renders the last (or first) real page instead of printing a page number that
 * does not exist together with "No tracks found." — which read as a claim about
 * the listener's music on a card that was really a claim about their button press.
 */
describe('ArtistTrackBuilders.buildArtistTopTracksResponse: a page past the end', () => {
  it('clamps onto the last real page and lists that page’s tracks', () => {
    const text = body(card(tracks(25), { page: 99 }));
    expect(text).toContain('Page 3/3 — 25 different tracks');
    expect(text).toContain('21. **Track 21** - *21 plays*');
    expect(text).toContain('25. **Track 25** - *25 plays*');
    expect(text).not.toContain('No tracks found.');
  });

  it('never prints a page number that does not exist', () => {
    expect(body(card(tracks(25), { page: 99 }))).not.toContain('Page 100/3');
    expect(body(card(tracks(25), { page: 99 }))).toBe(body(card(tracks(25), { page: 2 })));
  });

  it('clamps a negative index back onto page 1 rather than printing a zero page number', () => {
    const text = body(card(tracks(25), { page: -1 }));
    expect(text).toContain('Page 1/3 — 25 different tracks');
    expect(text).not.toContain('Page 0/3');
    expect(text).toBe(body(card(tracks(25), { page: 0 })));
  });

  it('disables forward navigation on the clamped page and leaves the way back live', () => {
    const over = buttons(card(tracks(25), { page: 99, artistId: 7, targetUserId: 't', authorUserId: 'a' }));
    expect(over.find(b => b.custom_id === 'at:next:2:7:t:a')?.disabled).toBe(true);
    expect(over.find(b => b.custom_id === 'at:last:2:7:t:a')?.disabled).toBe(true);
    expect(over.find(b => b.custom_id === 'at:first:2:7:t:a')?.disabled).toBe(false);
    expect(over.find(b => b.custom_id === 'at:prev:2:7:t:a')?.disabled).toBe(false);
  });
});
