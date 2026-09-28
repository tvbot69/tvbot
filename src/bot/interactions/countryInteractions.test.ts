import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageFlags } from 'discord.js';
import {
  CountryInteractions,
  storeCountryQuery,
  getCachedCountryQuery,
} from './countryInteractions';
import type { CachedCountryQuery } from './countryInteractions';
import { CountryBuilders } from '@bot/builders/countryBuilders';
import { CountryChartTheme, WorldMapGenerator } from '@images/generators/worldMapGenerator';
import type {
  CountryInfo,
  TopCountryItem,
  WhoKnowsCountryItem,
} from '@bot/services/countryService';
import type { ButtonInteraction, StringSelectMenuInteraction } from 'discord.js';

const NEPAL: CountryInfo = { Name: 'Nepal', Code: 'NP', Emoji: '🇳🇵' };
const JAPAN: CountryInfo = { Name: 'Japan', Code: 'JP', Emoji: '🇯🇵' };

const makeCountries = (n: number): TopCountryItem[] =>
  Array.from({ length: n }, (_, i) => ({
    countryName: `Country ${i + 1}`,
    countryCode: `C${i + 1}`,
    playcount: 100 - i,
  }));

const makeArtists = (n: number): { name: string; playcount: number }[] =>
  Array.from({ length: n }, (_, i) => ({ name: `Artist ${i + 1}`, playcount: 50 - i }));

const makeWhoKnows = (n: number): WhoKnowsCountryItem[] =>
  Array.from({ length: n }, (_, i) => ({
    userId: i + 1,
    discordUserId: `discord${i + 1}`,
    userNameLastFm: `user${i + 1}`,
    playcount: 10 - i,
  }));

const imageBuffer = Buffer.from('fake-png');

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'caller1' },
    deferred: false,
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };

const mkSelect = (customId: string, values: string[], over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'caller1' },
    deferred: false,
    values,
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    ...over,
  }) as unknown as StringSelectMenuInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const countryService = {
    getGuildTopCountriesAllTime: vi.fn(async () => [
      { countryName: 'Nepal', countryCode: 'NP', totalPlaycount: 300, listenerCount: 12 },
      { countryName: 'Japan', countryCode: 'JP', totalPlaycount: 200, listenerCount: 8 },
    ]),
    getUserTopCountriesAllTime: vi.fn(async () => makeCountries(3)),
    getGuildArtistsForCountry: vi.fn(async () => makeArtists(4)),
    getUserArtistsForCountry: vi.fn(async () => makeArtists(2)),
    ...(over.countryService as object),
  };
  const worldMapGenerator = {
    generateWorldMap: vi.fn(async () => imageBuffer),
    ...(over.worldMapGenerator as object),
  };
  const userService = {
    getUserByDiscordId: vi.fn(async () => ({ userId: 1, userNameLastFm: 'user1' })),
    ...(over.userService as object),
  };
  const ci = new CountryInteractions(
    countryService as never,
    worldMapGenerator as never,
    userService as never,
  );
  return { ci, countryService, worldMapGenerator, userService };
};

const seed = (key: string, data: Partial<Omit<CachedCountryQuery, 'expiresAt'>> = {}): void => {
  storeCountryQuery(key, { type: 'top', ...data } as Omit<CachedCountryQuery, 'expiresAt'>);
};

