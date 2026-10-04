import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { SRC_ROOT } from '../testSupport/repoRoot';
import ts from 'typescript';

/**
 * Registry invariants for the command layer.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two commands shared a name twice and both times the failure was silent. The
 * registry is last-write-wins, so `.remove` quietly became the queue-remove
 * command instead of account-unlink, and `.lyrics` quietly became the music
 * lyrics command instead of the Last.fm one. The only signal was a WARN line at
 * startup, which nobody reads unless they already suspect something.
 *
 * The collision logic itself is awkward to unit-test because `commands` is
 * instance state built in each module's constructor, so reading the real
 * definitions would mean standing up the whole DI container. Instead this reads
 * the definitions where they are written: the object literals in source.
 *
 * THE LOUD-FAILURE RULE
 * ---------------------
 * A test that extracts names by regex or AST can silently find nothing and pass
 * vacuously - which is exactly the trap that made the old chapter invariant test
 * worthless. So this test COUNTS what it found and asserts the count is
 * plausible, and it throws if any `name`/`aliases` value is not a string
 * literal. If someone starts computing a command name, this test breaks loudly
 * instead of quietly covering less.
 *
 * Names only - no instantiation, no container, no network, no database.
 */

const ROOT = join(SRC_ROOT, 'bot');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
};

interface CommandNames {
  name: string;
  aliases: string[];
  file: string;
}

/** Literal string value of an expression, or null when it is not a literal. */
const literal = (node: ts.Node | undefined): string | null => {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
};

/**
 * Collect every `{ name, aliases }` command literal in a file.
 * Throws on a non-literal name, which is the loud-failure guarantee.
 */
const extract = (file: string, text: string): CommandNames[] => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: CommandNames[] = [];
  const rel = relative(process.cwd(), file).replace(/\\/g, '/');

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const propNamed = (key: string) =>
        node.properties.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) &&
            ((ts.isIdentifier(p.name) && p.name.text === key) ||
              (ts.isStringLiteral(p.name) && p.name.text === key)),
        );

      // A command literal is identified by its executor. `name` alone is far too
      // loose: `{ artistId: 0, name }` is an artist return value, not a command.
      const isCommand = !!propNamed('executeAsync') || !!propNamed('execute');

      // A spread-rewritten literal is DERIVED from a real definition, not a
      // declaration. musicCommands wraps every control command like this:
      //   { ...def, executeAsync: (ctx, args) => this.withControl(ctx, ...) }
      // It has an executor but takes its name from `...def`, so treating it as a
      // definition would double-count the name and manufacture a false clash.
      const isDerived = node.properties.some((p) => ts.isSpreadAssignment(p));

      if (isCommand && !isDerived) {
        const nameProp = propNamed('name');
        if (!nameProp) {
          throw new Error(
            `${rel}: an object with an executor has no 'name' property. It cannot be a ` +
              'TextCommandDefinition, so this test would skip it silently.',
          );
        }
        const value = literal(nameProp.initializer);
        if (value === null) {
          throw new Error(
            `${rel}: a command 'name' is not a string literal (line ${
              sf.getLineAndCharacterOfPosition(nameProp.getStart()).line + 1
            }). ` +
              'This test reads command names from source, so a computed name would be ' +
              'silently skipped. Make it a literal, or teach this test to evaluate it.',
          );
        }
        const aliasProp = propNamed('aliases');
        let aliases: string[] = [];
        if (aliasProp) {
          const init = aliasProp.initializer;
          if (ts.isArrayLiteralExpression(init)) {
            aliases = init.elements.map((el, i) => {
              const v = literal(el);
              if (v === null) {
                throw new Error(
                  `${rel}: alias[${i}] is not a string literal. Same loud-failure reason as above.`,
                );
              }
              return v;
            });
          } else if (init.kind !== ts.SyntaxKind.UndefinedKeyword) {
            throw new Error(`${rel}: 'aliases' is neither an array literal nor undefined.`);
          }
        }
        found.push({ name: value, aliases, file: rel });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
};

const collect = (subdir: string): CommandNames[] =>
  walk(join(ROOT, subdir)).flatMap((f) => extract(f, readFileSync(f, 'utf8')));

