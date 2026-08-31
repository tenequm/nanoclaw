import globals from 'globals'
import pluginJs from '@eslint/js'
import tseslint from 'typescript-eslint'
import noCatchAll from 'eslint-plugin-no-catch-all'

export default [
  { ignores: ['node_modules/', 'dist/', 'container/', 'groups/'] },
  { files: ['src/**/*.{js,ts}'] },
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // Upstream silences no-catch-all per file; with the rule off here those
    // directives would each report as unused. Keeping them untouched avoids
    // drift in files this fork does not otherwise modify.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
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
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  // telegram-grammy/ is an Effect-TS v4 island. Effects are not Promises, but
  // the `Effect.runPromise` / `Effect.runFork` boundary must be explicit, so
  // the promise rules are pinned to 'error' HERE as well as globally: failure
  // handling in the island lives in the typed E channel, and a dropped
  // Effect→Promise boundary is the one class of mistake the types can't catch.
  // Relaxing the global rules must not silently relax them for this folder.
  {
    files: ['src/channels/telegram-grammy/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
]
