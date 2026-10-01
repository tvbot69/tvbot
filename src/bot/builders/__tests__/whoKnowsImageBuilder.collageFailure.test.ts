import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { buildWhoKnowsImageResponse } from '@bot/builders/whoKnowsImageBuilder';
import type { WhoKnowsImageDeps } from '@bot/builders/whoKnowsImageDeps';
import type { ContextModel } from '@bot/models/contextModel';
import type { WhoKnowsUser } from '@bot/models/whoKnowsModels';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';

/**
 * The four `// CORRECT AS IS` swallow sites in `whoKnowsImageBuilder`, pinned
 * so the decision is checkable rather than only claimed in a comment.
 *
 * WHAT IS BEING PINNED, AND WHY IT IS THE INTERESTING ASSERTION
 * ----------------------------------------------------------
 * Every one of those catches feeds the COLLAGE and the track-NAME list. The
 * figures a user could actually be misled by - the global scrobble count, the
 * global listener count, and every per-user playcount - never pass through
 * this file at all: they arrive on `args.metadata` and `args.users` from the
 * command layer, and this file only forwards them.
 *
 * So the assertion that matters is not "the card still renders" (it obviously
 * does - the existing characterisation test covers that) but the STRONGER one:
 * a source failure on every swallowed read must leave all three sets of real
 * numbers byte-for-byte correct. That is what makes "a missing tile is the
 * designed state" safe to say, and it is what would fail if someone later made
 * a decoration read feed a figure.
 *
 * These four sites are the same trade as `topBuilders` and `fmFooterResolver`:
 * an image has no "could not load" affordance, so raising would delete a real
 * card over its artwork rather than improve any statement on it.
 */

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
    '05fe02fea7b1c1e40000000049454e44ae426082',
  'hex',
);

const USERS: WhoKnowsUser[] = [
  { userId: 1, playcount: 150, lastFmUsername: 'alice', discordName: 'Alice' },
  { userId: 2, playcount: 120, lastFmUsername: 'bob', discordName: 'Bob' },
];

const GLOBAL_PLAYS = 987_654;
const GLOBAL_LISTENERS = 4321;

const ctx = { guildId: 'g-1', discordUserId: 'd-1', guild: { name: 'Test Guild' } } as unknown as ContextModel;

const sourceDown = () =>
  new SourceUnavailableError('whoKnowsImageBuilder:collage', new Error('connection reset'), 'Database unavailable');

const call = (deps: WhoKnowsImageDeps, metadata: Record<string, unknown> = { globalPlays: GLOBAL_PLAYS, globalListeners: GLOBAL_LISTENERS }) =>
  buildWhoKnowsImageResponse(
    {
      context: ctx,
      title: 'Radiohead',
      url: 'https://www.last.fm/music/Radiohead',
      thumbnailUrl: 'https://img.test/rh.jpg',
      users: USERS,
      resolvedAccent: 0x00ff00,
      type: 'Artist',
      requestedUserId: 1,
      metadata: metadata as never,
    },
    deps,
  );

/**
 * A generator stub plus collaborators that ALL raise the deliberate source
 * error, so every swallow site in the file is exercised at once.
 */
const allReadsDown = () => {
  const generate = vi.fn(async (..._args: unknown[]) => PNG);
  const raise = async () => { throw sourceDown(); };
  return {
    generate,
    deps: {
      generator: { generateWhoKnowsImage: generate } as never,
      albumService: { getTopTracksForAlbum: vi.fn(raise) } as never,
      artistsService: {
        getTopAlbumsForArtist: vi.fn(raise),
        getTopTracksForArtist: vi.fn(raise),
        getTopTracksForArtistGlobal: vi.fn(raise),
        getTopAlbumsForArtistGlobal: vi.fn(raise),
        getIndexedAlbumCoversForArtist: vi.fn(raise),
      } as never,
      artworkService: {} as never,
      userService: null,
      spotifyApi: { getArtistDiscographyCovers: vi.fn(raise) } as never,
      deezerApi: { searchAlbums: vi.fn(raise) } as never,
      coverIndexer: null,
    } satisfies WhoKnowsImageDeps,
  };
};

