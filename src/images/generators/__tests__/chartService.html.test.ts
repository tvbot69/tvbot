import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChartService } from '../chartService';
import type { PuppeteerService } from '../puppeteerService';
import { ChartTheme, ChartType, type ChartItem, type ChartSettings } from '@images/models/chartModels';
import { TimePeriod } from '@domain/enums/timePeriod';

/**
 * `ChartService` — the HTML it hands the browser, and the pixel box it asks for.
 *
 * No browser is launched. The generator's whole contract with the outside world
 * is one call, `screenshotHtml(html, width, height)`, so a fake that records
 * those three arguments is a complete test of the generator. What the real
 * render tests then check is pixels; what these check is that the right DATA
 * went in, which is the part a pixel assertion cannot localise.
 *
 * The point of this module is the FALLBACK. A chart cell whose artwork could not
 * be resolved is the single most common outcome in production (a Last.fm
 * placeholder, a dead Deezer link, a cascade that ran out of sources) and it has
 * to be visibly different from a cell that has art. Every test below asserts
 * which of the two was produced, in both directions: a missing image yields a
 * labelled fallback block, and a genuine art cell still yields an `<img>`.
 */

interface Captured {
  html: string;
  width: number;
  height: number;
}

const makeGenerator = () => {
  const plain: Captured[] = [];
  const rainbow: Captured[] = [];
  const puppeteer = {
    screenshotHtml: vi.fn(async (html: string, width: number, height: number) => {
      plain.push({ html, width, height });
      return Buffer.from('mock-png');
    }),
    screenshotHtmlWithRainbowSort: vi.fn(async (html: string, width: number, height: number) => {
      rainbow.push({ html, width, height });
      return Buffer.from('mock-rainbow-png');
    }),
  } as unknown as PuppeteerService;
  return { service: new ChartService(puppeteer), plain, rainbow };
};

const settings = (over: Partial<ChartSettings> = {}): ChartSettings => ({
  rows: 3,
  columns: 3,
  type: ChartType.Album,
  theme: ChartTheme.Dark,
  showTitle: true,
  padding: 6,
  imageSizePx: 150,
  timePeriod: TimePeriod.Weekly,
  ...over,
});

const item = (over: Partial<ChartItem> = {}): ChartItem => ({ name: 'Untitled', ...over });

let harness: ReturnType<typeof makeGenerator>;

beforeEach(() => {
  harness = makeGenerator();
});

