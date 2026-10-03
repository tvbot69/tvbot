// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'src/persistence/prisma/migrations/'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      /**
       * The three options below are load-bearing, not leniency for its own sake.
       *
       * varsIgnorePattern: '^_'
       *   A leading underscore is the codebase's stated convention for "bound but
       *   intentionally unused". Without it, every discarded binding is an error
       *   and the convention has to be abandoned.
       *
       * ignoreRestSiblings: true
       *   `const { artworkUrl: _dropped, ...rest } = override` is the standard
       *   idiom for omitting a key via rest destructuring. The renamed binding
       *   is unused BY CONSTRUCTION - that is the entire point of the idiom.
       *
       * caughtErrors: 'none'
       *   `catch (err)` that never inspects err is normal and often required by
       *   the async shape. Flagging the binding would push people to write
       *   `catch {}` and lose the handle entirely.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
          caughtErrors: 'none',
        },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'warn',

      /**
       * An empty catch is a swallowed failure with no trace. A `warn` rather
       * than `error` because the existing ~178 are comment-only blocks, which
       * ESLint correctly treats as deliberate and which are mostly justified
       * degradation paths. The point is to stop NEW ones appearing silently.
       *
       * Measured 2026-09-27 across 589 catch clauses in production code:
       *   225 bind an error, and every one of them inspects it - zero silent
       *       bound-and-unused, which is better than the earlier review assumed
       *   364 bind nothing; of those only 2 log, the rest degrade quietly by
       *       design (a missing cover falls back, a failed lookup returns null)
       *
       * Do NOT "fix" these by logging everything. AGENTS.md golden rule 10 is
       * explicit that INFO-level noise hides the lines that matter; hundreds of
       * DEBUG lines on a normal request would drown exactly the greps in
       * AGENTS.md section 9. An expected outcome is DEBUG, a lost capability is
       * WARN, and most of these are neither - they are the designed fallback.
       */
      'no-empty': ['warn', { allowEmptyCatch: false }],
    },
  },

  /**
   * Architecture boundaries, enforced rather than described.
   *
   * Scoped deliberately. AGENTS.md section 9 rule 9 requires type-only imports
   * across music modules; a value import there closes a runtime cycle, and the
   * music DAG is where a chapter-position incident came from. So the music
   * subtree is where a ban earns its keep.
   *
   * NOT scoped repo-wide: `commandDispatcher`. It appears in one measured cycle
   * (userService), but that edge is `import type` and is erased at compile time.
   * Banning it would force churn on correct code for no safety gain. The real
   * constraint is the zero-runtime-cycle budget in scripts/check-import-cycles.ts.
   */
  {
    files: ['src/bot/services/music/**/*.ts', 'src/bot/handlers/music/musicHandler.ts'],
    // Test files legitimately import the module under test, and musicTypes is
    // the leaf that everything is allowed to depend on.
    ignores: [
      'src/bot/services/music/musicTypes.ts',
      'src/bot/services/music/**/*.test.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/musicService'],
              message:
                'Music modules must not import musicService: it is the composition root. Use type-only imports (AGENTS.md section 9 rule 9).',
            },
          ],
        },
      ],
    },
  },

