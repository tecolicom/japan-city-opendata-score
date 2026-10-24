import { test } from 'node:test';
import { copySchemaWithMiniProfile } from './_helpers.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProfile, score, aggregate, loadProfile, collectRows, collectAll, distribution, profileBasisErrors, derivedAxesErrors, applyProfileToFile, toCsv } from '../score.mjs';

// 実物の schema/profiles/dynamic.yaml は Task 10 が作る。ここは形だけの inline fixture で、
// 点数に意味は無い (段差をコードにもテストにも埋め込まないための検証用)。
const FIXTURE_PROFILE = {
  profile: 'fixture',
  revision: 'fx1',
  axes: {
    A: [{ when: { reach: 'ok' }, points: 20 }, { when: { reach: 'blocked' }, points: 5 }],
    F: [{ when: { conditional_get: 'both' }, points: 20, basis: 'observed' }, { when: { conditional_get: 'none' }, points: 0, basis: 'design' }],
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
  const other = { ...FIXTURE_PROFILE, axes: { F: [{ when: { conditional_get: 'both' }, points: 7, basis: 'design' }] } };
  assert.equal(applyProfile({ conditional_get: 'both' }, other).axes.F, 7);
});

test('applyProfile: 事実は観測されたが段階表のどの段にも当たらないときは失敗する', () => {
  assert.throws(() => applyProfile({ conditional_get: 'etag' }, FIXTURE_PROFILE), /段階表/, '穴のある段階表を unknown に落とさない');
});

test('applyProfile: 先に当たった段を採る', () => {
  const p = { profile: 'x', revision: '2026-01-01.1', axes: { F: [{ when: { stable_url: true }, points: 9, basis: 'design' }, { when: { stable_url: true }, points: 1, basis: 'design' }] } };
  assert.equal(applyProfile({ stable_url: true }, p).axes.F, 9);
});

test('applyProfile: when に配列を書くと any-of', () => {
  const p = { profile: 'x', revision: '2026-01-01.1', axes: { F: [{ when: { conditional_get: ['etag', 'both'] }, points: 12, basis: 'design' }] } };
  assert.equal(applyProfile({ conditional_get: 'etag' }, p).axes.F, 12);
});

test('applyProfile は段階表が無い・壊れているとき黙って素通りせず失敗する', () => {
  assert.throws(() => applyProfile({ reach: 'ok' }, undefined), /profile/);
  assert.throws(() => applyProfile({ reach: 'ok' }, null), /profile/);
  assert.throws(() => applyProfile({ reach: 'ok' }, {}), /axes/);
  assert.throws(() => applyProfile({ reach: 'ok' }, { revision: '2026-01-01.1', axes: {} }), /axes/, '空の段階表');
  assert.throws(() => applyProfile({ reach: 'ok' }, { axes: FIXTURE_PROFILE.axes }), /revision/);
  assert.throws(() => applyProfile(undefined, FIXTURE_PROFILE), /facts/);
});

test('applyProfile は配点を超える段・未知の軸を持つ段階表を拒む', () => {
  const over = { profile: 'x', revision: '2026-01-01.1', axes: { A: [{ when: { reach: 'ok' }, points: 21 }] } };
  assert.throws(() => applyProfile({ reach: 'ok' }, over), /範囲/);
  const bad = { profile: 'x', revision: '2026-01-01.1', axes: { Z: [{ when: { reach: 'ok' }, points: 1 }] } };
  assert.throws(() => applyProfile({ reach: 'ok' }, bad), /軸/);
  const nowhen = { profile: 'x', revision: '2026-01-01.1', axes: { F: [{ points: 1 }] } };
  assert.throws(() => applyProfile({}, nowhen), /when/);
});

