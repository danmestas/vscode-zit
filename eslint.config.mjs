import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import prettier from 'eslint-plugin-prettier';
import tseslint from 'typescript-eslint';

export default defineConfig(
    {
        ignores: [
            'node_modules/',
            'out/',
            'coverage/',
            'resources/',
            '.vscode/',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.ts'],
        plugins: {
            prettier,
        },
        rules: {
            'prettier/prettier': 'error',
            'no-irregular-whitespace': [
                'error',
                {
                    skipTemplates: true,
                },
            ],
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    varsIgnorePattern: '^_|^toString$',
                    argsIgnorePattern: '^_',
                },
            ],
            'no-cond-assign': 'error',
            'no-constant-condition': 'off',
            'no-inner-declarations': 'error',
            'no-prototype-builtins': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/no-empty-object-type': 'off',
        },
    },
    {
        files: ['src/test/suite/index.ts'],
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
);
