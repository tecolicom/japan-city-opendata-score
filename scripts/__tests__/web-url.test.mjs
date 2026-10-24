import { test } from 'node:test';
import { copySchemaWithMiniProfile } from './_helpers.mjs';
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
  copySchemaWithMiniProfile(root, tmp);
  symlinkSync(join(root, 'families'), join(tmp, 'families'));
  mkdirSync(join(tmp, 'municipalities/saitama/kawagoe'), { recursive: true });
  writeFileSync(join(tmp, 'municipalities/saitama/kawagoe/web.yaml'), web);
  writeFileSync(join(tmp, 'reg.yaml'), registry);
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'validate.mjs'), '--root', tmp, '--registry', join(tmp, 'reg.yaml')], { encoding: 'utf8' });
  return { code: r.status, out: r.stderr + r.stdout };
};
const base = 'handle: kawagoe\nurl: https://www.city.hanno.lg.jp/\nfamily_id: null\nfamily_confidence: none\nfingerprinted_at: 2026-10-24\nsignals_seen: []\n';
const reg = (w) => `- {code: "11209", handle: kawagoe, name_ja: 飯能市, type: city, website: ${w}}\n`;

test('validate: レジストリと違う URL には根拠 (url_note) を強制する', () => {
  assert.equal(run(base, reg('https://www.city.hanno.lg.jp')).code, 0);
  assert.notEqual(run(base, reg(REG)).code, 0, '違うのに registry_website 無し');
  assert.notEqual(run(`${base}registry_website: ${REG}\n`, reg(REG)).code, 0, 'url_note 無し');
  const ok = `${base}registry_website: ${REG}\nurl_note:\n  observed_at: 2026-10-24\n  reason: レジストリの URL は 404、ルートは 200\n`;
  assert.equal(run(ok, reg(REG)).code, 0, run(ok, reg(REG)).out);
  assert.notEqual(run(`${base}url_note:\n  observed_at: 2026-10-24\n  reason: x\n`, reg(REG)).code, 0, 'registry_website 無しの url_note');
});

// Ruling AC / AD
const web = (extra, h = 'kawagoe') => `handle: ${h}\nurl: https://www.city.example.jp/\nfingerprinted_at: 2026-10-24\n${extra}`;
const runAt = (h, body) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webd-'));
  copySchemaWithMiniProfile(root, tmp);
  symlinkSync(join(root, 'families'), join(tmp, 'families'));
  mkdirSync(join(tmp, `municipalities/saitama/${h}`), { recursive: true });
  writeFileSync(join(tmp, `municipalities/saitama/${h}/web.yaml`), body);
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'validate.mjs'), '--root', tmp], { encoding: 'utf8' });
  return { code: r.status, out: r.stderr + r.stdout };
};
const S = '/theme/base/js/mutual_switching/';

test('AC: family_id が null でも当たった signal を残せる (below / none で区別)', () => {
  const some = `family_id: null\nfamily_confidence: below\nsignals_seen:\n  - {signal: ${S}, method: html}\n`;
  assert.equal(runAt('kawagoe', web(some)).code, 0, runAt('kawagoe', web(some)).out);
  assert.equal(runAt('kawagoe', web('family_id: null\nfamily_confidence: none\nsignals_seen: []\n')).code, 0);
  assert.notEqual(runAt('kawagoe', web(some.replace('below', 'none'))).code, 0, '痕跡があるのに none');
  assert.notEqual(runAt('kawagoe', web('family_id: null\nfamily_confidence: below\nsignals_seen: []\n')).code, 0, '痕跡が無いのに below');
  assert.notEqual(runAt('kawagoe', web(some.replace(S, '/no/such/'))).code, 0, '既知 family に無い signal');
});

test('AD: 代表実測に載っている handle が family と食い違うなら説明が要る', () => {
  const miss = 'family_id: null\nfamily_confidence: none\nsignals_seen: []\n';
  assert.notEqual(runAt('hanno', web(miss, 'hanno')).code, 0, '説明なしの食い違い');
  const ok = `${miss}family_divergence:\n  observed_at: 2026-10-24\n  reason: 自動指紋はトップ HTML のみ\n`;
  assert.equal(runAt('hanno', web(ok, 'hanno')).code, 0, runAt('hanno', web(ok, 'hanno')).out);
  assert.notEqual(runAt('kawagoe', web(ok)).code, 0, '代表実測でないのに family_divergence');
});
