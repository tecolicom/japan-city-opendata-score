import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, loadYaml, listMunicipalityDirs } from './lib.mjs';

const FIXTURE_REGISTRY = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'registry-min.yaml');

test('loadRegistry は handle で引ける Map を返す', () => {
  const reg = loadRegistry(FIXTURE_REGISTRY);
  assert.equal(reg.get('hanno').name_ja, '飯能市');
  assert.equal(reg.get('moroyama-town').type, 'town');
  assert.equal(reg.get('moroyama-town').website, null);
  assert.equal(reg.size, 3);
});

test('loadRegistry は未知の handle に undefined を返す', () => {
  assert.equal(loadRegistry(FIXTURE_REGISTRY).get('nonexistent'), undefined);
});

test('loadYaml は YAML を読む', () => {
  assert.deepEqual(loadYaml(join(dirname(FIXTURE_REGISTRY), 'registry-min.yaml'))[1].handle, 'hanno');
});

test('listMunicipalityDirs は municipalities/<pref>/<handle> を列挙する', () => {
  const root = mkdtempSync(join(tmpdir(), 'jpdi-'));
  mkdirSync(join(root, 'municipalities', 'saitama', 'hanno'), { recursive: true });
  mkdirSync(join(root, 'municipalities', 'saitama', 'moroyama-town'), { recursive: true });
  writeFileSync(join(root, 'municipalities', 'saitama', 'README.md'), 'x');
  const got = listMunicipalityDirs(root).map((d) => `${d.pref}/${d.handle}`).sort();
  assert.deepEqual(got, ['saitama/hanno', 'saitama/moroyama-town']);
  assert.ok(listMunicipalityDirs(root)[0].dir.endsWith(listMunicipalityDirs(root)[0].handle));
});

test('listMunicipalityDirs は municipalities/ が無ければ空配列', () => {
  assert.deepEqual(listMunicipalityDirs(mkdtempSync(join(tmpdir(), 'jpdi-'))), []);
});
