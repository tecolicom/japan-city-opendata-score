// schema/ に対する検証ゲート。
// schema/ がまだ無い間 (Task 3 以前) は「検証対象なし」として成功する。
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = join(root, 'schema');

if (!existsSync(schemaDir) || readdirSync(schemaDir).length === 0) {
  console.log('validate: schema/ が無い (または空) — 検証対象なし');
  process.exit(0);
}

console.log('validate: schema/ あり — 検証は後続タスクで実装');
