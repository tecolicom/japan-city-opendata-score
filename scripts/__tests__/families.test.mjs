import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { loadYaml } from '../_lib/lib.mjs';
import { loadFamilies, fingerprint } from '../fingerprint.mjs';

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
  assert.deepEqual([...f.measured_representatives].sort(),
    ['hanno', 'hidaka', 'iruma', 'moroyama-town']);
});

test('国外からの遮断は構造化フィールドで持ち、未観測と遮断なしを区別する', () => {
  assert.equal(typeof f.reachability.overseas_rest, 'string');
  assert.equal(f.reachability.overseas_rest, 'unknown');
  for (const v of ['unknown', 'not_blocked', 'blocked', 'partial']) {
    assert.ok(ok({ ...f, reachability: { overseas_rest: v } }), v);
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
  assert.equal(inc.started_at, '2026-10-21');
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
