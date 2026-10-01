/**
 * `UpdateBuilders` — the two cards the update pipeline answers with.
 *
 * These are the cards where a *fabricated* number is most tempting and most
 * damaging, because they are literally the report of what the indexer read:
 *
 *  1. `buildModularResult` prints a line per count and only for the counts that
 *     were actually supplied. A `trackCount` the service could not produce leaves
 *     the line out rather than printing "0 tracks indexed" next to a real album
 *     count. That is the whole point of the `!== undefined` guards, so both
 *     directions are asserted.
 *  2. "Nothing changed" and "we could not check" must be different sentences.
 *     A delta of 0/0 says the playcounts were already up to date, which is a
 *     claim about a read that happened; there is no path here that renders 0/0
 *     without having read something.
 *  3. A `latestScrobble` that is an invalid Date is dropped, not rendered as a
 *     relative timestamp 55 years in the past.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { UpdateBuilders } from '@bot/builders/meta/updateBuilders';
import { DiscordConstants } from '@bot/resources/discordConstants';

const desc = (r: { embed: { data: { description?: string } } }): string => r.embed.data.description ?? '';

describe('UpdateBuilders.buildDeltaResult', () => {
  it('reports a real change as a change, singularising a single scrobble', () => {
    const one = desc(UpdateBuilders.buildDeltaResult('listener', { newPlays: 1, removedPlays: 0 }));
    const many = desc(UpdateBuilders.buildDeltaResult('listener', { newPlays: 12, removedPlays: 0 }));
    expect(one).toContain("playcounts were updated with **1** new scrobble!");
    expect(many).toContain('playcounts were updated with **12** new scrobbles!');
    expect(many).not.toContain('removed');
  });

  it('reports removed plays only when there were some, and keeps the new count beside them', () => {
    const text = desc(UpdateBuilders.buildDeltaResult('listener', { newPlays: 3, removedPlays: 2 }));
    expect(text).toContain('**3** new scrobbles and **2** removed!');
  });

  it('reports a removal with no additions rather than claiming zero new scrobbles', () => {
    const text = desc(UpdateBuilders.buildDeltaResult('listener', { newPlays: 0, removedPlays: 5 }));
    expect(text).toContain('playcounts were updated with **0** new scrobbles and **5** removed!');
  });

  it('says "already up to date" for a genuine no-op, with a check time', () => {
    const before = Math.floor(Date.now() / 1000);
    const text = desc(UpdateBuilders.buildDeltaResult('listener', { newPlays: 0, removedPlays: 0 }));
    const after = Math.floor(Date.now() / 1000);
    const match = /already up to date \(last checked <t:(\d+):R>\)/.exec(text);
    expect(match).not.toBeNull();
    const stamp = Number(match?.[1]);
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
  });

  it('appends the last scrobble only for a no-op, not for a change', () => {
    const latest = new Date('2026-09-20T10:00:00Z');
    const unix = Math.floor(latest.getTime() / 1000);
    const noop = desc(UpdateBuilders.buildDeltaResult('listener', { newPlays: 0, removedPlays: 0, latestScrobble: latest }));
    const changed = desc(UpdateBuilders.buildDeltaResult('listener', { newPlays: 2, removedPlays: 0, latestScrobble: latest }));
    expect(noop).toContain(`Last scrobble: <t:${unix}:R>`);
    expect(changed).not.toContain('Last scrobble');
  });

  it('omits the last-scrobble line when there was no scrobble, rather than printing the epoch', () => {
    const text = desc(UpdateBuilders.buildDeltaResult('listener', { newPlays: 0, removedPlays: 0 }));
    expect(text).not.toContain('Last scrobble');
  });

  it('drops a last-scrobble date it could not parse instead of rendering nonsense', () => {
    // `new Date('not a date')` is an Invalid Date. Rendering it would put a
    // relative timestamp 55 years in the past on the card.
    const text = desc(
      UpdateBuilders.buildDeltaResult('listener', { newPlays: 0, removedPlays: 0, latestScrobble: new Date('nope') }),
    );
    expect(text).not.toContain('Last scrobble');
    expect(text).toContain('already up to date');
  });

  it('links the user by name so the card is about somebody specific', () => {
    const text = desc(UpdateBuilders.buildDeltaResult('two words', { newPlays: 1, removedPlays: 0 }));
    expect(text).toContain('[two words](https://www.last.fm/user/two%20words)');
  });

  it('reports success in green by default and honours an override', () => {
    expect(UpdateBuilders.buildDeltaResult('l', { newPlays: 1, removedPlays: 0 }).embed.toJSON().color).toBe(
      DiscordConstants.SuccessColorGreen,
    );
    expect(UpdateBuilders.buildDeltaResult('l', { newPlays: 1, removedPlays: 0 }, 0x999999).embed.toJSON().color).toBe(
      0x999999,
    );
  });
});

describe('UpdateBuilders.buildModularResult', () => {
  it('prints one line per count it was given', () => {
    const text = desc(
      UpdateBuilders.buildModularResult('listener', {
        artistCount: 1200,
        albumCount: 4300,
        trackCount: 12_500,
        playCount: 250_000,
        totalScrobbles: 260_000,
        durationSec: '12.5',
      }),
    );
    expect(text).toContain("- **1,200** artists indexed");
    expect(text).toContain("- **4,300** albums indexed");
    expect(text).toContain("- **12,500** tracks indexed");
    expect(text).toContain("- **250,000** plays stored");
    expect(text).toContain("- **260,000** total scrobbles");
  });

  it('omits a count that was not supplied rather than printing 0 for it', () => {
    // The honest half. A `trackCount` the indexer could not produce leaves the
    // line out; printing "0 tracks indexed" beside a real album count would
    // look like a wipe.
    const text = desc(
      UpdateBuilders.buildModularResult('listener', {
        artistCount: 12,
        albumCount: 0,
        durationSec: '1.2',
      }),
    );
    expect(text).toContain("- **12** artists indexed");
    // A genuine zero IS printed: the indexer ran and found nothing.
    expect(text).toContain("- **0** albums indexed");
    expect(text).not.toContain('tracks indexed');
    expect(text).not.toContain('plays stored');
    expect(text).not.toContain('total scrobbles');
  });

  it('renders a card with no counts at all rather than a list of zeroes', () => {
    const text = desc(UpdateBuilders.buildModularResult('listener', { durationSec: '0.1' }));
    expect(text).toBe("[listener](https://www.last.fm/user/listener)'s data has been updated:\n\n*Completed in 0.1s*");
  });

  it('always states how long the rebuild took, because that is the claim being made', () => {
    expect(desc(UpdateBuilders.buildModularResult('l', { durationSec: '31.7' }))).toContain(
      '*Completed in 31.7s*',
    );
  });

  it('links the user by name', () => {
    expect(desc(UpdateBuilders.buildModularResult('two words', { durationSec: '1' }))).toContain(
      "[two words](https://www.last.fm/user/two%20words)",
    );
  });

  it('defaults to a warning colour on a failed rebuild and to green on a clean one', () => {
    const failed = UpdateBuilders.buildModularResult('l', { durationSec: '1', error: true });
    const clean = UpdateBuilders.buildModularResult('l', { durationSec: '1' });
    expect(failed.embed.toJSON().color).toBe(DiscordConstants.WarningColorOrange);
    expect(clean.embed.toJSON().color).toBe(DiscordConstants.SuccessColorGreen);
  });

  it('lets the caller override the failure colour, because the bot knows more than the flag', () => {
    const response = UpdateBuilders.buildModularResult('l', { durationSec: '1', error: true }, 0x111111);
    expect(response.embed.toJSON().color).toBe(0x111111);
  });
});
