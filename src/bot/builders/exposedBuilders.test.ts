import { describe, it, expect } from 'vitest';
import { ExposedBuilders } from './exposedBuilders';
import type { ExposedReport } from '@bot/services/exposedService';

describe('ExposedBuilders', () => {
  const dummyReport: ExposedReport = {
    user: { userId: 1 } as any,
    displayName: 'Moha',
    publicArtists: ['Death Grips', 'Travis Scott'],
    publicGenres: ['experimental', 'hip-hop'],
    guiltyPleasures: [
      {
        artistName: 'Sabrina Carpenter',
        trackName: 'Espresso',
        playcount: 12,
        genres: ['pop', 'dance-pop'],
        reason: 'Secretly enjoying dance-pop',
      },
    ],
    roast: 'Bro thought Spotify Private Session was turned on 💀',
    shameScore: 85,
  };

  it('builds a rich 4K exposure response', () => {
    const response = ExposedBuilders.buildExposedResponse(dummyReport, 'https://example.com/avatar.png');
    expect(response.embed).toBeDefined();

    const json = response.embed.toJSON();
    expect(json.title).toContain('CAUGHT IN 4K: Moha');
    expect(json.thumbnail?.url).toBe('https://example.com/avatar.png');
    expect(json.fields).toHaveLength(4);

    const publicField = json.fields?.find((f) => f.name.includes('Public Persona'));
    expect(publicField?.value).toContain('Death Grips');

    const vaultField = json.fields?.find((f) => f.name.includes('The Secret Vault'));
    expect(vaultField?.value).toContain('Sabrina Carpenter');
    expect(vaultField?.value).toContain('12 plays');

    const verdictField = json.fields?.find((f) => f.name.includes('The Verdict'));
    expect(verdictField?.value).toContain('Spotify Private Session');

    const indexField = json.fields?.find((f) => f.name.includes('Down Bad Index'));
    expect(indexField?.value).toContain('85% Guilty');
  });

  it('builds a clean record response', () => {
    const response = ExposedBuilders.buildCleanRecordResponse('Moha');
    expect(response.embed).toBeDefined();
    const json = response.embed.toJSON();
    expect(json.title).toContain('4K Scan Complete: Moha');
    expect(json.description).toContain('zero secret guilty pleasures');
  });
});
