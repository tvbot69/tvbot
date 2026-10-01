import sharp from 'sharp';
import type { Stats } from 'sharp';

/**
 * Pixel-content assertions for the browser-render suite.
 *
 * WHY THIS EXISTS
 * ---------------
 * The three `*.render.test.ts` files used to assert only `buffer.length > 1000`
 * and the PNG magic bytes. That proves Chromium launched and encoded something.
 * It does not prove anything was DRAWN, and the gap is not theoretical: making
 * `ChartService.buildCell` return an empty string produces a 100% black PNG of
 * several kilobytes, and all nine tests stayed green. A suite that cannot fail
 * is worse than no suite, because it reports the feature as verified.
 *
 * So these assertions read the decoded pixels. Two defects they catch, and each
 * is mutation-proven against the real generator:
 *
 *   1. FLAT / NOTHING DRAWN. A blank render is a single colour (the template
 *      body is #000000, so a blank chart is solid black, not transparent).
 *      `distinctColours` counts quantised colours, so any flat image scores 1
 *      and fails the floor; `inkCoverage` scores 0 and fails the 2% floor.
 *      `entropy` from sharp is the same fact measured differently and is kept
 *      as an independent witness: a decode bug that flattened the histogram
 *      would have to fool both. PROVEN: making `ChartService.buildCell` return
 *      an empty string drops inkCoverage to 0.0033 and both chart render tests
 *      now fail with `nothing drawn`. Before this, both passed.
 *   2. EVERYTHING DRAWN. A canvas flooded edge to edge with no background left
 *      is its own defect, and it passes every floor in the table — a noise
 *      canvas measures inkCoverage 0.999, distinctColours 3893, entropy 7.59,
 *      sharpness 25.6. Only the ceiling catches it. Fully transparent output is
 *      caught by `opaqueCoverage` in the same way.
 *
 * WHAT THESE ASSERTIONS DO NOT CATCH
 * ----------------------------------
 * Text painted in its own background colour. This was tried and abandoned, and
 * the measurement is the reason, so it is recorded here rather than left for
 * someone to try again:
 *
 *   - Mutating `.fallback-artist` / `.fallback-album` in chart.html to the cell
 *     background colour leaves distinctColours 141, inkCoverage 0.261,
 *     entropy 3.14, stdev 15.5 — all inside the bands above. Sharpness falls
 *     from 3.25 to 1.39, which is above the 0.5 floor.
 *   - A per-tile detail measure was tried next, to stop the cell borders from
 *     masking the lost glyphs. It does not help: the busiest tile measures
 *     39.08 both with and without the text, because a border is an edge too.
 *   - A self-calibrating differential (re-render the same HTML with all text
 *     forced to a loud colour, and require the pixels to move) separates the
 *     two cases — 1.86% of pixels change — but it only works when the test can
 *     reach the generator's HTML, and it does not generalise to the templates
 *     whose text colour comes from a runtime theme rather than a fixed rule.
 *
 * So the honest scope is: these assertions prove a chart was DRAWN, not that it
 * is LEGIBLE. A legibility check is a different tool — compare rendered text
 * colour against its own background, in the CSS, not in the pixels — and it has
 * not been written. Do not read a green render suite as a claim about text
 * contrast.
 *
 * The bands below are deliberately wide. These tests assert a real render, not
 * a pixel-exact one, and a band that only passes for one Chromium build is a
 * flake generator. Every floor and ceiling was set from measured data rather
 * than picked. Across the six real renders in the suite the extremes are:
 *
 *   distinctColours  53 .. 469       floor 8      (6x headroom)
 *   inkCoverage      0.046 .. 0.874  floor 0.02   (2.3x headroom, tightest)
 *   sharpness        1.55 .. 6.30    floor 0.5    (3x headroom)
 *   stdev            15.5 .. 34.7    floor 2      (7x headroom)
 *   opaqueCoverage   1.0             floor 0.5
 *   inkCoverage      ceiling 0.98     (a noise canvas measures 0.999)
 *
 * There is deliberately NO default entropy floor, and that is a measured
 * decision rather than an omission. sharp's `entropy` is pooled over every
 * channel of the whole image, so it scores how much of the canvas is varied —
 * not whether anything was drawn. The 2x2 album chart renders 600x600 with
 * four small cells and measures entropy 0.413, which is a correct chart with
 * ~95% of its area the black body colour. A floor of 1 rejected it. The
 * generator was right and the band was wrong. `distinctColours` catches a flat
 * image on its own (a blank render scores 1, not 8), so entropy stays in the
 * report as a diagnostic and a caller may still set a floor explicitly.
 *
 * The nearest real floor is inkCoverage at 2.3x, and that is tight on purpose:
 * the 2x2 album chart measures 0.046 and the mosaic WhoKnows card 0.060, so
 * 0.02 is the largest floor with real headroom on both.
 *
 * No new dependency: `sharp` is already in package.json and already decodes
 * images elsewhere in this repo.
 */

