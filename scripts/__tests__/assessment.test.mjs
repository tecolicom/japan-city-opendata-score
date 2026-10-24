import { test } from 'node:test';
import { copySchemaWithMiniProfile } from './_helpers.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { loadYaml } from '../_lib/lib.mjs';
import { assessmentSemanticErrors } from '../_lib/assessment-check.mjs';
import { familySemanticErrors, webSemanticErrors, thresholdBasis } from '../_lib/family-check.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const schema = loadYaml(join(root, 'schema', 'assessment.schema.json'));
ajv.addSchema(schema);
const validateAssessment = ajv.getSchema(schema.$id);
const validatePublisher = ajv.getSchema(`${schema.$id}#/$defs/publisher`);
const webValidate = ajv.compile(loadYaml(join(root, 'schema', 'web.schema.json')));
const a = loadYaml(join(root, 'scripts', '__tests__', '__fixtures__', 'assessment-hanno-schedule-events.yaml'));

// schema と意味検査の両方を通って初めて妥当
const domains = new Map(loadYaml(join(root, 'schema', 'domains.yaml')).domains.map((d) => [d.id, d]));
const validate = (p) => validatePublisher(p) === true && assessmentSemanticErrors({ domain: 'schedule-events', publishers: [p] }, { handle: 'hanno', profiles, domains }).length === 0;
// 検査用の最小の段階表 (点数に意味は無い)。版 r1 は DER が指す。実物との照合は下の revision テストが持つ。
const profiles = new Map([['dynamic', { profile: 'dynamic', revision: 'r1', axes: { F: [{ when: { conditional_get: 'both' }, points: 10, basis: 'design' }] } }]]);
const REAL_REV = loadYaml(join(root, 'schema', 'profiles', 'dynamic.yaml')).revision;
const pub = { ...a.publishers[1] };
const pubBase = { ...pub, observed_at: '2026-10-23' };
const DER = { derived_at: '2026-10-30', profile: 'dynamic', profile_revision: 'r1' };
const inh = { family_id: 'fam-feedphp-sitenew', representative_handle: 'hanno' };

test('fixture は妥当で、配信元ごとに行を持ち、自治体値は保存しない', () => {
  assert.ok(validateAssessment(a), JSON.stringify(validateAssessment.errors));
  assert.ok(Array.isArray(a.publishers));
  assert.equal(a.municipality_score, undefined);
  assert.ok(!validateAssessment({ ...a, municipality_score: 80 }), '自治体値の保存は schema が拒む');
});

// Review Focus 1: 非 lg.jp の id 衝突
test('publisher id は handle で名前空間化される', () => {
  assert.equal(a.publishers[1].id, 'hanno/lib-main');
  assert.ok(!validatePublisher({ ...pub, id: 'lib-main' }), '名前空間なしは不可');
  assert.ok(!validatePublisher({ ...pub, id: 'hanno/Lib Main' }));
  const errs = assessmentSemanticErrors({ domain: 'schedule-events', publishers: [{ ...pub, id: 'hidaka/lib-main' }] }, { handle: 'hanno', profiles, domains });
  assert.ok(errs.some((e) => /handle/.test(e)), '置かれた handle と id の接頭辞が違えば不可');
  const dup = assessmentSemanticErrors({ domain: 'schedule-events', publishers: [pub, pub] }, { handle: 'hanno', profiles, domains });
  assert.ok(dup.some((e) => /重複/.test(e)));
});

// Review Focus 2: 広域連合 / ドメイン共有
test('複数 handle が 1 配信元を共有するとき shared_with を持てる', () => {
  assert.ok(validate({ ...pub, entity_type: 'kouiki', shared_with: ['hanno', 'hidaka'] }));
  assert.ok(!validatePublisher({ ...pub, shared_with: [] }));
  assert.ok(!validatePublisher({ ...pub, shared_with: ['hanno', 'hanno'] }));
  assert.ok(!validate({ ...pub, entity_type: 'kouiki', shared_with: ['hidaka', 'iruma'] }), '所有 handle を含まない共有は不可');
});

// Review Focus 3: 恒久的に消えた配信元
test('status: gone は観測日と最終成功日を要求する', () => {
  assert.ok(!validatePublisher({ ...pub, status: 'gone' }));
  assert.ok(!validatePublisher({ ...pub, status: 'gone', observed_at: '2026-10-23' }));
  assert.ok(!validatePublisher({ ...pub, status: 'gone', last_success_at: '2026-10-21' }));
  assert.ok(validate({ ...pub, status: 'gone', observed_at: '2026-10-23', last_success_at: '2026-10-21' }));
  assert.ok(!validate({ ...pub, status: 'gone', observed_at: '2026-10-01', last_success_at: '2026-10-21' }), '最終成功が観測より後は矛盾');
  assert.ok(!validatePublisher({ ...pub, status: 'moved', observed_at: '2026-10-23', last_success_at: '2026-10-21' }), 'moved は移転先を要求する (他は揃っている)');
});

