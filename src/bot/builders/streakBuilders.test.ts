import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { StreakBuilders } from './streakBuilders';
import { getEmojiForStreakCount } from '@bot/services/streakService';

describe('StreakBuilders', () => {
  it('correctly maps streak emojis based on thresholds', () => {
    expect(getEmojiForStreakCount(51)).toBe('🔥');
    expect(getEmojiForStreakCount(69)).toBe('😎');
    expect(getEmojiForStreakCount(100)).toBe('💯');
    expect(getEmojiForStreakCount(420)).toBe('🍃');
    expect(getEmojiForStreakCount(666)).toBe('😈');
    expect(getEmojiForStreakCount(1001)).toBe('😲');
    expect(getEmojiForStreakCount(1234)).toBe('🔢');
    expect(getEmojiForStreakCount(1337)).toBe('🦹');
    expect(getEmojiForStreakCount(5001)).toBe('🚀');
    expect(getEmojiForStreakCount(10)).toBeNull();
  });

  it('builds active streak overview matching fmbot 1:1', () => {
    const response = StreakBuilders.buildStreakResponse(
      'Moha',
      'Moha504',
      {
        artistName: 'Gunna',
        artistPlaycount: 69,
        albumName: 'DS4EVER',
        albumPlaycount: 15,
        trackName: 'thought i was playing',
        trackPlaycount: 8,
        genreName: 'Hip-Hop',
        genrePlaycount: 69,
        streakStarted: new Date('2026-09-05T20:00:00Z'),
        streakEnded: new Date('2026-09-05T22:00:00Z'),
        emoji: '😎',
      },
      0xa6006c,
    );

    expect(response.embed).toBeDefined();
    const desc = response.embed.data.description ?? '';
    expect(desc).toContain('### Streak overview for [Moha](https://last.fm/user/Moha504/library)');
    expect(desc).toContain('`Artist:` **[Gunna](https://last.fm/music/Gunna)** - 😎 **69** plays');
    expect(desc).toContain('` Album:` **[DS4EVER](https://last.fm/music/Gunna/DS4EVER)** - **15** plays');
    expect(desc).toContain('` Track:` **[thought i was playing](https://last.fm/music/Gunna/_/thought%20i%20was%20playing)** - **8** plays');
    expect(desc).toContain('` Genre:` **Hip-Hop** - 😎 **69** plays');
    expect(desc).toContain('Streak started <t:1788638400:R>.');
    expect(response.embed.data.color).toBe(0xa6006c);
  });

  it('builds no active streak response gracefully', () => {
    const response = StreakBuilders.buildStreakResponse('Moha', 'Moha504', null);
    expect(response.embed.data.description).toContain('No active streak found.');
  });
});
