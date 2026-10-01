/**
 * `PrefixService.getPrefix` and the database outage it used to hide.
 *
 * The bug: `getPrefix` was `try { ... } catch { return this.defaultPrefix }`.
 * In a guild whose configured prefix is `!`, a database outage therefore
 * answered `!foo` with "Unknown command `.foo`" - a confident wrong answer at
 * the very top of the text path, naming a prefix the user never typed, and
 * giving them no way to tell a missing command from a missing prefix. Nothing
 * was logged either, so the reply was indistinguishable from a typo in the log
 * as well as on screen.
 *
 * The fix raises `SourceUnavailableError` and lets the text-command boundary
 * name the source. The pair is the point of the file:
 *
 *   the query raised  -> raises, names the query, and does NOT answer '.'
 *   the query answered null -> '.', because that guild genuinely has no custom
 *                              prefix. A missing row is a real answer, and
 *                              collapsing it with the outage is the same bug
 *                              in the other direction.
 *
 * The same distinction is asserted for a guild id that is not a snowflake:
 * `GuildRepository.getGuild` returns `null` for one (it guards with `/^\d+$/`
 * before `BigInt`), so that is an answer too, and it must not be laundered
 * into "the database is down" - which would tell the caller to retry something
 * that can never succeed.
 *
 * Doubles are fresh plain objects per test; nothing is spied on.
 */
import { describe, it, expect, vi } from 'vitest';
import { PrefixService } from '@bot/services/user/prefixService';
import { isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import type { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import type { CacheService } from '@bot/services/system/cacheService';
import type { GuildRepository } from '@persistence/repositories/guildRepository';

/** `ConfigData.Data.bot.prefix` is `BOT_PREFIX ?? '.'`, so this is the default. */
const DEFAULT_PREFIX = '.';

/** Capture a rejection as the settled result, so both its shape and type can be asserted. */
const settle = async (p: Promise<string>) =>
  p.then((value) => ({ ok: true as const, value }), (err: unknown) => ({ ok: false as const, err }));

const build = (getGuild: (guildId: string) => Promise<unknown>) => {
  const get = vi.fn(async (_key: string): Promise<string | null> => null);
  const set = vi.fn(async (_key: string, _value: string, _ttl?: number): Promise<void> => undefined);
  const deleteKey = vi.fn(async (_key: string): Promise<void> => undefined);
  const cache = { get, set, delete: deleteKey } as unknown as CacheService;
  const getGuildMock = vi.fn(getGuild);
  const guildRepository = { getGuild: getGuildMock } as unknown as GuildRepository;
  const service = new PrefixService(cache, guildRepository);
  return { service, get, set, getGuild: getGuildMock };
};

describe('PrefixService.getPrefix', () => {
  it('raises rather than inventing the default prefix when the query fails', async () => {
    // The failure half. A raised `SourceUnavailableError` is what lets
    // `commandHandler` say "Could not reach the database"; returning '.' is
    // what produced "Unknown command `.foo`" in a `!` guild.
    const { service, get } = build(async () => {
      throw new Error('connection terminated unexpectedly');
    });

    const settled = await settle(service.getPrefix('1445761601129943222'));

    expect(settled.ok).toBe(false);
    if (settled.ok) throw new Error('unreachable');
    // The typed signal itself, not just "it threw": a bare Error would still
    // produce a confident wrong answer at the boundary.
    expect(isSourceUnavailable(settled.err)).toBe(true);
    // The read was really attempted, so this cannot pass without reaching the
    // repository.
    expect(get).toHaveBeenCalledWith('prefix:1445761601129943222');
  });

  it('names the query in the error, so a log reader can tell which read failed', async () => {
    // `SourceUnavailableError.method` is the field the boundaries use to say
    // what was unreachable, and the label carries the guild. Without both, a
    // "Could not reach the database" in a busy channel is unactionable.
    const { service } = build(async () => {
      throw new Error('connection terminated unexpectedly');
    });

    const settled = await settle(service.getPrefix('1445761601129943222'));

    if (settled.ok) throw new Error('unreachable');
    const err = settled.err as SourceUnavailableError;
    expect(err.method).toContain('prefixService.getPrefix');
    expect(err.method).toContain('1445761601129943222');
    // The original cause is kept, so the log line can show the driver error.
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('returns the guild\u2019s configured prefix when the row exists', async () => {
    // The ordinary path, so "always raise" cannot pass.
    const { service } = build(async () => ({ prefix: '!' }));

    await expect(service.getPrefix('1445761601129943222')).resolves.toBe('!');
  });

  it('returns the default prefix when the guild answered that it has none', async () => {
    // The PAIR's honest-empty half. A missing row is a real answer - that guild
    // really does use the default prefix. Collapsing this with the outage is the
    // same bug pointed the other way, and it would also make every correct
    // `.`-guild look like an outage.
    const { service, set } = build(async () => null);

    await expect(service.getPrefix('1445761601129943222')).resolves.toBe(DEFAULT_PREFIX);
    // And it is cached, so a later healthy read does not hit the database.
    expect(set).toHaveBeenCalledWith('prefix:1445761601129943222', DEFAULT_PREFIX, expect.any(Number));
  });

  it('returns the default prefix for a guild id that is not a snowflake', async () => {
    // `GuildRepository.getGuild` guards with `/^\d+$/` and returns `null`
    // before it ever reaches `BigInt`, so a malformed id is an ANSWER. Wrapping
    // it in the outage path would tell the caller to retry a request that can
    // never succeed.
    const { service } = build(async () => null);

    await expect(service.getPrefix('not-a-snowflake')).resolves.toBe(DEFAULT_PREFIX);
  });

  it('answers from the cache without touching the database at all', async () => {
    // `CacheService.get` is already the memory-first path, so a cached prefix
    // is served even while the database is down. This is why the raise is
    // scoped to the repository read and not to the whole method.
    const { service, get } = build(async () => {
      throw new Error('connection terminated unexpectedly');
    });
    get.mockResolvedValueOnce('!');

    await expect(service.getPrefix('1445761601129943222')).resolves.toBe('!');
  });

  it('answers from the default without any read for a DM, where there is no guild', async () => {
    // Not a failure and not a query: there is nothing to ask. The raise must
    // not extend this far, or every DM would report an outage.
    const { service, get } = build(async () => {
      throw new Error('connection terminated unexpectedly');
    });

    await expect(service.getPrefix(null)).resolves.toBe(DEFAULT_PREFIX);
    expect(get).not.toHaveBeenCalled();
  });
});
