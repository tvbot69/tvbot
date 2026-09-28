import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageFlags } from 'discord.js';
import { TasteInteractions } from './tasteInteractions';
import { TasteBuilders } from '@bot/builders/tasteBuilders';
import type { TasteData } from '@bot/services/tasteService';
import type { ButtonInteraction } from 'discord.js';

const makeTasteData = (over: Partial<TasteData> = {}): TasteData => ({
  cacheKey: 'abc123',
  user1DiscordId: 'u1',
  user2DiscordId: 'u2',
  user1DisplayName: 'One',
  user2DisplayName: 'Two',
  user1UserNameLastFm: 'one',
  user2UserNameLastFm: 'two',
  url: 'https://last.fm/user/one',
  timePeriodDescription: 'Alltime',
  amount: 14,
  artists: { items: [], totalCount: 0 },
  genres: { items: [], totalCount: 0 },
  countries: { items: [], totalCount: 0 },
  ...over,
});

const mkButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: 'g1',
    user: { id: 'u1' },
    update: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    update: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const tasteService = {
    getCachedTasteSession: vi.fn(async () => makeTasteData() as TasteData | null),
    ...(over.tasteService as object),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0xff0000),
    ...(over.colorService as object),
  };
  const ti = new TasteInteractions(tasteService as never, colorService as never);
  return { ti, tasteService, colorService };
};

