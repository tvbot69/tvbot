import 'reflect-metadata';
import { describe, it, expect, afterAll } from 'vitest';
import { WhoKnowsGenerator } from './whoKnowsGenerator';
import { PuppeteerService } from './puppeteerService';

const puppeteer = new PuppeteerService();
const generator = new WhoKnowsGenerator(puppeteer);

afterAll(async () => {
  await puppeteer.close();
});

describe('WhoKnowsGenerator', () => {
  it('renders a WhoKnows leaderboard card to valid PNG bytes', async () => {
    const users = [
      { userId: 1, playcount: 150, lastFmUsername: 'user1', discordName: 'Alice', hasCrown: true },
      { userId: 2, playcount: 120, lastFmUsername: 'user2', discordName: 'Bob' },
      { userId: 3, playcount: 90, lastFmUsername: 'user3', discordName: 'Charlie' },
      { userId: 4, playcount: 45, lastFmUsername: 'user4', discordName: 'David' },
    ];

    const png = await generator.generateWhoKnowsImage({
      type: 'Who Knows Artist',
      title: 'Radiohead',
      location: 'Music Hub',
      imageUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      users,
      callerUserId: 2,
      crownText: 'Crown claimed by Alice with 150 plays!',
    });

    expect(png.length).toBeGreaterThan(1000);
    expect(png[0]).toBe(0x89);
    expect(png.toString('ascii', 1, 4)).toBe('PNG');
  }, 60000);

  it('renders caller outside top 10 properly', async () => {
    const users = Array.from({ length: 15 }, (_, i) => ({
      userId: i + 1,
      playcount: 100 - i * 5,
      lastFmUsername: `listener${i + 1}`,
      discordName: `Listener ${i + 1}`,
    }));

    const png = await generator.generateWhoKnowsImage({
      type: 'Who Knows Track',
      title: 'Karma Police',
      location: 'The Server',
      users,
      callerUserId: 14, // Rank #14
    });

    expect(png.length).toBeGreaterThan(1000);
    expect(png[0]).toBe(0x89);
    expect(png.toString('ascii', 1, 4)).toBe('PNG');
  }, 60000);

  it('renders with custom backgroundCovers mosaic correctly', async () => {
    const users = [
      { userId: 1, playcount: 80, lastFmUsername: 'user1' },
    ];

    const png = await generator.generateWhoKnowsImage({
      type: 'Who Knows Artist',
      title: 'Daft Punk',
      location: 'Discovery Club',
      users,
      backgroundCovers: [
        'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
        'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      ],
    });

    expect(png.length).toBeGreaterThan(1000);
    expect(png[0]).toBe(0x89);
    expect(png.toString('ascii', 1, 4)).toBe('PNG');
  }, 60000);
});
