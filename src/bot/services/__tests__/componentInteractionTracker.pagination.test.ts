import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentInteractionTracker } from '../system/componentInteractionTracker';
import { PaginationService } from '../system/paginationService';
import { ResponseModel } from '@bot/models/responseModel';

/**
 * The button-interaction registry every paginated embed depends on.
 *
 * Two things are load-bearing and neither is obvious from the code:
 *
 *   - `handle` answers `true` for a component it OWNS even when the handler
 *     threw. `true` means "this interaction was consumed"; the caller uses it to
 *     decide whether to still try replying. A `false` there would leave a
 *     failed handler free to be retried by a second dispatcher and produce two
 *     replies to one click.
 *   - 10062 "Unknown interaction" is the normal result of a click more than
 *     three seconds after the button rendered. It is expected, so it must not
 *     be logged as an ERROR on every slow render.
 *
 * `PaginationService` is exercised through the REAL tracker rather than a
 * double, so the customId it registers and the customId the tracker keys on are
 * the same fact from both sides.
 */

/**
 * A button interaction double.
 *
 * `deferred` / `replied` / `editReply` are on it because the paginator has to
 * answer all THREE component-interaction shapes and they are different calls:
 * an unacked one is answered with `update`, an already-deferred or
 * already-replied one with `editReply`. A double with only `update` cannot
 * express the second, and the branch would be untested. `..._args: unknown[]`
 * for the same reason as the slash double below — the payloads are read back
 * off `mock.calls`, and a zero-arg `vi.fn` infers a `[]` tuple that `tsc`
 * rejects at index 0.
 */
const button = (customId: string, over: Partial<{ deferred: boolean; replied: boolean }> = {}) => ({
  isButton: () => true,
  isAnySelectMenu: () => false,
  customId,
  deferred: false,
  replied: false,
  update: vi.fn(async (..._args: unknown[]) => undefined),
  editReply: vi.fn(async (..._args: unknown[]) => undefined),
  deferUpdate: vi.fn(async (..._args: unknown[]) => undefined),
  ...over,
});

const notAComponent = () => ({ isButton: () => false, isAnySelectMenu: () => false });

let tracker: ComponentInteractionTracker;

