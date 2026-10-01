import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { REPO_ROOT } from '../../../testSupport/repoRoot';

/**
 * Components V2 payloads must never contain `undefined`.
 *
 * THE FAILURE. `interaction.update({ components: [response.componentsV2Container],
 * flags: MessageFlags.IsComponentsV2 })` where the field is optional. If it is
 * undefined, this posts the literal JSON `[null]` with the Components V2 flag
 * set, and Discord rejects the edit - or worse, the button row silently
 * disappears. `as any` on the payload is what let it compile.
 *
 * ALREADY FIXED ONCE: profileInteractions had exactly this bug, and the fix was
 * a local guard. It was never generalised, so the same omission survived in
 * artistInteractions while its siblings - albumInteractions,
 * countryInteractions, crownInteractions - all carried the guard.
 *
 * WHY THIS IS A TEXT TEST. The condition is "does this source file guard the
 * payload before building it", which is a property of the text, not of a
 * runtime path - the happy path always has a container, so no behavioural test
 * can reach the bad branch. A source invariant is the honest way to hold it,
 * and it fails the moment someone adds an eleventh file and forgets.
 *
 * The one thing it cannot do is catch a guard on the wrong variable, so the
 * rule requires the same identifier on both sides of the `if`.
 */

// This test file lives in src/bot/interactions, so the repo root is THREE
// levels up. Asserted rather than assumed: the first version guessed two and
// the suite failed to even collect with ENOENT.
const REPO = REPO_ROOT;
const INTERACTIONS = path.join(REPO, 'src/bot/interactions');

/** Every file that builds a Components V2 payload from a response field. */
const candidates = fs
  .readdirSync(INTERACTIONS, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => path.join(INTERACTIONS, f));

describe('Components V2 payloads are guarded', () => {
  it('finds the files it is checking (a silent empty run would pass vacuously)', () => {
    expect(candidates.length).toBeGreaterThan(10);
  });

  for (const file of candidates) {
    const rel = path.basename(file);
    const text = fs.readFileSync(file, 'utf8');

    // Every `[x.componentsV2Container]` that lands inside a components array.
    const uses = [...text.matchAll(/components:\s*\[(\w+)\.componentsV2Container\]/g)];
    if (uses.length === 0) continue;

    it(`${rel} guards every componentsV2Container it posts`, () => {
      const unguarded: string[] = [];

      for (const use of uses) {
        const variable = use[1];
        const index = use.index ?? 0;

        // Look back through the preceding block for a guard that proves the
        // container is present. Two forms count, and they are equally strong:
        //
        //   if (x.componentsV2Container)
        //   if (x.isComponentsV2)
        //
        // because ResponseModel DEFINES isComponentsV2 as
        // `componentsV2Container !== undefined`. Testing it is the same test.
        // chartInteractions uses a ternary on isComponentsV2 for the same
        // reason. An earlier version of this rule accepted only the first form
        // and reported four files that were in fact guarded.
        //
        // 600 chars is enough to cover the builder call and the guard that
        // immediately precedes the post.
        const before = text.slice(Math.max(0, index - 600), index);
        const guarded = new RegExp(
          `if\\s*\\(\\s*${variable}\\.componentsV2Container\\s*\\)|if\\s*\\([^)]*${variable}\\.isComponentsV2[^)]*\\)|${variable}\\.isComponentsV2\\s*\\?`,
        ).test(before);
        if (!guarded) {
          unguarded.push(`${variable}.componentsV2Container at offset ${index}`);
        }
      }

      expect(unguarded, `unguarded Components V2 payload(s) in ${rel}: ${unguarded.join(', ')}`).toEqual([]);
    });
  }
});

describe('no Components V2 payload is cast to any', () => {
  for (const file of candidates) {
    const rel = path.basename(file);
    const text = fs.readFileSync(file, 'utf8');
    if (!/components:\s*\[\w+\.componentsV2Container\]/.test(text)) continue;

    it(`${rel} does not silence the payload type with a cast`, () => {
      // The cast is the symptom: it exists only to get `[undefined]` past the
      // compiler. With the guard in place the payload typechecks on its own.
      //
      // Matched in BOTH layouts. The first version of this rule only handled
      // the multi-line form, so the single-line payloads - which is how
      // artistTrackInteractions and topInteractions write it - slipped through
      // and a mutation re-adding a cast survived. The guard is what makes the
      // cast unnecessary, so the cast must not come back in any layout.
      const casts = [
        // multi-line
        ...text.matchAll(/flags: MessageFlags\.IsComponentsV2,?\s*\n\s*\} as any\)/g),
        // single-line
        ...text.matchAll(/flags: MessageFlags\.IsComponentsV2\s*\} as any\)/g),
      ];
      expect(
        casts.length,
        `${rel} still casts a Components V2 payload to any; the guard should make it unnecessary`,
      ).toBe(0);
    });
  }
});
