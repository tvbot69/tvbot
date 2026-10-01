import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SRC_ROOT } from '../testSupport/repoRoot';

/**
 * Structural invariants about module side effects and service location.
 *
 * These are properties of the source text, not of behaviour, so reading the
 * file is the honest way to assert them. A behavioural test cannot tell the
 * difference between "calls telemetry" and "resolves telemetry from a
 * container at a call site" - the wire traffic is identical.
 */

const SRC = SRC_ROOT;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const tsFiles = (sub: string): string[] =>
  walk(join(SRC, sub))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.replace(/\\/g, '/'));

describe('no module-scope side effects outside the entrypoints', () => {
  // The three real process entrypoints. Each runs first, before anything is
  // imported, so a module-scope call is the correct place for it - and
  // anywhere else it fires as a side effect of importing an unrelated module.
  const ENTRYPOINTS = ['/bot/index.ts', '/bot/shardManager.ts', '/bot/shardWorker.ts'];

  it('dns.setDefaultResultOrder appears only in the entrypoints', () => {
    // It used to also fire on import of lastfmApi, which meant a unit test
    // importing that module silently changed resolver behaviour process-wide.
    const offenders = tsFiles('.')
      .filter((f) => readFileSync(f, 'utf8').includes('setDefaultResultOrder'))
      .filter((f) => !ENTRYPOINTS.some((e) => f.endsWith(e)));

    expect(offenders).toEqual([]);
  });

  it('every entrypoint still does it, because something has to', () => {
    // The guard above is only safe if the real calls were not simply deleted.
    for (const e of ENTRYPOINTS) {
      const f = tsFiles('.').find((p) => p.endsWith(e));
      expect(f, `entrypoint missing: ${e}`).toBeDefined();
      expect(readFileSync(f as string, 'utf8')).toContain('setDefaultResultOrder');
    }
  });
});

describe('lower layers do not service-locate', () => {
  const LOWER = ['lastfm', 'persistence', 'images'];

  it('nothing under src/lastfm, src/persistence or src/images calls container.resolve', () => {
    // Locating a dependency at a call site makes it invisible in the
    // constructor, so neither the wiring graph nor a test double can see it.
    const offenders = LOWER.flatMap(tsFiles).filter((f) =>
      /container\.(resolve|isRegistered)\(/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('nothing under those layers imports a @bot class for DI', () => {
    // Type-only imports from @bot are fine - they are erased. A value import
    // is a real runtime edge from a lower layer to a higher one.
    const offenders = LOWER.flatMap(tsFiles).filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /^import\s+(?!type\b)[^;]*from\s+'@bot\//m.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
