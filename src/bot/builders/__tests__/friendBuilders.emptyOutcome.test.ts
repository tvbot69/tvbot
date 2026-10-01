import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { FriendBuilders } from '../friendBuilders';
import { FriendType } from '@domain/enums/friendType';
import type { ContextModel } from '@bot/models/contextModel';

/**
 * `buildAddFriendsResultResponse` is a report of an outcome, and it only knows
 * three of them: added, not found, already on the list. Handed three empty lists
 * it had nothing to print, and `TextDisplayBuilder.setContent('')` throws
 * "Invalid string length" inside discord.js - so the caller crashed while
 * building a reply instead of sending one.
 *
 * That was unreachable until the `.addfriends` loop learned to file a Last.fm
 * outage separately from a "no such user": every argument used to land in
 * exactly one of the three buckets, so the empty case could not arise. Three
 * arguments that all went into the new fourth bucket is the first way to get
 * there, which is why the builder is fixed here rather than only worked around
 * in the one caller.
 *
 * Note the second test: it fails if the guard is implemented by skipping the
 * whole response rather than the one empty line. "Build a card with no body" and
 * "build no card" are different repairs.
 */

const ctx = { accentColor: 0x00ff00 } as unknown as ContextModel;

const added = [{ name: 'alice', type: FriendType.Normal, friendId: 1 }];
const already = [{ name: 'bob', type: FriendType.CloseFriend, friendId: 2 }];

/** The concatenated text of every text-display component in the response. */
const bodyOf = (response: ReturnType<typeof FriendBuilders.buildAddFriendsResultResponse>): string => {
  const json = response.componentsV2Container?.toJSON() as
    | { components?: Array<{ type: number; content?: string }> }
    | undefined;
  return (json?.components ?? [])
    .map((c) => c.content ?? '')
    .join('\n');
};

describe('FriendBuilders.buildAddFriendsResultResponse — an empty outcome is not a crash', () => {
  it('does not throw when nothing was added, missing, or already present', () => {
    expect(() => FriendBuilders.buildAddFriendsResultResponse(ctx, [], [], [])).not.toThrow();
  });

  it('produces no text-display body in that case, rather than an empty one', () => {
    const response = FriendBuilders.buildAddFriendsResultResponse(ctx, [], [], []);

    expect(bodyOf(response)).toBe('');
  });

  it('still prints all three outcomes when there is something to say', () => {
    const body = bodyOf(FriendBuilders.buildAddFriendsResultResponse(ctx, added, ['ghost'], already));

    expect(body).toContain('alice');
    expect(body).toContain('ghost');
    expect(body).toContain('bob');
  });

  it('still prints a single outcome on its own, with no stray blank line', () => {
    const body = bodyOf(FriendBuilders.buildAddFriendsResultResponse(ctx, added, [], []));

    expect(body).toContain('alice');
    expect(body).not.toContain('Could not find');
    expect(body).not.toContain('Already on your friends list');
  });
});
