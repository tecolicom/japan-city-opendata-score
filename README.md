# japan-public-data-index

全国の自治体が web で発信する情報が「**実際に使えるか**」を、実測で評価する知識ベース。

評価は `(自治体 × 情報領域 × 配信元)` の組ごとに付く。同じデータが二つの顔を持つ:

- **使う側**には「どの自治体の、どの情報が、どこから、どれだけの手間で取れるか」の地図
- **自治体側**には「現状がどこで、理想がどこで、次に何を直せばいいか」の材料

測るのは「オープンデータとして立派か」ではなく「**市民・開発者が実際に使えるか**」。公式カタログに載っていなくても、機械可読で取得できれば得点する。

## 何が新しいか

オープンデータの国際的な指標 (OECD OURdata Index、EU Open Data Maturity、Global Data Barometer) は、いずれも**国単位**で**自己申告・アンケート**に基づく。EU の方法論研究は自らの Quality 次元について「高得点が客観指標と相関しない」と指摘している。

本 index は **自治体単位 × 実測 × 動的コンテンツ**を埋める。軸の名前は自前で発明せず、W3C [Data Quality Vocabulary](https://www.w3.org/TR/vocab-dqv/) の次元に対応づけている (A=Availability / C=Precision+Completeness / D=Licensing / E=Traceability / F=Timeliness↔Currentness)。

情報領域の語彙は、デジタル庁の**自治体標準オープンデータセット** (基本編 14 + 応用編 8) を骨格とし、標準に無いもの (ごみ収集など) を拡張として足す。

### 国内の先行事例との関係

国内には既に、全国の自治体サイトを**実測して**公開している仕事がある。本 index はそれと重ならない。

| 先行事例 | 何を測るか | 測り方 |
|---|---|---|
| [code4fukui/localgovjp](https://github.com/code4fukui/localgovjp) (CC0) | 全自治体の一覧・公式サイト URL・位置 | 機械的に悉皆。**本 index が `website` の出典として使っている** |
| [code4fukui/opendatacity](https://github.com/code4fukui/opendatacity) (MIT) | **SSL 対応率・ドメイン・`.lg.jp` 採用**、プログラミング教育対応 | 全自治体を機械的に悉皆測定し、ダッシュボードで可視化 |
| デジタル庁 [オープンデータ取組済自治体一覧](https://data.e-gov.go.jp/data/dataset/digi_20220315_0064) | 取組済か否かの**二値** | 自治体からの報告 |
| デジタル庁 [オープンデータ取組の質評価指標 (ベータ版)](https://www.digital.go.jp/resources/open_data/materials-for-learning/) | 推進体制 / 公開範囲 / 運用 / データ品質 / 共創・連携 の **5 観点** | **自治体の自己評価** (Excel) |
| デジタル庁 [自治体標準オープンデータセット](https://www.digital.go.jp/resources/data_dataset) | — (形式の標準。評価指標ではない) | — |

**空いているのは「その情報を実際に使えるか」である。**

- `opendatacity` は**実測だが技術属性**を測る。サイトが https か、どのドメインか。「イベント情報が機械可読で取れるか」は測らない
- デジタル庁の質評価指標は**多面的だが自己評価**で、観点も組織・運用 (推進体制、共創・連携) が中心。使う側から見た取得可能性ではない
- 取組済自治体一覧は**粒度がゼロ** (約 74% が「取組済」)

本 index は **実測かつ情報の使用可能性**を、**情報領域ごと**に測る。先行事例と競合せず、その隣に置かれるものである。

**上流への還元:** 実測で `localgovjp` 由来の公式 URL に古いもの (404) を 1 件見つけた (`municipalities/saitama/moroyama-town/web.yaml` に記録)。この種の食い違いは、見つけたら上流に戻すのが筋である。

### なぜこの空白が残っていたか

見落とされていたからではない。**やれなかったから**である。

`localgovjp` / `opendatacity` が測っているのは、**判断の要らないもの**である。SSL か否か、ドメイン文字列、URL が応答するか。すべて機械的に決まる。だから一人がスクリプトを書けば 1,786 自治体を悉皆測定でき、実際にそうされている (2017 年から継続、直近の更新は 2026-01)。

本 index が測ろうとしているものは違う。

- この HTML の表は機械可読か
- このフィードの粒度で、規則を再構成できるか
- このライセンスで再利用してよいか
- この配信元は、その街の予定を知るのに足りているか

**どれも判断が要る。** 機械的な測定はスケールしたが、判断はスケールしなかった。だから「サイトが安全か」までは全国分が揃い、「その情報を実際に使えるか」は空白のまま残った。

### なぜ今か

判断を要する測定のコストが下がった。LLM が一次情報を読んで分類できるようになったことで、**1 自治体あたり人間が数十分かけていた作業が、人間の確認つきで数分になる**。

これは「自動化したから正しくなる」という話ではない。**判断は依然として間違う**ので、本 index は間違いを構造で captures する側に設計を倒している (§中核の原則)。推定と観測を分け、未調査を 0 点にせず、裏付けの無い段を明示する。**判断のコストが下がったぶん、判断の質を検査する仕組みに投じている。**

### だから「完成品」ではなく「土台」である

一人で全国 1,786 自治体を埋めるのは、いまでも不可能である。本 index は**各自治体や住民が自分の街ぶんを足していく**形でしか成立しない。

そのため設計は次を優先している:

- **LLM から操作できること** — 手順書 ([`docs/playbook.md`](docs/playbook.md))、エージェント向けの手引き ([`AGENTS.md`](AGENTS.md))、機械可読な schema
- **間違いが黙って通らないこと** — 検査をゲートに配線し、壊したデータで落ちることを確認する
- **部分的な貢献が受け入れられること** — `unknown` は 0 点ではない。1 軸だけ測って出すこともできる

**現状、本 index の実測は 30 自治体である。** 先行事例の 1,786 件に比べれば桁が 2 つ足りない。**この方法が全国規模で成立するかは、まだ証明されていない。**

## 中核の原則

**測っていない値を、測った値のように見せない。** これは標語ではなく、schema が構造で強制する:

- 各軸の値は必ず**由来**を持つ — `measured` / `inherited` / `estimated` / `unknown`
- **`unknown` は 0 点ではない。** 値を持たない (null)。未調査の自治体が「悪い」ように見えるのは評価として誤り
- **コア合計は 5 軸すべてが値を持つときだけ出す。** 1 軸でも `unknown` なら合計は null。部分和を 100 点満点として見せない
- **継承できるのは A / F / G のみ。** CMS family の代表実測から継承する。B (機械可読性) / C (粒度) / D (ライセンス) / E (検証可能性) は自治体の運用が決めるので継承できない
- **指紋の観測方法を記録する。** HTML に現れたのか、応答から推定したのかを区別する。推定だけで閾値を満たす同定は、観測で満たしたものより弱いとデータから導出できる
- **コア 100 点と追加軸 (F・G) を合算した総合点は作らない。** 合算するとコア部分の横断比較が壊れる

正典は [`docs/index.md`](docs/index.md)。配点・ランク閾値・由来の扱いはそこが決める。

## 構成

| 場所 | 内容 |
|---|---|
| [`docs/index.md`](docs/index.md) | **指標の正典** — コア 5 軸・配点・由来・測定地点・プロファイル規約 |
| `schema/domains.yaml` | 情報領域の語彙 (自治体標準オープンデータセット 22 件 + 拡張) |
| `schema/*.schema.json` | family / web / assessment / profile の JSON Schema |
| `families/<id>.yaml` | **CMS 系統ごとの指紋と取得口。** 代表実測から群全体に展開する仕組み |
| `municipalities/<県>/<handle>/web.yaml` | 自治体ごとの基盤 (family 判定・指紋・実際に使った URL) |
| `municipalities/<県>/<handle>/assessments/<領域>.yaml` | 領域ごとの評価 (配信元単位) |
| `scripts/` | 指紋採取・採点・検証 |

`handle` は [tecolicom/city-tecoli-data](https://github.com/tecolicom/city-tecoli-data) の `municipalities.yaml` (lg.jp ドメイン準拠、全 1,786 件) を引く。**自前で採番しない。**

## 収録状況

一人で全国 1,786 自治体を調べるのは不可能である。本 index は完成品のデータセットではなく、**各自治体や住民が自分の街ぶんを足していける土台**として作っている。

現時点:

- **CMS family: 1 件** (`fam-feedphp-sitenew`。**製品名は未特定**。指紋で群として同定できれば実用になる、というのが設計の前提)
- **実測済み: 埼玉県 30 自治体** の web 基盤
- **評価 (assessments): 埼玉の予定・催事 16 配信元** — F / G (`g_proxy`) だけを facts から導出。コア 5 軸は未調査 (`unknown`。0 点ではない)。F は全件 `estimated` (トップページでの観測)、G は 2 件が `measured`。段階表は `schema/profiles/dynamic.yaml`、裏付けの有無は docs/index.md §7

埼玉 30 件の実測から分かったこと:

| 項目 | 結果 |
|---|---|
| `fam-feedphp-sitenew` に該当 | 6 件 |
| どの family にも未同定 | 24 件 |
| 条件付き GET (ETag / Last-Modified) | **全 30 件が対応** (非対応 0 件) |

## はじめに

> **現状、この CI は赤になります。** `city-tecoli-data` の公開レジストリに `website` が無いため、`validate` が「レジストリが `website` を持たない」として落ちます。緑にするには `city-tecoli-data` に `website` 入りのレジストリを push する必要があります。**緑にするために検査を緩めないこと** — 黙ってスキップする設計は意図的に取り除いたものです。

自分の自治体を足したい人・エージェントはここから:

| 読むもの | 誰向け |
|---|---|
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 人 — 自分の町を足したい |
| [`AGENTS.md`](AGENTS.md) | エージェント (Claude Code / Codex) |
| [`docs/playbook.md`](docs/playbook.md) | 収録手順書 — 手順・判断基準・実際に踏んだ失敗 |

時系列観測・消滅検知は未実装 ([`docs/monitoring.md`](docs/monitoring.md) に範囲だけ宣言)。

## 取得の礼儀 (貢献する人は必ず読むこと)

対象は**他者の、それも公共機関のサーバ**である。以下は交渉の余地がない:

- **robots.txt を尊重する。指紋採取も例外ではない**
- **1 自治体あたりトップページ 1 回が基本** (robots.txt はホストごと 1 回でキャッシュ)
- **リクエスト間隔は 2 秒以上、同時実行は 1**
- **取得結果をキャッシュし、再実行で再取得しない**
- **User-Agent に実在する連絡先 URL を入れる**
- **脆弱性探索をしない。** 管理画面のパス探索・既知脆弱性の試行・認証の試験を一切行わない。取得するのは公開ページと robots.txt だけ
- **調査対象サイトの本文を repo に取り込まない**

これらは `scripts/_lib/fetch.mjs` の `politeFetch` が実装している。**素の `fetch` を直接呼ばないこと。** リダイレクト先のホストが変われば、そのホストの robots.txt を改めて確認してから進む (RFC 9309 では robots.txt は authority 単位)。

## 使い方

```
make setup   # 依存を入れる
make test    # 全ゲート (schema 検証 + ESLint + 単体テスト)
make help    # コマンド一覧
```

## ライセンス

**CC BY 4.0** ([`LICENSE`](LICENSE))。出典を明記すれば自由に利用できる。

データも文書も同じライセンスとする。収録しているのは我々の独自の調査・分析であり、帰属表示を求めるのが筋であるため。

## 関連

- [tecolicom/japan-gomi-data](https://github.com/tecolicom/japan-gomi-data) — 姉妹 repo。ごみ収集日のオープンデータ。本 index のコア 5 軸はここで確立した指標を継承している
- [tecolicom/city-tecoli-data](https://github.com/tecolicom/city-tecoli-data) — 自治体レジストリ (handle の正典)
- [code4fukui/localgovjp](https://github.com/code4fukui/localgovjp) — 全自治体の一覧と公式サイト URL。**本 index の `website` の出典** (CC0)
- [code4fukui/opendatacity](https://github.com/code4fukui/opendatacity) — 全自治体サイトの SSL・ドメインの実測と可視化。本 index と対象が重ならない先行事例

---

**未着手・未確定のもの** (拾える仕事。一覧は [`docs/playbook.md`](docs/playbook.md) 末尾):

- family 候補 3 系統 (代表実測が無いので `families/` に未登録。`docs/measurements/saitama-2026-10-24.md`)
- 標準 OD の悉皆確認 (埼玉 30 件すべて「未確認」)
- F の `measured` (配信元 URL そのものでの条件付き GET。現状 0 件)
- 非 lg.jp の配信元 (図書館・観光協会・商工会議所)
- 時系列観測 (監視層。[`docs/monitoring.md`](docs/monitoring.md))