test('unknown な軸は 0 ではなく provenance が unknown', () => {
  assert.ok(validate({ ...pub, ...DER, axes: { A: null }, provenance: { A: 'unknown' } }));
  assert.ok(!validate({ ...pub, ...DER, axes: { A: 0 }, provenance: { A: 'unknown' } }), 'unknown に 0 点は付けられない');
  assert.ok(!validate({ ...pubBase, ...DER, axes: { A: null }, provenance: { A: 'measured' }, facts: { stable_url: true } }), 'measured なのに値が無い');
  assert.ok(!validate({ ...pubBase, ...DER, axes: { A: 10 } }), '由来の無い点数は不可');
  assert.ok(!validate({ ...pubBase, ...DER, axes: { A: 10 }, provenance: { A: 'unknown' } }));
});

test('B/C/D/E は inherited を禁じる', () => {
  const p = { ...pub, inherited_from: inh };
  for (const k of ['B', 'C', 'D', 'E']) assert.ok(!validatePublisher({ ...p, provenance: { [k]: 'inherited' } }), k);
  for (const k of ['A', 'F', 'G']) assert.ok(validatePublisher({ ...p, provenance: { [k]: 'inherited' } }), k);
});

test('inherited は inherited_from を必須にし、observed_from は A/F のみ', () => {
  assert.ok(!validatePublisher({ ...pub, provenance: { A: 'inherited' } }));
  assert.ok(!validatePublisher({ ...pub, inherited_from: { family_id: 'fam-x' }, provenance: { A: 'inherited' } }));
  assert.ok(validatePublisher({ ...pub, observed_from: { A: 'jp-residential', F: 'overseas-ci' } }));
  assert.ok(!validatePublisher({ ...pub, observed_from: { B: 'jp-residential' } }), 'B に測定地点は付けない');
  assert.ok(!validatePublisher({ ...pub, observed_from: { A: 'moon' } }));
});

test('estimated は notes、measured は observed_at を要求する', () => {
  assert.ok(!validatePublisher({ ...pub, ...DER, axes: { B: 5 }, provenance: { B: 'estimated' } }));
  assert.ok(validatePublisher({ ...pub, ...DER, axes: { B: 5 }, provenance: { B: 'estimated' }, notes: '状況証拠: 同系統' }));
  assert.ok(!validatePublisher({ ...pub, ...DER, axes: { B: 5 }, provenance: { B: 'measured' } }));
  assert.ok(validatePublisher({ ...pubBase, ...DER, axes: { B: 5 }, provenance: { B: 'measured' } }));
});

test('軸の上限は配点を超えられない', () => {
  assert.ok(validatePublisher({ ...pubBase, ...DER, axes: { A: 20, B: 25, C: 20, D: 20, E: 15 }, provenance: { A: 'measured', B: 'measured', C: 'measured', D: 'measured', E: 'measured' } }));
  assert.ok(!validatePublisher({ ...pubBase, ...DER, axes: { A: 21 }, provenance: { A: 'measured' } }));
  assert.ok(!validatePublisher({ ...pubBase, ...DER, axes: { E: 16 }, provenance: { E: 'measured' } }));
});

test('facts だけで axes が無くても妥当 (Task 9 の中間状態)', () => {
  const p = { ...pubBase, facts: { conditional_get: 'etag', stable_url: true, standard_od: false } };
  assert.equal(p.axes, undefined);
  assert.ok(validate(p));
});

test('未調査を調査済みに見せない: facts があるなら観測日が要る / 空 facts は不可 / facts に未知の項目は不可', () => {
  assert.ok(!validate({ ...pub, facts: { stable_url: true } }), '観測日なしの facts');
  assert.ok(!validatePublisher({ ...pubBase, facts: {} }), '空の facts は「調べた」ように見える');
  assert.ok(!validatePublisher({ ...pubBase, facts: { conditional_get: 'maybe' } }));
  assert.ok(!validatePublisher({ ...pubBase, facts: { score: 90 } }));
  assert.ok(validate(pub), '何も調べていない配信元は facts/axes 無しで記録できる');
});

