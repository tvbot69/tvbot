/**
 * `OverviewBuilders.buildOverviewResponse` — the `.overview` daily-listeners card.
 *
 * The footer is the claim this file is about:
 *
 *   -# 1/2 - Top genres, artist, album and track
 *   -# 3 unique tracks - 20 total plays - 5 avg
 *
 * Every number in it is computed from the SLICE for the current page, and a
 * `page` index that is out of range produces an empty slice — which means the
 * card would say "0 unique tracks - 0 total plays - 0 avg" and a page counter
 * like "6/2". That is a confident wrong answer about somebody's listening, and
 * it is a real defect: this paginator does not clamp. It is recorded in the last
 * describe block rather than asserted as correct, and the in-range behaviour is
 * pinned honestly here.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ComponentType } from 'discord.js';
import { OverviewBuilders } from './overviewBuilders';
import type { DailyBlock, OverviewResult } from '@bot/services/overviewService';
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

/** The last text block, which is always the footer. */
const footer = (response: ResponseModel): string => texts(response).slice(-1)[0] ?? '';

const block = (over: Partial<DailyBlock> = {}): DailyBlock => ({
  date: new Date('2026-09-20T00:00:00Z'),
  epochSeconds: 1_789_516_800,
  playCount: 4,
  durationMs: 4 * 3_600_000,
  topArtist: 'Radiohead',
  topAlbum: 'OK Computer',
  topTrack: 'Airbag',
  genres: ['art rock'],
  trackKeys: ['Radiohead|Airbag'],
  ...over,
});

const overview = (dailyBlocks: DailyBlock[]) => ({ dailyBlocks }) as OverviewResult;

const days = (count: number) => Array.from({ length: count }, (_, i) => block({ epochSeconds: 1_789_516_800 - i * 86_400 }));

const card = (result: OverviewResult, page = 0, userNameLastFm = 'tester', timeDescription = 'weekly') =>
  OverviewBuilders.buildOverviewResponse(userNameLastFm, 'Tester', timeDescription, result, page);

