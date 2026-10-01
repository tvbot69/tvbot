import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { HelpInteractions } from '../helpInteractions';
import { HelpBuilders } from '@bot/builders/helpBuilders';
import { Logger } from '@domain/logger';
import type { ButtonInteraction, StringSelectMenuInteraction } from 'discord.js';

const EMBEDS = [{ title: 'help' }];
const COMPONENTS = [{ type: 1 }];

const makeSelect = (customId: string, values: string[], over: Record<string, unknown> = {}) =>
  ({
    customId,
    values,
    user: { id: 'caller1' },
    guildId: 'g1',
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    ...over,
  }) as unknown as StringSelectMenuInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

const makeButton = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    user: { id: 'caller1' },
    guildId: 'g1',
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    ...over,
  }) as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

const build = (over: Record<string, unknown> = {}) => {
  const prefixService = {
    getPrefix: vi.fn(async () => '!'),
    ...(over.prefixService as object),
  };
  const colorService = {
    getAccentColorAsync: vi.fn(async () => 0xabcdef),
    ...(over.colorService as object),
  };
  const hi = new HelpInteractions(prefixService as never, colorService as never);
  return { hi, prefixService, colorService };
};

const RESPONSE_STUB = {
  buildEmbed: () => EMBEDS,
  buildComponents: () => COMPONENTS,
};

let helpSpy: MockInstance<typeof HelpBuilders.buildHelpResponse>;

