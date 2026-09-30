import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { IntelligenceCommands } from './intelligenceCommands';
import { IntelligenceBuilders } from '@bot/builders/intelligenceBuilders';
import { DiscordConstants } from '@bot/resources/discordConstants';
import { CommandResponse } from '@domain/enums/commandResponse';
import { TimePeriod } from '@domain/enums/timePeriod';
import { SourceUnavailableError } from '@domain/models/sourceUnavailableError';
import type { TimeSettingsModel } from '@domain/models/timeSettings';
import type { ContextModel } from '@bot/models/contextModel';
import type { User } from '@domain/interfaces/iuserRepository';
import type { AffinityData } from '@bot/services/musicIntelligenceService';

/**
 * `.iceberg` and `.affinity` — the two commands that put GENERATED ARTWORK in a
 * Discord container.
 *
 * The interesting failures are all about what the card looks like when a piece
 * of the pipeline is missing, because each one has an obvious wrong answer:
 *
 *  - **No top artists.** `getIceberg` would happily tier an empty list, and the
 *    card would read as a judgement that the user has no taste. The command
 *    refuses before calling it.
 *  - **The image generator raises.** A failed PNG must not fail the command —
 *    the tier text is real data and was already computed — but the card must go
 *    out with no attachment rather than a broken one.
 *  - **No generator wired at all.** The collaborator is optional in the
 *    constructor, so this is a live branch, not dead defensive code.
 *
 * `.affinity` adds a guild-only guard that fires BEFORE the target is resolved,
 * so a DM costs no database round trip, and a guild with no similar listeners is
 * a real answer rather than a reason to error.
 */

type TopArtistLike = { name: string; playcount: number };

const caller = (over: Partial<User> = {}): User =>
  ({
    userId: 1,
    discordUserId: '111',
    userNameLastFm: 'Alpha',
    sessionKey: 'SK',
    lastUpdate: new Date(),
    ...over,
  }) as User;

/**
 * A guild context. `iconUrl` is an override so a test can put the server in the
 * "no icon" state — `affinityAsync` reads `context.guild.iconURL()` to decide
 * whether it can colour from the server icon at all, so a double that always
 * returns one can never reach the fallback branch.
 */
const ctx = (over: Record<string, unknown> = {}): ContextModel => {
  const { iconUrl, ...rest } = over;
  return ({
    discordUserId: '111',
    guildId: '222',
    prefix: '.',
    discordDisplayName: 'Caller',
    guild: {
      id: '222',
      name: 'Test Guild',
      iconURL: () => (iconUrl === undefined ? 'https://img/guild.png' : iconUrl),
    },
    member: { displayName: 'Caller' },
    ...rest,
  }) as unknown as ContextModel;
};

const dmCtx = () => ctx({ guildId: undefined, guild: null });

const settings = (over: Partial<TimeSettingsModel> = {}): TimeSettingsModel =>
  ({ timePeriod: TimePeriod.AllTime, description: 'Alltime', searchValue: '', ...over }) as TimeSettingsModel;

const affinityData = (over: Partial<AffinityData> = {}): AffinityData => ({
  userDisplayName: 'Caller',
  userNameLastFm: 'Alpha',
  guildName: 'Test Guild',
  neighbors: [
    {
      userId: 2,
      discordUserId: '222',
      userNameLastFm: 'Beta',
      displayName: 'Beta',
      totalPercentage: 62,
      artistPercentage: 70,
      genrePercentage: 55,
      countryPercentage: 40,
      sharedArtists: ['Boards of Canada'],
    },
  ],
  totalGuildUsers: 8,
  ...over,
});

