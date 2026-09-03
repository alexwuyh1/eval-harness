import parser from '@typescript-eslint/parser';

export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      complexity: [2, 15],
    },
  },
];
