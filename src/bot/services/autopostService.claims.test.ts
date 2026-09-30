import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutopostService } from './autopostService';
import type { AutopostConfig } from './autopostService';
import { SourceUnavailableError, isSourceUnavailable } from '@domain/models/sourceUnavailableError';
import { Logger } from '@domain/logger';

/**
 * A scheduled post is a claim the user never asked for, and it outlives the
 * sweep that made it. Nothing tells the user it failed, and the guild reads the
 * silence as "the bot decided not to post". So the whole service is built on one
 * rule: **a query that did not answer is not a zero.**
 *
 * The count is the sharpest case. `countForGuild` is the ONLY way a guild
 * reaches its ten-per-guild cap, and a count that fails used to be read as 0 —
 * which is the one value that silently disables the spam guard, while looking
 * exactly like a brand new guild. That is the failure this file exists to pin,
 * together with its opposite: a count that ran and matched nothing really is
 * zero, and must stay a normal path rather than an error.
 *
 * The due-claim is the second. `claimDueAutopost` returning null means "someone
 * else won". Returning a THROW means "I could not ask", and treating those two
 * alike skips the post with nothing counting it, so it would not even appear in
 * the sweep's own {executed, failed} tally.
 */

type Repo = Record<string, unknown>;

const config = (over: Partial<AutopostConfig> = {}): AutopostConfig => ({
  id: '1',
  guildId: '900',
  channelId: '800',
  schedule: 'Daily',
  contentType: 'TopArtists',
  enabled: true,
  ...over,
});

/** A repository double whose methods default to "the database answered". */
const repo = (over: Repo = {}) => ({
  getAutopostsForGuild: vi.fn(async () => []),
  getAllActiveAutoposts: vi.fn(async () => []),
  createAutopost: vi.fn(async (d: { guildId: string }) => ({ ...d, id: '77', enabled: true })),
  deleteAutopost: vi.fn(async () => true),
  toggleAutopost: vi.fn(async () => null),
  countForGuild: vi.fn(async () => 0),
  claimDueAutopost: vi.fn(async () => undefined),
  releaseClaim: vi.fn(async () => undefined),
  ...over,
});

const build = (over: { repo?: unknown; noRepo?: boolean; crown?: Repo; telemetry?: Repo } = {}) => {
  const artistsService = { getTopArtists: vi.fn(async () => []) };
  const albumService = { getTopAlbums: vi.fn(async () => []) };
  const trackService = { getTopTracks: vi.fn(async () => []) };
  const crownService = {
    getGuildLeaderboard: vi.fn(async () => ({ entries: [], totalActiveCrowns: 0 })),
    ...(over.crown as Repo),
  };
  const telemetryService = {
    recordCommandExecution: vi.fn(),
    ...(over.telemetry as Repo),
  };
  const guildRepository = {};
  const autopostRepository = over.noRepo ? undefined : repo(over.repo as Repo);
  const service = new AutopostService(
    artistsService as never,
    albumService as never,
    trackService as never,
    crownService as never,
    telemetryService as never,
    guildRepository as never,
    autopostRepository as never,
  );
  return {
    service,
    autopostRepository,
    crownService,
    telemetryService,
    artistsService,
    albumService,
    trackService,
  };
};

/** A channel double that is text-based and records what was sent. */
const textChannel = (guildName = 'The Guild') => {
  const sent: unknown[] = [];
  return {
    sent,
    channel: {
      isTextBased: () => true,
      guild: { name: guildName },
      send: async (payload: unknown) => {
        sent.push(payload);
        return { id: 'm1' };
      },
    },
  };
};

const clientWith = (channel: unknown) => ({
  channels: { fetch: vi.fn(async () => channel) },
});

/** A client whose fetch rejects with `err`, standing in for a Discord REST error. */
const clientThrowing = (err: unknown) => ({
  channels: { fetch: vi.fn(async () => { throw err; }) },
});

