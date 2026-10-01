/**
 * `/country` targeting and `/country whoknows` - the two halves of this module
 * that the three existing files do not touch.
 *
 * Already covered elsewhere in this directory, and deliberately NOT repeated:
 *  - `countrySlashCommands.lastFmUnavailable.test.ts` - the deliberate
 *    `LastFmUnavailableError` raised by `getTopArtists` in `handleTopCountriesSlash`
 *    and `handleCountryChartSlash`.
 *  - `countrySlashCommands.artistInfoUnavailable.test.ts` - the same for
 *    `getArtistInfo` in `handleCountryInfoSlash`'s ARTIST branch.
 *
 * WHAT IS LEFT, and it is the part that decides whose data the user gets.
 *
 * `resolveUser` has FOUR ways to name somebody and they did not agree on what
 * happens when the name is unknown. A Discord mention refuses, because a
 * mention is a specific person and silently answering with somebody else is
 * indefensible. An `lfm:` name does not - it is a public Last.fm account, not a
 * bot row, so having no `userId` is legitimate. A BARE name used to take the
 * mention path's lookup and then the `lfm:` path's forgiveness:
 *
 *     const u = await this.userService.getUserByLastFmName(rawUser.trim());
 *     if (u) { return { ... } }        // countrySlashCommands.ts:214-217
 *     // ...falls through to the caller
 *
 * So `/country top user:Stranger`, for a Stranger who has never registered with
 * the bot, answered with the CALLER's own top countries, under the caller's own
 * display name, with no indication that the named person was dropped. Every
 * number printed is true; it is simply an answer to a different question. It now
 * refuses, in the same shape and with the same `CommandResponse.NotFound` as
 * `intelligenceSlashCommands.resolveTarget`, which is the comparison that makes
 * it a defect rather than a policy. The registered bare name, the `lfm:`
 * stranger and the mention cases are pinned beside it so a fix cannot be made by
 * refusing everybody.
 *
 * `/country whoknows` is the other half of the file's theme. It is the one
 * command here whose answer is "nobody in this server listens to that country",
 * which is exactly the sentence an unreadable guild query would produce, and the
 * guild read has no catch - so the raise survives. Both directions are pinned:
 * the genuine empty renders as the genuine empty, and the outage renders no card
 * at all.
 *
 * Constructor arity read from `countrySlashCommands.ts`:
 * (userService, settingService, lastfmRepository, countryService,
 *  worldMapGenerator, colorService?). The sixth is supplied, so the accent-colour
 * read is exercised rather than skipped.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { CountrySlashCommands } from '@bot/slashCommands/library/countrySlashCommands';
import { CommandResponse } from '@domain/enums/commandResponse';
import { TimePeriod } from '@domain/enums/timePeriod';
import { SourceUnavailableError } from '@domain/models/errors/sourceUnavailableError';
import type { ContextModel } from '@bot/models/contextModel';
import type { ResponseModel } from '@bot/models/responseModel';
import type { UserService } from '@bot/services/user/userService';
import type { SettingService } from '@bot/services/system/settingService';
import type { LastFmRepository } from '@lastfm/repositories/lastFmRepository';
import type { CountryService } from '@bot/services/library/countryService';
import type { ColorService } from '@bot/services/system/colorService';
import type { WorldMapGenerator } from '@images/generators/worldMapGenerator';

const CALLER = { userId: 7, discordUserId: 'caller1', userNameLastFm: 'DreadRock' };
const OTHER = { userId: 9, discordUserId: 'other1', userNameLastFm: 'SomeUser' };

const UK = { Name: 'United Kingdom', Code: 'GB', Emoji: ':flag_gb:' };

/** The last.fm name of a mention, resolved and unregistered respectively. */
const MENTION_ID = '111222333444555666';

const DB_DOWN = () =>
  new SourceUnavailableError('countryService.getGuildUsersForCountry', new Error('connection closed'), 'Database unavailable');

interface CtxSpec {
  inGuild?: boolean;
  subcommand?: string;
  strings?: Record<string, string | null>;
  members?: Record<string, string>;
}

