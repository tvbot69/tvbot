import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { hasHealthyNode, isNodeCooling } from './musicNodeHealth';
import type { MoonlinkManager } from './moonlinkManager';

/**
 * The two node-health questions the playback service and the search ladder
 * share, and the tolerance they owe older/partial test doubles.
 *
 * Both consumers MUST get the same answer. When they drift, a node cools for
 * one path and stays selectable for the other — which is how a REST-dead node
 * keeps absorbing searches that the ladder believed it had excluded. Putting
 * both in one module is the guard; these tests are the other half of it.
 *
 * The tolerance is not politeness. A double that predates the REST-death work
 * has neither method, and the correct answer is "not cooling" / "assume
 * healthy" respectively — never a throw. A throw here would abort an entire
 * ladder pass because one collaborator is an older shape.
 */

type Partial = Record<string, unknown>;

const mm = (shape: Partial): MoonlinkManager => shape as unknown as MoonlinkManager;

describe('isNodeCooling', () => {
  it('answers from the manager when the manager knows', () => {
    const cooling = isNodeCooling(
      mm({ isNodeCoolingDown: (id: string) => id === 'Home' }),
      'Home',
    );
    expect(cooling).toBe(true);
  });

  it('is false for a node that is not cooling', () => {
    expect(isNodeCooling(mm({ isNodeCoolingDown: () => false }), 'Home')).toBe(false);
  });

  it('asks about the node it was given, not a hard-coded one', () => {
    const asked: string[] = [];
    isNodeCooling(
      mm({
        isNodeCoolingDown: (id: string) => {
          asked.push(id);
          return false;
        },
      }),
      'node-b',
    );
    expect(asked).toEqual(['node-b']);
  });

  it('invokes it with the manager as `this`, not detached', () => {
    // A method that reads its own cooldown Map needs the receiver; calling it
    // as a bare function would throw inside the manager.
    const seen: unknown[] = [];
    const manager = {
      cooldown: new Set(['Home']),
      isNodeCoolingDown(this: { cooldown: Set<string> }, id: string): boolean {
        seen.push(this.cooldown);
        return this.cooldown.has(id);
      },
    };
    expect(isNodeCooling(mm(manager), 'Home')).toBe(true);
    expect(seen[0]).toBe(manager.cooldown);
  });

  it('a double with no such method reads as NOT cooling, rather than throwing', () => {
    // `musicSearchLadder` reaches this with whatever MoonlinkManager shape the
    // caller injected; a pre-REST-death double must still search.
    expect(isNodeCooling(mm({}), 'Home')).toBe(false);
    expect(isNodeCooling(mm({ isNodeCoolingDown: undefined }), 'Home')).toBe(false);
    expect(isNodeCooling(mm({ isNodeCoolingDown: 'not a function' }), 'Home')).toBe(false);
  });

  it('a truthy non-boolean answer from the manager is passed through, not coerced', () => {
    // Coercion here would hide a manager bug behind a plausible boolean.
    // The pass-through is TOTAL: `isNodeCooling` declares `: boolean` but
    // returns `fn.call(mm, id)` verbatim, so at runtime the caller's value
    // arrives unchanged. Read it as `unknown` — asserting `toBe(true)` would
    // be asserting a coercion the code does not perform, and `toBe('yes')` on
    // a `boolean`-typed expression is a type error, which is the signature
    // disagreeing with the behaviour rather than the behaviour being wrong.
    const answer: unknown = isNodeCooling(mm({ isNodeCoolingDown: () => 'yes' }), 'Home');
    expect(answer).toBe('yes');
    // A falsy non-boolean is likewise not laundered into `false`.
    const falsy: unknown = isNodeCooling(mm({ isNodeCoolingDown: () => 0 }), 'Home');
    expect(falsy).toBe(0);
  });
});

describe('hasHealthyNode', () => {
  it('answers from the manager when the manager knows', () => {
    expect(hasHealthyNode(mm({ hasHealthyNode: () => false }))).toBe(false);
  });

  it('assumes HEALTHY for a double with no such method, rather than throwing', () => {
    // The safe default direction: assuming unhealthy would refuse every play
    // in a suite (and, in any real caller, silence the bot entirely).
    expect(hasHealthyNode(mm({}))).toBe(true);
    expect(hasHealthyNode(mm({ hasHealthyNode: undefined }))).toBe(true);
    expect(hasHealthyNode(mm({ hasHealthyNode: 42 }))).toBe(true);
  });

  it('invokes it with the manager as `this`', () => {
    const seen: unknown[] = [];
    const manager = {
      down: new Set(['Home']),
      hasHealthyNode(this: { down: Set<string> }): boolean {
        seen.push(this.down);
        return this.down.size === 0;
      },
    };
    expect(hasHealthyNode(mm(manager))).toBe(false);
    expect(seen[0]).toBe(manager.down);
  });

  it('the two answers are independent: a manager can report a cooling node and still be healthy', () => {
    // One node cooling is not "no nodes". Collapsing the two would turn a
    // single bad node into a bot-wide refusal.
    const manager = mm({ isNodeCoolingDown: () => true, hasHealthyNode: () => true });
    expect(isNodeCooling(manager, 'Home')).toBe(true);
    expect(hasHealthyNode(manager)).toBe(true);
  });

  it('both probes are read off the same manager each call, so a spy sees both', () => {
    const isCooling = vi.fn(() => false);
    const healthy = vi.fn(() => true);
    const manager = mm({ isNodeCoolingDown: isCooling, hasHealthyNode: healthy });
    isNodeCooling(manager, 'Home');
    hasHealthyNode(manager);
    expect(isCooling).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});