test('loadProfile は schema/profiles/<name>.yaml を読み、無ければ失敗する', () => {
  const root = mkdtempSync(join(tmpdir(), 'prof-'));
  mkdirSync(join(root, 'schema', 'profiles'), { recursive: true });
  writeFileSync(join(root, 'schema', 'profiles', 'fx.yaml'), 'profile: fx\nrevision: 2026-01-01.1\naxes:\n  F:\n    - when: {conditional_get: both}\n      points: 3\n      basis: design\n');
  const p = loadProfile('fx', root);
  assert.equal(applyProfile({ conditional_get: 'both' }, p).axes.F, 3);
  assert.throws(() => loadProfile('dynamic', root), /見つからない/);
  assert.throws(() => loadProfile('../x', root), /profile 名/);
});

// ---- 修正ラウンド 1: キャップ (合計後に掛ける上限。段階表ではなく score の引数) ----
const capRow = (facts) => ({ ...meas({ ...FULL }), facts });
const CAP = [{ when: { partial: true }, max: 59 }];

test('caps を渡さなければ上限なしで動く', () => {
  const s = score(capRow({ partial: true }));
  assert.equal(s.core.total, 100);
  assert.equal(s.core.capped_at, null);
  assert.equal(score(capRow({ partial: true }), {}).core.total, 100);
  assert.equal(score(capRow({ partial: true }), { caps: undefined }).core.total, 100);
  assert.equal(score(capRow({ partial: true }), { caps: [] }).core.total, 100);
});

test('caps は合計後に掛かり、ランクは上限後の合計で決まる', () => {
  const s = score(capRow({ partial: true }), { caps: CAP });
  assert.equal(s.core.total, 59);
  assert.equal(s.core.rank, 'C');
  assert.equal(s.core.capped_at, 59);
  assert.equal(s.core.A, 20, '軸の点は変えない');
});

test('caps の条件に当たらなければ掛からない (事実が未観測でも掛からない)', () => {
  assert.equal(score(capRow({ partial: false }), { caps: CAP }).core.total, 100);
  assert.equal(score(capRow({}), { caps: CAP }).core.total, 100);
  assert.equal(score(meas({ ...FULL }), { caps: CAP }).core.total, 100, 'facts が無い行');
});

test('caps が複数当たれば最小の上限を採り、合計を下回らない上限は掛からない', () => {
  const caps = [{ when: { partial: true }, max: 59 }, { when: { core_missing: ['x', 'y'] }, max: 19 }, { when: { partial: true }, max: 90 }];
  const s = score(capRow({ partial: true, core_missing: 'y' }), { caps });
  assert.equal(s.core.total, 19);
  assert.equal(s.core.rank, 'E');
  assert.equal(s.core.capped_at, 19);
  const low = score(meas({ A: 5, B: 5, C: 5, D: 5, E: 5, }), { caps: [{ when: { partial: true }, max: 59 }] });
  assert.equal(low.core.capped_at, null);
  const s2 = score({ ...capRow({ partial: true }) }, { caps: [{ when: { partial: true }, max: 100 }] });
  assert.equal(s2.core.capped_at, null, '合計が下がらなければ capped ではない');
});

test('total が null (unknown 軸あり) の行には caps を掛けない (null のまま)', () => {
  const s = score({ ...meas({ A: null, B: 25, C: 20, D: 20, E: 15 }), facts: { partial: true } }, { caps: CAP });
  assert.equal(s.core.total, null);
  assert.equal(s.core.rank, null);
  assert.equal(s.core.capped_at, null);
});

test('不正な caps / options は黙って無視せず例外にする', () => {
  const row = capRow({ partial: true });
  const bad = (caps, re) => assert.throws(() => score(row, { caps }), re, JSON.stringify(caps));
  bad('x', /caps/);
  bad({ when: { partial: true }, max: 59 }, /caps/);
  bad([null], /caps/);
  bad([{ max: 59 }], /when/);
  bad([{ when: {}, max: 59 }], /when/);
  bad([{ when: { partial: true } }], /max/);
  bad([{ when: { partial: true }, max: '59' }], /max/);
  bad([{ when: { partial: true }, max: 59.5 }], /max/);
  bad([{ when: { partial: true }, max: -1 }], /max/);
  bad([{ when: { partial: true }, max: 101 }], /max/);
  bad([{ when: { partial: true }, max: 59, note: 'x' }], /未知/);
  assert.throws(() => score(row, { cap: CAP }), /未知/, 'caps の綴り違いを無視しない');
  assert.throws(() => score(row, 'caps'), /options/);
  assert.throws(() => score(row, null), /options/);
});

