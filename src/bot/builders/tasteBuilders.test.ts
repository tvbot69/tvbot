import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TasteBuilders } from './tasteBuilders';
import type { TasteData } from '@bot/services/tasteService';

describe('TasteBuilders', () => {
  it('builds Component v2 container with comparison codeblock table, tabs, and expand button', () => {
    const tasteData: TasteData = {
      cacheKey: 'test_session_123',
      user1DiscordId: '12345',
      user2DiscordId: '67890',
      user1DisplayName: 'Moha504',
      user2DisplayName: 'Adaugh',
      user1UserNameLastFm: 'Moha504',
      user2UserNameLastFm: 'Adaugh',
      url: 'https://last.fm/user/Moha504/tasteomatic?with=Adaugh',
      timePeriodDescription: 'overall',
      amount: 14,
      artists: {
        items: [
          { name: 'TV Girl', ownPlaycount: 5815, otherPlaycount: 16 },
          { name: 'Taylor Swift', ownPlaycount: 200, otherPlaycount: 350 },
        ],
        totalCount: 2,
      },
      genres: {
        items: [
          { name: 'indie pop', ownPlaycount: 5815, otherPlaycount: 16 },
        ],
        totalCount: 1,
      },
      countries: {
        items: [
          { name: 'United States', ownPlaycount: 5815, otherPlaycount: 16 },
        ],
        totalCount: 1,
      },
    };

    const response = TasteBuilders.buildTasteResponse(tasteData, 0, 14);

    expect(response.isComponentsV2).toBe(true);
    const json = response.componentsV2Container!.toJSON();
    const str = JSON.stringify(json);

    // Title
    expect(str).toContain('Moha504 vs Adaugh');
    // Codeblock table
    expect(str).toContain('```');
    expect(str).toContain('Artist');
    expect(str).toContain('TV Girl');
    expect(str).toContain('5815 > 16');
    // Tabs & Plus button
    expect(str).toContain('taste-tab:test_session_123:0:12345:67890:overall:14');
    expect(str).toContain('taste-tab:test_session_123:1:12345:67890:overall:14');
    expect(str).toContain('taste-tab:test_session_123:2:12345:67890:overall:14');
    expect(str).toContain('1483232894318149692'); // Plus emoji ID
  });
});
