// 採点。責務を 3 つに分ける (docs/index.md §3.1, §6):
//   applyProfile … 観測事実 (facts) に段階表を当てて軸の点数と由来を出す。段階表は schema/profiles/<name>.yaml
//   score        … 点数からコア合計とランクを出すだけ。段階表を知らない
//   aggregate    … measured のみを分子にした集計。母数を併記する
// 判定の段差 (何が何点か) はコードに埋め込まない。コードが持つのは、コア共通の配点上限とランク閾値だけ。
//
// 必要な入力 (段階表・プロファイル) が無いときは、黙って素通りせず例外で失敗する。
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadYaml, listMunicipalityDirs } from './_lib/lib.mjs';

// コア 5 軸の配点 (docs/index.md §2。変えない)。F/G は段階表が未確定なので上限を持たない。
export const CORE_MAX = { A: 20, B: 25, C: 20, D: 20, E: 15 };
export const CORE_AXES = Object.keys(CORE_MAX);
export const DYNAMIC_AXES = ['F', 'G'];
// コア共通のランク閾値 (docs/index.md §3.1。japan-gomi-data から継承。変えない)
const RANKS = [['S', 90], ['A', 75], ['B', 60], ['C', 40], ['D', 20], ['E', 0]];
export const RANK_LABELS = RANKS.map(([r]) => r);

const isNum = (v) => typeof v === 'number' && Number.isInteger(v);
const rankOf = (total) => RANKS.find(([, min]) => total >= min)[0];

// ---- profile ----

// schema/profiles/<name>.yaml を読む。名前が不正・ファイルが無いときは失敗する。
export function loadProfile(name, root = join(dirname(fileURLToPath(import.meta.url)), '..')) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`loadProfile: profile 名が不正: ${name}`);
  const path = join(root, 'schema', 'profiles', `${name}.yaml`);
  if (!existsSync(path)) throw new Error(`loadProfile: 段階表が見つからない: ${path}`);
  return loadYaml(path);
}

function checkProfile(profile) {
  if (profile == null || typeof profile !== 'object') throw new TypeError('applyProfile: profile (段階表) が必要');
  const axes = profile.axes;
  if (axes == null || typeof axes !== 'object' || Object.keys(axes).length === 0) throw new TypeError('applyProfile: profile.axes (段階表) が空か無い');
  if (typeof profile.revision !== 'string' || profile.revision === '') throw new TypeError('applyProfile: profile.revision が必要 (どの版の段階表を当てたか記録するため)');
  for (const [k, steps] of Object.entries(axes)) {
    if (!CORE_AXES.includes(k) && !DYNAMIC_AXES.includes(k)) throw new TypeError(`applyProfile: 未知の軸 ${k}`);
    if (!Array.isArray(steps) || steps.length === 0) throw new TypeError(`applyProfile: 軸 ${k} の段階が無い`);
    for (const s of steps) {
      if (s?.when == null || typeof s.when !== 'object' || Object.keys(s.when).length === 0) throw new TypeError(`applyProfile: 軸 ${k} の段に when が無い`);
      if (!isNum(s.points) || s.points < 0 || (k in CORE_MAX && s.points > CORE_MAX[k])) {
        throw new RangeError(`applyProfile: 軸 ${k} の points (${s.points}) が範囲外 (0〜${CORE_MAX[k] ?? '∞'})`);
      }
    }
  }
}

const matches = (when, facts) => Object.entries(when).every(([key, want]) => {
  if (!(key in facts)) return false;
  return Array.isArray(want) ? want.includes(facts[key]) : facts[key] === want;
});

