/**
 * The two page-jump modal catches in `topInteractions` are the OTHER half of
 * the story in `topInteractions.silentSource.test.ts`, and they are left alone
 * on purpose. Both are the real boundary for their read: `tryHandleModal` only
 * logs whatever escapes, so if these catches re-threw the user would get nothing
 * at all. Instead they answer the modal reply with "Failed to jump to page." -
 * a true statement about what did not happen, not an empty chart, a zero, or a
 * "no data found" line the user could mistake for a genuine empty. The reads
 * raise before any builder runs, so no plausible wrong number can escape here.
 *
 * That trade is the deliverable, so it is pinned rather than left to a comment.
 * If someone later narrows these catches the way the button handler was
 * narrowed, these tests go red and say why that would be wrong.
 *
 * WHY ONE INSTANCE FOR THE WHOLE FILE. `registerModalHandler` pushes onto a
 * MODULE-level array and `tryHandleModal` dispatches to the FIRST match, so
 * every handler ever constructed in this process stays reachable and the oldest
 * one wins. Building a fresh `TopInteractions` per test would silently test the
 * first instance's collaborators instead. So there is exactly one instance, and
 * its doubles are re-programmed per test.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TopInteractions } from '../topInteractions';
import { TopBuilders } from '@bot/builders/topBuilders';
import { tryHandleModal } from '@bot/interactions';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import type { ModalSubmitInteraction } from 'discord.js';

const overviewHolder = vi.hoisted(() => ({
  getOverview: async (): Promise<{ dailyBlocks: never[] }> => ({ dailyBlocks: [] }),
}));

vi.mock('@bot/services/overviewService', () => ({
  OverviewService: class {
    public getOverview(): Promise<{ dailyBlocks: never[] }> {
      return overviewHolder.getOverview();
    }
  },
}));

const LFM_DOWN = (): LastFmUnavailableError =>
  new LastFmUnavailableError('user.gettopartists', new Error('Last.fm returned HTTP 500'));

const DB_DOWN = (): SourceUnavailableError =>
  new SourceUnavailableError('overviewService.getOverview', new Error('connect ECONNREFUSED'), 'Database unavailable');

const BUILT_RESPONSE = {
  componentsV2Container: undefined,
  buildEmbed: () => ({ embeds: [] }),
  buildComponents: () => [],
  toMessagePayload: () => ({ embeds: [] }),
};

const getTopArtists = vi.fn(async () => [{ name: 'Artist 1', playcount: 100 }]);
const getTopAlbums = vi.fn(async () => [{ name: 'Album 1', playcount: 50 }]);
const getTopTracks = vi.fn(async () => [{ name: 'Track 1', playcount: 200 }]);
const getTimePeriod = vi.fn(() => ({ timePeriod: 'overall', description: 'All time' }));
const getAccentColorAsync = vi.fn(async () => 0xff0000);

/** Read name -> the double, so `it.each` can name a read without a lookup cast. */
const READS: Record<string, ReturnType<typeof vi.fn>> = {
  getTopArtists,
  getTopAlbums,
  getTopTracks,
};

// Constructed for its SIDE EFFECT, never for use. `TopInteractions` registers
// its modal handlers into a module-level registry in the constructor, and the
// tests below drive `tryHandleModal`, which reads that registry. Delete this
// line and every test below still passes - vacuously, because there is no
// handler left to dispatch to. `void` states the intent and satisfies
// `no-unused-vars`, which would otherwise call it dead code.
//
// Constructor arity is three, in this order:
// `lastfmRepository`, `settingService`, `colorService`.
// Constructed for its SIDE EFFECT, never for use. `TopInteractions` registers
// its modal handlers into a module-level registry in the constructor, and the
// tests below drive `tryHandleModal`, which reads that registry. Delete this
// line and every test below still runs - and every one of them fails, which is
// the check that keeps this line from being deleted as dead code: mutation
// checked, 7 of 7 red without it. `void` states the intent and satisfies
// `no-unused-vars`, which would otherwise call it dead code.
//
// Constructor arity is three, in this order:
// `lastfmRepository`, `settingService`, `colorService`.
void new TopInteractions(
  { getTopArtists, getTopAlbums, getTopTracks } as never,
  { getTimePeriod } as never,
  { getAccentColorAsync } as never,
);

const mkModal = (customId: string, pageValue: string) =>
  ({
    customId,
    guildId: 'g1',
    fields: { getTextInputValue: vi.fn(() => pageValue) },
    deferReply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  }) as unknown as ModalSubmitInteraction & {
    deferReply: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };

/** True when the handler gave up, which is the message the user actually reads. */
const gaveUp = (modal: ReturnType<typeof mkModal>): boolean =>
  modal.editReply.mock.calls.some(
    (call) => typeof (call[0] as { content?: unknown } | undefined)?.content === 'string'
      && (call[0] as { content: string }).content.includes('Failed to jump'),
  );