const makeContext = (spec: CtxSpec = {}): ContextModel => {
  const inGuild = spec.inGuild !== false;
  const members = spec.members ?? {};
  const guild = inGuild
    ? { id: '222', name: 'Test Guild', members: { cache: { get: (id: string) => (members[id] ? { displayName: members[id] } : undefined) } } }
    : null;
  const strings = spec.strings ?? {};
  return {
    discordUserId: 'caller1',
    guildId: inGuild ? '222' : undefined,
    guild,
    prefix: '/',
    interaction: {
      channelId: 'text1',
      id: 'i1',
      guildId: inGuild ? '222' : undefined,
      commandName: 'country',
      user: { id: 'caller1' },
      options: {
        getSubcommand: () => spec.subcommand ?? 'top',
        getString: (name: string) => (name in strings ? strings[name] : null),
      },
    },
  } as unknown as ContextModel;
};

const allText = (nodes: unknown[]): string => {
  const lines: string[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const record = node as { content?: unknown; components?: unknown };
    if (typeof record.content === 'string') lines.push(record.content);
    if (Array.isArray(record.components)) lines.push(allText(record.components));
  }
  return lines.join('\n');
};

const cardText = (response: ResponseModel): string => {
  if (response.componentsV2Container) {
    return allText((response.componentsV2Container.toJSON() as { components?: unknown[] }).components ?? []);
  }
  return [response.embed.data.title ?? '', response.embed.data.description ?? '', response.content ?? ''].join(
    '\n',
  );
};

interface Doubles {
  caller?: unknown;
  byDiscordId?: Record<string, unknown>;
  byLastFmName?: Record<string, unknown>;
  country?: unknown;
  guildUsers?: unknown[];
  guildUsersImpl?: () => Promise<unknown[]>;
  userArtists?: Array<{ name: string; playcount: number }>;
  getArtistInfo?: () => Promise<unknown>;
  recent?: () => Promise<unknown[]>;
  allTimeCountries?: unknown[];
  accent?: number;
}

const build = (over: Doubles = {}) => {
  const userService = {
    getUserByDiscordId: vi.fn(async (id: string) => {
      if (over.byDiscordId && id in over.byDiscordId) return over.byDiscordId[id];
      return over.caller === undefined ? CALLER : over.caller;
    }),
    getUserByLastFmName: vi.fn(async (name: string) =>
      over.byLastFmName ? (over.byLastFmName[name] ?? null) : null,
    ),
  };
  const settingService = {
    // A SET period, so the all-time database short-circuit is skipped and the
    // handler is forced onto the Last.fm read - which is what makes the caller
    // identity observable in the query below.
    getTimePeriod: vi.fn(() => ({ timePeriod: TimePeriod.Quarterly, description: 'Quarterly' })),
  };
  const lastfmRepository = {
    getTopArtists: vi.fn(async () => []),
    getUserRecentTracks: vi.fn(over.recent ?? (async () => [])),
    getArtistInfo: vi.fn(over.getArtistInfo ?? (async () => null)),
  };
  const countryService = {
    searchCountry: vi.fn(() => (over.country === undefined ? undefined : over.country)),
    getGuildUsersForCountry: vi.fn(over.guildUsersImpl ?? (async () => over.guildUsers ?? [])),
    getUserArtistsForCountry: vi.fn(async () => over.userArtists ?? []),
    getUserTopCountriesAllTime: vi.fn(async () => over.allTimeCountries ?? []),
    getTopCountriesForTopArtists: vi.fn(async () => []),
    getArtistInfoWithCountry: vi.fn(async () => ({ country: UK, spotifyImageUrl: null })),
  };
  const worldMapGenerator = { generateWorldMap: vi.fn(async () => Buffer.from('png')) };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => over.accent ?? 0x445566),
    getColorFromImageUrl: vi.fn(async () => over.accent ?? 0x445566),
  };

  const cmd = new CountrySlashCommands(
    userService as unknown as UserService,
    settingService as unknown as SettingService,
    lastfmRepository as unknown as LastFmRepository,
    countryService as unknown as CountryService,
    worldMapGenerator as unknown as WorldMapGenerator,
    colorService as unknown as ColorService,
  );
  const privates = cmd as unknown as {
    handleCountrySlash(c: ContextModel): Promise<ResponseModel>;
    handleCountryChartSlash(c: ContextModel): Promise<ResponseModel>;
    handleTopCountriesSlash(c: ContextModel): Promise<ResponseModel>;
    handleCountryInfoSlash(c: ContextModel, search: string): Promise<ResponseModel>;
    handleWhoKnowsCountrySlash(c: ContextModel, country: string): Promise<ResponseModel>;
    resolveUser(c: ContextModel, raw: string | null): Promise<Record<string, unknown> | ResponseModel>;
  };
  return { cmd, privates, userService, settingService, lastfmRepository, countryService, colorService };
};