describe('text command registry invariants', () => {
  const commands = collect('textCommands');

  it('actually reads the command layer (guards against a vacuous pass)', () => {
    // If the extractor silently stopped matching, everything below would pass
    // for the wrong reason. AGENTS.md is explicit that a test which cannot fail
    // is a comment that runs.
    expect(commands.length).toBeGreaterThan(100);
    expect(new Set(commands.map((c) => c.file)).size).toBeGreaterThan(20);
  });

  it('no two text commands share a name', () => {
    const byName = new Map<string, CommandNames[]>();
    for (const c of commands) {
      const k = c.name.toLowerCase();
      byName.set(k, [...(byName.get(k) ?? []), c]);
    }
    const dupes = [...byName.entries()].filter(([, group]) => group.length > 1);
    expect(
      dupes.map(([name, group]) => `${name}: ${group.map((g) => g.file).join(' vs ')}`),
      'a later registration silently wins and the earlier command becomes unreachable',
    ).toEqual([]);
  });

  it('no name or alias contains a dot or whitespace', () => {
    // The prefix is added by the dispatcher, so a name carrying its own '.' or a
    // space can never be matched.
    const bad = commands
      .flatMap((c) => [c.name, ...c.aliases].map((n) => ({ n, file: c.file })))
      .filter(({ n }) => /[.\s]/.test(n));
    expect(bad.map((b) => `${b.file}: '${b.n}'`)).toEqual([]);
  });

  it('the two known alias overlaps are pinned, not drifting', () => {
    // `np` is an alias of TWO different commands: the Last.fm `fm` command and
    // the music `nowplaying` command. `rm` used to be the second case (fm vs
    // remove) until RateMyCommands took the canonical `rm` and both old aliases
    // were retired.
    //
    // Resolution is by registration order, not intent: names are registered in
    // pass 1, and pass 2 only fills names nobody claimed. PlayCommands is 3rd in
    // the module array and MusicCommands is far later, so PLAY COMMANDS claims
    // `np` first. That means `.np` currently answers as the Last.fm `fm`
    // command, not as now-playing.
    //
    // Pinned so the set cannot grow unnoticed. Resolving it is a behaviour
    // decision for the maintainer, not something a test should silently choose.
    const byAlias = new Map<string, CommandNames[]>();
    for (const c of commands) {
      for (const alias of c.aliases) {
        const k = alias.toLowerCase();
        byAlias.set(k, [...(byAlias.get(k) ?? []), c]);
      }
    }
    const overlaps = [...byAlias.entries()]
      .filter(([, group]) => new Set(group.map((x) => x.name.toLowerCase())).size > 1)
      .map(([alias, g]) => `${alias}: ${[...new Set(g.map((x) => x.name))].sort().join(' vs ')}`)
      .sort();
    expect(overlaps).toEqual(['np: fm vs nowplaying']);
  });

  it('alias-vs-name shadowing is exactly the known, accepted set', () => {
    // An alias that duplicates another command's NAME is not a bug: the registry
    // registers all names in pass 1 and only fills aliases in pass 2, so the name
    // always wins and the alias stays inert. That is a deliberate decision,
    // recorded in textCommands/index.ts.
    //
    // It is still a hazard: if the owning command is renamed, the dormant alias
    // silently activates and starts answering with different behaviour. So the
    // set is pinned exactly; a new entry must be consciously accepted.
    const names = new Set(commands.map((c) => c.name.toLowerCase()));
    const shadowed = commands
      .flatMap((c) => c.aliases.map((a) => ({ a: a.toLowerCase(), name: c.name })))
      .filter((x) => names.has(x.a))
      .map((x) => `${x.a} (alias of '${x.name}')`)
      .sort();
    expect(shadowed).toEqual([
      "history (alias of 'recent')",
      "nowplaying (alias of 'fm')",
      "prefix (alias of 'settings')",
    ]);
  });

  it('the historically-colliding names are owned by the right commands', () => {
    // Regression lock for the two real incidents. `.remove` and `.lyrics` were
    // both silently stolen at runtime; account unlink and Last.fm lyrics were
    // renamed to `.unlink` and `.lyric` to resolve it.
    const byName = new Map(commands.map((c) => [c.name.toLowerCase(), c.file]));
    expect(byName.get('remove')).toContain('music');
    expect(byName.get('nowplaying')).toContain('music');
    expect(byName.get('lyrics')).toContain('music');
    expect(byName.get('unlink')).toContain('lastfm');
    expect(byName.get('lyric')).toContain('lastfm');
  });
});

describe('slash command registry invariants', () => {
  const files = walk(join(ROOT, 'slashCommands'));
  const names = new Map<string, string>();

  it('no two top-level slash builders register the same command name', () => {
    // Only TOP-LEVEL commands are compared. `user`, `artist` and `album` are
    // legal subcommand names repeated across many parents, so a naive sweep of
    // every setName() reports 39 false duplicates. The discriminator is the
    // `new SlashCommandBuilder()` the chain is rooted in.
    const dupes: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const rel = relative(process.cwd(), file).replace(/\\/g, '/');

      const isSlashBuilderNew = (n: ts.Node): boolean =>
        ts.isNewExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'SlashCommandBuilder';

      const visit = (node: ts.Node): void => {
        if (isSlashBuilderNew(node)) {
          // Walk the fluent chain hanging off this constructor and take its name.
          let current: ts.Node = node;
          for (let guard = 0; guard < 50; guard++) {
            const parent = current.parent;
            if (
              !parent ||
              !ts.isPropertyAccessExpression(parent) ||
              !ts.isCallExpression(parent.parent) ||
              parent.parent.expression !== parent
            ) {
              break;
            }
            if (parent.name.text === 'setName' && parent.parent.arguments.length === 1) {
              const v = literal(parent.parent.arguments[0]);
              if (v !== null) {
                const k = v.toLowerCase();
                const previous = names.get(k);
                if (previous && previous !== rel) dupes.push(`${k}: ${previous} vs ${rel}`);
                else names.set(k, rel);
              }
              break;
            }
            current = parent.parent;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(dupes).toEqual([]);
  });

  it('found a plausible number of top-level slash registrations', () => {
    // 80 distinct names via the direct fluent chain, as walked by the
    // extractor immediately above this test (same walk, same literal() helper):
    // `new SlashCommandBuilder()` rooted chains, taking the single `setName()`
    // literal off each. Reproduce with a standalone AST walk over
    // `src/bot/slashCommands/**` and count the distinct lowercased names.
    //
    // This used to say 78. A whole feature was removed after the number was
    // written and nothing updated the comment, which is the condition this test
    // exists to catch - so the count below is a measurement with a stated
    // method, not a remembered figure. Re-derive it before changing it; if the
    // walk stops matching, this floor fails instead of the duplicate check above
    // passing vacuously.
    //
    // The true top-level count is AT LEAST this, since a builder assembled
    // through a helper rather than `new SlashCommandBuilder().setName(...)` is
    // not matched.
    expect(names.size).toBe(80);
    expect(names.size).toBeGreaterThan(60);
  });
});
