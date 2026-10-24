# 収録手順書 — 自治体 1 つを足す

新しい自治体 (または領域) を足す手順と、判断の基準と罠。人も LLM もこの順に進める。指標の定義は [`index.md`](index.md)、実測の前例は [`measurements/saitama-2026-10-24.md`](measurements/saitama-2026-10-24.md)。

**この手順書が前提にする事実 (2026-10-24 時点):**

- **`npm run validate` はレジストリ (`municipalities.yaml`) を必須とし、見つからなければ落ちる。** handle の実在と、`web.yaml` の `url` とレジストリ `website` の整合を検査する。レジストリは `--registry <path>` > 環境変数 `REGISTRY_PATH` > 隣の `../city-tecoli-data/municipalities/municipalities.yaml` の順で探す。CI も同じ (レジストリを checkout して `REGISTRY_PATH` で渡す)。以前は `--registry` を付けたときだけ効き、CI は付けておらず検査が素通りしていた (4 回目の「配線されていない検査」。Ruling AL で直した)
- 足場と指紋採取は `make new HANDLE=<h>` / `make fingerprint PREF=<県> HANDLES=a,b` でも呼べる (実体は `npm run`)
- 取得結果のキャッシュ (`cache/`) は git 管理外で共有されない。**クローンした直後は空で、初回は実際に取得が発生する。** だから取得の礼儀の制約がある (これは正常。`politeFetch` が robots を確認して取得し、キャッシュを作る)。

## 全体像

| Step | やること | コマンド / 成果物 | 外部リクエスト |
|---|---|---|---|
| 0 | 環境を整える | `make setup` | なし |
| 1 | レジストリから handle を引く | `municipalities.yaml` を検索 | なし |
| 2 | 足場を作る | `make new HANDLE=<h>` (= `npm run new -- --handle <h>`) | なし |
| 3 | 指紋を採る (自治体につき 1 回) | `npm run fingerprint -- --pref <p> --handles <h>` → `web.yaml` | トップ 1 + robots 1 |
| 4 | family 判定の結果を読む | `web.yaml` の `family_id` / `family_confidence` | なし |
| 5 | 配信元を洗い出す | 取得済みトップページのリンク → `assessments/<領域>.yaml` | なし (取得は別判断) |
| 6 | 観測した事実だけを facts に書き、軸を導出する | `npm run apply-profile` | なし |
| 7 | 検査する (レジストリ照合は既定で有効) | `npm run validate` | なし |
| 8 | 全ゲートを通してコミット | `npm test` | なし |

## 絶対に守る (取得の礼儀)

**対象は他者の、公共機関のサーバ。** 破ると枠組み全体の信用が失われる。

- 取得は **`scripts/_lib/fetch.mjs` の `politeFetch` 経由のみ**。素の `fetch` / `curl` / ブラウザ自動化で調査対象に触らない
- robots.txt を尊重する (指紋採取も例外ではない)。**取れない場合も「許可」と解釈しない** (`politeFetch` が拒否する。それが正しい挙動)
- 1 自治体あたりトップページ 1 回が基本。間隔 2 秒以上・同時実行 1・キャッシュ済みは再取得しない
- 管理画面・既知パス・脆弱性の探索はしない。取得するのは公開ページと robots.txt だけ
- リダイレクト先のホストが変わったら、そのホストの robots.txt を確認してから進む (`politeFetch` が自動でやる)
- 調査対象サイトの本文を repo に取り込まない。記録するのは判定結果・signal・短い要約だけ

## Step 1. handle を引く

handle は**自分で綴らない**。レジストリ `city-tecoli-data/municipalities/municipalities.yaml` (全 1,786 件) の `handle` / `code` / `website` を使う。

```
grep -B2 -A8 'name_ja: 越生町' ../city-tecoli-data/municipalities/municipalities.yaml
```

罠: 越生町の handle は `ogose` ではなく **`ogose-town`**。町村は `-town` / `-village` の接尾辞が付く。推測で `ogose` と打つと `npm run new` が「handle がレジストリに無い」で止まる (止まるのが正しい)。

レジストリは `../city-tecoli-data/` (この repo の隣) にある前提。別の場所なら `REGISTRY_PATH` か `--registry <path>`。

## Step 2. 足場

```
make new HANDLE=ogose-town       # または npm run new -- --handle ogose-town
```

`municipalities/<県>/<handle>/` ができる。県ディレクトリは code から導出され、`--pref` を渡して食い違えば失敗する。出力の 3 列目は取得の起点 URL (レジストリの `website`)。

**この時点では `web.yaml` も `assessments/` も無い。空のディレクトリのまま `validate` は通る** (何も無い = 未調査)。`assessments/` は配信元を 1 件以上見つけるまで作らない (schema が空を許さない。何も見つからなかったという記録は「調べた」ように見えるので置かない)。