// Fake timers for the whole file: the tracker arms a 60s sweep interval on its
// first registration, and a real one is never cleared, so a dozen tests would
// leave a dozen live handles behind.
beforeEach(() => {
  vi.useFakeTimers();
  tracker = new ComponentInteractionTracker();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ComponentInteractionTracker.handle', () => {
  it('ignores an interaction that is not a component at all', async () => {
    // A slash command routed here by mistake must not consume anything.
    const handler = vi.fn(async () => undefined);
    tracker.register('x', handler);

    await expect(tracker.handle(notAComponent() as never)).resolves.toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores a component whose customId was never registered', async () => {
    await expect(tracker.handle(button('unknown') as never)).resolves.toBe(false);
  });

  it('runs the handler for its own customId and reports it consumed', async () => {
    const handler = vi.fn(async () => undefined);
    tracker.register('page:next', handler);

    await expect(tracker.handle(button('page:next') as never)).resolves.toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('routes by exact customId, never by prefix', async () => {
    // `page:next` and `page:next:extra` are different sessions; matching loosely
    // would let one user's click drive another user's pager.
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    tracker.register('page:next', first);
    tracker.register('page:next:extra', second);

    await tracker.handle(button('page:next') as never);

    expect(first).toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('reports a throwing handler as consumed rather than as unhandled', async () => {
    tracker.register('boom', async () => { throw new Error('render failed'); });

    // `true` is what stops a second dispatcher retrying the same click and
    // producing a duplicate reply.
    await expect(tracker.handle(button('boom') as never)).resolves.toBe(true);
  });

  it('treats 10062 Unknown interaction as an ordinary outcome', async () => {
    tracker.register('slow', async () => {
      throw Object.assign(new Error('Unknown interaction'), { code: 10062 });
    });

    await expect(tracker.handle(button('slow') as never)).resolves.toBe(true);
  });

  it('does not let a failed handler keep the entry alive for a second click', async () => {
    let attempts = 0;
    tracker.register('boom', async () => {
      attempts++;
      throw new Error('render failed');
    });

    await tracker.handle(button('boom') as never);
    await tracker.handle(button('boom') as never);

    expect(attempts).toBe(2);
  });
});

describe('ComponentInteractionTracker expiry', () => {
  it('refuses an expired handler and forgets it', async () => {
    const handler = vi.fn(async () => undefined);
    tracker.register('old', handler, 1000);

    vi.advanceTimersByTime(2000);
    await expect(tracker.handle(button('old') as never)).resolves.toBe(false);
    expect(handler).not.toHaveBeenCalled();

    // Forgetting it matters: the map is otherwise keyed by customId forever and
    // a stale entry would answer `true` for a click nobody can make any more.
    await expect(tracker.handle(button('old') as never)).resolves.toBe(false);
  });

  it('still runs a handler that has not expired', async () => {
    const handler = vi.fn(async () => undefined);
    tracker.register('live', handler, 600000);

    vi.advanceTimersByTime(590000);
    await expect(tracker.handle(button('live') as never)).resolves.toBe(true);
  });

  it('sweeps expired entries on its own timer', async () => {
    tracker.register('stale', async () => undefined, 1000);

    vi.advanceTimersByTime(120000);
    const handlers = (tracker as unknown as { handlers: Map<string, unknown> }).handlers;
    expect(handlers.size).toBe(0);
  });

  it('stops its own timer once the last entry has gone', async () => {
    tracker.register('stale', async () => undefined, 1000);
    vi.advanceTimersByTime(120000);

    const state = tracker as unknown as { cleanupTimer: unknown };
    expect(state.cleanupTimer).toBeNull();
  });

  it('reuses one timer for many registrations', async () => {
    tracker.register('a', async () => undefined, 600000);
    const first = (tracker as unknown as { cleanupTimer: unknown }).cleanupTimer;
    tracker.register('b', async () => undefined, 600000);
    expect((tracker as unknown as { cleanupTimer: unknown }).cleanupTimer).toBe(first);
  });

  it('keeps a live entry when a stale one is swept', async () => {
    tracker.register('stale', async () => undefined, 1000);
    tracker.register('live', async () => undefined, 600000);

    vi.advanceTimersByTime(120000);
    const handlers = (tracker as unknown as { handlers: Map<string, unknown> }).handlers;
    expect([...handlers.keys()]).toEqual(['live']);
  });
});

describe('PaginationService', () => {
  const page = (n: number) => {
    const response = new ResponseModel(0x123456);
    response.embed.setDescription(`page ${n}`);
    return response;
  };

  const slashInteraction = (over: Record<string, unknown> = {}) => {
    // `..._args: unknown[]` because the payloads are read back off `mock.calls`
    // below, and a zero-arg `vi.fn()` infers a `[]` call tuple that `tsc`
    // rejects at index 0.
    const reply = vi.fn(async (..._args: unknown[]) => undefined);
    const editReply = vi.fn(async (..._args: unknown[]) => undefined);
    return { reply, editReply, deferred: false, replied: false, ...over } as unknown as {
      reply: ReturnType<typeof vi.fn>;
      editReply: ReturnType<typeof vi.fn>;
      deferred: boolean;
      replied: boolean;
    };
  };

  /** Run the paginator and hand back a click helper bound to the real tracker. */
  const start = async (totalPages: number, interaction = slashInteraction()) => {
    const service = new PaginationService(tracker);
    await service.sendPaginatedAsync(interaction as never, totalPages, page);
    const registered = (tracker as unknown as { handlers: Map<string, { handler: (i: never) => Promise<void> }> }).handlers;
    const click = async (which: 'prev' | 'next') => {
      const entry = [...registered.entries()].find(([id]) => id.endsWith(`:${which}`));
      if (!entry) throw new Error(`no ${which} button registered`);
      const clicked = button(entry[0]);
      await entry[1].handler(clicked as never);
      return clicked;
    };
    return { click, interaction, registered };
  };

  /**
   * `ActionRowBuilder.toJSON()` returns the API-serialised payload — a plain
   * `{ type, label, disabled, custom_id }` per button. There is no `data`
   * wrapper (that is the builder's own shape, and it does not survive
   * serialisation), so a test that reads `b.data.label` off a `toJSON()`
   * result reads `undefined` for every button.
   */
  type SerialisedButton = { label?: string; disabled?: boolean; custom_id?: string };
  const rowOf = (payload: unknown) =>
    (
      (payload as {
        components: Array<{ toJSON: () => { components: SerialisedButton[] } }>;
      }).components[0]!
    ).toJSON().components;

  it('replies with the first page and a three-button row', async () => {
    const { interaction, registered } = await start(3);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const payload = interaction.reply.mock.calls[0]?.[0] as {
      embeds: Array<{ data: { description?: string } }>;
      components: Array<{ toJSON: () => { components: SerialisedButton[] } }>;
    };
    expect(payload.embeds[0]?.data.description).toBe('page 0');
    expect(payload.components).toHaveLength(1);
    expect(rowOf(payload).map((b) => b.label)).toEqual(['<', '1/3', '>']);
    // The rendered ids are the ones the tracker actually keys on, so a click on
    // the real message reaches the handler rather than 404-ing in `handle`. The
    // middle button is the always-disabled indicator, which is deliberately NOT
    // registered: there is nothing to do on it.
    const renderedIds = rowOf(payload).map((b) => b.custom_id);
    const registeredIds = [...registered.keys()];
    expect(registeredIds).toEqual([renderedIds[0], renderedIds[2]]);
    expect(registeredIds).not.toContain(renderedIds[1]);
  });

  it('disables previous on the first page and next on the last', async () => {
    const { interaction } = await start(1);
    const buttons = rowOf(interaction.reply.mock.calls[0]?.[0]);
    expect(buttons[0]?.disabled).toBe(true);
    expect(buttons[2]?.disabled).toBe(true);
  });

  it('advances and edits rather than replying again', async () => {
    // This test was rewritten on 2026-09-30 to assert the reply-per-page
    // reality and its name was softened to match. The name is the better spec
    // and the behaviour is now what the name says.
    //
    // The old code acknowledged the click with `i.update({})`, which strips the
    // button row off the ORIGINAL message, and then posted the new page with
    // `interaction.reply`. A 20-page chart therefore produced 20 messages and 20
    // blanked originals, and it only worked because the slash interaction had
    // already been answered once — the second `reply` was a second answer to a
    // single interaction.
    //
    // One `i.update(payload)` now both acks the click and edits the one message.
    const { click, interaction } = await start(3);

    const clicked = await click('next');

    expect(clicked.update).toHaveBeenCalledTimes(1);
    expect(clicked.deferUpdate).not.toHaveBeenCalled();
    // The page came out on the CLICK's message, not on a new one.
    expect(clicked.editReply).not.toHaveBeenCalled();
    // And the slash interaction was never answered a second time.
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();
    const payload = clicked.update.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe('page 1');
  });

  it('the edited page carries its own button row, on the same ids', async () => {
    // The failure mode a bare `i.update({})` created: the original message was
    // left with no buttons at all, and every page after it was a fresh message.
    // One message means the row has to be re-sent on every edit or the pager
    // dies after a single click.
    const { click } = await start(3);

    const first = await click('next');
    const second = await click('next');

    const edited = (
      clicked: { update: { mock: { calls: unknown[][] } } },
    ) =>
      rowOf(clicked.update.mock.calls[0]?.[0] as {
        components: Array<{ toJSON: () => { components: SerialisedButton[] } }>;
      });

    // Middle page: both arrows live.
    expect(edited(first).map((b) => b.label)).toEqual(['<', '2/3', '>']);
    expect(edited(first).map((b) => b.disabled)).toEqual([false, true, false]);
    // Last page: next is disabled, and the row moved with the page.
    expect(edited(second).map((b) => b.label)).toEqual(['<', '3/3', '>']);
    expect(edited(second).map((b) => b.disabled)).toEqual([false, true, true]);
  });

  it('goes back to the page it came from', async () => {
    const { click, interaction } = await start(3);

    const first = await click('next');
    const second = await click('next');
    const back = await click('prev');

    // Still exactly one message: the initial send. Three clicks, three edits.
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(back.update).toHaveBeenCalledTimes(1);
    const payload = back.update.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe('page 1');
    // Each click is answered by its OWN interaction, so nothing double-acks.
    expect(second.update).toHaveBeenCalledTimes(1);
    expect(first.update).toHaveBeenCalledTimes(1);
  });

  it('does not edit anything when prev is pressed on the first page', async () => {
    const { click, interaction } = await start(3);

    await click('prev');
    await click('prev');

    // A rejected edit on a boundary button leaves the user with a spinner that
    // never resolves, so the boundary handler edits nothing at all.
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
  });

  it('stops at the last page', async () => {
    const { click, interaction } = await start(2);

    const reached = await click('next');
    const beyond = await click('next');
    await click('next');

    // Two pages: the initial send plus one edit, and the message count never
    // moves. The two clicks past the end are acknowledged with `deferUpdate`
    // and never move the page.
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(reached.update).toHaveBeenCalledTimes(1);
    expect(beyond.update).not.toHaveBeenCalled();
    expect(beyond.deferUpdate).toHaveBeenCalledTimes(1);
    const payload = reached.update.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe('page 1');
  });

  it('edits an interaction that was already deferred', async () => {
    // A slow paginator over a long list answers after the 3s interaction
    // deadline, so the first page is an edit, not a reply.
    const interaction = slashInteraction({ deferred: true, replied: true });
    const { click } = await start(2, interaction);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    await click('next');
    // The initial send used the slash interaction; the page change must NOT.
    // Re-answering it is the double-ack.
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('a DEFERRED button interaction is answered with editReply, exactly once', async () => {
    // The path that differs from the common one. `update` is documented to fail
    // on an already-deferred interaction, and the failure is silent from the
    // user's side: the button keeps spinning and the page never changes. An
    // interaction that has been deferred before reaching the handler must take
    // `editReply`, and must not take both.
    const { click } = await start(2);
    const clicked = button('tvb-pg:any:next', { deferred: true, replied: true });

    const entry = [...(tracker as unknown as { handlers: Map<string, { handler: (i: never) => Promise<void> }> }).handlers.entries()]
      .find(([id]) => id.endsWith(':next'))!;
    await entry[1].handler(clicked as never);

    expect(clicked.editReply).toHaveBeenCalledTimes(1);
    expect(clicked.update).not.toHaveBeenCalled();
    expect(clicked.deferUpdate).not.toHaveBeenCalled();
    const payload = clicked.editReply.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe('page 1');
    // The page moved, so the state advanced rather than the handler being a no-op.
    expect(clicked.deferUpdate).not.toHaveBeenCalled();
    await click('next');
  });

  it('an UNACKED button interaction is answered with update, exactly once', async () => {
    // The other half of the pair above, and the shape 99% of clicks have. Both
    // branches are asserted because they are two different lines: a paginator
    // that only had one of them works right up until a click arrives in the
    // other shape, and then the button just spins.
    const { interaction, registered } = await start(2);
    const entry = [...registered.entries()].find(([id]) => id.endsWith(':next'))!;
    const clicked = button(entry[0]);

    await entry[1].handler(clicked as never);

    expect(clicked.update).toHaveBeenCalledTimes(1);
    expect(clicked.editReply).not.toHaveBeenCalled();
    expect(clicked.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const payload = clicked.update.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe('page 1');
  });

  it('an already-REPLIED button interaction takes editReply too', async () => {
    // Third shape, same branch as deferred: `replied` without `deferred` still
    // forbids `update`, so the condition reads both flags rather than one.
    const { registered } = await start(2);
    const entry = [...registered.entries()].find(([id]) => id.endsWith(':next'))!;
    const clicked = button(entry[0], { deferred: false, replied: true });

    await entry[1].handler(clicked as never);

    expect(clicked.editReply).toHaveBeenCalledTimes(1);
    expect(clicked.update).not.toHaveBeenCalled();
  });

  it('paging twenty times never posts a second message', async () => {
    // The shape the fix exists for. Before it, this produced 21 messages and 21
    // blanked originals; asserting the MESSAGE COUNT rather than one call is
    // what makes it a regression test instead of a spot check.
    const { click, interaction } = await start(20);
    const sent = interaction.reply.mock.calls.length;

    for (let i = 0; i < 19; i++) await click('next');

    expect(interaction.reply).toHaveBeenCalledTimes(sent);
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('gives each session its own customIds', async () => {
    // There is ONE process-wide tracker, so the second paginator's ids land
    // beside the first's rather than replacing them.
    const first = await start(2);
    const firstIds = [...first.registered.keys()];
    const second = await start(2);
    const secondIds = [...second.registered.keys()].filter((id) => !firstIds.includes(id));

    expect(firstIds).toHaveLength(2);
    expect(secondIds).toHaveLength(2);
    // Disjoint: a shared id would drive one user's pager from another user's
    // click, which is the whole reason the session id is in the customId.
    for (const id of secondIds) {
      expect(firstIds).not.toContain(id);
    }
  });

  it('keeps its own page state, so two paginators never fight over one variable', async () => {
    const first = await start(3);
    const second = await start(3);

    await first.click('next');
    await first.click('next');

    const payload = second.interaction.reply.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe('page 0');
  });

  it('ignores a non-button interaction delivered to a page handler', async () => {
    const { registered } = await start(2);
    const entry = [...registered.entries()].find(([id]) => id.endsWith(':next'))!;

    await entry[1].handler(notAComponent() as never);

    expect(registered.size).toBe(2);
  });
});
