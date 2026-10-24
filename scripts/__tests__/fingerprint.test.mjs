// 指紋判定のテスト。判定規則は family ファイルが持つので、テストも fixture の family を読む。
// 実物の families/ は Task 6 が作る (ledger の Ruling 1)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, loadFamilies, DEFAULT_MIN_SIGNALS } from '../fingerprint.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const familiesDir = join(here, '..', '_lib', '__fixtures__', 'families');

// 自前で書いた最小の擬似 HTML。実在サイトの本文ではない (Global Constraints)。
// 指紋として拾わせたい痕跡 (パス・テンプレート文言) だけを置いている。
const FIXTURE_FEEDPHP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>擬似トップページ</title>
<link rel="alternate" type="application/rss+xml" href="/cgi-bin/feed.php?siteNew=1&amp;displayCount=10">
<script src="/resource/js/foot_print.js"></script>
</head>
<body>
<!-- CMS編集領域ここから -->
<p>擬似本文。</p>
</body>
</html>
`;

// 指紋 1 本だけが当たる擬似 HTML (閾値の検証用)。
const FIXTURE_ONE_SIGNAL_HTML = '<html><head><script src="/resource/js/foot_print.js"></script></head><body></body></html>';

const tmpFamilies = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'jpdi-fam-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
};

test('既知 family の指紋を判定する', () => {
  const r = fingerprint(FIXTURE_FEEDPHP_HTML, {}, { familiesDir });
  assert.equal(r.familyId, 'fam-feedphp-sitenew');
  assert.ok(r.signals.includes('/cgi-bin/feed.php?siteNew='), JSON.stringify(r.signals));
  assert.ok(r.signals.includes('<!-- CMS編集領域ここから -->'));
});

test('指紋が一つも当たらなければ familyId は null', () => {
  const r = fingerprint('<html></html>', {}, { familiesDir });
  assert.equal(r.familyId, null);
  assert.deepEqual(r.signals, []);
});

test('families が無い状態 (既定ディレクトリ未作成) でも落ちずに null を返す', () => {
  const r = fingerprint(FIXTURE_FEEDPHP_HTML, {}, { familiesDir: join(tmpdir(), 'jpdi-no-such-dir-xyz') });
  assert.equal(r.familyId, null);
  assert.deepEqual(r.signals, []);
});

test('一致が閾値に届かなければ familyId は null (痕跡は返す)', () => {
  const r = fingerprint(FIXTURE_ONE_SIGNAL_HTML, {}, { familiesDir });
  assert.deepEqual(r.signals, ['/resource/js/foot_print.js']);
  assert.equal(r.familyId, null);
});

test('閾値は family ファイルの min_signals から読む (コードに埋めない)', () => {
  const dir = tmpFamilies({
    'fam-loose.yaml': 'id: fam-loose\nmin_signals: 1\nsignals:\n  - /resource/js/foot_print.js\n',
  });
  assert.equal(fingerprint(FIXTURE_ONE_SIGNAL_HTML, {}, { familiesDir: dir }).familyId, 'fam-loose');
});

test('min_signals が無い family には既定の閾値を当てる', () => {
  assert.ok(DEFAULT_MIN_SIGNALS >= 1);
  const dir = tmpFamilies({
    'fam-nothreshold.yaml': 'id: fam-nothreshold\nsignals:\n  - /resource/js/foot_print.js\n  - /index.update.json\n',
  });
  assert.equal(fingerprint(FIXTURE_ONE_SIGNAL_HTML, {}, { familiesDir: dir }).familyId, null);
  const two = '<html><script src="/resource/js/foot_print.js"></script><a href="/index.update.json">x</a></html>';
  assert.equal(fingerprint(two, {}, { familiesDir: dir }).familyId, 'fam-nothreshold');
});

test('当て馬の family に吸われない', () => {
  const r = fingerprint(FIXTURE_FEEDPHP_HTML, {}, { familiesDir });
  assert.equal(r.familyId, 'fam-feedphp-sitenew');
  assert.ok(!r.signals.includes('/decoy/alpha.js'));
});

test('同数で並んだら familyId は null (どちらとも言わない)', () => {
  const dir = tmpFamilies({
    'fam-a.yaml': 'id: fam-a\nmin_signals: 1\nsignals:\n  - /shared/one.js\n',
    'fam-b.yaml': 'id: fam-b\nmin_signals: 1\nsignals:\n  - /shared/one.js\n',
  });
  const r = fingerprint('<html><script src="/shared/one.js"></script></html>', {}, { familiesDir: dir });
  assert.equal(r.familyId, null);
  assert.deepEqual(r.signals, ['/shared/one.js']);
});

test('応答ヘッダも指紋の対象にする', () => {
  const dir = tmpFamilies({
    'fam-hdr.yaml': 'id: fam-hdr\nmin_signals: 1\nsignals:\n  - "x-powered-by: PHP/8"\n',
  });
  const r = fingerprint('<html></html>', { 'X-Powered-By': 'PHP/8.3.1' }, { familiesDir: dir });
  assert.equal(r.familyId, 'fam-hdr');
});

// Ruling K: readdirSync はドットファイルも返す。macOS の .DS_Store で偽の失敗を出さない。
test('families ディレクトリのドットファイルと非 YAML を無視する', () => {
  const dir = tmpFamilies({
    '.DS_Store': '\u0000\u0001 これは YAML ではない',
    '.fam-hidden.yaml': 'id: fam-hidden\nmin_signals: 1\nsignals:\n  - /resource/js/foot_print.js\n',
    'README.md': '# これは family ではない',
    'fam-real.yaml': 'id: fam-real\nmin_signals: 1\nsignals:\n  - /resource/js/foot_print.js\n',
  });
  assert.deepEqual(loadFamilies(dir).map((f) => f.id), ['fam-real']);
  assert.equal(fingerprint(FIXTURE_ONE_SIGNAL_HTML, {}, { familiesDir: dir }).familyId, 'fam-real');
});

test('fingerprint はネットワークに出ない (html と headers だけで判定する)', () => {
  // 引数以外の入力を持たないことを、取得層を一切渡さずに判定が成立することで示す。
  assert.equal(fingerprint(FIXTURE_FEEDPHP_HTML, {}, { familiesDir }).familyId, 'fam-feedphp-sitenew');
  assert.equal(typeof fingerprint('', {}, { familiesDir }), 'object');
});
