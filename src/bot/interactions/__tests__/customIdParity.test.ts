import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { REPO_ROOT } from '../../../testSupport/repoRoot';

/**
 * A2: "no dead feature presents itself as working".
 *
 * A dead button is worse than a missing button: a user clicks it, nothing
 * visible happens, and nothing says the feature does not exist. This file is
 * the two-way match that stops that class of bug from coming back silently.
 *
 * WHY A TEXT TEST, AND THE TRAP THAT SHAPED IT. The condition is "does the id a
 * builder mints appear among the ids a handler matches", which is a property of
 * two files' text, not of a runtime path - minting an id needs a populated
 * ResponseModel, matching one needs a live gateway interaction.
 * `componentsV2Guard.test` in this directory established the pattern and
 * recorded the trap: a source invariant that finds nothing passes VACUOUSLY.
 * So the first two tests below assert the scan collected real ids, by name.
 * That guard earned its place - the first version of this file was WRONG in
 * three separate ways and every one of them showed up as a false failure here
 * rather than as a silent pass:
 *
 *   1. The emitted head was cut at the first `:`, so `friends:overview:0`
 *      collapsed to `friends:` and stopped matching `friends:overview`. It is
 *      cut at the first `${` instead, which is the only place a literal
 *      template actually becomes dynamic.
 *   2. The router regex demanded a literal `.` after `customId`, but the source
 *      is `interaction.customId.startsWith(` - no dot there at all. It matched
 *      ZERO of the 43 real prefixes and the test failed on that, not on a
 *      dead button.
 *   3. Modal FIELD ids (`size`, `options`, `font`, `page`, ...) were treated as
 *      routable. They are not buttons at all: they are read back through
 *      `interaction.fields.getTextInputValue('size')` on a submit the modal
 *      registry already routed. They are now identified by that read, not by a
 *      hard-coded list.
 *
 * THE TWO DIRECTIONS, because they fail differently.
 *   1. Emitted but unmatched   -> a DEAD BUTTON. The worst failure: visible,
 *      clickable, does nothing.
 *   2. Matched but never emitted -> a DEAD HANDLER. Invisible to users, but it
 *      is how the codebase lies about its own surface area, and it is exactly
 *      how four music handlers plus two settings aliases survived until this
 *      pass removed them. Both directions were real.
 *
 * WHY ROUTING IS READ FROM SOURCE, NOT ASSUMED. The project docs assert "there
 * is no dynamic dispatch in the bot". That claim is FALSE and it is load-bearing
 * here: `registerModalHandler` dispatches a modal submit by STRING PREFIX, so a
 * "no callers" proof that skipped the registry is wrong. This file reads the
 * router, the prefix constants it delegates to, and the modal registry, and
 * hard-codes nothing but the two ids that are routed by a fourth mechanism
 * (exact-key `ComponentInteractionTracker`) - each with its reason.
 */

/** This file lives in src/bot/interactions, so the repo root is THREE levels up. */
const REPO = REPO_ROOT;
const BUILDERS = path.join(REPO, 'src/bot/builders');
const INTERACTIONS = path.join(REPO, 'src/bot/interactions');
const ROUTER = path.join(REPO, 'src/bot/handlers/interactions/interactionHandler.ts');
const PAGINATOR = path.join(REPO, 'src/bot/services/system/componentPaginatorService.ts');

const listSources = (dir: string): string[] =>
  fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(dir, f));

const read = (file: string): string => fs.readFileSync(file, 'utf8');

/** Every production source whose text participates in the match. */
const allSources = (): string[] => [...listSources(BUILDERS), ...listSources(INTERACTIONS), ROUTER, PAGINATOR];

/**
 * The STATIC HEAD of every customId a builder can mint - the part before the
 * first interpolation, which is the longest literal a handler could ever match.
 *
 *   `album-tracks:${albumId}:${x}` -> `album-tracks:`
 *   `country:page:prev:top:${k}:${p}` -> `country:page:prev:top:`
 *   'user-crownpicker'                -> 'user-crownpicker'
 *
 * Cutting at the first `${` rather than the first `:` is the whole trick: a
 * `startsWith` handler can match mid-template, so the head has to be as long as
 * the literal actually is.
 */