describe('ChartService — the pixel box handed to the browser', () => {
  it('asks for exactly rows*columns cells of size, plus padding, plus a title band', async () => {
    const { service, plain } = harness;
    await service.generateChart([item()], settings({ rows: 3, columns: 3, padding: 6, imageSizePx: 150 }));

    const shot = plain[0]!;
    // width  = columns * (size + 2*padding) + 2*padding = 3*162 + 12 = 498
    // height = rows    * (size + 2*padding) + 2*padding + 46 = 486 + 12 + 46
    expect(shot.width).toBe(498);
    expect(shot.height).toBe(544);
  });

  it('drops the 46px title band when the title is hidden, so the PNG has no dead strip', async () => {
    const { service, plain } = harness;
    await service.generateChart([item()], settings({ showTitle: false }));

    expect(plain[0]!.height).toBe(498);
    expect(plain[0]!.html).not.toContain('<div class="title">');
  });

  it('MINOR GAP — keeps the 46px band even when showTitle is on and the title is empty', async () => {
    // The band is reserved from `showTitle` alone, while the `<div class="title">`
    // needs `showTitle && title`. A caller that sets the flag without the string
    // therefore gets 46px of nothing at the top of the image — no error, no log,
    // just a card that looks like it lost its heading. Pinned as observed so the
    // fix is visible; the two conditions are simply not derived from one value.
    const { service, plain } = harness;
    await service.generateChart([item()], settings({ showTitle: true, title: '' }));

    expect(plain[0]!.height).toBe(544);
    expect(plain[0]!.html).not.toContain('<div class="title">');
  });

  it('escapes the title rather than injecting it, because it is caller-supplied text', async () => {
    const { service, plain } = harness;
    await service.generateChart([item()], settings({ title: '<img src=x onerror=1>' }));

    expect(plain[0]!.html).toContain('&lt;img src=x onerror=1&gt;');
    expect(plain[0]!.html).not.toContain('<img src=x onerror=1>');
  });

  it('never renders more cells than the grid can hold', async () => {
    // 2x2 grid, 10 items. Two of them are a real album and a real cover; the
    // other eight must not reach the DOM, or the PNG is taller than the box
    // asked for and the bottom row is cut off with no error anywhere.
    const { service, plain } = harness;
    const items = Array.from({ length: 10 }, (_, i) => item({ name: `Item ${String(i)}` }));

    await service.generateChart(items, settings({ rows: 2, columns: 2, showTitle: false }));

    expect(plain[0]!.html.match(/class="cell"/g) ?? []).toHaveLength(4);
    expect(plain[0]!.html).not.toContain('Item 4');
  });

  it('emits fewer cells than the grid when the caller has fewer items', async () => {
    const { service, plain } = harness;
    await service.generateChart([item()], settings({ rows: 3, columns: 3, showTitle: false }));

    // One item, one cell: the rest of the grid is CSS, not markup. A generator
    // that padded the grid out itself would have to invent placeholder rows.
    expect(plain[0]!.html.match(/class="cell"/g) ?? []).toHaveLength(1);
  });

  it('substitutes every template token, so no raw placeholder reaches the page', async () => {
    const { service, plain } = harness;
    await service.generateChart([item({ name: 'A' })], settings({ title: 'T' }));

    // A leftover `{{size}}` is silently invalid CSS: the rule is dropped and the
    // chart renders at the browser default, which looks like "the grid is wrong"
    // rather than "the template drifted".
    expect(plain[0]!.html).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
  });

  it('inlines the real font faces, because the fallback is invisible in a PNG', async () => {
    const { service, plain } = harness;
    await service.generateChart([item()], settings());

    // 20 inline woff2 faces in `pages/fonts.css`. If the read failed the module
    // logs one WARN and every card in the process renders in a system face from
    // then on — decoration, but permanent and undetectable from the image.
    expect(plain[0]!.html).toContain('@font-face');
    expect(plain[0]!.html).toContain('data:font/woff2');
  });
});

describe('ChartService — an unresolved cover becomes a labelled cell, not a broken image', () => {
  it('renders an <img> when the cover resolved, sized to the cell', async () => {
    const { service, plain } = harness;
    await service.generateChart(
      [item({ name: 'OK Computer', artistName: 'Radiohead', imageUrl: 'https://cdn.example/ok.png' })],
      settings({ rows: 1, columns: 1, imageSizePx: 120, showTitle: false }),
    );

    const html = plain[0]!.html;
    expect(html).toContain('src="https://cdn.example/ok.png"');
    expect(html).toContain('width="120" height="120"');
    expect(html).toContain('crossorigin="anonymous"');
    expect(html).not.toContain('class="fallback"');
  });

  it('renders a text fallback when the cover did NOT resolve, and no <img> at all', async () => {
    // The direction that matters. An `<img src="">` or `<img src="undefined">`
    // renders as a browser-broken-image glyph inside an otherwise perfect
    // grid, and nothing in the image says "the lookup failed".
    const { service, plain } = harness;
    await service.generateChart(
      [item({ name: 'Untitled Rip', artistName: 'Boards of Canada' })],
      settings({ rows: 1, columns: 1, showTitle: false }),
    );

    const html = plain[0]!.html;
    expect(html).toContain('class="fallback"');
    expect(html).toContain('fallback-artist">Boards of Canada<');
    expect(html).toContain('fallback-album">Untitled Rip<');
    expect(html).not.toContain('<img ');
  });

  it('a failed read in one cell does not affect its neighbours', async () => {
    const { service, plain } = harness;
    await service.generateChart(
      [
        item({ name: 'Has Art', imageUrl: 'https://cdn.example/a.png' }),
        item({ name: 'No Art' }),
        item({ name: 'Also Has Art', imageUrl: 'https://cdn.example/b.png' }),
      ],
      settings({ rows: 1, columns: 3, showTitle: false }),
    );

    const html = plain[0]!.html;
    expect(html.match(/<img /g) ?? []).toHaveLength(2);
    expect(html.match(/class="fallback"/g) ?? []).toHaveLength(1);
    expect(html).toContain('fallback-artist">No Art<');
  });

  it('escapes artist and album text inside the fallback, which comes from Last.fm', async () => {
    const { service, plain } = harness;
    await service.generateChart(
      [item({ name: '<b>bold</b>', artistName: 'AC&DC' })],
      settings({ rows: 1, columns: 1, showTitle: false }),
    );

    const html = plain[0]!.html;
    expect(html).toContain('fallback-artist">AC&amp;DC<');
    expect(html).toContain('fallback-album">&lt;b&gt;bold&lt;/b&gt;<');
  });
});