test('aggregate も caps を受け取り、上限後の合計で集計する (不正なら例外)', () => {
  const agg = aggregate([capRow({ partial: true })], { caps: CAP });
  assert.equal(agg.total.mean, 59);
  assert.equal(agg.total.ranks.C, 1);
  assert.throws(() => aggregate([capRow({})], { caps: 'x' }), /caps/);
});

test('段階表の caps も同じ形式で検査される', () => {
  const withCaps = (caps) => ({ ...FIXTURE_PROFILE, caps });
  assert.deepEqual(applyProfile({ reach: 'ok' }, withCaps(CAP)).caps, CAP);
  assert.throws(() => applyProfile({ reach: 'ok' }, withCaps([{ when: { a: 1 } }])), /max/);
  assert.equal(applyProfile({ reach: 'ok' }, FIXTURE_PROFILE).caps, undefined);
});

// ---- 修正ラウンド 1: schema/profiles/ の検証 (validate.mjs) ----
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runValidate = (profiles) => {
  const tmp = mkdtempSync(join(tmpdir(), 'jpdi-prof-'));
  copySchemaWithMiniProfile(root, tmp);
  symlinkSync(join(root, 'families'), join(tmp, 'families'));
  for (const [rel, body] of Object.entries(profiles)) {
    mkdirSync(dirname(join(tmp, 'schema', 'profiles', rel)), { recursive: true });
    writeFileSync(join(tmp, 'schema', 'profiles', rel), body);
  }
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'validate.mjs'), '--root', tmp, '--no-registry'], { encoding: 'utf8' });
  return { code: r.status, out: r.stderr + r.stdout, tmp };
};
const GOOD = 'profile: dynamic\nrevision: 2026-01-01.1\naxes:\n  F:\n    - when: {conditional_get: both}\n      points: 20\n      basis: design\ncaps:\n  - when: {partial: true}\n    max: 59\n';

test('validate: schema/profiles/ が無くても空でも通る', () => {
  assert.equal(runValidate({}).code, 0);
  const r = runValidate({ '.gitkeep': '' });
  assert.equal(r.code, 0, r.out);
});

test('validate: schema/profiles/*.yaml は検証され、壊れていれば落ちる', () => {
  const ok = runValidate({ 'dynamic.yaml': GOOD });
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /profiles/, '検証一覧に出る');
  const broken = (body) => runValidate({ 'dynamic.yaml': body });
  assert.notEqual(broken(GOOD.replace('revision: 2026-01-01.1\n', '')).code, 0, 'revision 無し');
  assert.notEqual(broken(GOOD.replace('points: 20', 'points: x')).code, 0, 'points が数でない');
  assert.notEqual(broken(GOOD.replace('  F:', '  Z:')).code, 0, '未知の軸');
  assert.notEqual(broken(GOOD.replace('max: 59', 'max: 101')).code, 0, 'caps の範囲外');
  assert.notEqual(broken(GOOD.replace('profile: dynamic', 'profile: other')).code, 0, 'ファイル名と profile が違う');
  assert.notEqual(broken(GOOD.replace('F:\n    - when', 'A:\n    - when').replace('points: 20', 'points: 21')).code, 0, 'コア配点超過');
  assert.notEqual(runValidate({ 'notes.md': 'x' }).code, 0, 'yaml でないファイルは未実装として落ちる');
  assert.notEqual(runValidate({ 'sub/x.yaml': GOOD }).code, 0, '下位ディレクトリは検証されないので落ちる');
  const extra = runValidate({ 'dynamic.yaml': GOOD + 'foo: 1\n' });
  assert.notEqual(extra.code, 0, '知らないキー');
});