test('domain_name は url のホストと一致する', () => {
  assert.ok(!validate({ ...pub, domain_name: 'other.example.jp' }));
});

const fam = loadYaml(join(root, 'families', 'fam-feedphp-sitenew.yaml'));
const families = new Map([[fam.id, fam]]);
const [S1, S2] = fam.signals;
const webOf = (seen, conf, id = fam.id) => ({ handle: 'hanno', url: 'https://www.city.hanno.lg.jp/', family_id: id, family_confidence: conf, signals_seen: seen, fingerprinted_at: '2026-10-23' });
const sig = (signal, method = 'html') => ({ signal, method });

test('web.yaml: family が未特定でも記録でき、確度は導出値の enum', () => {
  assert.ok(webValidate(webOf([sig(S1), sig(S2)], 'observed')), JSON.stringify(webValidate.errors));
  assert.ok(webValidate(webOf([], 'none', null)));
  assert.ok(!webValidate({ ...webOf([], 'none', null), signals_seen: undefined }), 'signals_seen は省略不可');
  assert.ok(!webValidate(webOf([sig(S1)], 'high')), '主観 enum は不可');
  assert.ok(!webValidate(webOf([], 'observed', null)), 'family_id null で none 以外は不可');
  assert.ok(!webValidate(webOf([sig(S1)], 'none')), 'family があるのに none は不可');
});

test('family_confidence は thresholdBasis と同じ判定になる (導出値)', () => {
  const cases = [
    [[sig(S1), sig(S2)], 'observed'],
    [[sig(S1), sig(S2, 'header')], 'observed'],
    [[sig(S1), sig(S2, 'inferred_from_status')], 'inferred'],
    [[sig(S1)], 'below'],
    [[sig(S1, 'inferred_from_status')], 'below'],
  ];
  for (const [seen, want] of cases) {
    assert.equal(thresholdBasis(fam, { signals_seen: seen }), want);
    assert.deepEqual(webSemanticErrors(webOf(seen, want), families), [], want);
    for (const other of ['observed', 'inferred', 'below'].filter((c) => c !== want)) {
      assert.ok(webSemanticErrors(webOf(seen, other), families).some((e) => /導出値/.test(e)), `${want} を ${other} と書けてはならない`);
    }
  }
  assert.deepEqual(webSemanticErrors(webOf([], 'none', null), families), []);
  assert.ok(webSemanticErrors(webOf([sig(S1)], 'none', null), families).length > 0, 'null なのに signals_seen');
  assert.ok(webSemanticErrors(webOf([sig(S1), sig(S1)], 'observed'), families).some((e) => /重複/.test(e)), '水増し');
  assert.ok(webSemanticErrors(webOf([sig('/nowhere'), sig(S1)], 'observed'), families).some((e) => /signals に無い/.test(e)));
  assert.ok(webSemanticErrors(webOf([], 'below', 'fam-nope'), families).length > 0, '未登録 family');
});

test('axes は導出値: derived_at / profile / profile_revision を伴い、観測より後', () => {
  const ax = { axes: { A: 10 }, provenance: { A: 'measured' }, observed_at: '2026-10-23', facts: { stable_url: true } };
  assert.ok(!validatePublisher({ ...pub, ...ax }), '導出の由来なしは不可');
  const der = DER;
  assert.ok(validate({ ...pub, ...ax, ...der }));
  for (const k of Object.keys(der)) assert.ok(!validatePublisher({ ...pub, ...ax, ...der, [k]: undefined }), k);
  assert.ok(!validate({ ...pub, ...ax, ...der, derived_at: '2026-10-01' }), '導出が観測より前');
  assert.ok(validate({ ...pubBase, facts: { stable_url: true } }), 'facts だけなら導出の由来は不要');
});

test('measured / estimated の軸は観測の記録 (facts) を要求する。A/F は reachability も根拠になる', () => {
  const m = (k, prov, extra = {}) => ({ ...pubBase, ...DER, notes: 'n', axes: { [k]: 5 }, provenance: { [k]: prov }, ...extra });
  for (const prov of ['measured', 'estimated']) {
    assert.ok(!validate(m('B', prov)), `${prov}: facts 無しは不可`);
    assert.ok(validate(m('B', prov, { facts: { stable_url: true } })), prov);
    assert.ok(!validate(m('B', prov, { reachability: { overseas_rest: 'blocked' } })), 'B に到達性は根拠にならない');
    assert.ok(validate(m('A', prov, { reachability: { overseas_rest: 'blocked' } })), 'A は到達性が根拠になる');
  }
});

