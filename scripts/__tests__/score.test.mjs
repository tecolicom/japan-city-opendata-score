import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProfile, score, aggregate, loadProfile } from '../score.mjs';

// 実物の schema/profiles/dynamic.yaml は Task 10 が作る。ここは形だけの inline fixture で、
// 点数に意味は無い (段差をコードにもテストにも埋め込まないための検証用)。
const FIXTURE_PROFILE = {
  profile: 'fixture',
  revision: 'fx1',
  axes: {
    A: [{ when: { reach: 'ok' }, points: 20 }, { when: { reach: 'blocked' }, points: 5 }],
    F: [{ when: { conditional_get: 'both' }, points: 20 }, { when: { conditional_get: 'none' }, points: 0 }],
  },
};
const FULL = { A: 20, B: 25, C: 20, D: 20, E: 15 };
const meas = (axes, extra = {}) => ({
  axes,
  provenance: Object.fromEntries(Object.keys(axes).map((k) => [k, axes[k] === null ? 'unknown' : 'measured'])),
  ...extra,
});

test('total はコア 5 軸のみの合計で、F/G を含まない', () => {
  const s = score(meas({ ...FULL, F: 10, G: 8 }));
  assert.equal(s.core.total, 100);
  assert.equal(s.core.rank, 'S');
  assert.deepEqual(s.dynamic, { F: 10, G: 8 });
  assert.deepEqual(s.core.A, 20);
});

test('ランク閾値は 90/75/60/40/20 で切れる', () => {
  const at = (total) => score(meas({ A: total, B: 0, C: 0, D: 0, E: 0 })).core.rank;
  // A は最大 20 なので、複数軸に振って合計を作る
  const mk = (t) => { const a = { A: 0, B: 0, C: 0, D: 0, E: 0 }; let r = t; for (const [k, m] of [['B', 25], ['A', 20], ['C', 20], ['D', 20], ['E', 15]]) { a[k] = Math.min(m, r); r -= a[k]; } return score(meas(a)).core.rank; };
  assert.equal(at(0), 'E');
  const exp = { 100: 'S', 90: 'S', 89: 'A', 75: 'A', 74: 'B', 60: 'B', 59: 'C', 40: 'C', 39: 'D', 20: 'D', 19: 'E', 0: 'E' };
  for (const [t, r] of Object.entries(exp)) assert.equal(mk(Number(t)), r, `${t} 点`);
});

test('1 軸でも unknown なら total / rank は null で、部分和を出さない', () => {
  const s = score(meas({ A: null, B: 25, C: 20, D: 20, E: 15 }));
  assert.equal(s.core.total, null);
  assert.equal(s.core.rank, null);
  assert.equal(s.core.A, null);
  assert.ok(s.estimated.includes('A'));
  assert.notEqual(s.core.total, 0);
});

test('追加軸が unknown でもコア合計は出る (F/G は合計に入らない)', () => {
  const s = score(meas({ ...FULL, F: null, G: null }));
  assert.equal(s.core.total, 100);
  assert.deepEqual(s.dynamic, { F: null, G: null });
});

test('estimated は推定・未調査の軸を列挙し、measured / inherited は含めない', () => {
  const s = score({ axes: { ...FULL }, provenance: { A: 'inherited', B: 'measured', C: 'estimated', D: 'measured', E: 'measured' } });
  assert.equal(s.estimated, 'C');
  assert.equal(s.core.total, 100, 'inherited / estimated でも値があれば合計は出る');
});

test('score は不整合な入力を黙って通さない', () => {
  assert.throws(() => score({ axes: { ...FULL }, provenance: { ...meas(FULL).provenance, A: 'unknown' } }), /unknown/, 'unknown なのに点数');
  assert.throws(() => score({ axes: { ...FULL }, provenance: { A: 'measured' } }), /provenance/, '点数があるのに由来が無い');
  assert.throws(() => score(meas({ ...FULL, A: 21 })), /範囲/, '配点を超える');
  assert.throws(() => score({ facts: { reach: 'ok' }, provenance: {} }), /applyProfile/, 'facts があるのに axes 未生成');
});

test('axes も facts も無い行は、全軸 unknown (値なし) として扱う', () => {
  const s = score({});
  assert.equal(s.core.total, null);
  assert.equal(s.core.A, null);
  assert.equal(s.estimated, 'A,B,C,D,E');
});

test('集計には measured のみを含め、母数を返す', () => {
  const measuredPub = meas({ ...FULL });
  const inheritedPub = { axes: { ...FULL }, provenance: { ...meas(FULL).provenance, A: 'inherited' } };
  const unknownPub = meas({ A: null, B: null, C: null, D: null, E: null });
  const agg = aggregate([measuredPub, inheritedPub, unknownPub]);
  assert.equal(agg.n, 1, '5 軸すべて measured の行だけ');
  assert.equal(agg.n_total, 3);
  assert.equal(agg.total.mean, 100);
  assert.deepEqual(agg.total.ranks, { S: 1, A: 0, B: 0, C: 0, D: 0, E: 0 });
});

test('軸ごとの集計は軸単位で measured のみを分子にする', () => {
  const inheritedA = { axes: { ...FULL }, provenance: { ...meas(FULL).provenance, A: 'inherited' } };
  const agg = aggregate([meas({ ...FULL }), inheritedA, meas({ ...FULL, A: 10 })]);
  assert.deepEqual({ n: agg.axes.A.n, n_total: agg.axes.A.n_total, mean: agg.axes.A.mean }, { n: 2, n_total: 3, mean: 15 });
  assert.equal(agg.axes.B.n, 3, 'B は 3 行とも measured');
  assert.equal(agg.n, 2, '合計は A が inherited の行を落とす');
});