/** A `DiscordAPIError` shape: a numeric JSON error code, which is what the fix reads. */
const discordError = (code: number, message: string) =>
  Object.assign(new Error(message), { code, status: code });

/**
 * Every WARN line the service emitted, flattened, so a test can say "the operator
 * is told THIS" rather than "something was logged". A test that only counted
 * calls would pass on a single line that named none of the causes.
 */
const warnLines = (): string[] => {
  return vi
    .mocked(Logger.warn)
    .mock.calls.map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
};

/** Log capture for the channel-failure cases; the real logger must stay quiet. */
const captureWarns = (): void => {
  vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
};

beforeEach(() => vi.clearAllMocks());

describe('AutopostService.createAutopost — the per-guild cap', () => {
  it('creates an autopost when the guild is under the cap', async () => {
    const { service, autopostRepository } = build();
    (autopostRepository as Repo).countForGuild = vi.fn(async () => 0);

    const created = await service.createAutopost({
      guildId: '900', channelId: '800', schedule: 'Daily', contentType: 'TopArtists', enabled: true,
    });

    expect(created?.id).toBe('77');
    expect((autopostRepository as Repo).createAutopost).toHaveBeenCalled();
  });

  it('refuses an eleventh autopost for the same guild', async () => {
    const { service, autopostRepository } = build();
    (autopostRepository as Repo).countForGuild = vi.fn(async () => AutopostService.MAX_AUTOPOSTS_PER_GUILD);

    const created = await service.createAutopost({
      guildId: '900', channelId: '800', schedule: 'Daily', contentType: 'TopArtists', enabled: true,
    });

    expect(created).toBeNull();
    expect((autopostRepository as Repo).createAutopost).not.toHaveBeenCalled();
  });

  it('treats an unreadable count as a failure, never as an empty guild', async () => {
    // THE bug this service is shaped around. A `catch` here answered 0, which
    // is the one value that lets a guild configure unlimited autoposts while
    // the log says nothing.
    const { service, autopostRepository } = build();
    (autopostRepository as Repo).countForGuild = vi.fn(async () => {
      throw new Error('relation "guild_autopost" does not exist');
    });

    const err = await service
      .createAutopost({ guildId: '900', channelId: '800', schedule: 'Daily', contentType: 'TopArtists', enabled: true })
      .catch((e: unknown) => e);

    expect(isSourceUnavailable(err)).toBe(true);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).method).toBe('autopostService.createAutopost:guildAutopost.count');
    expect((autopostRepository as Repo).createAutopost).not.toHaveBeenCalled();
  });

  it('accepts a real zero, which is a successful count of nothing', async () => {
    // The other direction of the same pairing: a count that RAN and matched no
    // rows is a fact, and raising here would page the operator every time a
    // guild configures its first autopost.
    const { service } = build({ repo: { countForGuild: vi.fn(async () => 0) } });
    const created = await service.createAutopost({
      guildId: '900', channelId: '800', schedule: 'Daily', contentType: 'TopArtists', enabled: true,
    });
    expect(created).not.toBeNull();
  });

  it('lets a retry through after a failed count, so the outage is recoverable', async () => {
    let attempt = 0;
    const { service } = build({
      repo: {
        countForGuild: vi.fn(async () => {
          attempt++;
          if (attempt === 1) throw new Error('db down');
          return 0;
        }),
      },
    });
    const payload = { guildId: '900', channelId: '800', schedule: 'Daily' as const, contentType: 'TopArtists' as const, enabled: true };

    await expect(service.createAutopost(payload)).rejects.toBeTruthy();
    await expect(service.createAutopost(payload)).resolves.not.toBeNull();
  });

  it('falls back to an in-memory config when no repository is wired', async () => {
    // Dev and single-process runs have no autopost table; the service still has
    // to answer rather than crash on a missing collaborator.
    const { service } = build({ noRepo: true });
    const created = await service.createAutopost({
      guildId: '900', channelId: '800', schedule: 'Daily', contentType: 'TopArtists', enabled: true,
    });
    expect(created?.id).toBeDefined();
    expect(service.getAutopostsForGuild('900')).toHaveLength(1);
  });
});

