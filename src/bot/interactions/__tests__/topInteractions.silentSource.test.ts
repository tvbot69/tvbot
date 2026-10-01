/**
 * `TopInteractions.handle` reads `lastfmRepository.getTopArtists`,
 * `getTopAlbums`, `getTopTracks` and `OverviewService.getOverview` inside one
 * `try`. All four RAISE `LastFmUnavailableError` / `SourceUnavailableError`
 * when the source could not answer - deliberately, so that no caller can turn an
 * outage into an empty top list that looks like real data.
 *
 * The catch at the end of that `try` laundered the raise straight back into a
 * dead button: press "next page" during a Last.fm outage and the card did not
 * move, with nothing in Discord and nothing in Railway saying the read had
 * failed. It is now narrowed with `isSourceUnavailable`, so the deliberate
 * signal propagates to `interactionHandler.onInteractionCreated` - a real
 * boundary that answers the presser - while a genuine query failure still
 * degrades to the unchanged message.
 *
 * BOTH DIRECTIONS. A test that only pins the raise passes just as happily
 * against a blanket `throw err`, which would break every ordinary query failure;
 * a test that only pins the degrade passes against the bug. So: the raise is
 * pinned for all four reads, a plain query failure still degrades, and a query
 * that RAN and returned nothing still renders empty.
 *
 * `OverviewService` cannot be a constructor double - the handler resolves it out
 * of the container - so it is mocked at module scope behind a `vi.hoisted`
 * holder. Everything else is a plain object double built fresh per test and
 * handed to the constructor. The only spy is on the `TopBuilders` statics, which
 * hold no state and exist purely so this file does not build a real chart.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TopInteractions } from '../topInteractions';
import { TopBuilders } from '@bot/builders/topBuilders';
import { LastFmUnavailableError } from '@domain/models/lastfmUnavailableError';
import { SourceUnavailableError, isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import type { ButtonInteraction } from 'discord.js';

const overviewHolder = vi.hoisted(() => ({
  getOverview: async (): Promise<{ dailyBlocks: never[] }> => ({ dailyBlocks: [] }),
}));

vi.mock('@bot/services/overviewService', () => ({
  OverviewService: class {
    public getOverview(): Promise<{ dailyBlocks: never[] }> {
      return overviewHolder.getOverview();
    }
  },
}));

/** The transport failure as `lastfmRepository.orUnavailable` raises it. */
const LFM_DOWN = (): LastFmUnavailableError =>
  new LastFmUnavailableError('user.gettopartists', new Error('Last.fm returned HTTP 500'));

/** The database failure as `orDatabaseUnavailable` raises it. */
const DB_DOWN = (): SourceUnavailableError =>
  new SourceUnavailableError('overviewService.getOverview', new Error('connect ECONNREFUSED'), 'Database unavailable');

const TOP_ITEMS = [
  { name: 'Artist 1', playcount: 100 },
  { name: 'Artist 2', playcount: 90 },
];

const TIME_SETTINGS = { timePeriod: 'overall', description: 'All time' };

const BUILT_RESPONSE = {
  componentsV2Container: undefined,
  buildEmbed: () => ({ embeds: [] }),
  buildComponents: () => [],
  toMessagePayload: () => ({ embeds: [] }),
};

const mkButton = (customId: string) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'u1', username: 'Tester' },
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

/**
 * Constructor arity is three, in this order: `lastfmRepository`,
 * `settingService`, `colorService`. Swapping any two of them compiles clean and
 * would make every read fail inside the handler's own catch, which is
 * indistinguishable from the behaviour under test.
 */
