import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webUrlErrors } from '../_lib/family-check.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REG = 'https://www.town.x.example.jp/www/index.html';

test('webUrlErrors: レジストリと同じ URL (正規化して比較) は通り、違うなら registry_website が要る', () => {
  assert.deepEqual(webUrlErrors({ url: 'https://a.example.jp' }, 'https://a.example.jp/'), []);
  assert.equal(webUrlErrors({ url: 'https://a.example.jp/', registry_website: 'https://a.example.jp/' }, 'https://a.example.jp/').length, 1);
  assert.equal(webUrlErrors({ url: 'https://a.example.jp/' }, REG).length, 1, '違うのに根拠なし');
  assert.deepEqual(webUrlErrors({ url: 'https://a.example.jp/', registry_website: REG }, REG), []);
  assert.equal(webUrlErrors({ url: 'https://a.example.jp/', registry_website: 'https://other.example.jp/' }, REG).length, 1, '写し間違い');
});

const run = (web, registry) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webu-'));
  symlinkSync(join(root, 'schema'), join(tmp, 'schema'));
  symlinkSync(join(root, 'families'), join(tmp, 'families'));
  mkdirSync(join(tmp, 'municipalities/saitama/hanno'), { recursive: true });
  writeFileSync(join(tmp, 'municipalities/saitama/hanno/web.yaml'), web);
  writeFileSync(join(tmp, 'reg.yaml'), registry);
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'validate.mjs'), '--root', tmp, '--registry', join(tmp, 'reg.yaml')], { encoding: 'utf8' });
  return { code: r.status, out: r.stderr + r.stdout };
};
const base = 'handle: hanno\nurl: https://www.city.hanno.lg.jp/\nfamily_id: null\nfamily_confidence: none\nfingerprinted_at: 2026-10-24\nsignals_seen: []\n';
const reg = (w) => `- {code: "11209", handle: hanno, name_ja: 飯能市, type: city, website: ${w}}\n`;

test('validate: レジストリと違う URL には根拠 (url_note) を強制する', () => {
  assert.equal(run(base, reg('https://www.city.hanno.lg.jp')).code, 0);
  assert.notEqual(run(base, reg(REG)).code, 0, '違うのに registry_website 無し');
  assert.notEqual(run(`${base}registry_website: ${REG}\n`, reg(REG)).code, 0, 'url_note 無し');
  const ok = `${base}registry_website: ${REG}\nurl_note:\n  observed_at: 2026-10-24\n  reason: レジストリの URL は 404、ルートは 200\n`;
  assert.equal(run(ok, reg(REG)).code, 0, run(ok, reg(REG)).out);
  assert.notEqual(run(`${base}url_note:\n  observed_at: 2026-10-24\n  reason: x\n`, reg(REG)).code, 0, 'registry_website 無しの url_note');
});