describe('OverviewBuilders.buildOverviewResponse', () => {
  it('claims one page of one, with real zeroes, for a user with no listening at all', () => {
    // The empty direction. There genuinely are no days here, so "0 total plays"
    // is a true statement rather than a fabricated one.
    const text = body(card(overview([])));
    expect(footer(card(overview([])))).toContain('-# 1/1 - Top genres, artist, album and track');
    expect(footer(card(overview([])))).toContain('0 unique tracks - 0 total plays - 0 avg');
    expect(text).toContain('### Daily overview for [Tester]');
  });

  it('puts four days on a page and claims two pages for eight', () => {
    const result = overview(days(8));
    expect(footer(card(result, 0))).toContain('-# 1/2 -');
    expect(footer(card(result, 1))).toContain('-# 2/2 -');
    // Four day blocks plus the title plus the footer.
    expect(texts(card(result, 0))).toHaveLength(6);
    expect(texts(card(result, 1))).toHaveLength(6);
  });

  it('sums only the days on the current page, not the whole period', () => {
    const result = overview(days(8).map(d => ({ ...d, playCount: 10 })));
    expect(footer(card(result, 0))).toContain('40 total plays');
    expect(footer(card(result, 1))).toContain('40 total plays');
  });

  it('rounds the daily average to a whole play rather than printing a fraction', () => {
    const result = overview([block({ playCount: 4 }), block({ playCount: 5 })]);
    expect(footer(card(result))).toContain('9 total plays - 5 avg');
  });

  it('counts a track listened to on two days once, not twice', () => {
    const result = overview([
      block({ trackKeys: ['Radiohead|Airbag', 'Radiohead|Let Down'] }),
      block({ trackKeys: ['Radiohead|Airbag'] }),
    ]);
    expect(footer(card(result))).toContain('2 unique tracks');
  });

  it('drops the genre line for a day with no genres, and the blank does not leave a hole', () => {
    const result = overview([block({ genres: [] })]);
    const dayBlock = texts(card(result))[1] ?? '';
    expect(dayBlock).not.toContain('-# *');
    expect(dayBlock).not.toContain('\n\n');
    expect(dayBlock.split('\n')).toHaveLength(4);
  });

  it('joins several genres with a dash', () => {
    const result = overview([block({ genres: ['art rock', 'trip hop', 'electronic'] })]);
    expect(texts(card(result))[1]).toContain('-# *art rock - trip hop - electronic*');
  });

  it('omits a day line for an artist, album or track it could not name', () => {
    // No genres either, so the header line is the only thing left. The header line
    // is all that is left: no three empty lines pretending to be a top artist,
    // album and track.
    const result = overview([block({ topArtist: null, topAlbum: null, topTrack: null, genres: [] })]);
    const dayBlock = texts(card(result))[1] ?? '';
    expect(dayBlock).toContain('4 plays');
    expect(dayBlock.split('\n')).toHaveLength(1);
  });

  it('drops only the three unknown names, and keeps the genre line with them', () => {
    // The same nulls with a genre to report still leave no blank lines behind.
    const result = overview([block({ topArtist: null, topAlbum: null, topTrack: null })]);
    const dayBlock = texts(card(result))[1] ?? '';
    expect(dayBlock.split('\n')).toHaveLength(2);
    expect(dayBlock).toContain('-# *art rock*');
    expect(dayBlock).not.toMatch(/^\s*$/m);
  });

  it('renders an under-hour day in minutes and a multi-hour day in hours and minutes', () => {
    const minutes = card(overview([block({ durationMs: 45 * 60_000 })]));
    const hours = card(overview([block({ durationMs: 3 * 3_600_000 + 25 * 60_000 })]));
    expect(texts(minutes)[1]).toContain('— 45m —');
    expect(texts(hours)[1]).toContain('— 3h25m —');
  });

  it('links the header at the user library, URL-encoded', () => {
    const response = OverviewBuilders.buildOverviewResponse('two words', 'Two Words', 'weekly', overview(days(1)), 0);
    expect(texts(response)[0]).toContain('https://last.fm/user/two%20words/library?date_preset=LAST_7_DAYS');
  });

  it('url-encodes the user and the period into every paginator custom id', () => {
    const ids = buttons(
      OverviewBuilders.buildOverviewResponse('two words', 'T', 'last month', overview(days(8)), 1),
    ).map(b => b.custom_id);
    expect(ids).toContain('overview:first:1:two%20words:last%20month');
    expect(ids).toContain('overview:next:1:two%20words:last%20month');
  });

  it('falls back to self and weekly when the caller supplied neither a user nor a period', () => {
    const ids = buttons(OverviewBuilders.buildOverviewResponse('tester', 'T', '', overview(days(1)), 0)).map(
      b => b.custom_id,
    );
    expect(ids[0]).toBe('overview:first:0:tester:weekly');
  });

  it('disables backward navigation on page 0 and forward navigation on the last page', () => {
    const first = buttons(card(overview(days(8)), 0));
    const last = buttons(card(overview(days(8)), 1));
    expect(first.find(b => b.custom_id?.startsWith('overview:prev:'))?.disabled).toBe(true);
    expect(first.find(b => b.custom_id?.startsWith('overview:first:'))?.disabled).toBe(true);
    expect(first.find(b => b.custom_id?.startsWith('overview:next:'))?.disabled).toBe(false);
    expect(last.find(b => b.custom_id?.startsWith('overview:next:'))?.disabled).toBe(true);
    expect(last.find(b => b.custom_id?.startsWith('overview:last:'))?.disabled).toBe(true);
    expect(last.find(b => b.custom_id?.startsWith('overview:prev:'))?.disabled).toBe(false);
  });

  it('disables every direction when there is only one page', () => {
    const row = buttons(card(overview(days(2)), 0));
    expect(row.filter(b => b.disabled).map(b => b.custom_id)).toEqual([
      'overview:first:0:tester:weekly',
      'overview:prev:0:tester:weekly',
      'overview:next:0:tester:weekly',
      'overview:last:0:tester:weekly',
    ]);
  });

  it('keeps the jump button live even on a single page', () => {
    const jump = buttons(card(overview(days(2)), 0)).find(b => b.custom_id?.startsWith('overview:jump:'));
    expect(jump?.disabled).toBeUndefined();
  });

  it('carries the whole overview on the response so any page can be re-rendered', () => {
    // `_overviewData` is the re-render source. Holding the SLICE would make page 2
    // a re-render of page 1.
    const result = overview(days(8));
    const response = OverviewBuilders.buildOverviewResponse('tester', 'Tester', 'weekly', result, 1);
    expect(response._overviewData).toEqual({
      userNameLastFm: 'tester',
      displayName: 'Tester',
      timeDescription: 'weekly',
      overview: result,
    });
  });

  it('sets the container accent only when one was supplied', () => {
    expect(json(OverviewBuilders.buildOverviewResponse('u', 'U', 'weekly', overview(days(1)), 0, 0x998877)).accent_color).toBe(0x998877);
    expect(json(card(overview(days(1)))).accent_color).toBeUndefined();
  });

  it('renders each day as a Discord date token rather than a locale-formatted string', () => {
    expect(texts(card(overview([block({ epochSeconds: 1_789_516_800 })])))[1]).toContain('<t:1789516800:D>');
  });
});

/**
 * Recorded, not fixed: `buildOverviewResponse` computes `totalPages` and then
 * slices on the raw `page`. An out-of-range page therefore renders a footer that
 * says "6/2" and "0 unique tracks - 0 total plays - 0 avg" — a fabricated zero
 * about somebody's listening, produced by a button press rather than by their
 * data. `first`/`prev` stay live, so the user can get back; the lie is in the
 * numbers, not in a dead end.
 */
describe('OverviewBuilders.buildOverviewResponse: a page past the end', () => {
  it('prints a page counter that does not exist', () => {
    expect(footer(card(overview(days(8)), 5))).toContain('-# 6/2 -');
  });

  it('prints a fabricated zero for every measured total', () => {
    expect(footer(card(overview(days(8)), 5))).toContain('0 unique tracks - 0 total plays - 0 avg');
  });

  it('prints a zero page counter for a negative index', () => {
    expect(footer(card(overview(days(8)), -1))).toContain('-# 0/2 -');
  });

  it('leaves the escape-hatch buttons live so the user can recover', () => {
    const row = buttons(card(overview(days(8)), 5));
    expect(row.find(b => b.custom_id?.startsWith('overview:first:'))?.disabled).toBe(false);
    expect(row.find(b => b.custom_id?.startsWith('overview:prev:'))?.disabled).toBe(false);
  });
});
