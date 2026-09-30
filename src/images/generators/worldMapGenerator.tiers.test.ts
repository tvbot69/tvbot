import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  WorldMapGenerator,
  CountryChartTheme,
  WORLD_MAP_THEMES,
} from './worldMapGenerator';
import type { PuppeteerService } from './puppeteerService';
import type { TopCountryItem } from '@bot/services/countryService';

/**
 * `WorldMapGenerator` — the country choropleth, its buckets, and its legend.
 *
 * No browser: the generator's whole external contract is one
 * `screenshotHtml(html, 2754, 1398)` call, so recording those arguments is a
 * complete test of it.
 *
 * The theme is the DENOMINATOR. A choropleth is a picture of numbers, and every
 * number in it — the bucket boundaries, the "N countries" footer, the per-bucket
 * min/max — has to be a number the generator actually had. Two cases are pinned
 * here: an empty country list renders an empty legend rather than inventing
 * buckets, and the footer counts the countries it was GIVEN, which is only the
 * true total when the caller did not truncate upstream. Nothing in this module
 * knows the world total, so it must never imply one.
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
      return Buffer.from('mock-map-png');
    }),
  } as unknown as PuppeteerService;
  return { generator: new WorldMapGenerator(puppeteer), shots };
};

const country = (code: string, artistCount: number, artists?: number): TopCountryItem => ({
  countryName: `Country ${code}`,
  countryCode: code,
  playcount: artistCount * 10,
  artistCount,
  ...(artists === undefined
    ? {}
    : { artists: Array.from({ length: artists }, (_, i) => ({ name: `A${String(i)}`, playcount: 1 })) }),
});

/** The colour of each legend swatch, in order. `rx="8"` is unique to a swatch. */
const swatchFills = (html: string): string[] =>
  [...html.matchAll(/rx="8" ry="8" fill="([^"]+)"/g)].map((m) => m[1] as string);

const cssFill = (html: string, code: string): string | null =>
  new RegExp(`\\.${code.toLowerCase()}\\{fill:([^}]+)\\}`).exec(html)?.[1] ?? null;

/** One step of a theme's colour ramp. */
const ramp = (theme: CountryChartTheme, step: number): string =>
  WORLD_MAP_THEMES[theme]!.countryRamp[step]!;

let harness: ReturnType<typeof makeGenerator>;

const render = async (
  countries: TopCountryItem[],
  theme: CountryChartTheme = CountryChartTheme.Dark,
): Promise<Captured> => {
  const buffer = await harness.generator.generateWorldMap(countries, theme);
  expect(buffer.toString()).toBe('mock-map-png');
  return harness.shots[harness.shots.length - 1]!;
};

beforeEach(() => {
  harness = makeGenerator();
});

describe('WorldMapGenerator — the canvas', () => {
  it('always asks for the same 2754x1398 map', async () => {
    const shot = await render([country('US', 50)]);
    expect(shot.width).toBe(2754);
    expect(shot.height).toBe(1398);
  });

  it('injects the legend inside the single SVG rather than after it', async () => {
    const shot = await render([country('US', 50)]);
    // One `<svg>` and one `</svg>` in the page, so the legend lands inside it
    // and is actually painted. A second `<svg>` appended after the close tag
    // would be markup no one sized, and the map would ship with no legend at
    // all — with no error anywhere.
    expect(shot.html).toContain('id="map-legend"');
    expect(shot.html.indexOf('id="map-legend"')).toBeLessThan(shot.html.indexOf('</svg>'));
  });

  it('leaves no template token in the output', async () => {
    const shot = await render([country('US', 50)]);
    // An unsubstituted `{{customcss}}` is invalid CSS, so the buckets silently
    // fall back to the land fill and every country renders identically.
    expect(shot.html).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
  });
});

