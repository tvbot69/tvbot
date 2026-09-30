import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhoKnowsGenerator, type WhoKnowsImageParams } from './whoKnowsGenerator';
import type { PuppeteerService } from './puppeteerService';
import type { WhoKnowsUser } from '@bot/models/whoKnowsModels';

/**
 * `WhoKnowsGenerator` — the leaderboard card, and what it does when the data
 * behind it is thin, missing or unrankable.
 *
 * No browser. The generator's entire external contract is
 * `screenshotHtml(html, width, height)`, so a recorder for those three
 * arguments is a complete test of the generator. The `*.render.test.ts` files
 * then check the pixels; these check the DATA, which is the part a pixel
 * assertion cannot tell you is wrong.
 *
 * The theme is the failed read. A who-knows card with three listeners must not
 * look like a card that failed to load, and a card whose caller was not in the
 * top ten must have room for the extra row — otherwise the row is silently cut
 * off the bottom of the PNG. Both directions are asserted: a genuinely empty
 * input still renders, and reads as empty rather than as broken.
 */

interface Captured {
  html: string;
  width: number;
  height: number;
}

const makeGenerator = () => {
  const shots: Captured[] = [];
  const puppeteer = {
    screenshotHtml: vi.fn(async (html: string, width: number, height: number) => {
      shots.push({ html, width, height });
      return Buffer.from('mock-png');
    }),
  } as unknown as PuppeteerService;
  return { generator: new WhoKnowsGenerator(puppeteer), shots };
};

const listener = (over: Partial<WhoKnowsUser> & { userId: number }): WhoKnowsUser =>
  ({
    playcount: 0,
    lastFmUsername: `lfm${String(over.userId)}`,
    ...over,
  }) as WhoKnowsUser;

const base = (over: Partial<WhoKnowsImageParams> = {}): WhoKnowsImageParams => ({
  type: 'Who Knows Artist',
  title: 'Radiohead',
  location: 'The Server',
  users: [listener({ userId: 1, playcount: 100, discordName: 'Alice' })],
  ...over,
});

let harness: ReturnType<typeof makeGenerator>;

const render = async (params: Partial<WhoKnowsImageParams>): Promise<Captured> => {
  await harness.generator.generateWhoKnowsImage(base(params));
  return harness.shots[harness.shots.length - 1]!;
};

beforeEach(() => {
  harness = makeGenerator();
});

describe('WhoKnowsGenerator — the card is 1200px wide and grows for what it contains', () => {
  it('uses the short card for a handful of listeners', async () => {
    const shot = await render({ users: [listener({ userId: 1, playcount: 5 })] });
    expect(shot.width).toBe(1200);
    expect(shot.height).toBe(860);
  });

  it('grows to the tall card at eight listeners, where the extra rows start', async () => {
    const seven = Array.from({ length: 7 }, (_, i) => listener({ userId: i + 1, playcount: 10 }));
    expect((await render({ users: seven })).height).toBe(860);

    const eight = Array.from({ length: 8 }, (_, i) => listener({ userId: i + 1, playcount: 10 }));
    expect((await render({ users: eight })).height).toBe(920);
  });

  it('grows for a stats block or a top-tracks list even with one listener', async () => {
    expect((await render({ stats: [{ value: 1, label: 'x' }] })).height).toBe(920);
    expect((await render({ topTracks: ['Creep'] })).height).toBe(920);
  });

  it('reserves 60px for a crown banner', async () => {
    const shot = await render({ crownText: 'Crown claimed by Alice' });
    expect(shot.height).toBe(920);
    expect(shot.html).toContain('crown-banner');
  });

  it('strips a crown emoji the caller already put in the text, so it is not doubled', async () => {
    const shot = await render({ crownText: '👑  Alice holds it' });
    expect(shot.html).toContain('<span>Alice holds it</span>');
    expect(shot.html).not.toContain('👑  Alice holds it');
  });

  it('reserves 65px for a caller who is not in the top ten', async () => {
    const users = Array.from({ length: 12 }, (_, i) =>
      listener({ userId: i + 1, playcount: 200 - i * 10 }),
    );
    const shot = await render({ users, callerUserId: 12 });
    // 920 (>=8 listeners) + 65 for the caller's own row.
    expect(shot.height).toBe(985);
    expect(shot.html).toContain('caller-outside-container');
  });

  it('reserves nothing extra when the caller IS in the top ten', async () => {
    const users = Array.from({ length: 12 }, (_, i) =>
      listener({ userId: i + 1, playcount: 200 - i * 10 }),
    );
    const shot = await render({ users, callerUserId: 1 });
    expect(shot.height).toBe(920);
    // Matched as markup, not as a bare `caller-outside-container`: the
    // stylesheet defines that class, so the substring is always present.
    expect(shot.html).not.toContain('<div class="caller-outside-container">');
  });

  it('KNOWN GAP — reserves the caller row from the UNSORTED list while rendering the SORTED one', async () => {
    // The height is computed from `params.users.slice(0, 10)` — the order the
    // caller passed — while the rows are built from the same list SORTED by
    // playcount. When those disagree the reservation and the content disagree
    // with it. Here the caller is first as passed (so no band is reserved) but
    // last after sorting, so a caller row is rendered into space that was never
    // reserved: it is cut off the bottom of the PNG. Callers that happen to pass
    // already-sorted rows never see it, which is why it is worth pinning.
    const users = Array.from({ length: 12 }, (_, i) =>
      listener({ userId: i + 1, playcount: i === 0 ? 1 : 500 - i }),
    );
    const shot = await render({ users, callerUserId: 1 });

    expect(shot.html).toContain('caller-outside-container');
    // No +65 was reserved, even though a row was rendered.
    expect(shot.height).toBe(920);
  });
});