/**
   * TYPE-AWARE GATE, scoped to the two music directories.
   *
   * Why here and not repo-wide: in a codebase where a dropped promise means
   * dead air — a stall where a fast skip was required — the un-awaited promise
   * is the single most expensive defect class, and the playback DAG is where
   * the incidents happened. But enabling `recommendedTypeChecked` globally
   * turns on ~40 type-aware rules over 83k lines and buries that one signal
   * in a flag flood, which is worse than not having it: a gate that cries wolf
   * gets muted, and then it catches nothing.
   *
   * Why `projectService` and not `recommendedTypeChecked` + `project`:
   *   - `projectService` supplies type information per file without switching
   *     the whole recommended set to type-checked, so exactly the two rules
   *     that matter here turn on and nothing else does. A scoped `files` block
   *     with `recommendedTypeChecked` would drag every type-aware rule along
   *     for every file matched by the glob, which is the flood again.
   *   - It needs no `include` list maintenance. `project: ['tsconfig.json']`
   *     would have to be re-pointed as soon as a second tsconfig exists, and a
   *     stale `project` fails closed with a parser crash rather than a rule
   *     result. `projectService` reads the nearest tsconfig for the file.
   *   - `tsconfig.json` already includes every `.ts` file under `src`, which
   *     covers both globs including their `__tests__/` folders, so there is no
   *     second tsconfig to author and nothing to keep in sync.
   *
   * Deliberately NOT scoped repo-wide: the rest of the codebase keeps the
   * untyped recommended set. Same reasoning as the `no-restricted-imports`
   * block above — where a rule earns its keep is a per-subtree judgement, not a
   * default.
   *
   * Measured 2026-10-02 (typescript-eslint 8.68, typescript 5.9.3) across the
   * two globs named in the `files` below (74 + 18 `.ts` files, tests included):
   *   no-floating-promises: 0 violations — clean, and the rule stays an error
   *   no-misused-promises:  9 violations across 3 files
   *
   * Cost of the gate, measured on the same commit: `npm run lint` goes from
   * 21.4s / 0 errors / 56 warnings to 29.4s / 0 errors / 65 warnings. The
   * +8s is the tsconfig program being built once for the scoped files; the +9
   * warnings are exactly the baseline below and nothing else.
   *
   * NB: a glob pattern cannot be written literally in this comment. Its trailing
   *     star-slash ends the block comment early and the whole config stops
   *     parsing, which is the one trap in this file. The `files` array below
   *     is the source of truth for what is scoped.
   *
   * BASELINE: those 9 are downgraded to `warn` in the block immediately below,
   * by explicit file. `no-misused-promises` is the expected shape here and none
   * of the nine is provably safe to "fix" without touching source:
   *   musicEventListeners.ts:102,106,109,113 — `manager.on(...)` handlers that
   *     RETURN their promise on purpose, so the suite can `await` a listener
   *     directly (stated at musicEventListeners.ts:98-101 and in
   *     src/bot/handlers/music/AGENTS.md). Wrapping them in `void` would break
   *     every test that drives them. Not a mechanical fix.
   *   moonlinkManager.ts:157 — `client.once('ready', async ...)`; the ready
   *     init has no caller to await it.
   *   moonlinkManager.ts:315 — `setTimeout(async ...)`, the reconnect arm.
   *   playlistChunkManager.ts:96,106,118 — `manager.on('trackEnd'/'trackStart'/
   *     'queueEnd', async ...)`. The `queueEnd` one is the silence guard
   *     (playlistChunkManager.ts:114-117): it exists BECAUSE nothing else will
   *     ever trigger the next fetch. Adding a catch changes which failures
   *     reach the logger.
   *
   * The honest reading of all nine: the emitter discards the promise, so a
   * rejection surfaces as an unhandled rejection rather than as silent dead
   * air. That is the milder half of the failure mode, and it is still a real
   * defect — but each fix changes runtime behaviour in a directory this repo
   * protects with incident-derived invariants, so it wants its own change, not
   * a lint side-effect. They are enumerated by file here rather than exempted
   * silently; a tenth violation anywhere in these two directories is an error.
   */
  {
    files: ['src/bot/services/music/**/*.ts', 'src/bot/handlers/music/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    /**
     * Baseline carve-out, listed file by file. See the block above for the
     * count (9, all `no-misused-promises`) and why each is not mechanical.
     * `no-floating-promises` is intentionally absent here: it is clean today.
     */
    files: [
      'src/bot/handlers/music/musicEventListeners.ts',
      'src/bot/services/music/moonlinkManager.ts',
      'src/bot/services/music/playlistChunkManager.ts',
    ],
    rules: {
      '@typescript-eslint/no-misused-promises': 'warn',
    },
  },

  /**
 * `scripts/` is linted, because it now contains code that runs against the
 * production database - a migration verifier that nobody ever lints is how a
 * bad assumption reaches production.
 *
 * `.cjs` files are CommonJS by extension, so forbidding `require` in them is a
 * false positive: 42 of the 46 errors were exactly that.
 */
{
  files: ['scripts/**/*.ts'],
  rules: {
    'no-console': 'off',
  },
},
{
  files: ['scripts/**/*.cjs', 'scripts/**/*.js'],
  rules: {
    '@typescript-eslint/no-require-imports': 'off',
  },
},
);