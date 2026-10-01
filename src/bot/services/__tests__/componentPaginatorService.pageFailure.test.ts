import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { ButtonInteraction, ContainerBuilder } from 'discord.js';
import { ComponentPaginatorService } from '@bot/services/system/componentPaginatorService';

/**
 * `handleButton` when the page it is asked to move to cannot be fetched.
 *
 * WHAT WAS WRONG, and it is not the thing this round set out to fix.
 *
 * The plan's recorded rule for a paginator is that one which cannot fetch a
 * later page must not destroy the page the user is already looking at. The
 * `deferUpdate()` in the catch honours that - it acknowledges the press
 * WITHOUT editing the message, so the visible page is untouched. That part was
 * already right and this file pins it, because a version that "fixed" the
 * silence by rendering an empty page would pass every assertion about the
 * message while being the lie the plan forbids.
 *
 * What was wrong was one line above it. `session.currentPage = targetPage` sat
 * OUTSIDE the `try`, so it was committed BEFORE the render was attempted. After
 * a failed fetch the session claimed a page the message was not showing: the
 * cursor and the pixels disagreed. The next press computed its target from the
 * phantom page, so "next" skipped straight over a page of real listeners with
 * no indication anything had gone wrong - a chunk of a table of real people
 * silently missing, which is the same failure class as a leaderboard that
 * quietly drops a row, just harder to notice because the page still rendered.
 *
 * The fix moves the assignment below the `interaction.update()`, so the cursor
 * only ever advances to a page the user can actually see. That is also what
 * `handleJumpModal` already did at its own `session.currentPage` assignment, so
 * this brings the button path in line with its sibling rather than inventing a
 * new rule.
 *
 * Doubles are fresh plain objects per test and nothing is spied on. The
 * constructor is bypassed with `Object.create` because it registers a global
 * modal handler and starts a 60s interval, neither of which is under test -
 * the same harness `componentPaginatorModal.test.ts` uses for this class.
 */

const build = (opts: { renderThrows?: boolean; totalPages?: number } = {}) => {
  const container = { type: 17, components: [] } as unknown as ContainerBuilder;
  const renderPage = vi.fn(async (..._args: unknown[]) => {
    if (opts.renderThrows) {
      // Stands in for a `SourceUnavailableError` raised by a database read the
      // caller's `renderPage` performed. The paginator must not care which.
      throw new Error('Database unavailable during page render');
    }
    return container;
  });

  const session = {
    currentPage: 0,
    totalPages: opts.totalPages ?? 5,
    renderPage: renderPage as unknown as (pageIndex: number) => Promise<ContainerBuilder>,
    expiresAt: Date.now() + 60_000,
  };

  const service = Object.create(ComponentPaginatorService.prototype) as ComponentPaginatorService;
  (service as unknown as { sessions: Map<string, unknown> }).sessions = new Map<string, unknown>([
    ['m1', session],
  ]);
  (service as unknown as { ensureCleanupTimer: () => void }).ensureCleanupTimer = () => undefined;

  return { service, session, renderPage, container };
};

/** A `component_paginator_next` press. Only these four members are read. */
const pressNext = () => {
  const update = vi.fn(async () => undefined);
  const deferUpdate = vi.fn(async () => undefined);
  const interaction = {
    customId: 'component_paginator_next',
    message: { id: 'm1' },
    update,
    deferUpdate,
  } as unknown as ButtonInteraction;
  return { interaction, update, deferUpdate };
};

describe('ComponentPaginatorService.handleButton: a page that cannot be fetched', () => {
  it('leaves the message showing the page the user is already on', async () => {
    // The recorded rule, and the assertion that would fail if someone "fixed"
    // the dead button by rendering an empty page instead.
    const { service, session } = build({ renderThrows: true });
    const { interaction, update, deferUpdate } = pressNext();

    await expect(service.handleButton(interaction)).resolves.toBe(true);

    expect(update).not.toHaveBeenCalled();
    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(session.currentPage).toBe(0);
  });

  it('does not advance the cursor past a page it failed to render', async () => {
    // The half that was actually broken. Same setup, asserted on the state
    // rather than the message: the session must not claim a page the pixels do
    // not show.
    const { service, session } = build({ renderThrows: true });

    await service.handleButton(pressNext().interaction);

    expect(session.currentPage).toBe(0);
  });

  it('retries the SAME page on the next press instead of skipping a page of rows', async () => {
    // The user-visible consequence, which is why this is worth a test of its
    // own rather than resting on the state assertion above. Two failed presses
    // must both target page index 1. With the assignment above the `try`, the
    // second press targets index 2 and page 1 is never shown to anyone.
    const { service, session, renderPage } = build({ renderThrows: true });

    await service.handleButton(pressNext().interaction);
    await service.handleButton(pressNext().interaction);

    expect(renderPage.mock.calls.map((c) => c[0])).toEqual([1, 1]);
    expect(session.currentPage).toBe(0);
  });

  it('still advances the cursor and edits the message when the fetch succeeds', async () => {
    // The honest half of the pair. Without it, "never move the cursor" would
    // pass every failure assertion above and be a completely broken paginator.
    const { service, session, renderPage, container } = build();
    const { interaction, update, deferUpdate } = pressNext();

    await service.handleButton(interaction);

    expect(renderPage).toHaveBeenCalledWith(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect((update.mock.calls[0] as unknown as [{ components: unknown[] }])[0].components).toEqual([
      container,
    ]);
    expect(deferUpdate).not.toHaveBeenCalled();
    expect(session.currentPage).toBe(1);
  });

  it('advances across several successful pages, so the fix is not a one-page-only cap', async () => {
    const { service, session } = build({ totalPages: 3 });

    await service.handleButton(pressNext().interaction);
    expect(session.currentPage).toBe(1);
    await service.handleButton(pressNext().interaction);
    expect(session.currentPage).toBe(2);
  });
});