## Step 3. 指紋を採る

### URL の決め方 — 推測しない

**取得の起点は必ずレジストリの `website`。** URL を handle から組み立てない。

- 埼玉だけでも `www.city.saitama.jp` / `www.city.kawagoe.saitama.jp` / `www.city.kumagaya.lg.jp` とばらばらで、**`lg.jp` ですらない自治体が多数**
- 「`city.<label>.lg.jp` のはず」と組み立てて 3 件とも取得できなかった実例がある (この repo の最初の実行)。`www.` の有無も一定でない
- `website` が空の自治体は `no-verified-url` で止まる。現状 (1,786 件すべてに URL がある) そういう自治体は無い。**将来出たら推測しない。`web.yaml` を作らず、未解決として記録して相談する**

### レジストリの website が古いとき

毛呂山町 (`moroyama-town`) は `.../www/index.html` が 404 だった。

- **レジストリ (生成物) を手で直さない。** 直しても次の生成で消え、出典データの古さの記録も失われる
- 指紋採取 CLI は、`website` が 404/410 でパスを持つときだけ、サイトのルートを 1 回試す。成功すると `web.yaml` に `url` (実際に使った URL)、`registry_website` (レジストリの値)、`url_note` (日付と根拠) が自動で入る
- これ以外の代替 URL を試すときは、**使った URL と根拠を自分で `web.yaml` に書く** (`registry_website` + `url_note.observed_at` + `url_note.reason`)。推測ではなく観測に基づく理由を書く
- `url` とレジストリの `website` が違うのに `registry_website` / `url_note` が無いと、`npm run validate` が落ちる

### 小さく始めてから広げる

いきなり多数に流さない。

1. **まず 3〜4 件**で止める。`--handles a,b,c` か `--limit 4`
2. 止めて確認する: リクエスト数 (`cache/requests.jsonl`)、間隔 (2 秒)、robots の判定 (`robots-denied` が出ていないか)、キャッシュの中身 (`cache/pages/`, `cache/robots/`)
3. 問題が無ければ広げる

### 陰性対照を置く

**既知 family に該当しないと分かっている自治体を 1 つ混ぜる。** 判定が正しく「当たらない」ことを確認するため。埼玉では所沢市 (`tokorozawa`) を使い、`family_id: null` / `none` になった。全件が当たる、全件が外れる、のどちらも判定の故障を疑う。

```
npm run fingerprint -- --pref saitama --handles hanno,iruma,tokorozawa
```

結果は各自治体の `web.yaml` と `cache/fingerprint-run-<pref>.json`。ネットワーク失敗・robots 拒否は `status` と `reason` / `cause` に残る。

## Step 4. family 判定の結果を読む

`web.yaml` の見方:

| `family_id` | `family_confidence` | 意味 |
|---|---|---|
| `fam-…` | `observed` | HTML / ヘッダに現れた signal だけで閾値 (`min_signals`、既定 2) を満たした |
| `fam-…` | `inferred` | 応答ステータス等から推定した signal を足して初めて満たした。**観測だけの `observed` より弱い** |
| `null` | `below` | どの family の閾値にも届かないが、痕跡は 1 本以上ある。`signals_seen` に残る |
| `null` | `none` | 痕跡ゼロ。陰性対照が期待する値 |

- `family_confidence` は**導出値**。手で書かない (validate が再導出して照合する)
- **観測と推定を分ける**: `signals_seen[].method` が `html` / `header` / `asset_fetch` なら観測、応答ステータスからの推定は family 側の `inferred_from_status`。トップページ HTML にしか当たっていないものを「製品を特定した」と書かない
- 代表実測の handle なのに family が `null` になると `family_divergence` (観測日と理由) が要る。CLI が自動で付ける。理由文を消さない

### family を新設・昇格する

`families/` に載せるのは**代表実測があるものだけ**。現在は `fam-feedphp-sitenew` の 1 件。

**未確定の候補が 3 系統ある** (`docs/measurements/saitama-2026-10-24.md`「family 候補」)。次の調査者はここから拾える:

| 候補 | リンクの形 | 該当 (埼玉) |
|---|---|---|
| A | `event_calendar.html` + `news.rss` | kawagoe, kuki |
| B | `/rss/10/listN.xml` + `/calendar/` | ageo, asaka, higashimatsuyama, kounosu, niiza, shiki, toda |
| C | `rss_news.xml` | kumagaya, sayama, tokorozawa |

同じ形が見えただけで、**同一 CMS とは確認していない**。昇格するには、各候補で 2 件以上のトップページ実測と signal の選定が要る。`families/fam-feedphp-sitenew.yaml` を雛形にし、`measured_representatives` に代表実測を記録する。**製品名が不明なら `product: null`、id は指紋由来の仮 id** (製品名が判明したら `aliases` に足す。id は変えない)。

