import globals from 'globals'
import pluginJs from '@eslint/js'
import tseslint from 'typescript-eslint'
import noCatchAll from 'eslint-plugin-no-catch-all'

export default [
  { ignores: ['node_modules/', 'dist/', 'container/', 'groups/'] },
  { files: ['src/**/*.{js,ts}'] },
  { languageOptions: { globals: globals.node } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'no-catch-all': noCatchAll },
    rules: {
      'preserve-caught-error': ['error', { requireCatchParameter: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Disabled: NanoClaw is a long-running daemon with many I/O boundaries
      // (poll loops, adapter lifecycle, best-effort fs ops, retry-on-anything,
      // lookup-with-default). Catch-all + log-and-continue is the correct
      // pattern in nearly every site; narrowing + rethrowing would crash the
      // host on unknown errors instead of degrading gracefully. Real bugs
      // surface in logs/nanoclaw.error.log, not as lint warnings.
      'no-catch-all/no-catch-all': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // telegram-grammy/ is an Effect-TS v4 island. Stricter promise rules so
  // agents can't silently drop failure paths. Effects are not Promises, but
  // the `Effect.runPromise` / `Effect.runFork` boundary must be explicit.
  // no-floating-promises / no-misused-promises need type-aware linting;
  // projectService: true scopes it to this folder only.
  {
    files: ['src/channels/telegram-grammy/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Catch dropped Effect→Promise boundary mistakes. These are the real
      // safety rules in an Effect-TS island — failure handling lives in the
      // typed E channel, so the lint job here is just to make sure no Promise
      // escapes that boundary unhandled.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
]