describe('WorldMapGenerator — the buckets', () => {
  it('places each country in the first ceiling that holds it', async () => {
    // Six ceilings: 5, 30, 80, 200, 500, 10000. The busiest band is tier 0.
    const shot = await render([
      country('AA', 3),
      country('BB', 20),
      country('CC', 60),
      country('DD', 150),
      country('EE', 400),
      country('FF', 900),
    ]);

    expect(swatchFills(shot.html)).toEqual([
      ramp(CountryChartTheme.Dark, 0),
      ramp(CountryChartTheme.Dark, 1),
      ramp(CountryChartTheme.Dark, 2),
      ramp(CountryChartTheme.Dark, 3),
      ramp(CountryChartTheme.Dark, 4),
      ramp(CountryChartTheme.Dark, 5),
    ]);
  });

  it('puts a band boundary in the lower bucket, not the upper one', async () => {
    // `find(c => c >= count)` is inclusive, so 5 belongs to the 5-band and 6
    // opens the 30-band. The clearest way to see it is that adding a 6-artist
    // country pushes the 5-artist ones DOWN a band: tier 0 is always the
    // busiest band present, so a new busier band re-ranks everything below it.
    const lowOnly = await render([country('AA', 3), country('BB', 5)]);
    expect(cssFill(lowOnly.html, 'BB')).toBe(ramp(CountryChartTheme.Dark, 0));

    const withSix = await render([country('AA', 3), country('BB', 5), country('CC', 6)]);
    expect(cssFill(withSix.html, 'BB')).toBe(ramp(CountryChartTheme.Dark, 1));
    expect(cssFill(withSix.html, 'CC')).toBe(ramp(CountryChartTheme.Dark, 0));
  });

  it('groups countries in the same band into one tier, not one tier each', async () => {
    const shot = await render([country('AA', 3), country('BB', 4), country('CC', 5)]);

    expect(swatchFills(shot.html)).toHaveLength(1);
    expect(cssFill(shot.html, 'AA')).toBe(cssFill(shot.html, 'CC'));
    // The legend states the range, which is how a reader can tell the band is a
    // band rather than a single value.
    expect(shot.html).toContain('3 - 5');
  });

  it('states a single number in the legend when a band holds exactly one value', async () => {
    const shot = await render([country('AA', 7)]);
    expect(shot.html).toContain('>7</text>');
    expect(shot.html).not.toContain('7 - 7');
  });

  it('counts artists from the expanded list when the caller sent one', async () => {
    // Two fields for the same number, and they disagree more often than anyone
    // would like. The list wins when it is present, because it is the one that
    // can be counted. Here the `artistCount` says 3 and the list says 40, which
    // puts the country two bands higher — visibly, not silently.
    const shot = await render([
      country('AA', 3, 40),
      country('BB', 900),
    ]);

    expect(swatchFills(shot.html)).toHaveLength(2);
    // The 40-artist country is in the 80-band (tier 1), the 900 one in the top.
    expect(cssFill(shot.html, 'AA')).toBe(ramp(CountryChartTheme.Dark, 1));
    expect(shot.html).toContain('>40</text>');
  });

  it('treats a country with neither field as a single artist rather than as no data', async () => {
    const shot = await render([
      { countryName: 'Nowhere', countryCode: 'NW', playcount: 0 } as TopCountryItem,
    ]);
    expect(swatchFills(shot.html)).toHaveLength(1);
    expect(shot.html).toContain('>1</text>');
  });

  it('overflows past the top ceiling into the last band, and the legend says so', async () => {
    // A country with more artists than the last ceiling knows about is not
    // refused and not clamped to a fake number — it is counted honestly and the
    // legend prints the real maximum. The cost is precision: 100,000 and 900
    // share a band, so the map overstates how much the two differ.
    const shot = await render([country('AA', 900), country('BB', 100_000)]);

    expect(swatchFills(shot.html)).toHaveLength(1);
    expect(shot.html).toContain('900 - 100000');
  });

  it('lowercases the country code, because the CSS selector and the SVG class must agree', async () => {
    const shot = await render([country('GB', 50)]);
    expect(shot.html).toContain('.gb{fill:');
    expect(shot.html).not.toContain('.GB{fill:');
  });
});

describe('WorldMapGenerator — the legend denominator', () => {
  it('counts every country it painted, and not one more', async () => {
    const shot = await render([country('AA', 3), country('BB', 20), country('CC', 400)]);
    expect(shot.html).toContain('3 countries');
  });

  it('prints the number it was GIVEN, so an upstream truncation under-reports rather than inventing a total', async () => {
    // This module has no way to know how many countries a Last.fm user has, only
    // how many it was handed. The footer is therefore a count of rows, and
    // `totalKnown` does not exist here — which is the correct shape: a truncated
    // list shows a smaller number, it never shows a confident global one.
    const shot = await render([country('AA', 3), country('BB', 20)]);
    expect(shot.html).toContain('2 countries');
  });

  it('renders no swatches and no bucket CSS for an empty country list', async () => {
    // The "no data" case must not look like "one bucket that happens to be
    // empty": there is no fill rule, so every landmass stays on the base fill.
    const shot = await render([]);

    expect(swatchFills(shot.html)).toHaveLength(0);
    expect(shot.html).not.toMatch(/\.[a-z]{2}\{fill:/);
    expect(shot.html).toContain('0 countries');
    expect(shot.html).toContain('id="map-legend"');
  });

  it('always credits the generator in the legend footer', async () => {
    const shot = await render([country('AA', 3)]);
    expect(shot.html).toContain('Generated by tvbot');
  });
});

describe('WorldMapGenerator — themes', () => {
  it('substitutes the palette tokens for the requested theme', async () => {
    const shot = await render([country('US', 50)], CountryChartTheme.Sunset);
    const sunset = WORLD_MAP_THEMES[CountryChartTheme.Sunset]!;

    expect(shot.html).toContain(`background-color: ${sunset.svgBackground};`);
    expect(shot.html).toContain(`fill: ${sunset.landFill};`);
    expect(shot.html).toContain(`stroke: ${sunset.landStroke};`);
    expect(shot.html).toContain(`stroke-width: ${sunset.landStrokeWidth};`);
    // And those are the Sunset values, not the Dark default the map falls back to.
    expect(sunset.svgBackground).toBe('#1a0a1e');
    expect(shot.html).not.toContain(WORLD_MAP_THEMES[CountryChartTheme.Dark]!.svgBackground);
  });

  it('paints the buckets from that theme ramp, not the default one', async () => {
    const shot = await render([country('US', 50)], CountryChartTheme.Forest);
    expect(cssFill(shot.html, 'US')).toBe(ramp(CountryChartTheme.Forest, 0));
  });

  it('falls back to the dark palette for a theme it does not have', async () => {
    // A theme value that reaches this layer from a database column or an old
    // command argument must degrade, not paint the map with `undefined`.
    const shot = await render([country('US', 50)], 99 as CountryChartTheme);

    expect(shot.html).toContain('background-color: #000007;');
    expect(cssFill(shot.html, 'US')).toBe(ramp(CountryChartTheme.Dark, 0));
    expect(shot.html).not.toContain('fill:undefined');
    expect(shot.html).not.toContain('background-color: undefined');
    expect(shot.html).not.toContain('stroke-width: undefined');
  });

  it('gives every theme a full six-step ramp, so no bucket can be unpainted', async () => {
    for (const [name, palette] of Object.entries(WORLD_MAP_THEMES)) {
      expect(palette.countryRamp.length, name).toBeGreaterThanOrEqual(6);
      for (const colour of palette.countryRamp) {
        expect(colour, name).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});
