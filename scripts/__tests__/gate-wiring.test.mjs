// 「検査は存在するが、ゲートに配線されていない」の再発防止。
// ここは関数ではなく validate.mjs (ゲート本体) を走らせ、壊したデータで落ちることを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { loadYaml } from '../_lib/lib.mjs';
import { copySchemaWithMiniProfile, copyFamiliesExternal } from './_helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const run = (tmp, args) => {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'validate.mjs'), '--root', tmp, ...args], { encoding: 'utf8', env: { ...process.env, REGISTRY_PATH: '' } });
  return { code: r.status, out: r.stderr + r.stdout };
};

// 代表実測を 1 件足した family を持つ一時 root (municipalities/ は無い = ディレクトリを持たない handle の状況)。
const rootWithRep = (rep) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gw-'));
  copySchemaWithMiniProfile(root, tmp);
  copyFamiliesExternal(root, tmp);
  const name = readdirSync(join(tmp, 'families'))[0];
  const f = loadYaml(join(tmp, 'families', name));
  f.measured_representatives.push({ handle: 'fictional', observed_at: '2026-10-24', evidence: '架空', signals_seen: [{ signal: f.signals[0], method: 'html' }], ...rep });
  writeFileSync(join(tmp, 'families', name), stringify(f));
  return tmp;
};

test('代表実測: web.yaml も backing も無い架空の代表実測で validate が落ちる', () => {
  const r = run(rootWithRep({}), ['--no-registry']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /fictional.*backing: external の宣言も無い/);
});

test('代表実測: backing: external でも backing_note が無ければ落ち、揃えば通る', () => {
  assert.notEqual(run(rootWithRep({ backing: 'external', backing_note: undefined }), ['--no-registry']).code, 0);
  assert.equal(run(rootWithRep({ backing: 'external', backing_note: '2026-10-24 の観測 (repo 内に web.yaml 無し)' }), ['--no-registry']).code, 0);
});

test('レジストリが website を全件持たなければ validate が落ちる', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gw2-'));
  copySchemaWithMiniProfile(root, tmp);
  copyFamiliesExternal(root, tmp);
  mkdirSync(join(tmp, 'municipalities/saitama/kawagoe'), { recursive: true });
  writeFileSync(join(tmp, 'municipalities/saitama/kawagoe/web.yaml'),
    'handle: kawagoe\nurl: https://www.city.hanno.lg.jp/\nfamily_id: null\nfamily_confidence: none\nfingerprinted_at: 2026-10-24\nsignals_seen: []\n');
  writeFileSync(join(tmp, 'reg.yaml'), '- {code: "11201", handle: kawagoe, name_ja: 川越市, type: city}\n');
  const r = run(tmp, ['--registry', join(tmp, 'reg.yaml')]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /website が 0\/1 件/);
  // 一部だけ無い場合は件数を出して続行する
  writeFileSync(join(tmp, 'reg.yaml'), '- {code: "11201", handle: kawagoe, name_ja: 川越市, type: city, website: "https://www.city.hanno.lg.jp/"}\n- {code: "11202", handle: other, name_ja: 他市, type: city}\n');
  const ok = run(tmp, ['--registry', join(tmp, 'reg.yaml')]);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /website 無し 1\/2 件; URL 照合 実施 1 件/);
});
