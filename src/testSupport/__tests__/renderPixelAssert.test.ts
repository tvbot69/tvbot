import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { analysePng, assertRenderedInk } from '../renderPixelAssert';

/**
 * The render suite's blindness, isolated from a browser.
 *
 * `*.render.test.ts` can only tell you a PNG has content because
 * `assertRenderedInk` says so. If that helper is wrong, all three render files
 * are wrong the same way and the whole fix is theatre. So the helper gets its
 * own tests, and they run in the UNIT suite — no Chromium, no Puppeteer, fast.
 *
 * Every broken image here is synthesised, so each case names a specific defect
 * and there is no guessing about which one the assertion fires on.
 */

/** Solid colour canvas. Flat by construction. */
async function solid(
  width: number,
  height: number,
  background: { r: number; g: number; b: number; alpha?: number },
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background } })
    .png()
    .toBuffer();
}

/**
 * A canvas that is genuinely busy: a dense pattern of many quantised colours
 * with hard edges everywhere. Not a chart, but it satisfies every band a real
 * render does, which is what the "a real render passes" case needs. The
 * pattern steps by more than one palette entry per pixel, because a
 * modulo-8 palette on a 1-pixel checkerboard collapses to 8 distinct colours
 * after quantisation and would sit exactly on the default floor.
 */
async function busy(width: number, height: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 4);
  // Four hues across sixteen lightness steps. Eight palette entries would only
  // ever give eight quantised colours, which lands exactly on the default floor
  // of 8 and makes `toBeGreaterThan(8)` a coin toss. Real renders measure 144
  // to 469, so the fixture should be nowhere near the boundary either.
  const base = [
    [30, 58, 138],
    [15, 118, 110],
    [190, 24, 93],
    [217, 119, 6],
  ];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const step = (x * 3 + y * 5) % 16;
      const hue = base[(x + y) % base.length] as number[];
      const lift = step * 15;
      const offset = (y * width + x) * 4;
      pixels[offset] = Math.min(255, (hue[0] as number) + lift);
      pixels[offset + 1] = Math.min(255, (hue[1] as number) + lift);
      pixels[offset + 2] = Math.min(255, (hue[2] as number) + lift);
      pixels[offset + 3] = 255;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * A smooth diagonal gradient: broad histogram, plenty of distinct colours, no
 * edges at all. Every measure in this file calls it healthy except sharpness,
 * which is what makes it the fixture for that floor. Measured: distinct=50
 * ink=0.924 entropy=5.561 sharpness=0.055.
 */
