// 判定層。取得済みの HTML と応答ヘッダだけを見て CMS family を当てる。
// **ここはネットワークに出ない。** 取得の礼儀は scripts/_lib/fetch.mjs の責務。
//
// 判定規則はコードに持たない。`families/<id>.yaml` の `signals` (痕跡の文字列) と
// `min_signals` (当たりとみなす本数) が正典で、ここはそれを読んで数えるだけ。
import { existsSync, readdirSync } from 'node:fs';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml } from './_lib/lib.mjs';
import { thresholdBasis } from './_lib/family-check.mjs';
import { politeFetch } from './_lib/fetch.mjs';
import { DEFAULT_REGISTRY, loadRecords, prefDirOf, siteUrlOf } from './_lib/municipality.mjs';
import { stringify } from 'yaml';

// 既定は repo ルートの families/。cwd 相対にすると、repo ルート以外から呼ばれたときに
// 黙って 0 件になり、全自治体が familyId: null になってもエラーが出ない。
export const DEFAULT_FAMILIES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'families');
// family が min_signals を書いていないときの閾値。
// 1 本の偶然一致で family を名乗らせたくないので 2 本を既定とする。
export const DEFAULT_MIN_SIGNALS = 2;

// families ディレクトリの YAML を読む。
// readdirSync はドットファイル (macOS の .DS_Store 等) も返すので必ず除外する。
// .gitignore に在っても readdirSync は見ない。
export function loadFamilies(familiesDir = DEFAULT_FAMILIES_DIR) {
  if (!existsSync(familiesDir)) return [];
  return readdirSync(familiesDir)
    .filter((name) => !name.startsWith('.') && /\.ya?ml$/i.test(name))
    .sort()
    .map((name) => loadYaml(join(familiesDir, name)))
    .filter((f) => f != null && typeof f.id === 'string' && Array.isArray(f.signals));
}

// 痕跡を探す対象。HTML 本文に、応答ヘッダを `name: value` の行として足したもの。
function haystack(html, headers) {
  const lines = Object.entries(headers ?? {}).map(([k, v]) => `${String(k).toLowerCase()}: ${v}`);
  return `${String(html ?? '')}\n${lines.join('\n')}`;
}

const thresholdOf = (family) => (Number.isInteger(family.min_signals) && family.min_signals > 0
  ? family.min_signals
  : DEFAULT_MIN_SIGNALS);

/**
 * 指紋を採る。
 *
 * 返り値: `{signals, familyId}`
 *   signals  … 当たった痕跡の文字列 (既知 family 全体の和集合、重複なし・昇順)
 *   familyId … 閾値を満たした family が 1 つだけならその id。0 件または同数で並んだら null
 *
 * options:
 *   familiesDir … family YAML の置き場所 (既定 'families')
 *   families    … 読み込み済みの family 配列 (多数の自治体を回すときはこちらを使う)
 */
export function fingerprint(html, headers = {}, options = {}) {
  const { familiesDir = DEFAULT_FAMILIES_DIR, families = loadFamilies(familiesDir) } = options;
  const text = haystack(html, headers);
  const hits = families.map((f) => ({
    id: f.id,
    threshold: thresholdOf(f),
    matched: f.signals.filter((s) => typeof s === 'string' && s !== '' && text.includes(s)),
  }));

  const signals = [...new Set(hits.flatMap((h) => h.matched))].sort();
  const qualified = hits.filter((h) => h.matched.length >= h.threshold);
  if (qualified.length === 0) return { signals, familyId: null };

  const best = Math.max(...qualified.map((h) => h.matched.length));
  const top = qualified.filter((h) => h.matched.length === best);
  // 同数で並んだら「どちらとも言わない」。推測で family を付けない。
  return { signals, familyId: top.length === 1 ? top[0].id : null };
}

