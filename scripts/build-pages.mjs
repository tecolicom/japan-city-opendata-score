// GitHub Pages 用の静的ページを YAML から生成する。
//
// **手書きの HTML を置かない。** 手書きは必ずデータとずれる。
// 出力は site/index.html の 1 枚。CI (pages.yml) が走らせて deploy する。
//
// このページの主な仕事は「スコアを見せること」ではなく、
// **何がまだ測れていないかを読み取れるようにすること**である。
// コア 5 軸は現在全件 unknown で、コア合計は全行 null である。
// それを空白や故障に見せず、測っていない状態として見せる。
import { readdirSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site');

// 由来 (provenance) は順序尺度: measured > estimated > unknown(不在)。
// dataviz スキルの ordinal ramp を使い、両モードで検証器を通してある
// (light: #1c5cab/#5598e7、dark: #86b6ef/#2a78d6 — ALL CHECKS PASS)。
// unknown は値ではなく**不在**なので、ramp の段ではなく中立色 + テクスチャにする。
const PROV = {
  measured: { ja: '実測', light: '#1c5cab', dark: '#86b6ef' },
  estimated: { ja: '推定', light: '#5598e7', dark: '#2a78d6' },
  unknown: { ja: '未調査', light: '#f0efec', dark: '#383835', absent: true },
};
const AXES = [
  ['A', '取得性'], ['B', '機械可読性'], ['C', '粒度'], ['D', 'ライセンス'],
  ['E', '検証可能性'], ['F', '更新検知性'], ['G', '継続性'],
];
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function loadAll() {
  const prefRoot = join(ROOT, 'municipalities');
  const rows = [];
  for (const pref of readdirSync(prefRoot)) {
    for (const handle of readdirSync(join(prefRoot, pref))) {
      const dir = join(prefRoot, pref, handle);
      const webPath = join(dir, 'web.yaml');
      if (!existsSync(webPath)) continue;
      const web = parse(readFileSync(webPath, 'utf8'));
      const aPath = join(dir, 'assessments', 'schedule-events.yaml');
      const pubs = existsSync(aPath) ? (parse(readFileSync(aPath, 'utf8')).publishers ?? []) : [];
      rows.push({ pref, handle, web, pubs });
    }
  }
  return rows.sort((a, b) => a.handle.localeCompare(b.handle));
}

function provCounts(rows) {
  const out = {};
  for (const [k] of AXES) out[k] = { measured: 0, estimated: 0, unknown: 0 };
  for (const r of rows) for (const p of r.pubs) for (const [k] of AXES) {
    const v = p.provenance?.[k] ?? 'unknown';
    if (out[k][v] !== undefined) out[k][v] += 1;
  }
  return out;
}

// 軸ごとの由来は**表**で出す。
//
// 棒グラフにしない理由: 現在 A〜E は全件 unknown、F は全件 estimated なので、
// 7 軸のうち 6 軸が「単色 1 本の棒」になる。それは棒グラフにする意味が無い
// (dataviz: 単一の値は stat tile、1 本だけの棒グラフは誤り)。
// 由来が混ざる軸が増えたら、そのとき積み棒に替えればよい。
function provRow(k, ja, c, total) {
  const cell = (v) => {
    const n = c[v];
    if (!n) return '<td class="n na">—</td>';
    const m = PROV[v];
    return `<td class="n"><i class="sw${m.absent ? ' absent' : ''}" style="--c:var(--p-${v})"></i>${n}</td>`;
  };
  const state = c.measured ? 'measured' : c.estimated ? 'estimated' : 'unknown';
  return `<tr class="prov-${state}">
  <td><b>${k}</b> ${ja}</td>${cell('measured')}${cell('estimated')}${cell('unknown')}
  <td class="n na">${total ? `${((c.measured / total) * 100).toFixed(0)}%` : '—'}</td>
</tr>`;
}

const rows = loadAll();
const pubTotal = rows.reduce((n, r) => n + r.pubs.length, 0);
const counts = provCounts(rows);
const coreMeasured = ['A', 'B', 'C', 'D', 'E'].reduce((n, k) => n + counts[k].measured, 0);
const famIdentified = rows.filter((r) => r.web.family_id).length;
const confDist = rows.reduce((m, r) => { const c = r.web.family_confidence ?? 'none'; m[c] = (m[c] ?? 0) + 1; return m; }, {});
const asOf = rows.map((r) => r.web.fingerprinted_at).filter(Boolean).sort().at(-1) ?? '';

const tiles = [
  ['調査済みの自治体', rows.length, '件'],
  ['特定した配信元', pubTotal, '件'],
  ['コア 5 軸の実測', coreMeasured, `/ ${pubTotal * 5} 件`],
  ['CMS 系統を同定', famIdentified, `/ ${rows.length} 件`],
];

const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>自治体オープンデータ 使えるか指標</title>
<meta name="description" content="全国の自治体が web で発信する情報が実際に使えるかを実測で評価する。現在は埼玉県 ${rows.length} 自治体。">
<style>
:root{
  --p-measured:${PROV.measured.light}; --p-estimated:${PROV.estimated.light}; --p-unknown:${PROV.unknown.light};
  --surface:#fcfcfb; --ink:#1a1a19; --ink-2:#55544f; --ink-3:#8a8880; --rule:#e5e3de; --card:#fff;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --p-measured:${PROV.measured.dark}; --p-estimated:${PROV.estimated.dark}; --p-unknown:${PROV.unknown.dark};
  --surface:#1a1a19; --ink:#f2f1ee; --ink-2:#b4b2aa; --ink-3:#807e77; --rule:#33322f; --card:#232320;
}}
:root[data-theme="dark"]{
  --p-measured:${PROV.measured.dark}; --p-estimated:${PROV.estimated.dark}; --p-unknown:${PROV.unknown.dark};
  --surface:#1a1a19; --ink:#f2f1ee; --ink-2:#b4b2aa; --ink-3:#807e77; --rule:#33322f; --card:#232320;
}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--ink);
  font:16px/1.7 system-ui,-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif}