describe('whoKnowsImageBuilder - decoration reads are allowed to fail, figures are not', () => {
  it('still renders the card when every swallowed source read raises', async () => {
    const { deps } = allReadsDown();

    const response = await call(deps);

    expect(response).not.toBeNull();
    expect(response?.fileName).toBe('whoknows.png');
  });

  it('leaves every real figure exactly as it arrived, byte for byte', async () => {
    // The load-bearing assertion. None of these numbers is computed here, so a
    // failure anywhere in this file must not perturb a single one of them.
    const { deps, generate } = allReadsDown();

    await call(deps);
    const args = generate.mock.calls[0]![0] as Record<string, unknown>;

    expect(args.globalPlays).toBe(GLOBAL_PLAYS);
    expect(args.globalListeners).toBe(GLOBAL_LISTENERS);
    expect(args.users).toBe(USERS);
    expect(USERS.map((u) => u.playcount)).toEqual([150, 120]);
  });

  it('omits the track-name list rather than inventing a top track', async () => {
    // The alternative failure mode would be substituting a plausible name.
    // The designed state is an absent row, and the generator treats a missing
    // `topTracks`/`topItemValue` by omitting the row, so nothing is claimed.
    const { deps, generate } = allReadsDown();

    await call(deps);
    const args = generate.mock.calls[0]![0] as Record<string, unknown>;

    expect(args.topTracks).toBeUndefined();
    expect(args.topItemValue).toBeUndefined();
  });

  it('drops the mosaic rather than rendering a half-populated one', async () => {
    const { deps, generate } = allReadsDown();

    await call(deps);
    const args = generate.mock.calls[0]![0] as Record<string, unknown>;

    // `backgroundCovers` stays undefined, and the generator substitutes its own
    // single placeholder tile for the whole mosaic. Partial coverage is not
    // asserted against here because tile rendering belongs to the generator.
    expect(args.backgroundCovers).toBeUndefined();
  });

  it('forwards an ABSENT global figure as absent, never as a zero', async () => {
    // Added because mutation 7 slipped through. A `?? 0` on this passthrough is
    // the classic figure-forging bug, and the first version of this file could
    // not see it: every other test supplies both figures, so the `undefined`
    // path was never executed and the mutation was unreachable. A test that
    // cannot fail is decoration, and the only cure is a case that exercises the
    // branch the mutation touches.
    const { deps, generate } = allReadsDown();

    await call(deps, {});
    const args = generate.mock.calls[0]![0] as Record<string, unknown>;

    expect(args.globalPlays).toBeUndefined();
    expect(args.globalListeners).toBeUndefined();
    // And the card still renders, so "absent" degrades to an omitted figure
    // rather than to a crash or a substituted number.
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('forwards real track names when the reads succeed, proving the failures above were the cause', async () => {
    const generate = vi.fn(async (..._args: unknown[]) => PNG);
    const deps = {
      generator: { generateWhoKnowsImage: generate } as never,
      albumService: null,
      artistsService: {
        getTopAlbumsForArtist: vi.fn(async () => []),
        getTopTracksForArtist: vi.fn(async () => [{ name: 'Weird Fishes' }]),
        getTopTracksForArtistGlobal: vi.fn(async () => [{ name: 'Reckoner' }]),
        getTopAlbumsForArtistGlobal: vi.fn(async () => []),
        getIndexedAlbumCoversForArtist: vi.fn(async () => []),
      } as never,
      artworkService: {} as never,
      userService: null,
      spotifyApi: null,
      deezerApi: null,
      coverIndexer: null,
    } satisfies WhoKnowsImageDeps;

    await call(deps);
    const args = generate.mock.calls[0]![0] as Record<string, unknown>;

    expect(args.topTracks).toEqual(['Weird Fishes', 'Reckoner']);
    expect(args.topItemValue).toBe('Weird Fishes');
  });
});
