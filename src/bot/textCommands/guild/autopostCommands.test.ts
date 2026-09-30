import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { AutopostCommands } from './autopostCommands';
import { AutopostBuilders } from '@bot/builders/autopostBuilders';
import { AutopostService } from '@bot/services/autopostService';
import { auditAdminAction } from '@domain/adminAudit';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { AutopostConfig } from '@bot/services/autopostService';

/**
 * `.autopost` — the one command file here whose load-bearing behaviour is a
 * PERMISSION GUARD, so the guard gets the most attention.
 *
 * The shape is a subcommand dispatcher: a bare `.autopost` lists, and six
 * subcommands mutate. `add`, `remove`/`delete`, `toggle` and `send`/`run` all
 * write or publish, and all of them must be refused for a non-admin. The
 * listing must NOT be — a server member is entitled to see what is being posted
 * into their server. So the two directions are tested separately, because a
 * guard that is accidentally applied to the read, or accidentally missing from
 * a write, both look like a working command in a smoke test.
 *
 * A second property worth pinning: `add` must NOT create anything when the
 * channel is unreadable. It resolves the channel before `createAutopost`, so a
 * bot that cannot see the channel leaves the guild's autopost budget untouched
 * — otherwise a typo would burn one of the ten slots.
 */

vi.mock('@domain/adminAudit', () => ({ auditAdminAction: vi.fn() }));

const config = (over: Partial<AutopostConfig> = {}): AutopostConfig => ({
  id: '7',
  guildId: '222',
  channelId: 'C1',
  schedule: 'Weekly',
  contentType: 'TopArtists',
  enabled: true,
  ...over,
});

// `addAutopostAsync` resolves the target channel from `context.interaction?.channelId
// ?? context.message?.channelId` — the RAW message, not the normalised
// `context.channelId` getter. A mock that only sets the getter reports a missing
// channel, which is a wrong test, not a wrong command.
const ctx = (over: Record<string, unknown> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    guild: { id: '222', name: 'Test Guild' },
    prefix: '.',
    channelId: 'C1',
    message: { channelId: 'C1' },
    userIsGuildAdmin: true,
    ...over,
  }) as unknown as ContextModel;

const dmCtx = () => ctx({ guildId: undefined, guild: null, userIsGuildAdmin: false });
const noAdminCtx = () => ctx({ userIsGuildAdmin: false });

type Overrides = {
  autoposts?: AutopostConfig[];
  created?: AutopostConfig | null;
  removed?: boolean;
  toggled?: AutopostConfig | null;
  posted?: boolean;
  channel?: unknown;
  prefix?: string;
  accentColor?: number | null;
};

const build = (over: Overrides = {}) => {
  const autopostService = {
    fetchAutopostsForGuild: vi.fn(async (..._a: unknown[]) => over.autoposts ?? []),
    getAutopostsForGuild: vi.fn((..._a: unknown[]) => over.autoposts ?? []),
    createAutopost: vi.fn(async (..._a: unknown[]) => (over.created === undefined ? config() : over.created)),
    removeAutopost: vi.fn((..._a: unknown[]) => (over.removed === undefined ? true : over.removed)),
    toggleAutopost: vi.fn(async (..._a: unknown[]) => (over.toggled === undefined ? config() : over.toggled)),
    postAutopost: vi.fn(async (..._a: unknown[]) => (over.posted === undefined ? true : over.posted)),
  };
  const prefixService = {
    getPrefix: vi.fn(async (..._a: unknown[]) => (over.prefix === undefined ? '!' : over.prefix)),
  };
  const channel =
    over.channel === undefined
      ? { id: 'C1', isTextBased: vi.fn(() => true), send: vi.fn(async (..._a: unknown[]) => undefined) }
      : over.channel;
  const client = { channels: { fetch: vi.fn(async (..._a: unknown[]) => channel) } };
  const colorService = {
    getAccentColorAsync: vi.fn(async (..._a: unknown[]) =>
      over.accentColor === undefined ? 0x778899 : over.accentColor,
    ),
  };

  const commands = new AutopostCommands(
    autopostService as never,
    prefixService as never,
    client as never,
    colorService as never,
  );

  return { commands, autopostService, prefixService, client, colorService };
};

