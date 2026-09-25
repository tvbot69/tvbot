import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { GuildMember, type ButtonInteraction, type StringSelectMenuInteraction } from 'discord.js';
import { MusicInteractions } from './musicInteractions';

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
    skip: vi.fn(async () => false),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
  });

  const makeInteractions = (svc: unknown) =>
    new MusicInteractions(
      svc as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
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
      message: { embeds: [], flags: { has: () => true } },
    }) as unknown as StringSelectMenuInteraction & {
      reply: ReturnType<typeof vi.fn>;
      deferUpdate: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };

  const chapters = [
    { title: 'CHAMPAIN & VACAY', startMs: 0 },
    { title: 'BACKR00MS TO KICK OUT', startMs: 214000 },
    { title: 'KICK OUT', startMs: 465000 },
  ];

  const makeSvc = (opts: { chapters?: unknown; requesterId?: string; seekResult?: boolean } = {}) => ({
    getQueueInfo: vi.fn(() => ({
      current: {
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
    seek: vi.fn(async () => opts.seekResult ?? true),
  });

  const makeInteractions = (svc: unknown) =>
    new MusicInteractions(
      svc as never,
      { getAccentColorAsync: vi.fn(async () => 0xff0000) } as never,
    );

  it('seeks to the chosen chapter and re-renders the menu', async () => {
    const svc = makeSvc();
    const mi = makeInteractions(svc);
    const select = makeSelect('music:chapters:seek', 'u1', ['1']);

    await mi.handleSelectMenu(select);

    expect(svc.seek).toHaveBeenCalledWith('g1', 214);
    expect(select.update).toHaveBeenCalledTimes(1);
    expect(select.reply).not.toHaveBeenCalled();
  });

  it('reports expired chapters instead of seeking blindly', async () => {
    const svc = makeSvc({ chapters: null });
    const mi = makeInteractions(svc);
    const select = makeSelect('music:chapters:seek', 'u1', ['1']);

    await mi.handleSelectMenu(select);

    expect(svc.seek).not.toHaveBeenCalled();
    expect((select.reply.mock.calls[0]![0] as { content: string }).content).toContain('no longer available');
  });

  it('blocks chapter jumps for non-requesters', async () => {
    const svc = makeSvc({ requesterId: 'owner' });
    const mi = makeInteractions(svc);
    const select = makeSelect('music:chapters:seek', 'other', ['1']);

    await mi.handleSelectMenu(select);

    expect(svc.seek).not.toHaveBeenCalled();
    expect((select.reply.mock.calls[0]![0] as { content: string }).content).toContain('requester');
  });

  it('reports a failed seek', async () => {
    const svc = makeSvc({ seekResult: false });
    const mi = makeInteractions(svc);
    const select = makeSelect('music:chapters:seek', 'u1', ['1']);

    await mi.handleSelectMenu(select);

    expect(select.update).not.toHaveBeenCalled();
    expect((select.reply.mock.calls[0]![0] as { content: string }).content).toBe('No track is currently playing.');
  });
});
