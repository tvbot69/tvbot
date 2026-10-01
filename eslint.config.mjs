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