const build = (over: Record<string, unknown> = {}) => {
  const lastfmRepository = {
    getTopArtists: vi.fn(async () => TOP_ITEMS),
    getTopAlbums: vi.fn(async () => TOP_ITEMS),
    getTopTracks: vi.fn(async () => TOP_ITEMS),
    ...(over.lastfmRepository as object),
  };
  const settingService = {
    getTimePeriod: vi.fn(() => TIME_SETTINGS),
    ...(over.settingService as object),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0xff0000),
    ...(over.colorService as object),
  };
  const service = new TopInteractions(
    lastfmRepository as never,
    settingService as never,
    colorService as never,
  );
  return { service, lastfmRepository, settingService, colorService };
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(TopBuilders, 'buildTopArtistsResponse').mockResolvedValue(BUILT_RESPONSE as never);
  vi.spyOn(TopBuilders, 'buildTopAlbumsResponse').mockResolvedValue(BUILT_RESPONSE as never);
  vi.spyOn(TopBuilders, 'buildTopTracksResponse').mockResolvedValue(BUILT_RESPONSE as never);
  overviewHolder.getOverview = async () => ({ dailyBlocks: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * prefix -> the repository read that prefix performs AND the builder that read
 * feeds. Both are named explicitly rather than derived, so a test cannot drift
 * onto the wrong read and pass for the wrong reason.
 */
type TopBuilderName = 'buildTopArtistsResponse' | 'buildTopAlbumsResponse' | 'buildTopTracksResponse';
const PREFIX_READS: Array<[prefix: string, read: string, builder: TopBuilderName]> = [
  ['topartists', 'getTopArtists', 'buildTopArtistsResponse'],
  ['topalbums', 'getTopAlbums', 'buildTopAlbumsResponse'],
  ['toptracks', 'getTopTracks', 'buildTopTracksResponse'],
];

describe('TopInteractions.handle — a Last.fm outage is not an empty page', () => {
  it.each(PREFIX_READS)('%s re-throws the deliberate signal instead of rendering an empty list', async (prefix, read, builder) => {
    const { service } = build({
      lastfmRepository: { [read]: vi.fn(async () => { throw LFM_DOWN(); }) },
    });
    const press = mkButton(`${prefix}:next:0:user1:weekly`);

    await expect(service.handle(press)).rejects.toSatisfy(isSourceUnavailable);

    // The dead-button behaviour being removed: no render, and no local ack
    // either - the throw has to leave this handler for the boundary to answer.
    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
    expect(TopBuilders[builder]).not.toHaveBeenCalled();
  });

  it('overview re-throws a database outage instead of rendering an empty overview', async () => {
    overviewHolder.getOverview = async () => { throw DB_DOWN(); };
    const { service } = build();
    const press = mkButton('overview:next:0:user1:weekly');

    await expect(service.handle(press)).rejects.toSatisfy(isSourceUnavailable);

    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });

  it.each(PREFIX_READS)('%s still degrades a genuine query failure to the unchanged message', async (prefix, read) => {
    // The other half of the pair. Narrowing the catch to `isSourceUnavailable`
    // must not have turned an ordinary driver failure into a raised one: the
    // page cannot be built, so leaving the card where it was IS the right
    // answer, and this is what proves the re-throw is narrow rather than
    // blanket.
    const { service } = build({
      lastfmRepository: { [read]: vi.fn(async () => { throw new Error("Can't reach database server"); }) },
    });
    const press = mkButton(`${prefix}:next:0:user1:weekly`);

    await expect(service.handle(press)).resolves.toBeUndefined();

    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it.each(PREFIX_READS)('%s still renders empty when the read ran and returned nothing', async (prefix, read, builder) => {
    // The honest empty: the source ANSWERED, with no rows. A source that ran
    // and found nothing is a legitimate answer and must reach the builder,
    // otherwise the fix above would have made "no plays in this period"
    // indistinguishable from "Last.fm is down".
    const { service } = build({
      lastfmRepository: { [read]: vi.fn(async () => []) },
    });
    const press = mkButton(`${prefix}:next:0:user1:weekly`);

    await expect(service.handle(press)).resolves.toBeUndefined();

    expect(TopBuilders[builder]).toHaveBeenCalledTimes(1);
    expect(TopBuilders[builder]).toHaveBeenCalledWith(
      expect.anything(), 'user1', 'user1', [], expect.anything(), 0, 0xff0000,
    );
    expect(press.update).toHaveBeenCalledTimes(1);
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });

  it('overview still renders when getOverview ran and returned no daily blocks', async () => {
    // `{ dailyBlocks: [] }` is the shape `overviewService.getOverview` itself
    // returns for a genuine absence, so this is the real empty, not a stub of
    // one.
    overviewHolder.getOverview = async () => ({ dailyBlocks: [] });
    const { service } = build();
    const press = mkButton('overview:next:0:user1:weekly');

    await expect(service.handle(press)).resolves.toBeUndefined();

    expect(press.update).toHaveBeenCalledTimes(1);
  });
});
