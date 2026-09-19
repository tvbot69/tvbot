import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InteractionHandler } from './interactionHandler';

describe('InteractionHandler slow-button safety net (Phase 1.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeHandler = (blockMs: number) => {
    const handler = Object.create(InteractionHandler.prototype);
    handler.userSettingsInteractions = { isUserSettingsInteraction: () => false };
    handler.componentTracker = {
      handle: async () => {
        await new Promise((r) => setTimeout(r, blockMs));
        return false;
      },
    };
    return handler as InteractionHandler;
  };

  const makeInteraction = () => {
    const state = { replied: false, deferred: false };
    return {
      state,
      isChatInputCommand: () => false,
      isAutocomplete: () => false,
      isButton: () => true,
      isAnySelectMenu: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isRepliable: () => true,
      customId: 'unknown:xyz',
      user: { tag: 'tester', username: 'tester' },
      guild: { name: 'Test Guild' },
      get replied() {
        return state.replied;
      },
      get deferred() {
        return state.deferred;
      },
      deferUpdate: vi.fn(async () => {
        state.deferred = true;
      }),
      reply: vi.fn(async () => {
        state.replied = true;
      }),
    };
  };

  it('auto-defers a button stuck past 2.5s instead of hitting 10062', async () => {
    const handler = makeHandler(5000);
    const interaction = makeInteraction();

    const pending = (handler as unknown as {
      onInteractionCreated: (i: unknown) => Promise<void>;
    }).onInteractionCreated(interaction);

    await vi.advanceTimersByTimeAsync(2600);
    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    await pending;
    expect(interaction.reply).toHaveBeenCalled();
  });

  it('leaves fast buttons untouched (no spurious defer)', async () => {
    const handler = makeHandler(100);
    const interaction = makeInteraction();

    const pending = (handler as unknown as {
      onInteractionCreated: (i: unknown) => Promise<void>;
    }).onInteractionCreated(interaction);

    await vi.runAllTimersAsync();
    await pending;
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalled();
  });
});
