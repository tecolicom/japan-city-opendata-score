import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { loadYaml } from '../_lib/lib.mjs';
import { loadFamilies, fingerprint } from '../fingerprint.mjs';
import { familySemanticErrors, thresholdBasis } from '../_lib/family-check.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(loadYaml(join(root, 'schema', 'family.schema.json')));
const f = loadYaml(join(root, 'families', 'fam-feedphp-sitenew.yaml'));
const ok = (x) => validate(x) === true;
const without = (o, k) => Object.fromEntries(Object.entries(o).filter(([key]) => key !== k));

test('product が null でも family は妥当', () => {
  assert.equal(f.product, null);
  assert.ok(ok(f), JSON.stringify(validate.errors));
});

test('product null は特例でなく、製品名が判明した family も同じ schema で通る', () => {
  assert.ok(ok({ ...f, product: '製品X', aliases: ['製品X CMS'] }));
  assert.ok(!ok({ ...f, product: '' }), '空文字の製品名は不可 (null で表す)');
  assert.ok(!ok(without(f, 'product')), 'product は省略せず null と明示する');
});

test('仮 id (指紋由来) を許し、その他の形は許さない', () => {
  assert.ok(ok({ ...f, id: 'fam-abc' }));
  assert.ok(!ok({ ...f, id: 'FeedPHP' }));
  assert.ok(!ok({ ...f, id: 'feedphp-sitenew' }));
});

test('version を持つなら observed_at と evidence が必須', () => {
  assert.ok(!ok({ ...f, version: '1.2' }));
  assert.ok(!ok({ ...f, version: '1.2', observed_at: '2026-10-23' }));
  assert.ok(!ok({ ...f, version: '1.2', evidence: '応答ヘッダ X' }));
  assert.ok(!ok({ ...f, version: '1.2', observed_at: '2026-10-23', evidence: '' }));
  assert.ok(!ok({ ...f, version: '1.2', observed_at: '昨日', evidence: '根拠' }));
  assert.ok(ok({ ...f, version: '1.2', observed_at: '2026-10-23', evidence: '応答ヘッダ X' }));
});

test('既知 family は 4 自治体を代表実測として挙げる', () => {
  assert.deepEqual(f.measured_representatives.map((m) => m.handle).sort(),
    ['hanno', 'hidaka', 'iruma', 'moroyama-town']);
});

test('国外からの遮断は構造化フィールドで持ち、未観測と遮断なしを区別する', () => {
  assert.equal(typeof f.reachability.overseas_rest, 'string');
  assert.equal(f.reachability.overseas_rest, 'unknown');
  for (const v of ['unknown', 'not_blocked', 'blocked', 'partial']) {
    const extra = v === 'unknown' ? {} : { observed_from: 'overseas-ci', observed_at: '2026-10-23', notes: '一部のみ' };
    assert.ok(ok({ ...f, reachability: { overseas_rest: v, ...extra } }), v);
  }
  assert.ok(!ok({ ...f, reachability: { overseas_rest: null } }));
  assert.ok(!ok({ ...f, reachability: { overseas_rest: 'maybe' } }));
  assert.ok(!ok({ ...f, reachability: {} }));
});

test('signals は fingerprint が読める形で、実物から family を同定できる', () => {
  const [loaded] = loadFamilies(join(root, 'families'));
  assert.equal(loaded.id, 'fam-feedphp-sitenew');
  assert.equal(f.signals.length, 6);
  const html = f.signals.slice(0, 3).join('\n');
  assert.equal(fingerprint(html, {}).familyId, 'fam-feedphp-sitenew');
});

test('known_incidents: 因果が未確認のものは確認済みと書けない', () => {
  const inc = f.known_incidents[0];
  assert.equal(inc.start_window.handle, 'hanno');
  assert.equal(inc.cause_status, 'unconfirmed');
  assert.ok(ok({ ...f, known_incidents: [] }));
  assert.ok(!ok({ ...f, known_incidents: [{ ...inc, cause_status: 'confirmed' }] }),
    '確認済みなら根拠 (cause_evidence) が要る');
  assert.ok(ok({ ...f, known_incidents: [{ ...inc, cause_status: 'confirmed', cause_evidence: '公表文' }] }));
});

test('必須キー欠落・未知キー・signals 空を落とす', () => {
  for (const k of ['id', 'signals', 'sync_kind', 'reachability', 'measured_representatives']) {
    assert.ok(!ok(without(f, k)), k);
  }
  assert.ok(!ok({ ...f, bogus: 1 }));
  assert.ok(!ok({ ...f, signals: [] }));
  assert.ok(!ok({ ...f, sync_kind: 'whatever' }));
  assert.ok(!ok({ ...f, min_signals: 0 }));
});

const rep = f.measured_representatives[0];

test('代表実測は日付と根拠と確認した signal を持つ', () => {
  for (const k of ['observed_at', 'evidence', 'signals_seen']) {
    assert.ok(!ok({ ...f, measured_representatives: [without(rep, k)] }), k);
  }
  assert.ok(!ok({ ...f, measured_representatives: [{ ...rep, handle: 'x', evidence: '' }] }));
  assert.ok(!ok({ ...f, measured_representatives: ['hanno'] }), '裸の handle は不可');
});