const builderArgs = () => (TasteBuilders.buildTasteResponse as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
  TasteData,
  number,
  number,
  number,
];

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(TasteBuilders, 'buildTasteResponse').mockReturnValue({ componentsV2Container: {} } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TasteInteractions.handleButton — guard clauses', () => {
  it('does nothing for a customId without the taste-tab prefix', async () => {
    const { ti, tasteService } = build();
    const press = mkButton('topartists:next:0:user1:weekly');

    await ti.handleButton(press);

    expect(tasteService.getCachedTasteSession).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('does nothing when the customId has fewer than 7 parts', async () => {
    const { ti, tasteService, colorService } = build();
    const press = mkButton('taste-tab:abc123:0:u1:u2:alltime');

    await ti.handleButton(press);

    expect(tasteService.getCachedTasteSession).not.toHaveBeenCalled();
    expect(colorService.getAccentColorAsync).not.toHaveBeenCalled();
    expect(TasteBuilders.buildTasteResponse).not.toHaveBeenCalled();
    expect(press.update).not.toHaveBeenCalled();
  });

  it('replies ephemerally when the cached session has expired', async () => {
    const { ti, tasteService, colorService } = build({
      tasteService: { getCachedTasteSession: vi.fn(async () => null) },
    });
    const press = mkButton('taste-tab:abc123:0:u1:u2:alltime:14');

    await ti.handleButton(press);

    expect(tasteService.getCachedTasteSession).toHaveBeenCalledWith('abc123');
    expect(colorService.getAccentColorAsync).not.toHaveBeenCalled();
    expect(TasteBuilders.buildTasteResponse).not.toHaveBeenCalled();
    expect(press.reply).toHaveBeenCalledWith({
      content: 'This comparison session has expired. Run `.taste` again to refresh.',
      ephemeral: true,
    });
    expect(press.update).not.toHaveBeenCalled();
  });

  it('swallows a failure of the expiry reply', async () => {
    const { ti } = build({ tasteService: { getCachedTasteSession: vi.fn(async () => null) } });
    const press = mkButton('taste-tab:abc123:0:u1:u2:alltime:14', {
      reply: vi.fn(async () => {
        throw new Error('already acknowledged');
      }),
    });

    await expect(ti.handleButton(press)).resolves.toBeUndefined();
  });
});

describe('TasteInteractions.handleButton — tab navigation', () => {
  it('loads the session for the cache key in the customId', async () => {
    const { ti, tasteService } = build();
    await ti.handleButton(mkButton('taste-tab:xyz789:0:u1:u2:alltime:14'));

    expect(tasteService.getCachedTasteSession).toHaveBeenCalledWith('xyz789');
  });

  it('resolves the accent colour for the interacting guild', async () => {
    const { ti, colorService } = build();
    await ti.handleButton(mkButton('taste-tab:abc123:0:u1:u2:alltime:14'));

    expect(colorService.getAccentColorAsync).toHaveBeenCalledWith('g1');
  });

  it('passes the cache key, tab index, amount and accent colour to the builder', async () => {
    const { ti } = build();
    const data = makeTasteData();

    await ti.handleButton(mkButton('taste-tab:abc123:1:u1:u2:alltime:25'));

    expect(TasteBuilders.buildTasteResponse).toHaveBeenCalledWith(data, 1, 25, 0xff0000);
  });

  it('forwards the artist tab index of 0', async () => {
    const { ti } = build();
    await ti.handleButton(mkButton('taste-tab:abc123:0:u1:u2:alltime:14'));

    expect(builderArgs()[1]).toBe(0);
  });

  it('forwards the genres tab index of 1', async () => {
    const { ti } = build();
    await ti.handleButton(mkButton('taste-tab:abc123:1:u1:u2:alltime:14'));

    expect(builderArgs()[1]).toBe(1);
  });

  it('forwards the countries tab index of 2', async () => {
    const { ti } = build();
    await ti.handleButton(mkButton('taste-tab:abc123:2:u1:u2:alltime:14'));

    expect(builderArgs()[1]).toBe(2);
  });

  it('defaults a non-numeric tab index to 0', async () => {
    const { ti } = build();
    await ti.handleButton(mkButton('taste-tab:abc123:abc:u1:u2:alltime:14'));

    expect(builderArgs()[1]).toBe(0);
  });

  it('defaults a non-numeric amount to 14', async () => {
    const { ti } = build();
    await ti.handleButton(mkButton('taste-tab:abc123:1:u1:u2:alltime:abc'));

    expect(builderArgs()[2]).toBe(14);
  });

  it('forwards the cached session data unchanged', async () => {
    const data = makeTasteData({ user1DisplayName: 'Custom One', amount: 20 });
    const { ti } = build({ tasteService: { getCachedTasteSession: vi.fn(async () => data) } });

    await ti.handleButton(mkButton('taste-tab:abc123:0:u1:u2:alltime:20'));

    expect(builderArgs()[0]).toBe(data);
  });
});

describe('TasteInteractions.handleButton — response publishing', () => {
  it('updates the interaction with the ComponentsV2 container', async () => {
    const { ti } = build();
    const press = mkButton('taste-tab:abc123:0:u1:u2:alltime:14');

    await ti.handleButton(press);

    expect(press.update).toHaveBeenCalledWith({
      components: [{}],
      flags: MessageFlags.IsComponentsV2,
    });
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });

  it('falls back to deferUpdate when update throws', async () => {
    const { ti } = build();
    const press = mkButton('taste-tab:abc123:0:u1:u2:alltime:14', {
      update: vi.fn(async () => {
        throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      }),
    });

    await ti.handleButton(press);

    expect(press.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('swallows a failure of the deferUpdate fallback', async () => {
    const { ti } = build();
    const press = mkButton('taste-tab:abc123:0:u1:u2:alltime:14', {
      update: vi.fn(async () => {
        throw new Error('Unknown Message');
      }),
      deferUpdate: vi.fn(async () => {
        throw new Error('Unknown Interaction');
      }),
    });

    await expect(ti.handleButton(press)).resolves.toBeUndefined();
  });

  it('does not touch the interaction when the response has no container', async () => {
    const { ti } = build();
    vi.spyOn(TasteBuilders, 'buildTasteResponse').mockReturnValue({} as never);
    const press = mkButton('taste-tab:abc123:0:u1:u2:alltime:14');

    await ti.handleButton(press);

    expect(press.update).not.toHaveBeenCalled();
    expect(press.deferUpdate).not.toHaveBeenCalled();
  });
});
