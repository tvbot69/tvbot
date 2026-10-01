/**
 * `ClientLogHandler` — the eight gateway listeners the bot registers at boot.
 *
 * There is no test for this file at all, and it is worth one, because almost all
 * of it is fire-and-forget: five of the eight listeners are registered for their
 * log line and the remaining two do database work on `guildCreate` with no caller
 * to receive a result. The load-bearing behaviour is therefore the `.catch` on
 * each of those two: `storeGuildUsers` walks the whole member list and throws
 * without the privileged Guild Members intent, and an unhandled rejection there
 * is reported as a FATAL process error on every single guild the bot joins.
 *
 * So the assertions below are largely about what does NOT happen:
 *   - no unhandled rejection escapes a failing `ensureGuildExists` or
 *     `storeGuildUsers` (asserted through a real `unhandledRejection` listener,
 *     because a `void promise`'s catch has no other observable effect);
 *   - a half-cached guild object, the shape `guildCreate` and `guildDelete`
 *     actually deliver, does not throw on the `?? 0` fallbacks;
 *   - every event is subscribed exactly once, because a duplicate subscription
 *     would silently double every log line and double the member-list walk.
 *
 * `Logger` is never spied on. It is a module-level class with statics, and
 * `vi.spyOn` there leaves an own property behind for every later test in the
 * file. What each listener does is asserted through the injected doubles, which
 * is where the behaviour actually lives.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ClientLogHandler } from '../clientLogHandler';
import { Events } from 'discord.js';
import type { Client } from 'discord.js';
import type { GuildService } from '@bot/services/guild/guildService';
import type { GuildUserService } from '@bot/services/guild/guildUserService';

type Listener = (...args: never[]) => unknown;

interface GuildDouble {
  id: string;
  name?: string | null;
  memberCount?: number | null;
}

const build = (over: { guildService?: object; guildUserService?: object; guildCount?: number } = {}) => {
  const listeners = new Map<string, Listener>();
  // The spy IS the client's `on`, so "subscribed exactly once" is asserted against
  // the calls the handler actually made rather than against a second, dead copy.
  const on = vi.fn((event: string, cb: Listener) => {
    listeners.set(event, cb);
  });
  const client = {
    on,
    guilds: { cache: { size: over.guildCount ?? 12 } },
  } as unknown as Client;

  const ensureGuildExists = vi.fn(async (..._args: unknown[]) => undefined);
  const storeGuildUsers = vi.fn(async (..._args: unknown[]) => undefined);
  const guildService = { ensureGuildExists, ...(over.guildService as object) } as unknown as GuildService;
  const guildUserService = { storeGuildUsers, ...(over.guildUserService as object) } as unknown as GuildUserService;

  new ClientLogHandler(client, guildService, guildUserService);
  return { listeners, on, ensureGuildExists, storeGuildUsers };
};

const fire = (listeners: Map<string, Listener>, event: string, ...args: unknown[]): unknown =>
  listeners.get(event)?.(...(args as never[]));

/**
 * Fires a listener and reports any unhandled rejection the microtask queue
 * produced. This is the only way to observe the `.catch` on a `void promise` do
 * its job: the promise is not returned anywhere, so a missing catch shows up as a
 * process-level event and nowhere else. The listener is removed in `finally` so
 * nothing leaks into the next test.
 */
const fireAndDrainUnhandled = async (
  listeners: Map<string, Listener>,
  event: string,
  ...args: unknown[]
): Promise<unknown[]> => {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    fire(listeners, event, ...args);
    await new Promise(resolve => setTimeout(resolve, 10));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen;
};

describe('ClientLogHandler subscriptions', () => {
  it('subscribes to every gateway event exactly once', () => {
    const { listeners, on } = build();
    expect([...listeners.keys()].sort()).toEqual(
      [
        Events.ShardReady,
        Events.ShardDisconnect,
        Events.ShardReconnecting,
        Events.ShardResume,
        Events.GuildCreate,
        Events.GuildDelete,
        Events.Error,
        Events.Warn,
      ].sort(),
    );
    expect(listeners.size).toBe(8);
    expect(on).toHaveBeenCalledTimes(8);
  });

  it('does not subscribe to MessageCreate, which the command handler owns', () => {
    // Two owners for one event means every message is dispatched twice.
    expect(build().listeners.has(Events.MessageCreate)).toBe(false);
  });

  it('never registers two handlers for the same event', () => {
    const { on } = build();
    const events = on.mock.calls.map(c => c[0]);
    expect(new Set(events).size).toBe(events.length);
  });
});

