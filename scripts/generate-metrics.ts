import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export interface Metrics {
  productionFiles: number;
  productionLines: number;
  slashCommands: number;
  textCommands: number;
  textTriggers: number;
  testFiles: number;
  repositories: number;
}

export interface TextCommandName {
  name: string;
  aliases: string[];
}

const walkFiles = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
};

export const isProductionFile = (file: string): boolean => {
  const norm = file.replace(/\\/g, '/');
  if (norm.includes('/__tests__/')) return false;
  if (norm.endsWith('.test.ts') || norm.endsWith('.spec.ts')) return false;
  if (norm.endsWith('.d.ts')) return false;
  return norm.endsWith('.ts');
};

export const collectProductionFiles = (srcRoot: string): string[] =>
  walkFiles(srcRoot).filter(isProductionFile);

export const sumLines = (files: string[]): number =>
  files.reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length, 0);

export const countTestFiles = (srcRoot: string): number =>
  walkFiles(srcRoot).filter((f) => f.endsWith('.test.ts')).length;

export const countRepositories = (srcRoot: string): number => {
  let entries: string[] = [];
  try {
    entries = readdirSync(join(srcRoot, 'persistence', 'repositories'));
  } catch {
    return 0;
  }
  return entries.filter((e) => e.endsWith('.ts') && !e.endsWith('.test.ts') && !e.endsWith('.d.ts')).length;
};

const literal = (node: ts.Node | undefined): string | null => {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
};

export const extractTextCommands = (searchDir: string): TextCommandName[] => {
  const out: TextCommandName[] = [];
  for (const file of walkFiles(searchDir).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const prop = (key: string): ts.PropertyAssignment | undefined =>
          node.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) &&
              ((ts.isIdentifier(p.name) && p.name.text === key) ||
                (ts.isStringLiteral(p.name) && p.name.text === key)),
          ) as ts.PropertyAssignment | undefined;
        const isCommand = !!prop('executeAsync') || !!prop('execute');
        const isDerived = node.properties.some((p) => ts.isSpreadAssignment(p));
        if (isCommand && !isDerived) {
          const nameProp = prop('name');
          const value = literal(nameProp?.initializer);
          if (value !== null) {
            let aliases: string[] = [];
            const aliasProp = prop('aliases');
            if (aliasProp && ts.isArrayLiteralExpression(aliasProp.initializer)) {
              aliases = aliasProp.initializer.elements.map((el) => literal(el) ?? '');
            }
            out.push({ name: value, aliases });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
};

export const extractSlashNames = (searchDir: string): string[] => {
  const names = new Set<string>();
  for (const file of walkFiles(searchDir).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const isBuilderNew = (n: ts.Node): boolean =>
      ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'SlashCommandBuilder';
    const visit = (node: ts.Node): void => {
      if (isBuilderNew(node)) {
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
            if (v !== null) names.add(v.toLowerCase());
            break;
          }
          current = parent.parent;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return [...names].sort();
};

export const collectMetrics = (repoRoot: string): Metrics => {
  const srcRoot = join(repoRoot, 'src');
  const prodFiles = collectProductionFiles(srcRoot);
  const text = extractTextCommands(join(srcRoot, 'bot', 'textCommands'));
  const slash = extractSlashNames(join(srcRoot, 'bot', 'slashCommands'));
  return {
    productionFiles: prodFiles.length,
    productionLines: sumLines(prodFiles),
    slashCommands: slash.length,
    textCommands: text.length,
    textTriggers: text.reduce((n, c) => n + 1 + c.aliases.length, 0),
    testFiles: countTestFiles(srcRoot),
    repositories: countRepositories(srcRoot),
  };
};

export const renderMetricsBlock = (m: Metrics): string =>
  [
    '| Metric | Count |',
    '|---|---|',
    `| Production files | ${m.productionFiles} |`,
    `| Production lines | ${m.productionLines} |`,
    `| Slash top-level commands | ${m.slashCommands} |`,
    `| Text commands | ${m.textCommands} |`,
    `| Text triggers + aliases | ${m.textTriggers} |`,
    `| Test files | ${m.testFiles} |`,
    `| Repositories | ${m.repositories} |`,
  ].join('\n');

export const renderMetricsDoc = (m: Metrics): string =>
  ['# Metrics', '', '<!-- metrics:start -->', renderMetricsBlock(m), '<!-- metrics:end -->', ''].join('\n');

const MARKER_RE = /(<!-- metrics:start -->)([\s\S]*?)(<!-- metrics:end -->)/g;

export const rewriteMarkers = (content: string, block: string): string =>
  content.replace(MARKER_RE, (_m, start: string, _old: string, end: string) => `${start}\n${block}\n${end}`);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.turbo']);

export const findMarkdownFiles = (repoRoot: string): string[] =>
  walkFiles(repoRoot).filter((f) => {
    const norm = f.replace(/\\/g, '/');
    if (!norm.endsWith('.md')) return false;
    if (norm.includes('/docs/archive/')) return false;
    return !norm.split('/').some((part) => SKIP_DIRS.has(part));
  });

const main = (): void => {
  const check = process.argv.includes('--check');
  const repoRoot = process.cwd();
  const metrics = collectMetrics(repoRoot);
  const block = renderMetricsBlock(metrics);
  const docPath = join(repoRoot, 'docs', 'METRICS.md');
  const expectedDoc = renderMetricsDoc(metrics);
  const mdFiles = findMarkdownFiles(repoRoot).filter((f) => f !== docPath);
  const drifts: string[] = [];
  if (check) {
    let expected = '';
    try {
      expected = readFileSync(docPath, 'utf8');
    } catch {
      drifts.push('docs/METRICS.md: missing');
    }
    if (expected !== '' && expected !== expectedDoc) drifts.push('docs/METRICS.md: drift');
    for (const file of mdFiles) {
      const original = readFileSync(file, 'utf8');
      if (!original.includes('<!-- metrics:start -->')) continue;
      if (rewriteMarkers(original, block) !== original) drifts.push(`${file}: marker drift`);
    }
    if (drifts.length > 0) {
      console.error(`metrics drift detected:\n  ${drifts.join('\n  ')}\nRun: npx tsx scripts/generate-metrics.ts`);
      process.exit(1);
    }
    console.log('metrics check ok');
    return;
  }
  writeFileSync(docPath, expectedDoc, 'utf8');
  for (const file of mdFiles) {
    const original = readFileSync(file, 'utf8');
    if (!original.includes('<!-- metrics:start -->')) continue;
    const next = rewriteMarkers(original, block);
    if (next !== original) writeFileSync(file, next, 'utf8');
  }
  console.log(block);
};

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/generate-metrics.ts')) main();
