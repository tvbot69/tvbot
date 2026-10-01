import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { CountryBuilders } from '@bot/builders/countryBuilders';
import type { WhoKnowsCountryItem } from '@bot/services/library/countryService';
import type { CountryInfo } from '@bot/services/library/countryService';

/**
 * The country cards print a count of artists in two places, and both used to
 * print the plural unconditionally — so a country with exactly one top artist
 * read "1 artists". That is the same class of defect as a fabricated number:
 * the card states something the data does not support.
 *
 * Each case is pinned in BOTH directions. An assertion that only checks the
 * singular would still pass on a builder that always printed the singular.
 */

const body = (response: { componentsV2Container?: { toJSON: () => unknown } }): string => {
  const json = response.componentsV2Container?.toJSON() as {
    components?: { content?: string }[];
  };
  return (json.components ?? [])
    .map((c) => c.content ?? '')
    .join('\n');
};

const country = (over: Partial<CountryInfo> = {}): CountryInfo =>
  ({ Code: 'us', Name: 'United States', listeners: 1, ...over }) as CountryInfo;

describe('CountryBuilders: the artist count agrees with the count', () => {
  it('says "1 artist" on a top-countries row holding one artist', () => {
    const text = body(
      CountryBuilders.buildTopCountriesResponse({
        displayName: 'Alice',
        countries: [
          { countryName: 'United States', countryCode: 'US', playcount: 10, artists: [{ name: 'Nirvana', playcount: 1 }] },
        ],
        periodDescription: 'weekly',
        pageIndex: 0,
        cacheKey: 'k',
        callerDiscordUserId: '1',
      }),
    );
    expect(text).toContain('`1 artist`');
    expect(text).not.toContain('`1 artists`');
  });

  it('still says "artists" for two', () => {
    const text = body(
      CountryBuilders.buildTopCountriesResponse({
        displayName: 'Alice',
        countries: [
          {
            countryName: 'United States',
            countryCode: 'US',
            playcount: 10,
            artists: [{ name: 'Nirvana', playcount: 1 }, { name: 'Pixies', playcount: 1 }],
          },
        ],
        periodDescription: 'weekly',
        pageIndex: 0,
        cacheKey: 'k',
        callerDiscordUserId: '1',
      }),
    );
    expect(text).toContain('`2 artists`');
  });

  it('uses the same noun for the artistCount fallback', () => {
    const text = body(
      CountryBuilders.buildTopCountriesResponse({
        displayName: 'Alice',
        countries: [{ countryName: 'Japan', countryCode: 'JP', playcount: 4, artistCount: 1 }],
        periodDescription: 'weekly',
        pageIndex: 0,
        cacheKey: 'k',
        callerDiscordUserId: '1',
      }),
    );
    expect(text).toContain('`1 artist`');
    expect(text).not.toContain('`1 artists`');
  });

  it('says "1 artist" in the country-artists footer', () => {
    const text = body(
      CountryBuilders.buildCountryArtistsResponse({
        country: country(),
        artists: [{ name: 'Nirvana', playcount: 8 }],
        isServerView: false,
        targetName: 'Alice',
        pageIndex: 0,
        cacheKey: 'k',
        callerDiscordUserId: '1',
      }),
    );
    expect(text).toContain('1 artist ·');
    expect(text).not.toContain('1 artists ·');
  });

  it('still says "artists" in the country-artists footer for two', () => {
    const text = body(
      CountryBuilders.buildCountryArtistsResponse({
        country: country(),
        artists: [
          { name: 'Nirvana', playcount: 8 },
          { name: 'Pixies', playcount: 4 },
        ],
        isServerView: false,
        targetName: 'Alice',
        pageIndex: 0,
        cacheKey: 'k',
        callerDiscordUserId: '1',
      }),
    );
    expect(text).toContain('2 artists ·');
  });
});

describe('CountryBuilders: an unreadable page size must not cost the card', () => {
  it('renders the list when pageSize is 0 instead of throwing on empty content', () => {
    // `Math.ceil(n / 0)` is Infinity, so the slice came back empty, `lines.join()`
    // was `''`, and `TextDisplayBuilder.setContent('')` threw — the countries card
    // became impossible to send.
const response = CountryBuilders.buildTopCountriesResponse({
      displayName: 'Alice',
      countries: [{ countryName: 'Japan', countryCode: 'JP', playcount: 4, artistCount: 1 }],
      periodDescription: 'weekly',
      pageIndex: 0,
      pageSize: 0,
      cacheKey: 'k',
      callerDiscordUserId: '1',
    });
    expect(() => response.componentsV2Container?.toJSON()).not.toThrow();
  });
});

describe('CountryBuilders: the who-knows-country card survives its own inputs', () => {
  it('serialises with a single listener row', () => {
    const items: WhoKnowsCountryItem[] = [
      {
        userId: 1,
        userNameLastFm: 'alice',
        playcount: 12,
discordUserId: '1',
      },
    ];
    const response = CountryBuilders.buildWhoKnowsCountryResponse({
      country: country(),
      serverName: 'Test Guild',
      items,
      pageIndex: 0,
      cacheKey: 'k',
      callerDiscordUserId: '1',
    });
    expect(() => response.componentsV2Container?.toJSON()).not.toThrow();
    expect(body(response)).not.toContain('1 listeners');
  });
});