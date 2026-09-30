import type { MoonlinkManager } from './moonlinkManager';

/**
 * Node-health probes shared by the playback service and the search ladder.
 *
 * Both consumers need the same two questions, and both must answer them
 * *tolerantly* of partial test doubles: a double that predates the
 * REST-death work has neither method, and the correct answer is "not cooling"
 * and "assume healthy" respectively — never a throw. Keeping that tolerance in
 * one place means the ladder and the service can never drift apart on it.
 */

/**
 * REST-dead cooldown check, tolerant of partial test doubles.
 *
 * The declared `boolean` is now actually a boolean: the manager's own answer is
 * read for its truthiness, which is precisely what both call sites
 * (`musicPlayerRegistry.ts:180`, `musicSearchLadder.ts:302`) did with the raw
 * value. The old body returned `fn.call(mm, id)` unchanged under a `: boolean`
 * signature, so a manager that answered with a truthy non-boolean handed every
 * caller a value its own types claimed could not happen.
 */
export const isNodeCooling = (mm: MoonlinkManager, identifier: string): boolean => {
  const fn = mm.isNodeCoolingDown;
  return typeof fn === 'function' ? Boolean(fn.call(mm, identifier)) : false;
};

/** Node availability, tolerant of partial test doubles (assume healthy). */
export const hasHealthyNode = (mm: MoonlinkManager): boolean => {
  const fn = mm.hasHealthyNode;
  return typeof fn === 'function' ? fn.call(mm) : true;
};