describe('WhoKnowsGenerator — an unreadable or absent leaderboard reads as empty, not as broken', () => {
  it('renders an explicit "no listeners" row when there are none', async () => {
    const shot = await render({ users: [] });
    expect(shot.html).toContain('No listeners found');
    // And it is a rendered row, not an empty container: an empty `<ul>` looks
    // like a card that failed to build.
    expect(shot.html).toMatch(/<li class="user-row"><div class="name-col">No listeners found<\/div><\/li>/);
  });

  it('reports zero listeners and zero plays for an empty board, not a blank stats bar', async () => {
    const shot = await render({ users: [] });
    expect(shot.html).toContain('<strong class="stat-highlight">0</strong> listeners');
    expect(shot.html).toContain('<strong class="stat-highlight">0</strong> total plays');
  });

  it('does not divide by zero when nobody has played anything', async () => {
    // The average is omitted rather than printed as NaN. Asserted on the stat
    // markup, because the count and its label are separated by `</strong>`.
    const shot = await render({ users: [listener({ userId: 1, playcount: 0 })] });
    expect(shot.html).toContain('<strong class="stat-highlight">0</strong> listeners');
    expect(shot.html).not.toContain('NaN');
  });

  it('does not count a zero-play listener in the listener total', async () => {
    // A user can appear on the board with a playcount of 0 after a
    // re-index; counting them would make "1 listener · 0 plays" out of one row.
    const shot = await render({
      users: [listener({ userId: 1, playcount: 0 }), listener({ userId: 2, playcount: 40 })],
    });
    expect(shot.html).toContain('<strong class="stat-highlight">1</strong> listener<');
    expect(shot.html).toContain('<strong class="stat-highlight">40</strong> total plays');
  });

  it('de-duplicates a user that appears twice, keeping the first row', async () => {
    // A guild/DB join can repeat a user; counting them twice inflates the
    // listener total and the total plays on a card that is a statistic.
    const shot = await render({
      users: [
        listener({ userId: 7, playcount: 10, discordName: 'First' }),
        listener({ userId: 7, playcount: 999, discordName: 'Second' }),
      ],
    });
    expect(shot.html).toContain('First');
    expect(shot.html).not.toContain('Second');
    expect(shot.html).toContain('<strong class="stat-highlight">1</strong> listener<');
  });

  it('falls back through the name chain and never renders an empty name', async () => {
    const shot = await render({
      users: [
        listener({ userId: 1, playcount: 5, discordName: 'Discord', lastFmUsername: 'LastFm' }),
        listener({ userId: 2, playcount: 4, lastFmUsername: 'LastFmOnly' }),
        listener({ userId: 3, playcount: 3, discordName: '', lastFmUsername: '', userName: 'DbName' }),
        listener({ userId: 4, playcount: 2, discordName: '', lastFmUsername: '', userName: '' }),
      ],
    });
    expect(shot.html).toContain('Discord');
    expect(shot.html).toContain('LastFmOnly');
    expect(shot.html).toContain('DbName');
    expect(shot.html).toContain('>Unknown<');
  });

  it('reads the legacy `plays` field when `playcount` is absent', async () => {
    // Two field names for the same number in the same interface; a card that
    // printed 0 next to a real listener total would be a wrong number, not an
    // absent one.
    const shot = await render({
      users: [{ userId: 1, playcount: undefined, plays: 77, lastFmUsername: 'legacy' } as unknown as WhoKnowsUser],
    });
    expect(shot.html).toContain('77');
    expect(shot.html).toContain('<strong class="stat-highlight">77</strong> total plays');
  });
});