/** Sentinel response. `componentsV2Container` is the gate the handler checks. */
const sentinel = (label: string) => ({ componentsV2Container: { label } });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(CountryBuilders, 'buildTopCountriesResponse').mockReturnValue(sentinel('top') as never);
  vi.spyOn(CountryBuilders, 'buildCountryArtistsResponse').mockReturnValue(sentinel('artists') as never);
  vi.spyOn(CountryBuilders, 'buildWhoKnowsCountryResponse').mockReturnValue(sentinel('wkc') as never);
  vi.spyOn(CountryBuilders, 'buildCountryChartResponse').mockReturnValue(sentinel('chart') as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('storeCountryQuery / getCachedCountryQuery', () => {
  it('round-trips a stored query', async () => {
    storeCountryQuery('rt-1', { type: 'wkc', country: NEPAL, displayName: 'moha' });

    const cached = await getCachedCountryQuery('rt-1');

    expect(cached!.country).toEqual(NEPAL);
    expect(cached!.displayName).toBe('moha');
  });

  it('stamps a future expiresAt on store', async () => {
    const before = Date.now();
    storeCountryQuery('rt-2', { type: 'top' });

    const cached = await getCachedCountryQuery('rt-2');

    expect(cached!.expiresAt).toBeGreaterThanOrEqual(before);
  });

  it('returns undefined for an unknown key', async () => {
    await expect(getCachedCountryQuery('never-seeded-key')).resolves.toBeUndefined();
  });
});

describe('CountryInteractions.handleButton — routing guards', () => {
  it('ignores a customId that does not start with "country:"', async () => {
    const { ci } = build();

    await ci.handleButton(mkButton('genre:page:next:top:x:0:caller1'));

    expect(CountryBuilders.buildTopCountriesResponse).not.toHaveBeenCalled();
  });

  it('does nothing for a "country:" id whose verb is neither toggle nor page', async () => {
    const { ci } = build();
    const press = mkButton('country:mystery:a:b');

    await ci.handleButton(press);

    expect(press.reply).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });
});

describe('CountryInteractions.handleButton — ownership guards', () => {
  it('refuses a toggle from a different caller', async () => {
    const { ci, countryService } = build();
    seed('own-1', { type: 'top', userId: 1 });
    const press = mkButton('country:toggle:user:own-1:0:someoneElse');

    await ci.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'Only the user who initiated the command can interact with these controls.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.update).not.toHaveBeenCalled();
    expect(countryService.getUserTopCountriesAllTime).not.toHaveBeenCalled();
  });

  it('refuses a page from a different caller', async () => {
    const { ci } = build();
    seed('own-2', { type: 'top', countries: makeCountries(25) });
    const press = mkButton('country:page:next:top:own-2:0:someoneElse');

    await ci.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'Only the user who initiated the command can interact with these controls.',
      flags: MessageFlags.Ephemeral,
    });
    expect(CountryBuilders.buildTopCountriesResponse).not.toHaveBeenCalled();
  });
});

describe('CountryInteractions.handleButton — expiry guards', () => {
  it('replies "expired" for a toggle with no cached entry', async () => {
    const { ci } = build();
    const press = mkButton('country:toggle:user:missing:0:caller1');

    await ci.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'This interaction has expired. Please run the command again.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.update).not.toHaveBeenCalled();
  });

  it('replies "expired" for a page with no cached entry', async () => {
    const { ci } = build();
    const press = mkButton('country:page:next:top:missing:0:caller1');

    await ci.handleButton(press);

    expect(press.reply).toHaveBeenCalledWith({
      content: 'This interaction has expired. Please run the command again.',
      flags: MessageFlags.Ephemeral,
    });
    expect(press.update).not.toHaveBeenCalled();
  });
});

