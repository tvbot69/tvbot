import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { GuildMember, type ButtonInteraction, type StringSelectMenuInteraction } from 'discord.js';
import { MusicInteractions } from '@bot/interactions/musicInteractions';
import { MusicBuilders } from '@bot/builders/musicBuilders';
import { playErrorMessage } from '@bot/services/music/musicService';
import type { MoonlinkManager } from '@bot/services/music/moonlinkManager';

const makeMember = () => {
  const member = Object.create(GuildMember.prototype);
  Object.defineProperty(member, 'voice', { value: { channel: { id: 'vc' } } });
  return member;
};

describe('MusicInteractions control-row hardening', () => {
  const makeMember = () => {
    const member = Object.create(GuildMember.prototype);
    Object.defineProperty(member, 'voice', { value: { channel: { id: 'vc' } } });
    return member;
  };

  const makeButton = (customId: string, userId: string) =>
    ({
      customId,
      guildId: 'g1',
      user: { id: userId },
      member: makeMember(),
      reply: vi.fn(async () => undefined),
      deferUpdate: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      message: {
        embeds: [],
        delete: vi.fn(async () => undefined),
        edit: vi.fn(async () => undefined),
        flags: { has: () => true },
      },
    }) as unknown as ButtonInteraction & {
      reply: ReturnType<typeof vi.fn>;
      deferUpdate: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };

  const makeSelect = (customId: string, userId: string) =>
    ({
      customId,
      guildId: 'g1',
      user: { id: userId },
      member: makeMember(),
      values: [],
      reply: vi.fn(async () => undefined),
      deferUpdate: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      message: { embeds: [], flags: { has: () => true } },
    }) as unknown as StringSelectMenuInteraction & {
      reply: ReturnType<typeof vi.fn>;
      deferUpdate: ReturnType<typeof vi.fn>;
    };

  const makeSvc = (queue: unknown) => ({
    getQueueInfo: vi.fn(() => queue),
    // Mirrors MusicService.canControlPlayback: the current track's requester
    // controls playback, admins bypass, requester-less tracks are open.
    canControlPlayback: vi.fn((_guildId: string, userId: string, isAdmin = false) => {
      if (isAdmin) return true;
      const requesterId = (queue as { current?: { requester?: { id?: string } } } | null)?.current?.requester?.id;
      return !requesterId || requesterId === userId;
    }),
    skip: vi.fn(async () => false),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
  });

  const makeInteractions = (svc: unknown) =>
    new MusicInteractions(
      svc as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
      { getLyrics: vi.fn(async () => null) } as never,
    );

  it('ignores a second control press inside the double-press window', async () => {
    const svc = makeSvc({ current: { requester: { id: 'u1', tag: 'u1' } } });
    const mi = makeInteractions(svc);
    const first = makeButton('music:control:skip', 'u1');
    const second = makeButton('music:control:skip', 'u1');

    await mi.handleButton(first);
    await mi.handleButton(second);

    expect(svc.skip).toHaveBeenCalledTimes(1);
    expect(second.deferUpdate).toHaveBeenCalledTimes(1);
    expect(second.reply).not.toHaveBeenCalled();
  });

  it('blocks playback controls for non-requesters', async () => {
    const svc = makeSvc({ current: { requester: { id: 'owner', tag: 'owner#1' } } });
    const mi = makeInteractions(svc);
    const press = makeButton('music:control:skip', 'other');

    await mi.handleButton(press);

    expect(svc.skip).not.toHaveBeenCalled();
    expect(press.reply).toHaveBeenCalledTimes(1);
    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toContain('Only');
    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toContain('requester');
  });

  it('keeps controls open when the track has no requester (autoplay/24/7)', async () => {
    const svc = makeSvc(null);
    const mi = makeInteractions(svc);
    const press = makeButton('music:control:pause_resume', 'anyone');

    await mi.handleButton(press);

    expect(press.reply.mock.calls[0]![0]).toMatchObject({ content: 'No music is currently playing.' });
    expect((press.reply.mock.calls[0]![0] as { content: string }).content).not.toContain('Only');
  });

  it('does not gate view buttons', async () => {
    let calls = 0;
    const svc = {
      getQueueInfo: vi.fn(() => (calls++ === 0 ? { current: { requester: { id: 'owner' } } } : null)),
    };
    const mi = makeInteractions(svc);
    const press = makeButton('music:control:view_nowplaying', 'other');

    await mi.handleButton(press);

    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toBe(
      'No music is currently playing.',
    );
  });

  it('gates the filter select menu for non-requesters', async () => {
    const svc = makeSvc({ current: { requester: { id: 'owner', tag: 'owner#1' } } });
    const mi = makeInteractions(svc);
    const press = makeSelect('music:filter:select', 'other');

    await mi.handleSelectMenu(press);

    expect(press.reply).toHaveBeenCalledTimes(1);
    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toContain('Only');
  });
});

