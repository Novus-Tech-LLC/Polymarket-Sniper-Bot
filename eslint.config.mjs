import eslint from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import prettierPlugin from 'eslint-plugin-prettier';
import configPrettier from 'eslint-config-prettier';

export default [
  eslint.configs.recommended,
  configPrettier,
  {
    ignores: ['dist/**', 'node_modules/**', 'signer/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: false, sourceType: 'module' },
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin, prettier: prettierPlugin },
    rules: {
      'prettier/prettier': 'warn',
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  // Strict rules for auth files - no console.log allowed
  {
    files: [
      'src/clob/credential-derivation-v2.ts',
      'src/clob/auth-fallback.ts',
      'src/utils/clob-auth-headers.util.ts',
      'src/utils/l1-auth-headers.util.ts',
      'src/utils/auth-diagnostic.util.ts',
      'src/infrastructure/clob-client.factory.ts',
    ],
    rules: {
      'no-console': 'error', // Block console.log in auth files (use structured logger)
    },
  },
];

