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

test('標準データセットの正式名称・番号 (基本編 1〜14 / 応用編 A-1〜A-3, B-1〜B-5)', () => {
  const B = '自治体標準オープンデータセット/基本編/';
  const A = '自治体標準オープンデータセット/応用編/';
  const expected = [
    ...['AED設置箇所一覧', '介護サービス事業所一覧', '医療機関一覧', '文化財一覧', '観光施設一覧',
      'イベント一覧', '公衆無線LANアクセスポイント一覧', '公衆トイレ一覧', '消防水利施設一覧',
      '指定緊急避難場所一覧', '地域・年齢別人口', '公共施設一覧', '子育て施設一覧', 'オープンデータ一覧',
    ].map((n, i) => `${B}${i + 1}_${n}`),
    ...['A-1_食品等営業許可・届出一覧', 'A-2_学校給食献立情報', 'A-3_小中学校通学区域情報',
      'B-1_ボーリング柱状図等', 'B-2_都市計画基礎調査情報', 'B-3_調達情報',
      'B-4_標準的なバス情報フォーマット', 'B-5_支援制度情報',
    ].map((n) => `${A}${n}`),
  ];
  const actual = d.map((x) => x.standard_dataset).filter(Boolean);
  assert.deepEqual([...actual].sort(), [...expected].sort());
});

test('profile が null (未判定) なのは schedule-events と gomi 以外の 21 領域で、publishers_expected を持たない', () => {
  const rest = d.filter((x) => !['schedule-events', 'gomi'].includes(x.id));
  assert.equal(rest.length, 21);
  for (const x of rest) {
    assert.equal(x.profile, null, x.id);
    assert.ok(!('publishers_expected' in x), x.id);
  }
});

test('profile を持つ 2 領域は publishers_expected を持つ', () => {
  for (const id of ['schedule-events', 'gomi']) {
    assert.ok(find(id).publishers_expected.length > 0, id);
  }
});
