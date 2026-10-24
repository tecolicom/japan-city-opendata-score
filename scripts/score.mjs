// 採点。責務を 3 つに分ける (docs/index.md §3.1, §6):
//   applyProfile … 観測事実 (facts) に段階表を当てて軸の点数と由来を出す。段階表は schema/profiles/<name>.yaml
//   score        … 点数からコア合計とランクを出すだけ。段階表を知らない
//   aggregate    … measured のみを分子にした集計。母数を併記する
// 判定の段差 (何が何点か) はコードに埋め込まない。コードが持つのは、コア共通の配点上限とランク閾値だけ。
//
// 必要な入力 (段階表・プロファイル) が無いときは、黙って素通りせず例外で失敗する。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import { loadYaml, listMunicipalityDirs } from './_lib/lib.mjs';

// コア 5 軸の配点 (docs/index.md §2。変えない)。F/G の尺度は段階表 (schema/profiles/dynamic.yaml) が持ち、コアには足さない。
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

export function checkProfile(profile) {
  if (profile == null || typeof profile !== 'object') throw new TypeError('applyProfile: profile (段階表) が必要');
  const axes = profile.axes;
  if (axes == null || typeof axes !== 'object' || Object.keys(axes).length === 0) throw new TypeError('applyProfile: profile.axes (段階表) が空か無い');
  if (typeof profile.revision !== 'string' || profile.revision === '') throw new TypeError('applyProfile: profile.revision が必要 (どの版の段階表を当てたか記録するため)');
  for (const [k, steps] of Object.entries(axes)) {
    if (!CORE_AXES.includes(k) && !DYNAMIC_AXES.includes(k)) throw new TypeError(`applyProfile: 未知の軸 ${k}`);
    if (!Array.isArray(steps) || steps.length === 0) throw new TypeError(`applyProfile: 軸 ${k} の段階が無い`);
    for (const s of steps) {
      if (s?.when == null || typeof s.when !== 'object' || Object.keys(s.when).length === 0) throw new TypeError(`applyProfile: 軸 ${k} の段に when が無い`);
      // points: null は『観測はあるがこの軸の根拠にならない』(軸は null + unknown になる)
      if (s.points !== null && (!isNum(s.points) || s.points < 0 || (k in CORE_MAX && s.points > CORE_MAX[k]))) {
        throw new RangeError(`applyProfile: 軸 ${k} の points (${s.points}) が範囲外 (0〜${CORE_MAX[k] ?? '∞'})`);
      }
      if (s.basis !== undefined && !['observed', 'design'].includes(s.basis)) throw new TypeError(`applyProfile: 軸 ${k} の basis が不正: ${s.basis}`);
      if (s.provenance !== undefined && !['measured', 'estimated'].includes(s.provenance)) throw new TypeError(`applyProfile: 軸 ${k} の provenance が不正: ${s.provenance}`);
      if (DYNAMIC_AXES.includes(k) && s.basis === undefined) throw new TypeError(`applyProfile: 追加軸 ${k} の段には basis (observed か design) が要る (裏付けの有無を隠さない)`);
      if (s.provenance === 'estimated' && !s.note) throw new TypeError(`applyProfile: 軸 ${k} の estimated の段には note (根拠) が要る`);
    }
  }
  if (axes.G && profile.axis_aliases?.G !== 'g_proxy') throw new TypeError('applyProfile: G 軸を持つ段階表は axis_aliases.G: g_proxy が要る (単発訪問の代理指標であることを名前に残す)');
  if (profile.caps !== undefined) checkCaps(profile.caps, 'applyProfile');
}