describe('CountryInteractions.handleButton — toggle "top"', () => {
  it('reads and remaps guild countries for the server view', async () => {
    const { ci, countryService } = build();
    seed('tt-1', { type: 'top', guildId: 'g1', serverName: 'TestGuild', userId: 7 });
    const press = mkButton('country:toggle:server:tt-1:0:caller1');

    await ci.handleButton(press);

    expect(countryService.getGuildTopCountriesAllTime).toHaveBeenCalledWith('g1');
    expect(countryService.getUserTopCountriesAllTime).not.toHaveBeenCalled();
    expect(CountryBuilders.buildTopCountriesResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        countries: [
          { countryName: 'Nepal', countryCode: 'NP', playcount: 300, artistCount: 12 },
          { countryName: 'Japan', countryCode: 'JP', playcount: 200, artistCount: 8 },
        ],
        displayName: 'TestGuild',
        isServerView: true,
        guildId: 'g1',
        pageIndex: 0,
        cacheKey: 'tt-1',
        callerDiscordUserId: 'caller1',
      }),
    );
    expect(press.update).toHaveBeenCalledWith({ components: [{ label: 'top' }] });
  });

  it('reads user countries for the user view', async () => {
    const { ci, countryService } = build();
    seed('tt-2', { type: 'top', guildId: 'g1', serverName: 'TestGuild', userId: 7, displayName: 'moha' });
    const press = mkButton('country:toggle:user:tt-2:0:caller1');

    await ci.handleButton(press);

    expect(countryService.getUserTopCountriesAllTime).toHaveBeenCalledWith(7);
    expect(CountryBuilders.buildTopCountriesResponse).toHaveBeenCalledWith(
      expect.objectContaining({ countries: makeCountries(3), displayName: 'moha', isServerView: false }),
    );
  });

  it('falls back to an empty list when neither guildId nor userId is cached', async () => {
    const { ci, countryService } = build();
    seed('tt-3', { type: 'top', serverName: 'TestGuild' });
    const press = mkButton('country:toggle:server:tt-3:0:caller1');

    await ci.handleButton(press);

    expect(countryService.getGuildTopCountriesAllTime).not.toHaveBeenCalled();
    expect(countryService.getUserTopCountriesAllTime).not.toHaveBeenCalled();
    expect(CountryBuilders.buildTopCountriesResponse).toHaveBeenCalledWith(
      expect.objectContaining({ countries: [], displayName: 'TestGuild', isServerView: true }),
    );
  });

  it('writes the refreshed countries and view back to the store', async () => {
    const { ci } = build();
    seed('tt-4', { type: 'top', guildId: 'g1', serverName: 'TestGuild', userId: 7, displayName: 'moha' });

    await ci.handleButton(mkButton('country:toggle:server:tt-4:0:caller1'));

    const cached = await getCachedCountryQuery('tt-4');
    expect(cached!.isServerView).toBe(true);
    expect(cached!.countries).toEqual([
      { countryName: 'Nepal', countryCode: 'NP', playcount: 300, artistCount: 12 },
      { countryName: 'Japan', countryCode: 'JP', playcount: 200, artistCount: 8 },
    ]);
  });

  it('defaults displayName to "User" and periodDescription to "all-time"', async () => {
    const { ci } = build();
    seed('tt-5', { type: 'top', userId: 7 });

    await ci.handleButton(mkButton('country:toggle:user:tt-5:0:caller1'));

    expect(CountryBuilders.buildTopCountriesResponse).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'User', periodDescription: 'all-time' }),
    );
  });

  it('does not update when the builder returns no components container', async () => {
    vi.spyOn(CountryBuilders, 'buildTopCountriesResponse').mockReturnValue({} as never);
    const { ci } = build();
    seed('tt-6', { type: 'top', userId: 7 });
    const press = mkButton('country:toggle:user:tt-6:0:caller1');

    await ci.handleButton(press);

    expect(CountryBuilders.buildTopCountriesResponse).toHaveBeenCalledTimes(1);
    expect(press.update).not.toHaveBeenCalled();
  });
});