describe('MusicInteractions chapter jump', () => {
  const makeMember = () => {
    const member = Object.create(GuildMember.prototype);
    Object.defineProperty(member, 'voice', { value: { channel: { id: 'vc' } } });
    return member;
  };

  const makeSelect = (customId: string, userId: string, values: string[]) =>
    ({
      customId,
      guildId: 'g1',
      user: { id: userId },
      member: makeMember(),
      values,
      reply: vi.fn(async () => undefined),
      deferUpdate: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      message: { embeds: [], flags: { has: () => true } },
    }) as unknown as StringSelectMenuInteraction & {
      reply: ReturnType<typeof vi.fn>;
      deferUpdate: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      editReply: ReturnType<typeof vi.fn>;
      followUp: ReturnType<typeof vi.fn>;
    };

  const chapters = [
    { title: 'CHAMPAIN & VACAY', startMs: 0 },
    { title: 'BACKR00MS TO KICK OUT', startMs: 214000 },
    { title: 'KICK OUT', startMs: 465000 },
  ];

  const makeSvc = (opts: { chapters?: unknown; requesterId?: string; seekResult?: number | null; nothingPlaying?: boolean } = {}) => ({
    getQueueInfo: vi.fn(() => ({
      current: opts.nothingPlaying
        ? undefined
        : {
            title: 'Travis Scott - Live',
            author: 'gloss',
            uri: 'https://youtube.com/watch?v=abc',
            requester: opts.requesterId ? { id: opts.requesterId } : undefined,
          },
      position: 0,
    })),
    getPlayer: vi.fn(() => ({
      get: (key: string) => (key === 'chapters' ? (opts.chapters !== undefined ? opts.chapters : chapters) : undefined),
    })),
    // Mirrors MusicService.canControlPlayback (see the other harness).
    canControlPlayback: vi.fn((_guildId: string, userId: string, isAdmin = false) => {
      if (isAdmin) return true;
      return !opts.requesterId || opts.requesterId === userId;
    }),
    // seek() now returns the applied position (or null when refused).
    seek: vi.fn(async () => (opts.seekResult === undefined ? 214000 : opts.seekResult)),
  });

  const makeInteractions = (svc: unknown) =>
    new MusicInteractions(
      svc as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
      { getLyrics: vi.fn(async () => null) } as never,
    );

  it('seeks to the chosen chapter and re-renders the menu', async () => {
    const svc = makeSvc();
    const mi = makeInteractions(svc);
    const select = makeSelect('music:chapters:seek:0', 'u1', ['1']);

    await mi.handleSelectMenu(select);

    expect(svc.seek).toHaveBeenCalledWith('g1', 214);
    // Deferred first (slow seeks race the router auto-defer), then edited.
    expect(select.deferUpdate).toHaveBeenCalledTimes(1);
    expect(select.editReply).toHaveBeenCalledTimes(1);
    expect(select.update).not.toHaveBeenCalled();
    expect(select.reply).not.toHaveBeenCalled();
  });

  it('reports expired chapters instead of seeking blindly', async () => {
    const svc = makeSvc({ chapters: null });
    const mi = makeInteractions(svc);
    const select = makeSelect('music:chapters:seek:0', 'u1', ['1']);

    await mi.handleSelectMenu(select);

    expect(svc.seek).not.toHaveBeenCalled();
    expect((select.reply.mock.calls[0]![0] as { content: string }).content).toContain('no longer available');
  });

  it('blocks chapter jumps for non-requesters', async () => {
    const svc = makeSvc({ requesterId: 'owner' });
    const mi = makeInteractions(svc);
    const select = makeSelect('music:chapters:seek:0', 'other', ['1']);

    await mi.handleSelectMenu(select);

    expect(svc.seek).not.toHaveBeenCalled();
    expect((select.reply.mock.calls[0]![0] as { content: string }).content).toContain('requester');
  });

  it('reports a refused seek without claiming nothing is playing', async () => {
    const svc = makeSvc({ seekResult: null });
    const mi = makeInteractions(svc);
    const select = makeSelect('music:chapters:seek:0', 'u1', ['1']);

    await mi.handleSelectMenu(select);

    expect(select.editReply).not.toHaveBeenCalled();
    expect(select.followUp).toHaveBeenCalledTimes(1);
    // A stream or an unknown duration refuses the seek while the track is
    // still playing — "No track is currently playing." would be false.
    const content = (select.followUp.mock.calls[0]![0] as { content: string }).content;
    expect(content).toContain('Could not seek');
    expect(content).not.toContain('No track is currently playing');
  });

  it('still says nothing is playing when the track really is gone', async () => {
    const svc = makeSvc({ seekResult: null, nothingPlaying: true });
    const mi = makeInteractions(svc);
    const select = makeSelect('music:chapters:seek:0', 'u1', ['1']);

    await mi.handleSelectMenu(select);

    expect(select.followUp).toHaveBeenCalledTimes(1);
    expect((select.followUp.mock.calls[0]![0] as { content: string }).content).toBe(
      'No track is currently playing.',
    );
  });

  it('accepts the second select row (26+ chapters)', async () => {
    const svc = makeSvc();
    const mi = makeInteractions(svc);
    const select = makeSelect('music:chapters:seek:1', 'u1', ['2']);

    await mi.handleSelectMenu(select);

    expect(svc.seek).toHaveBeenCalledWith('g1', 465);
  });
});

