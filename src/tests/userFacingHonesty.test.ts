import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { GenericEmbedService } from '@bot/services/genericEmbedService';
import { MusicBuilders } from '@bot/builders/musicBuilders';
import { MusicCommands } from '@bot/textCommands/music/musicCommands';
import { NowPlayingInteractions } from '@bot/interactions/nowPlayingInteractions';
import { CommandResponse } from '@domain/enums/commandResponse';

/**
 * Regression cover for defects that shipped with a fully green suite because
 * nothing asserted the user-visible outcome. Each of these produced a
 * confident, wrong, or silent failure in front of a real user.
 */
describe('user-facing failure honesty', () => {
  describe('embed payload limits (builders assert and THROW, they do not warn)', () => {
    it('clamps an over-long error description instead of throwing', () => {
      const huge = 'x'.repeat(9000);
      const res = GenericEmbedService.buildNotFoundResponse(huge);
      expect(() => res.buildEmbed()).not.toThrow();
      expect(res.embed.data.description!.length).toBeLessThanOrEqual(4096);
    });

    it('clamps an over-long title and description in the custom embed', () => {
      const res = GenericEmbedService.buildCustomEmbedResponse('y'.repeat(900), 'z'.repeat(9000));
      expect(() => res.buildEmbed()).not.toThrow();
      expect(res.embed.data.title!.length).toBeLessThanOrEqual(256);
    });

    it('renders a 6000-char search query without throwing', () => {
      const query = 'a'.repeat(6000);
      const res = MusicBuilders.buildSearchResponse(query, []);
      expect(() => res.buildEmbed()).not.toThrow();
      expect(res.embed.data.title!.length).toBeLessThanOrEqual(256);
    });

    it('never renders an empty description (also an assertion failure)', () => {
      const res = GenericEmbedService.buildInfoResponse('');
      expect(() => res.buildEmbed()).not.toThrow();
    });
  });

  describe('queue pagination', () => {
    const makeQueue = (total: number) => ({
      current: {
        identifier: 'q1',
        title: 'Now Playing',
        author: 'Band',
        uri: 'https://youtube.com/watch?v=q1',
        duration: 200000,
        isSeekable: true,
        isStream: false,
        source: 'youtube' as const,
        position: 5000,
      },
      tracks: Array.from({ length: total }, (_, i) => ({
        identifier: `t${i}`,
        title: `Track ${i}`,
        author: 'Band',
        uri: `https://youtube.com/watch?v=t${i}`,
        duration: 1000,
        isSeekable: true,
        isStream: false,
        source: 'youtube' as const,
      })),
      totalTracks: total,
      totalDuration: total * 1000,
      remainingDuration: total * 1000,
      loopMode: 'off' as const,
      volume: 100,
      isPaused: false,
      isPlaying: true,
      is247: false,
      autoplay: false,
      position: 5000,
    });

    it('never produces a NaN page for junk input', () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
        const res = MusicBuilders.buildQueueResponse(makeQueue(30) as never, bad, 10);
        expect(() => res.buildEmbed()).not.toThrow();
        const payload = JSON.stringify(res.embed.toJSON());
        expect(payload).not.toContain('NaN');
      }
    });

    it('still paginates a valid page', () => {
      const res = MusicBuilders.buildQueueResponse(makeQueue(30) as never, 2, 10);
      const payload = JSON.stringify(res.embed.toJSON());
      expect(payload).toContain('Track 10');
      expect(payload).not.toContain('NaN');
    });
  });

  describe('.queue abc (NaN page produced an empty list and "Page NaN/3")', () => {
    it('falls back to page 1', async () => {
      const queue = {
        current: {
          identifier: 'q1',
          title: 'Now Playing',
          author: 'Band',
          uri: 'https://youtube.com/watch?v=q1',
          duration: 200000,
          isSeekable: true,
          isStream: false,
          source: 'youtube' as const,
        },
        tracks: [],
        totalTracks: 1,
        totalDuration: 0,
        remainingDuration: 0,
        loopMode: 'off' as const,
        volume: 100,
        isPaused: false,
        isPlaying: true,
        is247: false,
        autoplay: false,
        position: 0,
      };
      const svc = {
        getQueueInfo: vi.fn(() => queue),
        getPlayer: vi.fn(() => ({ get: () => undefined })),
        isKaraokeEnabled: vi.fn(() => false),
      };
      const colorSvc = { getAccentColorAsync: vi.fn(async () => 0xff0000) };
      const commands = new MusicCommands(svc as never, colorSvc as never, undefined as never, undefined as never);
      const ctx = {
        guildId: 'g1',
        prefix: '.',
        sender: { id: 'u1' },
        member: { voice: { channelId: 'vc1' } },
      };
      const res = await (commands as unknown as { queueAsync: (c: unknown, a: string[]) => Promise<{ embed: { toJSON: () => unknown } }> })
        .queueAsync(ctx, ['abc']);
      const payload = JSON.stringify(res.embed.toJSON());
      expect(payload).not.toContain('NaN');
    });
  });

  describe('Last.fm writes must not report success on rejection', () => {
    const makeButton = (customId: string) =>
      ({
        customId,
        user: { id: 'u1' },
        deferReply: vi.fn(async () => undefined),
        deferUpdate: vi.fn(async () => undefined),
        editReply: vi.fn(async () => undefined),
        reply: vi.fn(async () => undefined),
      }) as never;

    const makeInteractions = (loveOk: boolean) =>
      new NowPlayingInteractions(
        { getUserByDiscordUserId: vi.fn(async () => ({ userNameLastFm: 'someone', sessionKey: 'key' })) } as never,
        { loveTrack: vi.fn(async () => loveOk), unloveTrack: vi.fn(async () => loveOk), scrobbleTrack: vi.fn(async () => loveOk) } as never,
        {} as never,
      ) as unknown as {
        handleLove: (i: unknown) => Promise<void>;
        handleScrobble: (i: unknown) => Promise<void>;
      };

    it('tells the truth when Last.fm rejects a love', async () => {
      const mi = makeInteractions(false);
      const button = makeButton('love-track:Artist:Song') as unknown as {
        editReply: ReturnType<typeof vi.fn>;
      };
      await mi.handleLove(button);
      const reply = String(button.editReply.mock.calls.at(-1)?.[0]?.content ?? '');
      expect(reply).toContain('rejected');
      expect(reply).not.toContain('Loved');
    });

    it('confirms only on a real success', async () => {
      const mi = makeInteractions(true);
      const button = makeButton('love-track:Artist:Song') as unknown as {
        editReply: ReturnType<typeof vi.fn>;
      };
      await mi.handleLove(button);
      expect(String(button.editReply.mock.calls.at(-1)?.[0]?.content ?? '')).toContain('Loved');
    });

    it('tells the truth when Last.fm rejects a scrobble', async () => {
      const mi = makeInteractions(false);
      const button = makeButton('scrobble-now:Artist:Song') as unknown as {
        editReply: ReturnType<typeof vi.fn>;
      };
      await mi.handleScrobble(button);
      const reply = String(button.editReply.mock.calls.at(-1)?.[0]?.content ?? '');
      expect(reply).toContain('rejected');
      expect(reply).not.toContain('Scrobbled');
    });
  });

  describe('generic response semantics', () => {
    it('keeps error commands flagged as errors after clamping', () => {
      const res = GenericEmbedService.buildWrongInputResponse('q'.repeat(9000));
      expect(res.commandResponse).toBe(CommandResponse.WrongInput);
    });
  });
});