/** Decoded pixel measurements for one rendered PNG. */
export interface RenderPixelReport {
  width: number;
  height: number;
  /** Fraction of pixels with alpha > 0. 0 on a fully transparent render. */
  opaqueCoverage: number;
  /** Number of distinct colours after quantising each channel to 4 bits. */
  distinctColours: number;
  /** Proportion of pixels that are not the modal (background) colour. */
  inkCoverage: number;
  /** sharp's Shannon entropy over the channel histogram. 0 when flat. */
  entropy: number;
  /** sharp's Laplacian edge energy. 0 when there are no edges at all. */
  sharpness: number;
  /** Highest per-channel standard deviation. 0 across all channels means flat. */
  stdev: number;
}

/** Per-channel standard deviation; 0 on every channel means a flat image. */
function stdevOf(stats: Stats): number {
  return Math.max(...stats.channels.map((channel) => channel.stdev));
}

/**
 * Decode a PNG and measure its pixels. Pure: no assertions, so it can be used
 * to measure a real render and set the bands from data rather than from a guess.
 */
export async function analysePng(png: Buffer): Promise<RenderPixelReport> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 4) {
    throw new Error(
      `analysePng: expected 4 channels after ensureAlpha, got ${info.channels}`,
    );
  }

  const total = info.width * info.height;
  const counts = new Map<number, number>();
  let opaquePixels = 0;

  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3] ?? 0;
    if (alpha > 0) opaquePixels += 1;
    // Quantise to 4 bits per channel. A real render has thousands of distinct
    // values here; a flat one has exactly 1. The 4-bit step absorbs PNG
    // dithering and antialiasing noise without hiding a blank canvas.
    const r = (data[offset] ?? 0) >> 4;
    const g = (data[offset + 1] ?? 0) >> 4;
    const b = (data[offset + 2] ?? 0) >> 4;
    const key = (r << 8) | (g << 4) | b;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let modalCount = 0;
  for (const count of counts.values()) {
    if (count > modalCount) modalCount = count;
  }

  const stats = await sharp(png).stats();

  return {
    width: info.width,
    height: info.height,
    opaqueCoverage: opaquePixels / total,
    distinctColours: counts.size,
    inkCoverage: 1 - modalCount / total,
    entropy: stats.entropy,
    sharpness: stats.sharpness,
    stdev: stdevOf(stats),
  };
}

/**
 * Bounds an individual render must satisfy. Every field is optional; see
 * `DEFAULTS` for the values that apply when omitted.
 */
export interface InkBand {
  /** Minimum share of pixels with non-zero alpha. */
  minOpaqueCoverage?: number;
  /** Minimum distinct quantised colours. A flat image scores 1. */
  minDistinctColours?: number;
  /** Minimum share of pixels differing from the modal background colour. */
  minInkCoverage?: number;
  /**
   * Maximum share of pixels differing from the modal colour. Catches a canvas
   * flooded edge to edge with one non-background colour, which passes a
   * min-ink check and is still a broken chart.
   */
  maxInkCoverage?: number;
  /**
   * Minimum Shannon entropy over the whole image. Unset by default and see the
   * file header for the measurement that removed the default: entropy scores
   * how much of the CANVAS is varied, not whether anything was drawn, and a
   * correct small chart on a large dark body measures below 1.
   */
  minEntropy?: number;
  /**
   * Minimum Laplacian edge energy. A smooth body with no glyphs scores near
   * zero. This does NOT catch text painted in its own background colour — see
   * the file header for the measurement — so it is a floor against a blank
   * gradient, not a legibility check.
   */
  minSharpness?: number;
  /** Minimum per-channel standard deviation. A flat image scores 0. */
  minStdev?: number;
}