// 観測事実に段階表を当てる。段階表に無いコア軸と、必要な事実が未観測の軸は null + 'unknown' (0 点ではない)。
// 事実は観測されたのに段階表のどの段にも当たらないときは、unknown に落とさず失敗する (表の穴を隠さない)。
export function applyProfile(facts, profile) {
  if (facts == null || typeof facts !== 'object') throw new TypeError('applyProfile: facts が必要');
  checkProfile(profile);
  const axes = {};
  const provenance = {};
  for (const k of [...CORE_AXES, ...DYNAMIC_AXES]) {
    const steps = profile.axes[k];
    if (!steps) {
      if (CORE_AXES.includes(k)) { axes[k] = null; provenance[k] = 'unknown'; }
      continue;
    }
    const hit = steps.find((s) => matches(s.when, facts));
    if (hit) { axes[k] = hit.points; provenance[k] = 'measured'; continue; }
    const keys = new Set(steps.flatMap((s) => Object.keys(s.when)));
    if ([...keys].some((key) => key in facts)) {
      throw new Error(`applyProfile: 軸 ${k} は事実 (${[...keys].filter((x) => x in facts).map((x) => `${x}=${facts[x]}`).join(', ')}) が観測されているのに段階表のどの段にも当たらない`);
    }
    axes[k] = null;
    provenance[k] = 'unknown';
  }
  return { axes, provenance, profile_revision: profile.revision };
}

// ---- score ----

// 1 行 (配信元) の axes / provenance を検査して返す。不整合は黙って通さない。
function normalizeRow(p) {
  if (p == null || typeof p !== 'object') throw new TypeError('score: publisher が必要');
  if (p.facts && !p.axes) throw new Error('score: facts があるのに axes が無い (先に applyProfile で点数を出す)');
  const axes = p.axes ?? {};
  const prov = p.provenance ?? {};
  const out = {};
  const provOut = {};
  for (const k of [...CORE_AXES, ...DYNAMIC_AXES]) {
    const v = axes[k];
    const has = v !== undefined && v !== null;
    const pv = prov[k];
    if (has) {
      if (!isNum(v) || v < 0 || (k in CORE_MAX && v > CORE_MAX[k])) throw new RangeError(`score: 軸 ${k} の点数 (${v}) が範囲外`);
      if (pv === undefined) throw new Error(`score: 軸 ${k} に点数があるのに provenance が無い`);
      if (pv === 'unknown') throw new Error(`score: 軸 ${k} は unknown なのに点数がある (unknown は値を持たない)`);
      out[k] = v; provOut[k] = pv;
    } else {
      if (pv !== undefined && pv !== 'unknown') throw new Error(`score: 軸 ${k} の由来が ${pv} なのに点数が無い`);
      // コア軸の記載なしは未調査。追加軸の記載なしは「その行にその軸が無い」(静的領域) として区別する。
      if (CORE_AXES.includes(k) || pv === 'unknown' || axes[k] === null) { out[k] = null; provOut[k] = 'unknown'; }
    }
  }
  return { axes: out, prov: provOut };
}

// 点数からコア合計とランクを出す。段階表は知らない。
// total は 5 軸すべてが値を持つときだけ。1 軸でも unknown なら null (部分和を出さない)。
// 追加軸 F/G は dynamic に併記するだけで、total には入れない (総合点は作らない: docs/index.md §8)。
export function score(publisher) {
  const { axes, prov } = normalizeRow(publisher);
  const core = Object.fromEntries(CORE_AXES.map((k) => [k, axes[k]]));
  const complete = CORE_AXES.every((k) => core[k] !== null);
  const total = complete ? CORE_AXES.reduce((s, k) => s + core[k], 0) : null;
  const dynamic = Object.fromEntries(DYNAMIC_AXES.filter((k) => k in axes).map((k) => [k, axes[k]]));
  // 実測でない軸 (推定・未調査) の一覧。measured / inherited は含めない。
  const estimated = [...CORE_AXES, ...DYNAMIC_AXES].filter((k) => k in prov && (prov[k] === 'estimated' || prov[k] === 'unknown')).join(',');
  return { core: { ...core, total, rank: total === null ? null : rankOf(total) }, dynamic, estimated };
}

