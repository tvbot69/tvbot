import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CountryService } from './countryService';

/**
 * CountryService resolves an artist's country from a four-step ladder:
 * curated seed map -> preloaded DB map -> cache -> live DB row -> MusicBrainz.
 * The tests below mostly pin WHICH step wins, because the earlier steps are
 * curated and the later ones are best-effort network calls - reordering the
 * ladder silently turns every "known" country into a MusicBrainz round trip.
 *
 * Two things are worth knowing before editing these:
 *
 *  1. The constructor fires `void this.ensureDbPreloaded()` without awaiting, so
 *     `prisma.artist.findMany` runs on every single construction. Assertions
 *     here deliberately check `findFirst` / `cache` / MusicBrainz, never
 *     `findMany`, unless the test is specifically about the preload.
 *  2. The seed map is keyed LOWERCASE with UPPERCASE values, and lookups
 *     lowercase the artist name. `Radiohead` and `  radiohead ` are the same
 *     key; the name is never case-folded anywhere else in the ladder.
 */

describe('CountryService', () => {
  const mockPrisma: any = {
    artist: {
      findMany: async () => [],
      findFirst: async () => null,
      updateMany: async () => ({ count: 0 }),
    },
    $queryRaw: async () => [],
  };

  const mockMusicBrainzService: any = {
    getArtistData: async () => null,
  };

  const mockCache: any = {
    get: async () => undefined,
    set: async () => undefined,
  };

  it('loads countries and maps country codes', () => {
    const service = new CountryService(mockPrisma, mockMusicBrainzService, mockCache);
    expect(service.countries.length).toBeGreaterThan(0);

    const us = service.getCountryByCode('US');
    expect(us).toBeDefined();
    expect(us?.Name).toBe('United States');

    const jp = service.getCountryByCode('jp');
    expect(jp).toBeDefined();
    expect(jp?.Name).toBe('Japan');
  });

  it('searches countries by name, code, or alias', () => {
    const service = new CountryService(mockPrisma, mockMusicBrainzService, mockCache);

    const japan = service.searchCountry('japan');
    expect(japan?.Code).toBe('JP');

    const uk = service.searchCountry('UK');
    expect(uk?.Code).toBe('GB');

    const usa = service.searchCountry('USA');
    expect(usa?.Code).toBe('US');

    const netherlands = service.searchCountry('netherlands');
    expect(netherlands?.Code).toBe('NL');
  });

  it('trims country strings properly', () => {
    expect(CountryService.trimCountry('United States')).toBe('unitedstates');
    expect(CountryService.trimCountry('South-Korea')).toBe('southkorea');
  });

  it('aggregates top countries for top artists', async () => {
    const service = new CountryService(mockPrisma, mockMusicBrainzService, mockCache);

    const topArtists = [
      { name: 'Radiohead', playcount: 500 }, // UK seed
      { name: 'Nirvana', playcount: 400 },   // US seed
    ];

    const results = await service.getTopCountriesForTopArtists(topArtists, true);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.countryCode === 'GB' || r.countryCode === 'US')).toBe(true);
  });
});

type Over = {
  findMany?: unknown;
  findFirst?: unknown;
  updateMany?: unknown;
  getArtistData?: unknown;
  cacheGet?: unknown;
  queryRaw?: unknown;
  userArtists?: unknown;
};

const build = (over: Over = {}) => {
  const prisma = {
    artist: {
      findMany: vi.fn(async () => (over.findMany === undefined ? [] : over.findMany)),
      findFirst: vi.fn(async () => (over.findFirst === undefined ? null : over.findFirst)),
      updateMany: vi.fn(async () => (over.updateMany === undefined ? { count: 0 } : over.updateMany)),
    },
    userArtist: {
      findMany: vi.fn(async () => (over.userArtists === undefined ? [] : over.userArtists)),
    },
    $queryRaw: vi.fn(async () => (over.queryRaw === undefined ? [] : over.queryRaw)),
  };
  const musicBrainzService = {
    getArtistData: vi.fn(async () => (over.getArtistData === undefined ? null : over.getArtistData)),
  };
  const cache = {
    get: vi.fn(async () => (over.cacheGet === undefined ? null : over.cacheGet)),
    set: vi.fn(async () => undefined),
  };
  const service = new CountryService(prisma as never, musicBrainzService as never, cache as never);
  return { service, prisma, musicBrainzService, cache };
};

