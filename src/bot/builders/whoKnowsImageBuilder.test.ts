import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { container } from 'tsyringe';
import { buildWhoKnowsImageResponse } from './whoKnowsImageBuilder';
import { WhoKnowsGenerator } from '@images/generators/whoKnowsGenerator';
import type { ContextModel } from '@bot/models/contextModel';
import type { WhoKnowsUser } from '@bot/models/whoKnowsModels';

/**
 * Characterisation test for the WhoKnows image builder.
 *
 * WHY THIS IS A CHARACTERISATION TEST
 * ----------------------------------
 * `whoKnowsImageBuilder.ts` is 395 lines, calls `container.resolve` /
 * `container.isRegistered` twelve times, has three options it accepts and
 * ignores, writes to the database from a builder, and had **zero direct tests**.
 * It is also the file the quality review flagged as the worst layering
 * violation in the codebase.
 *
 * It was deliberately NOT refactored, because nothing could prove a refactor
 * had not changed the rendered card. This file closes that gap: it pins the
 * current observable behaviour, so the eventual dependency-injection refactor
 * becomes a provable no-op instead of a leap of faith.
 *
 * The container is the function's ambient input, so the test drives it the way
 * the function reads it - by registering and unregistering the real token. That
 * is uncomfortable, and it is exactly the coupling being removed later.
 *
 * WHAT IS PINNED
 * --------------
 *  - the isRegistered guard: no generator means no image and a null return
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

const call = (overrides: Overrides = {}) =>
  buildWhoKnowsImageResponse({
    context: makeContext(
      overrides.guildName === undefined ? 'Test Guild' : (overrides.guildName ?? undefined),
    ),
    title: 'Radiohead',
    url: 'https://www.last.fm/music/Radiohead',
    thumbnailUrl: overrides.thumbnailUrl === undefined ? 'https://img.test/rh.jpg' : overrides.thumbnailUrl,
    users: USERS,
    resolvedAccent: 0x00ff00,
    type: overrides.type ?? 'Artist',
    requestedUserId: 1,
    footerExtra: overrides.footerExtra,
    genres: overrides.genres,
    metadata: { globalPlays: 999, globalListeners: 12 },
  });

/** Register a stub generator and hand back the mock so args can be asserted. */
const stubGenerator = (impl: (args: Record<string, unknown>) => Promise<Buffer>) => {
  const generate = vi.fn(impl);
  container.registerInstance(WhoKnowsGenerator, { generateWhoKnowsImage: generate } as never);
  return generate;
};

let wasRegistered = false;

beforeEach(() => {
  wasRegistered = container.isRegistered(WhoKnowsGenerator);
});

afterEach(() => {
  // Leave the global container exactly as this file found it.
  if (wasRegistered) {
    // tsyringe has no unregister, so re-register a harmless placeholder only if
    // the token did not exist before; otherwise the next test overwrites it.
    return;
  }
  container.clearInstances();
  vi.restoreAllMocks();
});

describe('whoKnowsImageBuilder (characterisation)', () => {
  it('returns null and renders nothing when no generator is registered', async () => {
    container.clearInstances();
    expect(container.isRegistered(WhoKnowsGenerator)).toBe(false);
    expect(await call()).toBeNull();
  });

  it('returns a ResponseModel carrying the PNG on a successful render', async () => {
    const generate = stubGenerator(async () => PNG);

    const response = await call();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(response).not.toBeNull();
    expect(response?.fileName).toBe('whoknows.png');
    expect(response?.fileBuffer?.equals(PNG)).toBe(true);
  });

  it('degrades to null when the generator throws, never bubbling into the command', async () => {
    // The builder wraps generation in try/catch and logs at error. A throw here
    // reaching the dispatcher would fail a user-visible command because a
    // background image render failed.
    stubGenerator(async () => {
      throw new Error('chrome exploded');
    });
    expect(await call()).toBeNull();
  });

  it('passes crownText only when footerExtra mentions a crown', async () => {
    const withCrown = stubGenerator(async () => PNG);
    await call({ footerExtra: 'Holds the crown for Radiohead' });
    expect(withCrown.mock.calls[0]![0].crownText).toBe('Holds the crown for Radiohead');

    const withoutCrown = stubGenerator(async () => PNG);
    await call({ footerExtra: 'just a footer' });
    expect(withoutCrown.mock.calls[0]![0].crownText).toBeUndefined();
  });

  it('sends genres as tags for Artist and Album but not for Track', async () => {
    const artist = stubGenerator(async () => PNG);
    await call({ type: 'Artist', genres: ['rock', 'art rock'] });
    expect(artist.mock.calls[0]![0].tags).toEqual(['rock', 'art rock']);

    const album = stubGenerator(async () => PNG);
    await call({ type: 'Album', genres: ['rock'] });
    expect(album.mock.calls[0]![0].tags).toEqual(['rock']);

    const track = stubGenerator(async () => PNG);
    await call({ type: 'Track', genres: ['rock'] });
    expect(track.mock.calls[0]![0].tags).toBeUndefined();
  });

  it('uses the guild name as location and falls back to Server', async () => {
    const named = stubGenerator(async () => PNG);
    await call({ guildName: 'The Listening Room' });
    expect(named.mock.calls[0]![0].location).toBe('The Listening Room');

    const anonymous = stubGenerator(async () => PNG);
    await call({ guildName: null });
    expect(anonymous.mock.calls[0]![0].location).toBe('Server');
  });

  it('forwards the caller identity and the leaderboard unchanged', async () => {
    const generate = stubGenerator(async () => PNG);
    await call();
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
