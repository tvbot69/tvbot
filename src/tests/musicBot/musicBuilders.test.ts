import { describe, it, expect } from 'vitest';
import { MusicBuilders } from '@bot/builders/musicBuilders';
import type { MusicQueueInfo } from '@domain/models/music/musicQueue';
import type { MusicTrack } from '@domain/models/music/musicTrack';

describe('MusicBuilders', () => {
  const sampleTrack: MusicTrack = {
    identifier: 'abc12345',
    title: 'Starboy',
    author: 'The Weeknd',
    uri: 'https://open.spotify.com/track/abc12345',
    duration: 230000,
    isSeekable: true,
    isStream: false,
    artworkUrl: 'https://i.scdn.co/image/starboy.jpg',
    source: 'spotify',
    requester: {
      id: '999999',
      tag: 'TestUser#0001',
      avatarUrl: 'https://cdn.discordapp.com/avatars/user.png',
    },
  };

  const sampleQueue: MusicQueueInfo = {
    guildId: '111222333',
    current: sampleTrack,
    tracks: [
      {
        identifier: 'def67890',
        title: 'Blinding Lights',
        author: 'The Weeknd',
        uri: 'https://open.spotify.com/track/def67890',
        duration: 200000,
        isSeekable: true,
        isStream: false,
        source: 'spotify',
        requester: { id: '999999', tag: 'TestUser#0001' },
      },
    ],
    totalTracks: 2,
    totalDuration: 430000,
    remainingDuration: 330000,
    loopMode: 'off',
    volume: 100,
    isPaused: false,
    isPlaying: true,
    is247: false,
    autoplay: false,
    activeFilters: ['bassboost'],
    position: 100000,
    ping: 25,
  };

  describe('buildProgressBar', () => {
    it('renders live indicator for livestreams', () => {
      const liveBar = MusicBuilders.buildProgressBar(0, 0);
      expect(liveBar).toContain('LIVE');
    });

    it('renders progress bar with correct dot placement', () => {
      const bar = MusicBuilders.buildProgressBar(50000, 100000, 10);
      expect(bar).toContain('🔘');
      expect(bar).toContain('▬');
      expect(bar).toContain('0:50');
      expect(bar).toContain('1:40');
    });
  });

  describe('buildNowPlayingResponse', () => {
    it('builds a rich Now Playing card with hero artwork and 2 streamlined action rows in Components V2 container', () => {
      const response = MusicBuilders.buildNowPlayingResponse(sampleQueue, 0xff0000);
      expect(response.embed.data.description).toContain('Starboy');
      expect(response.embed.data.description).toContain('The Weeknd');
      expect(response.embed.data.description).toContain('🔘');
      expect(response.embed.data.description).toContain('<:sp:1496297132381048995>');

      // Modern Discord Components V2 container
      expect(response.isComponentsV2).toBe(true);
      expect(response.componentsV2Container).toBeDefined();

      const payload = response.toMessagePayload();
      expect(payload.flags).toBe(32768);
      expect(Array.isArray(payload.components)).toBe(true);

      // Fallback embed has single embed with image
      const embeds = response.buildEmbed();
      expect(embeds.length).toBe(1);
      expect((embeds[0] as unknown as { data: { image?: { url?: string } } })?.data?.image?.url).toBe(sampleTrack.artworkUrl);

      const components = response.buildComponents();
      expect(components.length).toBe(1);

      // Row 0 has 5 square icon buttons: previous, pause_resume, skip, loop, stop
      const row0 = components[0]?.components ?? [];
      expect(row0.length).toBe(5);
    });

    it('handles empty queue gracefully', () => {
      const emptyQueue: MusicQueueInfo = { ...sampleQueue, current: null, tracks: [] };
      const response = MusicBuilders.buildNowPlayingResponse(emptyQueue);
      expect(response.embed.data.description).toContain('Nothing is currently playing');
    });
  });

  describe('buildQueueResponse', () => {
    it('builds a formatted paginated queue with track removal dropdown', () => {
      const response = MusicBuilders.buildQueueResponse(sampleQueue, 1, 10);
      expect(response.embed.data.title).toContain('Music Queue');
      expect(response.embed.data.description).toContain('Blinding Lights');

      const components = response.buildComponents();
      expect(components.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('buildSearchResponse', () => {
    it('builds interactive search menu with dropdown and cancel button', () => {
      const response = MusicBuilders.buildSearchResponse('Weeknd', [sampleTrack]);
      expect(response.embed.data.title).toContain('Search Results: Weeknd');
      expect(response.embed.data.description).toContain('Starboy');

      const components = response.buildComponents();
      expect(components.length).toBe(2); // select menu row + cancel button row
    });
  });

  describe('getSourceBadge', () => {
    it('returns custom emojis for spotify, youtube, and soundcloud', async () => {
      const { getSourceBadge } = await import('@bot/builders/musicBuilders');
      expect(getSourceBadge('spotify')).toBe('<:sp:1496297132381048995>');
      expect(getSourceBadge('youtube')).toBe('<:yt:1496297072201040094>');
      expect(getSourceBadge('soundcloud')).toBe('<:sound:1545234670239879282>');
      expect(getSourceBadge(undefined)).toBe('<:yt:1496297072201040094>');
    });

    it('renders YouTube badge in Now Playing card when track source is youtube', () => {
      const ytQueue: MusicQueueInfo = {
        ...sampleQueue,
        current: { ...sampleTrack, source: 'youtube' },
      };
      const response = MusicBuilders.buildNowPlayingResponse(ytQueue);
      expect(response.embed.data.description).toContain('<:yt:1496297072201040094>');
    });

    it('renders SoundCloud badge in Now Playing card when track source is soundcloud', () => {
      const scQueue: MusicQueueInfo = {
        ...sampleQueue,
        current: { ...sampleTrack, source: 'soundcloud' },
      };
      const response = MusicBuilders.buildNowPlayingResponse(scQueue);
      expect(response.embed.data.description).toContain('<:sound:1545234670239879282>');
    });
  });
});
