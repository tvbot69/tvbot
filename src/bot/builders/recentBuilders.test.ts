import { describe, expect, it } from 'vitest';
import { RecentBuilders } from './recentBuilders';

describe('RecentBuilders', () => {
  it('builds a Component v2 container for recent scrobbles with dividers and buttons', () => {
    const recentData = {
      tracks: [
        {
          name: 'Song A',
          artistName: 'Artist A',
          albumName: 'Album A',
          nowPlaying: true,
          trackUrl: 'https://last.fm/trackA',
          coverUrl: 'https://cdn.example.com/coverA.jpg',
        },
        {
          name: 'Song B',
          artistName: 'Artist B',
          albumName: 'Album B',
          nowPlaying: false,
          timePlayed: new Date('2026-08-30T12:00:00Z'),
          trackUrl: 'https://last.fm/trackB',
        },
      ],
      totalScrobbles: 187416,
      totalPages: 80,
    };

    const response = RecentBuilders.buildRecentTracksResponse(
      'Moha504',
      'moha',
      '123456789',
      recentData,
      1,
      0xff0000,
    );

    expect(response.isComponentsV2).toBe(true);
    const container = response.componentsV2Container!;
    const json = container.toJSON();

    // Check title
    expect(JSON.stringify(json)).toContain('Recent tracks for [moha](https://www.last.fm/user/Moha504/library)');
    // Check right now timestamp
    expect(JSON.stringify(json)).toContain('Right now • *Album A*');
    // Check song names
    expect(JSON.stringify(json)).toContain('Song A');
    expect(JSON.stringify(json)).toContain('Song B');
    // Check footer with formatted total scrobbles
    expect(JSON.stringify(json)).toContain('1/80 - Moha504 has 187,416 scrobbles');
    // Check pagination buttons
    expect(JSON.stringify(json)).toContain('recent:next:1:123456789:Moha504');
  });
});
