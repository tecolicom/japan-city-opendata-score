// assessment の意味検査。JSON Schema では書けない「別フィールドとの整合」をここで持つ
// (family-check.mjs の先例に倣う)。schema を通った assessment に対して呼ぶ。
//
// ctx: { handle }                       … このファイルが置かれた自治体ディレクトリの handle (必須)
//      { domains, families }            … 任意。渡されれば領域の存在・プロファイル・継承元の実在も検査する
//        domains: Map<id, {profile}>、families: Map<id, family>

const AXES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const DAY = (s) => Date.parse(`${s}T00:00:00Z`);

export function assessmentSemanticErrors(a, ctx) {
  const errors = [];
  const { handle } = ctx;
  const profile = ctx.domains?.get(a.domain)?.profile;
  if (ctx.domains && !ctx.domains.has(a.domain)) errors.push(`domain が domains.yaml に無い: ${a.domain}`);

  const ids = new Set();
  for (const p of a.publishers ?? []) {
    const at = `publishers[${p.id}]`;
    if (ids.has(p.id)) errors.push(`${at}: id が重複`);
    ids.add(p.id);
    if (p.id.split('/')[0] !== handle) errors.push(`${at}: id の接頭辞が置かれた handle (${handle}) と違う`);
    if (p.shared_with && !p.shared_with.includes(handle)) errors.push(`${at}: shared_with に所有 handle (${handle}) が無い`);
    try {
      if (new URL(p.url).hostname !== p.domain_name) errors.push(`${at}: domain_name (${p.domain_name}) が url のホストと違う`);
    } catch { errors.push(`${at}: url を解釈できない`); }
    if (p.last_success_at && p.observed_at && DAY(p.last_success_at) > DAY(p.observed_at)) {
      errors.push(`${at}: last_success_at が observed_at より後`);
    }

    if (p.derived_at && p.observed_at && DAY(p.derived_at) < DAY(p.observed_at)) {
      errors.push(`${at}: derived_at が observed_at より前 (導出は観測の後)`);
    }

    const axes = p.axes ?? {};
    const prov = p.provenance ?? {};
    for (const k of AXES) {
      const has = axes[k] !== undefined && axes[k] !== null;
      if (has && prov[k] === undefined) errors.push(`${at}: 軸 ${k} に点数があるのに provenance が無い`);
      if (has && prov[k] === 'unknown') errors.push(`${at}: 軸 ${k} は unknown なのに点数がある (unknown は値を持たない)`);
      if (!has && prov[k] !== undefined && prov[k] !== 'unknown') errors.push(`${at}: 軸 ${k} の由来が ${prov[k]} なのに点数が無い`);
      if (prov[k] !== undefined && axes[k] === undefined) errors.push(`${at}: 軸 ${k} に provenance だけがあり axes に無い (null で明示する)`);
      if ((k === 'F' || k === 'G') && profile === 'static' && (has || prov[k] !== undefined)) {
        errors.push(`${at}: 静的領域に追加軸 ${k} は無い`);
      }
    }

    if (p.inherited_from) {
      if (!Object.values(prov).includes('inherited')) errors.push(`${at}: inherited_from があるのに inherited の軸が無い`);
      const fam = ctx.families?.get(p.inherited_from.family_id);
      if (ctx.families) {
        if (!fam) errors.push(`${at}: inherited_from.family_id が families/ に無い: ${p.inherited_from.family_id}`);
        else if (!fam.measured_representatives.some((m) => m.handle === p.inherited_from.representative_handle)) {
          errors.push(`${at}: ${p.inherited_from.representative_handle} は ${fam.id} の代表実測ではない`);
        }
      }
    }
  }
  return errors;
}