test('axes の profile は領域のプロファイルと一致し、未判定の領域には axes を書けない', () => {
  const p = { ...pubBase, ...DER, axes: { A: 5 }, provenance: { A: 'measured' }, facts: { stable_url: true } };
  const check = (dom, pp) => assessmentSemanticErrors({ domain: dom, publishers: [pp] }, { handle: 'hanno', profiles, domains });
  assert.deepEqual(check('schedule-events', p), []);
  assert.ok(check('schedule-events', { ...p, profile: 'static' }).some((e) => /プロファイル/.test(e)), '領域は dynamic');
  assert.ok(check('aed', p).some((e) => /未判定/.test(e)), 'profile が null の領域');
  assert.deepEqual(check('aed', pubBase), [], 'axes が無ければ未判定の領域でも記録できる');
});

test('derived_at / profile / profile_revision は axes があるときだけ書ける', () => {
  for (const k of Object.keys(DER)) assert.ok(!validatePublisher({ ...pubBase, [k]: DER[k] }), k);
});

test('inherited は web.yaml の確認が要る: 存在・family 一致・確度が observed/inferred', () => {
  const p = { ...pubBase, ...DER, inherited_from: inh, axes: { A: 5 }, provenance: { A: 'inherited' } };
  const web = (o = {}) => ({ handle: 'hanno', family_id: fam.id, family_confidence: 'observed', signals_seen: [], fingerprinted_at: '2026-10-23', ...o });
  const check = (w) => assessmentSemanticErrors({ domain: 'schedule-events', publishers: [p] }, { handle: 'hanno', profiles, domains, families, web: w });
  assert.deepEqual(check(web()), []);
  assert.deepEqual(check(web({ family_confidence: 'inferred' })), []);
  assert.ok(check(undefined).some((e) => /web\.yaml が無い/.test(e)), 'web.yaml が無い');
  assert.ok(check(web({ family_id: 'fam-other' })).some((e) => /family_id/.test(e)), 'family 不一致');
  assert.ok(check(web({ family_confidence: 'below' })).some((e) => /family_confidence/.test(e)), 'below');
  assert.ok(check(web({ family_id: null, family_confidence: 'none' })).some((e) => /family_id|family_confidence/.test(e)), 'none');
});

test('moved も gone と同じく観測日と最終成功日を要求する', () => {
  const m = { ...pub, status: 'moved', moved_to: 'https://new.example.jp/' };
  assert.ok(!validatePublisher({ ...m, observed_at: '2026-10-23' }));
  assert.ok(!validatePublisher({ ...m, last_success_at: '2026-10-21' }));
  assert.ok(validate({ ...m, observed_at: '2026-10-23', last_success_at: '2026-10-21' }));
});

// 繰越: signals_seen の重複で観測数を水増しできてはならない
test('signals_seen の同じ signal の二重記載は method が違ってもエラー', () => {
  const f = loadYaml(join(root, 'families', 'fam-feedphp-sitenew.yaml'));
  const rep = f.measured_representatives[0];
  const s = rep.signals_seen[0].signal;
  const withSeen = (seen) => ({ ...f, measured_representatives: [{ ...rep, signals_seen: seen }] });
  assert.deepEqual(familySemanticErrors(f), []);
  assert.ok(familySemanticErrors(withSeen([{ signal: s, method: 'html' }, { signal: s, method: 'html' }])).some((e) => /重複/.test(e)));
  assert.ok(familySemanticErrors(withSeen([{ signal: s, method: 'html' }, { signal: s, method: 'inferred_from_status' }])).some((e) => /重複/.test(e)));
});

// 偽の緑が出ないこと: validate.mjs 自体が、壊した assessment で落ちる
const runValidate = (files) => {
  const tmp = mkdtempSync(join(tmpdir(), 'jpdi-'));
  copySchemaWithMiniProfile(root, tmp);
  symlinkSync(join(root, 'families'), join(tmp, 'families'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(tmp, rel)), { recursive: true });
    writeFileSync(join(tmp, rel), body);
  }
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'validate.mjs'), '--root', tmp], { encoding: 'utf8' });
  return { code: r.status, out: r.stderr + r.stdout };
};
const good = {
  'municipalities/saitama/hanno/web.yaml': 'handle: hanno\nurl: https://www.city.hanno.lg.jp/\nfamily_id: fam-feedphp-sitenew\nfamily_confidence: observed\nsignals_seen:\n  - {signal: /index.update.json, method: html}\n  - {signal: /news_list.html, method: html}\nfingerprinted_at: 2026-10-23\n',
  'municipalities/saitama/hanno/assessments/schedule-events.yaml': `domain: schedule-events
surveyed_at: 2026-10-23
publishers:
  - id: hanno/lib-main
    name_ja: 図書館
    entity_type: gaikaku
    domain_name: lib.example.jp
    url: https://lib.example.jp/
`,
};
const A = 'municipalities/saitama/hanno/assessments/schedule-events.yaml';