// キャップ規則 [{when, max}]。段階表ではなく、合計後に掛ける上限。条件の語彙 (facts のキー) は領域プロファイルが決める。
// when は段階表の when と同じ評価 (全キー一致、値が配列なら any-of)。事実が未観測なら当たらない。
export function checkCaps(caps, who) {
  if (!Array.isArray(caps)) throw new TypeError(`${who}: caps は配列 [{when, max}] でなければならない`);
  for (const c of caps) {
    if (c == null || typeof c !== 'object' || Array.isArray(c)) throw new TypeError(`${who}: caps の要素はオブジェクトでなければならない`);
    for (const key of Object.keys(c)) if (key !== 'when' && key !== 'max') throw new TypeError(`${who}: caps に未知のキー ${key}`);
    if (c.when == null || typeof c.when !== 'object' || Array.isArray(c.when) || Object.keys(c.when).length === 0) throw new TypeError(`${who}: caps の when が無い/空`);
    if (!isNum(c.max) || c.max < 0 || c.max > 100) throw new RangeError(`${who}: caps の max (${c.max}) は 0〜100 の整数でなければならない`);
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
  const notes = [];
  for (const k of [...CORE_AXES, ...DYNAMIC_AXES]) {
    const steps = profile.axes[k];
    if (!steps) {
      if (CORE_AXES.includes(k)) { axes[k] = null; provenance[k] = 'unknown'; }
      continue;
    }
    const hit = steps.find((s) => matches(s.when, facts));
    if (hit) {
      if (hit.points === null) { axes[k] = null; provenance[k] = 'unknown'; continue; }
      axes[k] = hit.points; provenance[k] = hit.provenance ?? 'measured';
      if (hit.provenance === 'estimated') notes.push(`${k}: ${hit.note}`);
      continue;
    }
    const keys = new Set(steps.flatMap((s) => Object.keys(s.when)));
    if ([...keys].some((key) => key in facts)) {
      throw new Error(`applyProfile: 軸 ${k} は事実 (${[...keys].filter((x) => x in facts).map((x) => `${x}=${facts[x]}`).join(', ')}) が観測されているのに段階表のどの段にも当たらない`);
    }
    axes[k] = null;
    provenance[k] = 'unknown';
  }
  return { axes, provenance, ...(notes.length > 0 ? { notes } : {}), profile_revision: profile.revision, ...(profile.caps ? { caps: profile.caps } : {}) };
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
// options.caps (任意): キャップ規則 [{when, max}]。渡されなければ上限なし。形式が不正なら例外 (黙って無視しない)。
// 当たった上限の最小を、合計が下がるときだけ適用する。ランクは上限後の合計で決める。total が null の行には掛けない。
export function score(publisher, options = {}) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('score: options はオブジェクトでなければならない');
  for (const key of Object.keys(options)) if (key !== 'caps') throw new TypeError(`score: options に未知のキー ${key}`);
  const caps = options.caps ?? [];
  checkCaps(caps, 'score');
  const { axes, prov } = normalizeRow(publisher);
  const core = Object.fromEntries(CORE_AXES.map((k) => [k, axes[k]]));
  const complete = CORE_AXES.every((k) => core[k] !== null);
  const raw = complete ? CORE_AXES.reduce((s, k) => s + core[k], 0) : null;
  const facts = publisher.facts ?? {};
  const limits = caps.filter((c) => matches(c.when, facts)).map((c) => c.max);
  const limit = limits.length > 0 ? Math.min(...limits) : null;
  const capped = raw !== null && limit !== null && limit < raw;
  const total = capped ? limit : raw;
  const dynamic = Object.fromEntries(DYNAMIC_AXES.filter((k) => k in axes).map((k) => [k, axes[k]]));
  // 実測でない軸 (推定・未調査) の一覧。measured / inherited は含めない。
  const estimated = [...CORE_AXES, ...DYNAMIC_AXES].filter((k) => k in prov && (prov[k] === 'estimated' || prov[k] === 'unknown')).join(',');
  return { core: { ...core, total, rank: total === null ? null : rankOf(total), capped_at: capped ? limit : null }, dynamic, estimated };
}

// ---- aggregate ----

const mean = (xs) => (xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10);

// 集計 (docs/index.md §4)。公開値には measured のみを含め、母数を併記する。
//   axes[k]  … 軸単位で measured のみ。n=分子, n_total=母数 (その軸を持つ行)
//   n, total … 5 軸すべて measured の行のみ。n_total=全行
// コアと追加軸を合算した値は作らない。
export function aggregate(publishers, options = {}) {
  if (!Array.isArray(publishers)) throw new TypeError('aggregate: publishers (配列) が必要');
  const rows = publishers.map((p) => ({ ...normalizeRow(p), s: score(p, options) }));
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

// 領域の profile 名 (schema/domains.yaml)。null は未判定、'static' は段階表を本 repo に持たない (docs/index.md §6)。
export function domainProfiles(root) {
  return new Map(loadYaml(join(root, 'schema', 'domains.yaml')).domains.map((d) => [d.id, d.profile ?? null]));
}

// 領域の profile から、この行に使う段階表を決める。
//   dynamic など … schema/profiles/<name>.yaml を読む (無ければ loadProfile が失敗する)
//   static       … 段階表は japan-gomi-data 側が持つ。本 repo は読まず、キャップも持たない。axes が既にある行だけ通し、
//                  facts から導出する行は失敗する (導出できる段階表が無い)
//   null (未判定) … axes を書けない領域。facts だけの行は失敗する
function profileFor(p, domain, domains, profiles, root) {
  const name = p.profile ?? domains.get(domain) ?? null;
  if (name === null) {
    if (p.facts && !p.axes) throw new Error(`${p.id}: 領域 ${domain} はプロファイル未判定なので、facts から axes を導出できない`);
    return null;
  }
  if (name === 'static') {
    if (p.facts && !p.axes) throw new Error(`${p.id}: static 領域の段階表は japan-gomi-data 側にあり、本 repo では facts から導出できない (axes を書く)`);
    return null;
  }
  if (!profiles.has(name)) profiles.set(name, loadProfile(name, root));
  return profiles.get(name);
}

export function collectRows(root) {
  const rows = [];
  const profiles = new Map();
  const domains = domainProfiles(root);
  for (const { dir } of listMunicipalityDirs(root)) {
    const adir = join(dir, 'assessments');
    if (!existsSync(adir)) continue;
    for (const f of readdirSync(adir).filter((n) => /\.ya?ml$/i.test(n)).sort()) {
      const a = loadYaml(join(adir, f));
      for (const p of a.publishers ?? []) {
        const profile = profileFor(p, a.domain, domains, profiles, root);
        let row = p;
        if (p.facts && !p.axes) {
          // 点数がまだ無い行は、段階表を当てて出す (保存はしない。保存は --apply-profile)。
          const r = applyProfile(p.facts, profile);
          row = { ...p, axes: r.axes, provenance: r.provenance, profile: profile.profile };
        }
        rows.push({ id: p.id, domain: a.domain, row, caps: profile?.caps });
      }
    }
  }
  return rows;
}

// 段階表の basis と実データの突き合わせ。facts の行 (publishers) を段に当て、
//   basis: observed の段に当たる行が 0 件 … 観測の裏付けが無いのに有るように見える
//   basis: design の段に当たる行が 1 件以上 … 観測が付いたのに『未検証』のまま
// のどちらも誤りとして返す。
export function profileBasisErrors(profile, publishers) {
  const errors = [];
  for (const [k, steps] of Object.entries(profile.axes)) {
    if (!DYNAMIC_AXES.includes(k)) continue;
    const hits = steps.map(() => 0);
    for (const p of publishers) {
      if (!p.facts) continue;
      const i = steps.findIndex((s) => matches(s.when, p.facts));
      if (i >= 0) hits[i] += 1;
    }
    steps.forEach((s, i) => {
      const at = `${profile.profile} 軸 ${k} の段 ${JSON.stringify(s.when)}`;
      if (s.basis === 'observed' && hits[i] === 0) errors.push(`${at}: basis: observed だが実データが 1 件も当たらない (裏付けが無い)`);
      if (s.basis === 'design' && hits[i] > 0) errors.push(`${at}: basis: design だが実データが ${hits[i]} 件当たっている (observed に改める)`);
    });
  }
  return errors;
}

// 保存済みの axes が、いまの段階表を facts に当てた結果と一致するか。
// axes は導出値なので、段階表を変えたのに再導出していない (版の上げ忘れ・当て直し忘れ) をここで拾う。
// 段階表が定義する軸だけを比べる (他の軸は人が書いた値かもしれない)。inherited の軸は継承元の値なので比べない。
export function derivedAxesErrors(p, profile) {
  if (!p.axes || !p.facts) return [];
  const errors = [];
  if (p.profile_revision !== profile.revision) {
    errors.push(`profile_revision (${p.profile_revision}) が段階表 ${profile.profile} の版 (${profile.revision}) と違う (npm run apply-profile で当て直す)`);
  }
  let r;
  try { r = applyProfile(p.facts, profile); } catch (e) { return [...errors, e.message]; }
  for (const k of Object.keys(profile.axes)) {
    if (p.provenance?.[k] === 'inherited') continue;
    if ((p.axes[k] ?? null) !== r.axes[k] || (p.provenance?.[k] ?? 'unknown') !== r.provenance[k]) {
      errors.push(`軸 ${k} の保存値 (${p.axes[k] ?? null}/${p.provenance?.[k]}) が段階表を当てた結果 (${r.axes[k]}/${r.provenance[k]}) と違う (npm run apply-profile で当て直す)`);
    }
  }
  return errors;
}

// 追加軸の列名: G は代理指標版なので g_proxy と書く (時系列版の G と取り違えさせない)。
const axisLabel = (k) => (k === 'G' ? 'g_proxy' : k);

export function toCsv(rows) {
  const head = ['publisher_id', 'domain', ...CORE_AXES, 'total', 'rank', ...DYNAMIC_AXES.map(axisLabel), 'provenance', 'estimated'];
  const lines = [head.join(',')];
  for (const { id, domain, row, caps } of rows) {
    const s = score(row, { caps });
    const { prov } = normalizeRow(row);
    const provStr = Object.entries(prov).map(([k, v]) => `${k}:${v}`).join(';');
    lines.push([id, domain, ...CORE_AXES.map((k) => s.core[k]), s.core.total, s.core.rank, ...DYNAMIC_AXES.map((k) => s.dynamic[k] ?? null), provStr, s.estimated].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// facts の分布 (段階表を書く前に、観測がどの値にどれだけあるかを見る)。
// 観測が 0 件の値は出ない = 段階表のその段は実測の裏付けを持てない。
export function distribution(publishers) {
  const out = {};
  for (const p of publishers) {
    for (const [k, v] of Object.entries(p.facts ?? {})) {
      if (typeof v === 'string' && v.length > 20) continue; // 自由記述は分布にしない
      out[k] ??= {};
      out[k][String(v)] = (out[k][String(v)] ?? 0) + 1;
    }
  }
  return { n_total: publishers.length, facts: out };
}

function prefOf() {
  const i = process.argv.indexOf('--pref');
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ---- --apply-profile: facts → axes を assessment ファイルに書き戻す ----

const NOTE_PREFIX = '推定の根拠 — ';
const today = () => new Date().toISOString().slice(0, 10);

// 1 ファイルに段階表を当てて書き戻す。コメントと整形は保つ (yaml の Document API)。
// 対象は『facts があり、領域の profile が段階表を持つ』行だけ。static は触らない。
// 既に同じ版で同じ結果なら何も変えない (derived_at を無駄に動かさない)。変更した配信元 id の配列を返す。
export function applyProfileToFile(path, root, { derivedAt = today() } = {}) {
  const doc = parseDocument(readFileSync(path, 'utf8'));
  const a = doc.toJS();
  const domains = domainProfiles(root);
  const profiles = new Map();
  const changed = [];
  (a.publishers ?? []).forEach((p, i) => {
    if (!p.facts) return;
    const name = p.profile ?? domains.get(a.domain) ?? null;
    if (name === null || name === 'static') return;
    if (!profiles.has(name)) profiles.set(name, loadProfile(name, root));
    const profile = profiles.get(name);
    const r = applyProfile(p.facts, profile);
    const same = p.profile_revision === profile.revision && JSON.stringify(p.axes) === JSON.stringify(r.axes) && JSON.stringify(p.provenance) === JSON.stringify(r.provenance);
    if (same) return;
    const at = (k) => ['publishers', i, k];
    doc.setIn(at('axes'), doc.createNode(r.axes));
    doc.setIn(at('provenance'), doc.createNode(r.provenance));
    doc.setIn(at('derived_at'), derivedAt);
    doc.setIn(at('profile'), profile.profile);
    doc.setIn(at('profile_revision'), profile.revision);
    const gen = r.notes ? `${NOTE_PREFIX}${r.notes.join(' / ')}` : null;
    if (gen) {
      if (p.notes && !p.notes.startsWith(NOTE_PREFIX)) throw new Error(`${p.id}: 既存の notes を上書きしない (推定の根拠は手で足す): ${path}`);
      doc.setIn(at('notes'), gen);
    } else if (p.notes?.startsWith(NOTE_PREFIX)) doc.deleteIn(at('notes'));
    changed.push(p.id);
  });
  if (changed.length > 0) writeFileSync(path, String(doc));
  return changed;
}

function assessmentFiles(root, pref) {
  const files = [];
  for (const m of listMunicipalityDirs(root).filter((x) => !pref || x.pref === pref)) {
    const adir = join(m.dir, 'assessments');
    if (!existsSync(adir)) continue;
    for (const f of readdirSync(adir).filter((n) => /\.ya?ml$/i.test(n)).sort()) files.push(join(adir, f));
  }
  return files;
}

function main() {
  const root0 = join(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--apply-profile')) {
    const pref = prefOf();
    const files = assessmentFiles(root0, pref);
    const changed = files.flatMap((f) => applyProfileToFile(f, root0));
    console.log(`apply-profile: ${files.length} ファイル中 ${changed.length} 配信元の axes を更新${changed.length > 0 ? ` (${changed.join(', ')})` : ' (差分なし)'}`);
    return;
  }
  if (process.argv.includes('--distribution')) {
    const root = root0;
    const pref = prefOf();
    const dirs = listMunicipalityDirs(root).filter((m) => !pref || m.pref === pref);
    const pubs = assessmentFiles(root, pref).flatMap((f) => loadYaml(f).publishers ?? []);
    const d = distribution(pubs);
    console.log(`distribution: ${dirs.length} 自治体 / assessment の配信元 ${d.n_total} 件${pref ? ` (pref=${pref})` : ''}`);
    for (const [k, vs] of Object.entries(d.facts)) console.log(`  ${k}: ${Object.entries(vs).map(([v, n]) => `${v}=${n}`).join(' / ')} (観測 ${Object.values(vs).reduce((a, b) => a + b, 0)}/${d.n_total})`);
    for (const k of ['conditional_get', 'feed_format', 'stable_url', 'edition_label', 'license_text', 'standard_od', 'feed_http_status', 'conditional_get_scope', 'feed_url_basis']) if (!(k in d.facts)) console.log(`  ${k}: 観測 0/${d.n_total} (未観測)`);
    return;
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const rows = collectRows(root);
  writeFileSync(join(root, 'docs', 'scores.csv'), toCsv(rows));
  console.log(`score: ${rows.length} 行 → docs/scores.csv`);
  // キャップは profile ごとに違うので、集計も profile ごとに行う (profile 不明の行は上限なし)。
  const groups = Map.groupBy(rows, (r) => r.row.profile ?? '(profile なし)');
  for (const [name, rs] of groups) {
    const agg = aggregate(rs.map((r) => r.row), { caps: rs[0].caps });
    console.log(`[${name}] コア合計: ${agg.n}/${agg.n_total} 行が 5 軸すべて measured (平均 ${agg.total.mean ?? '—'})`);
    for (const [k, v] of Object.entries(agg.axes)) if (v.n_total > 0) console.log(`  ${axisLabel(k)}: measured ${v.n}/${v.n_total} (平均 ${v.mean ?? '—'})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
