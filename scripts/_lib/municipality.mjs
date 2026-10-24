// レジストリ (city-tecoli-data/municipalities/municipalities.yaml) から、ディレクトリ名と取得先 URL を導く。
// レジストリは pref も website も持たない (2026-10-24 時点で website は 0 件)。どちらも code / handle / type から導く。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { loadYaml } from './lib.mjs';

export const DEFAULT_REGISTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'city-tecoli-data', 'municipalities', 'municipalities.yaml');

export function loadRecords(path = DEFAULT_REGISTRY) {
  if (!existsSync(path)) throw new Error(`レジストリが無い: ${path}`);
  return loadYaml(path);
}

// code の上位 2 桁が都道府県コード。同じコードの type: pref レコードの handle から -pref を外す。
export function prefDirOf(record, records) {
  const prefCode = `${String(record.code).slice(0, 2)}000`;
  const pref = records.find((r) => r.type === 'pref' && r.code === prefCode);
  if (!pref) throw new Error(`${record.handle}: 都道府県レコード (code ${prefCode}) がレジストリに無い`);
  return pref.handle.replace(/-pref$/, '');
}

// lg.jp の識別子は <type>.<label>.lg.jp。label は handle から -town/-village/-city を外したもの
// (同名衝突を避けるための接尾辞。例 moroyama-town → town.moroyama.lg.jp)。
// 推測で URL を作らず、build.mjs が JPRS WHOIS で確認した結果 (whois-cache.json) に
// 『実在し、組織名が name_ja と一致する』ものだけを取得の起点にする。無ければ null。
// ここで作る URL は起点で、移転先 (www. 付き等) は politeFetch が robots を確認しつつ追う。
const LG_TYPE = { city: 'city', town: 'town', village: 'vill' };
let whoisCache = null;
export function siteUrlOf(record, whoisPath = join(dirname(DEFAULT_REGISTRY), 'whois-cache.json')) {
  if (record.website) return record.website;
  const t = LG_TYPE[record.type];
  if (!t) return null;
  if (whoisCache === null) whoisCache = existsSync(whoisPath) ? JSON.parse(readFileSync(whoisPath, 'utf8')) : {};
  const label = record.handle.replace(/-(town|village|city)$/, '');
  const host = `${t}.${label}.lg.jp`;
  const w = whoisCache[host];
  return w?.ok && w.org === record.name_ja ? `https://${host}/` : null;
}