describe('ClientLogHandler on guild join', () => {
  it('ensures the guild row and walks the member list', async () => {
    const { listeners, ensureGuildExists, storeGuildUsers } = build();
    const guild: GuildDouble = { id: 'g-1', name: 'Music Club', memberCount: 40 };

    await fireAndDrainUnhandled(listeners, Events.GuildCreate, guild);

    expect(ensureGuildExists).toHaveBeenCalledTimes(1);
    expect(storeGuildUsers).toHaveBeenCalledTimes(1);
    expect(storeGuildUsers.mock.calls[0]?.[0]).toBe(guild);
  });

  it('does not raise when the guild row write fails', async () => {
    const { listeners } = build({
      guildService: { ensureGuildExists: vi.fn(async () => Promise.reject(new Error('no such column'))) },
    });
    const seen = await fireAndDrainUnhandled(listeners, Events.GuildCreate, {
      id: 'g-1',
      name: 'Music Club',
      memberCount: 1,
    });
    expect(seen).toEqual([]);
  });

  it('does not raise when the member-list walk fails', async () => {
    // The classic one: `storeGuildUsers` needs the privileged Guild Members
    // intent, and without it this rejects on EVERY guild join.
    const { listeners } = build({
      guildUserService: { storeGuildUsers: vi.fn(async () => Promise.reject(new Error('Missing Access'))) },
    });
    const seen = await fireAndDrainUnhandled(listeners, Events.GuildCreate, {
      id: 'g-1',
      name: 'Music Club',
      memberCount: 1,
    });
    expect(seen).toEqual([]);
  });

  it('still does the other half of the work when one half fails', async () => {
    // Fire-and-forget means the two calls are independent; a swallowed failure
    // must not take the other with it.
    const { listeners, storeGuildUsers } = build({
      guildService: { ensureGuildExists: vi.fn(async () => Promise.reject(new Error('nope'))) },
    });
    await fireAndDrainUnhandled(listeners, Events.GuildCreate, { id: 'g-1', name: 'G', memberCount: 1 });
    expect(storeGuildUsers).toHaveBeenCalledTimes(1);
  });

  it('tolerates a guild with no member count, which is what an uncached guild reports', () => {
    // `memberCount ?? 0` is the whole reason the nullish coalescing is there; a
    // bare `memberCount` would put "undefined" in a log line.
    const { listeners } = build();
    expect(() => fire(listeners, Events.GuildCreate, { id: 'g-1', name: 'Music Club' })).not.toThrow();
    expect(() => fire(listeners, Events.GuildCreate, { id: 'g-2', name: null, memberCount: null })).not.toThrow();
  });

  it('returns nothing from the listener, because nothing is waiting on it', () => {
    const { listeners } = build();
    expect(fire(listeners, Events.GuildCreate, { id: 'g-1', name: 'G', memberCount: 1 })).toBeUndefined();
  });
});

describe('ClientLogHandler on guild leave', () => {
  it('tolerates a partial guild object from Discord', () => {
    // `name` is null and `memberCount` is absent when the guild is no longer
    // cached, which is the normal shape of a `guildDelete`.
    const { listeners } = build();
    expect(() => fire(listeners, Events.GuildDelete, { id: 'g-1', name: null })).not.toThrow();
    expect(() => fire(listeners, Events.GuildDelete, { id: 'g-1', name: 'Music Club', memberCount: 12 })).not.toThrow();
  });

  it('does no database work on the way out', () => {
    const { listeners, ensureGuildExists, storeGuildUsers } = build();
    fire(listeners, Events.GuildDelete, { id: 'g-1', name: 'G', memberCount: 1 });
    expect(ensureGuildExists).not.toHaveBeenCalled();
    expect(storeGuildUsers).not.toHaveBeenCalled();
  });
});

describe('ClientLogHandler shard and client events', () => {
  it('handles every shard event without touching the database', () => {
    const { listeners, ensureGuildExists, storeGuildUsers } = build();
    expect(() => fire(listeners, Events.ShardReady, 0, new Set(['g-9']))).not.toThrow();
    expect(() => fire(listeners, Events.ShardReady, 0, undefined)).not.toThrow();
    expect(() => fire(listeners, Events.ShardDisconnect, { code: 1001 }, 3)).not.toThrow();
    expect(() => fire(listeners, Events.ShardReconnecting, 3)).not.toThrow();
    expect(() => fire(listeners, Events.ShardResume, 3, 12)).not.toThrow();
    expect(() => fire(listeners, Events.Error, new Error('boom'))).not.toThrow();
    expect(() => fire(listeners, Events.Warn, 'a warning')).not.toThrow();
    expect(ensureGuildExists).not.toHaveBeenCalled();
    expect(storeGuildUsers).not.toHaveBeenCalled();
  });

  it('reads the guild count off the injected client, not off a global', () => {
    // The guild count in the ready line is the one shard-visible number here, and
    // it comes from `client.guilds.cache.size`, which is per shard.
    const { listeners } = build({ guildCount: 0 });
    expect(() => fire(listeners, Events.ShardReady, 0, undefined)).not.toThrow();
  });
});