describe('CountryInteractions.handleButton — toggle "info"', () => {
  it('reads guild artists for the server view using the country code', async () => {
    const { ci, countryService } = build();
    seed('ti-1', { type: 'info', country: NEPAL, guildId: 'g1', serverName: 'TestGuild', userId: 7 });
    const press = mkButton('country:toggle:server:ti-1:0:caller1');

    await ci.handleButton(press);

    expect(countryService.getGuildArtistsForCountry).toHaveBeenCalledWith('g1', 'NP');
    expect(CountryBuilders.buildCountryArtistsResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        country: NEPAL,
        artists: makeArtists(4),
        isServerView: true,
        targetName: 'TestGuild',
        pageIndex: 0,
        cacheKey: 'ti-1',
        guildId: 'g1',
      }),
    );
    expect(press.update).toHaveBeenCalledWith({ components: [{ label: 'artists' }] });
  });

  it('reads user artists for the user view', async () => {
    const { ci, countryService } = build();
    seed('ti-2', { type: 'info', country: JAPAN, userId: 7, displayName: 'moha' });
    const press = mkButton('country:toggle:user:ti-2:0:caller1');

    await ci.handleButton(press);

    expect(countryService.getUserArtistsForCountry).toHaveBeenCalledWith(7, 'JP');
    expect(CountryBuilders.buildCountryArtistsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ artists: makeArtists(2), isServerView: false, targetName: 'moha' }),
    );
  });

  it('falls back to an empty list when neither guildId nor userId is cached', async () => {
    const { ci, countryService } = build();
    seed('ti-3', { type: 'info', country: JAPAN });
    const press = mkButton('country:toggle:user:ti-3:0:caller1');

    await ci.handleButton(press);

    expect(countryService.getUserArtistsForCountry).not.toHaveBeenCalled();
    expect(CountryBuilders.buildCountryArtistsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ artists: [], targetName: 'User' }),
    );
  });

  it('writes the refreshed artists and view back to the store', async () => {
    const { ci } = build();
    seed('ti-4', { type: 'info', country: JAPAN, userId: 7, displayName: 'moha' });

    await ci.handleButton(mkButton('country:toggle:user:ti-4:0:caller1'));

    const cached = await getCachedCountryQuery('ti-4');
    expect(cached!.isServerView).toBe(false);
    expect(cached!.artists).toEqual(makeArtists(2));
  });

  it('does nothing for an "info" cache that has no country', async () => {
    const { ci, countryService } = build();
    seed('ti-5', { type: 'info', userId: 7 });
    const press = mkButton('country:toggle:user:ti-5:0:caller1');

    await ci.handleButton(press);

    expect(countryService.getUserArtistsForCountry).not.toHaveBeenCalled();
    expect(CountryBuilders.buildCountryArtistsResponse).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('does nothing for a "wkc" cache', async () => {
    const { ci } = build();
    seed('ti-6', { type: 'wkc', country: NEPAL, whoknowsItems: makeWhoKnows(5) });
    const press = mkButton('country:toggle:user:ti-6:0:caller1');

    await ci.handleButton(press);

    expect(CountryBuilders.buildWhoKnowsCountryResponse).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('does nothing for a "chart" cache', async () => {
    const { ci } = build();
    seed('ti-7', { type: 'chart', countries: makeCountries(5) });
    const press = mkButton('country:toggle:user:ti-7:0:caller1');

    await ci.handleButton(press);

    expect(CountryBuilders.buildTopCountriesResponse).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('does not update when the builder returns no components container', async () => {
    vi.spyOn(CountryBuilders, 'buildCountryArtistsResponse').mockReturnValue({} as never);
    const { ci } = build();
    seed('ti-8', { type: 'info', country: JAPAN, userId: 7 });
    const press = mkButton('country:toggle:user:ti-8:0:caller1');

    await ci.handleButton(press);

    expect(press.update).not.toHaveBeenCalled();
  });
});

describe('CountryInteractions.handleButton — page "top"', () => {
  it('passes the cached countries and the current view through', async () => {
    const { ci } = build();
    seed('pt-1', {
      type: 'top',
      countries: makeCountries(25),
      displayName: 'moha',
      periodDescription: 'last week',
      accentColor: 0xff0000,
    });
    const press = mkButton('country:page:next:top:pt-1:0:caller1');

    await ci.handleButton(press);

    expect(CountryBuilders.buildTopCountriesResponse).toHaveBeenCalledWith({
      displayName: 'moha',
      countries: makeCountries(25),
      periodDescription: 'last week',
      pageIndex: 1,
      cacheKey: 'pt-1',
      callerDiscordUserId: 'caller1',
      accentColor: 0xff0000,
      isServerView: undefined,
      guildId: undefined,
    });
    expect(press.update).toHaveBeenCalledWith({ components: [{ label: 'top' }] });
  });

  it('navigates first to page 0', async () => {
    const { ci } = build();
    seed('pt-2', { type: 'top', countries: makeCountries(25) });

    await ci.handleButton(mkButton('country:page:first:top:pt-2:2:caller1'));

    expect(CountryBuilders.buildTopCountriesResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 0 }),
    );
  });

  it('navigates prev without going below page 0', async () => {
    const { ci } = build();
    seed('pt-3', { type: 'top', countries: makeCountries(25) });

    await ci.handleButton(mkButton('country:page:prev:top:pt-3:0:caller1'));

    expect(CountryBuilders.buildTopCountriesResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 0 }),
    );
  });

  it('navigates last to the final page', async () => {
    const { ci } = build();
    seed('pt-4', { type: 'top', countries: makeCountries(25) });

    await ci.handleButton(mkButton('country:page:last:top:pt-4:0:caller1'));

    expect(CountryBuilders.buildTopCountriesResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 2 }),
    );
  });

  it('clamps next to the last page', async () => {
    const { ci } = build();
    seed('pt-5', { type: 'top', countries: makeCountries(12) });

    await ci.handleButton(mkButton('country:page:next:top:pt-5:1:caller1'));

    expect(CountryBuilders.buildTopCountriesResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 1 }),
    );
  });

  it('keeps the current page for an unrecognised action', async () => {
    const { ci } = build();
    seed('pt-6', { type: 'top', countries: makeCountries(25) });

    await ci.handleButton(mkButton('country:page:sideways:top:pt-6:2:caller1'));

    expect(CountryBuilders.buildTopCountriesResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 2 }),
    );
  });

  it('treats a non-numeric page as 0', async () => {
    const { ci } = build();
    seed('pt-7', { type: 'top', countries: makeCountries(25) });

    await ci.handleButton(mkButton('country:page:prev:top:pt-7:abc:caller1'));

    expect(CountryBuilders.buildTopCountriesResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 0 }),
    );
  });

  it('names the server when the cached view is a server view', async () => {
    const { ci } = build();
    seed('pt-8', { type: 'top', countries: makeCountries(5), isServerView: true, serverName: 'TestGuild' });

    await ci.handleButton(mkButton('country:page:first:top:pt-8:0:caller1'));

    expect(CountryBuilders.buildTopCountriesResponse).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'TestGuild', isServerView: true }),
    );
  });

  it('falls back to "Server" for a server view with no serverName', async () => {
    const { ci } = build();
    seed('pt-9', { type: 'top', countries: makeCountries(5), isServerView: true });

    await ci.handleButton(mkButton('country:page:first:top:pt-9:0:caller1'));

    expect(CountryBuilders.buildTopCountriesResponse).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Server' }),
    );
  });

  it('falls back to an empty country list and "all-time" period', async () => {
    const { ci } = build();
    seed('pt-10', { type: 'top' });
    const press = mkButton('country:page:next:top:pt-10:0:caller1');

    await ci.handleButton(press);

    expect(CountryBuilders.buildTopCountriesResponse).toHaveBeenCalledWith(
      expect.objectContaining({ countries: [], periodDescription: 'all-time' }),
    );
  });

  it('computes a pageIndex of -1 for "next" on an empty list, unlike genre pagination', async () => {
    const { ci } = build();
    seed('pt-11', { type: 'top', countries: [] });
    const press = mkButton('country:page:next:top:pt-11:0:caller1');

    await ci.handleButton(press);

    // totalPages is 0 here and is not floored at 1, so `Math.min(0 - 1, 1)` is -1.
    // The builder clamps internally, so this is latent rather than user-visible.
    expect(CountryBuilders.buildTopCountriesResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: -1 }),
    );
  });

  it('computes a pageIndex of -1 for "last" on an empty list', async () => {
    const { ci } = build();
    seed('pt-12', { type: 'info', country: NEPAL, artists: [] });
    const press = mkButton('country:page:last:info:pt-12:0:caller1');

    await ci.handleButton(press);

    expect(CountryBuilders.buildCountryArtistsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ artists: [], pageIndex: -1 }),
    );
  });
});