.wrap{max-width:60rem;margin:0 auto;padding:2.5rem 16px 5rem}
h1{font-size:1.6rem;line-height:1.35;margin:0 0 .5rem}
h2{font-size:1.1rem;margin:3rem 0 .75rem;padding-bottom:.4rem;border-bottom:1px solid var(--rule)}
p{margin:.6rem 0;color:var(--ink-2)}
a{color:var(--p-measured)}
.lede{font-size:1.05rem;color:var(--ink)}
.note{font-size:.9rem;color:var(--ink-3)}
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.75rem;margin:1.75rem 0}
.tile{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:.9rem 1rem}
.tile dt{font-size:.8rem;color:var(--ink-3);margin:0 0 .25rem}
.tile dd{margin:0;font-size:1.9rem;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.tile dd small{font-size:.85rem;font-weight:400;color:var(--ink-3);margin-left:.2rem}
.tile.flag dd{color:var(--p-measured)}
.callout{background:var(--card);border:1px solid var(--rule);border-left:3px solid var(--p-measured);
  border-radius:0 10px 10px 0;padding:1rem 1.1rem;margin:1.5rem 0}
.callout p:first-child{margin-top:0}.callout p:last-child{margin-bottom:0}
.axis{display:grid;grid-template-columns:9.5rem 1fr;gap:.5rem .9rem;align-items:center;margin:.35rem 0}
.axis-l{font-size:.85rem;color:var(--ink-2);text-align:right}
.axis-l b{color:var(--ink);font-weight:600}
.tbl.prov td:first-child{color:var(--ink-2)}
.tbl.prov td:first-child b{color:var(--ink);font-weight:600}
.tbl.prov tr.prov-unknown td{color:var(--ink-3)}
.tbl.prov .sw{display:inline-block;margin-right:.35rem;vertical-align:-1px}
.legend{display:flex;flex-wrap:wrap;gap:1rem;margin:1rem 0 0;font-size:.85rem;color:var(--ink-2)}
.legend span{display:inline-flex;align-items:center;gap:.4rem}
.sw{width:.85rem;height:.85rem;border-radius:3px;background:var(--c);flex:none}
.sw.absent{background:repeating-linear-gradient(45deg,var(--c),var(--c) 3px,transparent 3px,transparent 5px),var(--c);
  outline:1px solid var(--rule);outline-offset:-1px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.tbl{width:100%;border-collapse:collapse;font-size:.88rem;margin-top:.5rem}
.tbl th,.tbl td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--rule);vertical-align:top}
.tbl th{font-size:.78rem;color:var(--ink-3);font-weight:600;white-space:nowrap}
.tbl td.n{font-variant-numeric:tabular-nums}
.tbl .na{color:var(--ink-3)}
.pill{display:inline-block;font-size:.75rem;padding:.1rem .45rem;border-radius:999px;
  border:1px solid var(--rule);color:var(--ink-2);white-space:nowrap}
