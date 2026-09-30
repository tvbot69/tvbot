import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IcebergGenerator } from './icebergGenerator';
import type { PuppeteerService } from './puppeteerService';
import type { IcebergData } from '@bot/services/musicIntelligenceService';

/**
 * `IcebergGenerator` — the depth chart, and what it does when a tier comes back
 * thin, empty or longer than the layout was designed for.
 *
 * No browser: the generator's whole external contract is one
 * `screenshotHtml(html, 920, 1320)` call, so recording those three arguments is
 * a complete test of it. The `*.render.test.ts` files then check the pixels.
 *
 * The theme is truncation. A tier can hold more artists than the 16 chips the
 * row has room for, and a tier can hold none at all. Both have to be VISIBLE:
 * the overflow as a "+N more" chip, and the empty tier as an explicit message.
 * Silently dropping artists would produce a chart that looks complete and is
 * not, and an empty `<div>` would look like a rendering fault rather than a tier
 * with nothing in it.
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
      return Buffer.from('mock-iceberg-png');
    }),
  } as unknown as PuppeteerService;
  return { generator: new IcebergGenerator(puppeteer), shots };
};

const tier = (tierNumber: number, count: number, name = `Tier ${String(tierNumber)}`) => ({
  tierNumber,
  name,
  emoji: '',
  description: '',
  artists: Array.from({ length: count }, (_, i) => ({
    name: `${name} artist ${String(i)}`,
    playcount: 100 - i,
  })),
});

const iceberg = (over: Partial<IcebergData> = {}): IcebergData => ({
  displayName: over.displayName ?? 'Listener',
  userNameLastFm: over.userNameLastFm ?? 'listener',
  timePeriodDescription: over.timePeriodDescription ?? 'Overall',
  totalArtists: over.totalArtists ?? 40,
  tiers: over.tiers ?? [tier(1, 2, 'Tip of the Iceberg')],
});

let harness: ReturnType<typeof makeGenerator>;

const render = async (over: Partial<IcebergData> = {}): Promise<Captured> => {
  const buffer = await harness.generator.generateIceberg(iceberg(over));
  expect(buffer.toString()).toBe('mock-iceberg-png');
  return harness.shots[harness.shots.length - 1]!;
};

beforeEach(() => {
  harness = makeGenerator();
});

describe('IcebergGenerator — the canvas', () => {
  it('always asks for the same 920x1320 card, whatever the tier count', async () => {
    const one = await render({ tiers: [tier(1, 2)] });
    const seven = await render({ tiers: Array.from({ length: 7 }, (_, i) => tier(i + 1, 2)) });

    expect(one.width).toBe(920);
    expect(one.height).toBe(1320);
    expect(seven.width).toBe(920);
    expect(seven.height).toBe(1320);
  });

  it('is a complete document, not a fragment pasted into a shell', async () => {
    const shot = await render({});
    expect(shot.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(shot.html).toContain('</html>');
  });
});

describe('IcebergGenerator — the header names the run it is about', () => {
  it('uppercases the display name and counts the artists it was given', async () => {
    const shot = await render({ displayName: 'Moha', totalArtists: 128, timePeriodDescription: 'Last 12 months' });
    expect(shot.html).toContain("MOHA'S MUSIC ICEBERG");
    expect(shot.html).toContain('Last 12 months • 128 top artists analyzed');
  });

  it('escapes the display name, which is a Discord nickname', async () => {
    // Note the ORDER: `escapeHtml(data.displayName.toUpperCase())` uppercases
    // first and escapes second, so the CONTENT is uppercased and the ENTITY
    // names are not: `&lt;IMG SRC=X ONERROR=1&gt;`. (The tier tag below is the
    // other order round — escape, then uppercase the escaped string, entity
    // names and all, so it comes out `&LT;B&GT;`. The two differ, and both are
    // asserted as they actually render.)
    const shot = await render({ displayName: '<img src=x onerror=1>' });
    expect(shot.html).not.toContain('<img src=x onerror=1>');
    expect(shot.html).toContain('&lt;IMG SRC=X ONERROR=1&gt;');
  });

  it('escapes the Last.fm username in the footer link', async () => {
    const shot = await render({ userNameLastFm: 'a"b' });
    expect(shot.html).toContain('last.fm/user/a&quot;b');
  });
});

describe('IcebergGenerator — a tier that overflows discloses the overflow', () => {
  it('prints at most sixteen chips and a count of the rest', async () => {
    const shot = await render({ tiers: [tier(1, 20, 'Tip')] });

    expect(shot.html.match(/class="artist-chip chip-tip"/g) ?? []).toHaveLength(16);
    // Matched as markup, not as a bare `more-chip`: the stylesheet defines
    // `.more-chip`, so a substring check would fail on a chart that correctly
    // showed no overflow at all.
    expect(shot.html).toMatch(/class="artist-chip more-chip">\+4 more<\/span>/);
    expect(shot.html).not.toContain('Tip artist 16');
  });

  it('omits the overflow chip when a tier fits exactly', async () => {
    const shot = await render({ tiers: [tier(1, 16, 'Tip')] });
    expect(shot.html.match(/class="artist-chip chip-tip"/g) ?? []).toHaveLength(16);
    expect(shot.html).not.toMatch(/class="artist-chip more-chip">/);
  });

  it('caps each tier independently, so a full row does not starve the next one', async () => {
    const shot = await render({ tiers: [tier(1, 40, 'Tip'), tier(2, 3, 'Surface')] });

    expect(shot.html).toMatch(/class="artist-chip more-chip">\+24 more<\/span>/);
    expect(shot.html.match(/class="artist-chip chip-surface"/g) ?? []).toHaveLength(3);
    // The overflow count belongs to the tier that overflowed, not the chart.
    expect(shot.html).not.toContain('+37 more');
  });

  it('escapes artist names, which come from the scrobble log', async () => {
    const shot = await render({
      tiers: [
        {
          tierNumber: 1,
          name: 'Tip',
          emoji: '',
          description: '',
          artists: [{ name: 'AC&DC <live>', playcount: 1 }],
        },
      ],
    });
    expect(shot.html).toContain('AC&amp;DC &lt;live&gt;');
  });
});

describe('IcebergGenerator — an empty tier says so instead of leaving a hole', () => {
  it('renders an explicit message for a tier with no artists', async () => {
    // A genre nobody listens to in a given month produces a tier with nothing in
    // it. An empty chips div reads as a broken render; the message reads as data.
    const shot = await render({ tiers: [tier(1, 0, 'Tip'), tier(2, 2, 'Surface')] });

    expect(shot.html).toContain('class="empty-chip">No artists in this tier<');
    expect(shot.html).toContain('class="artist-chip chip-surface"');
  });

  it('does not claim an overflow for an empty tier', async () => {
    const shot = await render({ tiers: [tier(1, 0)] });
    expect(shot.html).not.toMatch(/class="artist-chip more-chip">/);
  });

  it('renders a chart with no tiers at all rather than throwing', async () => {
    const shot = await render({ tiers: [] });
    // Matched as markup: the stylesheet defines `.tier-row`, so a substring check
    // would fail on a chart that correctly has no rows.
    expect(shot.html).not.toMatch(/<div class="tier-row"/);
    expect(shot.html).toContain('tiers-container');
  });
});

describe('IcebergGenerator — the depth ladder', () => {
  it('gives each tier its own depth label, chip style and width', async () => {
    const shot = await render({ tiers: Array.from({ length: 7 }, (_, i) => tier(i + 1, 1, `T${String(i + 1)}`)) });

    expect(shot.html.match(/class="tier-row"/g) ?? []).toHaveLength(7);
    for (const depth of ['SURFACE LEVEL', '-100m', '-500m', '-1,500m', '-3,500m', '-6,500m', '-11,000m']) {
      expect(shot.html, depth).toContain(`<span class="tier-depth">${depth}</span>`);
    }
    for (const width of ['440px', '560px', '680px', '780px', '720px', '620px', '500px']) {
      expect(shot.html, width).toContain(`style="width: ${width};"`);
    }
  });

  it('reuses the deepest tier styling past seven tiers, instead of emitting undefined', async () => {
    // The metadata table has seven rows. An eighth tier must borrow the last one
    // rather than read past the end, which would put the literal text
    // "undefined" into a `style="width: undefinedpx;"` — silently collapsed to
    // no width at all, and no error to explain it.
    const shot = await render({ tiers: Array.from({ length: 9 }, (_, i) => tier(i + 1, 1, `T${String(i + 1)}`)) });

    expect(shot.html.match(/<div class="tier-row"/g) ?? []).toHaveLength(9);
    expect(shot.html.match(/style="width: 500px;"/g) ?? []).toHaveLength(3);
    expect(shot.html).not.toContain('undefinedpx');
    expect(shot.html).not.toMatch(/class="[^"]*undefined/);
    expect(shot.html.match(/class="artist-chip chip-trench"/g) ?? []).toHaveLength(3);
  });

  it('numbers the tiers from the data, uppercased, rather than from the row index', async () => {
    const shot = await render({ tiers: [tier(4, 1, 'The Deep')] });
    expect(shot.html).toContain('<span class="tier-tag">L4 • THE DEEP</span>');
  });

  it('escapes a tier name, which is a genre label from a provider', async () => {
    // Same quirk on the tier tag, other way round: `escapeHtml(name).toUpperCase()`
    // escapes first and uppercases second, and `toUpperCase` is applied to the
    // WHOLE already-escaped string, so the entity NAMES are mangled too:
    // `&lt;` -> `&LT;` and `&gt;` -> `&GT;`. Still valid (HTML entity names are
    // case-insensitive) and still escaped, but not what the code reads like.
    const shot = await render({ tiers: [tier(1, 1, '<b>Dark</b> & Deep')] });
    expect(shot.html).toContain('&LT;B&GT;DARK&LT;/B&GT; &AMP; DEEP');
    expect(shot.html).not.toContain('<b>Dark</b>');
  });
});
