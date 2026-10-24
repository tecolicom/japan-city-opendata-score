// validate.mjs を一時 root で走らせるテスト用。実物の dynamic.yaml は basis: observed の段を持ち、
// その段は実データに当たっていなければ validate が落とす。一時 root には実データが無いので、
// 実物の代わりに『全段 design』の最小の段階表を置く (版は実物と同じ)。
import { cpSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadYaml } from '../_lib/lib.mjs';

export function copySchemaWithMiniProfile(root, tmp) {
  cpSync(join(root, 'schema'), join(tmp, 'schema'), { recursive: true });
  const rev = loadYaml(join(root, 'schema', 'profiles', 'dynamic.yaml')).revision;
  mkdirSync(join(tmp, 'schema', 'profiles'), { recursive: true });
  writeFileSync(join(tmp, 'schema', 'profiles', 'dynamic.yaml'),
    `profile: dynamic\nrevision: ${rev}\naxes:\n  F:\n    - when: {conditional_get: both}\n      points: 10\n      basis: design\n`);
}
