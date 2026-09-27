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
    },
  },
);
