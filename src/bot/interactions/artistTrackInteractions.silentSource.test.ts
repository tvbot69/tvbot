/**
 * `ArtistTrackInteractions.handle` reads
 * `artistTrackService.getTopTracksForArtist` with NO try around it, and that is
 * the correct shape - this file exists to pin it.
 *
 * The read raises rather than returning an empty track list, and with nothing
 * catching it the failure propagates to
 * `interactionHandler.onInteractionCreated` - a real boundary that answers the
 * presser ("Sorry, something went wrong while processing this interaction",
 * ephemeral), or lets Discord's own "This interaction failed" stand if the ack
 * guard already fired. Either way the user is TOLD. A local
 * `catch { deferUpdate() }` - the shape `artistInteractions` and
 * `playcountInteractions` used to have - converts that into a card that silently
 * does not move, which is indistinguishable from "this artist has no indexed
 * plays". So if someone later adds that catch here, this file goes red and says
 * why it would be the bug.
 *
 * Also the honest-empty half: a query that RAN and returned no rows must still
 * render, otherwise the propagate-everything version would make "no plays" and
 * "the database is down" render the same way.
 *
 * `UserService` cannot be a constructor double - `handle` resolves it out of the
 * container - so it is mocked at module scope behind a `vi.hoisted` holder. The
 * two real constructor dependencies are plain object doubles built fresh per
 * test. The only spy is the `ArtistTrackBuilders` static, which holds no state.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageFlags } from 'discord.js';
import { ArtistTrackInteractions } from './artistTrackInteractions';
import { ArtistTrackBuilders } from '@bot/builders/artistTrackBuilders';
import { SourceUnavailableError, isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import type { ButtonInteraction } from 'discord.js';

const userHolder = vi.hoisted(() => ({
  user: { userId: 7, userNameLastFm: 'Tester', discordUserId: 'u1' } as unknown,
}));

vi.mock('@bot/services/userService', () => ({
  UserService: class {
    public getUserByDiscordId(): unknown {
      return userHolder.user;
    }
  },
}));

const DB_DOWN = (): SourceUnavailableError =>
  new SourceUnavailableError('artistTrackService.getTopTracksForArtist', new Error('connect ECONNREFUSED'), 'Database unavailable');

const V2_CONTAINER = { sentinel: 'components-v2' } as never;

const BUILT_RESPONSE = {
  componentsV2Container: V2_CONTAINER,
  buildEmbed: () => ({ embeds: [] }),
  buildComponents: () => [],
};

const mkButton = (customId: string) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'u1', username: 'Tester' },
    guild: { id: 'g1', name: 'Test Guild', members: { cache: new Map() } },
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

/** Constructor arity is two, in this order: `artistTrackService`, `colorService`. */
const build = (over: Record<string, unknown> = {}) => {
  const artistTrackService = {
    getTopTracksForArtist: vi.fn(async () => [{ name: 'Track 1', playcount: 12 }]),
    getTotalArtistPlays: vi.fn(async () => 24),
    getDistinctTrackCount: vi.fn(async () => 1),
    ...(over.artistTrackService as object),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0xff0000),
    ...(over.colorService as object),
  };
  const service = new ArtistTrackInteractions(
    artistTrackService as never,
    colorService as never,
  );
  return { service, artistTrackService };
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(ArtistTrackBuilders, 'buildArtistTopTracksResponse').mockReturnValue(BUILT_RESPONSE as never);
  userHolder.user = { userId: 7, userNameLastFm: 'Tester', discordUserId: 'u1' };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NEXT_PAGE = 'at:next:0:Radiohead';

describe('ArtistTrackInteractions.handle — the read is deliberately unprotected', () => {
  it('lets a database outage reach the interaction dispatcher', async () => {
    // The behaviour being pinned. Nothing here catches, so the deliberate raise
    // leaves this handler instead of degrading into a card that does not move.
    const { service } = build({
      artistTrackService: {
        getTopTracksForArtist: vi.fn(async () => { throw DB_DOWN(); }),
      },
    });
    const press = mkButton(NEXT_PAGE);

    await expect(service.handle(press)).rejects.toSatisfy(isSourceUnavailable);

    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
    expect(ArtistTrackBuilders.buildArtistTopTracksResponse).not.toHaveBeenCalled();
  });

  it('still renders an empty track list when the read ran and returned nothing', async () => {
    const { service } = build({
      artistTrackService: {
        getTopTracksForArtist: vi.fn(async () => []),
        getTotalArtistPlays: vi.fn(async () => 0),
        getDistinctTrackCount: vi.fn(async () => 0),
      },
    });
    const press = mkButton(NEXT_PAGE);

    await expect(service.handle(press)).resolves.toBeUndefined();

    expect(ArtistTrackBuilders.buildArtistTopTracksResponse).toHaveBeenCalledTimes(1);
    expect(ArtistTrackBuilders.buildArtistTopTracksResponse).toHaveBeenCalledWith(
      'Radiohead', 'Tester', [], 0, 0, 0, 0xff0000, 'Radiohead', 'u1', 'u1', false,
    );
    expect(press.update).toHaveBeenCalledWith({
      components: [V2_CONTAINER],
      flags: MessageFlags.IsComponentsV2,
    });
  });

  it('still renders when the read succeeds', async () => {
    const { service } = build();
    const press = mkButton(NEXT_PAGE);

    await expect(service.handle(press)).resolves.toBeUndefined();

    expect(press.update).toHaveBeenCalledTimes(1);
  });
});
