import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml } from '../_lib/lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const d = loadYaml(join(root, 'schema', 'domains.yaml')).domains;
const find = (id) => d.find((x) => x.id === id);

test('domains.yaml は標準データセット 22 件 (基本編 14 + 応用編 8) を含む', () => {
  const std = d.filter((x) => x.standard_dataset);
  assert.equal(std.length, 22);
  assert.equal(std.filter((x) => x.standard_dataset.includes('/基本編/')).length, 14);
  assert.equal(std.filter((x) => x.standard_dataset.includes('/応用編/')).length, 8);
});

test('id と standard_dataset は重複しない', () => {
  const ids = d.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  const sds = d.map((x) => x.standard_dataset).filter(Boolean);
  assert.equal(new Set(sds).size, sds.length);
});

test('schedule-events は dynamic プロファイルで標準 OD に紐づく', () => {
  const se = find('schedule-events');
  assert.equal(se.profile, 'dynamic');
  assert.equal(se.standard_dataset, '自治体標準オープンデータセット/基本編/6_イベント一覧');
});

test('お知らせフィードはイベント一覧と別領域にしない', () => {
  assert.ok(!d.some((x) => x.id === 'news' || x.id === 'announcements'));
  assert.ok(find('schedule-events').publishers_expected.length > 0);
});

test('gomi は標準データセットを持たない拡張領域', () => {
  assert.equal(find('gomi').standard_dataset, null);
  assert.equal(find('gomi').profile, 'static');
});

test('政令指定都市の handle は 1 件で、行政区を領域の単位にしない', () => {
  assert.ok(!JSON.stringify(d).includes('行政区'));
});
