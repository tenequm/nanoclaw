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
      'no-catch-all/no-catch-all': 'warn',
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
      // safety rules in an Effect-TS island.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // no-catch-all stays at global-default (warn). Effect-TS enforces
      // failure handling via the typed E channel; try/catch at the
      // Effect→Promise boundary is idiomatic and intentionally swallows
      // (e.g. bot.stop() when bot never started).
    },
  },
]