beforeEach(() => {
  vi.restoreAllMocks();
  helpSpy = vi
    .spyOn(HelpBuilders, 'buildHelpResponse')
    .mockReturnValue(RESPONSE_STUB as unknown as ReturnType<typeof HelpBuilders.buildHelpResponse>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HelpInteractions.handleSelectMenu — category', () => {
  it('builds for the selected category', async () => {
    const { hi } = build();
    const select = makeSelect('help:select:all', ['music']);

    await hi.handleSelectMenu(select);

    expect(helpSpy.mock.calls[0]![0]).toBe('music');
  });

  it('falls back to home when nothing is selected', async () => {
    const { hi } = build();
    const select = makeSelect('help:select:all', []);

    await hi.handleSelectMenu(select);

    expect(helpSpy.mock.calls[0]![0]).toBe('home');
  });

  it('takes the category from the value, not the customId', async () => {
    const { hi } = build();
    const select = makeSelect('help:select:stats', ['charts']);

    await hi.handleSelectMenu(select);

    expect(helpSpy.mock.calls[0]![0]).toBe('charts');
  });
});

describe('HelpInteractions.handleSelectMenu — target user', () => {
  it('uses the presser id when the customId says "all"', async () => {
    const { hi } = build();
    const select = makeSelect('help:select:all', ['home']);

    await hi.handleSelectMenu(select);

    expect(helpSpy.mock.calls[0]![2]).toBe('caller1');
  });

  it('uses the named target when the customId carries one', async () => {
    const { hi } = build();
    const select = makeSelect('help:select:target9', ['home']);

    await hi.handleSelectMenu(select);

    expect(helpSpy.mock.calls[0]![2]).toBe('target9');
  });

  it('falls back to the presser id when the customId has no third part', async () => {
    const { hi } = build();
    const select = makeSelect('help:select', ['home']);

    await hi.handleSelectMenu(select);

    expect(helpSpy.mock.calls[0]![2]).toBe('caller1');
  });
});

describe('HelpInteractions.handleSelectMenu — prefix and colour', () => {
  it('asks for the guild prefix', async () => {
    const { hi, prefixService } = build();
    const select = makeSelect('help:select:all', ['home']);

    await hi.handleSelectMenu(select);

    expect(prefixService.getPrefix).toHaveBeenCalledWith('g1');
    expect(helpSpy.mock.calls[0]![1]).toBe('!');
  });

  it('forwards a custom prefix', async () => {
    const { hi } = build({ prefixService: { getPrefix: vi.fn(async () => '~') } });
    const select = makeSelect('help:select:all', ['home']);

    await hi.handleSelectMenu(select);

    expect(helpSpy.mock.calls[0]![1]).toBe('~');
  });

  it('asks for the user colour first and stops when it resolves', async () => {
    const { hi, colorService } = build();
    const select = makeSelect('help:select:all', ['home']);

    await hi.handleSelectMenu(select);

    expect(colorService.getAccentColorAsync).toHaveBeenCalledTimes(1);
    expect(colorService.getAccentColorAsync).toHaveBeenCalledWith('caller1');
    expect(helpSpy.mock.calls[0]![3]).toBe(0xabcdef);
  });

  it('falls back to the guild colour when the user has none', async () => {
    const { hi, colorService } = build({
      colorService: { getAccentColorAsync: vi.fn(async () => null) },
    });
    const select = makeSelect('help:select:all', ['home']);

    await hi.handleSelectMenu(select);

    expect(colorService.getAccentColorAsync).toHaveBeenCalledTimes(2);
    expect(colorService.getAccentColorAsync).toHaveBeenNthCalledWith(1, 'caller1');
    expect(colorService.getAccentColorAsync).toHaveBeenNthCalledWith(2, 'g1');
  });

  it('never asks for a guild colour outside a guild', async () => {
    const { hi, colorService } = build({
      colorService: { getAccentColorAsync: vi.fn(async () => null) },
    });
    const select = makeSelect('help:select:all', ['home'], { guildId: null });

    await hi.handleSelectMenu(select);

    expect(colorService.getAccentColorAsync).toHaveBeenCalledTimes(1);
    expect(colorService.getAccentColorAsync).toHaveBeenCalledWith('caller1');
    expect(helpSpy.mock.calls[0]![3]).toBeUndefined();
  });
});

describe('HelpInteractions.handleSelectMenu — response delivery', () => {
  it('updates with the built embeds and components', async () => {
    const { hi } = build();
    const select = makeSelect('help:select:all', ['top']);

    await hi.handleSelectMenu(select);

    expect(select.update).toHaveBeenCalledTimes(1);
    expect(select.update).toHaveBeenCalledWith({ embeds: EMBEDS, components: COMPONENTS });
    expect(select.reply).not.toHaveBeenCalled();
    expect(select.deferUpdate).not.toHaveBeenCalled();
  });

  it('builds the embed and the components exactly once each', async () => {
    const buildEmbed = vi.fn(() => EMBEDS);
    const buildComponents = vi.fn(() => COMPONENTS);
    helpSpy.mockReturnValue({ buildEmbed, buildComponents } as unknown as ReturnType<
      typeof HelpBuilders.buildHelpResponse
    >);
    const { hi } = build();
    const select = makeSelect('help:select:all', ['home']);

    await hi.handleSelectMenu(select);

    expect(buildEmbed).toHaveBeenCalledTimes(1);
    expect(buildComponents).toHaveBeenCalledTimes(1);
  });

  it('logs a warning and swallows an update rejection', async () => {
    const { hi } = build();
    const loggerSpy = vi.spyOn(Logger, 'warn').mockReturnValue(undefined as never);
    const select = makeSelect('help:select:all', ['home'], {
      update: vi.fn(async () => {
        throw new Error('Unknown Message');
      }),
    });

    await expect(hi.handleSelectMenu(select)).resolves.toBeUndefined();
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to update help dropdown interaction',
    );
  });

  it('does not log when the update succeeds', async () => {
    const { hi } = build();
    const loggerSpy = vi.spyOn(Logger, 'warn').mockReturnValue(undefined as never);
    const select = makeSelect('help:select:all', ['home']);

    await hi.handleSelectMenu(select);

    expect(loggerSpy).not.toHaveBeenCalled();
  });
});