describe('CountryInteractions.handleButton — page "info"', () => {
  it('passes the country and artists through and advances the page', async () => {
    const { ci } = build();
    seed('pi-1', {
      type: 'info',
      country: NEPAL,
      artists: makeArtists(25),
      displayName: 'moha',
      guildId: 'g1',
      accentColor: 0x00ff00,
    });
    const press = mkButton('country:page:next:info:pi-1:0:caller1');

    await ci.handleButton(press);

    expect(CountryBuilders.buildCountryArtistsResponse).toHaveBeenCalledWith({
      country: NEPAL,
      artists: makeArtists(25),
      isServerView: false,
      targetName: 'moha',
      pageIndex: 1,
      cacheKey: 'pi-1',
      callerDiscordUserId: 'caller1',
      accentColor: 0x00ff00,
      guildId: 'g1',
    });
    expect(press.update).toHaveBeenCalledWith({ components: [{ label: 'artists' }] });
  });

  it('coerces a missing isServerView to false but honours a true one', async () => {
    const { ci } = build();
    seed('pi-2', { type: 'info', country: NEPAL, artists: makeArtists(25) });
    await ci.handleButton(mkButton('country:page:first:info:pi-2:0:caller1'));

    expect(CountryBuilders.buildCountryArtistsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ isServerView: false }),
    );

    vi.mocked(CountryBuilders.buildCountryArtistsResponse).mockClear();
    seed('pi-3', { type: 'info', country: NEPAL, artists: makeArtists(25), isServerView: true, serverName: 'TestGuild' });
    await ci.handleButton(mkButton('country:page:first:info:pi-3:0:caller1'));

    expect(CountryBuilders.buildCountryArtistsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ isServerView: true, targetName: 'TestGuild' }),
    );
  });

  it('navigates last to the final artist page', async () => {
    const { ci } = build();
    seed('pi-4', { type: 'info', country: JAPAN, artists: makeArtists(25) });

    await ci.handleButton(mkButton('country:page:last:info:pi-4:0:caller1'));

    expect(CountryBuilders.buildCountryArtistsResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 2 }),
    );
  });

  it('does nothing when the cache has no country', async () => {
    const { ci } = build();
    seed('pi-5', { type: 'info', artists: makeArtists(25) });
    const press = mkButton('country:page:next:info:pi-5:0:caller1');

    await ci.handleButton(press);

    expect(CountryBuilders.buildCountryArtistsResponse).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });
});