const DEFAULTS: Required<Omit<InkBand, 'minEntropy'>> & {
  minEntropy: number | null;
} = {
  minOpaqueCoverage: 0.5,
  minDistinctColours: 8,
  minInkCoverage: 0.02,
  maxInkCoverage: 0.98,
  // No default floor. A correct 2x2 album chart measures 0.413 — see header.
  minEntropy: null,
  minSharpness: 0.5,
  minStdev: 2,
};

function describe(report: RenderPixelReport): string {
  return [
    `report { width: ${report.width}, height: ${report.height},`,
    `  opaqueCoverage: ${report.opaqueCoverage.toFixed(4)},`,
    `  distinctColours: ${report.distinctColours},`,
    `  inkCoverage: ${report.inkCoverage.toFixed(4)},`,
    `  entropy: ${report.entropy.toFixed(4)},`,
    `  sharpness: ${report.sharpness.toFixed(4)} }`,
  ].join('\n');
}

/**
 * Assert that a rendered PNG carries real pixel content.
 *
 * Throws with the measured report and the band that failed, so a red run says
 * which defect fired rather than only that something is off. Call this IN
 * ADDITION to the size and magic-byte assertions, never instead of them: those
 * prove a PNG came back, this proves it has something in it.
 */
export async function assertRenderedInk(
  png: Buffer,
  label: string,
  band: InkBand = {},
): Promise<RenderPixelReport> {
  const limits = { ...DEFAULTS, ...band };
  const report = await analysePng(png);
  const detail = `${label}: ${describe(report)}`;
  const fail = (reason: string): never => {
    throw new Error(
      `${detail}\n  -> ${reason}. A render that fails this drew no real content; ` +
        'a PNG that merely decoded is not evidence that a chart was drawn.',
    );
  };

  if (report.opaqueCoverage < limits.minOpaqueCoverage) {
    fail(
      `flat/transparent render: only ${(report.opaqueCoverage * 100).toFixed(1)}% of pixels have ` +
        `non-zero alpha, floor is ${(limits.minOpaqueCoverage * 100).toFixed(1)}%`,
    );
  }
  if (report.distinctColours < limits.minDistinctColours) {
    fail(
      `flat-colour render: ${report.distinctColours} distinct quantised colour(s), ` +
        `floor is ${limits.minDistinctColours}. A single-colour canvas is a blank chart.`,
    );
  }
  if (report.inkCoverage < limits.minInkCoverage) {
    fail(
      `nothing drawn: ink coverage ${(report.inkCoverage * 100).toFixed(2)}% is below the ` +
        `${(limits.minInkCoverage * 100).toFixed(2)}% floor, so the render is background only`,
    );
  }
  if (report.inkCoverage > limits.maxInkCoverage) {
    fail(
      `canvas flooded: ink coverage ${(report.inkCoverage * 100).toFixed(2)}% is above the ` +
        `${(limits.maxInkCoverage * 100).toFixed(2)}% ceiling, so there is no background left`,
    );
  }
  if (limits.minEntropy !== null && report.entropy < limits.minEntropy) {
    fail(
      `flat-colour render: entropy ${report.entropy.toFixed(4)} is below the ` +
        `${limits.minEntropy} floor, so the pixel histogram has no spread`,
    );
  }
  if (report.sharpness < limits.minSharpness) {
    fail(
      `no detail drawn: sharpness ${report.sharpness.toFixed(4)} is below the ` +
        `${limits.minSharpness} floor, so the canvas has no edges at all. A smooth gradient ` +
        'body with no glyphs measures like this.',
    );
  }

  return report;
}
