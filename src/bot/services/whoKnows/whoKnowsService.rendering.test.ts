import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { WhoKnowsService } from './whoKnowsService';
import type { WhoKnowsUser } from '@bot/models/whoKnowsModels';

/**
 * The pure half of `WhoKnowsService` — name rendering, deduplication and page
 * arithmetic.
 *
 * WHAT THE EXISTING TESTS ALREADY COVER, AND WHY THIS IS NOT A DUPLICATE
 * ----------------------------------------------------------------------
 * `whoKnowsService.test.ts` pins four things: a formatted leaderboard with a
 * bolded requester, the requester pinned below rank 14, ban/activity filtering,
 * and `addOrReplaceUserToIndexList`. `whoKnowsPagination.test.ts` pins one
 * `generatePages` case (a crown-holding requester is not duplicated).
 *
 * So the untouched surface is the part where a NAME reaches Discord:
 * `nameWithLink` sanitisation, the deduplication rules in `generatePages`, and
 * the page-count arithmetic. Those matter more than they look: a markdown link
 * built from a user-controlled nickname can break the row, and a duplicated row
 * is a claim that somebody listened twice.
 *
 * THE SANITISATION IS NOT COSMETIC
 * -------------------------------
 * `nameWithLink` strips `[` and `]` and the zero-width characters U+200B-200D
 * and U+FEFF from the display name, then falls back to the Last.fm username when
 * nothing is left. All three exist because of a real Discord/Last.fm interaction:
 * a nickname with a bracket closes the markdown link early and the rest of the
 * name renders as a stray URL, and a zero-width character inside a link label
 * makes the row unclickable for no visible reason.
 */

const listener = (userId: number, playcount: number, over: Partial<WhoKnowsUser> = {}): WhoKnowsUser => ({
  userId,
  playcount,
  lastFmUsername: `lfm_${userId}`,
  discordName: `User ${userId}`,
  ...over,
});

describe('WhoKnowsService.nameWithLink: a nickname must not be able to break the row', () => {
  it('builds a Last.fm link from the username and labels it with the nickname', () => {
    const link = WhoKnowsService.nameWithLink(listener(1, 10, { discordName: 'Alice' }));
    expect(link).toBe('[Alice](https://last.fm/user/lfm_1)');
  });

  it('falls back to the Last.fm username when there is no nickname at all', () => {
    const link = WhoKnowsService.nameWithLink(listener(1, 10, { discordName: undefined }));
    expect(link).toBe('[lfm_1](https://last.fm/user/lfm_1)');
  });

  it('falls back to the Last.fm username when the nickname is only whitespace', () => {
    // `trim() || lastFmUsername`. Without it the label is empty and the whole row
    // renders as a bare link.
    const link = WhoKnowsService.nameWithLink(listener(1, 10, { discordName: '   ' }));
    expect(link).toBe('[lfm_1](https://last.fm/user/lfm_1)');
  });

  it('strips square brackets, which would close the markdown link early', () => {
    const link = WhoKnowsService.nameWithLink(listener(1, 10, { discordName: 'Ali[ce]x' }));
    expect(link).toBe('[Alicex](https://last.fm/user/lfm_1)');
  });

  it('strips a name made only of brackets, rather than leaving an empty label', () => {
    const link = WhoKnowsService.nameWithLink(listener(1, 10, { discordName: '[][]' }));
    expect(link).toBe('[lfm_1](https://last.fm/user/lfm_1)');
  });

  it('strips zero-width characters, which make a link label unclickable', () => {
    // U+200B zero-width space, U+200D zero-width joiner, U+FEFF BOM. All three
    // are invisible in the rendered row and all three break the link.
    const link = WhoKnowsService.nameWithLink(
      listener(1, 10, { discordName: 'Al\u200Bice\u200D\uFEFF' }),
    );
    expect(link).toBe('[Alice](https://last.fm/user/lfm_1)');
  });

  it('keeps ordinary diacritics, Arabic and CJK, because those are names', () => {
    // The scrub is a deny-list, not an allow-list, and it must stay one: an
    // allow-list of "safe" characters would flatten every non-Latin nickname on
    // the card, which is the worst possible outcome for a list of real people.
    expect(WhoKnowsService.nameWithLink(listener(1, 10, { discordName: 'Sigur Rós' }))).toContain(
      '[Sigur Rós]',
    );
    expect(WhoKnowsService.nameWithLink(listener(1, 10, { discordName: 'مس' }))).toContain('[مس]');
    expect(WhoKnowsService.nameWithLink(listener(1, 10, { discordName: '青葉' }))).toContain('[青葉]');
  });

  it('keeps markdown emphasis characters, which are legal and meaningful in a label', () => {
    expect(WhoKnowsService.nameWithLink(listener(1, 10, { discordName: 'a*b_c' }))).toContain('[a*b_c]');
  });

  it('percent-encodes the username in the URL, so a slash cannot forge a path', async () => {
    const link = WhoKnowsService.nameWithLink(
      listener(1, 10, { discordName: 'x', lastFmUsername: 'a/b c' }),
    );
    expect(link).toContain('https://last.fm/user/a%2Fb%20c');
  });

  it('does not strip a paren from the nickname, because a paren is legal in a label', () => {
    expect(WhoKnowsService.nameWithLink(listener(1, 10, { discordName: 'a(b)c' }))).toContain('[a(b)c]');
  });
});