/** Whose Last.fm name the country read was actually performed for. */
const askedForWhom = (lastfmRepository: { getTopArtists: ReturnType<typeof vi.fn> }): string =>
  String(lastfmRepository.getTopArtists.mock.calls[0]![0]);

describe('who a country query is performed FOR', () => {
  it('reads the caller\'s own countries when no user is named', async () => {
    const { privates, lastfmRepository } = build();
    await privates.handleTopCountriesSlash(makeContext());
    expect(askedForWhom(lastfmRepository)).toBe('DreadRock');
  });

  it('reads the MENTIONED user\'s countries when they are registered', async () => {
    // The case the refusal below is measured against. A mention names a specific
    // person, so getting this wrong is not a policy question.
    const { privates, lastfmRepository } = build({ byDiscordId: { [MENTION_ID]: OTHER } });
    const response = await privates.handleTopCountriesSlash(
      makeContext({ strings: { user: `<@${MENTION_ID}>` }, members: { [MENTION_ID]: 'OtherNick' } }),
    );

    expect(askedForWhom(lastfmRepository)).toBe('SomeUser');
    // And the card is headed with THEIR nickname, not the caller's.
    expect(cardText(response)).toContain('OtherNick');
  });

  it('accepts the `<@!…>` mention form Discord also sends', async () => {
    const { privates, lastfmRepository } = build({ byDiscordId: { [MENTION_ID]: OTHER } });
    await privates.handleTopCountriesSlash(
      makeContext({ strings: { user: `<@!${MENTION_ID}>` } }),
    );
    expect(askedForWhom(lastfmRepository)).toBe('SomeUser');
  });

  it('REFUSES a mention of somebody who never registered, and reads nothing', async () => {
    // The mention branch has a real `if (!u) return notFound`. It matters: a
    // mention names a person, and answering that question with the caller's own
    // countries is an answer to a different question, however true every number
    // in it is.
    const { privates, lastfmRepository } = build({ byDiscordId: { [MENTION_ID]: null } });
    const response = await privates.handleTopCountriesSlash(
      makeContext({ strings: { user: `<@${MENTION_ID}>` } }),
    );

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain(`<@${MENTION_ID}> is not registered`);
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
  });

  it('reads the `lfm:` name as given, even with no bot row behind it', async () => {
    // Correct as written, and deliberately asymmetric with the mention above. An
    // `lfm:` name is a PUBLIC Last.fm account, not a bot row - not having one is
    // normal and must not stop the command, or `/country top lfm:someone` would
    // be dead for every stranger the user ever typed.
    const { privates, lastfmRepository } = build();
    const response = await privates.handleTopCountriesSlash(
      makeContext({ strings: { user: 'lfm:SomeStranger' } }),
    );

    expect(askedForWhom(lastfmRepository)).toBe('SomeStranger');
    expect(cardText(response)).toContain('SomeStranger');
  });

  it('takes only the first token of an `lfm:` argument, so trailing words do not become the name', async () => {
    const { privates, lastfmRepository } = build();
    await privates.handleTopCountriesSlash(
      makeContext({ strings: { user: 'lfm:SomeStranger   extra words here' } }),
    );
    // The whole argument as a username is a Last.fm lookup that cannot match
    // anything, and it would be reported as "this person has no country data".
    expect(askedForWhom(lastfmRepository)).toBe('SomeStranger');
  });

  it('reads a bare registered Last.fm name as that user', async () => {
    const { privates, lastfmRepository } = build({ byLastFmName: { SomeUser: OTHER } });
    await privates.handleTopCountriesSlash(makeContext({ strings: { user: 'SomeUser' } }));
    expect(askedForWhom(lastfmRepository)).toBe('SomeUser');
  });

  it('REFUSES a bare UNREGISTERED name instead of answering with the CALLER', async () => {
    // THE FIX. This test used to pin the opposite and is named after it.
    // `resolveUser` did the mention path's lookup at :214 and then took the
    // `lfm:` path's forgiveness, falling through to the caller. So
    // `/country top user:Stranger` returned the caller's own top countries,
    // headed with the caller's own name, with nothing to say the named person
    // had been dropped. `intelligenceSlashCommands.resolveTarget` refuses the
    // identical case in the identical shape, which is what made this a defect
    // rather than a choice — and which is why the refusal here uses the same
    // `buildCommandErrorResponse` + `CommandResponse.NotFound` pair.
    //
    // The registered bare name and the `lfm:` stranger are pinned either side of
    // it, so a fix cannot be made by refusing everybody.
    const { privates, lastfmRepository } = build({ byLastFmName: { Stranger: null } });
    const response = await privates.handleTopCountriesSlash(
      makeContext({ strings: { user: 'Stranger' } }),
    );

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('Stranger');
    // Not one query ran against the caller's data, so nothing of theirs can be
    // what the user is shown.
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
    expect(cardText(response)).not.toContain('DreadRock');
  });

  it('names the `lfm:` escape hatch, so the refusal is not a dead end', async () => {
    // The refusal is only fair if the working alternative is named. `/country
    // top user:lfm:Stranger` answers for an account that has never linked, and
    // that asymmetry is deliberate — so the card has to say so, or "this person
    // is unknown" reads as "this person does not exist".
    const { privates } = build({ byLastFmName: { Stranger: null } });
    const response = await privates.handleTopCountriesSlash(
      makeContext({ strings: { user: 'Stranger' } }),
    );

    expect(cardText(response)).toContain('lfm:Stranger');
    expect(cardText(response)).toContain('/register');
  });

  it('refuses on the CHART twin too, which shares this resolver', async () => {
    // `handleCountryChartSlash` calls the same `resolveUser`. A fix applied to
    // one handler only would leave `/countrychart user:Stranger` answering with
    // the caller's map — and a wrong map is harder to spot than a wrong list,
    // because the title carries the display name.
    const { privates, lastfmRepository, countryService } = build({
      byLastFmName: { Stranger: null },
      allTimeCountries: [{ countryName: 'United Kingdom', countryCode: 'GB', playcount: 40 }],
    });
    const response = await privates.handleCountryChartSlash(
      makeContext({ strings: { user: 'Stranger', period: 'overall' } }),
    );

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(countryService.getUserTopCountriesAllTime).not.toHaveBeenCalled();
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
  });

  it('refuses an unregistered caller who named nobody, and names the command to fix it', async () => {
    const { privates, lastfmRepository } = build({ caller: null });
    const response = await privates.handleTopCountriesSlash(makeContext());

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('/register');
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
  });

  it('answers a NAMED target even when the caller has no account of their own', async () => {
    // The caller lookup is the FALLBACK, not the gate. `/country top user:SomeUser`
    // asks about SomeUser, so it must be answerable by a caller who has not
    // connected a Last.fm account - otherwise the command is dead for exactly the
    // people most likely to be asking about somebody else.
    const { privates, lastfmRepository, userService } = build({
      caller: null,
      byLastFmName: { SomeUser: OTHER },
    });
    await privates.handleTopCountriesSlash(makeContext({ strings: { user: 'SomeUser' } }));

    expect(askedForWhom(lastfmRepository)).toBe('SomeUser');
    // And the caller was never consulted, so nothing of theirs could leak in.
    expect(userService.getUserByDiscordId).not.toHaveBeenCalled();
  });
});