type Over = {
  caller?: User | null;
  mentioned?: User | null;
  /** What `getUserByLastFmName` resolves. `null` (the default) = an account the bot has never indexed. */
  byLfmName?: User | null;
  topArtists?: unknown[] | null;
  generateThrows?: unknown;
  withGenerator?: boolean;
  artUrl?: string | null;
  iconUrl?: string | null;
  affinity?: AffinityData;
  affinityRaise?: unknown;
  timeSettings?: TimeSettingsModel;
  /** What `extractAccentColor` reports for a generated image. */
  imageAccent?: number;
};

const build = (over: Over = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async (...a: unknown[]) => {
      const id = a[0] as string;
      if (id !== '111') return (over.mentioned ?? null) as User | null;
      return over.caller === undefined ? caller() : over.caller;
    }),
    getUserByLastFmName: vi.fn(async () => (over.byLfmName ?? null) as User | null),
  };
  const settingService = { getTimePeriod: vi.fn(() => (over.timeSettings as TimeSettingsModel) ?? settings()) };
  const lastfmRepository = {
    getTopArtists: vi.fn(async (..._a: unknown[]) =>
      (over.topArtists === undefined ? [{ name: 'Radiohead', playcount: 900 }] : over.topArtists) as
        | TopArtistLike[]
        | null,
    ),
  };
  const intelligenceService = {
    // Echoes the labels it was handed, so a test can tell whose card this is
    // rather than reading a fixed stub.
    getIceberg: vi.fn(async (...a: unknown[]) => ({
      displayName: a[2] as string,
      userNameLastFm: a[3] as string,
      timePeriodDescription: a[4] as string,
      tiers: [{ tierNumber: 1, name: 'Mainstream', emoji: '🧊', description: 'Everyone knows these', artists: [] }],
      totalArtists: 1,
    })),
    getGuildAffinity: vi.fn(async (..._a: unknown[]) => {
      if (over.affinityRaise) throw over.affinityRaise;
      return over.affinity ?? affinityData();
    }),
  };
  const colorService = {
    getColorFromImageUrl: vi.fn(async (..._a: unknown[]) => 0x445566),
    extractAccentColor: vi.fn(async () =>
      over.imageAccent === undefined ? 0x778899 : over.imageAccent,
    ),
  };
  const icebergGenerator = {
    generateIceberg: vi.fn(async (..._a: unknown[]) => {
      if (over.generateThrows) throw over.generateThrows;
      return Buffer.from('iceberg');
    }),
  };
  const artworkService = {
    getArtistImageUrl: vi.fn(async (..._a: unknown[]) => (over.artUrl === undefined ? 'https://img/artist.png' : over.artUrl)),
  };

  const commands = new IntelligenceCommands(
    userService as never,
    settingService as never,
    lastfmRepository as never,
    intelligenceService as never,
    colorService as never,
    over.withGenerator === false ? undefined : (icebergGenerator as never),
    artworkService as never,
  );
  return { commands, userService, settingService, lastfmRepository, intelligenceService, colorService, artworkService, icebergGenerator,
    // A context matching THIS build's `over.iconUrl`, so the knob is wired to
    // the context double rather than declared and ignored.
    ctx: (extra: Record<string, unknown> = {}) => ctx({ iconUrl: over.iconUrl, ...extra }),
  };
};

const priv = (c: IntelligenceCommands) =>
  c as unknown as Record<string, (...a: unknown[]) => Promise<{ commandResponse: CommandResponse }>>;

const iceberg = (c: IntelligenceCommands, raw: string, context: ContextModel = ctx()) =>
  priv(c)['icebergAsync']!.bind(c)(context, raw);
const affinity = (c: IntelligenceCommands, raw: string, context: ContextModel = ctx()) =>
  priv(c)['affinityAsync']!.bind(c)(context, raw);

const icebergParams = () => vi.mocked(IntelligenceBuilders.buildIcebergResponse).mock.calls[0]![0];
const affinityParams = () => vi.mocked(IntelligenceBuilders.buildAffinityResponse).mock.calls[0]![0];

const dbDown = (method: string) => new SourceUnavailableError(method, new Error('db down'), 'Database unavailable');