// ---- aggregate ----

const mean = (xs) => (xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10);

// 集計 (docs/index.md §4)。公開値には measured のみを含め、母数を併記する。
//   axes[k]  … 軸単位で measured のみ。n=分子, n_total=母数 (その軸を持つ行)
//   n, total … 5 軸すべて measured の行のみ。n_total=全行
// コアと追加軸を合算した値は作らない。
export function aggregate(publishers) {
  if (!Array.isArray(publishers)) throw new TypeError('aggregate: publishers (配列) が必要');
  const rows = publishers.map((p) => ({ ...normalizeRow(p), s: score(p) }));
  const axesOut = {};
  for (const k of [...CORE_AXES, ...DYNAMIC_AXES]) {
    const applicable = rows.filter((r) => k in r.prov);
    const measured = applicable.filter((r) => r.prov[k] === 'measured').map((r) => r.axes[k]);
    axesOut[k] = { n: measured.length, n_total: applicable.length, mean: mean(measured) };
  }
  const full = rows.filter((r) => CORE_AXES.every((k) => r.prov[k] === 'measured'));
  const ranks = Object.fromEntries(RANK_LABELS.map((r) => [r, 0]));
  for (const r of full) ranks[r.s.core.rank] += 1;
  return {
    n: full.length,
    n_total: rows.length,
    total: { mean: mean(full.map((r) => r.s.core.total)), ranks },
    axes: axesOut,
  };
}

// ---- CLI: municipalities/**/assessments/*.yaml → docs/scores.csv ----

const csvCell = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));

export function collectRows(root) {
  const rows = [];
  const profiles = new Map();
  for (const { dir } of listMunicipalityDirs(root)) {
    const adir = join(dir, 'assessments');
    if (!existsSync(adir)) continue;
    for (const f of readdirSync(adir).filter((n) => /\.ya?ml$/i.test(n)).sort()) {
      const a = loadYaml(join(adir, f));
      for (const p of a.publishers ?? []) {
        let row = p;
        if (p.facts && !p.axes) {
          // 点数がまだ無い行は、段階表を当てて出す。段階表が無ければ loadProfile が失敗する。
          if (!p.profile) throw new Error(`${p.id}: facts があるのに profile が無く、段階表を選べない`);
          if (!profiles.has(p.profile)) profiles.set(p.profile, loadProfile(p.profile, root));
          const r = applyProfile(p.facts, profiles.get(p.profile));
          row = { ...p, axes: r.axes, provenance: r.provenance };
        }
        rows.push({ id: p.id, domain: a.domain, row });
      }
    }
  }
  return rows;
}

export function toCsv(rows) {
  const head = ['publisher_id', 'domain', ...CORE_AXES, 'total', 'rank', ...DYNAMIC_AXES, 'provenance', 'estimated'];
  const lines = [head.join(',')];
  for (const { id, domain, row } of rows) {
    const s = score(row);
    const { prov } = normalizeRow(row);
    const provStr = Object.entries(prov).map(([k, v]) => `${k}:${v}`).join(';');
    lines.push([id, domain, ...CORE_AXES.map((k) => s.core[k]), s.core.total, s.core.rank, ...DYNAMIC_AXES.map((k) => s.dynamic[k] ?? null), provStr, s.estimated].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const rows = collectRows(root);
  writeFileSync(join(root, 'docs', 'scores.csv'), toCsv(rows));
  const agg = aggregate(rows.map((r) => r.row));
  console.log(`score: ${rows.length} 行 → docs/scores.csv`);
  console.log(`  コア合計: ${agg.n}/${agg.n_total} 行が 5 軸すべて measured (平均 ${agg.total.mean ?? '—'})`);
  for (const [k, v] of Object.entries(agg.axes)) if (v.n_total > 0) console.log(`  ${k}: measured ${v.n}/${v.n_total} (平均 ${v.mean ?? '—'})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
