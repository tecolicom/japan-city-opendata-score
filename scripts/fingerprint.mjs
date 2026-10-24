// 判定層。取得済みの HTML と応答ヘッダだけを見て CMS family を当てる。
// **ここはネットワークに出ない。** 取得の礼儀は scripts/_lib/fetch.mjs の責務。
//
// 判定規則はコードに持たない。`families/<id>.yaml` の `signals` (痕跡の文字列) と
// `min_signals` (当たりとみなす本数) が正典で、ここはそれを読んで数えるだけ。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadYaml } from './_lib/lib.mjs';

export const DEFAULT_FAMILIES_DIR = 'families';
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