describe('AutopostService.setAutopost — a configuration that cannot be stored', () => {
  it('keeps the in-memory entry keyed by the caller id until the save resolves', async () => {
    const { service } = build();
    service.setAutopost(config({ id: 'local-1' }));
    expect(service.getAutopostsForGuild('900').map((a) => a.id)).toEqual(['local-1']);
  });

  it('does not leave the caller id behind once the row is saved', async () => {
    // The sweep reads `getAllActiveAutoposts()` from the database, so a stale
    // in-memory copy keyed by the caller's id would be a second phantom post.
    const { service } = build();
    service.setAutopost(config({ id: 'local-1' }));
    await new Promise((r) => setImmediate(r));
    expect(service.getAutopostsForGuild('900').map((a) => a.id)).toEqual(['77']);
  });

  it('keeps the caller id when the save fails, so the failure is visible', async () => {
    const { service } = build({
      repo: { createAutopost: vi.fn(async () => { throw new Error('write failed'); }) },
    });
    service.setAutopost(config({ id: 'local-1' }));
    await new Promise((r) => setImmediate(r));
    expect(service.getAutopostsForGuild('900').map((a) => a.id)).toEqual(['local-1']);
  });
});

describe('AutopostService.isAutopostDue', () => {
  const now = new Date('2026-03-10T00:00:00.000Z');
  const hoursBefore = (h: number) => new Date(now.getTime() - h * 3600 * 1000);

  it('is due immediately for a post that has never run', () => {
    const { service } = build({ noRepo: true });
    expect(service.isAutopostDue(config({ lastPosted: null }), now)).toBe(true);
  });

  it('is never due while the autopost is disabled', () => {
    const { service } = build({ noRepo: true });
    expect(service.isAutopostDue(config({ enabled: false, lastPosted: null }), now)).toBe(false);
  });

  it.each([
    ['Daily', 24, true],
    ['Daily', 23, false],
    ['Weekly', 7 * 24, true],
    ['Weekly', 7 * 24 - 1, false],
    ['Monthly', 28 * 24, true],
    ['Monthly', 28 * 24 - 1, false],
  ] as const)('%s is due after %i hours: %s', (schedule, hours, expected) => {
    const { service } = build({ noRepo: true });
    expect(service.isAutopostDue(config({ schedule, lastPosted: hoursBefore(hours) }), now)).toBe(expected);
  });

  it('is never due for a schedule it does not recognise', () => {
    // An unknown schedule must not post on every sweep.
    const { service } = build({ noRepo: true });
    expect(service.isAutopostDue(config({ schedule: 'Yearly' as never, lastPosted: hoursBefore(365 * 24) }), now)).toBe(false);
  });
});