describe('WhoKnowsService.whoKnowsListToString: the embed form', () => {
  it('says plainly that nobody in the server has listened, rather than an empty list', () => {
    // The honest-empty direction. The pagination twin says "No listeners found.";
    // the embed says this. Both true, neither a zero playcount claim.
    expect(WhoKnowsService.whoKnowsListToString([], 1)).toBe('Nobody in this server has listened to this.');
  });

  it('shows at most fourteen rows, because the embed has room for fourteen', () => {
    const users = Array.from({ length: 30 }, (_, i) => listener(i + 1, 1000 - i));
    const text = WhoKnowsService.whoKnowsListToString(users, 999);

    expect(text.split('\n')).toHaveLength(14);
  });

  it('sorts by playcount, so the card is a leaderboard rather than a query result', () => {
    const text = WhoKnowsService.whoKnowsListToString(
      [listener(1, 5), listener(2, 500), listener(3, 50)],
      999,
    );
    const lines = text.split('\n');
    expect(lines[0]).toContain('User 2');
    expect(lines[1]).toContain('User 3');
    expect(lines[2]).toContain('User 1');
  });

  it('renders a single play in the singular, with the count bolded as usual', () => {
    // Both branches bold the number; only the noun changes. "1 plays" is the
    // shape that reads as a bug, and a `playcount === 1 ? 'play' : 'plays'`
    // somewhere else would reintroduce it.
    const one = WhoKnowsService.whoKnowsListToString([listener(1, 1)], 999);
    expect(one).toContain('**1** play');
    expect(one).not.toContain('**1** plays');

    const two = WhoKnowsService.whoKnowsListToString([listener(1, 2)], 999);
    expect(two).toContain('**2** plays');
  });

  it('formats a large playcount with separators', () => {
    expect(WhoKnowsService.whoKnowsListToString([listener(1, 1234567)], 999)).toContain(
      '1,234,567',
    );
  });

  it('never lists the same person twice, even under two different Discord accounts', () => {
    // The same Last.fm username can be linked from two Discord accounts. Two rows
    // would be a claim that they listened twice as often.
    const text = WhoKnowsService.whoKnowsListToString(
      [listener(1, 100, { lastFmUsername: 'alice' }), listener(2, 50, { lastFmUsername: 'ALICE' })],
      999,
    );
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toContain('100');
  });

  it('deduplicates case-insensitively, because Last.fm usernames are', () => {
    const text = WhoKnowsService.whoKnowsListToString(
      [listener(1, 100, { lastFmUsername: 'Alice' }), listener(2, 50, { lastFmUsername: 'alice' })],
      999,
    );
    expect(text.split('\n')).toHaveLength(1);
  });

  it('deduplicates by userId even when the usernames differ', () => {
    // Two rows for the same internal user under two Last.fm names - which is what
    // a rename half way through an index leaves behind. Two rows would claim they
    // listened twice as often.
    const text = WhoKnowsService.whoKnowsListToString(
      [
        { userId: 1, playcount: 100, lastFmUsername: 'alice_old', discordName: 'Alice' },
        { userId: 1, playcount: 50, lastFmUsername: 'alice_new', discordName: 'Alice' },
      ],
      999,
    );
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toContain('**100** plays');
    expect(text).not.toContain('alice_new');
  });

  it('marks the crown holder with a crown instead of a rank number', () => {
    const text = WhoKnowsService.whoKnowsListToString(
      [listener(1, 100, { hasCrown: true })],
      999,
    );
    expect(text).toContain('\u{1F451}');
    expect(text).not.toContain('1.');
  });

  it('pins the requester at the bottom when they are outside the top fourteen', () => {
    const users = Array.from({ length: 20 }, (_, i) => listener(i + 1, 1000 - i * 10));
    const text = WhoKnowsService.whoKnowsListToString(users, 20);

    // Rank 20 is where they actually are, not rank 15 where they were appended.
    expect(text).toContain('20.');
    expect(text.split('\n').length).toBeGreaterThan(14);
  });

  it('does not pin a requester it never found in the list', () => {
    const text = WhoKnowsService.whoKnowsListToString([listener(1, 100)], 999);
    expect(text.split('\n')).toHaveLength(1);
  });

  it('identifies the requester by Discord id when one was supplied', () => {
    // The command layer looks the caller up by Discord id, because the numeric
    // userId is not what the command knows.
    const text = WhoKnowsService.whoKnowsListToString(
      [listener(1, 100, { discordUserId: 'd-1' }), listener(2, 50, { discordUserId: 'd-2' })],
      999,
      undefined,
      'd-2',
    );
    expect(text).toContain('**[User 2]');
  });

  it('pins a close friend who is outside the top fourteen, with their real rank', () => {
    const users = Array.from({ length: 20 }, (_, i) => listener(i + 1, 1000 - i * 10));
    const text = WhoKnowsService.whoKnowsListToString(users, 999, new Set([20]));

    expect(text).toContain('20.');
    expect(text).toContain('User 20');
  });

  it('does not pin a close friend who is already in the visible fourteen', () => {
    const users = Array.from({ length: 20 }, (_, i) => listener(i + 1, 1000 - i * 10));
    const text = WhoKnowsService.whoKnowsListToString(users, 999, new Set([1]));

    expect(text.match(/User 1\b/g)).toHaveLength(1);
  });

  it('does not pin the requester twice when they are also a close friend', () => {
    const users = Array.from({ length: 20 }, (_, i) => listener(i + 1, 1000 - i * 10));
    const text = WhoKnowsService.whoKnowsListToString(users, 20, new Set([20]));

    expect(text.match(/User 20\b/g)).toHaveLength(1);
  });
});