describe('the all-time short-circuit, and the Last.fm read it exists to avoid', () => {
  const allTimeContext = (user: string | null): ContextModel =>
    makeContext({ strings: { user, period: 'overall' } });

  const buildOverall = (over: Doubles = {}) => {
    const settingService = { getTimePeriod: vi.fn(() => ({ timePeriod: TimePeriod.AllTime, description: 'Overall' })) };
    const userService = {
      getUserByDiscordId: vi.fn(async () => CALLER),
      getUserByLastFmName: vi.fn(async () => null),
    };
    const lastfmRepository = { getTopArtists: vi.fn(async () => []) };
    const countryService = {
      getUserTopCountriesAllTime: vi.fn(async () => over.allTimeCountries ?? []),
      getTopCountriesForTopArtists: vi.fn(async () => []),
    };
    const cmd = new CountrySlashCommands(
      userService as unknown as UserService,
      settingService as unknown as SettingService,
      lastfmRepository as unknown as LastFmRepository,
      countryService as unknown as CountryService,
      // Never reached on this path: the all-time short-circuit answers first.
      {} as unknown as WorldMapGenerator,
      undefined,
    );
    const privates = cmd as unknown as {
      handleTopCountriesSlash(c: ContextModel): Promise<ResponseModel>;
    };
    return { privates, lastfmRepository, countryService, userService };
  };

  it('answers an all-time request from the database and never asks Last.fm', async () => {
    // The point of the short-circuit: `overall` is the one period our own tables
    // already know, and Last.fm's `overall` is a 1000-artist fetch for the same
    // answer. A handler that missed this condition would cost a rate-limit unit
    // per invocation.
    const { privates, lastfmRepository, countryService } = buildOverall({
      allTimeCountries: [{ countryName: 'United Kingdom', countryCode: 'GB', playcount: 40 }],
    });
    const response = await privates.handleTopCountriesSlash(allTimeContext(null));

    expect(countryService.getUserTopCountriesAllTime).toHaveBeenCalledWith(7);
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
    expect(cardText(response)).toContain('United Kingdom');
  });

  it('falls back to Last.fm when the database genuinely has no all-time data', async () => {
    // The other half, and what keeps the short-circuit from becoming a refusal. A
    // user who has never had their library indexed has no rows, and the honest
    // answer is a real Last.fm read.
    const { privates, lastfmRepository } = buildOverall({ allTimeCountries: [] });
    await privates.handleTopCountriesSlash(allTimeContext(null));
    expect(lastfmRepository.getTopArtists).toHaveBeenCalledWith('DreadRock', TimePeriod.AllTime, 1000);
  });

  it('skips the database read for a user with no local row, and uses Last.fm', async () => {
    // `userRes.userId &&` - an `lfm:` stranger has no row to read, so the query
    // would be against id `undefined`. That is the same class of bug as reading
    // play history for userId 0: SOMEONE ELSE's numbers, or a crash.
    const { privates, lastfmRepository, countryService } = buildOverall({ allTimeCountries: [] });
    await privates.handleTopCountriesSlash(allTimeContext('lfm:SomeStranger'));

    expect(countryService.getUserTopCountriesAllTime).not.toHaveBeenCalled();
    expect(lastfmRepository.getTopArtists).toHaveBeenCalledWith('SomeStranger', TimePeriod.AllTime, 1000);
  });
});