const emittedHeads = (): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  for (const file of [...listSources(BUILDERS), ...listSources(INTERACTIONS)]) {
    const rel = path.basename(file);
    for (const m of read(file).matchAll(/setCustomId\(\s*(`[^`]*`|'[^']*')/g)) {
      const raw = m[1]!.slice(1, -1);
      const at = raw.indexOf('${');
      const head = at === -1 ? raw : raw.slice(0, at);
      if (head.length === 0) continue;
      const seen = found.get(head) ?? [];
      seen.push(rel);
      found.set(head, seen);
    }
  }
  return found;
};

/**
 * Every prefix a handler can match on, gathered from all three real dispatch
 * mechanisms.
 *
 * The dot in `customId.startsWith` is NOT there - the source reads
 * `interaction.customId.startsWith(` - so the alternation has to tolerate the
 * whitespace-and-call form, the `===` form, and the bare-literal form.
 */
const matchedPrefixes = (): Set<string> => {
  const out = new Set<string>();

  for (const m of read(ROUTER).matchAll(
    /customId\s*(?:\.\s*(?:startsWith|endsWith)\s*\(|===\s*)'([^']+)'/g,
  )) {
    out.add(m[1]!);
  }

  // The modal registry. `registerModalHandler('top-jump', ...)` takes a bare
  // LITERAL, which no `const X = '...'` scan can see - and dispatching by it is
  // the one mechanism the project docs wrongly claim does not exist. Missing
  // this is exactly how a "no callers" proof goes wrong.
  for (const file of [...listSources(INTERACTIONS), PAGINATOR]) {
    for (const m of read(file).matchAll(/registerModalHandler\(\s*'([^']+)'/g)) out.add(m[1]!);
  }

  // The router delegates several families to an exported array rather than a
  // literal (`ALBUM_BUTTON_PREFIXES.some(...)`). Those literals live in the
  // modules, so read them from there.
  const constFiles = [...listSources(INTERACTIONS), PAGINATOR];
  const templateBases = new Set<string>();
  for (const file of constFiles) {
    for (const m of read(file).matchAll(
      /(?:export\s+)?const\s+\w*(?:PREFIX|PREFIXES|MODAL_ID|MODAL_PREFIX)\w*\s*(?::[^=]+)?=\s*(\[[^\]]*\]|'[^']*')/g,
    )) {
      for (const lit of m[1]!.matchAll(/'([^']+)'/g)) out.add(lit[1]!);
      for (const lit of m[1]!.matchAll(/`\$\{(\w+)\}[^`]*`/g)) templateBases.add(lit[1]!);
    }
  }
  // A prefix array built as [`${SOME_INTERACTION_PREFIX}date:`, ...]: the base is
  // a separate scalar constant, resolved here rather than skipped.
  for (const file of constFiles) {
    for (const m of read(file).matchAll(
      /(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*'([^']+)'/g,
    )) {
      if (templateBases.has(m[1]!)) out.add(m[2]!);
    }
  }
  for (const base of templateBases) {
    for (const file of constFiles) {
      for (const m of read(file).matchAll(
        /`\$\{\w+\}([^`]*)`/g,
      )) {
        if (read(file).includes(`const ${base} =`)) out.add(m[1]!);
      }
    }
  }

  return out;
};

/**
 * Modal FIELD ids. These are not buttons and are not routed by customId: a
 * modal submit is already claimed by the modal registry, and these are read
 * back with `interaction.fields.getTextInputValue('size')`. Identifying them by
 * that READ - rather than by a hard-coded list - is what keeps a new modal
 * field from being reported as a dead button.
 */
const modalFieldIds = (): Set<string> => {
  const out = new Set<string>();
  for (const file of [...listSources(INTERACTIONS), PAGINATOR]) {
    for (const m of read(file).matchAll(/fields\.get\w+\(\s*'([^']+)'/g)) out.add(m[1]!);
  }
  return out;
};

describe('A2 customId two-way match — the scan is not vacuous', () => {
  it('reads the sources it claims to read', () => {
    expect(listSources(BUILDERS).length).toBeGreaterThan(20);
    expect(listSources(INTERACTIONS).length).toBeGreaterThan(20);
    expect(fs.existsSync(ROUTER)).toBe(true);
  });

  it('collected emitted ids, by name', () => {
    const heads = emittedHeads();
    // Named anchors on BOTH shapes: a head that ends at an interpolation and a
    // head that is a whole literal. A regex that stopped matching either shape
    // fails here instead of quietly shrinking the checked set.
    for (const anchor of [
      'album-tracks:',
      'country:page:prev:top:',
      'music:control:pause_resume',
      'user-crownpicker',
      'chart-edit:',
      'crowns-page:jump:',
    ]) {
      expect(heads.has(anchor), `scan missed emitted id ${anchor}`).toBe(true);
    }
    expect(heads.size).toBeGreaterThan(100);
  });

  it('collected matched prefixes, by name, from all three mechanisms', () => {
    const matched = matchedPrefixes();
    // router literal, delegated prefix array, and modal registry respectively.
    for (const anchor of [
      'taste-tab:',
      'album-info:',
      'fmmode:',
      'top-jump',
      'comp_page_jump',
      'settings-modal-prefix',
    ]) {
      expect(matched.has(anchor), `scan missed matched prefix ${anchor}`).toBe(true);
    }
    expect(matched.size).toBeGreaterThan(40);
  });

  it('identified the modal field ids, which are not routable', () => {
    const fields = modalFieldIds();
    for (const anchor of ['size', 'page', 'page_number']) {
      expect(fields.has(anchor), `scan missed modal field id ${anchor}`).toBe(true);
    }
  });
});

describe('A2 customId two-way match — no emitted id is unroutable', () => {
  /**
   * The only two ids routed by a mechanism this file does not model.
   * `ComponentInteractionTracker` is an exact-key Map, not a prefix table, so a
   * `startsWith` scan can never see it. Both are registered in the same way the
   * router's own fallback expects: `tracker.register(id, handler)`.
   */
  const ROUTED_BY_EXACT_KEY = new Set<string>(['tvb-pg:', 'login-confirm:']);

  it('finds the two exact-key ids, so the exemption above is not a blind pass', () => {
    // These two live OUTSIDE the two directories this test scans, which is
    // precisely why they need their own check: a reader cannot discover them
    // from the scan, so the exemption would otherwise be unfalsifiable.
    const exactKeySources = [
      path.join(REPO, 'src/bot/services/system/paginationService.ts'),
      path.join(REPO, 'src/bot/slashCommands/user/loginSlashCommands.ts'),
      path.join(REPO, 'src/bot/textCommands/lastfm/loginCommands.ts'),
    ];
    for (const file of exactKeySources) {
      expect(fs.existsSync(file), `missing ${path.relative(REPO, file)}`).toBe(true);
    }
    const text = exactKeySources.map(read).join('\n');
    // Each id must be both MINTED and REGISTERED, or the exemption is a lie.
    expect(text).toContain('setCustomId(`tvb-pg:');
    expect(text).toContain('tracker.register(');
    expect(text).toContain('setCustomId(`login-confirm:');
  });

  it('every emitted customId reaches a handler', () => {
    const heads = emittedHeads();
    const matched = matchedPrefixes();
    const fields = modalFieldIds();
    const unroutable: string[] = [];

    for (const [head, files] of heads) {
      if (ROUTED_BY_EXACT_KEY.has(head)) continue;
      if (fields.has(head)) continue;
      // A handler may match a SHORTER literal than the head carries: the id
      // `music:chapters:seek:0` is caught by `startsWith('music:')`. So the
      // test is a plain string prefix, which is exactly what the router does.
      if (![...matched].some((m) => head.startsWith(m))) {
        unroutable.push(`${head}   (emitted in ${[...new Set(files)].join(', ')})`);
      }
    }

    expect(
      unroutable,
      `emitted customId(s) with no matching handler — a DEAD BUTTON:\n${unroutable.join('\n')}`,
    ).toEqual([]);
  });
});

