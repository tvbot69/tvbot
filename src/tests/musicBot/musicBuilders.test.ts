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

  describe('buildNowPlayingMetaLine', () => {
    it('renders requester and remaining time with no emojis', () => {
      const line = MusicBuilders.buildNowPlayingMetaLine(248000, 15000, false, 'TestUser#0001');
      expect(line).toContain('Ordered by TestUser#0001');
      expect(line).toContain('3:53 mins left');
      expect(line).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    });

    it('renders seconds under a minute with singular handling', () => {
      expect(MusicBuilders.buildNowPlayingMetaLine(200000, 158000, false, undefined)).toContain('42 secs left');
      expect(MusicBuilders.buildNowPlayingMetaLine(200000, 199500, false, undefined)).toContain('1 sec left');
    });

    it('renders Live for streams', () => {
      const line = MusicBuilders.buildNowPlayingMetaLine(0, 0, true, undefined);
      expect(line).toContain('Live');
    });

    it('returns Live text when there is no duration', () => {
      expect(MusicBuilders.buildNowPlayingMetaLine(0, 0, false, undefined)).toBe('-# Live');
    });
  });

  describe('buildNowPlayingResponse', () => {
    it('builds a rich Now Playing card with hero artwork and 2 streamlined action rows in Components V2 container', () => {
      const response = MusicBuilders.buildNowPlayingResponse(sampleQueue, 0xff0000);
      expect(response.embed.data.description).toContain('Starboy');
      expect(response.embed.data.description).toContain('The Weeknd');
      expect(response.embed.data.description).not.toContain('🔘');
      // One-line header: title • artist • badge (no album on this track).
      expect(response.embed.data.description).toContain(
        '[Starboy](https://open.spotify.com/track/abc12345) • The Weeknd •',
      );
      expect(response.embed.data.description).not.toContain('###');
      // Text-only remaining-time footer (position 100000 of 230000).
      expect(response.embed.data.description).toContain('Ordered by TestUser#0001 • 2:10 mins left');
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

    it('inserts the album into the one-line header when known', () => {
      const withAlbum: MusicQueueInfo = {
        ...sampleQueue,
        current: { ...sampleTrack, album: 'After Hours' },
      };
      const response = MusicBuilders.buildNowPlayingResponse(withAlbum, 0xff0000);
      expect(response.embed.data.description).toContain(
        '[Starboy](https://open.spotify.com/track/abc12345) • After Hours • The Weeknd •',
      );
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

describe('buildChaptersResponse', () => {
  it('gives every select row a unique custom_id (26+ chapters = two rows)', () => {
    const chapters = Array.from({ length: 30 }, (_, i) => ({
      title: `Chapter ${i + 1}`,
      startMs: i * 60_000,
    }));
    const response = MusicBuilders.buildChaptersResponse(
      { title: 'Live Show', author: 'Artist', uri: 'https://www.youtube.com/watch?v=abcdefghijk' },
      chapters,
      0,
    );
    const container = (
      response as unknown as {
        componentsV2Container: { toJSON(): { components: Array<{ components?: Array<{ custom_id?: string }> }> } };
      }
    ).componentsV2Container;
    const customIds = container
      .toJSON()
      .components.flatMap((c) => (c.components ?? []).map((child) => child.custom_id))
      .filter((id): id is string => typeof id === 'string');
    expect(customIds).toHaveLength(2);
    expect(new Set(customIds).size).toBe(2);
    expect(customIds.every((id) => id.startsWith('music:chapters:seek:'))).toBe(true);
  });

  it('drops the Chapters title line but keeps the track header', () => {
    const response = MusicBuilders.buildChaptersResponse(
      { title: 'Live Show', author: 'Artist', uri: 'https://www.youtube.com/watch?v=abcdefghijk' },
      [{ title: 'Opener', startMs: 0 }],
      0,
    );
    expect(response.embed.data.description).not.toContain('⏱️ Chapters');
    expect(response.embed.data.description).toContain('[Live Show](https://www.youtube.com/watch?v=abcdefghijk)');
    expect(response.embed.data.title).toBe('Live Show');
  });
});
