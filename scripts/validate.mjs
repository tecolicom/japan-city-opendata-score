// schema/ と families/ に対する検証ゲート。
// 検証対象 (schema/domains.yaml, families/*.yaml) は必須成果物。無ければ失敗する。
// schema/ に何かがあるのに対応する検証が無ければ失敗する (偽の緑を出さない)。
// ドットファイル (macOS の .DS_Store 等) は readdirSync が返すので除外する (偽の赤を出さない)。
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { loadYaml } from './_lib/lib.mjs';
import { familySemanticErrors } from './_lib/family-check.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = join(root, 'schema');
const familiesDir = join(root, 'families');

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);

const listFiles = (dir) => readdirSync(dir).filter((n) => !n.startsWith('.')).sort();

function schemaErrors(validate, data, label) {
  return validate(data) ? [] : validate.errors.map((e) => `${label}${e.instancePath} ${e.message} (${e.schemaPath})`);
}

function checkDomains() {
  const validate = ajv.compile(loadYaml(join(schemaDir, 'domains.schema.json')));
  const data = loadYaml(join(schemaDir, 'domains.yaml'));
  const errors = schemaErrors(validate, data, 'domains.yaml');
  if (errors.length > 0) return errors;
  const seen = { id: new Set(), standard_dataset: new Set() };
  for (const d of data.domains) {
    for (const key of ['id', 'standard_dataset']) {
      if (d[key] == null) continue;
      if (seen[key].has(d[key])) errors.push(`domains.yaml: ${key} が重複: ${d[key]}`);
      seen[key].add(d[key]);
    }
  }
  return errors;
}

function checkFamilies() {
  if (!existsSync(familiesDir)) return ['families/: 見つからない'];
  const all = listFiles(familiesDir);
  const files = all.filter((n) => /\.ya?ml$/i.test(n));
  const errors = all.filter((n) => !files.includes(n)).map((n) => `families/${n}: yaml ではないファイル (対応する検証が未実装)`);
  if (files.length === 0) return [...errors, 'families/: family が 1 件も無い'];
  const validate = ajv.compile(loadYaml(join(schemaDir, 'family.schema.json')));
  const ids = new Set();
  for (const name of files) {
    const family = loadYaml(join(familiesDir, name));
    const errs = schemaErrors(validate, family, `families/${name}`);
    errors.push(...errs);
    if (errs.length > 0) continue;
    errors.push(...familySemanticErrors(family).map((e) => `families/${name}: ${e}`));
    if (family.id !== name.replace(/\.ya?ml$/i, '')) errors.push(`families/${name}: id (${family.id}) がファイル名と一致しない`);
    if (ids.has(family.id)) errors.push(`families/${name}: id が重複: ${family.id}`);
    ids.add(family.id);
  }
  return errors;
}

// 検証の一覧。files は schema/ 直下で、この検証が面倒を見るファイル。
// schema/ にこれ以外のファイルがあれば「未実装」で落とす (known は files から導出する)。
const validators = {
  'domains.yaml': { files: ['domains.yaml', 'domains.schema.json'], check: checkDomains },
  'families/*.yaml': { files: ['family.schema.json'], check: checkFamilies },
};

const errors = [];
if (!existsSync(schemaDir)) {
  errors.push('schema/: 見つからない');
} else {
  const known = new Set(Object.values(validators).flatMap((v) => v.files));
  for (const f of listFiles(schemaDir)) {
    if (!known.has(f)) errors.push(`${f}: 対応する検証が未実装`);
  }
  for (const v of Object.values(validators)) {
    for (const f of v.files) {
      if (!existsSync(join(schemaDir, f))) errors.push(`schema/${f}: 見つからない`);
    }
  }
}
// 必要なファイルが揃っているものだけ実行する (欠落は上で報告済み)
for (const [name, v] of Object.entries(validators)) {
  if (v.files.every((f) => existsSync(join(schemaDir, f)))) errors.push(...v.check());
  else errors.push(`${name}: 検証できない (schema 不足)`);
}

if (errors.length > 0) {
  console.error('validate: 失敗');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`validate: OK (${Object.keys(validators).join(', ')})`);