test('moroyama-town は直接取得が 1 本で、弱い根拠であることが evidence に残る', () => {
  const m = f.measured_representatives.find((x) => x.handle === 'moroyama-town');
  assert.match(m.evidence, /502/);
  assert.match(m.evidence, /エンドポイントが存在する/);
});

test('signals_seen は signals の部分集合', () => {
  assert.deepEqual(familySemanticErrors(f), []);
  const bad = { ...f, measured_representatives: [{ ...rep, signals_seen: [{ signal: '/typo.js', method: 'html' }] }] };
  assert.equal(familySemanticErrors(bad).length, 1);
});

test('overseas_rest が unknown 以外なら observed_from と observed_at が必須、partial は notes も', () => {
  const r = (x) => ok({ ...f, reachability: x });
  assert.ok(!r({ overseas_rest: 'not_blocked' }));
  assert.ok(!r({ overseas_rest: 'not_blocked', observed_from: 'overseas-ci' }));
  assert.ok(!r({ overseas_rest: 'blocked', observed_at: '2026-10-23' }));
  assert.ok(r({ overseas_rest: 'not_blocked', observed_from: 'overseas-ci', observed_at: '2026-10-23' }));
  assert.ok(!r({ overseas_rest: 'partial', observed_from: 'jp', observed_at: '2026-10-23' }));
  assert.ok(r({ overseas_rest: 'partial', observed_from: 'jp', observed_at: '2026-10-23', notes: '画像のみ遮断' }));
  assert.ok(r({ overseas_rest: 'unknown' }));
});

test('障害の影響自治体と疑い要因は根拠・出典を持ち、不在の主張は範囲と日付を限定する', () => {
  const inc = f.known_incidents[0];
  assert.ok(inc.affected.every((a) => a.observed_at && a.evidence));
  assert.ok(!ok({ ...f, known_incidents: [{ ...inc, affected: ['hanno'] }] }));
  assert.ok(!ok({ ...f, known_incidents: [{ ...inc, suspected_factors: [{ summary: 'x' }] }] }), '出典なしは不可');
  const urls = inc.suspected_factors.flatMap((x) => x.sources.map((y) => y.url));
  assert.ok(urls.includes('https://github.com/php/php-src/security/advisories/GHSA-w8hw-w9fx-j79w'));
  assert.ok(urls.includes('https://github.com/php/php-src/security/advisories/GHSA-6wmf-4rv5-p3rp'));
  assert.ok(urls.includes('https://www.php.net/archive/2026.php#2026-10-21-5'));
  assert.equal(new Set(urls).size, urls.length, '出典 URL が使い回されていない');
  assert.equal(inc.cause_search.searched_at, '2026-10-23');
  assert.doesNotMatch(JSON.stringify(inc), /公表していない/);
});

test('signals_seen は method 必須で、観測と推定が機械的に区別できる', () => {
  const withSeen = (seen) => ok({ ...f, measured_representatives: [{ ...rep, signals_seen: seen }] });
  const sig = rep.signals_seen[0].signal;
  assert.ok(withSeen([{ signal: sig, method: 'html' }]));
  assert.ok(!withSeen([{ signal: sig }]), 'method なしは不可');
  assert.ok(!withSeen([{ signal: sig, method: 'guess' }]));
  assert.ok(!withSeen([sig]), '裸の文字列は不可');
  const by = Object.fromEntries(f.measured_representatives.map((m) => [m.handle, m]));
  assert.ok(by.hanno.signals_seen.every((x) => (x.signal === '/resource/js/foot_print.js' ? x.method === 'asset_fetch' : x.method === 'html')),
    'foot_print.js はトップ HTML に無く、JS を直接取得して確認した (asset_fetch)');
  assert.ok(by.iruma.signals_seen.every((x) => x.method === 'html'));
  assert.ok(by.hidaka.signals_seen.every((x) => x.method === 'html'));
  assert.deepEqual(by['moroyama-town'].signals_seen.filter((x) => x.method === 'inferred_from_status')
    .map((x) => x.signal), ['/cgi-bin/feed.php?siteNew=']);
});

test('推定だけで閾値を満たす実測は、観測で満たしたものより弱いと導出できる', () => {
  const basis = Object.fromEntries(f.measured_representatives.map((m) => [m.handle, thresholdBasis(f, m)]));
  assert.deepEqual(basis, { hanno: 'observed', iruma: 'observed', hidaka: 'observed', 'moroyama-town': 'inferred' });
  const one = { signals_seen: [{ signal: 'a', method: 'html' }] };
  assert.equal(thresholdBasis({ min_signals: 2 }, one), 'below');
});

test('障害の開始: 同時に始まったと書かず、窓は観測した自治体にだけ付く', () => {
  const inc = f.known_incidents[0];
  assert.ok(!('started_at' in inc));
  assert.equal(inc.affected.length, 4);
  const withWindow = inc.affected.filter((a) => a.start_window !== null).map((a) => a.handle);
  assert.deepEqual(withWindow, ['hanno']);
  assert.ok(Date.parse(inc.start_window.after) < Date.parse(inc.start_window.before));
  assert.doesNotMatch(inc.summary, /同時に発生/);
  assert.match(inc.summary, /開始が同時だったかは未観測/);
  assert.ok(!ok({ ...f, known_incidents: [without(inc, 'start_window')] }));
});