describe('ChartService — the per-cell label', () => {
  it('shows the artist over the album when the item has an artist', async () => {
    const { service, plain } = harness;
    await service.generateChart(
      [item({ name: 'Kid A', artistName: 'Radiohead', showTitle: true, imageUrl: 'https://cdn.example/a.png' })],
      settings({ rows: 1, columns: 1, showTitle: false }),
    );

    const html = plain[0]!.html;
    expect(html).toContain('<span class="top-text">Radiohead</span>');
    expect(html).toContain('<span class="bottom-text">Kid A</span>');
  });

  it('shows only the name when the item has no artist', async () => {
    const { service, plain } = harness;
    await service.generateChart(
      [item({ name: 'Sonnet 2', showTitle: true, imageUrl: 'https://cdn.example/a.png' })],
      settings({ rows: 1, columns: 1, showTitle: false }),
    );

    const html = plain[0]!.html;
    expect(html).toContain('<span class="top-text">Sonnet 2</span>');
    // Matched as markup, not as a substring: the stylesheet legitimately
    // contains `.bottom-text`, so a bare `not.toContain` would fail for the
    // wrong reason and would also pass on a card that rendered no label at all.
    expect(html).not.toMatch(/<span class="bottom-text">/);
  });

  it('treats a whitespace-only artist as absent rather than rendering a blank line', async () => {
    // A Last.fm artist field that is whitespace is not an artist; rendering it
    // produces a label with an empty top line and the title pushed down.
    const { service, plain } = harness;
    await service.generateChart(
      [item({ name: 'Sonnet 2', artistName: '   ', showTitle: true, imageUrl: 'https://cdn.example/a.png' })],
      settings({ rows: 1, columns: 1, showTitle: false }),
    );

    const html = plain[0]!.html;
    expect(html).toContain('<span class="top-text">Sonnet 2</span>');
    expect(html).not.toMatch(/<span class="bottom-text">/);
  });

  it('omits the label entirely when the item does not ask for one', async () => {
    const { service, plain } = harness;
    await service.generateChart(
      [item({ name: 'Kid A', artistName: 'Radiohead', imageUrl: 'https://cdn.example/a.png' })],
      settings({ rows: 1, columns: 1, showTitle: false }),
    );

    expect(plain[0]!.html).not.toContain('<div class="label theme-dark">');
  });

  it('escapes label text, which is arbitrary catalogue metadata', async () => {
    const { service, plain } = harness;
    await service.generateChart(
      [item({ name: 'A & B', artistName: '"Quoted"', showTitle: true, imageUrl: 'https://cdn.example/a.png' })],
      settings({ rows: 1, columns: 1, showTitle: false }),
    );

    const html = plain[0]!.html;
    expect(html).toContain('<span class="top-text">&quot;Quoted&quot;</span>');
    expect(html).toContain('<span class="bottom-text">A &amp; B</span>');
  });

  it('escapes a hostile image URL so it cannot break out of the src attribute', async () => {
    const { service, plain } = harness;
    await service.generateChart(
      [item({ name: 'X', imageUrl: 'https://cdn.example/a.png" onerror="alert(1)' })],
      settings({ rows: 1, columns: 1, showTitle: false }),
    );

    const html = plain[0]!.html;
    // The assertion is about the quote that would CLOSE the attribute. A regex
    // for the literal substring ` onerror=` would match even in the escaped
    // form, because the text survives — only the boundary is removed.
    expect(html).toContain('src="https://cdn.example/a.png&quot; onerror=&quot;alert(1)"');
    expect(html).not.toContain('" onerror="alert(1)"');
  });
});

