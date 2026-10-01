import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { PlaycountCommands } from '../playcountCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';

/**
 * The text-command target grammar, which has no equivalent in the slash layer.
 *
 * The slash commands take typed Discord options, so `lfm:username` and a
 * `<@123>` mention are parsed by Discord. Here they are hand-written regexes
 * (AGENTS.md section 6 notes the two argument models are genuinely different),
 * which makes this the only place those forms are interpreted - and the file
 * had zero tests at 18% line coverage.
 *
 * The interesting cases are the ones a naive `match` would get wrong: a
 * registered target vs an unregistered one, and the `userId: 0` sentinel the
 * unregistered path fabricates so the play-count lookup is skipped rather
 * than run against the caller's own id.
 */

const makeUser = (over: Partial<User> = {}): User =>
  ({
    userId: 1,
    userNameLastFm: 'DreadRock',
    sessionKey: 'SK',
    ...over,
  }) as User;

const makeContext = (over: Partial<ContextModel> = {}): ContextModel =>
  ({
    discordUserId: '111',
    guildId: '222',
    prefix: '.',
    args: [],
    member: { displayName: 'Caller' },
    ...over,
  }) as unknown as ContextModel;

/**
 * Every collaborator is named with its real type on purpose. PLAN_PROGRESS
 * records a test that passed with its 11 constructor arguments in the wrong
 * order because inline `as never` literals made them mutually assignable.
 */
const makeModule = (opts: { caller?: User | null; mentioned?: User | null; byLfmName?: User | null } = {}) => {
  const caller = opts.caller === undefined ? makeUser() : opts.caller;
  const userService = {
    getUserByDiscordId: vi.fn(async (id: string) => (id === '111' ? caller : (opts.mentioned ?? null))),
    getUserByLastFmName: vi.fn(async () => opts.byLfmName ?? null),
  };
  const settingService = { getTimePeriod: vi.fn(() => ({ timePeriod: 'AllTime', description: 'Alltime', searchValue: '' })) };
  const playHistoryService = { getRecentArtistPlaycounts: vi.fn(async () => ({ week: 0, month: 0 })) };
  const artistsService = { searchArtist: vi.fn(async () => null) };
  const albumService = {};
  const trackService = {};
  const artworkService = {};
  const colorService = { getAccentColorAsync: vi.fn(async () => undefined) };
  const lastfmRepository = { getTopTracks: vi.fn(async () => []) };

  const commands = new PlaycountCommands(
    userService as never,
    settingService as never,
    playHistoryService as never,
    artistsService as never,
    albumService as never,
    trackService as never,
    artworkService as never,
    lastfmRepository as never,
    colorService as never,
    undefined,
  );
  return { commands, userService, artistsService, playHistoryService };
};

/** Reads the private resolver through the class, which is what commands do. */
const resolve = async (commands: PlaycountCommands, context: ContextModel, raw: string) => {
  const fn = (commands as unknown as {
    resolveTarget(c: ContextModel, r: string): Promise<Record<string, unknown>>;
  }).resolveTarget.bind(commands);
  return fn(context, raw);
};

