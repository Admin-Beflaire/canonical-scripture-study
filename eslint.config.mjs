import js from '@eslint/js';
import {defineConfig, globalIgnores} from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist/', 'node_modules/', '.wrangler/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {globals: {...globals.node}},
    rules: {
      // Size and complexity limits: a function over either limit probably does
      // more than one job. The Python limits in ruff.toml use the same values.
      complexity: ['error', 15],
      'max-lines-per-function': [
        'error',
        {max: 80, skipBlankLines: true, skipComments: true},
      ],
    },
  },
);