// ---- Task 10: F / G の段階表 (schema/profiles/dynamic.yaml) ----
const REAL = loadProfile('dynamic', root);
const realPublishers = () => collectRows(root).map((r) => r.row);

test('実物の dynamic 段階表: 版の形式・G の別名・全段に basis がある', () => {
  assert.match(REAL.revision, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.equal(REAL.axis_aliases.G, 'g_proxy', 'G は代理指標版であることを名前に持つ');
  for (const k of ['F', 'G']) for (const s of REAL.axes[k]) assert.ok(['observed', 'design'].includes(s.basis), `${k} ${JSON.stringify(s.when)}`);
  for (const k of ['F', 'G']) for (const s of REAL.axes[k]) assert.ok(s.points === null || (s.points >= 0 && s.points <= 10), '尺度は 0〜10');
});

test('段階表の basis は実データと食い違わない (observed は実測が当たり、design には当たっていない)', () => {
  assert.deepEqual(profileBasisErrors(REAL, realPublishers()), []);
  // 実測の分布: 条件付き GET の none は 0 件なので、none の段が observed を名乗ってはならない
  const none = REAL.axes.F.filter((s) => s.when.conditional_get === 'none');
  assert.ok(none.length > 0 && none.every((s) => s.basis === 'design'));
});

test('profileBasisErrors: 実データの無い observed と、実データが当たった design を拾う', () => {
  const prof = { profile: 'x', axes: { F: [{ when: { conditional_get: 'both' }, points: 1, basis: 'observed' }, { when: { conditional_get: 'none' }, points: 0, basis: 'design' }] } };
  assert.equal(profileBasisErrors(prof, [{ facts: { conditional_get: 'both' } }]).length, 0, 'both=observed に当たり、none=design に当たらない: 誤りなし');
  assert.equal(profileBasisErrors(prof, []).length, 1, 'observed に 1 件も当たらない');
  assert.equal(profileBasisErrors(prof, [{ facts: { conditional_get: 'both' } }, { facts: { conditional_get: 'none' } }]).length, 1, 'design に当たった');
});

test('実データへの適用: F は site-top 観測なので estimated、G は 5xx のページリンクだけが measured', () => {
  const rows = collectRows(root).filter((r) => r.domain === 'schedule-events');
  assert.equal(rows.length, 16);
  for (const { row } of rows) {
    assert.equal(row.provenance.F, 'estimated', row.id);
    assert.ok([6, 10].includes(row.axes.F), row.id);
    assert.ok(['A', 'B', 'C', 'D', 'E'].every((k) => row.axes[k] === null && row.provenance[k] === 'unknown'), 'コア軸は未調査のまま');
  }
  const g = Object.fromEntries(rows.map(({ row }) => [row.id.split('/')[0], [row.axes.G, row.provenance.G]]));
  assert.deepEqual(g.hanno, [0, 'measured']);
  assert.deepEqual(g.iruma, [0, 'measured']);
  assert.deepEqual(g.fukaya, [null, 'unknown'], '組み立てた URL の 502 は G の根拠にしない');
  assert.deepEqual(g.gyoda, [null, 'unknown']);
  assert.deepEqual(g.chichibu, [null, 'unknown'], '観測の無い行は unknown (0 ではない)');
});

test('F が estimated なら measured の集計は母数だけ数え、平均は null (推定を実測として集計しない)', () => {
  const agg = aggregate(realPublishers().filter((r) => r.axes?.F !== undefined));
  assert.equal(agg.axes.F.n, 0);
  assert.equal(agg.axes.F.n_total, 16);
  assert.equal(agg.axes.F.mean, null);
  assert.equal(agg.axes.G.n, 2);
  assert.equal(agg.total.mean, null, 'コア未調査の行からは合計を出さない');
});

test('保存済みの axes は段階表から再導出した結果と一致し、版も一致する (実データ)', () => {
  for (const r of collectRows(root).filter((x) => x.domain === 'schedule-events')) assert.deepEqual(derivedAxesErrors(r.row, REAL), [], r.id);
});

test('derivedAxesErrors: 段階表を変えて当て直さない・版を上げ忘れると拾う', () => {
  const p = { facts: { conditional_get: 'both', conditional_get_scope: 'source' }, ...applyProfile({ conditional_get: 'both', conditional_get_scope: 'source' }, REAL), profile_revision: REAL.revision };
  assert.deepEqual(derivedAxesErrors(p, REAL), []);
  const edited = { ...REAL, axes: { ...REAL.axes, F: REAL.axes.F.map((s) => ({ ...s, points: s.points === 10 ? 9 : s.points })) } };
  assert.ok(derivedAxesErrors(p, edited).some((e) => /軸 F/.test(e)), '点数が変わったのに当て直していない');
  assert.ok(derivedAxesErrors(p, { ...REAL, revision: '2099-01-01.1' }).some((e) => /profile_revision/.test(e)), '版が違う');
});

test('G を持つ段階表は axis_aliases.G: g_proxy が要る / points: null は unknown (0 ではない)', () => {
  const noAlias = { ...REAL, axis_aliases: undefined };
  assert.throws(() => applyProfile({ stable_url: true }, noAlias), /g_proxy/);
  const r = applyProfile({ feed_http_status: 200 }, REAL);
  assert.equal(r.axes.G, null);
  assert.equal(r.provenance.G, 'unknown');
  const noBasis = { profile: 'x', revision: '2026-01-01.1', axes: { F: [{ when: { a: 1 }, points: 1 }] } };
  assert.throws(() => applyProfile({ a: 1 }, noBasis), /basis/, '追加軸の段は裏付けの有無を書く');
  const est = { profile: 'x', revision: '2026-01-01.1', axes: { F: [{ when: { a: 1 }, points: 1, basis: 'design', provenance: 'estimated' }] } };
  assert.throws(() => applyProfile({ a: 1 }, est), /note/, 'estimated の段は根拠が要る');
});

test('CSV の列名は G を g_proxy と書く (時系列版と取り違えない)', () => {
  const csv = toCsv(collectRows(root));
  assert.match(csv.split('\n')[0], /,F,g_proxy,/);
  assert.ok(!/,G,/.test(csv.split('\n')[0]));
});

test('distribution: 観測された値だけを数え、未観測は出さない', () => {
  const d = distribution([{ facts: { conditional_get: 'both' } }, { facts: { conditional_get: 'both', feed_http_status: 502 } }, {}]);
  assert.equal(d.n_total, 3);
  assert.deepEqual(d.facts.conditional_get, { both: 2 });
  assert.equal(d.facts.stable_url, undefined);
});

// 繰越 (Task 8): static の扱い。段階表は japan-gomi-data 側にあり、本 repo は読まない
const rootWith = (files) => {
  const tmp = mkdtempSync(join(tmpdir(), 'jpdi-static-'));
  cpSync(join(root, 'schema'), join(tmp, 'schema'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(tmp, rel)), { recursive: true });
    writeFileSync(join(tmp, rel), body);
  }
  return tmp;
};
const GOMI_PUB = (extra) => `domain: gomi\nsurveyed_at: 2026-10-24\npublishers:\n  - id: hanno/city\n    name_ja: 市\n    entity_type: municipality\n    domain_name: example.jp\n    url: https://example.jp/\n    observed_at: 2026-10-24\n${extra}`;
const GOMI_AXES = '    axes: {A: 10, B: 10, C: 10, D: 10, E: 10}\n    provenance: {A: measured, B: measured, C: measured, D: measured, E: measured}\n    facts: {stable_url: true}\n    derived_at: 2026-10-24\n    profile: static\n    profile_revision: gomi-1\n';

