import 'reflect-metadata';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TopInteractions } from '@bot/interactions/topInteractions';
import { TopBuilders } from '@bot/builders/topBuilders';
import { OverviewBuilders } from '@bot/builders/overviewBuilders';
import { TimePeriod } from '@domain/enums/timePeriod';
import { tryHandleModal } from '@bot/interactions';
import type { ButtonInteraction, ModalSubmitInteraction } from 'discord.js';

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'u1', username: 'Tester' },
    deferReply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction;

const mkModal = (customId: string, pageValue: string) =>
  ({
    customId,
    fields: { getTextInputValue: vi.fn(() => pageValue) },
    deferReply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
  }) as unknown as ModalSubmitInteraction;

const build = (over: Record<string, unknown> = {}) => {
  const lastfmRepository = {
    getTopArtists: vi.fn(async () => Array.from({ length: 25 }, (_, i) => ({ name: `Artist ${i}`, playcount: 100 - i }))),
    getTopAlbums: vi.fn(async () => Array.from({ length: 15 }, (_, i) => ({ name: `Album ${i}`, playcount: 50 - i }))),
    getTopTracks: vi.fn(async () => Array.from({ length: 35 }, (_, i) => ({ name: `Track ${i}`, playcount: 200 - i }))),
    ...(over.lastfmRepository as object),
  };
  const settingService = {
    getTimePeriod: vi.fn(() => ({
      timePeriod: TimePeriod.AllTime,
      description: 'Alltime',
      searchValue: '',
      startDateTime: new Date('2020-01-01'),
      endDateTime: null,
    })),
    ...(over.settingService as object),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0xff0000),
    ...(over.colorService as object),
  };
  const service = new TopInteractions(lastfmRepository as never, settingService as never, colorService as never);
  return { service, lastfmRepository, settingService, colorService };
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(TopBuilders, 'buildTopArtistsResponse').mockReturnValue({ content: 'artists' } as never);
  vi.spyOn(TopBuilders, 'buildTopAlbumsResponse').mockReturnValue({ content: 'albums' } as never);
  vi.spyOn(TopBuilders, 'buildTopTracksResponse').mockReturnValue({ content: 'tracks' } as never);
  vi.spyOn(OverviewBuilders, 'buildOverviewResponse').mockReturnValue({ content: 'overview' } as never);
});

describe('TopInteractions.handle', () => {
  it('shows a jump modal for topartists', async () => {
    const { service } = build();
    await service.handle(mkButton('topartists:jump:0:user1:weekly'));
    expect(mkButton('x').showModal).toBeDefined();
  });

  it('shows a jump modal for overview', async () => {
    const { service } = build();
    const interaction = mkButton('overview:jump:0:user1:weekly');
    await service.handle(interaction);
    expect(interaction.showModal).toHaveBeenCalled();
  });

  it('paginates topartists first', async () => {
    const { service } = build();
    const interaction = mkButton('topartists:first:5:user1:weekly');
    await service.handle(interaction);
    expect(TopBuilders.buildTopArtistsResponse).toHaveBeenCalledWith(
      expect.anything(), 'user1', 'user1', expect.any(Array), expect.anything(), 0, expect.any(Number),
    );
  });

  it('paginates topartists prev', async () => {
    const { service } = build();
    const interaction = mkButton('topartists:prev:5:user1:weekly');
    await service.handle(interaction);
    expect(TopBuilders.buildTopArtistsResponse).toHaveBeenCalledWith(
      expect.anything(), 'user1', 'user1', expect.any(Array), expect.anything(), 4, expect.any(Number),
    );
  });

  it('paginates topartists next', async () => {
    const { service } = build();
    const interaction = mkButton('topartists:next:0:user1:weekly');
    await service.handle(interaction);
    expect(TopBuilders.buildTopArtistsResponse).toHaveBeenCalledWith(
      expect.anything(), 'user1', 'user1', expect.any(Array), expect.anything(), 1, expect.any(Number),
    );
  });

  it('paginates topartists last', async () => {
    const { service } = build();
    const interaction = mkButton('topartists:last:0:user1:weekly');
    await service.handle(interaction);
    expect(TopBuilders.buildTopArtistsResponse).toHaveBeenCalledWith(
      expect.anything(), 'user1', 'user1', expect.any(Array), expect.anything(), 2, expect.any(Number),
    );
  });

  it('paginates topalbums', async () => {
    const { service } = build();
    const interaction = mkButton('topalbums:next:0:user1:weekly');
    await service.handle(interaction);
    expect(TopBuilders.buildTopAlbumsResponse).toHaveBeenCalledWith(
      expect.anything(), 'user1', 'user1', expect.any(Array), expect.anything(), 1, expect.any(Number),
    );
  });

  it('paginates toptracks', async () => {
    const { service } = build();
    const interaction = mkButton('toptracks:next:0:user1:weekly');
    await service.handle(interaction);
    expect(TopBuilders.buildTopTracksResponse).toHaveBeenCalledWith(
      expect.anything(), 'user1', 'user1', expect.any(Array), expect.anything(), 1, expect.any(Number),
    );
  });

  it('updates the interaction with the response', async () => {
    const { service } = build();
    const interaction = mkButton('topartists:next:0:user1:weekly');
    await service.handle(interaction);
    expect(TopBuilders.buildTopArtistsResponse).toHaveBeenCalled();
  });

  it('does nothing for unknown prefix', async () => {
    const { service } = build();
    const interaction = mkButton('unknown:next:0:user1:weekly');
    await service.handle(interaction);
    expect(interaction.update).not.toHaveBeenCalled();
  });
});

describe('TopInteractions modal handlers', () => {
  it('rejects invalid page numbers (NaN)', async () => {
    build();
    const modal = mkModal('top-jump:topartists:user1:weekly', 'abc');
    await tryHandleModal(modal);
    expect(modal.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Invalid page number') }),
    );
  });

  it('rejects page numbers below 1', async () => {
    build();
    const modal = mkModal('top-jump:topartists:user1:weekly', '0');
    await tryHandleModal(modal);
    expect(modal.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Invalid page number') }),
    );
  });

  it('rejects page numbers above 31', async () => {
    build();
    const modal = mkModal('top-jump:topartists:user1:weekly', '32');
    await tryHandleModal(modal);
    expect(modal.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Invalid page number') }),
    );
  });

  it('accepts a valid page number', async () => {
    build();
    const modal = mkModal('top-jump:topartists:user1:weekly', '5');
    await tryHandleModal(modal);
    expect(modal.deferReply).toHaveBeenCalled();
  });

  it('handles overview-jump modal', async () => {
    build();
    const modal = mkModal('overview-jump:user1:weekly', '3');
    await tryHandleModal(modal);
    expect(modal.deferReply).toHaveBeenCalled();
  });
});