const run = (commands: AutopostCommands, context: ContextModel, ...args: string[]) =>
  commands.commands[0]!.executeAsync(context, args);

const desc = (r: { embed: { data: { description?: string } } }): string =>
  (r.embed.data.description ?? '') as string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(AutopostBuilders, 'buildAutopostOverview').mockReturnValue({ marker: 'overview' } as never);
  vi.mocked(auditAdminAction).mockClear();
});

describe('AutopostCommands — registration and the DM guard', () => {
  it('registers autoposts with its aliases', () => {
    const { commands } = build();
    // The canonical name is the PLURAL; `autopost` is the alias users type.
    expect(commands.commands[0]!.name).toBe('autoposts');
    expect(commands.commands[0]!.aliases).toEqual(['autopost', 'autoposter', 'scheduledposts']);
  });

  it('refuses everything outside a server, including the read', async () => {
    const { commands, autopostService } = build();

    const result = await run(commands, dmCtx());

    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    expect(autopostService.fetchAutopostsForGuild).not.toHaveBeenCalled();
  });
});

describe('AutopostCommands — the Manage Server guard on every mutating subcommand', () => {
  // `delete` and `run` are the documented synonyms; a guard applied to `remove`
  // but not `delete` would be a real privilege hole, so both spellings are
  // listed here.
  it.each([
    ['add', ['add', 'topartists', 'weekly']],
    ['remove', ['remove', '1']],
    ['delete', ['delete', '1']],
    ['toggle', ['toggle', '1']],
    ['send', ['send', '1']],
    ['run', ['run', '1']],
  ])('refuses %s for a caller without Manage Server', async (name, args) => {
    const { commands, autopostService } = build();

    const result = await run(commands, noAdminCtx(), ...args);

    // WrongInput is what the command returns, and the reason is a permission
    // problem rather than a malformed one — the wording is what carries the
    // diagnostic, so it is asserted too.
    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(desc(result as never)).toContain('Manage Server');
    expect(autopostService.createAutopost).not.toHaveBeenCalled();
    expect(autopostService.removeAutopost).not.toHaveBeenCalled();
    expect(autopostService.toggleAutopost).not.toHaveBeenCalled();
    expect(autopostService.postAutopost).not.toHaveBeenCalled();
    expect(auditAdminAction).not.toHaveBeenCalled();
    expect(name).toBeTruthy();
  });

  it('still lets a non-admin list the guild autoposts', async () => {
    const { commands, autopostService } = build({ autoposts: [config()] });

    const result = await run(commands, noAdminCtx());

    expect(result).toEqual({ marker: 'overview' });
    expect(autopostService.fetchAutopostsForGuild).toHaveBeenCalledWith('222');
  });

  it('reads the guild prefix from the service, not a hardcoded dot', async () => {
    const { commands, prefixService } = build({ prefix: '?' });

    await run(commands, ctx());

    expect(prefixService.getPrefix).toHaveBeenCalledWith('222');
  });

  it('passes the guild prefix into the overview so its examples match the server', async () => {
    const { commands } = build({ prefix: '?' });

    await run(commands, ctx());

    expect(AutopostBuilders.buildAutopostOverview).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: '?', guildName: 'Test Guild' }),
    );
  });
});