## Step 5. 配信元を洗い出す

配信元 = 情報を実際に出している主体の、実際の URL。評価は `(自治体 × 領域 × 配信元)` ごと。自治体本体のサイト以外が出していることがある。

| `entity_type` | 例 |
|---|---|
| `municipality` | 自治体公式サイト |
| `gaikaku` | 図書館・公民館など外郭団体 |
| `shoko` | 商工会議所・商工会 |
| `kanko` | 観光協会 |
| `shitei-kanrisha` | 指定管理者 |
| `kouiki` | 広域連合・一部事務組合 |

手順:

1. **トップページのリンクから辿れる範囲を基本とする。** 取得済みならキャッシュ (`cache/pages/<hash>.json` の `body`) を読む (追加の取得は要らない)。キャッシュが空なら Step 3 の取得でできる。**取得予算を先に決める** (例: 1 自治体あたり追加 3 リクエストまで)。**予算内で見つからなければ「未確認」として残し、「無い」と書かない。** 深追いしたくなったら、別の調査として予算を決め直す
2. `assessments/<領域>.yaml` に配信元を書く。`url` は href を解決しただけでも書いてよいが、**未取得なら `form` に「未取得」と明記する**
3. 領域は `schema/domains.yaml` の `id`。現在 `profile` を持つのは `schedule-events` (動的) と `gomi` (静的。本 repo では採点しない) だけ
4. 「カレンダーでさがす」のように表記が曖昧で配信元を特定できない自治体は、**ファイルを置かない** (= 未調査。埼玉では 14 自治体)。予算を超えて追いかけない
5. 非 lg.jp の配信元 (図書館・観光協会・商工会議所) は**まだ誰も着手していない**。見つけたら `entity_type` を付けて足す。共有する配信元 (広域連合など) は `shared_with` に全 handle を書く

**配信元 id は `<handle>/<publisher-slug>`。** slug は貢献者が決めるが、条件は 2 つ: **安定していること** (後から変えると UID が変わる)、**実体が分かること**。例: `hanno/city-site` (自治体サイト)、`hanno/lib-main` (図書館)、`hanno/cci-event` (商工会議所のイベント)、`hanno/tourism-news` (観光協会のお知らせ)。主体の種類は slug ではなく `entity_type` で区別する。

雛形 (最小):

```yaml
domain: schedule-events
surveyed_at: 2026-10-24
publishers:
  - id: <handle>/city-site          # <handle>/<slug>
    name_ja: ○○市 公式サイト (イベント一覧)
    entity_type: municipality
    domain_name: www.city.example.lg.jp   # url のホスト名と一致させる
    url: https://www.city.example.lg.jp/event_list.html
    form: イベント一覧 (HTML)。URL はトップページの href を解決しただけで未取得
```

## Step 6. 記録 — 何を書き、何を書かないか

**facts は観測した事実だけ。書かない項目は「未観測」を意味する。既定値を置かない。** `axes` は facts から導出する値で、手で書かない。

```
npm run apply-profile            # 全 assessment に段階表を当てる (差分が無ければ何も変えない)
npm run apply-profile -- --pref saitama
```

### 未確認と不在は別

- 案内ページ 1 枚を見て「標準 OD のイベント一覧が無い」とは書けない。**`standard_od: false` を書かず、未確認のまま残す。** `false` は悉皆確認 (カタログ本体と、案内ページがさらに誘導する先) をした後にだけ書く
- 実例: 埼玉では案内ページ 6 枚を見て見つからなかったが、不在の証明には足りないため、30 件すべて「未確認」
- `unknown` は 0 点ではない (null)。未調査の自治体を悪く見せない

### 観測と推定を分ける

- facts の値は観測。`estimated` は状況証拠からの推定で、**`notes` に根拠を書く**
- `conditional_get_scope` を必ず付ける: `site-top` (自治体トップページで観測) / `source` (配信元の URL そのもので観測)
- **F はトップページの観測で代用できない。** 条件付き GET を正しく測るには**配信元の URL そのもの**を取得する必要がある。トップページの値から導いた F は `estimated`。`measured` にするには `conditional_get_scope: source` で、配信元を取得して ETag / Last-Modified を確かめる (取得は `politeFetch` 経由・1 回)。**この観測は現時点で 0 件**
- 継承できるのは A / F / G のみ。B / C / D / E に `inherited` は付けられない (§4)。`inherited` には `inherited_from: {family_id, representative_handle}` が要る。調べていない自治体への一括生成は禁止、個別の継承記録は可

### 何を測ったかを狭く書く