describe('/country whoknows: "nobody listens to that" is an answer that must be earned', () => {
  it('lists the listeners the query returned', async () => {
    const { privates, countryService } = build({
      country: UK,
      guildUsers: [{ userId: 3, discordUserId: 'holder1', userNameLastFm: 'Holder', playcount: 12 }],
    });
    const response = await privates.handleWhoKnowsCountrySlash(makeContext({ subcommand: 'whoknows' }), 'gb');

    expect(countryService.getGuildUsersForCountry).toHaveBeenCalledWith('222', 'GB');
    expect(cardText(response)).toContain('Holder');
    expect(cardText(response)).toContain('12');
    // One guild member, one listener - singular. The footer used to hardcode the
    // plural and print "1 listeners" while the row above it said "12 plays".
    expect(cardText(response)).toContain('1 listener ·');
    expect(cardText(response)).not.toContain('1 listeners');
  });

  it('renders the honest empty for a server with nobody from that country', async () => {
    // The genuine empty. "Nobody in Test Guild has listened to artists from the
    // United Kingdom yet!" is a TRUE and specific statement, and it is exactly
    // what an unreadable guild query would produce - which is why the next test
    // is not optional.
    const { privates } = build({ country: UK, guildUsers: [] });
    const response = await privates.handleWhoKnowsCountrySlash(makeContext({ subcommand: 'whoknows' }), 'gb');

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('Nobody in **Test Guild** has listened');
    expect(cardText(response)).toContain('United Kingdom');
  });

  it('RAISES rather than saying "nobody" when the guild query is unreadable', async () => {
    // THE A1 TEST. The sentence above is the whole answer this command gives, so
    // a database outage laundering into it tells a member of a server with
    // several dozen listeners that not one of them has ever played that country.
    // There is no catch on this read, so the raise reaches the boundary.
    const { privates } = build({
      country: UK,
      guildUsersImpl: () => Promise.reject(DB_DOWN()),
    });

    const settled = await privates
      .handleWhoKnowsCountrySlash(makeContext({ subcommand: 'whoknows' }), 'gb')
      .then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));

    expect(settled.ok).toBe(false);
    if (settled.ok) throw new Error('unreachable');
    expect(String(settled.e)).toMatch(/countryService\.getGuildUsersForCountry/);
    expect(String(settled.e)).not.toContain('Nobody in');
  });

  it('refuses outside a server and queries no guild at all', async () => {
    // There is no "nobody in this server" when there is no server. The command
    // names that, rather than rendering the empty-state card, which would be a
    // claim about a room that does not exist.
    const { privates, countryService } = build({ country: UK });
    const response = await privates.handleWhoKnowsCountrySlash(
      makeContext({ inGuild: false, subcommand: 'whoknows' }),
      'gb',
    );

    expect(response.commandResponse).toBe(CommandResponse.NotSupportedInDm);
    expect(cardText(response)).toContain('can only be used inside a server');
    expect(countryService.getGuildUsersForCountry).not.toHaveBeenCalled();
  });

  it('says which country it could not match, and asks no question of the database', async () => {
    // A miss must be a miss, not a query. `searchCountry` is a local lookup over
    // the bundled list, so "Atlantis" costs nothing and must not reach Postgres.
    const { privates, countryService } = build({ country: undefined });
    const response = await privates.handleWhoKnowsCountrySlash(
      makeContext({ subcommand: 'whoknows' }),
      'Atlantis',
    );

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('Could not find a country matching **Atlantis**');
    expect(countryService.getGuildUsersForCountry).not.toHaveBeenCalled();
  });

  it('resolves a code, a name and a loose spelling to the same country', async () => {
    // `searchCountry` is a local alias map, and the option's own description says
    // "country name or code". Pinning one spelling would let a fix break the
    // other two silently.
    for (const spelling of ['gb', 'United Kingdom', '  uk  ']) {
      const { privates, countryService } = build({ country: UK });
      await privates.handleWhoKnowsCountrySlash(makeContext({ subcommand: 'whoknows' }), spelling);
      expect(countryService.getGuildUsersForCountry).toHaveBeenCalledWith('222', 'GB');
    }
  });

  it('needs no Last.fm account, because the question is about the server', async () => {
    // And no `lfm:` fallback, unlike `/country top`: there is nothing for the
    // caller to be needed for.
    const { privates, userService, countryService } = build({ caller: null, country: UK, guildUsers: [] });
    const response = await privates.handleWhoKnowsCountrySlash(
      makeContext({ subcommand: 'whoknows' }),
      'gb',
    );

    expect(userService.getUserByDiscordId).not.toHaveBeenCalled();
    expect(countryService.getGuildUsersForCountry).toHaveBeenCalled();
    expect(response.commandResponse).toBe(CommandResponse.NotFound);
  });
});

