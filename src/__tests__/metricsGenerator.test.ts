import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

// Mirrors scripts/generate-metrics.ts without importing it: tsconfig rootDir
// is src/, so a test importing from scripts/ breaks `tsc --noEmit` (TS6059).
const walkFiles = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
};

const isProductionFile = (file: string): boolean => {
  const norm = file.replace(/\\/g, '/');
  if (norm.includes('/__tests__/')) return false;
  if (norm.endsWith('.test.ts')) return false;
  if (norm.endsWith('.d.ts')) return false;
  return norm.endsWith('.ts');
};

const literal = (node: ts.Node | undefined): string | null => {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
};

const rewriteMarkers = (content: string, block: string): string =>
  content.replace(
    /(<!-- metrics:start -->)([\s\S]*?)(<!-- metrics:end -->)/g,
    (_m, start: string, _old: string, end: string) => `${start}\n${block}\n${end}`,
  );

let root = '';
let src = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metrics-'));
  src = join(root, 'src');
  mkdirSync(join(src, 'commands'), { recursive: true });
  mkdirSync(join(src, '__tests__'), { recursive: true });
  writeFileSync(join(src, 'keep.ts'), 'line1\nline2\nline3', 'utf8');
  writeFileSync(join(src, '__tests__', 'skip.ts'), 'a\nb\nc\nd\ne', 'utf8');
  writeFileSync(join(src, 'skip.test.ts'), 't1\nt2', 'utf8');
  writeFileSync(
    join(src, 'commands', 'slash.ts'),
    "import { SlashCommandBuilder } from 'discord.js';\nexport const data = new SlashCommandBuilder().setName('Ping');\n",
    'utf8',
  );
  writeFileSync(
    join(src, 'commands', 'text.ts'),
    'export const cmd = { name: "foo", aliases: ["f"], executeAsync: async () => {} };\n',
    'utf8',
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('metrics generator fixture', () => {
  it('counts production files and lines with known values', () => {
    const prod = walkFiles(src).filter(isProductionFile);
    expect(prod.length).toBe(3);
    const keep = prod.filter((f) => f.endsWith('keep.ts'));
    expect(keep.length).toBe(1);
    expect(readFileSync(keep[0] as string, 'utf8').split('\n').length).toBe(3);
    expect(walkFiles(src).filter((f) => f.endsWith('.test.ts')).length).toBe(1);
  });

  it('extracts slash and text names via AST with known values', () => {
    const slashText = readFileSync(join(src, 'commands', 'slash.ts'), 'utf8');
    const slashSf = ts.createSourceFile('slash.ts', slashText, ts.ScriptTarget.Latest, true);
    const slashNames: string[] = [];
    const visitSlash = (node: ts.Node): void => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'SlashCommandBuilder'
      ) {
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
            if (v !== null) slashNames.push(v.toLowerCase());
            break;
          }
          current = parent.parent;
        }
      }
      ts.forEachChild(node, visitSlash);
    };
    visitSlash(slashSf);
    expect(slashNames).toEqual(['ping']);
    const textSrc = readFileSync(join(src, 'commands', 'text.ts'), 'utf8');
    const textSf = ts.createSourceFile('text.ts', textSrc, ts.ScriptTarget.Latest, true);
    let triggers = 0;
    const visitText = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const hasExecutor = node.properties.some(
          (p) =>
            ts.isPropertyAssignment(p) &&
            ((ts.isIdentifier(p.name) && (p.name.text === 'execute' || p.name.text === 'executeAsync')) ||
              (ts.isStringLiteral(p.name) && (p.name.text === 'execute' || p.name.text === 'executeAsync'))),
        );
        if (hasExecutor) triggers += 1;
      }
      ts.forEachChild(node, visitText);
    };
    visitText(textSf);
    expect(triggers).toBe(1);
  });

  it('marker rewriter is idempotent', () => {
    const block = '| Metric | Count |';
    const input = 'head\n<!-- metrics:start -->\nold\n<!-- metrics:end -->\nfoot';
    const once = rewriteMarkers(input, block);
    expect(once).toContain(block);
    expect(rewriteMarkers(once, block)).toBe(once);
  });
});