describe('CountryInteractions.handleButton — page "wkc"', () => {
  it('passes the who-knows items through with a page size of ten', async () => {
    const { ci } = build();
    seed('pw-1', {
      type: 'wkc',
      country: NEPAL,
      serverName: 'TestGuild',
      whoknowsItems: makeWhoKnows(25),
      accentColor: 0xabcdef,
    });
    const press = mkButton('country:page:next:wkc:pw-1:0:caller1');

    await ci.handleButton(press);

    expect(CountryBuilders.buildWhoKnowsCountryResponse).toHaveBeenCalledWith({
      country: NEPAL,
      serverName: 'TestGuild',
      items: makeWhoKnows(25),
      pageIndex: 1,
      cacheKey: 'pw-1',
      callerDiscordUserId: 'caller1',
      accentColor: 0xabcdef,
    });
    expect(press.update).toHaveBeenCalledWith({ components: [{ label: 'wkc' }] });
  });

  it('navigates last to the final who-knows page', async () => {
    const { ci } = build();
    seed('pw-2', { type: 'wkc', country: JAPAN, whoknowsItems: makeWhoKnows(25) });

    await ci.handleButton(mkButton('country:page:last:wkc:pw-2:0:caller1'));

    expect(CountryBuilders.buildWhoKnowsCountryResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pageIndex: 2, serverName: 'Server' }),
    );
  });

  it('does nothing when the cache has no country', async () => {
    const { ci } = build();
    seed('pw-3', { type: 'wkc', whoknowsItems: makeWhoKnows(25) });
    const press = mkButton('country:page:next:wkc:pw-3:0:caller1');

    await ci.handleButton(press);

    expect(CountryBuilders.buildWhoKnowsCountryResponse).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('does nothing for an unknown query type', async () => {
    const { ci } = build();
    seed('pw-4', { type: 'wkc', country: NEPAL, whoknowsItems: makeWhoKnows(25) });
    const press = mkButton('country:page:next:bogus:pw-4:0:caller1');

    await ci.handleButton(press);

    expect(CountryBuilders.buildWhoKnowsCountryResponse).not.toHaveBeenCalled();
    expect(CountryBuilders.buildTopCountriesResponse).not.toHaveBeenCalled();
    expect(CountryBuilders.buildCountryArtistsResponse).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });
});