/** Reaches the private preload latch so the memoisation branch can be tested. */
const privates = (service: CountryService) =>
  service as unknown as {
    dbArtistCountryMap: Map<string, string>;
    dbPreloadPromise: Promise<void> | null;
  };

const seedMap = (service: CountryService) => service.seedArtistCountryMap;

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('CountryService.getSeedCountry', () => {
  it('finds a curated artist regardless of case or padding', () => {
    const { service } = build();
    expect(service.getSeedCountry('Radiohead')).toBe('GB');
    expect(service.getSeedCountry('  RADIOHEAD ')).toBe('GB');
  });

  it('returns undefined for an artist that is not curated', () => {
    const { service } = build();
    expect(service.getSeedCountry('Definitely Not A Real Band 12345')).toBeUndefined();
  });

  it('populates the seed map with lowercase keys and uppercase values', () => {
    const { service } = build();
    // The resource file is keyed however it is keyed; the map is normalised on
    // load, which is what makes `getSeedCountry` case-insensitive.
    expect(seedMap(service).get('radiohead')).toBe('GB');
    expect(seedMap(service).get('nirvana')).toBe('US');
  });

  it('is idempotent across reloads', () => {
    const { service } = build();
    const before = seedMap(service).size;
    service.reloadSeedMap();
    service.reloadSeedMap();
    expect(seedMap(service).size).toBe(before);
  });
});

describe('CountryService.trimCountry', () => {
  it('lowercases, drops all whitespace and strips hyphens', () => {
    expect(CountryService.trimCountry('  United   States ')).toBe('unitedstates');
    expect(CountryService.trimCountry('South-Korea')).toBe('southkorea');
    expect(CountryService.trimCountry('Bosnia\tand\nHerzegovina')).toBe('bosniaandherzegovina');
  });

  it('leaves an already-trimmed value unchanged', () => {
    expect(CountryService.trimCountry('japan')).toBe('japan');
  });
});

describe('CountryService.getCountryByCode', () => {
  it('is case-insensitive on the code', () => {
    const { service } = build();
    expect(service.getCountryByCode('us')?.Name).toBe('United States');
    expect(service.getCountryByCode('US')?.Name).toBe('United States');
  });

  it('returns undefined for a code that is not in the table', () => {
    const { service } = build();
    expect(service.getCountryByCode('ZZ')).toBeUndefined();
  });
});

describe('CountryService.countryCodeToCountryName', () => {
  it('resolves a known code to its display name', () => {
    const { service } = build();
    expect(service.countryCodeToCountryName('NL')).toBe('Netherlands');
    expect(service.countryCodeToCountryName('nl')).toBe('Netherlands');
  });

  it('echoes the code back for an unknown one rather than rendering blank', () => {
    // A card that said "undefined" is worse than one that said "ZZ".
    const { service } = build();
    expect(service.countryCodeToCountryName('ZZ')).toBe('ZZ');
  });
});

describe('CountryService.searchCountry', () => {
  it('matches an exact name ignoring case, spaces and hyphens', () => {
    const { service } = build();
    expect(service.searchCountry('South Korea')?.Code).toBe('KR');
    expect(service.searchCountry('south-korea')?.Code).toBe('KR');
    expect(service.searchCountry('SOUTH KOREA')?.Code).toBe('KR');
  });

  it('matches a two-letter code', () => {
    const { service } = build();
    expect(service.searchCountry('JP')?.Code).toBe('JP');
    expect(service.searchCountry('jp')?.Code).toBe('JP');
  });

  it('matches a declared alias', () => {
    const { service } = build();
    expect(service.searchCountry('Great Britain')?.Code).toBe('GB');
    expect(service.searchCountry('Holland')?.Code).toBe('NL');
  });

  it('matches on the emoji, which is compared verbatim', () => {
    // The emoji arm is an exact `===` against the trimmed input, so this only
    // works for the flag itself - not for a regional-indicator pair by name.
    const { service } = build();
    const jp = service.countries.find(c => c.Code === 'JP');
    expect(service.searchCountry(`  ${jp?.Emoji}  `)?.Code).toBe('JP');
  });

  it('returns undefined for empty, blank or unknown input', () => {
    const { service } = build();
    expect(service.searchCountry('')).toBeUndefined();
    expect(service.searchCountry('   ')).toBeUndefined();
    // searchCountry is EXACT-match only; the fuzzy behaviour lives in
    // searchCountries, and pinning the difference stops the two being merged.
    expect(service.searchCountry('United')).toBeUndefined();
    expect(service.searchCountry('Atlantis')).toBeUndefined();
  });
});