test('validate.mjs: 正しい assessment は通り、壊したものは落ちる (偽の緑なし)', () => {
  assert.equal(runValidate(good).code, 0, runValidate(good).out);
  const broken = (from, to) => runValidate({ ...good, [A]: good[A].replace(from, to) });
  assert.notEqual(broken('hanno/lib-main', 'lib-main').code, 0, '名前空間なし');
  assert.notEqual(broken('hanno/lib-main', 'hidaka/lib-main').code, 0, '別 handle の id');
  assert.notEqual(broken('domain: schedule-events', 'domain: no-such-domain').code, 0, '未知の領域');
  assert.notEqual(broken('domain: schedule-events', 'domain: public-wifi').code, 0, 'ファイル名と領域の不一致');
  assert.notEqual(broken('entity_type: gaikaku', 'entity_type: gaikaku\n    status: gone').code, 0, 'gone で日付なし');
  assert.notEqual(broken('    url:', '    municipality_score: 1\n    url:').code, 0, '未知のフィールド');
  assert.notEqual(runValidate({ ...good, 'municipalities/saitama/hanno/memo.txt': 'x' }).code, 0, '知らないファイル');
  assert.notEqual(runValidate({ ...good, 'municipalities/saitama/hanno/assessments/notes.md': 'x' }).code, 0, 'yaml でないファイル');
  const inheritedBad = broken('    url:', `    inherited_from: {family_id: fam-feedphp-sitenew, representative_handle: nobody}
    provenance: {A: inherited}
    axes: {A: 10}
    derived_at: 2026-10-30
    profile: dynamic
    profile_revision: ${REAL_REV}
    url:`);
  assert.notEqual(inheritedBad.code, 0, '代表実測でない handle からの継承');
  const web = 'municipalities/saitama/hanno/web.yaml';
  const inh1 = broken('    url:', `    inherited_from: {family_id: fam-feedphp-sitenew, representative_handle: hanno}
    provenance: {A: inherited}
    axes: {A: 10}
    derived_at: 2026-10-30
    profile: dynamic
    profile_revision: ${REAL_REV}
    url:`);
  assert.equal(inh1.code, 0, `web.yaml が観測済みなら inherited は通る: ${inh1.out}`);
  const inhFiles = { ...good, [A]: good[A].replace('    url:', `    inherited_from: {family_id: fam-feedphp-sitenew, representative_handle: hanno}
    provenance: {A: inherited}
    axes: {A: 10}
    derived_at: 2026-10-30
    profile: dynamic
    profile_revision: ${REAL_REV}
    url:`) };
  const { [web]: _w, ...noWeb } = inhFiles;
  assert.notEqual(runValidate(noWeb).code, 0, 'web.yaml 無しの inherited');
  assert.notEqual(runValidate({ ...inhFiles, [web]: inhFiles[web].replace('observed', 'below').replace(/signals_seen:[\s\S]*?fingerprinted/, 'signals_seen:\n  - {signal: /news_list.html, method: html}\nfingerprinted') }).code, 0, 'below の inherited');
  assert.notEqual(runValidate({ ...good, [web]: good[web].replace('observed', 'below') }).code, 0, '導出値と違う family_confidence');
});

// 繰越 (Task 7 レビュー): 依存が渡されていない呼び出しで検査が黙って切れてはならない
test('依存 (domains / families) が無い呼び出しは、検査をスキップせず失敗する', () => {
  const p = { ...pubBase, ...DER, inherited_from: inh, axes: { A: 5 }, provenance: { A: 'inherited' } };
  const call = (pp, ctx) => () => assessmentSemanticErrors({ domain: 'schedule-events', publishers: [pp] }, ctx);
  assert.throws(call(pubBase, { handle: 'hanno' }), /domains/, 'domains 無しは領域の照合ができない');
  assert.throws(call(p, { handle: 'hanno', profiles, domains }), /families/, 'inherited_from があるのに families 無し');
  assert.doesNotThrow(call(pubBase, { handle: 'hanno', profiles, domains }), 'inherited が無ければ families は要らない');
});