/**
 * True when the REAL `OverviewBuilders` output reached the modal reply. The
 * builder is deliberately not stubbed in this file, so this is a text assertion
 * on what the user would actually see rather than a call-count on a spy.
 */
const renderedOverview = (modal: ReturnType<typeof mkModal>): boolean =>
  modal.editReply.mock.calls.some(
    (call) => JSON.stringify(call[0] ?? null).includes('Daily overview for'),
  );

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(TopBuilders, 'buildTopArtistsResponse').mockResolvedValue(BUILT_RESPONSE as never);
  vi.spyOn(TopBuilders, 'buildTopAlbumsResponse').mockResolvedValue(BUILT_RESPONSE as never);
  vi.spyOn(TopBuilders, 'buildTopTracksResponse').mockResolvedValue(BUILT_RESPONSE as never);
  getTopArtists.mockReset().mockResolvedValue([{ name: 'Artist 1', playcount: 100 }]);
  getTopAlbums.mockReset().mockResolvedValue([{ name: 'Album 1', playcount: 50 }]);
  getTopTracks.mockReset().mockResolvedValue([{ name: 'Track 1', playcount: 200 }]);
  getTimePeriod.mockReset().mockReturnValue({ timePeriod: 'overall', description: 'All time' });
  getAccentColorAsync.mockReset().mockResolvedValue(0xff0000);
  overviewHolder.getOverview = async () => ({ dailyBlocks: [] });
});

describe('top-jump modal: a Last.fm outage is stated, not rendered', () => {
  it.each([
    ['topartists', 'getTopArtists'],
    ['topalbums', 'getTopAlbums'],
    ['toptracks', 'getTopTracks'],
  ])('%s tells the user the jump failed instead of showing an empty page', async (prefix, read) => {
    const modal = mkModal(`top-jump:${prefix}:user1:weekly`, '2');
    READS[read]!.mockRejectedValue(LFM_DOWN());

    await tryHandleModal(modal);

    expect(gaveUp(modal)).toBe(true);
    // No chart was built at all, so there is no wrong number on screen.
    expect(TopBuilders.buildTopArtistsResponse).not.toHaveBeenCalled();
    expect(TopBuilders.buildTopAlbumsResponse).not.toHaveBeenCalled();
    expect(TopBuilders.buildTopTracksResponse).not.toHaveBeenCalled();
  });

  it('still shows the page when the read ran and returned nothing', async () => {
    // The honest empty. If this went through the same "Failed to jump" path, the
    // fix above would have made "no plays in this period" indistinguishable from
    // "Last.fm is down".
    const modal = mkModal('top-jump:topartists:user1:weekly', '2');
    getTopArtists.mockResolvedValue([]);

    await tryHandleModal(modal);

    expect(TopBuilders.buildTopArtistsResponse).toHaveBeenCalledTimes(1);
    // Page 0, not the requested page 1: the clamp is `Math.min(targetPage,
    // ceil(items.length / 10) - 1)`, and an empty list has no page 1 to show.
    // That clamp is the honest empty, and it is what proves this path did not
    // go through the "Failed to jump" catch.
    expect(TopBuilders.buildTopArtistsResponse).toHaveBeenCalledWith(
      expect.anything(), 'user1', 'user1', [], expect.anything(), 0, 0xff0000,
    );
    expect(gaveUp(modal)).toBe(false);
  });

  it('still shows the page when the read succeeds', async () => {
    const modal = mkModal('top-jump:topartists:user1:weekly', '2');

    await tryHandleModal(modal);

    expect(TopBuilders.buildTopArtistsResponse).toHaveBeenCalledTimes(1);
    expect(gaveUp(modal)).toBe(false);
  });
});

describe('overview-jump modal: a database outage is stated, not rendered', () => {
  it('tells the user the jump failed instead of showing an empty overview', async () => {
    const modal = mkModal('overview-jump:user1:weekly', '2');
    overviewHolder.getOverview = async () => { throw DB_DOWN(); };

    await tryHandleModal(modal);

    expect(gaveUp(modal)).toBe(true);
    // The real `OverviewBuilders` was never reached, so the card the user is
    // left holding is the "Failed to jump" text and nothing that could read as
    // a chart of zeroes.
    expect(renderedOverview(modal)).toBe(false);
  });

  it('still shows the overview when getOverview ran and returned no daily blocks', async () => {
    // `{ dailyBlocks: [] }` is what `overviewService.getOverview` itself returns
    // for a genuine absence, and the REAL `OverviewBuilders` renders it - the
    // builder is not stubbed here, so "the overview rendered" is asserted on
    // the text the user would read.
    const modal = mkModal('overview-jump:user1:weekly', '2');

    await tryHandleModal(modal);

    expect(gaveUp(modal)).toBe(false);
    expect(renderedOverview(modal)).toBe(true);
  });
});