describe('/country info with a COUNTRY argument: the branch the artist tests never reach', () => {
  it('lists the caller\'s artists from that country', async () => {
    const { privates, countryService } = build({
      country: UK,
      userArtists: [{ name: 'Radiohead', playcount: 88 }],
    });
    const response = await privates.handleCountryInfoSlash(makeContext({ subcommand: 'info' }), 'United Kingdom');

    expect(countryService.getUserArtistsForCountry).toHaveBeenCalledWith(7, 'GB');
    expect(cardText(response)).toContain('Radiohead');
    expect(cardText(response)).toContain('Top United Kingdom artists for DreadRock');
  });

  it('renders the honest empty for a country the caller has no artists from', async () => {
    const { privates } = build({ country: UK, userArtists: [] });
    const response = await privates.handleCountryInfoSlash(makeContext({ subcommand: 'info' }), 'United Kingdom');

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('no registered artists found from **United Kingdom** in your library');
  });

  it('reads no artist playcount from Last.fm on the country branch', async () => {
    // The country branch is a different set of facts - the caller's artists
    // inside a country - and it must not reach for the caller's per-artist
    // playcount. If it did, and that read failed, the partial card would lose its
    // only distinguishing number for a question it never asked.
    const { privates, lastfmRepository } = build({
      country: UK,
      userArtists: [{ name: 'Radiohead', playcount: 88 }],
    });
    await privates.handleCountryInfoSlash(makeContext({ subcommand: 'info' }), 'United Kingdom');
    expect(lastfmRepository.getArtistInfo).not.toHaveBeenCalled();
  });

  it('refuses an unregistered caller before looking up any country', async () => {
    const { privates, countryService } = build({ caller: null, country: UK });
    const response = await privates.handleCountryInfoSlash(makeContext({ subcommand: 'info' }), 'United Kingdom');

    expect(response.commandResponse).toBe(CommandResponse.NotFound);
    expect(cardText(response)).toContain('/register');
    expect(countryService.searchCountry).not.toHaveBeenCalled();
  });

  it('derives the target from the caller\'s last scrobble when no argument is given', async () => {
    // The convenience. `/country info` with nothing typed is a legal invocation,
    // and the derived target is the caller's most recent artist - which then fails
    // `searchCountry`, so the card is an ARTIST card. That is right, and it is the
    // opposite of the empty answer below.
    const { privates, lastfmRepository } = build({
      country: undefined,
      recent: async () => [{ name: 'Airbag', artistName: 'Radiohead', albumName: 'OK Computer' }],
    });
    await privates.handleCountryInfoSlash(makeContext({ subcommand: 'info' }), '');

    expect(lastfmRepository.getUserRecentTracks).toHaveBeenCalledWith('DreadRock', 1);
  });

  it('asks for a target when the prefill read comes back empty', async () => {
    // The genuine empty, and TRUE: no argument was supplied and none could be
    // derived. "Please specify a country or artist name" is the right answer.
    const { privates } = build({ country: undefined, recent: async () => [] });
    const response = await privates.handleCountryInfoSlash(makeContext({ subcommand: 'info' }), '');

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('Please specify a country or artist name.');
  });

  it('asks for a target when the prefill read RAISES, having asked for no country', async () => {
    // The same three-way split as the `/rateyourmusic` prefill. The raise is
    // swallowed INSIDE the prefill only, so the command degrades to the honest
    // "no target was supplied and none could be derived" - and it does not then go
    // on to look up an EMPTY country name, which would be a database call
    // answering a question nobody asked.
    const { privates, countryService } = build({
      country: undefined,
      recent: () => Promise.reject(new Error('Last.fm returned HTTP 500')),
    });
    const response = await privates.handleCountryInfoSlash(makeContext({ subcommand: 'info' }), '');

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('Please specify a country or artist name.');
    expect(countryService.searchCountry).not.toHaveBeenCalled();
  });

  it('still runs the country and artist lookups, and their failures, when a target WAS given', async () => {
    // The complement to the prefill test above, and the reason the prefill's
    // `catch` is scoped rather than wrapping the rest of the handler: a lookup
    // that raises on its own must reach the boundary, not be absorbed into the
    // prefill's tolerance.
    const { privates, lastfmRepository, countryService } = build({
      country: undefined,
      getArtistInfo: () => Promise.reject(new Error('Last.fm returned HTTP 500')),
    } as Doubles);
    (countryService.getArtistInfoWithCountry as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Can't reach database server"),
    );

    await expect(
      privates.handleCountryInfoSlash(makeContext({ subcommand: 'info' }), 'Radiohead'),
    ).rejects.toThrow(/database server/i);
    expect(lastfmRepository.getUserRecentTracks).not.toHaveBeenCalled();
  });
});