test('measured が 0 件の軸の mean は null で、0 ではない', () => {
  const agg = aggregate([meas({ A: null, B: null, C: null, D: null, E: null })]);
  assert.equal(agg.n, 0);
  assert.equal(agg.axes.A.mean, null);
  assert.equal(agg.total.mean, null);
});

test('追加軸の母数は、その軸を持つ行 (動的) に限る', () => {
  const dyn = meas({ ...FULL, F: 10, G: null });
  const stat = meas({ ...FULL });
  const agg = aggregate([dyn, stat]);
  assert.equal(agg.axes.F.n_total, 1);
  assert.equal(agg.axes.F.n, 1);
  assert.equal(agg.axes.G.n_total, 1);
  assert.equal(agg.axes.G.n, 0);
});

test('集計はコアと追加軸を合算した総合点を返さない', () => {
  const agg = aggregate([meas({ ...FULL, F: 10, G: 8 })]);
  assert.equal(agg.total.mean, 100);
  assert.equal(agg.overall, undefined);
});

test('applyProfile は段階表を当てて点数と由来を返す', () => {
  const r = applyProfile({ conditional_get: 'both' }, FIXTURE_PROFILE);
  assert.equal(r.axes.F, 20);
  assert.equal(r.provenance.F, 'measured');
  assert.equal(r.profile_revision, 'fx1');
});

test('applyProfile は事実が欠けた軸を null + unknown にする', () => {
  const r = applyProfile({}, FIXTURE_PROFILE);
  assert.equal(r.axes.F, null);
  assert.equal(r.provenance.F, 'unknown');
  assert.equal(r.axes.A, null);
});

test('applyProfile は段階表に載っていないコア軸も null + unknown で返す', () => {
  const r = applyProfile({ reach: 'ok' }, FIXTURE_PROFILE);
  assert.equal(r.axes.A, 20);
  for (const k of ['B', 'C', 'D', 'E']) { assert.equal(r.axes[k], null, k); assert.equal(r.provenance[k], 'unknown', k); }
  assert.equal(r.axes.G, undefined, '段階表に無い追加軸は出さない');
});

test('applyProfile: 段差は profile から読む (同じ事実でも段階表が違えば点が変わる)', () => {
  const other = { ...FIXTURE_PROFILE, axes: { F: [{ when: { conditional_get: 'both' }, points: 7 }] } };
  assert.equal(applyProfile({ conditional_get: 'both' }, other).axes.F, 7);
});

test('applyProfile: 事実は観測されたが段階表のどの段にも当たらないときは失敗する', () => {
  assert.throws(() => applyProfile({ conditional_get: 'etag' }, FIXTURE_PROFILE), /段階表/, '穴のある段階表を unknown に落とさない');
});

test('applyProfile: 先に当たった段を採る', () => {
  const p = { profile: 'x', revision: 'r', axes: { F: [{ when: { stable_url: true }, points: 9 }, { when: { stable_url: true }, points: 1 }] } };
  assert.equal(applyProfile({ stable_url: true }, p).axes.F, 9);
});

test('applyProfile: when に配列を書くと any-of', () => {
  const p = { profile: 'x', revision: 'r', axes: { F: [{ when: { conditional_get: ['etag', 'both'] }, points: 12 }] } };
  assert.equal(applyProfile({ conditional_get: 'etag' }, p).axes.F, 12);
});

test('applyProfile は段階表が無い・壊れているとき黙って素通りせず失敗する', () => {
  assert.throws(() => applyProfile({ reach: 'ok' }, undefined), /profile/);
  assert.throws(() => applyProfile({ reach: 'ok' }, null), /profile/);
  assert.throws(() => applyProfile({ reach: 'ok' }, {}), /axes/);
  assert.throws(() => applyProfile({ reach: 'ok' }, { revision: 'r', axes: {} }), /axes/, '空の段階表');
  assert.throws(() => applyProfile({ reach: 'ok' }, { axes: FIXTURE_PROFILE.axes }), /revision/);
  assert.throws(() => applyProfile(undefined, FIXTURE_PROFILE), /facts/);
});

test('applyProfile は配点を超える段・未知の軸を持つ段階表を拒む', () => {
  const over = { profile: 'x', revision: 'r', axes: { A: [{ when: { reach: 'ok' }, points: 21 }] } };
  assert.throws(() => applyProfile({ reach: 'ok' }, over), /範囲/);
  const bad = { profile: 'x', revision: 'r', axes: { Z: [{ when: { reach: 'ok' }, points: 1 }] } };
  assert.throws(() => applyProfile({ reach: 'ok' }, bad), /軸/);
  const nowhen = { profile: 'x', revision: 'r', axes: { F: [{ points: 1 }] } };
  assert.throws(() => applyProfile({}, nowhen), /when/);
});

test('loadProfile は schema/profiles/<name>.yaml を読み、無ければ失敗する', () => {
  const root = mkdtempSync(join(tmpdir(), 'prof-'));
  mkdirSync(join(root, 'schema', 'profiles'), { recursive: true });
  writeFileSync(join(root, 'schema', 'profiles', 'fx.yaml'), 'profile: fx\nrevision: r1\naxes:\n  F:\n    - when: {conditional_get: both}\n      points: 3\n');
  const p = loadProfile('fx', root);
  assert.equal(applyProfile({ conditional_get: 'both' }, p).axes.F, 3);
  assert.throws(() => loadProfile('dynamic', root), /見つからない/);
  assert.throws(() => loadProfile('../x', root), /profile 名/);
});