describe('WhoKnowsService.generatePages: the Components V2 pagination form', () => {
  it('returns exactly one empty page for no listeners, not zero pages', () => {
    // The paginator would divide by `pages.length`. Zero pages is a division by
    // zero on the first button press.
    const pages = WhoKnowsService.generatePages([], 1);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.totalPages).toBe(1);
    expect(pages[0]!.lines).toBe('No listeners found.');
  });

  it('claims the same total on every page, so the footer never disagrees with itself', () => {
    const users = Array.from({ length: 25 }, (_, i) => listener(i + 1, 250 - i));
    const pages = WhoKnowsService.generatePages(users, 1);
    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.totalPages)).toEqual([3, 3, 3]);
    expect(pages.map((p) => p.pageIndex)).toEqual([0, 1, 2]);
  });

  it('splits ten to a page, so the boundary is not off by one in either direction', () => {
    const ten = Array.from({ length: 10 }, (_, i) => listener(i + 1, 100));
    expect(WhoKnowsService.generatePages(ten, 999)).toHaveLength(1);

    const eleven = Array.from({ length: 11 }, (_, i) => listener(i + 1, 100));
    const pages = WhoKnowsService.generatePages(eleven, 999);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.lines).not.toContain('lfm_11');
    expect(pages[1]!.lines).toContain('lfm_11');
  });

  it('puts exactly ten rows on a full page', () => {
    const users = Array.from({ length: 25 }, (_, i) => listener(i + 1, 100));
    expect(WhoKnowsService.generatePages(users, 999)[0]!.lines.split('\n')).toHaveLength(10);
  });

  it('numbers rows continuously across pages rather than restarting', () => {
    const users = Array.from({ length: 25 }, (_, i) => listener(i + 1, 100));
    const pages = WhoKnowsService.generatePages(users, 999);
    expect(pages[1]!.lines).toContain('11.');
    expect(pages[2]!.lines).toContain('21.');
  });

  it('honours a caller-supplied page size', () => {
    const users = Array.from({ length: 25 }, (_, i) => listener(i + 1, 100));
    const pages = WhoKnowsService.generatePages(users, 999, undefined, 5);
    expect(pages).toHaveLength(5);
    expect(pages[0]!.lines.split('\n')).toHaveLength(5);
  });

  it('deduplicates before paginating, so a duplicate cannot cost a slot on a page', () => {
    // Six rows, one duplicate. Five must be shown, on one page - not five on one
    // page with a sixth row smuggled in.
    const users = [
      listener(1, 100, { lastFmUsername: 'alice' }),
      listener(2, 90, { lastFmUsername: 'bob' }),
      listener(3, 80, { lastFmUsername: 'carol' }),
      listener(4, 70, { lastFmUsername: 'dave' }),
      listener(5, 60, { lastFmUsername: 'erin' }),
      listener(6, 50, { lastFmUsername: 'ALICE' }),
    ];
    const pages = WhoKnowsService.generatePages(users, 999);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.lines.split('\n')).toHaveLength(5);
  });

  it('pins the requester at the bottom of page one when they are not on it', () => {
    const users = Array.from({ length: 25 }, (_, i) => listener(i + 1, 1000 - i * 10));
    const pages = WhoKnowsService.generatePages(users, 25, undefined, 10);

    // Rank 25 is where they actually are. They are on page three, so the pin is
    // the only way they appear on page one at all.
    expect(pages[0]!.lines).toContain('25.');
    expect(pages[0]!.lines).toContain('User 25');
    expect(pages[1]!.lines).not.toContain('25.');
  });

  it('does not pin a requester who is already on page one', () => {
    const users = Array.from({ length: 25 }, (_, i) => listener(i + 1, 1000 - i * 10));
    const lines = WhoKnowsService.generatePages(users, 1, undefined, 10)[0]!.lines;
    // The row is rendered once, in place, with no appended duplicate.
    expect(lines.match(/User 1\b/g)).toHaveLength(1);
    expect(lines).not.toContain('\n\n');
  });

  it('does not pin a requester it cannot find', () => {
    const users = Array.from({ length: 25 }, (_, i) => listener(i + 1, 1000 - i * 10));
    const pages = WhoKnowsService.generatePages(users, 999, undefined, 10);
    expect(pages[0]!.lines).not.toContain('\n**');
  });

  it('pins the requester once when they hold the crown, rather than twice', () => {
    // The case `whoKnowsPagination.test.ts` pins, restated here because it is a
    // property of the crown branch rather than of that one fixture.
    const users = [
      listener(1, 241, { hasCrown: true, discordUserId: '1001' }),
      listener(2, 2, { discordUserId: '1002' }),
    ];
    const lines = WhoKnowsService.generatePages(users, 1, undefined, 10, '1001')[0]!.lines;
    expect(lines.match(/User 1\b/g)).toHaveLength(1);
  });

  it('lists a close friend on page one only, with their real rank', () => {
    const users = Array.from({ length: 25 }, (_, i) => listener(i + 1, 1000 - i * 10));
    const pages = WhoKnowsService.generatePages(users, 999, new Set([25]), 10);

    expect(pages[0]!.lines).toContain('25.');
    expect(pages[1]!.lines).not.toContain('25.');
  });

  it('does not pin the requester a second time as a close friend', () => {
    const users = Array.from({ length: 25 }, (_, i) => listener(i + 1, 1000 - i * 10));
    const lines = WhoKnowsService.generatePages(users, 25, new Set([25]), 10)[0]!.lines;
    expect(lines.match(/User 25\b/g)).toHaveLength(1);
  });

  it('puts the close-friend block on its own line group, not glued to the list', () => {
    const users = Array.from({ length: 25 }, (_, i) => listener(i + 1, 1000 - i * 10));
    const lines = WhoKnowsService.generatePages(users, 999, new Set([25]), 10)[0]!.lines;
    expect(lines).toContain('\n25.');
    expect(lines).toContain('\n\n');
  });

  it('renders a single play in the singular and pluralises the rest', () => {
    const one = WhoKnowsService.generatePages([listener(1, 1)], 999)[0]!.lines;
    expect(one).toContain('**1** play');
    expect(one).not.toContain('**1** plays');

    const two = WhoKnowsService.generatePages([listener(1, 2)], 999)[0]!.lines;
    expect(two).toContain('**2** plays');
  });

  it('keeps a zero-playcount row, because a supplied zero is a measurement', () => {
    // The opposite of the omission rule, and the one that is easier to lose: a
    // `playcount || default` would drop this row entirely.
    const lines = WhoKnowsService.generatePages([listener(1, 0), listener(2, 5)], 999)[0]!.lines;
    expect(lines).toContain('User 1');
    expect(lines).toContain('**0** plays');
  });

  it('escapes the requester nickname in the pinned row as well', () => {
    const users = Array.from({ length: 15 }, (_, i) => listener(i + 1, 1000 - i * 10));
    const lines = WhoKnowsService.generatePages(
      [...users, listener(99, 1, { discordName: 'Ali[ce]' })],
      99,
      undefined,
      10,
    )[0]!.lines;
    expect(lines).toContain('[Alice]');
    expect(lines).not.toContain('[Ali[ce]');
  });
});