/**
 * A crown-card button carries a numeric Artist row id, and this file is about
 * the moment that id is not allowed to become a name.
 *
 * `CrownBuilders.buildCrownDuelResponse` writes `artist-whoknows:${artistId}`
 * (`crownBuilders.ts:249`) - a bare id, with no name in the customId at all.
 * `CrownInteractions.handleButton` then had
 *
 *     let artistName = decodeURIComponent(raw);
 *     if (/^\d+$/.test(raw)) {
 *       try { ... } catch { /* fallback to decodeURIComponent *\/ }
 *     }
 *
 * and the comment described a fallback that does not exist for a numeric raw:
 * decoding "42" yields "42", not a name. So a lookup that failed produced a
 * who-knows card headed "42", and the Crown button that card carries was then
 * stamped `artist-crown:42` - a wrong name frozen into a customId on a message
 * that is never re-rendered, so every later press of that button repeats it.
 *
 * The distinction that matters, and the reason the two failure messages differ:
 * a read that THREW is retryable and transient, a read that RAN and found no
 * row is permanent, and neither of them is evidence that an artist called "42"
 * exists. Both are reported; neither is substituted.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';
import { MessageFlags } from 'discord.js';
import { CrownInteractions } from '@bot/interactions/crown/crownInteractions';
import { ArtistRepository } from '@persistence/repositories/artistRepository';
import { WhoKnowsCommands } from '@bot/textCommands/guild/whoKnowsCommands';
import { CrownCommands } from '@bot/textCommands/guild/crownCommands';

const LFM_DOWN_TEXT = 'Could not load that artist. Please try again in a moment.';
const GONE_TEXT = 'That artist is no longer available.';

const mkButton = (customId: string) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'caller1' },
    guild: { name: 'TestGuild', members: { cache: new Map() } },
    isRepliable: vi.fn(() => true),
    replied: false,
    deferred: false,
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  }) as unknown as import('discord.js').ButtonInteraction & {
    isRepliable: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };

const build = () => {
  const crownService = {
    getUserCrowns: vi.fn(async () => []),
    getGuildLeaderboard: vi.fn(async () => ({ entries: [], totalActiveCrowns: 0 })),
  };
  const userService = {
    getUserByDiscordId: vi.fn(async () => ({ userId: 1, userNameLastFm: 'lfmuser' })),
  };
  const colorService = { getAccentColorAsync: vi.fn(async () => 0xff0000) };
  const ci = new CrownInteractions(crownService as never, userService as never, colorService as never);
  return { ci };
};

const whoKnowsDouble = () => ({
  // Both call arguments are declared so `mock.calls[0][1]` typechecks. A
  // zero-arg mock infers a `[]` call tuple, and reading index 1 of it is a
  // compile error that vitest never reports.
  whoKnowsArtistForName: vi.fn(async (..._args: unknown[]) => ({
    isComponentsV2: true,
    componentsV2Container: {},
    addButtonRow: vi.fn(),
  })),
});

const crownDouble = () => ({
  crownAsync: vi.fn(async () => ({ isComponentsV2: true, componentsV2Container: {} })),
});

const resolveWith = (impl: (token: unknown) => unknown) => {
  vi.spyOn(container, 'resolve').mockImplementation(impl as never);
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CrownInteractions — a numeric customId is resolved to a name or reported, never substituted', () => {
  it('uses the artist name the lookup returned', async () => {
    const { ci } = build();
    const whoKnowsCommands = whoKnowsDouble();
    resolveWith((token) => {
      if (token === ArtistRepository) return { getArtistById: vi.fn(async () => ({ name: 'Radiohead' })) };
      if (token === WhoKnowsCommands) return whoKnowsCommands;
      return {} as never;
    });

    await ci.handleButton(mkButton('artist-whoknows:42'));

    expect(whoKnowsCommands.whoKnowsArtistForName).toHaveBeenCalledTimes(1);
    expect(whoKnowsCommands.whoKnowsArtistForName.mock.calls[0]![1]).toBe('Radiohead');
  });

  it('reports a lookup that threw, and does not call the command at all', async () => {
    const { ci } = build();
    const whoKnowsCommands = whoKnowsDouble();
    resolveWith((token) => {
      if (token === ArtistRepository) {
        return {
          getArtistById: vi.fn(async () => {
            throw new Error('connect ECONNREFUSED');
          }),
        };
      }
      if (token === WhoKnowsCommands) return whoKnowsCommands;
      return {} as never;
    });
    const press = mkButton('artist-whoknows:42');

    await ci.handleButton(press);

    expect(whoKnowsCommands.whoKnowsArtistForName).not.toHaveBeenCalled();
    expect(press.reply).toHaveBeenCalledWith({
      content: LFM_DOWN_TEXT,
      flags: MessageFlags.Ephemeral,
    });
  });

  it('reports a lookup that ran and found no row, with a DIFFERENT message', async () => {
    // The pair, strictly. "Could not load that artist" is a retry promise, and
    // it would be a false one here: the query ran, the answer was "no such
    // row", and telling the user to try again in a moment is a lie about a
    // thing that will never change. Equally, neither message may fall back to
    // rendering a card for "42".
    const { ci } = build();
    const whoKnowsCommands = whoKnowsDouble();
    resolveWith((token) => {
      if (token === ArtistRepository) return { getArtistById: vi.fn(async () => null) };
      if (token === WhoKnowsCommands) return whoKnowsCommands;
      return {} as never;
    });
    const press = mkButton('artist-whoknows:42');

    await ci.handleButton(press);

    expect(whoKnowsCommands.whoKnowsArtistForName).not.toHaveBeenCalled();
    expect(press.reply).toHaveBeenCalledWith({
      content: GONE_TEXT,
      flags: MessageFlags.Ephemeral,
    });
  });

  it('never sends a "42" or any id-as-name to the crown command', async () => {
    // The sticky half. The who-knows branch writes `artist-crown:${artistName}`
    // (crownInteractions.ts:204), so a wrong name here becomes a permanent
    // wrong label on a button of a message that is never re-rendered. This
    // asserts the absence of the defect directly, over both outcomes that
    // produce no name at all.
    const { ci } = build();
    const crownCommands = crownDouble();
    const resolve = (getArtistById: () => Promise<unknown>) =>
      resolveWith((token) => {
        if (token === ArtistRepository) return { getArtistById: vi.fn(getArtistById) };
        if (token === CrownCommands) return crownCommands;
        return {} as never;
      });

    resolve(async () => {
      throw new Error('db down');
    });
    await ci.handleButton(mkButton('artist-crown:42'));
    resolve(async () => null);
    await ci.handleButton(mkButton('artist-crown:42'));

    expect(crownCommands.crownAsync).not.toHaveBeenCalled();
  });

  it('uses followUp rather than reply when the ack guard already deferred', async () => {
    // The 2.5s ack guard in interactionHandler races this handler, so the same
    // lookup can fail with the interaction already acknowledged, where `reply`
    // throws 40060 and the report is lost.
    const { ci } = build();
    resolveWith((token) => {
      if (token === ArtistRepository) {
        return {
          getArtistById: vi.fn(async () => {
            throw new Error('db down');
          }),
        };
      }
      return {} as never;
    });
    const press = mkButton('artist-whoknows:42');
    (press as unknown as { deferred: boolean }).deferred = true;

    await ci.handleButton(press);

    expect(press.followUp).toHaveBeenCalledWith({
      content: LFM_DOWN_TEXT,
      flags: MessageFlags.Ephemeral,
    });
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('leaves the crown card the user is looking at untouched', async () => {
    // A nav target that cannot render must degrade in place. Neither `reply`
    // nor `followUp` carries components, and no `editReply` is issued, so the
    // duel card the user pressed from is still there.
    const { ci } = build();
    resolveWith((token) => {
      if (token === ArtistRepository) {
        return {
          getArtistById: vi.fn(async () => {
            throw new Error('db down');
          }),
        };
      }
      return {} as never;
    });
    const press = mkButton('artist-whoknows:42');

    await ci.handleButton(press);

    expect(press.editReply).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('still trusts a customId that already carries a name', async () => {
    // The other half of the contract, and the reason the report above is not
    // "this button never works": `artist-crown:` is written from a name we
    // already had, so there is no read to fail and nothing to report. Only a
    // NUMERIC raw needs the repository.
    const { ci } = build();
    const whoKnowsCommands = whoKnowsDouble();
    const getArtistById = vi.fn(async () => {
      throw new Error('must not be called for a name-carrying customId');
    });
    resolveWith((token) => {
      if (token === ArtistRepository) return { getArtistById };
      if (token === WhoKnowsCommands) return whoKnowsCommands;
      return {} as never;
    });
    const press = mkButton('artist-whoknows:Radiohead');

    await ci.handleButton(press);

    expect(getArtistById).not.toHaveBeenCalled();
    expect(whoKnowsCommands.whoKnowsArtistForName.mock.calls[0]![1]).toBe('Radiohead');
    expect(press.reply).not.toHaveBeenCalled();
    expect(press.editReply).toHaveBeenCalledTimes(1);
  });

  it('decodes a percent-encoded name correctly, so a read is not the only path', async () => {
    const { ci } = build();
    const whoKnowsCommands = whoKnowsDouble();
    resolveWith((token) => {
      if (token === WhoKnowsCommands) return whoKnowsCommands;
      return {} as never;
    });

    await ci.handleButton(mkButton('artist-whoknows:AC%2FDC'));

    expect(whoKnowsCommands.whoKnowsArtistForName.mock.calls[0]![1]).toBe('AC/DC');
  });
});