describe('AutopostCommands — add: the argument grammar', () => {
  it('creates a weekly top-artists autopost in the invoking channel', async () => {
    const { commands, autopostService } = build();

    const result = await run(commands, ctx(), 'add', 'topartists', 'weekly');

    expect(autopostService.createAutopost).toHaveBeenCalledWith({
      guildId: '222',
      channelId: 'C1',
      contentType: 'TopArtists',
      schedule: 'Weekly',
      enabled: true,
    });
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    // The confirmation echoes the resolved ENUM names, not the raw tokens.
    expect(desc(result as never)).toContain('Top Artists');
    expect(desc(result as never)).toContain('Weekly');
    expect(auditAdminAction).toHaveBeenCalledWith('222', '111', 'autopost-add', expect.stringContaining('TopArtists'));
  });

  it.each([
    ['topartists', 'TopArtists'],
    ['topalbums', 'TopAlbums'],
    ['toptracks', 'TopTracks'],
    ['crowns', 'ServerCrowns'],
  ])('maps the %j content type to %s', async (raw, expected) => {
    const { commands, autopostService } = build();

    await run(commands, ctx(), 'add', raw, 'weekly');

    expect(autopostService.createAutopost.mock.calls[0]![0]).toMatchObject({ contentType: expected });
  });

  it.each([
    ['daily', 'Daily'],
    ['day', 'Daily'],
    ['weekly', 'Weekly'],
    ['week', 'Weekly'],
    ['monthly', 'Monthly'],
    ['month', 'Monthly'],
  ])('maps the %j schedule to %s', async (raw, expected) => {
    const { commands, autopostService } = build();

    await run(commands, ctx(), 'add', 'topalbums', raw);

    expect(autopostService.createAutopost.mock.calls[0]![0]).toMatchObject({ schedule: expected });
  });

  it('accepts an uppercase subcommand and content type', async () => {
    // `sub` and the type/schedule are both lowercased, so `ADD TopArtists WEEKLY`
    // is the same command. A case-sensitive dispatcher would read that as an
    // unknown content type.
    const { commands, autopostService } = build();

    await run(commands, ctx(), 'ADD', 'TopArtists', 'WEEKLY');

    expect(autopostService.createAutopost.mock.calls[0]![0]).toMatchObject({
      contentType: 'TopArtists',
      schedule: 'Weekly',
    });
  });

  it('asks for the missing arguments instead of guessing a type', async () => {
    const { commands, autopostService } = build();

    const result = await run(commands, ctx(), 'add', 'topartists');

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(desc(result as never)).toContain('autopost add');
    expect(autopostService.createAutopost).not.toHaveBeenCalled();
  });

  it('rejects an unknown content type by name', async () => {
    const { commands, autopostService } = build();

    const result = await run(commands, ctx(), 'add', 'podcasts', 'weekly');

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(desc(result as never)).toContain('topartists');
    expect(autopostService.createAutopost).not.toHaveBeenCalled();
  });

  it('rejects an unknown schedule by name', async () => {
    const { commands, autopostService } = build();

    const result = await run(commands, ctx(), 'add', 'topartists', 'fortnightly');

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(desc(result as never)).toContain('daily');
    expect(autopostService.createAutopost).not.toHaveBeenCalled();
  });

  it('honours a channel mention over the invoking channel', async () => {
    const { commands, autopostService } = build();

    await run(commands, ctx(), 'add', 'topartists', 'weekly', '<#555>');

    expect(autopostService.createAutopost.mock.calls[0]![0]).toMatchObject({ channelId: '555' });
  });

  it('accepts a bare channel id as well as a mention', async () => {
    const { commands, autopostService } = build();

    await run(commands, ctx(), 'add', 'topartists', 'weekly', '555');

    expect(autopostService.createAutopost.mock.calls[0]![0]).toMatchObject({ channelId: '555' });
  });

  it('refuses an unreadable channel WITHOUT creating anything', async () => {
    // The channel check precedes createAutopost on purpose: a bot that cannot
    // VIEW_CHANNEL gets the same 403 as a typo, and burning one of the ten
    // per-guild slots on a failed paste would be a silent data loss.
    const { commands, autopostService } = build({ channel: null });

    const result = await run(commands, ctx(), 'add', 'topartists', 'weekly');

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(desc(result as never)).toContain('permission');
    expect(autopostService.createAutopost).not.toHaveBeenCalled();
  });

  it('refuses a non-text channel such as a voice channel', async () => {
    const { commands, autopostService } = build({
      channel: { id: 'V1', isTextBased: vi.fn(() => false) },
    });

    const result = await run(commands, ctx(), 'add', 'topartists', 'weekly', '<#V1>');

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(autopostService.createAutopost).not.toHaveBeenCalled();
  });

  it('reports the per-guild cap as a wrong input rather than a bare failure', async () => {
    const { commands } = build({ created: null });

    const result = await run(commands, ctx(), 'add', 'topartists', 'weekly');

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(desc(result as never)).toContain(String(AutopostService.MAX_AUTOPOSTS_PER_GUILD));
  });

  it('reports a missing channel id when the context carries none', async () => {
    const { commands, autopostService, client } = build();

    const result = await run(commands, ctx({ channelId: undefined, message: undefined }), 'add', 'topartists', 'weekly');

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(desc(result as never)).toContain('channel');
    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(autopostService.createAutopost).not.toHaveBeenCalled();
  });
});