describe('MusicInteractions lyric rebuilds', () => {
  const LINES = [
    { ms: 2000, text: 'Line one' },
    { ms: 8000, text: 'Line two' },
  ];

  const lyricSvc = (opts?: { karaoke?: boolean; lines?: typeof LINES | null; position?: number }) => {
    const lines = opts && 'lines' in opts ? opts.lines : LINES;
    return {
      isKaraokeEnabled: vi.fn().mockReturnValue(opts?.karaoke ?? true),
      getQueueInfo: vi.fn().mockReturnValue({ position: opts?.position ?? 4000 }),
      getPlayer: vi.fn().mockReturnValue({
        get: (key: string) => (key === 'karaokeLines' ? lines : undefined),
      }),
    };
  };

  const lyricWindowFor = (svc: unknown): { current: string | null; next: string | null } | null =>
    (
      new MusicInteractions(svc as never, {} as never, { getLyrics: vi.fn(async () => null) } as never) as unknown as {
        lyricWindowFor: (guildId: string) => { current: string | null; next: string | null } | null;
      }
    ).lyricWindowFor('g1');

  it('preserves the lyric window on control rebuilds (no pause flicker)', () => {
    // Frozen at 4s with lines at 2s/8s — the pause rebuild must keep
    // singing instead of blanking until the next boundary.
    expect(lyricWindowFor(lyricSvc())).toEqual({ current: 'Line one', next: 'Line two' });
  });

  it('returns null when karaoke is disabled or lines are missing', () => {
    expect(lyricWindowFor(lyricSvc({ karaoke: false }))).toBeNull();
    expect(lyricWindowFor(lyricSvc({ lines: null }))).toBeNull();
  });
});

describe('MusicInteractions.handleButton entry guards', () => {
  const makeMember = (inVoice: boolean) => {
    const member = Object.create(GuildMember.prototype);
    Object.defineProperty(member, 'voice', { value: inVoice ? { channel: { id: 'vc' } } : undefined });
    return member;
  };

  const makeButton = (customId: string, userId: string, member: unknown, over: Record<string, unknown> = {}) =>
    ({
      customId,
      guildId: 'g1',
      user: { id: userId, tag: `${userId}#1` },
      member,
      reply: vi.fn(async () => undefined),
      deferUpdate: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      deferReply: vi.fn(async () => undefined),
      message: { embeds: [], delete: vi.fn(async () => undefined), flags: { has: () => true } },
      ...over,
    }) as unknown as ButtonInteraction & {
      reply: ReturnType<typeof vi.fn>;
      deferUpdate: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      followUp: ReturnType<typeof vi.fn>;
      editReply: ReturnType<typeof vi.fn>;
      deferReply: ReturnType<typeof vi.fn>;
    };

  const makeSvc = (queue: unknown) => ({
    getQueueInfo: vi.fn(() => queue),
    canControlPlayback: vi.fn(() => true),
  });

  const makeInteractions = (svc: unknown) =>
    new MusicInteractions(
      svc as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
      { getLyrics: vi.fn(async () => null) } as never,
    );

  it('rejects a press outside a server', async () => {
    const mi = makeInteractions(makeSvc(null));
    const press = makeButton('music:control:skip', 'u1', makeMember(true), { guildId: null });

    await mi.handleButton(press);

    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toContain('only be used in a server');
  });

  it('rejects a press from a member not in a voice channel', async () => {
    const mi = makeInteractions(makeSvc(null));
    const press = makeButton('music:control:skip', 'u1', makeMember(false));

    await mi.handleButton(press);

    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toContain('must be in a voice channel');
  });
});