describe('ChartService — the CSS numbers the layout depends on', () => {
  it('halves the padding into a gap, with a 2px floor and a 0 for no padding', async () => {
    const { service, plain } = harness;

    await service.generateChart([item()], settings({ rows: 1, columns: 1, padding: 10, showTitle: false }));
    expect(plain[0]!.html).toContain('gap: 5px;');

    await service.generateChart([item()], settings({ rows: 1, columns: 1, padding: 1, showTitle: false }));
    expect(plain[1]!.html).toContain('gap: 2px;');

    await service.generateChart([item()], settings({ rows: 1, columns: 1, padding: 0, showTitle: false }));
    expect(plain[2]!.html).toContain('gap: 0px;');
  });

  it('switches the label scale at 240px, so a big chart does not get 8px text', async () => {
    const { service, plain } = harness;

    await service.generateChart([item()], settings({ rows: 1, columns: 1, imageSizePx: 150, showTitle: false }));
    // Small cells: 0.058 * 150 = 8.7 -> 9, raised to the 11px floor.
    expect(plain[0]!.html).toMatch(/\.cell \.label \.top-text \{\s*font-size: 11px;/);

    await service.generateChart([item()], settings({ rows: 1, columns: 1, imageSizePx: 300, showTitle: false }));
    // Large cells: 0.052 * 300 = 15.6 -> 16, above the 14px floor.
    expect(plain[1]!.html).toMatch(/\.cell \.label \.top-text \{\s*font-size: 16px;/);
  });

  it('scales the fallback text with the cell, and never below 11px', async () => {
    const { service, plain } = harness;

    await service.generateChart([item()], settings({ rows: 1, columns: 1, imageSizePx: 60, showTitle: false }));
    // 60/10 = 6, raised to the 11px floor.
    expect(plain[0]!.html).toMatch(/\.cell \.fallback \{[\s\S]*?font-size: 11px;/);

    await service.generateChart([item()], settings({ rows: 1, columns: 1, imageSizePx: 300, showTitle: false }));
    expect(plain[1]!.html).toMatch(/\.cell \.fallback \{[\s\S]*?font-size: 30px;/);
  });

  it('puts a requested font family in front of the built-in stack', async () => {
    const { service, plain } = harness;
    await service.generateChart([item()], settings({ fontFamily: 'MyFont' }));

    expect(plain[0]!.html).toContain("font-family: 'MyFont', 'Readex Pro'");
  });

  it('strips quotes and backslashes out of the requested family so it cannot break the CSS', async () => {
    const { service, plain } = harness;
    await service.generateChart([item()], settings({ fontFamily: "Evil'; } body { display:none" }));

    expect(plain[0]!.html).toContain("font-family: 'Evil; } body { display:none', 'Readex Pro'");
  });

  it('uses the built-in stack when no family is requested', async () => {
    const { service, plain } = harness;
    await service.generateChart([item()], settings());

    expect(plain[0]!.html).toContain("font-family: 'Readex Pro', 'Cairo'");
  });
});

describe('ChartService — rainbow sort takes a different render path', () => {
  it('routes to the rainbow renderer and leaves the plain one untouched', async () => {
    const { service, plain, rainbow } = harness;
    const buffer = await service.generateChart([item()], settings({ rainbowSort: true }));

    expect(rainbow).toHaveLength(1);
    expect(plain).toHaveLength(0);
    expect(buffer.toString()).toBe('mock-rainbow-png');
  });

  it('gives the rainbow renderer the same pixel box as the plain one', async () => {
    // The rainbow path re-sorts the DOM in place, so a different viewport would
    // re-lay the grid out of the picture the user asked for.
    const { service, plain, rainbow } = harness;
    const chartSettings = settings({ rainbowSort: true });
    await service.generateChart([item()], chartSettings);
    await service.generateChart([item()], { ...chartSettings, rainbowSort: false });

    expect(rainbow[0]!.width).toBe(plain[0]!.width);
    expect(rainbow[0]!.height).toBe(plain[0]!.height);
  });

  it('builds the same HTML for both paths, so a sort cannot change the content', async () => {
    const { service, plain, rainbow } = harness;
    const items = [item({ name: 'A' }), item({ name: 'B' })];
    await service.generateChart(items, settings({ rainbowSort: true }));
    await service.generateChart(items, settings({ rainbowSort: false }));

    expect(rainbow[0]!.html).toBe(plain[0]!.html);
  });
});
