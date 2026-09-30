/**
 * `UserEventHandler` — the two membership listeners.
 *
 * This file has no test at all, and it is a small one that a guild admin
 * interacts with constantly: every join and every leave fires it, it reads the
 * user table to find out whether the joining member is one of ours, and it does
 * database work on a member event where there is no caller waiting.
 *
 * The four behaviours worth pinning are all about what it does NOT do:
 *   - an unknown member writes nothing at all (no membership row invented for a
 *     stranger who joined the server);
 *   - a failed lookup does not become an unhandled rejection, which on this
 *     event would be a FATAL process error for one person's join;
 *   - the lookup is by DISCORD id, not by Last.fm name, so one Discord account
 *     cannot be linked to two users;
 *   - the add and the remove paths are opposites, and a removal for a member we
 *     never linked is a no-op rather than a delete of somebody else's row.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { UserEventHandler } from './userEventHandler';
import { Events } from 'discord.js';
import type { Client } from 'discord.js';
import type { UserService } from '@bot/services/userService';
import type { GuildUserService } from '@bot/services/guild/guildUserService';

type Listener = (...args: never[]) => unknown;

interface MemberDouble {
  id: string;
  guild: { id: string };
}

const build = (over: { userService?: object; guildUserService?: object } = {}) => {
  const listeners = new Map<string, Listener>();
  // The spy IS the client's `on`, so "subscribed exactly once" is asserted against
  // the calls the handler actually made rather than against a second, dead copy.
  const on = vi.fn((event: string, cb: Listener) => {
    listeners.set(event, cb);
  });
  const client = { on } as unknown as Client;

  const getUserByDiscordId = vi.fn(async (..._args: unknown[]) => ({ userId: 42, userNameLastFm: 'listener' }));
  const ensureUserInGuild = vi.fn(async (..._args: unknown[]) => undefined);
  const removeUserFromGuild = vi.fn(async (..._args: unknown[]) => undefined);
  const userService = { getUserByDiscordId, ...(over.userService as object) } as unknown as UserService;
  const guildUserService = {
    ensureUserInGuild,
    removeUserFromGuild,
    ...(over.guildUserService as object),
  } as unknown as GuildUserService;

  new UserEventHandler(client, userService, guildUserService);
  return { listeners, on, getUserByDiscordId, ensureUserInGuild, removeUserFromGuild };
};

const fire = (listeners: Map<string, Listener>, event: string, member: MemberDouble): unknown =>
  listeners.get(event)?.(...([member] as never[]));

/**
 * Fires a membership listener and reports any unhandled rejection it produced.
 * The listener is `void this.handleMemberAdd(member)`, so the `.catch` inside is
 * the only thing between a failed lookup and a FATAL process error, and the only
 * way to see it work is a process-level listener.
 */
const fireAndDrainUnhandled = async (
  listeners: Map<string, Listener>,
  event: string,
  member: MemberDouble,
): Promise<unknown[]> => {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    fire(listeners, event, member);
    await new Promise(resolve => setTimeout(resolve, 10));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen;
};

const member = (id = 'discord-1', guildId = 'g-1'): MemberDouble => ({ id, guild: { id: guildId } });

describe('UserEventHandler subscriptions', () => {
  it('subscribes to the two membership events and nothing else', () => {
    const { listeners, on } = build();
    expect([...listeners.keys()].sort()).toEqual([Events.GuildMemberAdd, Events.GuildMemberRemove].sort());
    expect(on).toHaveBeenCalledTimes(2);
  });
});