describe('CountryInteractions.handleStringSelect — theme', () => {
  it('ignores a customId without the "country:theme:" prefix', async () => {
    const { ci, worldMapGenerator } = build();
    const select = mkSelect('country:page:top:k1:0:caller1', ['light']);

    await ci.handleStringSelect(select);

    expect(worldMapGenerator.generateWorldMap).not.toHaveBeenCalled();
    expect(select.reply).not.toHaveBeenCalled();
  });

  it('refuses a theme change from a different caller', async () => {
    const { ci, worldMapGenerator } = build();
    seed('st-1', { type: 'chart', countries: makeCountries(5) });
    const select = mkSelect('country:theme:st-1:someoneElse', ['light']);

    await ci.handleStringSelect(select);

    expect(select.reply).toHaveBeenCalledWith({
      content: 'Only the user who initiated the command can interact with these controls.',
      flags: MessageFlags.Ephemeral,
    });
    expect(worldMapGenerator.generateWorldMap).not.toHaveBeenCalled();
  });

  it('replies "expired" when nothing is cached', async () => {
    const { ci } = build();
    const select = mkSelect('country:theme:missing:caller1', ['light']);

    await ci.handleStringSelect(select);

    expect(select.reply).toHaveBeenCalledWith({
      content: 'This interaction has expired. Please run the command again.',
      flags: MessageFlags.Ephemeral,
    });
    expect(select.deferUpdate).not.toHaveBeenCalled();
  });

  it('replies "expired" when the cache has no countries', async () => {
    const { ci } = build();
    seed('st-2', { type: 'chart' });
    const select = mkSelect('country:theme:st-2:caller1', ['light']);

    await ci.handleStringSelect(select);

    expect(select.reply).toHaveBeenCalledWith({
      content: 'This interaction has expired. Please run the command again.',
      flags: MessageFlags.Ephemeral,
    });
    expect(select.deferUpdate).not.toHaveBeenCalled();
  });

  it('resolves the theme, regenerates the map and edits the reply with the png', async () => {
    const { ci, worldMapGenerator } = build();
    seed('st-3', {
      type: 'chart',
      countries: makeCountries(5),
      displayName: 'moha',
      userNameLastFm: 'moha_lfm',
      periodDescription: 'last week',
      accentColor: 0x123456,
    });
    const select = mkSelect('country:theme:st-3:caller1', ['synthwave']);

    await ci.handleStringSelect(select);

    expect(select.deferUpdate).toHaveBeenCalledTimes(1);
    expect(worldMapGenerator.generateWorldMap).toHaveBeenCalledWith(makeCountries(5), CountryChartTheme.Synthwave);
    expect(CountryBuilders.buildCountryChartResponse).toHaveBeenCalledWith({
      displayName: 'moha',
      userNameLastFm: 'moha_lfm',
      periodDescription: 'last week',
      imageBuffer,
      theme: CountryChartTheme.Synthwave,
      callerDiscordUserId: 'caller1',
      cacheKey: 'st-3',
      accentColor: 0x123456,
    });
    expect(select.editReply).toHaveBeenCalledWith({
      files: [{ attachment: imageBuffer, name: 'artist-map.png' }],
      components: [{ label: 'chart' }],
    });
  });

  it('defaults an unrecognised theme to Dark', async () => {
    const { ci, worldMapGenerator } = build();
    seed('st-4', { type: 'chart', countries: makeCountries(5) });
    const select = mkSelect('country:theme:st-4:caller1', ['not-a-theme']);

    await ci.handleStringSelect(select);

    expect(worldMapGenerator.generateWorldMap).toHaveBeenCalledWith(
      makeCountries(5),
      CountryChartTheme.Dark,
    );
  });

  it('persists the chosen theme back onto the cached entry', async () => {
    const { ci } = build();
    seed('st-5', { type: 'chart', countries: makeCountries(5) });

    await ci.handleStringSelect(mkSelect('country:theme:st-5:caller1', ['ocean']));

    const cached = await getCachedCountryQuery('st-5');
    expect(cached!.currentTheme).toBe(CountryChartTheme.Ocean);
  });

  it('defaults displayName, periodDescription and drops an absent last.fm name', async () => {
    const { ci } = build();
    seed('st-6', { type: 'chart', countries: makeCountries(5) });

    await ci.handleStringSelect(mkSelect('country:theme:st-6:caller1', ['forest']));

    expect(CountryBuilders.buildCountryChartResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'User',
        userNameLastFm: undefined,
        periodDescription: 'all-time',
        theme: CountryChartTheme.Forest,
      }),
    );
  });

  it('does not edit the reply when the chart builder returns no container', async () => {
    vi.spyOn(CountryBuilders, 'buildCountryChartResponse').mockReturnValue({} as never);
    const { ci } = build();
    seed('st-7', { type: 'chart', countries: makeCountries(5) });
    const select = mkSelect('country:theme:st-7:caller1', ['light']);

    await ci.handleStringSelect(select);

    expect(select.editReply).not.toHaveBeenCalled();
  });

  it('proceeds even when deferUpdate throws an already-acknowledged error', async () => {
    const { ci, worldMapGenerator } = build();
    seed('st-8', { type: 'chart', countries: makeCountries(5) });
    const select = mkSelect('country:theme:st-8:caller1', ['light'], {
      deferUpdate: vi.fn(async () => {
        throw Object.assign(new Error('InteractionAlreadyAcknowledged'), { code: 40060 });
      }),
    });

    await ci.handleStringSelect(select);

    expect(select.deferUpdate).toHaveBeenCalledTimes(1);
    expect(worldMapGenerator.generateWorldMap).toHaveBeenCalledTimes(1);
    expect(select.editReply).toHaveBeenCalledTimes(1);
  });

  it('resolves every theme name through the generator', async () => {
    const { ci, worldMapGenerator } = build();
    const cases: [string, CountryChartTheme][] = [
      ['dark', CountryChartTheme.Dark],
      ['light', CountryChartTheme.Light],
      ['ocean', CountryChartTheme.Ocean],
      ['synthwave', CountryChartTheme.Synthwave],
      ['sunset', CountryChartTheme.Sunset],
      ['forest', CountryChartTheme.Forest],
    ];
    let n = 0;

    for (const [name, theme] of cases) {
      seed(`st-theme-${name}`, { type: 'chart', countries: makeCountries(2) });
      await ci.handleStringSelect(mkSelect(`country:theme:st-theme-${name}:caller1`, [name]));
      n += 1;
      expect(worldMapGenerator.generateWorldMap).toHaveBeenCalledWith(makeCountries(2), theme);
    }

    expect(n).toBe(cases.length);
  });
});

describe('CountryInteractions.handleStringSelect — real builder', () => {
  it('edits the reply with a real Components V2 container and the png', async () => {
    vi.restoreAllMocks();
    const { ci } = build();
    seed('real-1', {
      type: 'chart',
      countries: makeCountries(5),
      displayName: 'moha',
      userNameLastFm: 'moha_lfm',
    });
    const select = mkSelect('country:theme:real-1:caller1', ['light']);

    await ci.handleStringSelect(select);

    expect(select.editReply).toHaveBeenCalledTimes(1);
    const payload = select.editReply.mock.calls[0]![0] as {
      files: { name: string; attachment: Buffer }[];
      components: unknown[];
    };
    expect(payload.files[0]!.name).toBe('artist-map.png');
    expect(payload.components).toHaveLength(1);
  });
});

describe('WorldMapGenerator.getThemeFromName', () => {
  it('defaults to Dark for undefined', () => {
    expect(WorldMapGenerator.getThemeFromName(undefined)).toBe(CountryChartTheme.Dark);
  });

  it('is case and whitespace insensitive', () => {
    expect(WorldMapGenerator.getThemeFromName('  OCEAN ')).toBe(CountryChartTheme.Ocean);
  });
});