describe('WhoKnowsGenerator — the stats bar says what it counted', () => {
  it('uses the singular for exactly one listener and omits the average', async () => {
    // "1 listeners · 42 total plays · 42 avg" is three wrong words in one line.
    const shot = await render({ users: [listener({ userId: 1, playcount: 42 })] });
    expect(shot.html).toContain('<strong class="stat-highlight">1</strong> listener<');
    expect(shot.html).toContain('<strong class="stat-highlight">42</strong> total plays');
    expect(shot.html).not.toContain('avg</span>');
  });

  it('uses the singular play only when the total really is one', async () => {
    const shot = await render({ users: [listener({ userId: 1, playcount: 1 })] });
    expect(shot.html).toContain('<strong class="stat-highlight">1</strong> play<');
  });

  it('adds the average only once there is more than one listener', async () => {
    const shot = await render({
      users: [listener({ userId: 1, playcount: 100 }), listener({ userId: 2, playcount: 50 })],
    });
    expect(shot.html).toContain('<strong class="stat-highlight">2</strong> listeners');
    // round((100+50)/2) = 75
    expect(shot.html).toContain('<strong class="stat-highlight">75</strong> avg');
  });

  it('lets the caller rename the listener label', async () => {
    const shot = await render({
      users: [listener({ userId: 1, playcount: 3 })],
      footerItemLabel: 'scrobbler',
    });
    expect(shot.html).toContain('</strong> scrobbler<');
  });
});

