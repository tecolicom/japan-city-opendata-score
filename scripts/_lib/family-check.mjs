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

/**
 * web.yaml の意味検査。family_confidence は書き手の判断ではなく導出値で、
 * signals_seen と family の min_signals から thresholdBasis と同じ規則で決まる。
 * families: Map<id, family>
 */
export function webSemanticErrors(web, families) {
  const errors = [];
  if (web.family_id == null) {
    if (web.family_confidence !== 'none') errors.push('family_id が null なのに family_confidence が none ではない');
    if (web.signals_seen.length > 0) errors.push('family_id が null なのに signals_seen がある');
    return errors;
  }
  const family = families.get(web.family_id);
  if (!family) return [`family_id が families/ に無い: ${web.family_id}`];
  const known = new Set(family.signals ?? []);
  const seen = new Set();
  for (const { signal } of web.signals_seen) {
    if (seen.has(signal)) errors.push(`signals_seen に重複した signal: ${signal}`);
    seen.add(signal);
    if (!known.has(signal)) errors.push(`signals_seen に family の signals に無い値: ${signal}`);
  }
  const basis = thresholdBasis(family, { signals_seen: web.signals_seen });
  if (web.family_confidence !== basis) errors.push(`family_confidence (${web.family_confidence}) が導出値 (${basis}) と違う`);
  return errors;
}

// web.yaml の url とレジストリの website の整合。レジストリと違う URL を使うなら、レジストリの値と根拠 (url_note) が要る。
// 逆に、同じなのに registry_website があるのも誤り。URL の比較は正規化 (末尾スラッシュ等) してから行う。
const norm = (u) => { try { return new URL(u).href; } catch { return u; } };
export function webUrlErrors(web, registryWebsite) {
  const same = norm(web.url) === norm(registryWebsite);
  if (same) return web.registry_website ? ['url がレジストリの website と同じなのに registry_website がある'] : [];
  if (!web.registry_website) return [`url (${web.url}) がレジストリの website (${registryWebsite}) と違うのに registry_website / url_note が無い`];
  if (norm(web.registry_website) !== norm(registryWebsite)) return [`registry_website (${web.registry_website}) がレジストリの website (${registryWebsite}) と一致しない`];
  return [];
}
