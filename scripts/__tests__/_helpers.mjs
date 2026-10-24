// validate.mjs を一時 root で走らせるテスト用。実物の dynamic.yaml は basis: observed の段を持ち、
// その段は実データに当たっていなければ validate が落とす。一時 root には実データが無いので、
// 実物の代わりに『全段 design』の最小の段階表を置く (版は実物と同じ)。
import { cpSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadYaml } from '../_lib/lib.mjs';
import { stringify } from 'yaml';

export function copySchemaWithMiniProfile(root, tmp) {
  cpSync(join(root, 'schema'), join(tmp, 'schema'), { recursive: true });
  const rev = loadYaml(join(root, 'schema', 'profiles', 'dynamic.yaml')).revision;
  mkdirSync(join(tmp, 'schema', 'profiles'), { recursive: true });
  writeFileSync(join(tmp, 'schema', 'profiles', 'dynamic.yaml'),
    `profile: dynamic\nrevision: ${rev}\naxes:\n  F:\n    - when: {conditional_get: both}\n      points: 10\n      basis: design\n`);
}

// 一時 root に families/ の写しを置く。一時 root には代表実測の web.yaml が無いので、
// 全代表を backing: external にして「裏付けの無い代表実測」の検査に当たらないようにする
// (その検査自体は families.test.mjs と実データの validate が見る)。
export function copyFamiliesExternal(root, tmp) {
  mkdirSync(join(tmp, 'families'), { recursive: true });
  for (const n of readdirSync(join(root, 'families')).filter((x) => /\.ya?ml$/i.test(x))) {
    const f = loadYaml(join(root, 'families', n));
    for (const m of f.measured_representatives) { m.backing = 'external'; m.backing_note = 'テスト用の写し'; }
    writeFileSync(join(tmp, 'families', n), stringify(f));
  }
}
