// assessment の意味検査。JSON Schema では書けない「別フィールドとの整合」をここで持つ
// (family-check.mjs の先例に倣う)。schema を通った assessment に対して呼ぶ。
//
// ctx: { handle }                       … このファイルが置かれた自治体ディレクトリの handle (必須)
//      { domains }                      … 必須。領域の存在と、axes の profile が領域のプロファイルと一致するかを検査する
//      { profiles }                     … Map<name, 段階表>。axes を持つ非 static の配信元があるとき必須。
//        facts から段階表を当て直した結果と保存済み axes の一致、profile_revision の一致を検査する
//        (axes は導出値。段階表を変えて当て直し忘れると、古い点数が残る)
//      { families, web }                … families は inherited_from を持つ配信元があるとき必須。
//        web はその自治体の web.yaml (無ければ undefined)。inherited は web.yaml が存在し、
//        family_id が一致し、family_confidence が observed/inferred のときだけ書ける。
//        domains: Map<id, {profile}>、families: Map<id, family>
// 必須の依存が渡されていないときは検査を黙って飛ばさず、TypeError で失敗する
// (Task 7 で、依存の渡し忘れにより継承の検査が一度も効いていなかった事故の再発防止)。

import { derivedAxesErrors } from '../score.mjs';

const AXES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const DAY = (s) => Date.parse(`${s}T00:00:00Z`);

export function assessmentSemanticErrors(a, ctx) {
  const errors = [];
  const { handle } = ctx;
  if (!ctx.domains) throw new TypeError('assessmentSemanticErrors: ctx.domains が必要 (領域とプロファイルの照合を黙って飛ばさない)');
  const profile = ctx.domains.get(a.domain)?.profile;
  if (!ctx.domains.has(a.domain)) errors.push(`domain が domains.yaml に無い: ${a.domain}`);

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

    if (p.axes && ctx.domains.has(a.domain)) {
      if (profile == null) errors.push(`${at}: 領域 ${a.domain} はプロファイル未判定なので axes を書けない`);
      else if (p.profile !== profile) errors.push(`${at}: profile (${p.profile}) が領域 ${a.domain} のプロファイル (${profile}) と違う`);
    }

    if (p.axes && ctx.domains.has(a.domain) && profile != null && profile !== 'static') {
      if (!ctx.profiles) throw new TypeError(`assessmentSemanticErrors: ${at} は axes を持つので ctx.profiles が必要 (profile_revision の照合を黙って飛ばさない)`);
      const prof = ctx.profiles.get(p.profile);
      if (!prof) errors.push(`${at}: profile ${p.profile} の段階表 (schema/profiles/${p.profile}.yaml) が無い`);
      else {
        if (p.profile_revision !== prof.revision) errors.push(`${at}: profile_revision (${p.profile_revision}) が段階表 ${prof.profile} の版 (${prof.revision}) と違う (npm run apply-profile で当て直す)`);
        else errors.push(...derivedAxesErrors(p, prof).map((e) => `${at}: ${e}`));
      }
    }
    if (Object.values(p.provenance ?? {}).includes('estimated') && !p.notes) errors.push(`${at}: estimated の軸があるのに notes (根拠) が無い`);

    const axes = p.axes ?? {};
    const prov = p.provenance ?? {};
    for (const k of AXES) {
      const has = axes[k] !== undefined && axes[k] !== null;
      if (has && prov[k] === undefined) errors.push(`${at}: 軸 ${k} に点数があるのに provenance が無い`);
      if (has && prov[k] === 'unknown') errors.push(`${at}: 軸 ${k} は unknown なのに点数がある (unknown は値を持たない)`);
      if (!has && prov[k] !== undefined && prov[k] !== 'unknown') errors.push(`${at}: 軸 ${k} の由来が ${prov[k]} なのに点数が無い`);
      if (prov[k] !== undefined && axes[k] === undefined) errors.push(`${at}: 軸 ${k} に provenance だけがあり axes に無い (null で明示する)`);
      if (has && (prov[k] === 'measured' || prov[k] === 'estimated')) {
        // 観測の記録が無い点数を実測・推定と書かせない。到達性は A / F の根拠として認める。
        const grounded = p.facts || ((k === 'A' || k === 'F') && p.reachability);
        if (!grounded) errors.push(`${at}: 軸 ${k} は ${prov[k]} だが根拠 (facts${k === 'A' || k === 'F' ? ' か reachability' : ''}) が無い`);
      }
      if ((k === 'F' || k === 'G') && profile === 'static' && (has || prov[k] !== undefined)) {
        errors.push(`${at}: 静的領域に追加軸 ${k} は無い`);
      }
    }

    if (p.inherited_from) {
      if (!Object.values(prov).includes('inherited')) errors.push(`${at}: inherited_from があるのに inherited の軸が無い`);
      if (!ctx.families) throw new TypeError(`assessmentSemanticErrors: ${at} は inherited_from を持つので ctx.families が必要 (継承の検査を黙って飛ばさない)`);
      const fam = ctx.families.get(p.inherited_from.family_id);
      if (!ctx.web) errors.push(`${at}: inherited だが web.yaml が無い (family 所属を確認していない)`);
      else {
        if (ctx.web.family_id !== p.inherited_from.family_id) errors.push(`${at}: inherited_from.family_id が web.yaml の family_id (${ctx.web.family_id}) と違う`);
        if (!['observed', 'inferred'].includes(ctx.web.family_confidence)) errors.push(`${at}: web.yaml の family_confidence が ${ctx.web.family_confidence} なので inherited は書けない`);
      }
      if (!fam) errors.push(`${at}: inherited_from.family_id が families/ に無い: ${p.inherited_from.family_id}`);
      else if (!fam.measured_representatives.some((m) => m.handle === p.inherited_from.representative_handle)) {
        errors.push(`${at}: ${p.inherited_from.representative_handle} は ${fam.id} の代表実測ではない`);
      }
    }
  }
  return errors;
}