const desc = (r: unknown): string => (r as { embed: { data: { description?: string } } }).embed.data.description ?? '';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(IntelligenceBuilders, 'buildIcebergResponse').mockReturnValue({ marker: 'iceberg' } as never);
  vi.spyOn(IntelligenceBuilders, 'buildAffinityResponse').mockReturnValue({ marker: 'affinity' } as never);
});

describe('.iceberg — an empty library is not a taste judgement', () => {
  it('refuses when Last.fm has no top artists at all', async () => {
    const { commands, intelligenceService } = build({ topArtists: [] });

    const result = await iceberg(commands, '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result)).toContain('No top artists');
    // Tiering an empty list would render "your top 0 artists" as a verdict.
    expect(intelligenceService.getIceberg).not.toHaveBeenCalled();
    expect(IntelligenceBuilders.buildIcebergResponse).not.toHaveBeenCalled();
  });

  it('reports the same for a Last.fm read that answered with nothing', async () => {
    const { commands } = build({ topArtists: null });

    const result = await iceberg(commands, '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
  });

  it('refuses an unregistered caller before asking Last.fm anything', async () => {
    const { commands, lastfmRepository } = build({ caller: null });

    const result = await iceberg(commands, '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
  });

  it('sends the session key so a private library still counts', async () => {
    const { commands, lastfmRepository } = build({ caller: caller({ sessionKey: 'PRIVATE' }) });

    await iceberg(commands, '');

    expect(lastfmRepository.getTopArtists).toHaveBeenCalledWith('Alpha', TimePeriod.AllTime, 100, 1, 'PRIVATE');
  });

  it('hands the tierer names and counts only', async () => {
    // The raw Last.fm rows carry image urls and mbids. Passing the whole object
    // through would leak more of the provider's response into the tierer than
    // the classifier is documented to read.
    const { commands, intelligenceService } = build();

    await iceberg(commands, '');

    const [userId, artists] = (intelligenceService.getIceberg as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(userId).toBe(1);
    expect(artists).toEqual([{ name: 'Radiohead', playcount: 900 }]);
  });

  it('passes the resolved period through to both the read and the classifier', async () => {
    const { commands, intelligenceService, lastfmRepository } = build({
      timeSettings: settings({ timePeriod: TimePeriod.Yearly, description: 'Yearly' }),
    });

    await iceberg(commands, 'yearly');

    expect(lastfmRepository.getTopArtists).toHaveBeenCalledWith('Alpha', TimePeriod.Yearly, 100, 1, 'SK');
    expect((intelligenceService.getIceberg as ReturnType<typeof vi.fn>).mock.calls[0]![4]).toBe('Yearly');
  });
});

describe('.iceberg — the image is decoration and must stay that way', () => {
  it('attaches the generated image when the generator works', async () => {
    const { commands, icebergGenerator } = build();

    await iceberg(commands, '');

    expect(icebergGenerator.generateIceberg).toHaveBeenCalledTimes(1);
    expect(icebergParams().imageBuffer).toEqual(Buffer.from('iceberg'));
  });

  it('still returns the card, without an image, when the generator raises', async () => {
    // The tier text was already computed from real data, so failing the whole
    // command over a PNG would throw away a correct answer.
    const { commands } = build({ generateThrows: new Error('puppeteer crashed') });

    const result = await iceberg(commands, '');

    expect(result).toEqual({ marker: 'iceberg' });
    expect(icebergParams().imageBuffer).toBeNull();
  });

  it('still returns the card when no generator is wired at all', async () => {
    const { commands } = build({ withGenerator: false });

    const result = await iceberg(commands, '');

    expect(result).toEqual({ marker: 'iceberg' });
    expect(icebergParams().imageBuffer).toBeNull();
  });

  it('colours from the image itself when there is one', async () => {
    const { commands, colorService, artworkService } = build();

    await iceberg(commands, '');

    expect(colorService.extractAccentColor).toHaveBeenCalledWith(Buffer.from('iceberg'));
    // The image already decided the colour, so a second art lookup would be
    // decorative noise on the command boundary.
    expect(artworkService.getArtistImageUrl).not.toHaveBeenCalled();
  });

  it('falls back to the top artist when the image yields the default colour', async () => {
    const { commands, artworkService } = build({ imageAccent: DiscordConstants.LastFmColorRed });

    await iceberg(commands, '');

    expect(artworkService.getArtistImageUrl).toHaveBeenCalledWith('Radiohead');
    expect(icebergParams().accentColor).toBe(0x445566);
  });

  it('keeps the default colour when the top artist has no image either', async () => {
    const { commands } = build({ artUrl: null, imageAccent: DiscordConstants.LastFmColorRed });

    await iceberg(commands, '');

    expect(icebergParams().accentColor).toBe(DiscordConstants.LastFmColorRed);
  });

  it('labels the card with the target, not the caller who asked', async () => {
    const { commands } = build({ mentioned: caller({ userId: 7, discordUserId: '999', userNameLastFm: 'Beta' }) });

    await iceberg(commands, '<@999>');

    expect(icebergParams().data.displayName).toBe('Beta');
  });

  it('REFUSES a mention that resolves to nobody, rather than iceberging the caller', async () => {
    // The same refusal `playcountCommands` and the genre family make. Dropping
    // the mention answered with the caller's own top artists under the caller's
    // own name, so the card looked correct and was about the wrong person.
    const { commands, lastfmRepository, icebergGenerator } = build({ mentioned: null });

    const result = await iceberg(commands, '<@333>');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result)).toContain('<@333>');
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
    expect(icebergGenerator.generateIceberg).not.toHaveBeenCalled();
    expect(IntelligenceBuilders.buildIcebergResponse).not.toHaveBeenCalled();
  });
});

describe('.affinity — guild only, and the guard costs nothing', () => {
  it('refuses outside a server', async () => {
    const { commands, userService, intelligenceService } = build();

    const result = await affinity(commands, '', dmCtx());

    expect(result.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    // The guild check runs BEFORE the target is resolved, so a DM costs no user
    // lookup and no affinity query at all.
    expect(userService.getUserByDiscordId).not.toHaveBeenCalled();
    expect(intelligenceService.getGuildAffinity).not.toHaveBeenCalled();
  });

  it('tolerates a context with a guild id but no guild object', async () => {
    const { commands, intelligenceService } = build();

    const result = await affinity(commands, '', ctx({ guild: null }));

    expect(result).toEqual({ marker: 'affinity' });
    // "this server" is the fallback in the query itself, so the card does not
    // read `null` as the server's name.
    expect((intelligenceService.getGuildAffinity as ReturnType<typeof vi.fn>).mock.calls[0]![4]).toBe('this server');
  });

  it('passes the guild and the caller through to the query', async () => {
    const { commands, intelligenceService } = build();

    await affinity(commands, '');

    expect(intelligenceService.getGuildAffinity).toHaveBeenCalledWith('222', 1, 'Caller', 'Alpha', 'Test Guild');
  });

  it('asks about the mentioned user, not the caller', async () => {
    const { commands, intelligenceService } = build({
      mentioned: caller({ userId: 7, discordUserId: '999', userNameLastFm: 'Beta' }),
    });

    await affinity(commands, '<@999>');

    expect((intelligenceService.getGuildAffinity as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(7);
    expect(affinityParams().targetDiscordId).toBe('999');
    expect(affinityParams().callerDiscordId).toBe('111');
  });

  it('refuses an unregistered caller', async () => {
    const { commands, intelligenceService } = build({ caller: null });

    const result = await affinity(commands, '');

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(intelligenceService.getGuildAffinity).not.toHaveBeenCalled();
  });

  it('lets a failed query raise rather than claiming nobody here is similar', async () => {
    const { commands } = build({ affinityRaise: dbDown('getGuildAffinity') });

    await expect(affinity(commands, '')).rejects.toThrow(/Database unavailable/);
    expect(IntelligenceBuilders.buildAffinityResponse).not.toHaveBeenCalled();
  });
});

describe('.affinity — nobody similar is a real answer', () => {
  const nobody = affinityData({ neighbors: [] });

  it('renders the empty card for a guild with no similar listeners', async () => {
    const { commands } = build({ affinity: nobody });

    const result = await affinity(commands, '');

    expect(result).toEqual({ marker: 'affinity' });
    expect(affinityParams().data.neighbors).toEqual([]);
  });

  it('makes no shared-artist lookup when there is no neighbour to borrow art from', async () => {
    const { commands, artworkService, ctx: buildCtx } = build({ affinity: nobody, iconUrl: null });

    await affinity(commands, '', buildCtx());

    expect(artworkService.getArtistImageUrl).not.toHaveBeenCalled();
    expect(affinityParams().accentColor).toBe(DiscordConstants.LastFmColorRed);
  });

  it('colours from the server icon when there is one', async () => {
    const { commands, colorService, artworkService } = build();

    await affinity(commands, '');

    expect(colorService.getColorFromImageUrl).toHaveBeenCalledWith('https://img/guild.png');
    expect(artworkService.getArtistImageUrl).not.toHaveBeenCalled();
  });

  it('borrows the closest neighbour’s shared artist when there is no icon', async () => {
    const { commands, artworkService, ctx: buildCtx } = build({ iconUrl: null });

    await affinity(commands, '', buildCtx());

    expect(artworkService.getArtistImageUrl).toHaveBeenCalledWith('Boards of Canada');
    expect(affinityParams().accentColor).toBe(0x445566);
  });

  it('does not borrow art when the icon already decided the colour', async () => {
    const { commands, artworkService } = build();

    await affinity(commands, '');

    expect(artworkService.getArtistImageUrl).not.toHaveBeenCalled();
  });
});

describe('.affinity — an `lfm:` target the bot has no index for is REFUSED', () => {
  // `getGuildAffinity` excludes the target BY `userId` and reads the target's top
  // artists BY `userId`. The `userId: 0` sentinel the unindexed-name path builds
  // is what stopped the caller's rows leaking under a stranger's name, and it is
  // also why the card cannot be trusted: an empty target profile zeroes
  // `artistScore` for every neighbour, and `totalGuildUsers` stays real, so the
  // card renders a full table of real people, every number wrong, sorted by
  // those wrong numbers — reading as "nobody in this server has a similar
  // taste". `.gaps` and `.discoveries` already refuse in this shape; the third
  // index-keyed command has to refuse the same way or the family is two-thirds
  // fixed.
  it('refuses the same way `.gaps` does, naming the target and the reason', async () => {
    const { commands, userService, intelligenceService } = build({ byLfmName: null });

    const result = await affinity(commands, 'lfm:stranger');

    // Same response shape as `.gaps`: an error embed carrying NotFound, not a
    // card. A `toBeDefined()` here would pass on any response at all.
    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(desc(result)).toContain('stranger');
    // The refusal has to state the reason, or the user reads "no such command".
    expect(desc(result)).toContain('no indexed listening history');
    expect(userService.getUserByLastFmName).toHaveBeenCalledWith('stranger');
    // The neighbour query never runs — this is the whole point. Running it
    // costs a `guildUser` scan plus two `userArtist` reads and produces a table
    // of fabricated zeros about real neighbours.
    expect(intelligenceService.getGuildAffinity).not.toHaveBeenCalled();
    expect(IntelligenceBuilders.buildAffinityResponse).not.toHaveBeenCalled();
  });

  it('refuses through an alias too — the guard is in the body, not the trigger', async () => {
    const { commands, intelligenceService } = build({ byLfmName: null });
    const cmd = commands.commands.find((c) => c.name === 'affinity')!;

    // A value assertion on the trigger surface, not `toBeDefined()`: this test
    // is about the refusal being wired into the body, so it has to be
    // trigger-independent.
    expect(cmd.aliases).toEqual(['n', 'aff', 'neighbors', 'soulmates', 'neighbours']);

    const result = (await cmd.executeAsync(ctx(), ['lfm:stranger'])) as unknown as {
      commandResponse: CommandResponse;
    };

    expect(result.commandResponse).toBe(CommandResponse.NotFound);
    expect(intelligenceService.getGuildAffinity).not.toHaveBeenCalled();
  });

  it('still asks about a REGISTERED `lfm:` target, under that account\'s own id', async () => {
    // The direction that keeps the refusal specific rather than blanket: refusing
    // every `lfm:` name would be a different bug, and a silent one.
    const { commands, intelligenceService } = build({
      byLfmName: caller({ userId: 42, discordUserId: '888', userNameLastFm: 'Beta' }),
    });

    const result = await affinity(commands, 'lfm:Beta');

    expect(result).toEqual({ marker: 'affinity' });
    expect(intelligenceService.getGuildAffinity).toHaveBeenCalledWith('222', 42, 'Beta', 'Beta', 'Test Guild');
  });

  it('leaves `.iceberg` alone: the same unindexed name still gets an iceberg', async () => {
    // The control. `getIceberg` classifies artists by catalogue popularity and
    // never reads a user id (its parameter is `_userId`), so an unlinked `lfm:`
    // name is a real Last.fm account to it and the card is honest. A blanket
    // refusal in this module would break a command that works.
    const { commands, lastfmRepository, intelligenceService } = build({ byLfmName: null });

    const result = await iceberg(commands, 'lfm:stranger');

    expect(result).toEqual({ marker: 'iceberg' });
    // Last.fm was asked about the NAME, not about the sentinel account.
    expect(lastfmRepository.getTopArtists).toHaveBeenCalledWith('stranger', TimePeriod.AllTime, 100, 1, 'SK');
    const [userId, , displayName, userNameLastFm] = (intelligenceService.getIceberg as ReturnType<typeof vi.fn>)
      .mock.calls[0]!;
    expect(userId).toBe(0);
    expect(displayName).toBe('stranger');
    expect(userNameLastFm).toBe('stranger');
    expect(IntelligenceBuilders.buildIcebergResponse).toHaveBeenCalledTimes(1);
  });
});

describe('the iceberg and affinity triggers reach those bodies through the registry', () => {
  it('routes every iceberg alias to the same body', async () => {
    // The mention in the third call has to RESOLVE: an unresolvable mention is
    // refused now (see the file's own test above), so leaving it in would make
    // this a test of the refusal with an alias-routing label on it.
    const { commands, icebergGenerator } = build({
      mentioned: caller({ userId: 7, discordUserId: '999', userNameLastFm: 'Beta' }),
    });
    const cmd = commands.commands.find((c) => c.name === 'iceberg')!;
    expect(cmd.aliases).toEqual(['ice', 'icebergify', 'berg']);

    for (const args of [[], ['yearly'], ['<@999>'], []]) {
      await cmd.executeAsync(ctx(), args);
    }

    expect(icebergGenerator.generateIceberg).toHaveBeenCalledTimes(4);
  });

  it('routes `n` to the affinity body', async () => {
    const { commands, intelligenceService } = build();
    const cmd = commands.commands.find((c) => c.name === 'affinity')!;
    expect(cmd.aliases).toContain('n');

    await cmd.executeAsync(ctx(), []);

    expect(intelligenceService.getGuildAffinity).toHaveBeenCalledTimes(1);
  });

  it('gives every trigger in this module a unique name', () => {
    const { commands } = build();
    const triggers = commands.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(new Set(triggers).size).toBe(triggers.length);
  });
});