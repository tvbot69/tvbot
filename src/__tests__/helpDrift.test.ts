import 'reflect-metadata';
import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { SRC_ROOT, REPO_ROOT } from '../testSupport/repoRoot';
import { configureContainer } from '@bot/startup';
import { getTextCommand } from '@bot/textCommands';
import { getSlashCommand } from '@bot/slashCommands';
import { HelpBuilders, type HelpCategory } from '@bot/builders/meta/helpBuilders';

/**
 * Help drift: HelpBuilders.buildHelpResponse is hardcoded strings while the
 * registries are code, so the two drift silently. Every `.name` token in the
 * rendered help must resolve via getTextCommand and every `/name` via
 * getSlashCommand, otherwise a guest types what the bot told them to type and
 * gets silence.
 *
 * Existence alone does not catch the two known lies, because both resolve to
 * the wrong owner: `.np` resolves to Last.fm `fm` (not music `nowplaying`),
 * and bare `.search` resolves to music search (not `librarysearch`). Those get
 * targeted pins below, so the old copy fails and the fixed copy passes.
 */

const HELP_PAGES: HelpCategory[] = [
  'home',
  'stats',
  'charts',
  'top',
  'whoknows',
  'music',
  'social',
  'settings',
];

// No known exceptions: every dot/slash token in the current copy resolves, so
// any new unresolvable token is drift. Keep under 5 entries.
const TEXT_ALLOWLIST: Record<string, string> = {};
const SLASH_ALLOWLIST: Record<string, string> = {};

// Recursive walk with readdirSync. Explicit recursion (not { recursive: true })
// so a non-recursive read cannot pass vacuously; see commandRegistryInvariants.
const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
};

const collectHelpText = (page: HelpCategory): string => {
  const res = HelpBuilders.buildHelpResponse(page, '.', '123', 0x00ff00);
  const desc = res.embed.data.description ?? '';
  const fields = (res.embed.data.fields ?? []).map((f) => `${f.name}\n${f.value}`).join('\n');
  return `${desc}\n${fields}`;
};

// Dot token preceded by start/whitespace/backtick, so discord.gg and e.g. never match.
const DOT_RE = /(^|[\s`'"({\[])\.([A-Za-z][A-Za-z0-9_]*)/g;
// Slash token with a letter immediately after, so https:// and `w / weekly` never match.
const SLASH_RE = /(^|[\s`'"({\[])\/([A-Za-z][A-Za-z0-9_]*)/g;
// Markdown bullet alternatives: **`.fm`** or **`.np`**.
const OR_PAIR_RE = /`\.([A-Za-z0-9_]+)`\*\*\s+or\s+\*\*`\.([A-Za-z0-9_]+)`/g;

const extractTokens = (text: string, re: RegExp): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const tok = m[2]?.toLowerCase();
    if (tok) out.push(tok);
  }
  return out;
};

const pageText = new Map<HelpCategory, string>();

beforeAll(() => {
  configureContainer();
  for (const page of HELP_PAGES) pageText.set(page, collectHelpText(page));
});

describe('helpDrift', () => {
  it('actually walks the source tree (guards against a vacuous pass)', () => {
    const textFiles = walk(join(SRC_ROOT, 'bot', 'textCommands'));
    const slashFiles = walk(join(SRC_ROOT, 'bot', 'slashCommands'));
    const buildersFile = join(REPO_ROOT, 'src', 'bot', 'builders', 'meta', 'helpBuilders.ts');
    expect(textFiles.length).toBeGreaterThan(20);
    expect(slashFiles.length).toBeGreaterThan(20);
    expect(walk(SRC_ROOT).length).toBeGreaterThan(300);
    expect(statSync(buildersFile).isFile()).toBe(true);
    expect(Object.keys(TEXT_ALLOWLIST).length).toBeLessThan(5);
    expect(Object.keys(SLASH_ALLOWLIST).length).toBeLessThan(5);
  });

  it('every `.name` token in help text resolves via getTextCommand', () => {
    const missing: string[] = [];
    let total = 0;
    for (const page of HELP_PAGES) {
      const tokens = [...new Set(extractTokens(pageText.get(page) ?? '', DOT_RE))].sort();
      total += tokens.length;
      for (const tok of tokens) {
        if (tok in TEXT_ALLOWLIST) continue;
        if (!getTextCommand(tok)) missing.push(`${page}: .${tok}`);
      }
    }
    expect(total).toBeGreaterThan(50);
    expect(missing, `advertised but not in text registry: ${missing.join(', ')}`).toEqual([]);
  });

  it('every `/name` token in help text resolves via getSlashCommand', () => {
    const missing: string[] = [];
    let total = 0;
    for (const page of HELP_PAGES) {
      const tokens = [...new Set(extractTokens(pageText.get(page) ?? '', SLASH_RE))].sort();
      // Lowercase for the lookup; slash registry keys are lowercased.
      const lowered = tokens.map((t) => t.toLowerCase());
      total += lowered.length;
      for (const tok of lowered) {
        if (tok in SLASH_ALLOWLIST) continue;
        if (!getSlashCommand(tok)) missing.push(`${page}: /${tok}`);
      }
    }
    expect(total).toBeGreaterThanOrEqual(1);
    expect(missing, `advertised but not in slash registry: ${missing.join(', ')}`).toEqual([]);
  });

  it('music help keeps .nowplaying and drops .np (old lie: .np is Last.fm fm)', () => {
    const tokens = new Set(extractTokens(pageText.get('music') ?? '', DOT_RE));
    expect([...tokens]).toContain('nowplaying');
    expect([...tokens], 'music .np resolves to fm, not to music nowplaying').not.toContain('np');
  });

  it('stats library line advertises .librarysearch, not bare .search (old lie: .search is music search)', () => {
    const tokens = new Set(extractTokens(pageText.get('stats') ?? '', DOT_RE));
    expect([...tokens]).toContain('fm');
    expect([...tokens]).toContain('np');
    expect([...tokens]).toContain('librarysearch');
    expect([...tokens], 'bare .search resolves to music search, not librarysearch').not.toContain('search');
  });

  it('no doubled X-or-X advertising (old copy listed the same name twice)', () => {
    const dupes: string[] = [];
    let pairs = 0;
    for (const page of HELP_PAGES) {
      const text = pageText.get(page) ?? '';
      for (const m of text.matchAll(OR_PAIR_RE)) {
        const a = m[1]?.toLowerCase() ?? '';
        const b = m[2]?.toLowerCase() ?? '';
        if (!a || !b) continue;
        pairs += 1;
        if (a === b) dupes.push(`${page}: .${a} or .${b}`);
      }
    }
    expect(pairs).toBeGreaterThan(10);
    expect(dupes, `doubled alternatives: ${dupes.join(', ')}`).toEqual([]);
  });
});