describe('CountryService.searchCountries', () => {
  it('returns an empty array for empty or blank input', () => {
    const { service } = build();
    expect(service.searchCountries('')).toEqual([]);
    expect(service.searchCountries('  ')).toEqual([]);
  });

  it('finds every country whose name contains the query', () => {
    const { service } = build();
    const codes = service.searchCountries('United').map(c => c.Code);
    expect(codes).toContain('US');
    expect(codes).toContain('GB');
    expect(codes).toContain('AE');
  });

  it('still matches a partial alias', () => {
    const { service } = build();
    expect(service.searchCountries('Nippon').map(c => c.Code)).toEqual(['JP']);
  });

  it('returns an empty array when nothing matches', () => {
    const { service } = build();
    expect(service.searchCountries('Atlantis')).toEqual([]);
  });
});

describe('CountryService.ensureDbPreloaded', () => {
  it('short-circuits when the map is already populated', async () => {
    const { service, prisma } = build({ findMany: [{ name: 'Nirvana', countryCode: 'us' }] });
    await service.ensureDbPreloaded();
    expect(prisma.artist.findMany).toHaveBeenCalledTimes(1);
    await service.ensureDbPreloaded();
    expect(prisma.artist.findMany).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight promise between concurrent callers', async () => {
    // Without the latch three callers would fire three full-table reads.
    const { service, prisma } = build({ findMany: [] });
    const p = privates(service);
    await service.ensureDbPreloaded();
    p.dbArtistCountryMap.clear();
    p.dbPreloadPromise = null;
    const before = prisma.artist.findMany.mock.calls.length;
    await Promise.all([
      service.ensureDbPreloaded(),
      service.ensureDbPreloaded(),
      service.ensureDbPreloaded(),
    ]);
    expect(prisma.artist.findMany).toHaveBeenCalledTimes(before + 1);
  });

  it('uppercases the stored code and lowercases the key', async () => {
    const { service } = build({ findMany: [{ name: 'Nirvana', countryCode: 'us' }] });
    await service.ensureDbPreloaded();
    expect(privates(service).dbArtistCountryMap.get('nirvana')).toBe('US');
  });

  it('skips rows with a null country code', async () => {
    const { service } = build({
      findMany: [
        { name: 'Unknown One', countryCode: null },
        { name: 'Unknown Two', countryCode: 'jp' },
      ],
    });
    await service.ensureDbPreloaded();
    expect(privates(service).dbArtistCountryMap.has('unknown one')).toBe(false);
    expect(privates(service).dbArtistCountryMap.get('unknown two')).toBe('JP');
  });

  it('swallows a failed preload instead of rejecting', async () => {
    const { service, prisma } = build();
    prisma.artist.findMany.mockRejectedValue(new Error('db down'));
    await expect(service.ensureDbPreloaded()).resolves.toBeUndefined();
    expect(privates(service).dbArtistCountryMap.size).toBe(0);
  });
});