.pill.on{border-color:var(--p-measured);color:var(--p-measured)}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
ul{color:var(--ink-2)}li{margin:.3rem 0}
footer{margin-top:4rem;padding-top:1.25rem;border-top:1px solid var(--rule);font-size:.85rem;color:var(--ink-3)}
</style></head><body>
<div class="wrap">

<h1>自治体オープンデータ 使えるか指標</h1>
<p class="lede">全国の自治体が web で発信する情報が「<b>実際に使えるか</b>」を実測で評価する。
測るのは「オープンデータとして立派か」ではなく「市民・開発者が実際に使えるか」。</p>
<p class="note">現在の収録: 埼玉県 ${rows.length} 自治体 / 指紋採取 ${esc(asOf)} 時点。
このページは YAML から生成している (手書きではない)。</p>

<dl class="kpi">
${tiles.map(([t, v, u], i) => `<div class="tile${i === 2 ? ' flag' : ''}"><dt>${t}</dt>
  <dd>${v}<small>${u}</small></dd></div>`).join('\n')}
</dl>

<div class="callout">
<p><b>コア 5 軸はまだ 1 件も実測できていない。</b>
今あるのは web 発信基盤の実測 (どの CMS 系統か、更新を検知できるか) までで、
情報そのものの使えるかを測るには配信元の中身に踏み込む必要がある。</p>
<p class="note">このページが空に見えるのは故障ではない。
未調査を 0 点にせず、測っていないものは測っていないと表示する設計である
(<a href="https://github.com/tecolicom/japan-city-opendata-score/blob/main/docs/index.md">指標の正典</a>)。</p>
</div>

<h2>軸ごとの由来</h2>
<p>配信元 ${pubTotal} 件について、各軸の値がどこから来たか。<b>件数</b>であって配点ではない。</p>
<div class="scroll"><table class="tbl prov">
<thead><tr><th>軸</th>
  <th class="n"><i class="sw" style="--c:var(--p-measured)"></i>実測</th>
  <th class="n"><i class="sw" style="--c:var(--p-estimated)"></i>推定</th>
  <th class="n"><i class="sw absent" style="--c:var(--p-unknown)"></i>未調査</th>
  <th class="n">実測率</th></tr></thead>
<tbody>
${AXES.map(([k, ja]) => provRow(k, ja, counts[k], pubTotal)).join('\n')}
</tbody></table></div>
<p class="note" style="margin-top:1rem"><b>コア 5 軸 (A〜E) は全件が未調査である。</b>
F が全件「推定」なのは、条件付き GET を<b>自治体トップページ</b>で観測しており、
配信元 URL そのものでは未確認であるため。正しく実測するには配信元 URL を取得する必要がある。
G の実測 2 件は、フィードのエンドポイントが 5xx を返したことのみを根拠としている
(その配信元の HTML ページは同時点で取得できている)。</p>