describe('A2 customId two-way match — the removed dead handlers stay removed', () => {
  /**
   * The four music ids and the two bare settings ids were handlers with NO
   * emitter anywhere in the repo - confirmed by a whole-repo grep across every
   * .ts/.js/.mjs/.json/.md, not just the builder directory. They were deleted
   * on 2026-09-29.
   *
   * This asserts the deletion did not half-happen, in BOTH directions, because
   * a half-measure is itself a bug: a handler re-added without its button is the
   * dead handler again, and a button re-added without its handler is a dead
   * button. Asserting only "the string is gone from handlers" would miss the
   * second case entirely.
   */
  const REMOVED = [
    'music:control:view_queue',
    'music:control:lyrics',
    'music:control:open_filters',
    'music:control:vol_down',
    'music:control:vol_up',
    'response-mode-pick',
    'cover-type-pick',
  ];

  const sources = allSources();

  for (const id of REMOVED) {
    it(`${id} appears in no production source`, () => {
      const hits = sources.filter((f) => read(f).includes(id)).map((f) => path.relative(REPO, f));
      expect(
        hits,
        `${id} is back in production source (${hits.join(', ')}); it had no emitter, so it is dead again`,
      ).toEqual([]);
    });
  }
});

describe('A2 customId two-way match — the settings alias removal did not open a hole', () => {
  it('user-settings: still claims every settings id the builders emit', () => {
    const handler = read(path.join(INTERACTIONS, 'user', 'userSettingsInteractions.ts'));
    const builder = read(path.join(INTERACTIONS, '..', 'builders', 'user', 'userSettingsBuilders.ts'));

    // Dropping the two bare aliases is only safe while the prefix keeps
    // claiming the real ids, so the two facts are asserted together.
    expect(handler).toContain('startsWith(USER_SETTINGS_PREFIX)');
    expect(handler).not.toContain('response-mode-pick');
    expect(handler).not.toContain('cover-type-pick');

    // Every settings id the builder mints must still be under that prefix.
    const emitted = [...builder.matchAll(/setCustomId\(\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(emitted.length).toBeGreaterThan(0);
    for (const id of emitted) {
      expect(id.startsWith('user-settings:'), `${id} is minted outside USER_SETTINGS_PREFIX`).toBe(true);
    }
  });
});