describe('CountryService.getArtistCountry', () => {
  const UNKNOWN = 'Zzqx Unknown Band 9182';

  it('returns undefined for an empty or blank artist name', async () => {
    const { service } = build();
    await expect(service.getArtistCountry('')).resolves.toBeUndefined();
    await expect(service.getArtistCountry('   ')).resolves.toBeUndefined();
  });

  it('answers from the curated seed map without any lookup', async () => {
    const { service, prisma, cache, musicBrainzService } = build();
    const result = await service.getArtistCountry('Radiohead');
    expect(result?.Code).toBe('GB');
    expect(prisma.artist.findFirst).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
    expect(musicBrainzService.getArtistData).not.toHaveBeenCalled();
  });

  it('answers from the preloaded database map', async () => {
    const { service, prisma, cache } = build({
      findMany: [{ name: 'Nirvana', countryCode: 'us' }],
    });
    const result = await service.getArtistCountry('Nirvana');
    expect(result?.Name).toBe('United States');
    expect(prisma.artist.findFirst).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('answers from the cache and skips the database and MusicBrainz', async () => {
    const { service, prisma, cache, musicBrainzService } = build({ findMany: [], cacheGet: 'NL' });
    const result = await service.getArtistCountry(UNKNOWN);
    expect(result?.Code).toBe('NL');
    expect(cache.get).toHaveBeenCalledWith(`artist_country:${UNKNOWN.toLowerCase()}`);
    expect(prisma.artist.findFirst).not.toHaveBeenCalled();
    expect(musicBrainzService.getArtistData).not.toHaveBeenCalled();
  });

  it('falls through to the live database row and backfills both maps', async () => {
    const { service, prisma, cache } = build({
      findMany: [],
      findFirst: { countryCode: 'jp' },
    });
    const result = await service.getArtistCountry('  RIN  ');
    expect(result?.Name).toBe('Japan');
    expect(prisma.artist.findFirst).toHaveBeenCalledWith({
      where: { name: { equals: 'RIN', mode: 'insensitive' } },
      select: { countryCode: true },
    });
    expect(cache.set).toHaveBeenCalledWith('artist_country:rin', 'JP', 86400);
    // Second call is served from the in-memory map, not the database.
    expect(privates(service).dbArtistCountryMap.get('rin')).toBe('JP');
  });

  it('falls through to MusicBrainz and writes the answer back to the database', async () => {
    const { service, prisma, cache, musicBrainzService } = build({
      findMany: [],
      getArtistData: { countryCode: 'de' },
    });
    const result = await service.getArtistCountry(UNKNOWN);
    expect(result?.Name).toBe('Germany');
    expect(musicBrainzService.getArtistData).toHaveBeenCalledWith(UNKNOWN);
    expect(cache.set).toHaveBeenCalledWith(`artist_country:${UNKNOWN.toLowerCase()}`, 'DE', 86400);
    expect(prisma.artist.updateMany).toHaveBeenCalledWith({
      where: { name: { equals: UNKNOWN, mode: 'insensitive' } },
      data: { countryCode: 'DE' },
    });
  });

  it('skips a MusicBrainz answer that carries no country', async () => {
    const { service, prisma } = build({ findMany: [], getArtistData: { countryCode: null } });
    await expect(service.getArtistCountry(UNKNOWN)).resolves.toBeUndefined();
    expect(prisma.artist.updateMany).not.toHaveBeenCalled();
  });

  it('returns undefined and survives a database error', async () => {
    const { service, prisma, musicBrainzService } = build({ findMany: [] });
    prisma.artist.findFirst.mockRejectedValue(new Error('db down'));
    musicBrainzService.getArtistData.mockResolvedValue(null);
    await expect(service.getArtistCountry(UNKNOWN)).resolves.toBeUndefined();
  });

  it('returns undefined and survives a MusicBrainz error', async () => {
    const { service, musicBrainzService } = build({ findMany: [] });
    musicBrainzService.getArtistData.mockRejectedValue(new Error('mb down'));
    await expect(service.getArtistCountry(UNKNOWN)).resolves.toBeUndefined();
  });

  it('does not fail when the fire-and-forget database write rejects', async () => {
    // updateMany is deliberately not awaited - `.catch(() => undefined)` keeps
    // an unhandled rejection out of the process. The lookup still succeeds.
    const { service, prisma } = build({ findMany: [], getArtistData: { countryCode: 'de' } });
    prisma.artist.updateMany.mockRejectedValue(new Error('write failed'));
    await expect(service.getArtistCountry(UNKNOWN)).resolves.toMatchObject({ Code: 'DE' });
  });
});

describe('CountryService.getArtistInfoWithCountry', () => {
  it('returns the country and the stored Spotify image together', async () => {
    const { service } = build({
      findMany: [],
      findFirst: { spotifyImageUrl: 'https://img/a.png' },
    });
    await expect(service.getArtistInfoWithCountry('Radiohead')).resolves.toEqual({
      country: expect.objectContaining({ Code: 'GB' }),
      spotifyImageUrl: 'https://img/a.png',
    });
  });

  it('omits the image key rather than setting it to null', async () => {
    const { service } = build({ findMany: [], findFirst: null });
    await expect(service.getArtistInfoWithCountry('Radiohead')).resolves.toEqual({
      country: expect.objectContaining({ Code: 'GB' }),
      spotifyImageUrl: undefined,
    });
  });

  it('still returns the country when the image lookup throws', async () => {
    const { service, prisma } = build({ findMany: [] });
    prisma.artist.findFirst.mockRejectedValue(new Error('db down'));
    await expect(service.getArtistInfoWithCountry('Radiohead')).resolves.toMatchObject({
      country: expect.objectContaining({ Code: 'GB' }),
      spotifyImageUrl: undefined,
    });
  });
});

describe('CountryService.getTopCountriesForTopArtists', () => {
  it('returns an empty array for an empty or missing artist list', async () => {
    const { service } = build();
    await expect(service.getTopCountriesForTopArtists([])).resolves.toEqual([]);
    await expect(service.getTopCountriesForTopArtists(undefined as never)).resolves.toEqual([]);
  });

  it('sums playcounts per country and sorts by playcount descending', async () => {
    const { service } = build({ findMany: [] });
    const result = await service.getTopCountriesForTopArtists([
      { name: 'Radiohead', playcount: 10 },
      { name: 'Burial', playcount: 5 },
      { name: 'Nirvana', playcount: 20 },
    ]);
    expect(result).toEqual([
      { countryName: 'United States', countryCode: 'US', playcount: 20, artistCount: undefined, artists: undefined },
      { countryName: 'United Kingdom', countryCode: 'GB', playcount: 15, artistCount: undefined, artists: undefined },
    ]);
  });

  it('groups and sorts the contributing artists when addArtists is set', async () => {
    const { service } = build({ findMany: [] });
    const result = await service.getTopCountriesForTopArtists([
      { name: 'Radiohead', playcount: 10 },
      { name: 'Burial', playcount: 5 },
      { name: 'Nirvana', playcount: 1 },
    ], true);
    const gb = result.find(r => r.countryCode === 'GB');
    expect(gb?.artists).toEqual([
      { name: 'Radiohead', playcount: 10 },
      { name: 'Burial', playcount: 5 },
    ]);
    expect(gb?.artistCount).toBe(2);
  });

  it('sorts by ARTIST COUNT when addArtists is set, not by playcount', async () => {
    // A country with three one-play artists outranks a country with one
    // ten-play artist, because the card is showing artist variety.
    const { service } = build({ findMany: [] });
    const result = await service.getTopCountriesForTopArtists([
      { name: 'Nirvana', playcount: 10 },
      { name: 'Radiohead', playcount: 1 },
      { name: 'Burial', playcount: 1 },
    ], true);
    expect(result[0]?.countryCode).toBe('GB');
    expect(result[0]?.artistCount).toBe(2);
  });

  it('skips an artist whose country is unknown and one with no plays', async () => {
    const { service } = build({ findMany: [] });
    const result = await service.getTopCountriesForTopArtists([
      { name: 'Nirvana', playcount: 5 },
      { name: 'Zzqx Unknown Band 9182', playcount: 500 },
      { name: 'Radiohead', playcount: 0 },
    ]);
    expect(result).toEqual([
      { countryName: 'United States', countryCode: 'US', playcount: 5, artistCount: undefined, artists: undefined },
    ]);
  });

  it('resolves at most five unknown artists in the background', async () => {
    vi.useFakeTimers();
    const { service, musicBrainzService } = build({ findMany: [] });
    const missing = Array.from({ length: 7 }, (_, i) => ({ name: `Missing ${i}`, playcount: 1 }));
    const promise = service.getTopCountriesForTopArtists(missing);
    // The response is produced before MusicBrainz is consulted at all.
    await expect(promise).resolves.toEqual([]);
    await vi.runAllTimersAsync();
    expect(musicBrainzService.getArtistData).toHaveBeenCalledTimes(5);
  });

  it('records a background MusicBrainz answer in the in-memory map', async () => {
    vi.useFakeTimers();
    const { service, prisma } = build({ findMany: [], getArtistData: { countryCode: 'fr' } });
    await service.getTopCountriesForTopArtists([{ name: 'Zzqx Unknown Band 9182', playcount: 1 }]);
    await vi.runAllTimersAsync();
    expect(privates(service).dbArtistCountryMap.get('zzqx unknown band 9182')).toBe('FR');
    expect(prisma.artist.updateMany).toHaveBeenCalledWith({
      where: { name: { equals: 'Zzqx Unknown Band 9182', mode: 'insensitive' } },
      data: { countryCode: 'FR' },
    });
  });

  it('still answers when a background MusicBrainz lookup rejects', async () => {
    vi.useFakeTimers();
    const { service, musicBrainzService } = build({ findMany: [] });
    musicBrainzService.getArtistData.mockRejectedValue(new Error('mb down'));
    await expect(
      service.getTopCountriesForTopArtists([{ name: 'Zzqx Unknown Band 9182', playcount: 1 }]),
    ).resolves.toEqual([]);
    await vi.runAllTimersAsync();
    expect(privates(service).dbArtistCountryMap.size).toBe(0);
  });
});

describe('CountryService.getUserArtistsTop', () => {
  it('returns the rows ordered by playcount', async () => {
    const rows = [{ name: 'Nirvana', playcount: 9 }];
    const { service, prisma } = build({ userArtists: rows });
    await expect(service.getUserArtistsTop(1)).resolves.toEqual(rows);
    expect(prisma.userArtist.findMany).toHaveBeenCalledWith({
      where: { userId: 1 },
      select: { name: true, playcount: true },
      orderBy: { playcount: 'desc' },
      take: 10000,
    });
  });

  it('returns an empty array when the query throws', async () => {
    const { service, prisma } = build();
    prisma.userArtist.findMany.mockRejectedValue(new Error('db down'));
    await expect(service.getUserArtistsTop(1)).resolves.toEqual([]);
  });
});

describe('CountryService.getUserTopCountriesAllTime', () => {
  it('aggregates the user artists in memory when they resolve to countries', async () => {
    const { service, prisma } = build({
      findMany: [],
      userArtists: [
        { name: 'Radiohead', playcount: 10 },
        { name: 'Nirvana', playcount: 20 },
      ],
    });
    const result = await service.getUserTopCountriesAllTime(1);
    // The aggregate path is called with addArtists=true, which means the
    // ordering is by ARTIST COUNT, not playcount - both countries have one
    // artist, so this is a tie and insertion order survives.
    expect(result.map(r => r.countryCode)).toEqual(['GB', 'US']);
    // The aggregate path answered, so the raw query was never needed.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('orders the user list by artist count, not by playcount', async () => {
    // Pinned because it is surprising: `getUserTopCountriesAllTime` delegates
    // to `getTopCountriesForTopArtists(..., true)`, whose sort key under
    // `addArtists` is `artists.length`. A country with three one-play artists
    // is listed above one with a single ten-play artist.
    const { service } = build({
      findMany: [],
      userArtists: [
        { name: 'Nirvana', playcount: 10 },
        { name: 'Radiohead', playcount: 1 },
        { name: 'Burial', playcount: 1 },
      ],
    });
    const result = await service.getUserTopCountriesAllTime(1);
    expect(result.map(r => r.countryCode)).toEqual(['GB', 'US']);
    expect(result[0]?.artistCount).toBe(2);
    expect(result[1]?.playcount).toBe(10);
  });

  it('applies the limit to the aggregated list', async () => {
    const { service } = build({
      findMany: [],
      userArtists: [
        { name: 'Radiohead', playcount: 10 },
        { name: 'Nirvana', playcount: 20 },
      ],
    });
    await expect(service.getUserTopCountriesAllTime(1, 1)).resolves.toHaveLength(1);
  });

  it('falls back to the raw query when no artist has a known country', async () => {
    const { service, prisma } = build({
      findMany: [],
      userArtists: [{ name: 'Zzqx Unknown Band 9182', playcount: 10 }],
      queryRaw: [{ countryCode: 'jp', playcount: BigInt(5), artistCount: BigInt(2) }],
    });
    await expect(service.getUserTopCountriesAllTime(1)).resolves.toEqual([
      { countryName: 'Japan', countryCode: 'JP', playcount: 5, artistCount: 2 },
    ]);
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it('uppercases the raw country code', async () => {
    const { service } = build({
      findMany: [],
      queryRaw: [{ countryCode: 'jp', playcount: BigInt(5), artistCount: BigInt(2) }],
    });
    const result = await service.getUserTopCountriesAllTime(1);
    expect(result[0]?.countryCode).toBe('JP');
  });

  it('returns an empty array when the whole path throws', async () => {
    const { service, prisma } = build();
    prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    await expect(service.getUserTopCountriesAllTime(1)).resolves.toEqual([]);
  });
});

describe('CountryService.getUserArtistsForCountry', () => {
  it('maps the rows and normalises the bigint playcount', async () => {
    const { service } = build({ queryRaw: [{ name: 'Radiohead', playcount: BigInt(12) }] });
    await expect(service.getUserArtistsForCountry(1, ' gb ')).resolves.toEqual([
      { name: 'Radiohead', playcount: 12 },
    ]);
  });

  it('returns an empty array when the query throws', async () => {
    const { service, prisma } = build();
    prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    await expect(service.getUserArtistsForCountry(1, 'GB')).resolves.toEqual([]);
  });
});

describe('CountryService.getGuildTopCountriesAllTime', () => {
  it('maps the rows, resolves the name and normalises both bigints', async () => {
    const { service } = build({
      queryRaw: [{ countryCode: 'jp', totalPlaycount: BigInt(40), listenerCount: BigInt(3) }],
    });
    await expect(service.getGuildTopCountriesAllTime('123')).resolves.toEqual([
      { countryName: 'Japan', countryCode: 'JP', totalPlaycount: 40, listenerCount: 3 },
    ]);
  });

  it('returns an empty array for a non-numeric guild id rather than throwing', async () => {
    const { service, prisma } = build({ queryRaw: [] });
    await expect(service.getGuildTopCountriesAllTime('not-a-snowflake')).resolves.toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns an empty array when the query throws', async () => {
    const { service, prisma } = build();
    prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    await expect(service.getGuildTopCountriesAllTime('123')).resolves.toEqual([]);
  });
});

describe('CountryService.getGuildArtistsForCountry', () => {
  it('maps the rows and normalises the summed playcount', async () => {
    const { service } = build({ queryRaw: [{ name: 'Radiohead', playcount: BigInt(31) }] });
    await expect(service.getGuildArtistsForCountry('123', ' GB ')).resolves.toEqual([
      { name: 'Radiohead', playcount: 31 },
    ]);
  });

  it('returns an empty array for a non-numeric guild id', async () => {
    const { service, prisma } = build({ queryRaw: [] });
    await expect(service.getGuildArtistsForCountry('abc', 'GB')).resolves.toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns an empty array when the query throws', async () => {
    const { service, prisma } = build();
    prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    await expect(service.getGuildArtistsForCountry('123', 'GB')).resolves.toEqual([]);
  });
});

describe('CountryService.getGuildUsersForCountry', () => {
  it('stringifies the bigint discord id and normalises the playcount', async () => {
    const { service } = build({
      queryRaw: [{
        userId: 5,
        discordUserId: BigInt('900000000000000001'),
        userNameLastFm: 'moha',
        playcount: BigInt(8),
      }],
    });
    await expect(service.getGuildUsersForCountry('123', 'GB')).resolves.toEqual([
      { userId: 5, discordUserId: '900000000000000001', userNameLastFm: 'moha', playcount: 8 },
    ]);
  });

  it('returns an empty array for a non-numeric guild id', async () => {
    const { service, prisma } = build({ queryRaw: [] });
    await expect(service.getGuildUsersForCountry('abc', 'GB')).resolves.toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns an empty array when the query throws', async () => {
    const { service, prisma } = build();
    prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    await expect(service.getGuildUsersForCountry('123', 'GB')).resolves.toEqual([]);
  });
});
