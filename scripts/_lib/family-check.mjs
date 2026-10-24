// family の意味検査と派生値。JSON Schema では書けない「別フィールドとの整合」をここで持つ。
// (標準の JSON Schema では不可能。Ajv の `$data` 拡張なら可能かもしれないが非標準のため採らなかった。)

// 観測 (html/header) と推定 (inferred_from_status) を分ける。
const isObserved = (s) => s.method !== 'inferred_from_status';

export function familySemanticErrors(family) {
  const known = new Set(family.signals ?? []);
  const errors = [];
  for (const m of family.measured_representatives ?? []) {
    const seen = new Set();
    for (const { signal } of m.signals_seen ?? []) {
      // 同じ signal の二重記載は method が違っても重複。観測数 (thresholdBasis) を水増しできてしまう。
      if (seen.has(signal)) errors.push(`measured_representatives[${m.handle}].signals_seen に重複した signal: ${signal}`);
      seen.add(signal);
      if (!known.has(signal)) errors.push(`measured_representatives[${m.handle}].signals_seen に signals に無い値: ${signal}`);
    }
  }
  return errors;
}

/**
 * 代表実測 1 件が min_signals を満たす根拠の強さ。データから導出する (閾値ロジックは変えない)。
 *   'observed' … 観測だけで閾値を満たす
 *   'inferred' … 推定を数えて初めて閾値を満たす (観測だけでは足りない = 弱い)
 *   'below'    … 推定を含めても足りない
 */
export function thresholdBasis(family, rep) {
  const min = Number.isInteger(family.min_signals) && family.min_signals > 0 ? family.min_signals : 2;
  const all = rep.signals_seen.length;
  const observed = rep.signals_seen.filter(isObserved).length;
  if (observed >= min) return 'observed';
  return all >= min ? 'inferred' : 'below';
}
