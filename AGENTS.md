# AGENTS.md

自治体が web で発信する情報が「実際に使えるか」を実測評価する知識ベース (CC BY 4.0)。Claude Code / Codex 向けの手引き。

- 人向けの入口: `CONTRIBUTING.md`
- **手順と判断基準 (必読): `docs/playbook.md`**
- 指標の正典: `docs/index.md`
- 実測の前例と発見: `docs/measurements/saitama-2026-10-24.md`

## 取得の礼儀 (不変条件。最優先)

対象は他者の、公共機関のサーバ。**これを破ると枠組みの信用が失われる。判断に迷ったら取得しない。**

- 調査対象への取得は **`scripts/_lib/fetch.mjs` の `politeFetch` 経由のみ。素の `fetch` / `curl` / ブラウザ自動化を使わない**
- robots.txt を尊重する (指紋採取も例外ではない)。取れなくても「許可」と解釈しない
- 1 自治体あたりトップページ 1 回が基本。間隔 2 秒以上・同時実行 1・キャッシュ済みは再取得しない
- 管理画面・既知パス・脆弱性の探索をしない。取得するのは公開ページと robots.txt だけ
- 調査対象サイトの本文を repo に取り込まない
- **小さく始める:** 3〜4 件で止め、リクエスト数・間隔・robots 判定・キャッシュを確認してから広げる
- **陰性対照を混ぜる:** 既知 family に該当しない自治体を 1 つ入れ、「当たらない」ことを確認する
- **ユーザーの承認なしに取得を広げない。** 取得は外部への副作用なので、件数と対象を示して確認を取る
- キャッシュ (`cache/`) にある自治体は、手順を踏み直しても再取得されない (`fromCache: true`)。まずキャッシュで済むか確かめる

## 守る規則

- **handle を自分で綴らない。** レジストリ (`../city-tecoli-data/municipalities/municipalities.yaml`) から引く。町村は `-town` / `-village` 付き (例 `ogose-town`)
- **URL を handle から組み立てない。** レジストリの `website` を使う。古ければレジストリを直さず、`web.yaml` に `url` + `registry_website` + `url_note` を書く
- **`npm run validate` は必ず `--registry ../city-tecoli-data/municipalities/municipalities.yaml` 付きで実行する。** 付けないと handle の実在と URL の整合が検査されない (CI も付けていない)
- **未確認と不在は別。** `standard_od: false` は悉皆確認の後だけ。案内ページ 1 枚では書かず、未確認のまま残す
- **観測と推定を分ける。** `signals_seen[].method`、`conditional_get_scope`、`provenance` で区別する。推定は `estimated` + `notes` に根拠
- **何を測ったかを狭く書く。** 根拠の範囲を超える一般化をしない
- **F はトップページの観測で代用できない。** `measured` にするには配信元 URL そのものを取得し `conditional_get_scope: source`
- **継承できるのは A / F / G のみ。** 調べていない自治体の assessment を一括生成しない
- **`unknown` は 0 点ではない (null)。** コア合計は 5 軸すべてが値を持つときだけ。コアと F/G を合算しない
- **生成値を手で書かない:** `axes` / `provenance` / `derived_at` / `profile_revision` / `family_confidence` / 生成された `notes`
- **レジストリ・`families/` の既存 family・`docs/index.md` を変更しない** (提案に留める)。`schema/` と `scripts/` の変更は依頼されたときだけ
- **検査を足したら、壊したデータで `npm run validate` が実際に落ちることを確認する。** テストが落ちるだけでは足りない (過去 3 回、「検査を書いた」が「検査が走っている」でなかった)
- **緑でないコミットを残さない。** `git add -A` を使わず、ファイルを指定する

## コマンド

```
make setup                          依存を入れる
make test                           全ゲート (validate + ESLint + 単体テスト)
npm run new -- --handle <h>         自治体の足場 (県はレジストリから導出)
npm run fingerprint -- --pref <p> --handles a,b [--limit N]   指紋採取 (取得を伴う)
npm run apply-profile [-- --pref <p>]   facts から axes を導出して書き戻す
npm run score                       採点して docs/scores.csv を更新
npm run score -- --pref <p> --distribution   facts の分布 (取得なし)
npm run validate -- --registry ../city-tecoli-data/municipalities/municipalities.yaml
```

`make` にあるのは `setup` / `test` / `lint` / `score` だけ。`new` / `fingerprint` / `apply-profile` は `npm run`。

## データの単位

```
municipalities/<県>/<handle>/
  web.yaml                       基盤 (family 判定・signals_seen・実際に使った URL)
  assessments/<領域>.yaml        領域ごとの評価 (配信元単位)。配信元が 1 件以上あるときだけ置く
families/<id>.yaml               CMS family (代表実測があるものだけ)
schema/                          語彙と JSON Schema。profiles/ が F/G の段階表の正典
cache/                           取得キャッシュ (git 管理外)
```

## 触ってよい場所

1 自治体を足すとき、書き込みは `municipalities/<県>/<handle>/` に閉じる。`families/` に足すのは代表実測を伴うときだけ。それ以外 (`schema/` `scripts/` `docs/index.md` 他自治体) は提案に留める。

## 迷ったとき

- 手順は `docs/playbook.md`。罠の一覧と「まだ誰もやっていないこと」がある
- ここに無い判断は、**調べて分かる範囲で書き、分からないものは書かずに残す** (推測で埋めない)
- 人の判断が要る点 (取得を広げる、family を昇格する、指標を変える) は止まって聞く