describe('PlaycountCommands.resolveTarget', () => {
  it('refuses when the caller has never connected a Last.fm account', async () => {
    const { commands } = makeModule({ caller: null });
    const result = await resolve(commands, makeContext(), 'radiohead');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('defaults the target to the caller when no target syntax is present', async () => {
    const { commands } = makeModule();
    const result = await resolve(commands, makeContext(), 'radiohead');
    expect(result.isDifferentUser).toBe(false);
    expect(result.cleanSearchValue).toBe('radiohead');
    expect(result.displayName).toBe('Caller');
  });

  it('falls back to the Last.fm name when the context has no member', async () => {
    const { commands } = makeModule();
    const context = makeContext({ member: null as never });
    const result = await resolve(commands, context, '');
    expect(result.displayName).toBe('DreadRock');
  });

  it('redirects to a mentioned user and strips the mention from the search', async () => {
    const { commands, userService } = makeModule({ mentioned: makeUser({ userId: 2, userNameLastFm: 'Tycho' }) });
    const result = await resolve(commands, makeContext(), '<@333> spectral');
    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('333');
    expect(result.isDifferentUser).toBe(true);
    expect(result.displayName).toBe('<@333>');
    expect(result.cleanSearchValue).toBe('spectral');
  });

  it('accepts a nickname mention form, which Discord also sends', async () => {
    const { commands, userService } = makeModule({ mentioned: makeUser({ userId: 2 }) });
    await resolve(commands, makeContext(), '<@!333>');
    expect(userService.getUserByDiscordId).toHaveBeenCalledWith('333');
  });

  it('refuses a mention whose target has not registered', async () => {
    const { commands } = makeModule({ mentioned: null });
    const result = await resolve(commands, makeContext(), '<@333>');
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('treats a self-mention as not a different user', async () => {
    const { commands } = makeModule({ mentioned: makeUser({ userId: 1 }) });
    const result = await resolve(commands, makeContext(), '<@111>');
    expect(result.isDifferentUser).toBe(false);
  });

  it('resolves an lfm: prefix to a registered user', async () => {
    const { commands, userService } = makeModule({ byLfmName: makeUser({ userId: 3, userNameLastFm: 'Tycho' }) });
    const result = await resolve(commands, makeContext(), 'lfm:Tycho spectral');
    expect(userService.getUserByLastFmName).toHaveBeenCalledWith('Tycho');
    expect(result.isDifferentUser).toBe(true);
    expect(result.displayName).toBe('Tycho');
    expect(result.cleanSearchValue).toBe('spectral');
  });

  it('matches the lfm: prefix case-insensitively', async () => {
    const { commands, userService } = makeModule({ byLfmName: makeUser({ userId: 3 }) });
    await resolve(commands, makeContext(), 'LFM:Tycho');
    expect(userService.getUserByLastFmName).toHaveBeenCalledWith('Tycho');
  });

  it('gives an unregistered lfm: target the userId 0 sentinel', async () => {
    // userId 0 is what makes the play-count lookup skip instead of reading
    // the CALLER's own counts and attributing them to the named user.
    const { commands } = makeModule({ byLfmName: null });
    const result = await resolve(commands, makeContext(), 'lfm:ghost');
    expect((result.targetUser as User).userId).toBe(0);
    expect((result.targetUser as User).userNameLastFm).toBe('ghost');
    expect(result.isDifferentUser).toBe(true);
  });

  it('keeps the sentinel at 0 but preserves the caller session key', async () => {
    const { commands } = makeModule({ byLfmName: null });
    const result = await resolve(commands, makeContext(), 'lfm:ghost');
    expect((result.targetUser as User).sessionKey).toBe('SK');
  });

  it('collapses the runs of whitespace left behind by removing a target token', async () => {
    // The lfm branch does replace(/\s+/g, ' ') so interior runs go too, not
    // just the gap the removal created. Pinning the whole-string collapse
    // because an artist search is whitespace-insensitive only by luck.
    const { commands } = makeModule({ byLfmName: makeUser({ userId: 3 }) });
    const result = await resolve(commands, makeContext(), 'lfm:Tycho    spectral   bloom');
    expect(result.cleanSearchValue).toBe('spectral bloom');
  });

  it('collapses whitespace on the mention branch too', async () => {
    const { commands } = makeModule({ mentioned: makeUser({ userId: 2 }) });
    const result = await resolve(commands, makeContext(), '<@333>    spectral   bloom');
    expect(result.cleanSearchValue).toBe('spectral bloom');
  });

  it('leaves interior whitespace alone when no target token is present', async () => {
    const { commands } = makeModule();
    const result = await resolve(commands, makeContext(), 'spectral   bloom');
    expect(result.cleanSearchValue).toBe('spectral   bloom');
  });

  it('prefers a mention over an lfm: prefix when both are present', async () => {
    const { commands, userService } = makeModule({ mentioned: makeUser({ userId: 2 }), byLfmName: makeUser({ userId: 3 }) });
    const result = await resolve(commands, makeContext(), '<@333> lfm:Tycho');
    expect(userService.getUserByLastFmName).not.toHaveBeenCalled();
    expect((result.targetUser as User).userId).toBe(2);
  });

  it('does not treat a bare @word as a mention', async () => {
    const { commands } = makeModule();
    const result = await resolve(commands, makeContext(), 'hello@world');
    expect(result.isDifferentUser).toBe(false);
    expect(result.cleanSearchValue).toBe('hello@world');
  });
});

describe('PlaycountCommands command table', () => {
  it('registers every documented name and alias uniquely', () => {
    const { commands } = makeModule();
    const names = commands.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
  });

  // `recap` was a byte-identical delegate to `year`, and `rcp`/`wrapped` were
  // its aliases. All three were removed on the product owner's instruction.
  // This pins the deletion, and the survival of `year`, in both directions.
  it('no longer registers the recap duplicate of year or its aliases', () => {
    const { commands } = makeModule();
    const triggers = commands.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(triggers).not.toContain('recap');
    expect(triggers).not.toContain('rcp');
    expect(triggers).not.toContain('wrapped');
    expect(triggers).toContain('year');
  });

  it('routes artistplays and its alias to the same handler', async () => {
    const { commands, artistsService } = makeModule();
    artistsService.searchArtist.mockResolvedValue(null);
    const byName = commands.commands.find((c) => c.name === 'artistplays')!;
    const byAlias = commands.commands.find((c) => (c.aliases ?? []).includes('ap'))!;
    expect(byAlias).toBeDefined();
    const context = makeContext();
    await byName.executeAsync(context, ['radiohead']);
    await byAlias.executeAsync(context, ['radiohead']);
    expect(artistsService.searchArtist).toHaveBeenCalledTimes(2);
  });

  it('returns a not-found response when the artist search finds nothing', async () => {
    const { commands, artistsService } = makeModule();
    artistsService.searchArtist.mockResolvedValue(null);
    const cmd = commands.commands.find((c) => c.name === 'artistplays')!;
    const result = await cmd.executeAsync(makeContext(), ['zzzznotanartist']);
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('tolerates an empty args array rather than throwing', async () => {
    const { commands } = makeModule();
    const cmd = commands.commands.find((c) => c.name === 'artistplays')!;
    await expect(cmd.executeAsync(makeContext(), [])).resolves.toBeDefined();
  });
});