describe('WhoKnowsGenerator — ranking is content, so it is asserted as content', () => {
  it('sorts by playcount and numbers the rows from one', async () => {
    const shot = await render({
      users: [
        listener({ userId: 1, playcount: 10, discordName: 'Low' }),
        listener({ userId: 2, playcount: 99, discordName: 'High' }),
        listener({ userId: 3, playcount: 50, discordName: 'Mid' }),
      ],
    });
    const order = [...shot.html.matchAll(/class="name-col">([A-Za-z]+)</g)].map((m) => m[1]);
    expect(order).toEqual(['High', 'Mid', 'Low']);
    expect(shot.html).toContain('<span class="rank-gold">1.</span>');
  });

  it('gives the crown holder the crown instead of a rank number', async () => {
    const shot = await render({
      users: [listener({ userId: 1, playcount: 10, discordName: 'A', hasCrown: true })],
    });
    expect(shot.html).toContain('<span class="rank-crown">👑</span>');
    // Matched as markup: the stylesheet defines `.rank-gold`, so the bare
    // substring is always present and could never fail.
    expect(shot.html).not.toContain('<span class="rank-gold">');
  });

  it('medals only the top three and plain-numbers the rest', async () => {
    const shot = await render({
      users: Array.from({ length: 5 }, (_, i) =>
        listener({ userId: i + 1, playcount: 100 - i, discordName: `U${String(i)}` }),
      ),
    });
    expect(shot.html).toContain('<span class="rank-gold">1.</span>');
    expect(shot.html).toContain('<span class="rank-silver">2.</span>');
    expect(shot.html).toContain('<span class="rank-bronze">3.</span>');
    expect(shot.html).toContain('<span>4.</span>');
    expect(shot.html).toContain('<span>5.</span>');
  });

  it('renders at most ten rows however many listeners exist', async () => {
    const shot = await render({
      users: Array.from({ length: 25 }, (_, i) => listener({ userId: i + 1, playcount: 100 - i })),
    });
    expect(shot.html.match(/class="user-row/g) ?? []).toHaveLength(10);
  });

  it('highlights the caller by Last.fm id OR by Discord id', async () => {
    const byLfm = await render({
      users: [listener({ userId: 1, playcount: 10 }), listener({ userId: 2, playcount: 5 })],
      callerUserId: 2,
    });
    expect(byLfm.html).toContain('caller-highlight');

    const byDiscord = await render({
      users: [
        listener({ userId: 1, playcount: 10, discordUserId: 'discord-2' }),
        listener({ userId: 2, playcount: 5 }),
      ],
      callerDiscordId: 'discord-2',
    });
    expect(byDiscord.html).toContain('caller-highlight');
  });
});

describe('WhoKnowsGenerator — the artwork area degrades visibly', () => {
  it('hides the artwork slot and falls back to the Last.fm placeholder when there is no image', async () => {
    // The hidden class plus the placeholder is what stops an empty grey box being
    // read as "this artist has no cover".
    const shot = await render({ imageUrl: undefined });
    expect(shot.html).toContain('class="artwork-card hidden"');
    expect(shot.html).toContain('2a96cbd8b46e442fc41c2b86b821562f');
  });

  it('shows the artwork slot when an image did resolve', async () => {
    const shot = await render({ imageUrl: 'https://cdn.example/hero.png' });
    expect(shot.html).toContain('class="artwork-card "');
    expect(shot.html).toContain('src="https://cdn.example/hero.png"');
  });

  it('escapes a hostile artwork URL instead of letting it close the src attribute', async () => {
    const shot = await render({ imageUrl: 'https://cdn.example/a.png" onerror="alert(1)' });
    expect(shot.html).toContain('&quot; onerror=&quot;alert(1)');
    expect(shot.html).not.toContain('" onerror="alert(1)"');
  });

  it('gives every mosaic tile an onerror handler, so a dead cover is hidden not left broken', async () => {
    const shot = await render({ backgroundCovers: ['https://cdn.example/a.png'] });
    const tiles = shot.html.match(/<div class="mosaic-tile"><img/g) ?? [];
    expect(tiles).toHaveLength(10);
    expect(
      shot.html.match(/onerror="this\.style\.display='none';"/g) ?? [],
    ).toHaveLength(10);
  });

  it('shows at most four genre pills, and none at all when there are no tags', async () => {
    const many = await render({ tags: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(many.html.match(/class="genre-tag"/g) ?? []).toHaveLength(4);
    // Matched against the generated chip, not a bare `>e<`: a one-letter tag
    // could otherwise collide with unrelated markup.
    expect(many.html).not.toMatch(/<span class="genre-tag"><span class="genre-tag-dot">.*?<\/span>e<\/span>/);

    const none = await render({});
    expect(none.html).not.toContain('class="genre-tag"');
  });
});

describe('WhoKnowsGenerator — the info card only appears when it has something to say', () => {
  it('renders nothing extra when there are no stats, tags or top items', async () => {
    const shot = await render({});
    expect(shot.html).not.toContain('class="info-card"');
    expect(shot.html).not.toContain('class="artwork-meta"');
  });

  it('prefers caller-supplied stats over the global pair, so a card cannot show two sets', async () => {
    const shot = await render({
      stats: [{ value: 12, label: 'in library' }],
      globalPlays: 9_000,
      globalListeners: 4_000,
    });
    expect(shot.html).toContain('>12<');
    expect(shot.html).toContain('in library');
    expect(shot.html).not.toContain('scrobbles');
  });

  it('omits the half of the global pair it was not given, rather than printing zero', async () => {
    const shot = await render({ globalPlays: 2_540_000 });
    expect(shot.html).toContain('2.5M');
    expect(shot.html).toContain('scrobbles');
    // No invented zero for the listeners figure. Matched on the chip markup:
    // the stats bar legitimately ends in </strong> listeners</span> too.
    expect(shot.html).not.toContain('<span class="info-stat-lbl">listeners</span>');
  });

  it('separates both halves of the global pair with a divider', async () => {
    const shot = await render({ globalPlays: 2_540_000, globalListeners: 320_000 });
    expect(shot.html).toContain('2.5M');
    expect(shot.html).toContain('320K');
    // Counted, not matched: the stylesheet defines .info-stat-divider, so a
    // bare 	oContain would pass on a card with no divider at all.
    expect(shot.html.match(/<div class="info-stat-divider"><\/div>/g) ?? []).toHaveLength(1);
  });

  it('compacts large numbers and leaves small ones alone', async () => {
    const shot = await render({ stats: [
      { value: 1_500_000, label: 'a' },
      { value: 2_000, label: 'b' },
      { value: 42, label: 'c' },
    ] });
    expect(shot.html).toContain('1.5M');
    expect(shot.html).toContain('2K');
    expect(shot.html).toContain('>42<');
  });

  it('shows at most three top tracks, under a caller-supplied header', async () => {
    const shot = await render({ topTracks: ['a', 'b', 'c', 'd'], topListHeader: 'Most scrobbed' });
    expect(shot.html.match(/class="info-top-item"/g) ?? []).toHaveLength(3);
    expect(shot.html).toContain('Most scrobbed');
    expect(shot.html).not.toMatch(/class="info-top-name">d<\/span>/);
  });

  it('defaults the top-tracks header rather than leaving it blank', async () => {
    const shot = await render({ topTracks: ['a'] });
    expect(shot.html).toContain('Top Tracks');
  });

  it('shows a top item only when BOTH the label and the value are present', async () => {
    // Half a top item is a card with a badge and no number, which reads as a
    // rendering fault rather than as missing data.
    const labelOnly = await render({ topItemLabel: 'Top Track' });
    expect(labelOnly.html).not.toContain('<span class="info-top-badge">');

    const valueOnly = await render({ topItemValue: 'Creep' });
    expect(valueOnly.html).not.toContain('<span class="info-top-badge">');

    const both = await render({ topItemLabel: 'Top Track', topItemValue: 'Creep' });
    expect(both.html).toContain('info-top-badge');
    expect(both.html).toContain('Creep');
  });
});

describe('WhoKnowsGenerator — nothing caller-supplied is interpolated raw', () => {
  it('leaves no template token in the output', async () => {
    // A token that survived is either invalid markup or, for `image-url`, a live
    // request for the literal string `{{image-url}}`.
    const shot = await render({ title: 'T', location: 'L', crownText: 'C', tags: ['x'] });
    expect(shot.html).not.toMatch(/\{\{/);
  });

  it('escapes a title, a location and a username that all try to break out', async () => {
    const shot = await render({
      title: '"><script>alert(1)</script>',
      location: "'\"><b>",
      users: [listener({ userId: 1, playcount: 5, discordName: '<img src=x>' })],
    });
    expect(shot.html).not.toContain('<script>alert(1)</script>');
    expect(shot.html).toContain('&lt;script&gt;');
    expect(shot.html).toContain('&lt;img src=x&gt;');
  });

  it('is not fooled by a replacement pattern in the data', async () => {
    // Every token replacement uses a replacer FUNCTION precisely so a `$&` or
    // `$1` in a name cannot be re-expanded as a capture-group reference, which
    // would corrupt the row and could splice a fragment of the template in.
    const shot = await render({
      title: '$& $1 $` $\'',
      users: [listener({ userId: 1, playcount: 5, discordName: '$&' })],
    });
    // escapeHtml turns the ampersand and the quote; the `$` and the backtick
    // survive verbatim, which is the proof that no second expansion ran.
    expect(shot.html).toContain('$&amp; $1 $` $&#039;');
    expect(shot.html).toMatch(/<div class="name-col">\$&amp;<\/div>/);
    expect(shot.html).not.toMatch(/\{\{/);
  });
});