describe('AutopostCommands — remove, toggle and send', () => {
  it.each(['remove', 'delete'])('removes via the %s synonym', async (sub) => {
    const { commands, autopostService } = build();

    const result = await run(commands, ctx(), sub, '7');

    expect(autopostService.removeAutopost).toHaveBeenCalledWith('7', '222');
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(auditAdminAction).toHaveBeenCalledWith('222', '111', 'autopost-remove', '#7');
  });

  it('reports an unknown autopost id as NotFound', async () => {
    const { commands } = build({ removed: false });

    const result = await run(commands, ctx(), 'remove', '99');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result as never)).toContain('99');
    expect(auditAdminAction).not.toHaveBeenCalled();
  });

  it('asks for the id when remove gets none', async () => {
    const { commands, autopostService } = build();

    const result = await run(commands, ctx(), 'remove');

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(autopostService.removeAutopost).not.toHaveBeenCalled();
  });

  it('reports a resumed autopost after enabling one', async () => {
    const { commands, autopostService } = build({ toggled: config({ enabled: true }) });

    const result = await run(commands, ctx(), 'toggle', '7');

    expect(autopostService.toggleAutopost).toHaveBeenCalledWith('7', '222');
    expect(desc(result as never)).toContain('Resumed');
  });

  it('reports a paused autopost after disabling one', async () => {
    const { commands } = build({ toggled: config({ enabled: false }) });

    const result = await run(commands, ctx(), 'toggle', '7');

    expect(desc(result as never)).toContain('Paused');
  });

  it('reports an unknown autopost id on toggle as NotFound', async () => {
    const { commands } = build({ toggled: null });

    const result = await run(commands, ctx(), 'toggle', '99');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('asks for the id when toggle gets none', async () => {
    const { commands, autopostService } = build();

    const result = await run(commands, ctx(), 'toggle');

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(autopostService.toggleAutopost).not.toHaveBeenCalled();
  });

  it.each(['send', 'run'])('publishes immediately via the %s synonym', async (sub) => {
    const { commands, autopostService, client } = build({ autoposts: [config({ channelId: 'C9' })] });

    const result = await run(commands, ctx(), sub, '7');

    expect(autopostService.postAutopost).toHaveBeenCalledWith(
      expect.objectContaining({ id: '7' }),
      client,
    );
    expect(result.commandResponse).toBe(CommandResponse.Ok);
    expect(desc(result as never)).toContain('C9');
  });

  it('surfaces a failed publish as an error naming the channel', async () => {
    // The user asked for a test run and got none. Saying "ok" here would be a
    // confident false claim, so this must be a visible Error.
    const { commands } = build({ autoposts: [config({ channelId: 'C9' })], posted: false });

    const result = await run(commands, ctx(), 'send', '7');

    expect(result.commandResponse).toBe(CommandResponse.Error);
    expect(desc(result as never)).toContain('C9');
    expect(desc(result as never)).toContain('permissions');
  });

  it('scopes the send lookup to this guild, so another server id cannot be published', async () => {
    // The command does not re-filter by guildId itself — it asks
    // `getAutopostsForGuild(context.guildId)` and finds within that list. The
    // scoping is therefore the GUILD ID ARGUMENT, and that argument is the thing
    // to pin: pass the wrong one and the id resolves.
    const { commands, autopostService } = build({ autoposts: [config({ id: '7', guildId: '222' })] });

    await run(commands, ctx(), 'send', '7');

    expect(autopostService.getAutopostsForGuild).toHaveBeenCalledWith('222');
  });

  it('reports NotFound for an id that is not in this guild list', async () => {
    const { commands, autopostService } = build({ autoposts: [] });

    const result = await run(commands, ctx(), 'send', '7');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(autopostService.postAutopost).not.toHaveBeenCalled();
  });

  it('asks for the id when send gets none', async () => {
    const { commands, autopostService } = build();

    const result = await run(commands, ctx(), 'send');

    expect(result.commandResponse).toBe(CommandResponse.WrongInput);
    expect(autopostService.postAutopost).not.toHaveBeenCalled();
  });
});