<h2>CMS 系統の同定</h2>
<p>同じ CMS なら取得口の形も罠も同じなので、系統を同定できれば代表 1 件の実測を群に展開できる。
これが全国 1,786 自治体を一人で調べられない問題への答えになる。</p>
<div class="scroll"><table class="tbl">
<thead><tr><th>確度</th><th>意味</th><th class="n">件数</th></tr></thead><tbody>
<tr><td><span class="pill on">observed</span></td><td>直接観測した指紋だけで閾値を満たす</td><td class="n">${confDist.observed ?? 0}</td></tr>
<tr><td><span class="pill">below</span></td><td>指紋が当たったが閾値未満 (部分一致)</td><td class="n">${confDist.below ?? 0}</td></tr>
<tr><td><span class="pill">none</span></td><td>どの系統にも当たらなかった</td><td class="n">${confDist.none ?? 0}</td></tr>
</tbody></table></div>
<p class="note">同定済み ${famIdentified} 件はすべて <code>fam-feedphp-sitenew</code>。
<b>この系統の製品名は未特定である。</b>指紋で群として同定できれば実用になる、というのが設計の前提。
部分一致 ${confDist.below ?? 0} 件は「まだ同定できていない系統の候補」として残している。</p>

<h2>自治体ごと</h2>
<div class="scroll"><table class="tbl">
<thead><tr><th>handle</th><th>CMS 系統</th><th>確度</th><th class="n">配信元</th><th>条件付き GET</th><th>コア合計</th></tr></thead>
<tbody>
${rows.map((r) => {
  const cg = [...new Set(r.pubs.map((p) => p.facts?.conditional_get).filter(Boolean))];
  const conf = r.web.family_confidence ?? 'none';
  return `<tr>
  <td><code>${esc(r.handle)}</code></td>
  <td>${r.web.family_id ? `<code>${esc(r.web.family_id)}</code>` : '<span class="na">未同定</span>'}</td>
  <td><span class="pill${conf === 'observed' ? ' on' : ''}">${esc(conf)}</span></td>
  <td class="n">${r.pubs.length || '<span class="na">0</span>'}</td>
  <td>${cg.length ? esc(cg.join(', ')) : '<span class="na">未調査</span>'}</td>
  <td><span class="na">未算出</span></td>
</tr>`;
}).join('\n')}
</tbody></table></div>
<p class="note">「コア合計 未算出」は、コア 5 軸すべてに値がある行だけ合計を出す規則による。
1 軸でも未調査なら合計は出さない (部分和を 100 点満点として見せない)。</p>

<h2>拾える仕事</h2>
<ul>
<li><b>F を実測にする</b> — 配信元 URL そのものでの条件付き GET。現在 0 件</li>
<li><b>コア 5 軸の実測</b> — 配信元の中身に踏み込む。現在 0 件</li>
<li><b>標準オープンデータセット「イベント一覧」の有無</b> — ${rows.length} 件すべて未確認</li>
<li><b>CMS 系統の候補 3 系統</b> — 代表実測が無いので未登録</li>
<li><b>非 lg.jp の配信元</b> — 図書館・観光協会・商工会議所。未着手</li>
<li><b>埼玉以外</b> — 全国 1,786 自治体のうち ${rows.length} 件</li>
</ul>

<footer>
<p>データ・文書: CC BY 4.0 /
<a href="https://github.com/tecolicom/japan-city-opendata-score">tecolicom/japan-city-opendata-score</a></p>
<p>自治体の一覧と公式サイト URL は
<a href="https://github.com/code4fukui/localgovjp">code4fukui/localgovjp</a> (CC0) に依拠している。
<b>スコアは改善の材料であって成績表ではない。</b>低い自治体を非難する趣旨ではない。</p>
</footer>

</div></body></html>
`;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'index.html'), html);
writeFileSync(join(OUT, '.nojekyll'), '');
console.log(`pages: site/index.html (自治体 ${rows.length} 件 / 配信元 ${pubTotal} 件 / コア実測 ${coreMeasured} 件)`);