describe('MusicInteractions search cancel', () => {
  const makeButton = () =>
    ({
      customId: 'music:search:cancel',
      guildId: 'g1',
      user: { id: 'u1' },
      member: makeMember(),
      reply: vi.fn(async () => undefined),
      deferUpdate: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      message: { id: 'msg-1', embeds: [], delete: vi.fn(async () => undefined), flags: { has: () => true } },
    }) as unknown as ButtonInteraction & {
      deferUpdate: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };

  it('drops the stored results and deletes the search message', async () => {
    const mi = new MusicInteractions(
      { getQueueInfo: vi.fn(() => null), canControlPlayback: vi.fn(() => true) } as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
      { getLyrics: vi.fn(async () => null) } as never,
    );
    const press = makeButton();
    mi.storeSearchResults('msg-1', [{ title: 'T', author: 'A', uri: 'https://x', source: 'youtube' } as never]);

    await mi.handleButton(press);

    const store = (mi as unknown as { activeSearches: { get: (k: string) => Promise<unknown> } }).activeSearches;
    expect(await store.get('msg-1')).toBeUndefined();
    expect(press.message.delete).toHaveBeenCalledTimes(1);
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('MusicInteractions view buttons', () => {
  const makeButton = (over: Record<string, unknown> = {}) =>
    ({
      guildId: 'g1',
      user: { id: 'u1' },
      member: makeMember(),
      reply: vi.fn(async () => undefined),
      deferUpdate: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      message: { embeds: [], delete: vi.fn(async () => undefined), flags: { has: () => true } },
      ...over,
    }) as unknown as ButtonInteraction & {
      reply: ReturnType<typeof vi.fn>;
      deferUpdate: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      followUp: ReturnType<typeof vi.fn>;
    };

  const makeSvc = (queue: unknown) => ({
    getQueueInfo: vi.fn(() => queue),
    canControlPlayback: vi.fn(() => true),
  });

  const makeInteractions = (svc: unknown) =>
    new MusicInteractions(
      svc as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
      { getLyrics: vi.fn(async () => null) } as never,
    );

  const playingQueue = {
    current: { title: 'Airbag', author: 'Radiohead', uri: 'https://yt/abc', source: 'youtube', duration: 258000 },
    position: 1000,
    isPaused: false,
    loopMode: 'off',
    tracks: [],
  };

  it('view_nowplaying updates a Components V2 message in place', async () => {
    const mi = makeInteractions(makeSvc(playingQueue));
    const press = makeButton({ customId: 'music:control:view_nowplaying' });

    await mi.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
    expect(press.message.delete).not.toHaveBeenCalled();
    expect(press.followUp).not.toHaveBeenCalled();
  });

  it('view_nowplaying swaps a legacy message instead of morphing it into V2', async () => {
    const mi = makeInteractions(makeSvc(playingQueue));
    const press = makeButton({
      customId: 'music:control:view_nowplaying',
      message: { embeds: [], delete: vi.fn(async () => undefined), flags: { has: () => false } },
    });

    await mi.handleButton(press);

    expect(press.update).not.toHaveBeenCalled();
    expect(press.message.delete).toHaveBeenCalledTimes(1);
    expect(press.followUp).toHaveBeenCalledTimes(1);
  });

  it('view_nowplaying replies when nothing is playing', async () => {
    const mi = makeInteractions(makeSvc(null));
    const press = makeButton({ customId: 'music:control:view_nowplaying' });

    await mi.handleButton(press);

    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toBe('No music is currently playing.');
    expect(press.update).not.toHaveBeenCalled();
  });
});

describe('MusicInteractions filters button and reset', () => {
  const makeButton = (customId: string) =>
    ({
      customId,
      guildId: 'g1',
      user: { id: 'u1' },
      member: makeMember(),
      reply: vi.fn(async () => undefined),
      deferUpdate: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      message: { embeds: [], delete: vi.fn(async () => undefined), flags: { has: () => true } },
    }) as unknown as ButtonInteraction & {
      reply: ReturnType<typeof vi.fn>;
      deferUpdate: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };

  const queue = {
    current: { title: 'Airbag', author: 'Radiohead', uri: 'https://yt/abc', source: 'youtube' },
    position: 0,
    isPaused: false,
    loopMode: 'off',
    tracks: [],
    activeFilters: [] as string[],
  };

  it('filter:reset clears filters and rebuilds the panel', async () => {
    const svc = {
      getQueueInfo: vi.fn(() => ({ ...queue, activeFilters: ['bassboost'] })),
      canControlPlayback: vi.fn(() => true),
      clearFilters: vi.fn(async () => undefined),
    };
    const mi = new MusicInteractions(
      svc as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
      { getLyrics: vi.fn(async () => null) } as never,
    );
    const press = makeButton('music:filter:reset');

    await mi.handleButton(press);

    expect(svc.clearFilters).toHaveBeenCalledWith('g1');
    expect(press.update).toHaveBeenCalledTimes(1);
  });

  it('filter:reset defers when the queue is gone', async () => {
    const svc = {
      getQueueInfo: vi.fn(() => null),
      canControlPlayback: vi.fn(() => true),
      clearFilters: vi.fn(async () => undefined),
    };
    const mi = new MusicInteractions(
      svc as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
      { getLyrics: vi.fn(async () => null) } as never,
    );
    const press = makeButton('music:filter:reset');

    await mi.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.update).not.toHaveBeenCalled();
  });
});

describe('MusicInteractions queue pagination', () => {
  const makeButton = (customId: string) =>
    ({
      customId,
      guildId: 'g1',
      user: { id: 'u1' },
      member: makeMember(),
      reply: vi.fn(async () => undefined),
      deferUpdate: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      message: { embeds: [], delete: vi.fn(async () => undefined), flags: { has: () => true } },
    }) as unknown as ButtonInteraction & {
      reply: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };

  const queue = {
    current: { title: 'Airbag', author: 'Radiohead', uri: 'https://yt/abc', source: 'youtube' },
    position: 0,
    isPaused: false,
    loopMode: 'off',
    tracks: Array.from({ length: 25 }, (_, i) => ({ title: `Track ${i + 1}`, author: 'A', duration: 180000 })),
    activeFilters: [],
  };

  const build = () => {
    const svc = { getQueueInfo: vi.fn(() => queue), canControlPlayback: vi.fn(() => true) };
    const mi = new MusicInteractions(
      svc as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
      { getLyrics: vi.fn(async () => null) } as never,
    );
    return { svc, mi };
  };

  it('replies when nothing is playing', async () => {
    const svc = { getQueueInfo: vi.fn(() => null), canControlPlayback: vi.fn(() => true) };
    const mi = new MusicInteractions(
      svc as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
      { getLyrics: vi.fn(async () => null) } as never,
    );
    const press = makeButton('music:queue:first');

    await mi.handleButton(press);

    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toBe('No music is currently playing.');
  });

  it('renders the first page on music:queue:first', async () => {
    const spy = vi.spyOn(MusicBuilders, 'buildQueueResponse');
    const { mi } = build();

    await mi.handleButton(makeButton('music:queue:first'));

    expect(spy).toHaveBeenCalledWith(queue, 1, 10, 0xff0000);
  });

  it('renders the last page on music:queue:last', async () => {
    const spy = vi.spyOn(MusicBuilders, 'buildQueueResponse');
    const { mi } = build();

    await mi.handleButton(makeButton('music:queue:last'));

    expect(spy).toHaveBeenCalledWith(queue, 3, 10, 0xff0000);
  });

  it('renders an explicit page on music:queue:page:N', async () => {
    const spy = vi.spyOn(MusicBuilders, 'buildQueueResponse');
    const { mi } = build();

    await mi.handleButton(makeButton('music:queue:page:2'));

    expect(spy).toHaveBeenCalledWith(queue, 2, 10, 0xff0000);
  });
});

describe('MusicInteractions playback controls', () => {
  const makeButton = (customId: string) =>
    ({
      customId,
      guildId: 'g1',
      user: { id: 'u1' },
      member: makeMember(),
      reply: vi.fn(async () => undefined),
      deferUpdate: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      message: { embeds: [], delete: vi.fn(async () => undefined), flags: { has: () => true } },
    }) as unknown as ButtonInteraction & {
      reply: ReturnType<typeof vi.fn>;
      deferUpdate: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };

  const baseQueue = {
    current: { title: 'Airbag', author: 'Radiohead', uri: 'https://yt/abc', source: 'youtube', duration: 258000 },
    position: 1000,
    isPaused: false,
    loopMode: 'off',
    tracks: [{ title: 'Next' }],
    activeFilters: [] as string[],
  };

  const build = (over: Record<string, unknown>) => {
    const svc = {
      getQueueInfo: vi.fn(() => baseQueue),
      canControlPlayback: vi.fn(() => true),
      ...over,
    };
    const mi = new MusicInteractions(
      svc as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
      { getLyrics: vi.fn(async () => null) } as never,
    );
    return { svc: svc as unknown as Record<string, unknown>, mi };
  };

  it('pause_resume resumes a paused queue', async () => {
    const { svc, mi } = build({
      getQueueInfo: vi.fn(() => ({ ...baseQueue, isPaused: true })),
      resume: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined),
    });

    await mi.handleButton(makeButton('music:control:pause_resume'));

    expect(svc.resume).toHaveBeenCalledWith('g1');
    expect(svc.pause).not.toHaveBeenCalled();
  });

  it('pause_resume pauses a playing queue', async () => {
    const { svc, mi } = build({
      resume: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined),
    });

    await mi.handleButton(makeButton('music:control:pause_resume'));

    expect(svc.pause).toHaveBeenCalledWith('g1');
    expect(svc.resume).not.toHaveBeenCalled();
  });

  it('pause_resume defers when the queue vanished after the toggle', async () => {
    const svc = {
      getQueueInfo: vi.fn()
        .mockReturnValueOnce(baseQueue)
        .mockReturnValueOnce(baseQueue)
        .mockReturnValueOnce(null),
      canControlPlayback: vi.fn(() => true),
      pause: vi.fn(async () => undefined),
    };
    const mi = new MusicInteractions(
      svc as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
      { getLyrics: vi.fn(async () => null) } as never,
    );
    const press = makeButton('music:control:pause_resume');

    await mi.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.update).not.toHaveBeenCalled();
  });

  it('skip rebuilds the card on success', async () => {
    const { svc, mi } = build({ skip: vi.fn(async () => true) });

    await mi.handleButton(makeButton('music:control:skip'));

    expect(svc.skip).toHaveBeenCalledWith('g1');
  });

  it('skip deletes the card when the queue is empty afterwards', async () => {
    const svc = {
      getQueueInfo: vi.fn()
        .mockReturnValueOnce(baseQueue)
        .mockReturnValueOnce(null),
      canControlPlayback: vi.fn(() => true),
      skip: vi.fn(async () => true),
    };
    const mi = new MusicInteractions(
      svc as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
      { getLyrics: vi.fn(async () => null) } as never,
    );
    const press = makeButton('music:control:skip');

    await mi.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.message.delete).toHaveBeenCalledTimes(1);
    expect(press.update).not.toHaveBeenCalled();
  });

  it('skip replies when there is nothing to skip', async () => {
    const { mi } = build({ skip: vi.fn(async () => false) });
    const press = makeButton('music:control:skip');

    await mi.handleButton(press);

    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toBe('Nothing to skip.');
  });

  it('previous rebuilds the card on success', async () => {
    const { svc, mi } = build({ previous: vi.fn(async () => true) });

    await mi.handleButton(makeButton('music:control:previous'));

    expect(svc.previous).toHaveBeenCalledWith('g1');
  });

  it('previous replies when history is empty', async () => {
    const { mi } = build({ previous: vi.fn(async () => false) });
    const press = makeButton('music:control:previous');

    await mi.handleButton(press);

    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toBe(
      'No previous track in history to replay.',
    );
  });

  it('shuffle rebuilds the card on success', async () => {
    const { svc, mi } = build({ shuffle: vi.fn(async () => true) });

    await mi.handleButton(makeButton('music:control:shuffle'));

    expect(svc.shuffle).toHaveBeenCalledWith('g1');
  });

  it('shuffle replies when the queue is too small', async () => {
    const { mi } = build({ shuffle: vi.fn(async () => false) });
    const press = makeButton('music:control:shuffle');

    await mi.handleButton(press);

    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toBe('Queue is too small to shuffle.');
  });

  it('clear rebuilds the card', async () => {
    const { svc, mi } = build({ clear: vi.fn(() => undefined) });

    await mi.handleButton(makeButton('music:control:clear'));

    expect(svc.clear).toHaveBeenCalledWith('g1');
  });

  it('loop rebuilds the card', async () => {
    const { svc, mi } = build({ cycleLoop: vi.fn(() => undefined) });

    await mi.handleButton(makeButton('music:control:loop'));

    expect(svc.cycleLoop).toHaveBeenCalledWith('g1');
  });

  it('stop stops playback and deletes the card', async () => {
    const { svc, mi } = build({ stop: vi.fn(async () => undefined) });
    const press = makeButton('music:control:stop');

    await mi.handleButton(press);

    expect(svc.stop).toHaveBeenCalledWith('g1');
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
    expect(press.message.delete).toHaveBeenCalledTimes(1);
    expect(press.update).not.toHaveBeenCalled();
  });
});

