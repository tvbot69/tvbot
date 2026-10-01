import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import type { ModalSubmitInteraction } from 'discord.js';
import { ComponentPaginatorService } from '@bot/services/system/componentPaginatorService';

/**
 * The paginator page-jump modal.
 *
 * WHAT WAS WRONG - and the subtlety, which is the reason this file exists.
 *
 * `handleJumpModal` used to branch on `interaction.isFromMessage()`:
 *
 *   if (interaction.isFromMessage()) { await interaction.update({...}) }
 *   else                             { await (interaction as any).update({...}) }
 *
 * The two branches were byte-identical apart from a cast, so the condition
 * decided nothing. The first arm compiled only because `isFromMessage()` is a
 * TYPE GUARD: TypeScript narrowed the ModalSubmitInteraction to a type that
 * has `update()`. That is false confidence rather than false safety -
 * `update()` is not declared on a modal in the v14 typings at all. It happens
 * to exist on the runtime prototype (a v13 carry-over discord.js never typed),
 * so the feature worked by accident, reachable only through a cast, and
 * removable in a minor release with no compile error anywhere.
 *
 * Both problems are now gone: one branch, documented API only.
 */

interface Harness {
  service: ComponentPaginatorService;
  calls: string[];
  edited: unknown[];
  renderMs: number;
}

const makeHarness = (opts: { session?: boolean; totalPages?: number; renderMs?: number; renderThrows?: boolean } = {}): Harness => {
  const calls: string[] = [];
  const edited: unknown[] = [];
  const renderMs = opts.renderMs ?? 0;

  const container = { type: 17, components: [] };
  const session = opts.session === false ? undefined : {
    currentPage: 0,
    totalPages: opts.totalPages ?? 5,
    expiresAt: Date.now() + 60_000,
    renderPage: vi.fn(async () => {
      calls.push('renderPage');
      if (renderMs) await new Promise((r) => setTimeout(r, renderMs));
      if (opts.renderThrows) throw new Error('render exploded');
      return container;
    }),
  };

  const service = Object.create(ComponentPaginatorService.prototype) as ComponentPaginatorService;
  (service as unknown as { sessions: Map<string, unknown> }).sessions = new Map();
  if (session) (service as unknown as { sessions: Map<string, unknown> }).sessions.set('m1', session);
  (service as unknown as { ensureCleanupTimer: () => void }).ensureCleanupTimer = () => undefined;

  return { service, calls, edited, renderMs };
};

/** A double with the documented modal surface. */
const makeModal = (pageNumber: string) => {
  const order: string[] = [];
  const edited: unknown[] = [];
  const interaction = {
    customId: 'paginator-jump:m1',
    guildId: 'g-1',
    fields: { getTextInputValue: () => pageNumber },
    isFromMessage: () => true,
    reply: vi.fn(async (o: unknown) => { order.push('reply'); return o; }),
    deferReply: vi.fn(async () => { order.push('deferReply'); return {}; }),
    editReply: vi.fn(async (o: unknown) => { order.push('editReply'); edited.push(o); return {}; }),
    // Present at runtime, absent from the typings - the reason for the old cast.
    update: vi.fn(async () => { order.push('update'); return {}; }),
  } as unknown as ModalSubmitInteraction;
  return { interaction, order, edited };
};

describe('ComponentPaginatorService.handleJumpModal', () => {
  it('defers before rendering, so a slow render cannot blow the 3s window', async () => {
    const h = makeHarness({ renderMs: 30 });
    const { interaction, order } = makeModal('3');

    await h.service.handleJumpModal(interaction);

    // The ack must come before the expensive work, not after.
    expect(order[0]).toBe('deferReply');
    expect(order.indexOf('deferReply')).toBeLessThan(order.indexOf('editReply'));
  });

  it('responds with editReply, never the undeclared update', async () => {
    const h = makeHarness();
    const { interaction, order } = makeModal('2');

    await h.service.handleJumpModal(interaction);

    expect(order).toContain('editReply');
    // The cast-free, single-branch path. If anyone restores
    // `interaction.update(...)` here this fails.
    expect(order).not.toContain('update');
  });

  it('carries the rendered container with the Components V2 flag', async () => {
    const h = makeHarness();
    const { interaction, edited } = makeModal('2');

    await h.service.handleJumpModal(interaction);

    const last = edited[edited.length - 1] as { components: unknown[]; flags: number };
    expect(last.flags).toBe(MessageFlags.IsComponentsV2);
    expect(last.components).toHaveLength(1);
  });

  it('replies without deferring when the session is gone', async () => {
    // Nothing expensive to do, so deferring would leave a spinner the user
    // never sees resolved.
    const h = makeHarness({ session: false });
    const { interaction, order } = makeModal('2');

    await h.service.handleJumpModal(interaction);

    expect(order).toEqual(['reply']);
  });

  it('replies without deferring when the page number is invalid', async () => {
    const h = makeHarness({ totalPages: 3 });
    const { interaction, order } = makeModal('99');

    await h.service.handleJumpModal(interaction);

    expect(order).toEqual(['reply']);
  });

  it('does not crash when the page render throws, and edits the deferred reply', async () => {
    // The failure path used to reply a SECOND time after an update, which
    // Discord rejects with InteractionAlreadyReplied. Now it edits.
    const h = makeHarness({ renderThrows: true });
    const { interaction, order, edited } = makeModal('2');

    await expect(h.service.handleJumpModal(interaction)).resolves.toBeUndefined();

    expect(order).toContain('editReply');
    expect(order).not.toContain('reply');
    expect(edited[edited.length - 1]).toEqual({ content: 'Failed to update page.' });
  });
});
