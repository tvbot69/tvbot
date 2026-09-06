import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { CountryService } from './countryService';

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