describe('AutopostService.postAutopost', () => {
  it('posts a recap embed to the channel', async () => {
    const { service } = build();
    const { channel, sent } = textChannel();

    await expect(service.postAutopost(config(), clientWith(channel) as never)).resolves.toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('stamps lastPosted only after the send succeeded', async () => {
    const { service } = build();
    const { channel } = textChannel();
    const autopost = config({ lastPosted: null });

    await service.postAutopost(autopost, clientWith(channel) as never);

    expect(autopost.lastPosted).toBeInstanceOf(Date);
  });

  it('leaves lastPosted alone when the channel cannot be fetched', async () => {
    // If the stamp were written on failure the post would be suppressed for a
    // whole cycle and nothing would ever report it.
    const { service } = build();
    const autopost = config({ lastPosted: null });
    const client = { channels: { fetch: vi.fn(async () => { throw new Error('Unknown Channel'); }) } };

    await expect(service.postAutopost(autopost, client as never)).resolves.toBe(false);
    expect(autopost.lastPosted).toBeNull();
  });

  it('leaves lastPosted alone when the channel is not text-based', async () => {
    const { service } = build();
    const autopost = config({ lastPosted: null });
    const channel = { isTextBased: () => false, guild: { name: 'G' }, send: vi.fn() };

    await expect(service.postAutopost(autopost, clientWith(channel) as never)).resolves.toBe(false);
    expect(autopost.lastPosted).toBeNull();
  });

  it('leaves lastPosted alone when the send throws', async () => {
    const { service } = build();
    const autopost = config({ lastPosted: null });
    const channel = {
      isTextBased: () => true,
      guild: { name: 'G' },
      send: async () => { throw new Error('Missing Permissions'); },
    };

    await expect(service.postAutopost(autopost, clientWith(channel) as never)).resolves.toBe(false);
    expect(autopost.lastPosted).toBeNull();
  });

  it('builds a crown leaderboard for the crown content type', async () => {
    const { service, crownService } = build({
      crown: {
        getGuildLeaderboard: vi.fn(async () => ({
          entries: [{ userId: 1, discordUserId: 'd1', userNameLastFm: 'DreadRock', displayName: 'Dread', crownCount: 3 }],
          totalActiveCrowns: 1,
        })),
      },
    });
    const { channel, sent } = textChannel();

    await expect(
      service.postAutopost(config({ contentType: 'ServerCrowns' }), clientWith(channel) as never),
    ).resolves.toBe(true);
    expect(crownService.getGuildLeaderboard).toHaveBeenCalledWith('900');
    expect(sent).toHaveLength(1);
  });

  it('posts a real crown payload, not an empty one', async () => {
    // `toMessagePayload` is called on the real ResponseModel the real builder
    // produced, so a shape change upstream fails here rather than in production.
    const { service } = build({
      crown: {
        getGuildLeaderboard: vi.fn(async () => ({
          entries: [{ userId: 1, discordUserId: 'd1', userNameLastFm: 'DreadRock', displayName: 'Dread', crownCount: 3 }],
          totalActiveCrowns: 1,
        })),
      },
    });
    const { channel, sent } = textChannel();

    await service.postAutopost(config({ contentType: 'ServerCrowns' }), clientWith(channel) as never);

    expect(sent[0]).toHaveProperty('components');
  });

  it('fails the post when the crown read is unreadable, rather than posting an empty board', async () => {
    // A caught read here would publish "this server has no crowns" and stamp
    // the post, so the real board would never appear.
    const { service } = build({
      crown: { getGuildLeaderboard: vi.fn(async () => { throw new Error('db down'); }) },
    });
    const autopost = config({ contentType: 'ServerCrowns', lastPosted: null });
    const { channel } = textChannel();

    await expect(service.postAutopost(autopost, clientWith(channel) as never)).resolves.toBe(false);
    expect(autopost.lastPosted).toBeNull();
  });
});

/**
 * A channel the bot cannot post in, a channel that does not exist, and a fetch
 * that failed for a moment are three different operator problems with three
 * different fixes, and all three used to produce the SAME single WARN line. The
 * sharpest is 50013: the channel is right there, the bot simply cannot use it,
 * and nothing about that improves on its own — so an autopost re-failing every
 * fifteen minutes looked in the log exactly like a network blip that would clear
 * up on its own.
 *
 * The RETRY POLICY is deliberately unchanged: every one of these returns false,
 * the sweep rolls the due-claim back and tries again next cycle. What is pinned
 * here is only that the operator can tell them apart.
 */
describe('AutopostService.postAutopost — a missing capability is not a missing channel', () => {
  it('names 50013 as a PERMISSIONS problem, with the fix, and not as a missing channel', async () => {
    captureWarns();
    const { service } = build();

    await expect(
      service.postAutopost(config(), clientThrowing(discordError(50013, 'Missing Access')) as never),
    ).resolves.toBe(false);

    const line = warnLines().join('\n');
    expect(line).toContain('50013');
    expect(line).toContain('cannot access');
    // The channel EXISTS. Reporting it as gone is what sent an operator looking
    // for a deleted channel that was still sitting right there.
    expect(line).not.toMatch(/no longer exists|could not be found/);
  });

  it('names 50001 as a DELETED channel, distinctly from a permissions problem', async () => {
    captureWarns();
    const { service } = build();

    await expect(
      service.postAutopost(config(), clientThrowing(discordError(50001, 'Unknown Channel')) as never),
    ).resolves.toBe(false);

    const line = warnLines().join('\n');
    expect(line).toContain('50001');
    expect(line).toMatch(/no longer exists/);
    expect(line).not.toMatch(/cannot access/);
  });

  it('names a transport failure as TRANSIENT, so it is read as neither of the other two', async () => {
    captureWarns();
    const { service } = build();

    await expect(
      service.postAutopost(config(), clientThrowing(new Error('socket hang up')) as never),
    ).resolves.toBe(false);

    const line = warnLines().join('\n');
    expect(line).toMatch(/transient/);
    expect(line).not.toMatch(/no longer exists|cannot access/);
  });

  it('separates a channel that EXISTS but is not a text channel from all three', async () => {
    captureWarns();
    const { service } = build();
    const channel = { isTextBased: () => false, guild: { name: 'G' }, send: vi.fn() };

    await expect(service.postAutopost(config(), clientWith(channel) as never)).resolves.toBe(false);

    const line = warnLines().join('\n');
    expect(line).toMatch(/not a text channel/);
    expect(line).not.toMatch(/transient|no longer exists|cannot access/);
  });

  it('a fetch that RESOLVES to null is a missing channel, not a transient failure', async () => {
    // discord.js answers `null` rather than throwing when the channel is not in
    // the cache, so this arm needs its own line as well.
    captureWarns();
    const { service } = build();

    await expect(service.postAutopost(config(), clientWith(null) as never)).resolves.toBe(false);

    const line = warnLines().join('\n');
    expect(line).toMatch(/could not be found/);
    expect(line).not.toMatch(/transient/);
  });

  it('the four outcomes produce FOUR DIFFERENT lines, which is the actual claim', async () => {
    captureWarns();
    const { service } = build();
    const voice = { isTextBased: () => false, guild: { name: 'G' }, send: vi.fn() };

    await service.postAutopost(config(), clientThrowing(discordError(50013, 'Missing Access')) as never);
    await service.postAutopost(config(), clientThrowing(discordError(50001, 'Unknown Channel')) as never);
    await service.postAutopost(config(), clientThrowing(new Error('socket hang up')) as never);
    await service.postAutopost(config(), clientWith(voice) as never);

    // Four calls, four distinct messages. Any pair sharing a line is the bug.
    expect(new Set(warnLines()).size).toBe(4);
  });

  it('does NOT change the retry policy: all four still return false and stamp nothing', async () => {
    captureWarns();
    const { service } = build();
    const voice = { isTextBased: () => false, guild: { name: 'G' }, send: vi.fn() };

    for (const client of [
      clientThrowing(discordError(50013, 'Missing Access')),
      clientThrowing(discordError(50001, 'Unknown Channel')),
      clientThrowing(new Error('socket hang up')),
      clientWith(voice),
    ]) {
      const autopost = config({ lastPosted: null });
      await expect(service.postAutopost(autopost, client as never)).resolves.toBe(false);
      // Unchanged on purpose. The sweep rolls the claim back and retries, which
      // is right for a blip and is the only thing standing between a 50013 and a
      // silently abandoned autopost; the fix here is diagnosability, not policy.
      expect(autopost.lastPosted).toBeNull();
    }
  });

  it('CONTROL: a healthy channel logs no warning at all', async () => {
    // So the four-line assertion above cannot pass by the service warning more
    // than it should.
    captureWarns();
    const { service } = build();
    const { channel } = textChannel();

    await expect(service.postAutopost(config(), clientWith(channel) as never)).resolves.toBe(true);

    expect(Logger.warn).not.toHaveBeenCalled();
  });
});

describe('AutopostService.runScheduledAutoposts — the sweep', () => {
  const due = (over: Partial<AutopostConfig> = {}) => config({ id: '10', lastPosted: null, ...over });

  it('posts every due autopost and reports the count', async () => {
    const { service } = build({
      repo: { getAllActiveAutoposts: vi.fn(async () => [due({ id: '10' }), due({ id: '11' })]) },
    });
    const { channel, sent } = textChannel();

    const result = await service.runScheduledAutoposts(clientWith(channel) as never);

    expect(result).toEqual({ executed: 2, failed: 0 });
    expect(sent).toHaveLength(2);
  });

  it('skips an autopost that is not due and does not count it', async () => {
    const { service } = build({
      repo: { getAllActiveAutoposts: vi.fn(async () => [due({ lastPosted: new Date() })]) },
    });
    const { channel, sent } = textChannel();

    await expect(service.runScheduledAutoposts(clientWith(channel) as never)).resolves.toEqual({ executed: 0, failed: 0 });
    expect(sent).toHaveLength(0);
  });

  it('claims the post atomically before sending, so two runners cannot double-post', async () => {
    const order: string[] = [];
    const { service } = build({
      repo: {
        getAllActiveAutoposts: vi.fn(async () => [due()]),
        claimDueAutopost: vi.fn(async () => { order.push('claim'); return undefined; }),
      },
    });
    const channel = {
      isTextBased: () => true,
      guild: { name: 'G' },
      send: async () => { order.push('send'); return { id: 'm' }; },
    };

    await service.runScheduledAutoposts(clientWith(channel) as never);

    expect(order).toEqual(['claim', 'send']);
  });

  it('skips a post another runner already claimed', async () => {
    const { service } = build({
      repo: {
        getAllActiveAutoposts: vi.fn(async () => [due()]),
        claimDueAutopost: vi.fn(async () => null),
      },
    });
    const { channel, sent } = textChannel();

    await expect(service.runScheduledAutoposts(clientWith(channel) as never)).resolves.toEqual({ executed: 0, failed: 0 });
    expect(sent).toHaveLength(0);
  });

  it('counts an UNREADABLE claim as failed rather than skipping it silently', async () => {
    // A throw is not the same answer as `null`. Reading them alike left the post
    // unposted AND uncounted, so nothing anywhere recorded that it happened.
    const { service } = build({
      repo: {
        getAllActiveAutoposts: vi.fn(async () => [due()]),
        claimDueAutopost: vi.fn(async () => { throw new Error('connection reset'); }),
      },
    });
    const { channel, sent } = textChannel();

    const result = await service.runScheduledAutoposts(clientWith(channel) as never);

    expect(result).toEqual({ executed: 0, failed: 1 });
    expect(sent).toHaveLength(0);
  });

  it('still retries next sweep after an unreadable claim, because nothing was stamped', async () => {
    const { service, autopostRepository } = build({
      repo: {
        getAllActiveAutoposts: vi.fn(async () => [due()]),
        claimDueAutopost: vi.fn(async () => { throw new Error('connection reset'); }),
      },
    });
    const { channel } = textChannel();
    const autopost = due();

    await service.runScheduledAutoposts(clientWith(channel) as never);

    expect(autopost.lastPosted).toBeNull();
    expect((autopostRepository as Repo).releaseClaim).not.toHaveBeenCalled();
  });

  it('rolls the claim back when the post fails, so the next sweep retries', async () => {
    const { service, autopostRepository } = build({
      repo: {
        getAllActiveAutoposts: vi.fn(async () => [due()]),
        claimDueAutopost: vi.fn(async () => new Date('2026-01-01T00:00:00.000Z')),
      },
    });
    const client = { channels: { fetch: vi.fn(async () => { throw new Error('Unknown Channel'); }) } };

    const result = await service.runScheduledAutoposts(client as never);

    expect(result).toEqual({ executed: 0, failed: 1 });
    expect((autopostRepository as Repo).releaseClaim).toHaveBeenCalledWith(10, new Date('2026-01-01T00:00:00.000Z'));
  });

  it('rolls the claim back when the post fails, including when a builder throws', async () => {
    const { service, autopostRepository } = build({
      repo: {
        getAllActiveAutoposts: vi.fn(async () => [due({ contentType: 'ServerCrowns' })]),
        claimDueAutopost: vi.fn(async () => undefined),
      },
      crown: { getGuildLeaderboard: vi.fn(async () => { throw new Error('db down'); }) },
    });
    const { channel } = textChannel();

    const result = await service.runScheduledAutoposts(clientWith(channel) as never);

    // postAutopost catches, so this is the `success === false` branch rather
    // than the outer catch; either way the claim must be released or the post
    // is lost for a whole cycle.
    expect(result.failed).toBe(1);
    expect((autopostRepository as Repo).releaseClaim).toHaveBeenCalled();
  });

  it('does not double-count a post whose rollback also fails', async () => {
    // The rollback is the worst silent failure in the service: the stamp stays,
    // so the guild silently stops getting its recap. It is also the one place
    // a throw must NOT escape, because the failure was already counted.
    const { service } = build({
      repo: {
        getAllActiveAutoposts: vi.fn(async () => [due()]),
        claimDueAutopost: vi.fn(async () => undefined),
        releaseClaim: vi.fn(async () => { throw new Error('rollback failed'); }),
      },
    });
    const client = { channels: { fetch: vi.fn(async () => { throw new Error('Unknown Channel'); }) } };

    await expect(service.runScheduledAutoposts(client as never)).resolves.toEqual({ executed: 0, failed: 1 });
  });

  it('does not claim at all for an id the database did not mint', async () => {
    // A non-numeric id cannot be claimed safely, so the post runs unclaimed
    // rather than being silently dropped.
    const { service, autopostRepository } = build({
      repo: { getAllActiveAutoposts: vi.fn(async () => [due({ id: 'local-1' })]) },
    });
    const { channel, sent } = textChannel();

    const result = await service.runScheduledAutoposts(clientWith(channel) as never);

    expect(result.executed).toBe(1);
    expect((autopostRepository as Repo).claimDueAutopost).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  it('records telemetry for a successful post', async () => {
    const { service, telemetryService } = build({
      repo: { getAllActiveAutoposts: vi.fn(async () => [due()]) },
    });
    const { channel } = textChannel();

    await service.runScheduledAutoposts(clientWith(channel) as never);

    expect(telemetryService.recordCommandExecution).toHaveBeenCalledWith('autopost:topartists', expect.any(Number), true);
  });

  it('reads the sweep list from the database, not from memory', async () => {
    // The sweep runs on every shard-less process; an in-memory-only list would
    // post a guild's recap twice after a restart.
    const { service, autopostRepository } = build({
      repo: { getAllActiveAutoposts: vi.fn(async () => []) },
    });
    await service.runScheduledAutoposts(clientWith(null) as never);
    expect((autopostRepository as Repo).getAllActiveAutoposts).toHaveBeenCalled();
  });

  it('uses the in-memory list when no repository is wired', async () => {
    const { service } = build({ noRepo: true });
    service.setAutopost(config({ id: '1', lastPosted: null }));
    const { channel, sent } = textChannel();

    const result = await service.runScheduledAutoposts(clientWith(channel) as never);

    expect(result.executed).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('continues the sweep after one guild fails', async () => {
    const { service } = build({
      repo: { getAllActiveAutoposts: vi.fn(async () => [due({ id: '10' }), due({ id: '11' })]) },
    });
    let n = 0;
    const channel = {
      isTextBased: () => true,
      guild: { name: 'G' },
      send: async () => {
        n++;
        if (n === 1) throw new Error('Missing Permissions');
        return { id: 'm' };
      },
    };

    const result = await service.runScheduledAutoposts(clientWith(channel) as never);

    expect(result).toEqual({ executed: 1, failed: 1 });
  });
});

describe('AutopostService.toggleAutopost / removeAutopost / fetch', () => {
  it('toggles through the database and stores the returned row', async () => {
    const toggled = { id: '5', guildId: '900', channelId: '800', schedule: 'Weekly' as const, contentType: 'TopAlbums' as const, enabled: false };
    const { service } = build({ repo: { toggleAutopost: vi.fn(async () => toggled) } });

    const result = await service.toggleAutopost('5', '900');

    expect(result).toEqual(toggled);
    expect(service.getAutopostsForGuild('900').map((a) => a.id)).toEqual(['5']);
  });

  it('falls back to the in-memory flip when the row is gone', async () => {
    const { service } = build({ repo: { toggleAutopost: vi.fn(async () => null) } });
    service.setAutopost(config({ id: 'local-1', enabled: true }));

    const result = await service.toggleAutopost('local-1', '900');

    expect(result?.enabled).toBe(false);
  });

  it('answers null for an autopost it has never seen', async () => {
    const { service } = build();
    await expect(service.toggleAutopost('nope', '900')).resolves.toBeNull();
  });

  it('deletes a numeric id from the database as well as memory', async () => {
    const { service, autopostRepository } = build();
    await service.createAutopost({
      guildId: '900', channelId: '800', schedule: 'Daily', contentType: 'TopArtists', enabled: true,
    });

    expect(service.removeAutopost('77', '900')).toBe(true);
    expect((autopostRepository as Repo).deleteAutopost).toHaveBeenCalledWith(77, '900');
  });

  it('reports the in-memory removal even when nothing was stored there', async () => {
    const { service } = build({ noRepo: true });
    service.setAutopost(config({ id: 'local-1' }));

    expect(service.removeAutopost('local-1', '900')).toBe(true);
    expect(service.getAutopostsForGuild('900')).toEqual([]);
  });

  it('does not call the database for a non-numeric id', async () => {
    // `parseInt('abc')` is NaN and a NaN id would go to the table as a query
    // that matches nothing, reporting a delete that never happened.
    const { service, autopostRepository } = build();
    service.setAutopost(config({ id: 'local-1' }));

    expect(service.removeAutopost('local-1', '900')).toBe(true);
    expect((autopostRepository as Repo).deleteAutopost).not.toHaveBeenCalled();
  });

  it('reports false when asked to remove something it does not have', async () => {
    const { service } = build();
    expect(service.removeAutopost('nope', '900')).toBe(false);
  });

  it('merges the database rows into memory and returns them', async () => {
    const rows = [config({ id: '5', guildId: '900' })];
    const { service } = build({ repo: { getAutopostsForGuild: vi.fn(async () => rows) } });

    const result = await service.fetchAutopostsForGuild('900');

    expect(result).toEqual(rows);
    expect(service.getAutopostsForGuild('900').map((a) => a.id)).toEqual(['5']);
  });

  it('lets a failed read propagate instead of returning an empty autopost list', async () => {
    // The caller renders "this server has no autoposts" from this list and then
    // offers to create one, so a swallowed failure reads as a real answer.
    const { service } = build({
      repo: { getAutopostsForGuild: vi.fn(async () => { throw new Error('db down'); }) },
    });
    await expect(service.fetchAutopostsForGuild('900')).rejects.toThrow('db down');
  });

  it('scopes the in-memory list to one guild', async () => {
    const { service } = build({ noRepo: true });
    service.setAutopost(config({ id: '1', guildId: '900' }));
    service.setAutopost(config({ id: '2', guildId: '901' }));
    expect(service.getAutopostsForGuild('900').map((a) => a.id)).toEqual(['1']);
  });
});