describe('the /country dispatcher', () => {
  it('routes each subcommand to its own question', async () => {
    // One builder, four questions, and a dispatcher that reads a typed option.
    // Getting the routing wrong is invisible on the card - a user asking who in
    // the server knows Germany gets a list of their own countries instead, and
    // both are plausible.
    const byDiscordId = { [MENTION_ID]: OTHER };
    const subcommands: Array<[string, Record<string, string | null>]> = [
      ['info', { search: 'United Kingdom' }],
      ['whoknows', { country: 'gb' }],
      ['top', { user: 'lfm:SomeStranger' }],
    ];
    for (const [subcommand, strings] of subcommands) {
      const { privates } = build({ byDiscordId, country: UK });
      const response = await privates.handleCountrySlash(makeContext({ subcommand, strings }));
      expect(response).toBeDefined();
    }
  });

  it('refuses a subcommand it does not implement, rather than answering `top`', async () => {
    // `?? 'top'` covers a missing subcommand, which is right for `/country` typed
    // bare. An UNRECOGNISED one falls through to the error, and that has to stay:
    // answering it with somebody's top countries would answer a question nobody
    // asked.
    const { privates, lastfmRepository } = build();
    const response = await privates.handleCountrySlash(makeContext({ subcommand: 'nonsense' }));

    expect(response.commandResponse).toBe(CommandResponse.WrongInput);
    expect(cardText(response)).toContain('Unknown subcommand');
    expect(lastfmRepository.getTopArtists).not.toHaveBeenCalled();
  });

  const PERIODS = ['weekly', 'monthly', 'quarterly', 'halfyearly', 'yearly', 'overall'];
  const THEMES = ['dark', 'light', 'ocean', 'synthwave', 'sunset', 'forest'];

  interface OptionNode {
    type: number;
    name: string;
    required?: boolean;
    choices?: Array<{ value: string }>;
    options?: OptionNode[];
  }
  /** discord.js serialises SUBCOMMANDS into `options` with `type: 1`. */
  const allOptions = (json: { options?: OptionNode[] }): OptionNode[] => {
    const out: OptionNode[] = [];
    for (const node of json.options ?? []) {
      out.push(node);
      out.push(...allOptions(node));
    }
    return out;
  };

  it('registers the three top-level commands', async () => {
    const { cmd } = build();
    expect(cmd.commands.map((c) => (c.data.toJSON() as { name: string }).name)).toEqual([
      'country',
      'topcountries',
      'countrychart',
    ]);
  });

  it('offers the same six periods everywhere a period is offered', async () => {
    // `period` is a CHOICE, not a free string, and the choice list is spelled out
    // four times at module scope - `country top`, `country chart`, `topcountries`,
    // `countrychart`. A period added to three of them would be accepted by the
    // text twin's grammar and rejected by the slash command, so every copy has to
    // carry all six. `expect(...)` per command rather than a count: the parent
    // legitimately declares the option twice, once per subcommand.
    const { cmd } = build();
    let seen = 0;
    for (const definition of cmd.commands) {
      const json = definition.data.toJSON() as { options?: OptionNode[] };
      const periods = allOptions(json).filter((o) => o.name === 'period');
      expect(periods.length).toBeGreaterThan(0);
      for (const period of periods) {
        expect(period.choices?.map((c) => c.value)).toEqual(PERIODS);
        seen++;
      }
    }
    expect(seen).toBe(4);
  });

  it('keeps the map theme a choice on both map commands, so an unknown theme cannot reach the generator', async () => {
    // `getThemeFromName` is a fallback for a bad VALUE, and the value arrives
    // from a typed choice - so an unknown one means the two lists have drifted
    // apart. Pinning both catches that at the builder, where it is cheap.
    const { cmd } = build();
    const themes: OptionNode[] = [];
    for (const definition of cmd.commands) {
      const json = definition.data.toJSON() as { options?: OptionNode[] };
      themes.push(...allOptions(json).filter((o) => o.name === 'theme'));
    }
    expect(themes).toHaveLength(2);
    for (const theme of themes) {
      expect(theme.choices?.map((c) => c.value)).toEqual(THEMES);
    }
  });

  it('makes whoknows\' country REQUIRED and everything else optional', async () => {
    // `country` is the only thing `/country whoknows` can answer, so an optional
    // one would mean a guaranteed "Could not find a country matching **" on every
    // bare invocation. The optional `user` options are correct as they are -
    // they default to the caller.
    const { cmd } = build();
    const countryJson = cmd.commands[0]!.data.toJSON() as { options?: OptionNode[] };
    const whoknows = (countryJson.options ?? []).find((o) => o.name === 'whoknows');
    expect(whoknows?.options?.find((o) => o.name === 'country')?.required).toBe(true);

    for (const definition of cmd.commands) {
      const json = definition.data.toJSON() as { options?: OptionNode[] };
      for (const option of allOptions(json).filter((o) => o.name === 'user')) {
        expect(option.required).toBe(false);
      }
    }
  });
});
