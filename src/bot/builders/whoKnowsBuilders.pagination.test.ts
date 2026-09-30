/**
 * `WhoKnowsBuilders.buildWhoKnowsResponse` — the `.whoknows` leaderboard, in
 * Components V2 pagination mode.
 *
 * Two claims carry the card and both are worth pinning:
 *
 *  1. The stats line. `avg` is only rendered when there is more than one LISTENER,
 *     and the listener count excludes anyone whose playcount is zero. Both of
 *     those are honesty decisions: an average over one person is noise, and a
 *     listener with zero plays is not a listener of this thing.
 *  2. The filter line. `FilterStats` carries four counters and exactly two of
 *     them are allowed on the card — the blocked and the inactive counts. The
 *     privacy count is deliberately never rendered, because rendering it would
 *     leak the existence of people who opted out. That omission is a feature and
 *     gets its own test.
 *
 * Pagination bounds too: an empty leaderboard is ONE page of one, not zero
 * pages, and every direction button is disabled.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ComponentType } from 'discord.js';
import { WhoKnowsBuilders } from './whoKnowsBuilders';
import { ContextModel } from '@bot/models/contextModel';
import { WhoKnowsMode } from '@domain/enums/whoKnowsMode';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { WhoKnowsUser, FilterStats } from '@bot/models/whoKnowsModels';
import type { ResponseModel } from '@bot/models/responseModel';

interface Cv2Component {
  type: number;
  content?: string;
  components?: Cv2Component[];
  custom_id?: string;
  disabled?: boolean;
}

type Session = {
  currentPage: number;
  totalPages: number;
  authorDiscordId: string;
  expiresAt: number;
  renderPage: (i: number) => { toJSON: () => { components: Cv2Component[] } };
};

const context = new ContextModel();
context.discordUserId = 'discord-1';

const json = (response: ResponseModel) =>
  response.componentsV2Container!.toJSON() as unknown as { components: Cv2Component[] };

const texts = (response: ResponseModel): string[] =>
  json(response).components.filter(c => c.type === ComponentType.TextDisplay).map(c => c.content ?? '');

/** The container footer is the last text block, and it is the claim under test. */
const footer = (response: ResponseModel): string => texts(response).slice(-1)[0] ?? '';

/** The default-mode embed footer, for the lines the two modes do not share. */
const embedFooter = (response: ResponseModel): string => response.embed.data.footer?.text ?? '';

const buttons = (response: ResponseModel): Cv2Component[] =>
  json(response).components.filter(c => c.type === ComponentType.ActionRow).flatMap(c => c.components ?? []);

const sessionOf = (response: ResponseModel): Session => response._paginatorSession as unknown as Session;

const listener = (userId: number, playcount: number, over: Partial<WhoKnowsUser> = {}): WhoKnowsUser => ({
  userId,
  playcount,
  lastFmUsername: `listener-${userId}`,
  discordUserId: `discord-${userId}`,
  ...over,
});

interface CardOpts {
  title?: string;
  url?: string;
  filterStats?: FilterStats;
  guildAlsoPlaying?: string | null;
  genres?: string[];
  footerExtra?: string;
  mediaType?: 'Artist' | 'Track' | 'Album';
}

const build = (users: WhoKnowsUser[], mode: WhoKnowsMode, over: CardOpts = {}) =>
  WhoKnowsBuilders.buildWhoKnowsResponse(
    context,
    over.title ?? 'Radiohead',
    over.url ?? 'https://last.fm/music/Radiohead',
    null,
    users,
    over.filterStats,
    over.guildAlsoPlaying,
    over.genres,
    undefined,
    mode,
    over.footerExtra,
    over.mediaType,
  );

const card = (users: WhoKnowsUser[], over: CardOpts = {}) => build(users, WhoKnowsMode.Pagination, over);