describe('MusicInteractions.updateCardOrDefer', () => {
  const makeInteraction = (updateImpl: () => Promise<void>) =>
    ({
      update: vi.fn(updateImpl),
      deferUpdate: vi.fn(async () => undefined),
    }) as unknown as ButtonInteraction & {
      update: ReturnType<typeof vi.fn>;
      deferUpdate: ReturnType<typeof vi.fn>;
    };

  const mi = new MusicInteractions(
    {} as never,
    {} as never,
    {} as never,
  );
  const call = (interaction: ButtonInteraction, payload: unknown) =>
    (
      mi as unknown as {
        updateCardOrDefer: (i: ButtonInteraction, p: unknown) => Promise<void>;
      }
    ).updateCardOrDefer(interaction, payload);

  it('falls back to deferUpdate when the card is already gone (10008)', async () => {
    const press = makeInteraction(async () => {
      throw Object.assign(new Error('Unknown Message'), { code: 10008 });
    });

    await call(press, { content: 'x' });

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('rethrows edit failures that are not Unknown Message', async () => {
    const press = makeInteraction(async () => {
      throw Object.assign(new Error('Invalid Form Body'), { code: 50035 });
    });

    await expect(call(press, { content: 'x' })).rejects.toMatchObject({ code: 50035 });
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });
});

describe('MusicInteractions.handleSelectMenu entry guards', () => {
  const makeSelect = (over: Record<string, unknown> = {}) =>
    ({
      guildId: 'g1',
      user: { id: 'u1' },
      member: makeMember(),
      values: [],
      reply: vi.fn(async () => undefined),
      deferUpdate: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      message: { embeds: [], flags: { has: () => true } },
      ...over,
    }) as unknown as StringSelectMenuInteraction & {
      reply: ReturnType<typeof vi.fn>;
    };

  const mi = new MusicInteractions(
    { getQueueInfo: vi.fn(() => null), canControlPlayback: vi.fn(() => true) } as never,
    { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
    {} as never,
  );

  it('rejects a press outside a server', async () => {
    const press = makeSelect({ guildId: null });

    await mi.handleSelectMenu(press);

    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toContain('only be used in a server');
  });

  it('rejects a press from a member not in a voice channel', async () => {
    const member = Object.create(GuildMember.prototype);
    Object.defineProperty(member, 'voice', { value: undefined });
    const press = makeSelect({ member });

    await mi.handleSelectMenu(press);

    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toContain('must be in a voice channel');
  });
});

describe('MusicInteractions filter select menu', () => {
  const makeSelect = (values: string[]) =>
    ({
      customId: 'music:filter:select',
      guildId: 'g1',
      user: { id: 'u1' },
      member: makeMember(),
      values,
      reply: vi.fn(async () => undefined),
      deferUpdate: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      message: { embeds: [], flags: { has: () => true } },
    }) as unknown as StringSelectMenuInteraction & {
      reply: ReturnType<typeof vi.fn>;
      deferUpdate: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      followUp: ReturnType<typeof vi.fn>;
    };

  const queue = {
    current: { title: 'Airbag', author: 'Radiohead', uri: 'https://yt/abc', source: 'youtube' },
    position: 0,
    isPaused: false,
    loopMode: 'off',
    tracks: [],
    activeFilters: [] as string[],
  };

  const build = (over: Record<string, unknown>) => {
    const svc = {
      getQueueInfo: vi.fn(() => queue),
      canControlPlayback: vi.fn(() => true),
      setFilter: vi.fn(async () => ({ applied: true, replaced: [] as string[] })),
      ...over,
    };
    const mi = new MusicInteractions(
      svc as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
      {} as never,
    );
    return { svc: svc as unknown as Record<string, unknown>, mi };
  };

  it('defers when the selection is empty', async () => {
    const { svc, mi } = build({});
    const press = makeSelect([]);

    await mi.handleSelectMenu(press);

    expect(svc.setFilter).not.toHaveBeenCalled();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('replies when nothing is playing', async () => {
    const { mi } = build({ getQueueInfo: vi.fn(() => null) });
    const press = makeSelect(['bassboost']);

    await mi.handleSelectMenu(press);

    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toBe('No music is currently playing.');
  });

  it('turns a filter on when it is not active', async () => {
    const { svc, mi } = build({});
    const press = makeSelect(['bassboost']);

    await mi.handleSelectMenu(press);

    expect(svc.setFilter).toHaveBeenCalledWith('g1', 'bassboost', true);
    expect(press.update).toHaveBeenCalledTimes(1);
    expect(press.followUp).not.toHaveBeenCalled();
  });

  it('turns a filter off when it is already active', async () => {
    const { svc, mi } = build({
      getQueueInfo: vi.fn(() => ({ ...queue, activeFilters: ['bassboost'] })),
    });
    const press = makeSelect(['bassboost']);

    await mi.handleSelectMenu(press);

    expect(svc.setFilter).toHaveBeenCalledWith('g1', 'bassboost', false);
  });

  it('follows up when the audio node refuses the filter', async () => {
    const { mi } = build({
      setFilter: vi.fn(async () => ({ applied: false, replaced: [] })),
    });
    const press = makeSelect(['bassboost']);

    await mi.handleSelectMenu(press);

    expect((press.followUp.mock.calls[0]![0] as { content: string }).content).toContain(
      "Couldn't apply **bassboost**",
    );
  });

  it('follows up when the filter replaces another EQ preset', async () => {
    const { mi } = build({
      setFilter: vi.fn(async () => ({ applied: true, replaced: ['nightcore'] })),
    });
    const press = makeSelect(['bassboost']);

    await mi.handleSelectMenu(press);

    expect((press.followUp.mock.calls[0]![0] as { content: string }).content).toContain(
      'EQ presets don\'t stack',
    );
  });
});

describe('MusicInteractions chapter seek validation', () => {
  const makeSelect = (values: string[]) =>
    ({
      customId: 'music:chapters:seek:0',
      guildId: 'g1',
      user: { id: 'u1' },
      member: makeMember(),
      values,
      reply: vi.fn(async () => undefined),
      deferUpdate: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      message: { embeds: [], flags: { has: () => true } },
    }) as unknown as StringSelectMenuInteraction & {
      reply: ReturnType<typeof vi.fn>;
    };

  const chapters = [
    { title: 'Intro', startMs: 0 },
    { title: 'Verse', startMs: 60000 },
  ];

  const build = () => {
    const svc = {
      getQueueInfo: vi.fn(() => ({ current: { title: 'T', author: 'A', uri: 'https://x' }, position: 0 })),
      getPlayer: vi.fn(() => ({ get: (k: string) => (k === 'chapters' ? chapters : undefined) })),
      canControlPlayback: vi.fn(() => true),
      seek: vi.fn(async () => 60000),
    };
    const mi = new MusicInteractions(
      svc as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
      {} as never,
    );
    return { svc: svc as unknown as Record<string, unknown>, mi };
  };

  it('reports expired chapters on a non-numeric selection', async () => {
    const { svc, mi } = build();
    const press = makeSelect(['abc']);

    await mi.handleSelectMenu(press);

    expect(svc.seek).not.toHaveBeenCalled();
    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toContain('no longer available');
  });

  it('reports expired chapters on an out-of-range index', async () => {
    const { svc, mi } = build();
    const press = makeSelect(['99']);

    await mi.handleSelectMenu(press);

    expect(svc.seek).not.toHaveBeenCalled();
    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toContain('no longer available');
  });
});

describe('MusicInteractions queue quick remove', () => {
  const makeSelect = (values: string[]) =>
    ({
      customId: 'music:queue:quick_remove',
      guildId: 'g1',
      user: { id: 'u1' },
      member: makeMember(),
      values,
      reply: vi.fn(async () => undefined),
      deferUpdate: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      message: { embeds: [], flags: { has: () => true } },
    }) as unknown as StringSelectMenuInteraction & {
      reply: ReturnType<typeof vi.fn>;
      deferUpdate: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      followUp: ReturnType<typeof vi.fn>;
    };

  const queue = {
    current: { title: 'Airbag', author: 'Radiohead', uri: 'https://yt/abc', source: 'youtube' },
    position: 0,
    isPaused: false,
    loopMode: 'off',
    tracks: [{ title: 'Keep', author: 'A', duration: 180000 }],
    activeFilters: [] as string[],
  };

  const build = (over: Record<string, unknown>) => {
    const svc = {
      getQueueInfo: vi.fn(() => queue),
      canControlPlayback: vi.fn(() => true),
      remove: vi.fn(() => ({ title: 'Keep' })),
      ...over,
    };
    const mi = new MusicInteractions(
      svc as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
      {} as never,
    );
    return { svc: svc as unknown as Record<string, unknown>, mi };
  };

  it('denies non-requesters', async () => {
    const { mi } = build({ canControlPlayback: vi.fn(() => false) });
    const press = makeSelect(['1']);

    await mi.handleSelectMenu(press);

    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toContain('Only the requester');
  });

  it('defers on a non-numeric selection', async () => {
    const { svc, mi } = build({});
    const press = makeSelect(['abc']);

    await mi.handleSelectMenu(press);

    expect(svc.remove).not.toHaveBeenCalled();
    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the queue and follows up when a track is removed', async () => {
    const { svc, mi } = build({});
    const press = makeSelect(['1']);

    await mi.handleSelectMenu(press);

    expect(svc.remove).toHaveBeenCalledWith('g1', 0);
    expect(press.update).toHaveBeenCalledTimes(1);
    expect((press.followUp.mock.calls[0]![0] as { content: string }).content).toContain('Removed **Keep**');
  });

  it('does not follow up when removal fails', async () => {
    const { mi } = build({ remove: vi.fn(() => null) });
    const press = makeSelect(['1']);

    await mi.handleSelectMenu(press);

    expect(press.update).toHaveBeenCalledTimes(1);
    expect(press.followUp).not.toHaveBeenCalled();
  });
});

describe('MusicInteractions search select menu', () => {
  const track = {
    title: 'Airbag',
    author: 'Radiohead',
    uri: 'https://yt/abc',
    source: 'youtube',
    artworkUrl: 'https://img/a.png',
  };

  const makeSelect = () =>
    ({
      customId: 'music:search:select',
      guildId: 'g1',
      channelId: 'ch1',
      user: { id: 'u1', tag: 'u1#1', displayAvatarURL: () => 'https://img/u.png' },
      member: makeMember(),
      values: ['0'],
      reply: vi.fn(async () => undefined),
      deferUpdate: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      message: { id: 'msg-9', embeds: [], delete: vi.fn(async () => undefined), flags: { has: () => true } },
      channel: { send: vi.fn(async () => undefined) },
    }) as unknown as StringSelectMenuInteraction & {
      reply: ReturnType<typeof vi.fn>;
      deferUpdate: ReturnType<typeof vi.fn>;
      message: { delete: ReturnType<typeof vi.fn> };
      channel: { send: ReturnType<typeof vi.fn> };
    };

  const build = (playResult: unknown, unavailable?: { reason: string; retryAfterMs: number }) => {
    // The real sentence logic, reached the way production reaches it: the
    // service's BOUND `playErrorMessage` is what supplies the manager, and the
    // free function turns that manager's answer into words. Re-stating the
    // strings here would make the assertion a test of this file instead.
    const moonlinkManager = {
      getUnavailableReason: () => unavailable ?? { reason: 'rate-limited', retryAfterMs: 30_000 },
    };
    const svc = {
      getQueueInfo: vi.fn(() => ({
        current: track,
        position: 0,
        isPaused: false,
        loopMode: 'off',
        tracks: [track],
        totalTracks: 1,
        activeFilters: [],
      })),
      canControlPlayback: vi.fn(() => true),
      playErrorMessage: (reason?: 'no-nodes' | 'voice' | 'search' | 'empty-spotify' | 'queue-full') =>
        playErrorMessage(reason, moonlinkManager as unknown as MoonlinkManager),
      play: vi.fn(async () => playResult),
    };
    const mi = new MusicInteractions(
      svc as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
      {} as never,
    );
    return { svc: svc as unknown as Record<string, unknown>, mi };
  };

  it('replies when the search results expired', async () => {
    const { mi } = build({ loadType: 'loaded' });
    const press = makeSelect();

    await mi.handleSelectMenu(press);

    expect((press.reply.mock.calls[0]![0] as { content: string }).content).toContain('Search results expired');
  });

  it('plays the chosen track, deletes the search message, and clears the cache', async () => {
    const { svc, mi } = build({ loadType: 'loaded', positionInQueue: 1, totalTracksAdded: 1 });
    const press = makeSelect();
    mi.storeSearchResults('msg-9', [track as never]);

    await mi.handleSelectMenu(press);

    expect(svc.play).toHaveBeenCalledWith(
      'g1',
      'vc',
      'ch1',
      'https://yt/abc',
      { id: 'u1', tag: 'u1#1', avatarUrl: 'https://img/u.png' },
      { title: 'Airbag', author: 'Radiohead', artworkUrl: 'https://img/a.png', source: 'youtube' },
    );
    expect(press.message.delete).toHaveBeenCalledTimes(1);
    expect(press.channel.send).toHaveBeenCalledTimes(1);

    const store = (mi as unknown as { activeSearches: { get: (k: string) => Promise<unknown> } }).activeSearches;
    expect(await store.get('msg-9')).toBeUndefined();
  });

  it('posts an error message when the play result fails', async () => {
    const { mi } = build({ loadType: 'error', errorReason: 'no-nodes' });
    const press = makeSelect();
    mi.storeSearchResults('msg-9', [track as never]);

    await mi.handleSelectMenu(press);

    expect((press.channel.send.mock.calls[0]![0] as { content: string }).content).toContain('❌');
    expect(press.message.delete).toHaveBeenCalledTimes(1);
  });

  it('answers a no-nodes pick from the real node state, not a rate limit', async () => {
    // The same user-visible lie the `.play` command used to tell, reached by a
    // different route: a search-menu pick. `playErrorMessage` is a free function
    // with no `this`, so a caller that used it could never see a manager — and
    // with `ENABLE_LAVALINK=false` the manager says `disabled`, while the reply
    // claimed a rate limit and told the listener to wait. The bound method is
    // what supplies the manager.
    const { mi } = build(
      { loadType: 'error', errorReason: 'no-nodes' },
      { reason: 'disabled', retryAfterMs: 0 },
    );
    const press = makeSelect();
    mi.storeSearchResults('msg-9', [track as never]);

    await mi.handleSelectMenu(press);

    const content = (press.channel.send.mock.calls[0]![0] as { content: string }).content;
    expect(content).toContain('❌');
    expect(content).toContain('disabled in this environment');
    expect(content).not.toMatch(/rate-limited|try again/i);
  });
});
