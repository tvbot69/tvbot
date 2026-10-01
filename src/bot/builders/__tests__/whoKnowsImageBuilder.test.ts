import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { buildWhoKnowsImageResponse } from '@bot/builders/whoKnowsImageBuilder';
import type { WhoKnowsImageDeps } from '@bot/builders/whoKnowsImageDeps';
import type { ContextModel } from '@bot/models/contextModel';
import type { WhoKnowsUser } from '@bot/models/whoKnowsModels';

/**
 * Characterisation test for the WhoKnows image builder, and the proof that the
 * dependency-injection refactor was a no-op.
 *
 * WHY THIS EXISTS
 * ---------------
 * `whoKnowsImageBuilder.ts` is 429 lines and had **zero direct tests**. It called
 * `container.resolve` nineteen times with no declared dependencies, accepted
 * three options it ignored (one of them REQUIRED by the type), and wrote to the
 * database from inside a response builder. It was also the worst layering
 * violation in the codebase, and the quality review refused to refactor it
 * because nothing could prove a refactor had not changed the rendered card.
 *
 * This file was written FIRST, pinning the observable behaviour, which made the
 * refactor provable: the same assertions run before and after.
 *
 * It was also the proof the refactor was worth doing. The first version had to
 * mutate the global tsyringe container, because the container WAS the
 * function's ambient input. Now the test passes a `WhoKnowsImageDeps` object and
 * never touches global state - which is the entire point of the change, visible
 * in the diff rather than only in a commit message.
 *
 * WHAT IS PINNED
 * --------------
 *  - no generator means no image and a null return
 *  - a successful render returns a ResponseModel carrying the PNG
 *  - a generator that throws is swallowed and degrades to null, never bubbling
 *    into the command dispatcher
 *  - crownText is passed ONLY when footerExtra says crown/claimed/stolen
 *  - genres reach the generator as `tags` for Artist/Album but NOT for Track
 *  - the guild name becomes `location`, falling back to 'Server'
 */

const USERS: WhoKnowsUser[] = [
  { userId: 1, playcount: 150, lastFmUsername: 'alice', discordName: 'Alice', hasCrown: true },
  { userId: 2, playcount: 120, lastFmUsername: 'bob', discordName: 'Bob' },
  { userId: 3, playcount: 90, lastFmUsername: 'carol', discordName: 'Carol' },
  { userId: 4, playcount: 45, lastFmUsername: 'dave', discordName: 'Dave' },
];

/** PNG magic bytes, so a "valid render" claim means the real file format. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
    '05fe02fea7b1c1e40000000049454e44ae426082',
  'hex',
);

const makeContext = (guildName?: string) =>
  ({
    guildId: 'g-1',
    discordUserId: 'd-1',
    guild: guildName === undefined ? undefined : { name: guildName },
  }) as unknown as ContextModel;

interface Overrides {
  /** `null` means "this context has no guild", which is not the same as a default. */
  guildName?: string | null;
  type?: 'Artist' | 'Track' | 'Album';
  genres?: string[];
  footerExtra?: string;
  thumbnailUrl?: string | null;
}

const call = (overrides: Overrides = {}, deps: WhoKnowsImageDeps = NO_DEPS) =>
  buildWhoKnowsImageResponse(
    {
      context: makeContext(
        overrides.guildName === undefined ? 'Test Guild' : (overrides.guildName ?? undefined),
      ),
      title: 'Radiohead',
      url: 'https://www.last.fm/music/Radiohead',
      thumbnailUrl:
        overrides.thumbnailUrl === undefined ? 'https://img.test/rh.jpg' : overrides.thumbnailUrl,
      users: USERS,
      resolvedAccent: 0x00ff00,
      type: overrides.type ?? 'Artist',
      requestedUserId: 1,
      footerExtra: overrides.footerExtra,
      genres: overrides.genres,
      metadata: { globalPlays: 999, globalListeners: 12 },
    },
    deps,
  );

