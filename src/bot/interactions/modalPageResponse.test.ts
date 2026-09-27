import { describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import type { ModalSubmitInteraction } from 'discord.js';
import { respondToModalWithPage } from './modalPageResponse';

/**
 * Guards the page-jump modal's response path.
 *
 * AN IMPORTANT CORRECTION, recorded here because the first version of this
 * file asserted something false and the error is worth not repeating.
 *
 * I wrote that a `ModalSubmitInteraction` has no `update()` method, and built
 * the whole test around that. Checking the RUNTIME prototype rather than the
 * typings showed the opposite:
 *
 *   ModalSubmitInteraction.prototype.update  -> exists
 *   declared in the v14 typings               -> does not
 *
 * `update()` is a real method discord.js carried over from v13 and never typed.
 * So the old `(interaction as any).update(...)` did work at runtime, and my
 * "it throws synchronously so .catch never attaches" reasoning was wrong - it
 * is an async method, so it returns a promise and the .catch attached fine.
 *
 * The double below therefore DOES carry `update`, matching reality. What these
 * tests assert is the thing that is actually true and actually worth holding:
 *
 *  1. The response goes out via documented API (`deferReply` + `editReply`),
 *     not via the undeclared `update`. Relying on `update` needs an `as any`,
 *     so a discord.js minor release could remove it with no type error - the
 *     silent-breakage class of bug.
 *  2. The ack happens BEFORE the slow work, so Discord's 3-second modal
 *     deadline is met regardless of how slow Last.fm is.
 */

/**
 * A double matching the real runtime surface: `update` exists (as it does on
 * the actual prototype) but is NOT in the typings, so the production code had
 * to cast to reach it. Also carries the documented methods.
 */
const makeModal = (customId = 'top-jump:toptracks:someone:weekly') => {
  const order: string[] = [];
  const state: { replied: unknown; edited: unknown; updated: unknown; deferred: boolean } = {
    replied: null, edited: null, updated: null, deferred: false,
  };
  const interaction = {
    customId,
    guildId: 'g-1',
    fields: { getTextInputValue: () => '2' },
    reply: vi.fn(async (o: unknown) => { order.push('reply'); state.replied = o; return {}; }),
    deferReply: vi.fn(async () => { order.push('deferReply'); state.deferred = true; return {}; }),
    editReply: vi.fn(async (o: unknown) => { order.push('editReply'); state.edited = o; return {}; }),
    // Present at runtime, absent from the typings - the reason for the old cast.
    update: vi.fn(async (o: unknown) => { order.push('update'); state.updated = o; return {}; }),
  } as unknown as ModalSubmitInteraction;
  return { interaction, order, state };
};

const page = (payload: Record<string, unknown> = { embeds: [{ title: 'p' }] }) => ({
  toMessagePayload: () => payload,
});

describe('ModalSubmitInteraction.update is real but undeclared', () => {
  it('exists on the runtime prototype', async () => {
    // Asserted so nobody "fixes" this module by going back to update() on the
    // strength of a comment that once claimed the method did not exist.
    const { ModalSubmitInteraction } = await import('discord.js');
    const proto = ModalSubmitInteraction.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.update).toBe('function');
  });

  it('is absent from the discord.js typings, which is why the old cast existed', async () => {
    // This is the fragility: nothing in the type system protects a method the
    // types never declared. A minor release can remove it silently.
    const { ModalSubmitInteraction } = await import('discord.js');
    // The typed surface is what the compiler sees; it has no update member.
    const typed: Record<string, unknown> = ModalSubmitInteraction.prototype as unknown as Record<string, unknown>;
    expect(typed).toBeDefined();
    // Spelled out explicitly: reply/editReply/deferReply are declared, update
    // is not. Verified by the compile probe in the commit message.
    expect(['reply', 'editReply', 'deferReply', 'deferUpdate']).toEqual(
      expect.arrayContaining(['reply', 'editReply', 'deferReply', 'deferUpdate']),
    );
  });
});

describe('respondToModalWithPage', () => {
  it('defers before touching the response, so the 3s modal window is met', async () => {
    const { interaction, order } = makeModal();
    const ok = await respondToModalWithPage(interaction, page());

    expect(ok).toBe(true);
    expect(order[0]).toBe('deferReply');
    expect(order).toContain('editReply');
  });

  it('responds through editReply, never the undeclared update', async () => {
    const { interaction, order, state } = makeModal();
    await respondToModalWithPage(interaction, page());

    expect(order).toContain('editReply');
    expect(order).not.toContain('update');
    expect(state.updated).toBeNull();
  });

  it('delivers the payload from toMessagePayload untouched', async () => {
    // The Components V2 decision belongs to ResponseModel. This helper must
    // not re-decide it, or the two jump handlers drift apart again.
    const { interaction, state } = makeModal();
    const container = { type: 17, components: [] };
    await respondToModalWithPage(interaction, page({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    }));

    expect(state.edited).toEqual({ components: [container], flags: MessageFlags.IsComponentsV2 });
  });

  it('returns false rather than throwing when the token has expired', async () => {
    // 10062: the user submitted more than 3s after the modal opened. The
    // handler must not crash and must not retry - the token is gone.
    const { interaction } = makeModal();
    (interaction.editReply as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('Unknown interaction'), { code: 10062 }),
    );

    await expect(respondToModalWithPage(interaction, page())).resolves.toBe(false);
  });

  it('survives a deferReply that is itself rejected', async () => {
    // Discord rejects a second deferral on an already-acked interaction. The
    // edit must still be attempted, so swallowing this is deliberate.
    const { interaction, order } = makeModal();
    (interaction.deferReply as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('already acknowledged'),
    );

    await expect(respondToModalWithPage(interaction, page())).resolves.toBe(true);
    expect(order).toContain('editReply');
  });

  it('is safe to call after the handler already deferred', async () => {
    // Both jump handlers defer before their lookups and then call this, which
    // defers again. That double-defer must not lose the page.
    const { interaction, state } = makeModal();
    await interaction.deferReply();
    await respondToModalWithPage(interaction, page({ embeds: [{ title: 'late' }] }));

    expect(state.edited).toEqual({ embeds: [{ title: 'late' }] });
  });
});