test('static 領域: 採点対象から除外して件数を返し (黙って捨てない)、facts だけの行は妥当', () => {
  assert.ok(!existsSync(join(root, 'schema', 'profiles', 'static.yaml')), '前提: static の段階表ファイルは置かない');
  const tmp = rootWith({ 'municipalities/saitama/hanno/assessments/gomi.yaml': GOMI_PUB('    facts: {stable_url: true}\n') });
  const r = collectAll(tmp);
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.excluded.static, ['hanno/city']);
  assert.equal(collectRows(tmp).length, 0);
});

test('static 領域: axes がある行は本 repo の段階表で導出できないので失敗する', () => {
  const tmp = rootWith({ 'municipalities/saitama/hanno/assessments/gomi.yaml': GOMI_PUB(GOMI_AXES) });
  assert.throws(() => collectAll(tmp), /static.*導出/);
});

test('プロファイル未判定の領域の facts だけの行も、除外して件数を返す', () => {
  const aed = rootWith({ 'municipalities/saitama/hanno/assessments/aed.yaml': GOMI_PUB('    facts: {stable_url: true}\n').replace('domain: gomi', 'domain: aed') });
  assert.deepEqual(collectAll(aed).excluded.unjudged, ['hanno/city']);
});

test('--apply-profile は冪等で、コメントを保ち、既存の notes を上書きしない', () => {
  const src = '# 先頭コメント\ndomain: schedule-events\nsurveyed_at: 2026-10-24\npublishers:\n  - id: hanno/city\n    name_ja: 市\n    entity_type: municipality\n    domain_name: example.jp\n    url: https://example.jp/\n    observed_at: 2026-10-24\n    facts:\n      conditional_get: last-modified\n      conditional_get_scope: site-top\n';
  const tmp = rootWith({ 'municipalities/saitama/hanno/assessments/schedule-events.yaml': src });
  cpSync(join(root, 'schema', 'profiles'), join(tmp, 'schema', 'profiles'), { recursive: true });
  const f = join(tmp, 'municipalities/saitama/hanno/assessments/schedule-events.yaml');
  assert.deepEqual(applyProfileToFile(f, tmp, { derivedAt: '2026-10-25' }), ['hanno/city']);
  const once = readFileSync(f, 'utf8');
  assert.match(once, /^# 先頭コメント/);
  assert.match(once, /derived_at: 2026-10-25/);
  assert.match(once, /段階表の注記/);
  assert.deepEqual(applyProfileToFile(f, tmp, { derivedAt: '2026-11-01' }), [], '同じ版・同じ結果なら何も変えない');
  assert.equal(readFileSync(f, 'utf8'), once);
  const clobber = rootWith({ 'municipalities/saitama/hanno/assessments/schedule-events.yaml': `${src}    notes: 手書きのメモ\n` });
  cpSync(join(root, 'schema', 'profiles'), join(clobber, 'schema', 'profiles'), { recursive: true });
  assert.throws(() => applyProfileToFile(join(clobber, 'municipalities/saitama/hanno/assessments/schedule-events.yaml'), clobber), /notes/);
});

// 繰越 (Task 8): caps の when は facts だけを見る。軸点・由来を条件にする必要は実データに無い (今は不要)
test('caps の when は facts だけを見る: 軸点や由来は条件にならない (今は不要と判断)', () => {
  const row = { ...meas({ ...FULL, F: 10 }), facts: { partial: true } };
  assert.equal(score(row, { caps: [{ when: { F: 10 }, max: 10 }] }).core.total, 100, '軸 F は when の語彙ではない');
});

test('G=0 の行の notes に根拠の範囲 (フィードのエンドポイントのみ。HTML ページは取得できている) が入る', () => {
  const r = applyProfile({ feed_http_status: 502, feed_url_basis: 'page-link', feed_url: 'https://example.jp/feed' }, REAL);
  assert.equal(r.axes.G, 0);
  assert.ok(r.notes.some((n) => /https:\/\/example\.jp\/feed/.test(n) && /HTML ページは同時点で取得できている/.test(n) && /継続性を観測したものではない/.test(n)));
  assert.throws(() => applyProfile({ feed_http_status: 502, feed_url_basis: 'page-link' }, REAL), /feed_url/, 'URL が無ければ範囲を書けない');
  for (const h of ['hanno', 'iruma']) {
    const row = collectRows(root).find((x) => x.id === `${h}/city-site`).row;
    assert.match(row.notes, /フィードのエンドポイント/, h);
  }
});

// 配線の確認 (変異): 実物の repo を丸ごと写して壊し、validate.mjs (テストの関数ではなくゲート本体) が落ちること
const mutate = (edit) => {
  const tmp = mkdtempSync(join(tmpdir(), 'jpdi-mut-'));
  for (const d of ['schema', 'families', 'municipalities']) cpSync(join(root, d), join(tmp, d), { recursive: true });
  edit(tmp);
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'validate.mjs'), '--root', tmp, '--no-registry'], { encoding: 'utf8' });
  return { code: r.status, out: r.stderr + r.stdout };
};
const editFile = (rel, from, to) => (tmp) => {
  const f = join(tmp, rel);
  const s = readFileSync(f, 'utf8');
  assert.ok(s.includes(from), `変異の前提: ${rel} に ${from} がある`);
  writeFileSync(f, s.replace(from, to));
};
const DYN = 'schema/profiles/dynamic.yaml';
const IRUMA = 'municipalities/saitama/iruma/assessments/schedule-events.yaml';

