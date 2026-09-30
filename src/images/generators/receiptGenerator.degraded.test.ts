import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReceiptGenerator, type ReceiptData } from './receiptGenerator';
import type { PuppeteerService } from './puppeteerService';

/**
 * `ReceiptGenerator` — the "your listening wrapped up as a till receipt" card.
 *
 * No browser. The generator's whole external contract is one
 * `screenshotHtml(html, 500, height)` call, so recording those three arguments
 * is a complete test of it.
 *
 * The theme is the DENOMINATOR. This generator can be handed a tracklist it
 * truncated (`tracks.slice(0, 12)`) and separately a `totalTracks` it could not
 * read. Printing a number it does not have is the failure the A-tier bar names
 * explicitly, so both directions are asserted: a known total is printed, and an
 * unknown one OMITS the row entirely rather than printing 0 or a guess.
 *
 * VENDOR ASSUMPTION — none here touches a vendor, but one host does appear in
 * the shipped template (`receipt.html` references a font on a third-party site).
 * The test below asserts that the BACKGROUND is inlined as a data URI and that
 * the font URL is still remote, because that asymmetry is the reason the
 * request policy has an allowlist entry for it at all. If the font is ever
 * inlined too, that allowlist entry becomes dead and the test says so.
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
      return Buffer.from('mock-receipt-png');
    }),
  } as unknown as PuppeteerService;
  return { generator: new ReceiptGenerator(puppeteer), shots };
};

const data = (over: Partial<ReceiptData> = {}): ReceiptData => ({
  userNameLastFm: 'listener',
  displayName: 'Listener',
  periodDescription: 'Last 7 days',
  tracks: [
    { artistName: 'Radiohead', trackName: 'Paranoid Android', userPlaycount: 42 },
    { artistName: 'Kendrick Lamar', trackName: 'HUMBLE.', userPlaycount: 35 },
  ],
  totalPlays: 77,
  ...over,
});

let harness: ReturnType<typeof makeGenerator>;

const render = async (over: Partial<ReceiptData>): Promise<Captured> => {
  const buffer = await harness.generator.generateReceipt(data(over));
  expect(buffer.toString()).toBe('mock-receipt-png');
  return harness.shots[harness.shots.length - 1]!;
};

beforeEach(() => {
  harness = makeGenerator();
});

describe('ReceiptGenerator — the track table', () => {
  it('prints one row per track with a thousands-grouped playcount', async () => {
    const shot = await render({
      tracks: [{ artistName: 'Boards of Canada', trackName: 'Music Is Math', userPlaycount: 12345 }],
      totalPlays: 12345,
      totalTracks: 1,
    });

    expect(shot.html).toContain('Boards of Canada - Music Is Math');
    expect(shot.html).toContain('12,345');
  });

  it('caps the printed rows at twelve and does NOT pretend that is the whole list', async () => {
    // The cap is a layout decision. The danger is a truncated list being summed
    // into a "SUBTOTAL" that then reads as the listener's total, so the
    // subtotal is the sum of the printed rows and `totalPlays` stays whatever
    // the caller actually knows.
    const tracks = Array.from({ length: 15 }, (_, i) => ({
      artistName: `Artist ${String(i)}`,
      trackName: `Track ${String(i)}`,
      userPlaycount: 10,
    }));
    const shot = await render({ tracks, totalPlays: 150, totalTracks: 15 });

    expect(shot.html.match(/<td class="align-right">10<\/td>/g) ?? []).toHaveLength(12);
    expect(shot.html).not.toContain('Artist 12');
    // 12 printed rows x 10 plays, while the caller-supplied total stays 150.
    // The whitespace-tolerant match matters: the template wraps its own cells in
    // newlines and indentation, so `<td class="align-right">150</td>` never
    // appears verbatim and a naive assertion would pass for the wrong reason.
    expect(shot.html).toMatch(/<td class="align-right">\s*120\s*<\/td>/);
    expect(shot.html).toMatch(/<td class="align-right">\s*150\s*<\/td>/);
  });

  it('escapes artist and track names, which come from a scrobble log', async () => {
    const shot = await render({
      tracks: [{ artistName: 'AC&DC', trackName: '<b>T.N.T.</b>', userPlaycount: 1 }],
    });

    expect(shot.html).toContain('AC&amp;DC - &lt;b&gt;T.N.T.&lt;/b&gt;');
    expect(shot.html).not.toContain('<b>T.N.T.</b>');
  });

  it('renders an empty table body when there are no tracks, rather than throwing', async () => {
    // A genuine empty is not a failure, and it must not print "SUBTOTAL 0" next
    // to a total the caller supplied — that is a denominator the card cannot
    // reconcile, so the honest answer is an empty table.
    const shot = await render({ tracks: [], totalPlays: 0 });
    // No ITEM row survives: the generator emitted no `<td>Artist - Track</td>`.
    expect(shot.html).not.toMatch(/<td>[^<]* - [^<]*<\/td>/);
    // The zero subtotal still renders. Matched whitespace-tolerantly: the
    // template wraps its own cells in newlines and indentation, so
    // `>0</td>` never appears verbatim and a bare substring check would fail
    // on a card that is entirely correct.
    expect(shot.html).toMatch(/<td class="align-right">\s*0\s*<\/td>/);
  });
});

describe('ReceiptGenerator — the denominator is only printed when it is known', () => {
  it('prints the total-tracks row when the caller supplied one', async () => {
    const shot = await render({ totalTracks: 2 });
    expect(shot.html).toContain('TOTAL TRACKS:');
    expect(shot.html).toMatch(/TOTAL TRACKS:<\/td>\s*<td class="align-right">2<\/td>/);
  });

  const unknownTotals: Array<[string, number | undefined]> = [
    ['absent', undefined],
    ['zero', 0],
  ];

  it.each(unknownTotals)(
    'OMITS the total-tracks row when it is %s, instead of printing 0',
    async (_label, totalTracks) => {
      // Rule 7 of the brief, and the A1 property: a number the generator could
      // not read must not become a confident number on the image. There is no
      // "TOTAL TRACKS: 0" here, because 0 is a claim and the truth is "unknown".
      const shot = await render({ totalTracks });
      expect(shot.html).not.toContain('TOTAL TRACKS');
      // The rest of the receipt is untouched, so the omission is targeted.
      expect(shot.html).toContain('TOTAL PLAYS:');
    },
  );

  it('still prints the total-plays line, which the caller always has', async () => {
    const shot = await render({ totalTracks: undefined, totalPlays: 77 });
    expect(shot.html).toMatch(/TOTAL PLAYS:\s*<\/td>\s*<td class="align-right">\s*77\s*<\/td>/);
  });
});

describe('ReceiptGenerator — the card is sized to what it printed', () => {
  it('never asks for less than the 680px minimum, however few tracks there are', async () => {
    const shot = await render({ tracks: [{ artistName: 'A', trackName: 'B', userPlaycount: 1 }] });
    // max(680, 520 + 1*36) = 680
    expect(shot.width).toBe(500);
    expect(shot.height).toBe(680);
  });

  it('grows by 36px a row once the minimum is passed', async () => {
    const tracks = Array.from({ length: 12 }, () => ({
      artistName: 'A',
      trackName: 'B',
      userPlaycount: 1,
    }));
    const shot = await render({ tracks, totalPlays: 12 });
    // max(680, 520 + 12*36) = 952
    expect(shot.height).toBe(952);
  });

  it('sizes from the PRINTED rows, not the supplied list', async () => {
    // Twelve printed rows out of fifteen: the height is what has to fit.
    const tracks = Array.from({ length: 15 }, () => ({
      artistName: 'A',
      trackName: 'B',
      userPlaycount: 1,
    }));
    const shot = await render({ tracks, totalPlays: 15 });
    expect(shot.height).toBe(952);
  });
});

describe('ReceiptGenerator — the header is filled from the caller or invented', () => {
  it('uses the supplied order number, period, username and year verbatim', async () => {
    const shot = await render({
      orderNumber: 1337,
      periodDescription: 'Last 7 days',
      userNameLastFm: 'listener',
      displayName: 'Listener',
      year: 2026,
      authCode: '987654',
    });

    expect(shot.html).toContain('ORDER #1337 FOR listener');
    expect(shot.html).toContain('LAST 7 DAYS');
    expect(shot.html).toContain('**** 2026');
    expect(shot.html).toContain('AUTH CODE: 987654');
    expect(shot.html).toContain('CARDHOLDER: Listener');
  });

  it('invented values are shaped like real ones, because there is nothing to read', async () => {
    // With no order number there is no fact to report, so a receipt-shaped
    // value is the right answer — but it must be the right SHAPE, or the card
    // reads as a broken render.
    const shot = await render({ orderNumber: undefined, authCode: undefined, year: undefined });

    const order = shot.html.match(/ORDER #(\d+)/)?.[1];
    expect(order).toMatch(/^\d{4}$/);
    const auth = shot.html.match(/AUTH CODE: (\d+)/)?.[1];
    expect(auth).toMatch(/^\d{6}$/);
    const year = shot.html.match(/\*\*\*\* (\d{4})/)?.[1];
    expect(year).toMatch(/^\d{4}$/);
  });

  it('picks a background offset inside the texture, so the receipt is not cropped', async () => {
    const shot = await render({});
    const offset = Number(shot.html.match(/background-position: -(\d+)px/)?.[1]);
    expect(Number.isInteger(offset)).toBe(true);
    expect(offset).toBeGreaterThanOrEqual(10);
    expect(offset).toBeLessThanOrEqual(999);
  });

  it('renders a generation date, which is the one field the generator does know', async () => {
    const shot = await render({});
    expect(shot.html).toMatch(/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/);
  });
});

describe('ReceiptGenerator — what reaches the browser', () => {
  it('inlines the background as a data URI, so no third-party image is fetched at render time', async () => {
    // The constructor reads `receipt_bg.png` and rewrites the CDN URL. If that
    // read fails the template keeps pointing at another origin and every receipt
    // render makes an outbound request the request policy has to allowlist.
    const shot = await render({});
    expect(shot.html).toContain('url("data:image/png;base64,');
    expect(shot.html).not.toContain('https://fm.bot/img/bot/receipt.png');
  });

  it('still uses a remote font, which is the only remote asset in any page', async () => {
    // Deliberately asserted rather than wished away: the font is NOT inlined, so
    // the allowlist entry for that host in `browserRequestPolicy.ts` is
    // load-bearing. If this ever becomes a data URI, the entry is dead.
    const shot = await render({});
    expect(shot.html).toContain('https://fm.bot/fonts/receipt.ttf');
  });

  it('adds the monospace fallback, so the receipt is readable without the web font', async () => {
    // If the font request is blocked by the policy or fails, the card must not
    // render in a proportional face — the columns are aligned by spaces.
    const shot = await render({});
    expect(shot.html).toContain('font-family: "receipt", "Courier New", Courier, monospace;');
  });

  it('leaves no template token in the output', async () => {
    // `{{total-tracks}}` is replaced with the EMPTY STRING when the total is
    // unknown, so a bare "contains the token" check would pass on a card whose
    // literal `{{total-tracks}}` was simply never substituted.
    const shot = await render({ totalTracks: undefined });
    expect(shot.html).not.toMatch(/\{\{/);
  });

  it('escapes the period and the usernames, both of which are user-supplied', async () => {
    const shot = await render({
      periodDescription: '<script>alert(1)</script>',
      userNameLastFm: 'a"b',
      displayName: "c'd",
    });
    expect(shot.html).not.toContain('<script>alert(1)</script>');
    expect(shot.html).toContain('&lt;SCRIPT&gt;');
    expect(shot.html).toContain('a&quot;b');
    expect(shot.html).toContain('c&#039;d');
  });
});

describe('ReceiptGenerator — an unreadable template fails loudly', () => {
  it('throws when the template could not be loaded, instead of screenshotting an empty page', async () => {
    // A silently empty template would render a 500x680 black PNG and post it as
    // a "your week in music" card. The throw is the whole point.
    const { generator, shots } = makeGenerator();
    (generator as unknown as { receiptHtmlTemplate: string }).receiptHtmlTemplate = '';

    await expect(generator.generateReceipt(data())).rejects.toThrow(/template not found/i);
    expect(shots).toHaveLength(0);
  });
});
