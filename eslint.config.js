const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_|next' }] },
  },
  { files: ['public/js/**/*.js', 'src/plugins/*/public/**/*.js'], languageOptions: { sourceType: 'script', globals: { ...globals.browser } } },
  { ignores: ['node_modules/', 'public/js/htmx.min.js'] },
];