test('validate (ゲート本体): 変異していない実物は通る', () => {
  const r = mutate(() => {});
  assert.equal(r.code, 0, r.out);
});

test('validate (ゲート本体): basis の嘘 (observed に実データが無い / design に実データが当たる) で落ちる', () => {
  // site-top の etag は実データが無い。observed を名乗らせる
  const lie1 = mutate(editFile(DYN, '      basis: design\n      provenance: estimated\n      note: ETag のみ。', '      basis: observed\n      provenance: estimated\n      note: ETag のみ。'));
  assert.notEqual(lie1.code, 0);
  assert.match(lie1.out, /basis: observed だが実データが 1 件も当たらない/);
  // site-top の both は実データが当たっている。design に戻す
  const lie2 = mutate(editFile(DYN, '      basis: observed\n      provenance: estimated\n      note: ETag と Last-Modified の両方', '      basis: design\n      provenance: estimated\n      note: ETag と Last-Modified の両方'));
  assert.notEqual(lie2.code, 0);
  assert.match(lie2.out, /basis: design だが実データが/);
});

test('validate (ゲート本体): 生成された notes (観測の範囲の注記) を消す・書き換えると落ちる', () => {
  const read = (tmp) => readFileSync(join(tmp, IRUMA), 'utf8');
  const noNotes = mutate((tmp) => writeFileSync(join(tmp, IRUMA), read(tmp).replace(/\n    notes:[\s\S]*$/, '\n')));
  assert.notEqual(noNotes.code, 0);
  assert.match(noNotes.out, /notes/);
  const edited = mutate(editFile(IRUMA, '配信元全体の継続性を観測したものではない', '配信元は継続性が無い'));
  assert.notEqual(edited.code, 0);
  assert.match(edited.out, /notes が段階表の生成する注記と違う/);
});

test('CSV に notes 列があり、G=0 の行は観測の範囲を持つ', () => {
  const csv = toCsv(collectRows(root));
  assert.match(csv.split('\n')[0], /,notes$/);
  assert.match(csv, /hanno\/city-site[\s\S]*?フィードのエンドポイント/);
});
