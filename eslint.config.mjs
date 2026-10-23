// スクリプトの静的検査。目的は「未定義参照」を CI で落とすこと。
// スタイル規約は入れない。整形の好みで差分を増やすのが目的ではない。
// globals パッケージは足さず、使っている Node 組み込みだけを列挙する。
const nodeGlobals = Object.fromEntries([
  'process', 'console', 'Buffer', 'URL', 'URLSearchParams', 'TextDecoder', 'TextEncoder',
  'fetch', 'Response', 'Request', 'Headers', 'AbortController', 'structuredClone',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  '__dirname', '__filename', 'global', 'globalThis',
].map((k) => [k, 'readonly']));

export default [
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      // 本命。FY 未定義のような移行の取り残しを落とす
      'no-undef': 'error',
      // 使われなくなった定数も移行の取り残しの兆候なので拾う。
      // 引数は無視する (シグネチャを保つために残すことがある)。
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
];
