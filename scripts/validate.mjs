// schema/ に対する検証ゲート。
// schema/ がまだ無い (または空の) 間は「検証対象なし」として成功する。
// schema/ に何かがあるのに対応する検証が無ければ失敗する (偽の緑を出さない)。
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { loadYaml } from './_lib/lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = join(root, 'schema');

// 検証できる schema の一覧。ファイル名 -> 検証関数 (エラー文字列の配列を返す)。
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);

function validateAgainst(schemaFile, dataFile, extra = () => []) {
  const schema = loadYaml(join(schemaDir, schemaFile));
  const data = loadYaml(join(schemaDir, dataFile));
  const validate = ajv.compile(schema);
  const errors = validate(data)
    ? []
    : validate.errors.map((e) => `${dataFile}${e.instancePath} ${e.message}`);
  return [...errors, ...extra(data)];
}

function checkDomains() {
  return validateAgainst('domains.schema.json', 'domains.yaml', ({ domains }) => {
    const errors = [];
    const seen = { id: new Set(), standard_dataset: new Set() };
    for (const d of domains) {
      for (const key of ['id', 'standard_dataset']) {
        if (d[key] == null) continue;
        if (seen[key].has(d[key])) errors.push(`domains.yaml: ${key} が重複: ${d[key]}`);
        seen[key].add(d[key]);
      }
    }
    return errors;
  });
}

const validators = { 'domains.yaml': checkDomains };
const known = new Set(['domains.yaml', 'domains.schema.json']);

if (!existsSync(schemaDir) || readdirSync(schemaDir).length === 0) {
  console.log('validate: schema/ が無い (または空) — 検証対象なし');
  process.exit(0);
}

const errors = [];
for (const f of readdirSync(schemaDir)) {
  if (!known.has(f)) errors.push(`${f}: 対応する検証が未実装`);
}
for (const [file, check] of Object.entries(validators)) {
  if (!existsSync(join(schemaDir, file))) errors.push(`${file}: 見つからない`);
  else errors.push(...check());
}

if (errors.length > 0) {
  console.error('validate: 失敗');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`validate: OK (${Object.keys(validators).join(', ')})`);