describe('WhoKnowsBuilders pagination mode: the stats line', () => {
  it('renders one page of one for an empty leaderboard rather than zero pages', async () => {
    const response = await card([]);
    expect(footer(response)).toContain('-# Page 1/1');
    expect(footer(response)).toContain('-# Artist - 0 listeners - 0 plays');
    expect(sessionOf(response).totalPages).toBe(1);
  });

  it('says plainly that there is nobody to list, and does so differently per mode', async () => {
    // Two builders, two sentences, both true. The pagination mode's own wording
    // is "No listeners found."; the embed's is "Nobody in this server has
    // listened to this." Neither is a zero playcount claim about anybody.
    const paginated = await card([]);
    const embedded = await build([], WhoKnowsMode.Default);
    expect(texts(paginated)).toContain('No listeners found.');
    expect(embedded.embed.data.description).toBe('Nobody in this server has listened to this.');
  });

  it('omits the average for a single listener, because a mean of one is not information', async () => {
    const response = await card([listener(1, 263)]);
    expect(footer(response)).toContain('-# Artist - 1 listener - 263 plays');
    expect(footer(response)).not.toContain('avg');
  });

  it('renders the average for two or more listeners, rounded down', async () => {
    const response = await card([listener(1, 263), listener(2, 10)]);
    expect(footer(response)).toContain('-# Artist - 2 listeners - 273 plays - 136 avg');
  });

  it('does not count a listener with zero plays', async () => {
    // Someone with 0 plays of this artist is not a listener of this artist, and
    // counting them would also drag the average down with a zero they contribute.
    const response = await card([listener(1, 263), listener(2, 0)]);
    expect(footer(response)).toContain('-# Artist - 1 listener - 263 plays');
    expect(footer(response)).not.toContain('avg');
  });

  it('counts a user once even when they appear twice', async () => {
    const response = await card([listener(1, 100), listener(1, 100), listener(2, 50)]);
    expect(footer(response)).toContain('-# Artist - 2 listeners - 150 plays');
  });

  it('pluralises listeners and plays from the counted totals', async () => {
    const response = await card([listener(1, 1), listener(2, 1)]);
    expect(footer(response)).toContain('-# Artist - 2 listeners - 2 plays');
  });

  it('formats large totals with separators', async () => {
    const response = await card([listener(1, 1_234_567)]);
    expect(footer(response)).toContain('-# Artist - 1 listener - 1,234,567 plays');
  });

  it('labels the media type it was told, not one it guessed', async () => {
    expect(footer(await card([listener(1, 5)], { mediaType: 'Track' }))).toContain('-# Track - 1 listener - 5 plays');
    expect(footer(await card([listener(1, 5)], { mediaType: 'Album' }))).toContain('-# Album - 1 listener - 5 plays');
  });

  it('infers Track from a Last.fm track url', async () => {
    const response = await card([listener(1, 5)], { url: 'https://last.fm/music/Radiohead/_/Creep' });
    expect(footer(response)).toContain('-# Track -');
  });

  it('infers Album from a Last.fm url with an album segment, and Artist without one', async () => {
    const album = await card([listener(1, 5)], { url: 'https://last.fm/music/Radiohead/OK+Computer' });
    const artist = await card([listener(1, 5)], { url: 'https://last.fm/music/Radiohead' });
    expect(footer(album)).toContain('-# Album -');
    expect(footer(artist)).toContain('-# Artist -');
  });

  it('falls back to the title to guess, and only calls it a Track when the title says " by "', async () => {
    const byTitle = await card([listener(1, 5)], { url: 'https://example.com/x', title: 'Creep by Radiohead' });
    const plain = await card([listener(1, 5)], { url: 'https://example.com/x', title: 'Radiohead' });
    expect(footer(byTitle)).toContain('-# Track -');
    expect(footer(plain)).toContain('-# Artist -');
  });

  it('ignores a trailing slash and a query string when deciding Artist from Album', async () => {
    const withSlash = await card([listener(1, 5)], { url: 'https://last.fm/music/Radiohead/' });
    const withQuery = await card([listener(1, 5)], { url: 'https://last.fm/music/Radiohead?x=1' });
    expect(footer(withSlash)).toContain('-# Artist -');
    expect(footer(withQuery)).toContain('-# Artist -');
  });
});

describe('WhoKnowsBuilders: the context lines', () => {
  const filtered = { startCount: 10, endCount: 5, blockedFiltered: 3, activityThresholdFiltered: 2 };

  it('reports the blocked and the inactive counts together in pagination mode', async () => {
    expect(footer(await card([listener(1, 5)], { filterStats: filtered }))).toContain('-# Filtered: 3 blocked, 2 inactive');
  });

  it('reports the same two counts in default mode', async () => {
    const response = await build([listener(1, 5), listener(2, 3)], WhoKnowsMode.Default, { filterStats: filtered });
    expect(embedFooter(response)).toContain('Filtered: 3 blocked, 2 inactive');
  });

  it('omits the filtered line when both counters are zero', async () => {
    const response = await card([listener(1, 5)], {
      filterStats: { startCount: 10, endCount: 5, blockedFiltered: 0, activityThresholdFiltered: 0 },
    });
    expect(footer(response)).not.toContain('Filtered');
  });

  it('reports one counter alone when only one is non-zero', async () => {
    const blockedOnly = await card([listener(1, 5)], {
      filterStats: { startCount: 10, endCount: 5, blockedFiltered: 7 },
    });
    const inactiveOnly = await card([listener(1, 5)], {
      filterStats: { startCount: 10, endCount: 5, activityThresholdFiltered: 9 },
    });
    expect(footer(blockedOnly)).toContain('-# Filtered: 7 blocked');
    expect(footer(blockedOnly)).not.toContain('inactive');
    expect(footer(inactiveOnly)).toContain('-# Filtered: 9 inactive');
  });

  it('never renders the privacy-filter count, because that would leak who opted out', async () => {
    const paginated = await card([listener(1, 5)], {
      filterStats: { startCount: 10, endCount: 5, privacyFiltered: 4 },
    });
    const embedded = await build([listener(1, 5)], WhoKnowsMode.Default, {
      filterStats: { startCount: 10, endCount: 5, privacyFiltered: 4 },
    });
    expect(footer(paginated)).not.toContain('privacy');
    expect(footer(paginated)).toContain('-# Artist - 1 listener - 5 plays');
    expect(embedFooter(embedded)).not.toContain('privacy');
    expect(embedFooter(embedded)).not.toContain('4');
  });

  it('carries the "also playing here" line through in both modes', async () => {
    const paginated = await card([listener(1, 5)], { guildAlsoPlaying: '3 people are playing this right now' });
    const embedded = await build([listener(1, 5)], WhoKnowsMode.Default, {
      guildAlsoPlaying: '3 people are playing this right now',
    });
    expect(footer(paginated)).toContain('-# 3 people are playing this right now');
    expect(embedFooter(embedded)).toContain('3 people are playing this right now');
  });

  it('lists at most five genres in default mode', async () => {
    const response = await build([listener(1, 5)], WhoKnowsMode.Default, {
      genres: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    });
    expect(embedFooter(response)).toContain('a - b - c - d - e');
    expect(embedFooter(response)).not.toContain('f');
  });

  it('always keeps the Spotify sync hint, which is advice and not a measurement', async () => {
    expect(footer(await card([listener(1, 5)]))).toContain("-# Spotify not tracking properly? Check '.outofsync'");
  });

  /**
   * Recorded, not fixed: the genre list is assembled into `footerLines`, which
   * only the DEFAULT mode's embed footer reads. The pagination footer is built
   * from `extraFooterLines` (filters + "also playing") and so silently drops the
   * genres a caller passed in. Same data, two modes, one of them lies by
   * omission.
   */
  it('drops the genre list in pagination mode even though default mode prints it', async () => {
    const paginated = await card([listener(1, 5)], { genres: ['art rock', 'trip hop'] });
    const embedded = await build([listener(1, 5)], WhoKnowsMode.Default, { genres: ['art rock', 'trip hop'] });
    expect(footer(paginated)).not.toContain('art rock');
    expect(embedFooter(embedded)).toContain('art rock - trip hop');
  });
});