// ---- CLI ----
// node scripts/fingerprint.mjs --pref saitama --handles iruma,tokorozawa [--limit N] [--cache cache] [--registry <path>]
// 取得は politeFetch だけを通す (robots.txt・間隔 2 秒・直列化・キャッシュ)。トップページ 1 URL ずつ。
// _fetch に渡すのは実リクエストを記録するだけの薄い包みで、礼儀の層は迂回しない。
async function main() {
  const argOf = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const pref = argOf('--pref');
  if (!pref) { console.error('usage: fingerprint --pref <dir> [--handles a,b] [--limit N]'); process.exit(2); }
  const cacheDir = join(root, argOf('--cache') ?? 'cache');
  const records = loadRecords(argOf('--registry') ?? DEFAULT_REGISTRY);
  const wanted = argOf('--handles')?.split(',');
  let targets = records.filter((r) => r.type !== 'pref' && prefDirOf(r, records) === pref);
  if (wanted) targets = wanted.map((h) => targets.find((r) => r.handle === h) ?? (() => { throw new Error(`${pref} に ${h} は無い`); })());
  if (argOf('--limit')) targets = targets.slice(0, Number(argOf('--limit')));

  mkdirSync(cacheDir, { recursive: true });
  const requestLog = join(cacheDir, 'requests.jsonl');
  const loggedFetch = async (href, init) => {
    const t = Date.now();
    appendFileSync(requestLog, `${JSON.stringify({ t, iso: new Date(t).toISOString(), url: href })}\n`);
    return fetch(href, init);
  };
  const families = loadFamilies();
  const today = new Date().toISOString().slice(0, 10);
  const run = [];
  for (const r of targets) {
    const url = siteUrlOf(r);
    if (!url) { run.push({ handle: r.handle, status: 'no-verified-url' }); console.log(`${r.handle}\tno-verified-url`); continue; }
    let usedUrl = url;
    let res = await politeFetch(url, { cacheDir, _fetch: loggedFetch });
    // レジストリの website が 404/410 で、パスを持つなら、サイトのルートを 1 回だけ試す
    // (出典データの古い URL への観測に基づく代替。URL を推測で組み立てるのではない)。
    let fellBack = null;
    const u = new URL(url);
    if (res.status === 'http-error' && [404, 410].includes(res.httpStatus) && u.pathname !== '/') {
      fellBack = `${url} は HTTP ${res.httpStatus}`;
      usedUrl = `${u.origin}/`;
      res = await politeFetch(usedUrl, { cacheDir, _fetch: loggedFetch });
    }
    const entry = { handle: r.handle, url: usedUrl, registryUrl: url, status: res.status, httpStatus: res.httpStatus, fromCache: res.fromCache, finalUrl: res.url, redirects: res.redirects ?? [], reason: res.reason, cause: res.cause };
    if (res.status === 'ok') {
      const { signals, familyId } = fingerprint(res.body, res.headers, { families });
      const family = families.find((f) => f.id === familyId);
      // family が特定できなくても、当たった signal は残す。
      const pool = family ? new Set(family.signals) : null;
      const signals_seen = signals.filter((x) => !pool || pool.has(x))
        .map((signal) => ({ signal, method: res.body.includes(signal) ? 'html' : 'header' }));
      const rep = families.find((f) => (f.measured_representatives ?? []).some((m) => m.handle === r.handle));
      const repRec = rep?.measured_representatives.find((m) => m.handle === r.handle);
      const web = {
        handle: r.handle,
        url: usedUrl,
        ...(new URL(usedUrl).href === new URL(url).href ? {} : {
          registry_website: url,
          url_note: { observed_at: today, reason: `レジストリの website (${fellBack}) だったため、ルート ${usedUrl} を取得したところ HTTP ${res.httpStatus} だった。観測に基づく代替` },
        }),
        family_id: familyId,
        family_confidence: family ? thresholdBasis(family, { signals_seen }) : (signals_seen.length > 0 ? 'below' : 'none'),
        fingerprinted_at: today,
        signals_seen,
        ...(rep && rep.id !== familyId ? {
          family_divergence: {
            observed_at: today,
            reason: `自動指紋はトップページ HTML だけを読み、${rep.id} の signal は ${signals_seen.length} 本だった (閾値 ${rep.min_signals ?? 2})。family の代表実測 (${repRec.observed_at}) の根拠: ${repRec.evidence}。測っているものが違い、どちらも観測として正しい`,
          },
        } : {}),
      };
      const dir = join(root, 'municipalities', pref, r.handle);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'web.yaml'), stringify(web));
      Object.assign(entry, { familyId, signals, etag: 'etag' in res.headers, lastModified: 'last-modified' in res.headers });
    }
    run.push(entry);
    console.log(JSON.stringify(entry));
  }
  writeFileSync(join(cacheDir, `fingerprint-run-${pref}.json`), `${JSON.stringify(run, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