- `G: 0` の根拠が「フィードのエンドポイント 1 つが 502」なら、そう書く。**「配信元全体の継続性」と読ませない。** 段階表の `row_note` から `notes` が自動生成される。生成された `notes` を手で書き換えない
- `feed_url_basis` を区別する: `page-link` (ページ上の href で存在を確認) / `assembled` (family の `feed_patterns` から組み立てた。**そのサイトがその URL で公開しているか未確認**)。`assembled` の 5xx は G の根拠にしない (G は unknown のまま)
- フィードが 502 のとき、`feed_format` と `conditional_get` は書かない (エラーページの ETag はフィードの事実ではない)

### ライセンスと本文

`license_text` は 200 字以内の要約か短い引用。サイト本文を転載しない。

## Step 7. 検査する — そしてゲートが落ちることを確かめる

```
npm run validate
```

レジストリ照合は既定で有効。次を検査する: **handle がレジストリに存在するか** (綴り違い — `ogose` と `ogose-town` — はここで落ちる)、**`web.yaml` の `url` がレジストリの `website` と整合するか** (違うなら `registry_website` + `url_note`)。**レジストリが見つからなければ落ちる** (黙ってスキップしない)。出力の末尾に `レジストリ照合あり: <path>` が出ていることを確かめる。

### 「検査を書いた」と「検査が走っている」は別

この repo で最も再発した失敗。**3 回**起きた:

1. `validate.mjs` がファイル名順に `web.yaml` を後で読み、継承の検査が**一度も効いていなかった**
2. 依存が無いと検査が**黙ってスキップ**されていた
3. 検査が**テストからしか呼ばれず**、`validate` 単体では効かなかった

**検査・段階表・schema の規則を足したら、壊したデータで実際にゲートが落ちることを確認する。** テストが落ちることではなく、**`npm run validate` (と `npm test`) が落ちること**を。手順:

```
cp municipalities/<県>/<h>/web.yaml /tmp/web.bak     # 退避
# 壊す (例: url を別の値に、family_confidence を手で書き換える 等)
npm run validate        # → 失敗するはず (npm test も落ちる)
cp /tmp/web.bak municipalities/<県>/<h>/web.yaml     # 戻す
git status --short                                    # 差分が残っていないこと
```

落ちなければ検査が効いていない。**緑のまま先に進まない。**

## Step 8. 通してコミット

```
npm test          # validate + ESLint + 単体テスト
git add municipalities/<県>/<handle> && git commit
```

- **緑でないコミットを残さない**
- `git add -A` を使わない (ファイルを指定する)
- 1 自治体 1 コミットが読みやすい。コミットメッセージは「何を観測したか」を書く

## 罠の一覧

| 罠 | 対処 |
|---|---|
| URL を handle から組み立てる | レジストリの `website` を使う (§Step 3) |
| レジストリの `website` が古い | レジストリを直さず `url` + `registry_website` + `url_note` を `web.yaml` に |
| いきなり大量に流す | 3〜4 件で止めて確認 (§Step 3) |
| 判定が全件当たる / 全件外れる | 陰性対照を置いて判定の故障を見分ける |
| 配信元を深追いする | 予算を先に決め、超えたら「未確認」で残す |
| 素の `fetch` / `curl` で調査対象に触る | `politeFetch` 経由のみ |
| 案内ページ 1 枚で「無い」と書く | `standard_od` を書かず未確認のまま |
| 推定を観測として書く | `method` と `conditional_get_scope` で区別、推定は `notes` に根拠 |
| 502 を「配信元の継続性 0」と読ませる | 何を測ったかを狭く書く (エンドポイント 1 つ) |
| トップページの条件付き GET を F の実測にする | 配信元 URL そのものを取得して `scope: source` |
| `validate` の「OK」を信じる | 末尾に `レジストリ照合あり` が出ていること。壊したデータで落ちることを確認 |
| 検査を足して満足する | 壊したデータでゲートが落ちることを確認 |
| 生成値 (`axes` / `family_confidence` / 生成 `notes`) を手で書く | `apply-profile` / 指紋採取に任せる |

## まだ誰もやっていないこと (拾える仕事)

- **family 候補 A / B / C の代表実測** (§Step 4)
- **標準 OD の悉皆確認** (埼玉 30 件すべて「未確認」)
- **F を `measured` にする** — 配信元 URL そのものでの条件付き GET (現状 0 件)
- **非 lg.jp の配信元** — 図書館・観光協会・商工会議所
- **埼玉の残り 33 自治体**、および他県
- **`schedule-events` 以外の領域** — `schema/domains.yaml` に語彙はあるが `profile: null`。段階表 (`schema/profiles/`) から作る必要がある

## 隣の仕組み

hanno-data に予定の配信元を取り込むときの「先に決める 4 つ」(取り込んでよいか / 系統 / CI から通るか / 英訳するか) は `hanno-data/.claude/skills/adding-a-calendar-source/SKILL.md` にある。**本 repo の収録は評価の記録で、取り込みではない** が、配信元の洗い出しと取得の可否の判断は共通する。
