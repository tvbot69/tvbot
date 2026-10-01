import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SRC_ROOT } from '../testSupport/repoRoot';
import { HelpBuilders } from '@bot/builders/helpBuilders';

/**
 * /help is the bot's credibility. Every name it advertises must actually
 * resolve, otherwise a guest types what the bot told them to type and gets
 * complete silence (the text dispatcher returns without a word on an unknown
 * command). This walks the real registry rather than a hand-kept list.
 */
const TEXT_COMMAND_ROOT = path.join(SRC_ROOT, 'bot', 'textCommands');

const collectRegisteredNames = (): Set<string> => {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name === 'index.ts') continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/name:\s*'([a-zA-Z0-9_]+)'/g)) names.add(m[1]!.toLowerCase());
      for (const m of src.matchAll(/aliases:\s*\[([^\]]*)\]/g)) {
        for (const a of m[1]!.matchAll(/'([a-zA-Z0-9_]+)'/g)) names.add(a[1]!.toLowerCase());
      }
    }
  };
  walk(TEXT_COMMAND_ROOT);
  return names;
};

describe('/help only advertises commands that exist', () => {
  const registered = collectRegisteredNames();

  const advertisedNames = (): string[] => {
    // The help copy is built from `${prefix}name` fragments across every page.
    const src = fs.readFileSync(path.join(SRC_ROOT, 'bot', 'builders', 'helpBuilders.ts'), 'utf8');
    const found = new Set<string>();
    for (const m of src.matchAll(/\$\{prefix\}([a-zA-Z0-9_]+)/g)) found.add(m[1]!.toLowerCase());
    return [...found].sort();
  };

  it('registers a large enough surface for the check to be meaningful', () => {
    expect(registered.size).toBeGreaterThan(100);
  });

  it('every advertised command resolves in the registry', () => {
    const missing = advertisedNames().filter((name) => !registered.has(name));
    expect(missing, `advertised but not registered: ${missing.join(', ')}`).toEqual([]);
  });

  it('builds every help page without throwing', () => {
    // One entry per `case` in buildHelpResponse's page switch.
    const pages = ['home', 'stats', 'charts', 'top', 'whoknows', 'music', 'social', 'settings'] as const;
    for (const page of pages) {
      const res = HelpBuilders.buildHelpResponse(page, '.', '123', 0x00ff00);
      expect(() => res.buildEmbed(), page).not.toThrow();
      // Every page must carry actual copy, not an empty embed.
      expect(res.embed.data.description, page).toBeTruthy();
    }
  });

  it('resolves every advertised category to a real page', () => {
    const categories = [
      'home', 'main', 'overview', 'stats', 'fm', 'charts', 'c', 'top', 'tar', 'tab', 'tt',
      'whoknows', 'wk', 'wka', 'wkt', 'crown', 'server', 'music', 'lavalink', 'social',
      'friends', 'games', 'genre', 'settings', 'setting', 'admin', 'login', 'import',
    ];
    for (const category of categories) {
      const res = HelpBuilders.buildHelpResponse(HelpBuilders.normalizeCategory(category), '.', '1', 0);
      expect(res.embed.data.description, category).toBeTruthy();
    }
  });
});
