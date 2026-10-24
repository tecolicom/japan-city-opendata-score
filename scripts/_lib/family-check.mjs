// family の意味検査。JSON Schema では書けない「別フィールドとの整合」をここで持つ。
// signals_seen は signals の部分集合でなければならない (書き間違いで未知の痕跡を「確認した」ことにしない)。
export function familySemanticErrors(family) {
  const known = new Set(family.signals ?? []);
  const errors = [];
  for (const m of family.measured_representatives ?? []) {
    for (const s of m.signals_seen ?? []) {
      if (!known.has(s)) errors.push(`measured_representatives[${m.handle}].signals_seen に signals に無い値: ${s}`);
    }
  }
  return errors;
}