describe('WhoKnowsBuilders pagination mode: the paginator', () => {
  const many = (count: number) => Array.from({ length: count }, (_, i) => listener(i + 1, (i + 1) * 10));

  const renderedText = (page: { toJSON: () => { components: Cv2Component[] } }): string =>
    page
      .toJSON()
      .components.filter(c => c.type === ComponentType.TextDisplay)
      .map(c => c.content ?? '')
      .join('\n');

  it('splits at ten listeners a page and claims the right number of pages', async () => {
    expect(footer(await card(many(10)))).toContain('-# Page 1/1');
    expect(footer(await card(many(11)))).toContain('-# Page 1/2');
  });

  it('disables all five buttons on a single-page leaderboard, the jump included', async () => {
    // There is nowhere to jump to, so the jump goes with the four directions.
    // A live jump button on a one-page card is a control that can only do harm.
    const row = buttons(await card(many(4)));
    expect(row.filter(b => b.disabled).map(b => b.custom_id)).toEqual([
      'component_paginator_first',
      'component_paginator_previous',
      'component_paginator_next',
      'component_paginator_last',
      'component_paginator_jump',
    ]);
  });

  it('leaves forward navigation live on page 0 of a multi-page leaderboard', async () => {
    const row = buttons(await card(many(25)));
    const byId = new Map(row.map(b => [b.custom_id, b.disabled]));
    expect(byId.get('component_paginator_first')).toBe(true);
    expect(byId.get('component_paginator_previous')).toBe(true);
    expect(byId.get('component_paginator_next')).toBe(false);
    expect(byId.get('component_paginator_last')).toBe(false);
  });

  it('carries a session the paginator service can render later pages from', async () => {
    const session = sessionOf(await card(many(25)));
    expect(session.currentPage).toBe(0);
    expect(session.totalPages).toBe(3);
    expect(session.authorDiscordId).toBe('discord-1');
    expect(session.expiresAt).toBeGreaterThan(Date.now());
  });

  it('renders the last page with the real page number and the real names on it', async () => {
    const session = sessionOf(await card(many(25)));
    const rendered = renderedText(session.renderPage(2));
    expect(rendered).toContain('Page 3/3');
    expect(rendered).toContain('listener-25');
  });

  it('disables forward navigation on the last page it rendered', async () => {
    const session = sessionOf(await card(many(25)));
    const lastRow = session
      .renderPage(2)
      .toJSON()
      .components.filter(c => c.type === ComponentType.ActionRow)
      .flatMap(c => c.components ?? []);
    const byId = new Map(lastRow.map(b => [b.custom_id, b.disabled]));
    expect(byId.get('component_paginator_next')).toBe(true);
    expect(byId.get('component_paginator_previous')).toBe(false);
  });

  it('puts the caller-supplied extra note on page 1 only', async () => {
    const session = sessionOf(await card(many(25), { footerExtra: 'Crown claimed by someone!' }));
    expect(renderedText(session.renderPage(0))).toContain('Crown claimed by someone!');
    expect(renderedText(session.renderPage(1))).not.toContain('Crown claimed by someone!');
  });

  it('reports success, so the dispatcher does not treat a leaderboard as a failure', async () => {
    expect((await card(many(3))).commandResponse).toBe(CommandResponse.Ok);
  });
});