/** Every collaborator absent - the shape of a partially built container. */
const NO_DEPS: WhoKnowsImageDeps = {
  generator: null,
  artistsService: null,
  albumService: null,
  artworkService: null,
  userService: null,
  spotifyApi: null,
  deezerApi: null,
  coverIndexer: null,
};

/**
 * Build deps around a stub generator and hand back the mock so its arguments can
 * be asserted. No global state is touched, which is the whole improvement over
 * the first version of this file.
 */
const depsWith = (
  impl: (args: Record<string, unknown>) => Promise<Buffer>,
): { deps: WhoKnowsImageDeps; generate: ReturnType<typeof vi.fn> } => {
  const generate = vi.fn(impl);
  return {
    deps: { ...NO_DEPS, generator: { generateWhoKnowsImage: generate } as never },
    generate,
  };
};

describe('whoKnowsImageBuilder (characterisation)', () => {
  it('returns null and renders nothing when no generator is registered', async () => {
    // The old test had to assert on the container here; now absence is just a null field.
    expect(await call({}, NO_DEPS)).toBeNull();
  });

  it('returns a ResponseModel carrying the PNG on a successful render', async () => {
    const { deps, generate } = depsWith(async () => PNG);

    const response = await call({}, deps);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(response).not.toBeNull();
    expect(response?.fileName).toBe('whoknows.png');
    expect(response?.fileBuffer?.equals(PNG)).toBe(true);
  });

  it('degrades to null when the generator throws, never bubbling into the command', async () => {
    // The builder wraps generation in try/catch and logs at error. A throw here
    // reaching the dispatcher would fail a user-visible command because a
    // background image render failed.
    const { deps } = depsWith(async () => {
      throw new Error('chrome exploded');
    });
    expect(await call({}, deps)).toBeNull();
  });

  it('passes crownText only when footerExtra mentions a crown', async () => {
    const withCrown = depsWith(async () => PNG);
    await call({ footerExtra: 'Holds the crown for Radiohead' }, withCrown.deps);
    expect(withCrown.generate.mock.calls[0]![0].crownText).toBe('Holds the crown for Radiohead');

    const withoutCrown = depsWith(async () => PNG);
    await call({ footerExtra: 'just a footer' }, withoutCrown.deps);
    expect(withoutCrown.generate.mock.calls[0]![0].crownText).toBeUndefined();
  });

  it('sends genres as tags for Artist and Album but not for Track', async () => {
    const artist = depsWith(async () => PNG);
    await call({ type: 'Artist', genres: ['rock', 'art rock'] }, artist.deps);
    expect(artist.generate.mock.calls[0]![0].tags).toEqual(['rock', 'art rock']);

    const album = depsWith(async () => PNG);
    await call({ type: 'Album', genres: ['rock'] }, album.deps);
    expect(album.generate.mock.calls[0]![0].tags).toEqual(['rock']);

    const track = depsWith(async () => PNG);
    await call({ type: 'Track', genres: ['rock'] }, track.deps);
    expect(track.generate.mock.calls[0]![0].tags).toBeUndefined();
  });

  it('uses the guild name as location and falls back to Server', async () => {
    const named = depsWith(async () => PNG);
    await call({ guildName: 'The Listening Room' }, named.deps);
    expect(named.generate.mock.calls[0]![0].location).toBe('The Listening Room');

    const anonymous = depsWith(async () => PNG);
    await call({ guildName: null }, anonymous.deps);
    expect(anonymous.generate.mock.calls[0]![0].location).toBe('Server');
  });

  it('forwards the caller identity and the leaderboard unchanged', async () => {
    const { deps, generate } = depsWith(async () => PNG);
    await call({}, deps);
    const args = generate.mock.calls[0]![0] as Record<string, unknown>;

    expect(args.type).toBe('Who Knows Artist');
    expect(args.title).toBe('Radiohead');
    expect(args.users).toBe(USERS);
    expect(args.callerUserId).toBe(1);
    expect(args.callerDiscordId).toBe('d-1');
    expect(args.globalPlays).toBe(999);
    expect(args.globalListeners).toBe(12);
  });
});