async function gradient(width: number, height: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = Math.round((x / width) * 60 + 10);
      pixels[offset + 1] = Math.round((y / height) * 50 + 15);
      pixels[offset + 2] = Math.round(((x + y) / (width + height)) * 80 + 30);
      pixels[offset + 3] = 255;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * A large near-black canvas with four small light cells in the middle — the
 * shape of the real 2x2 album chart at 600x600, where ~95% of the area is the
 * body colour. Measured entropy 0.41 against the other fixtures' 3.3 to 7.6,
 * which is what made the old default floor of 1 wrong.
 */
async function sparseCanvas(width: number, height: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = 10;
    pixels[offset + 1] = 10;
    pixels[offset + 2] = 12;
    pixels[offset + 3] = 255;
  }
  const cell = 90;
  for (let cy = 0; cy < 2; cy += 1) {
    for (let cx = 0; cx < 2; cx += 1) {
      const x0 = Math.round(width / 2 - cell) + cx * cell;
      const y0 = Math.round(height / 2 - cell) + cy * cell;
      for (let y = y0; y < y0 + cell; y += 1) {
        for (let x = x0; x < x0 + cell; x += 1) {
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          // A hard border, a lighter interior, and a couple of label bars, so
          // the cell has real edges and many quantised values rather than one
          // flat square. Four flat squares would only score 3 distinct colours
          // and would trip the distinct-colour floor for the wrong reason.
          const onEdge =
            x < x0 + 3 || x >= x0 + cell - 3 || y < y0 + 3 || y >= y0 + cell - 3;
          const onLabel =
            y > y0 + cell - 26 && y < y0 + cell - 18 &&
            x > x0 + 8 && x < x0 + cell - 20 - ((x + y) % 14);
          const offset = (y * width + x) * 4;
          if (onEdge) {
            pixels[offset] = 210;
            pixels[offset + 1] = 210;
            pixels[offset + 2] = 215;
          } else if (onLabel) {
            pixels[offset] = 236;
            pixels[offset + 1] = 238;
            pixels[offset + 2] = 242;
          } else {
            // Artwork stands in for a cover: a low-contrast ramp, so the cell
            // contributes many quantised colours the way a real image does.
            const ramp = Math.round(((x - x0) / cell) * 40);
            pixels[offset] = 120 + ramp;
            pixels[offset + 1] = 130 + ramp;
            pixels[offset + 2] = 145 + ramp;
          }
        }
      }
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

describe('analysePng', () => {
  it('reports a flat image as flat on every measure', async () => {
    const report = await analysePng(await solid(64, 64, { r: 0, g: 0, b: 0 }));

    expect(report.distinctColours).toBe(1);
    expect(report.inkCoverage).toBe(0);
    expect(report.entropy).toBe(0);
    expect(report.sharpness).toBe(0);
    expect(report.stdev).toBe(0);
    expect(report.opaqueCoverage).toBe(1);
  });

  it('reports a fully transparent image as having no opaque pixels', async () => {
    const report = await analysePng(
      await solid(32, 32, { r: 0, g: 0, b: 0, alpha: 0 }),
    );

    expect(report.opaqueCoverage).toBe(0);
    expect(report.distinctColours).toBe(1);
  });

  it('finds many colours, ink and edges in a busy canvas', async () => {
    const report = await analysePng(await busy(128, 128));

    expect(report.distinctColours).toBeGreaterThan(8);
    expect(report.inkCoverage).toBeGreaterThan(0.02);
    expect(report.entropy).toBeGreaterThan(1);
    expect(report.sharpness).toBeGreaterThan(0.05);
    expect(report.width).toBe(128);
    expect(report.height).toBe(128);
  });
});

describe('assertRenderedInk', () => {
  // The regression this whole helper exists for. Before the pixel assertions,
  // a blank chart passed this suite on size and magic bytes alone.
  it('rejects a solid black canvas that decoded to a large PNG', async () => {
    const png = await solid(498, 544, { r: 0, g: 0, b: 0 });
    expect(png.length).toBeGreaterThan(1000);

    await expect(assertRenderedInk(png, 'blank black')).rejects.toThrow(
      /flat-colour render: 1 distinct quantised colour/,
    );
  });

  it('rejects a fully transparent canvas', async () => {
    const png = await solid(498, 544, { r: 0, g: 0, b: 0, alpha: 0 });

    await expect(assertRenderedInk(png, 'blank transparent')).rejects.toThrow(
      /flat\/transparent render: only 0\.0% of pixels/,
    );
  });

  /**
   * The second blind spot: a canvas that is NOT flat and NOT empty, but has no
   * background left because it was flooded edge to edge. A flat red canvas
   * does not demonstrate this — its modal colour is still itself, so it trips
   * the distinct-colour floor first and proves nothing about the ceiling. The
   * fixture has to be a canvas where the modal colour is a genuine MINORITY,
   * which is what noise is. Measured: ink=0.999, distinct=3893, entropy=7.59,
   * sharpness=25.6 — every floor passes by a mile, and only the ceiling fires.
   */
  it('rejects a canvas flooded edge to edge with no background left', async () => {
    const width = 498;
    const height = 544;
    const pixels = Buffer.alloc(width * height * 4);
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = Math.floor(rnd() * 256);
      pixels[offset + 1] = Math.floor(rnd() * 256);
      pixels[offset + 2] = Math.floor(rnd() * 256);
      pixels[offset + 3] = 255;
    }
    const png = await sharp(pixels, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();

    // The premise, stated so it cannot quietly rot: every FLOOR is satisfied.
    const report = await analysePng(png);
    expect(report.opaqueCoverage).toBe(1);
    expect(report.distinctColours).toBeGreaterThan(8);
    expect(report.inkCoverage).toBeGreaterThan(0.02);
    expect(report.entropy).toBeGreaterThan(1);
    expect(report.sharpness).toBeGreaterThan(0.5);

    await expect(assertRenderedInk(png, 'flooded noise')).rejects.toThrow(
      /canvas flooded: ink coverage 99\.9\d% is above the 98\.00% ceiling/,
    );
  });

  /**
   * A smooth gradient: broad histogram, plenty of distinct colours, zero edges.
   * Every measure except sharpness calls this healthy, so it is the fixture
   * that shows the sharpness floor earning its place. Note what this does NOT
   * prove — a gradient is not the same as text painted in its own background
   * colour, which also measures healthy here. That defect is out of reach of
   * every measure in this file; the header records why.
   */
  it('rejects a gradient with no detail drawn into it', async () => {
    const png = await gradient(498, 544);

    const report = await analysePng(png);
    expect(report.distinctColours).toBeGreaterThan(8);
    expect(report.entropy).toBeGreaterThan(1);
    expect(report.inkCoverage).toBeGreaterThan(0.02);
    expect(report.stdev).toBeGreaterThan(2);
    expect(report.sharpness).toBeLessThan(0.5);

    await expect(assertRenderedInk(png, 'smooth gradient')).rejects.toThrow(
      /no detail drawn: sharpness 0\.055\d* is below the 0\.5 floor/,
    );
  });

  it('accepts a busy canvas at the default bands and returns its report', async () => {
    const report = await assertRenderedInk(await busy(256, 256), 'busy');

    expect(report.distinctColours).toBeGreaterThan(8);
    expect(report.inkCoverage).toBeGreaterThan(0);
    expect(report.opaqueCoverage).toBe(1);
  });

  /**
   * The default entropy floor was removed because it rejected a correct render,
   * so this asserts the removal is real: a canvas with almost no colour spread
   * still passes, and only fails when a caller asks for a floor explicitly.
   * A correct 2x2 album chart measures entropy 0.413, which is what forced it.
   */
  it('does not fail a low-entropy render unless a floor is given', async () => {
    const png = await sparseCanvas(600, 600);
    const report = await analysePng(png);
    // The premise, stated so it cannot rot: this canvas scores below the 1.0
    // floor that used to be the default, and still passes every band that has
    // one. It is the shape of the real 2x2 album chart, which measures 0.413 —
    // same failure, this fixture just has ramped artwork so it also clears the
    // distinct-colour floor.
    expect(report.entropy).toBeLessThan(1);
    expect(report.distinctColours).toBeGreaterThan(8);
    expect(report.sharpness).toBeGreaterThan(0.5);

    await expect(assertRenderedInk(png, 'sparse chart')).resolves.toBeDefined();
    await expect(
      assertRenderedInk(png, 'sparse chart', { minEntropy: 1 }),
    ).rejects.toThrow(/entropy 0\.89\d* is below the 1 floor/);
  });

  it('honours an explicit band over the default', async () => {
    // A caller may legitimately render something flatter than the defaults, but
    // only by asking. This proves the override is applied rather than ignored.
    await expect(
      assertRenderedInk(await busy(64, 64), 'busy', { minDistinctColours: 1000 }),
    ).rejects.toThrow(/floor is 1000/);
  });
});