// schema/ と families/ に対する検証ゲート。
// 検証対象 (schema/domains.yaml, families/*.yaml) は必須成果物。無ければ失敗する。
// schema/ に何かがあるのに対応する検証が無ければ失敗する (偽の緑を出さない)。
// ドットファイル (macOS の .DS_Store 等) は readdirSync が返すので除外する (偽の赤を出さない)。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { loadYaml, loadRegistry, listMunicipalityDirs } from './_lib/lib.mjs';
import { familySemanticErrors, webSemanticErrors, webUrlErrors, representativeDivergenceErrors } from './_lib/family-check.mjs';
import { assessmentSemanticErrors } from './_lib/assessment-check.mjs';
import { checkProfile } from './score.mjs';

// --root <dir>: 検証対象のリポジトリルート (既定はこのスクリプトの親)。テストが壊したデータで落ちることを確かめるのに使う。
// --registry <municipalities.yaml>: 指定されたら handle の実在も検査する (自前で採番しない)。
const argOf = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const root = argOf('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = argOf('--registry');
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

// municipalities/<pref>/<handle>/{web.yaml, assessments/<domain>.yaml}。
// municipalities/ が無いのは正常 (まだ実測が無い)。ただし中にある物は全部検査し、知らないファイルは落とす。
function checkMunicipalities() {
  const muniDir = join(root, 'municipalities');
  if (!existsSync(muniDir)) return [];
  const errors = [];
  const validateWeb = ajv.compile(loadYaml(join(schemaDir, 'web.schema.json')));
  const validateAssessment = ajv.compile(loadYaml(join(schemaDir, 'assessment.schema.json')));
  const domains = new Map(loadYaml(join(schemaDir, 'domains.yaml')).domains.map((d) => [d.id, d]));
  const families = new Map(existsSync(familiesDir)
    ? listFiles(familiesDir).filter((n) => /\.ya?ml$/i.test(n)).map((n) => loadYaml(join(familiesDir, n))).map((f) => [f.id, f])
    : []);
  const registry = registryPath ? loadRegistry(registryPath) : null;
  const yamlName = (n) => /\.ya?ml$/i.test(n);
  const known = new Set(listMunicipalityDirs(root).map((m) => `${m.pref}/${m.handle}`));
  for (const pref of listFiles(muniDir)) {
    for (const n of listFiles(join(muniDir, pref))) {
      if (!known.has(`${pref}/${n}`)) errors.push(`municipalities/${pref}/${n}: ディレクトリではない`);
    }
  }
  const publisherIds = new Set();
  for (const { pref, handle, dir } of listMunicipalityDirs(root)) {
    const at = `municipalities/${pref}/${handle}`;
    if (registry && !registry.has(handle)) errors.push(`${at}: handle が municipalities.yaml に無い`);
    // assessments/ は web.yaml を参照する (継承の確認) ので、先に web.yaml を読む。
    let web;
    if (existsSync(join(dir, 'web.yaml'))) {
      const w = loadYaml(join(dir, 'web.yaml'));
      const errs = schemaErrors(validateWeb, w, `${at}/web.yaml`);
      errors.push(...errs);
      if (errs.length === 0) {
        web = w;
        if (w.handle !== handle) errors.push(`${at}/web.yaml: handle (${w.handle}) がディレクトリ名と一致しない`);
        errors.push(...webSemanticErrors(w, families).map((e) => `${at}/web.yaml: ${e}`));
        errors.push(...representativeDivergenceErrors(w, families).map((e) => `${at}/web.yaml: ${e}`));
        if (registry?.get(handle)?.website) errors.push(...webUrlErrors(w, registry.get(handle).website).map((e) => `${at}/web.yaml: ${e}`));
      }
    }
    for (const n of listFiles(dir)) {
      if (n === 'web.yaml') continue;
      if (n === 'assessments') {
        for (const f of listFiles(join(dir, n))) {
          const label = `${at}/assessments/${f}`;
          if (!yamlName(f)) { errors.push(`${label}: yaml ではないファイル (対応する検証が未実装)`); continue; }
          const a = loadYaml(join(dir, n, f));
          const errs = schemaErrors(validateAssessment, a, label);
          errors.push(...errs);
          if (errs.length > 0) continue;
          if (a.domain !== f.replace(/\.ya?ml$/i, '')) errors.push(`${label}: domain (${a.domain}) がファイル名と一致しない`);
          errors.push(...assessmentSemanticErrors(a, { handle, domains, families, web }).map((e) => `${label}: ${e}`));
          for (const p of a.publishers) {
            if (publisherIds.has(p.id)) errors.push(`${label}: publisher id が他のファイルと重複: ${p.id}`);
            publisherIds.add(p.id);
          }
        }
      } else {
        errors.push(`${at}/${n}: 対応する検証が未実装`);
      }
    }
  }
  return errors;
}

// schema/profiles/<name>.yaml (段階表とキャップ規則)。実物は Task 10 が置く。無い/空は正常。
// 中にある物は全部検査し、yaml でないファイルと下位ディレクトリは「未実装」で落とす。
function checkProfiles() {
  const dir = join(schemaDir, 'profiles');
  if (!existsSync(dir)) return [];
  const errors = [];
  const validate = ajv.compile(loadYaml(join(schemaDir, 'profile.schema.json')));
  for (const n of listFiles(dir)) {
    const label = `schema/profiles/${n}`;
    if (!/\.ya?ml$/i.test(n) || statSync(join(dir, n)).isDirectory()) { errors.push(`${label}: yaml ではないファイル/ディレクトリ (対応する検証が未実装)`); continue; }
    const prof = loadYaml(join(dir, n));
    const errs = schemaErrors(validate, prof, label);
    errors.push(...errs);
    if (errs.length > 0) continue;
    if (prof.profile !== n.replace(/\.ya?ml$/i, '')) errors.push(`${label}: profile (${prof.profile}) がファイル名と一致しない`);
    try { checkProfile(prof); } catch (e) { errors.push(`${label}: ${e.message}`); }
  }
  return errors;
}

// 検証の一覧。files は schema/ 直下で、この検証が面倒を見るファイル。
// schema/ にこれ以外のファイルがあれば「未実装」で落とす (known は files から導出する)。
const validators = {
  'domains.yaml': { files: ['domains.yaml', 'domains.schema.json'], check: checkDomains },
  'families/*.yaml': { files: ['family.schema.json'], check: checkFamilies },
  'schema/profiles/*.yaml': { files: ['profile.schema.json'], dirs: ['profiles'], check: checkProfiles },
  'municipalities/**': { files: ['assessment.schema.json', 'web.schema.json'], check: checkMunicipalities },
};

const errors = [];
if (!existsSync(schemaDir)) {
  errors.push('schema/: 見つからない');
} else {
  const known = new Set(Object.values(validators).flatMap((v) => [...v.files, ...(v.dirs ?? [])]));
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
