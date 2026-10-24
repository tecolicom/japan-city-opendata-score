// レジストリ (city-tecoli-data/municipalities/municipalities.yaml) から、ディレクトリ名と取得先 URL を導く。
// pref ディレクトリ名は code から導く。取得先 URL はレジストリの website だけを使う (推測しない)。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
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

// 取得の起点はレジストリの website だけ。URL を handle から組み立てない (playbook.md / AGENTS.md の禁止事項。
// 過去に推測した URL が 3 件とも失敗した)。website が無ければ null を返し、呼び側は取得しない。
export function siteUrlOf(record) {
  return record.website ?? null;
}