describe('HelpInteractions.handleButton — category and target', () => {
  it('builds for the category encoded in the button', async () => {
    const { hi } = build();
    const press = makeButton('help:cat:whoknows:all');

    await hi.handleButton(press);

    expect(helpSpy.mock.calls[0]![0]).toBe('whoknows');
  });

  it('falls back to home when the third part is missing', async () => {
    const { hi } = build();
    const press = makeButton('help:cat');

    await hi.handleButton(press);

    expect(helpSpy.mock.calls[0]![0]).toBe('home');
  });

  it('uses the presser id when the fourth part is "all"', async () => {
    const { hi } = build();
    const press = makeButton('help:cat:social:all');

    await hi.handleButton(press);

    expect(helpSpy.mock.calls[0]![2]).toBe('caller1');
  });

  it('uses the named target from the fourth part', async () => {
    const { hi } = build();
    const press = makeButton('help:cat:social:target9');

    await hi.handleButton(press);

    expect(helpSpy.mock.calls[0]![2]).toBe('target9');
  });

  it('falls back to the presser id when the fourth part is missing', async () => {
    const { hi } = build();
    const press = makeButton('help:cat:settings');

    await hi.handleButton(press);

    expect(helpSpy.mock.calls[0]![2]).toBe('caller1');
  });
});

describe('HelpInteractions.handleButton — prefix, colour and delivery', () => {
  it('asks for the guild prefix and the user colour', async () => {
    const { hi, prefixService, colorService } = build();
    const press = makeButton('help:cat:charts:all');

    await hi.handleButton(press);

    expect(prefixService.getPrefix).toHaveBeenCalledWith('g1');
    expect(colorService.getAccentColorAsync).toHaveBeenCalledWith('caller1');
  });

  it('falls back to the guild colour when the user has none', async () => {
    const { hi, colorService } = build({
      colorService: { getAccentColorAsync: vi.fn(async () => null) },
    });
    const press = makeButton('help:cat:charts:all');

    await hi.handleButton(press);

    expect(colorService.getAccentColorAsync).toHaveBeenCalledTimes(2);
    expect(colorService.getAccentColorAsync).toHaveBeenNthCalledWith(2, 'g1');
    expect(helpSpy.mock.calls[0]![3]).toBeNull();
  });

  it('passes all four builder arguments in order', async () => {
    const { hi } = build({ prefixService: { getPrefix: vi.fn(async () => '$') } });
    const press = makeButton('help:cat:stats:target9');

    await hi.handleButton(press);

    expect(helpSpy).toHaveBeenCalledTimes(1);
    expect(helpSpy.mock.calls[0]![0]).toBe('stats');
    expect(helpSpy.mock.calls[0]![1]).toBe('$');
    expect(helpSpy.mock.calls[0]![2]).toBe('target9');
    expect(helpSpy.mock.calls[0]![3]).toBe(0xabcdef);
  });

  it('updates with the built embeds and components', async () => {
    const { hi } = build();
    const press = makeButton('help:cat:music:all');

    await hi.handleButton(press);

    expect(press.update).toHaveBeenCalledTimes(1);
    expect(press.update).toHaveBeenCalledWith({ embeds: EMBEDS, components: COMPONENTS });
    expect(press.reply).not.toHaveBeenCalled();
  });

  it('logs the button-specific warning and swallows an update rejection', async () => {
    const { hi } = build();
    const loggerSpy = vi.spyOn(Logger, 'warn').mockReturnValue(undefined as never);
    const press = makeButton('help:cat:music:all', {
      update: vi.fn(async () => {
        throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      }),
    });

    await expect(hi.handleButton(press)).resolves.toBeUndefined();
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ code: 10008 }) }),
      'Failed to update help button interaction',
    );
  });

  it('handles a button pressed outside a guild', async () => {
    const { hi, colorService } = build({
      colorService: { getAccentColorAsync: vi.fn(async () => null) },
    });
    const press = makeButton('help:cat:home:all', { guildId: null });

    await hi.handleButton(press);

    expect(colorService.getAccentColorAsync).toHaveBeenCalledTimes(1);
    expect(press.update).toHaveBeenCalledTimes(1);
  });
});