describe('UserEventHandler on member join', () => {
  it('links a known member into the guild by the looked-up user id', async () => {
    const { listeners, getUserByDiscordId, ensureUserInGuild } = build();
    await fireAndDrainUnhandled(listeners, Events.GuildMemberAdd, member());

    expect(getUserByDiscordId).toHaveBeenCalledWith('discord-1');
    expect(ensureUserInGuild).toHaveBeenCalledWith('g-1', 42);
  });

  it('writes no membership row for a member who is not one of ours', async () => {
    // A stranger joined the server. Inventing a `guild_user` row for them would
    // be a claim the bot has a listening relationship with them.
    const { listeners, ensureUserInGuild } = build({ userService: { getUserByDiscordId: vi.fn(async () => null) } });
    await fireAndDrainUnhandled(listeners, Events.GuildMemberAdd, member());
    expect(ensureUserInGuild).not.toHaveBeenCalled();
  });

  it('looks the member up by Discord id, never by Last.fm name', async () => {
    const { listeners, getUserByDiscordId } = build();
    await fireAndDrainUnhandled(listeners, Events.GuildMemberAdd, member('discord-9', 'g-4'));
    const call = getUserByDiscordId.mock.calls[0]?.[0];
    expect(call).toBe('discord-9');
    expect(String(call)).not.toContain('listener');
  });

  it('does not raise when the user lookup fails', async () => {
    const { listeners } = build({
      userService: { getUserByDiscordId: vi.fn(async () => Promise.reject(new Error('connection terminated'))) },
    });
    const seen = await fireAndDrainUnhandled(listeners, Events.GuildMemberAdd, member());
    expect(seen).toEqual([]);
  });

  it('does not raise when the membership write fails', async () => {
    const { listeners } = build({
      guildUserService: { ensureUserInGuild: vi.fn(async () => Promise.reject(new Error('unique violation'))) },
    });
    const seen = await fireAndDrainUnhandled(listeners, Events.GuildMemberAdd, member());
    expect(seen).toEqual([]);
  });

  it('returns nothing from the listener, because nothing is waiting on it', () => {
    const { listeners } = build();
    expect(fire(listeners, Events.GuildMemberAdd, member())).toBeUndefined();
  });
});

describe('UserEventHandler on member leave', () => {
  it('unlinks a known member by the looked-up user id', async () => {
    const { listeners, getUserByDiscordId, removeUserFromGuild } = build();
    await fireAndDrainUnhandled(listeners, Events.GuildMemberRemove, member());

    expect(getUserByDiscordId).toHaveBeenCalledWith('discord-1');
    expect(removeUserFromGuild).toHaveBeenCalledWith('g-1', 42);
  });

  it('deletes nothing for a member we never linked', async () => {
    const { listeners, removeUserFromGuild } = build({ userService: { getUserByDiscordId: vi.fn(async () => null) } });
    await fireAndDrainUnhandled(listeners, Events.GuildMemberRemove, member());
    expect(removeUserFromGuild).not.toHaveBeenCalled();
  });

  it('is the opposite of the add path: it never writes a row', async () => {
    const { listeners, ensureUserInGuild, removeUserFromGuild } = build();
    await fireAndDrainUnhandled(listeners, Events.GuildMemberRemove, member());
    expect(removeUserFromGuild).toHaveBeenCalledTimes(1);
    expect(ensureUserInGuild).not.toHaveBeenCalled();
  });

  it('does not raise when the lookup or the delete fails', async () => {
    const lookupFails = build({
      userService: { getUserByDiscordId: vi.fn(async () => Promise.reject(new Error('timeout'))) },
    });
    const deleteFails = build({
      guildUserService: { removeUserFromGuild: vi.fn(async () => Promise.reject(new Error('timeout'))) },
    });
    expect(await fireAndDrainUnhandled(lookupFails.listeners, Events.GuildMemberRemove, member())).toEqual([]);
    expect(await fireAndDrainUnhandled(deleteFails.listeners, Events.GuildMemberRemove, member())).toEqual([]);
  });
});

describe('UserEventHandler: the two events are independent', () => {
  it('does not let a failed join affect the next leave', async () => {
    const { listeners, removeUserFromGuild } = build({
      userService: {
        getUserByDiscordId: vi
          .fn()
          .mockRejectedValueOnce(new Error('transient'))
          .mockResolvedValueOnce({ userId: 42 }),
      },
    });

    await fireAndDrainUnhandled(listeners, Events.GuildMemberAdd, member());
    expect(removeUserFromGuild).not.toHaveBeenCalled();

    await fireAndDrainUnhandled(listeners, Events.GuildMemberRemove, member());
    expect(removeUserFromGuild).toHaveBeenCalledWith('g-1', 42);
  });
});
