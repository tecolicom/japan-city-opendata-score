// 取得層のテスト。**ネットワークには一切出ない** — fetch は必ず注入する。
// 目的は「礼儀をそう書いた」ではなく「そう動く」ことを示すこと。
// 偽の fetch が受け取った URL・ヘッダ・呼び出し回数・同時実行数・待ち時間を記録して検証する。
import { test } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { politeFetch, robotsAllows, USER_AGENT, MIN_INTERVAL_MS, MAX_REDIRECTS } from './fetch.mjs';

const TOP = 'https://example.invalid/';
const OTHER = 'https://example.invalid/sub/';
const ROBOTS = 'https://example.invalid/robots.txt';
const ALLOW_ALL = 'User-agent: *\nDisallow:';

const freshCache = () => mkdtempSync(join(tmpdir(), 'jpdi-cache-'));

// 待ち時間は記録するだけで実際には待たない (テストを 2 秒 × n で遅くしないため)。
const sleepRecorder = () => {
  const waits = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
};

// 偽の fetch。呼ばれた URL とヘッダ、同時に走った数を記録する。
function fetchRecorder({ robots = ALLOW_ALL, robotsStatus = 200, page = '<html>擬似</html>', pageStatus = 200, routes = {} } = {}) {
  const calls = [];
  const state = { inFlight: 0, maxInFlight: 0 };
  const impl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers ?? {} });
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((r) => setTimeout(r, 0)); // 同時実行があれば観測できるよう 1 tick 譲る
    state.inFlight -= 1;
    const route = routes[u];
    if (route !== undefined) {
      return new Response(route.body ?? '', {
        status: route.status ?? 200,
        headers: { 'content-type': 'text/html; charset=utf-8', ...(route.location ? { location: route.location } : {}) },
      });
    }
    const isRobots = u.endsWith('/robots.txt');
    return new Response(isRobots ? robots : page, {
      status: isRobots ? robotsStatus : pageStatus,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };
  return { impl, calls, urls: () => calls.map((c) => c.url), state };
}

// 時計を止めておくと「間隔を空けたか」が経過時間に揺らされずに測れる。
const frozenNow = () => 1_700_000_000_000;

const base = (extra = {}) => {
  const rec = fetchRecorder(extra.recorder);
  const slp = sleepRecorder();
  return {
    rec,
    slp,
    opts: { cacheDir: extra.cacheDir ?? freshCache(), _fetch: rec.impl, _sleep: slp.sleep, _now: frozenNow, ...extra.opts },
  };
};

// ---- Review Focus 1: robots.txt の尊重 ----

test('robots.txt が禁じているパスは取得しない', async () => {
  const { rec, opts } = base();
  const r = await politeFetch(TOP, { ...opts, _robots: 'User-agent: *\nDisallow: /' });
  assert.equal(r.status, 'robots-denied');
  assert.equal(r.body, undefined);        // 本文を取っていない
  assert.deepEqual(rec.urls(), []);       // そもそも 1 度もネットワークに出ていない
});

test('robots.txt が取得できないとき (5xx) は取得を見送る', async () => {
  const { rec, opts } = base({ recorder: { robotsStatus: 503 } });
  const r = await politeFetch(TOP, opts);
  assert.equal(r.status, 'robots-denied');
  assert.equal(r.body, undefined);
  assert.deepEqual(rec.urls(), [ROBOTS]);  // robots.txt を見に行っただけで本文は取っていない
});

// robots.txt の 4xx を一律で「無い = 全許可」と読むと、429 (叩きすぎだ) や
// 403 (見せない) を取得の許可として解釈してしまう。しかも absent はディスクに焼かれるため
// 再実行でも永久に固定される。許可と読めるのは 404 / 410 だけ。
for (const code of [429, 403]) {
  test(`robots.txt が ${code} のときは取得を見送り、覚えない`, async () => {
    const cacheDir = freshCache();
    const { rec, opts } = base({ cacheDir, recorder: { robotsStatus: code } });
    const r = await politeFetch(TOP, opts);
    assert.equal(r.status, 'robots-denied');
    assert.equal(r.reason, 'robots-unavailable');
    assert.equal(r.body, undefined);
    assert.deepEqual(rec.urls(), [ROBOTS]);   // 本文を取りに行っていない
    // 一時的な拒否を焼かない (再実行で永久に固定されないこと)
    assert.equal(existsSync(join(cacheDir, 'robots')), false, 'robots.txt の取得失敗を焼いている');
    assert.equal(existsSync(join(cacheDir, 'pages')), false, '一時的な拒否を焼いている');
  });
}

test('robots.txt が 404 なら制限なしとして扱う', async () => {
  const { opts } = base({ recorder: { robotsStatus: 404 } });
  const r = await politeFetch(TOP, opts);
  assert.equal(r.status, 'ok');
});

test('robots.txt はホストごとに 1 回しか取らない', async () => {
  const { rec, opts } = base();
  await politeFetch(TOP, opts);
  await politeFetch(OTHER, opts);
  assert.equal(rec.urls().filter((u) => u === ROBOTS).length, 1);
});

test('取得するのは robots.txt と指定 URL だけ、各 1 回 (探索も再取得もしない)', async () => {
  const { rec, opts } = base();
  await politeFetch(TOP, opts);
  // 集合ではなく**列**を固定する。重複を潰すと「ページを 2 回叩く実装」も通ってしまう。
  // 順序も固定されるので「robots.txt を先に見ている」ことの証拠にもなる。
  assert.deepEqual(rec.urls(), [ROBOTS, TOP]);
});

// ---- robots.txt のパース ----

test('robotsAllows は最長一致で Allow / Disallow を決める', () => {
  const txt = 'User-agent: *\nDisallow: /cgi-bin/\nAllow: /cgi-bin/feed.php\n';
  assert.equal(robotsAllows(txt, '/cgi-bin/feed.php?siteNew=1'), true);
  assert.equal(robotsAllows(txt, '/cgi-bin/admin'), false);
  assert.equal(robotsAllows(txt, '/'), true);
});

test('robotsAllows は * と $ を解釈する', () => {
  assert.equal(robotsAllows('User-agent: *\nDisallow: /*.pdf$', '/a/b.pdf'), false);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /*.pdf$', '/a/b.pdf?x=1'), true);
});

test('robotsAllows は空の Disallow を全許可として扱う', () => {
  assert.equal(robotsAllows('User-agent: *\nDisallow:', '/anything'), true);
});

test('robotsAllows は自分の product token のグループを * より優先する', () => {
  const txt = 'User-agent: *\nDisallow:\n\nUser-agent: japan-city-data-usability\nDisallow: /\n';
  assert.equal(robotsAllows(txt, '/'), false);
});

test('robotsAllows は該当グループが無ければ全許可', () => {
  assert.equal(robotsAllows('User-agent: Googlebot\nDisallow: /', '/'), true);
});

test('robotsAllows はコメントを無視する', () => {
  assert.equal(robotsAllows('User-agent: *  # 全部\nDisallow: /secret  # 秘密', '/secret/x'), false);
});

// ---- キャッシュ ----

test('キャッシュがあれば再取得しない', async () => {
  const cacheDir = freshCache();
  const first = base({ cacheDir });
  const r1 = await politeFetch(TOP, first.opts);
  assert.equal(r1.fromCache, false);

  // 2 回目は別プロセス相当 (記録器も作り直す) — ディスクのキャッシュだけが頼り
  const second = base({ cacheDir });
  const r2 = await politeFetch(TOP, second.opts);
  assert.equal(r2.fromCache, true);
  assert.equal(r2.body, r1.body);
  assert.deepEqual(second.rec.urls(), []);   // robots.txt すら引き直さない
});

test('robots-denied もキャッシュして再実行で叩き直さない', async () => {
  const cacheDir = freshCache();
  const first = base({ cacheDir, recorder: { robots: 'User-agent: *\nDisallow: /' } });
  assert.equal((await politeFetch(TOP, first.opts)).status, 'robots-denied');
  const second = base({ cacheDir });
  const r = await politeFetch(TOP, second.opts);
  assert.equal(r.status, 'robots-denied');
  assert.equal(r.fromCache, true);
  assert.deepEqual(second.rec.urls(), []);
});

// テスト自体にも制限を付ける: 取得側のタイムアウトが外れたら「落ちる」(ハングしない)。
test('一時障害 (タイムアウト) はキャッシュしない', { timeout: 5000 }, async () => {
  const cacheDir = freshCache();
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
  });
  const slp = sleepRecorder();
  const r1 = await politeFetch(TOP, { cacheDir, _robots: ALLOW_ALL, _fetch: hang, _sleep: slp.sleep, _now: frozenNow, timeoutMs: 20 });
  assert.equal(r1.status, 'timeout');
  assert.equal(r1.body, undefined);
  const retry = base({ cacheDir });
  const r2 = await politeFetch(TOP, retry.opts);
  assert.equal(r2.status, 'ok');
  assert.equal(r2.fromCache, false);
});

test('cacheDir を渡さない呼び出しは拒否する (黙って再取得させない)', async () => {
  const { opts } = base();
  await assert.rejects(() => politeFetch(TOP, { ...opts, cacheDir: undefined }), /cacheDir/);
});

// ---- User-Agent ----

test('User-Agent に連絡先 URL が入る', () => {
  assert.match(USER_AGENT, /\+https?:\/\//);
});

test('実際のリクエストすべてに連絡先つき User-Agent が載る', async () => {
  const { rec, opts } = base();
  await politeFetch(TOP, opts);
  assert.ok(rec.calls.length >= 2);
  for (const c of rec.calls) {
    const ua = c.headers['user-agent'] ?? c.headers['User-Agent'];
    assert.match(ua ?? '', /\+https?:\/\//, c.url);
  }
});

// ---- 間隔と同時実行 ----

test('既定の間隔は 2 秒以上', () => {
  assert.ok(MIN_INTERVAL_MS >= 2000, String(MIN_INTERVAL_MS));
});

test('リクエストの間に既定 2 秒以上の間隔を置く', async () => {
  const { slp, opts } = base();
  await politeFetch(TOP, opts);
  await politeFetch(OTHER, opts);
  assert.ok(slp.waits.length >= 1, '待ちが 1 度も入っていない');
  for (const ms of slp.waits) assert.ok(ms >= MIN_INTERVAL_MS, `待ち ${ms}ms`);
});

test('robots.txt の Crawl-delay が 2 秒より長ければそれに従う', async () => {
  const { slp, opts } = base({ recorder: { robots: 'User-agent: *\nCrawl-delay: 5\nDisallow:' } });
  await politeFetch(TOP, opts);
  await politeFetch(OTHER, opts);
  assert.ok(Math.max(...slp.waits) >= 5000, JSON.stringify(slp.waits));
});

test('同時実行は 1 に絞られる', async () => {
  const { rec, opts } = base();
  await Promise.all([TOP, OTHER, 'https://example.invalid/third/'].map((u) => politeFetch(u, opts)));
  assert.equal(rec.state.maxInFlight, 1);
});

// ---- その他の応答 ----

test('HTTP エラーは本文を持たず httpStatus を記録する', async () => {
  const { opts } = base({ recorder: { pageStatus: 404 } });
  const r = await politeFetch(TOP, opts);
  assert.equal(r.status, 'http-error');
  assert.equal(r.httpStatus, 404);
  assert.equal(r.body, undefined);
});

test('成功時は本文とヘッダを返す', async () => {
  const { opts } = base();
  const r = await politeFetch(TOP, opts);
  assert.equal(r.status, 'ok');
  assert.equal(r.httpStatus, 200);
  assert.equal(r.body, '<html>擬似</html>');
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
});

// ---- リダイレクト: 移転先のホストの robots.txt を改めて確認する ----
// lg.jp では `city.x.lg.jp` → `www.city.x.lg.jp` の形が頻出し、これは別オリジンになる。
// 自動 follow に任せると、元ホストの robots.txt だけ見て別ホストの本文を取ることになる。

const A = 'https://a.invalid/';
const B = 'https://b.invalid/';

test('別ホストへリダイレクトされたら移転先の robots.txt を確認し、禁止なら本文を取らない', async () => {
  const { rec, opts } = base({ recorder: { routes: {
    [A]: { status: 301, location: B },
    'https://b.invalid/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /' },
  } } });
  const r = await politeFetch(A, opts);
  assert.equal(r.status, 'robots-denied');
  assert.equal(r.body, undefined);
  assert.ok(rec.urls().includes('https://b.invalid/robots.txt'), '移転先の robots.txt を見ていない');
  assert.ok(!rec.urls().includes(B), '移転先の本文を取ってしまっている');
  assert.deepEqual(r.redirects, [A]);
});

test('移転先が許可していればリダイレクトを追って取得する', async () => {
  const { opts } = base({ recorder: { routes: {
    [A]: { status: 301, location: B },
    [B]: { status: 200, body: '<html>移転先</html>' },
  } } });
  const r = await politeFetch(A, opts);
  assert.equal(r.status, 'ok');
  assert.equal(r.body, '<html>移転先</html>');
  assert.equal(r.url, B);
  assert.deepEqual(r.redirects, [A]);
});

test('リダイレクトの輪は打ち切る', async () => {
  const { rec, opts } = base({ recorder: { routes: {
    [A]: { status: 302, location: B },
    [B]: { status: 302, location: A },
  } } });
  const r = await politeFetch(A, opts);
  assert.equal(r.status, 'redirect-loop');
  assert.equal(r.body, undefined);
  assert.ok(rec.urls().filter((u) => u === A || u === B).length <= 3, JSON.stringify(rec.urls()));
});

test('リダイレクトの連鎖に上限を設ける', async () => {
  const routes = {};
  for (let i = 0; i < 12; i += 1) routes[`https://hop.invalid/${i}`] = { status: 301, location: `https://hop.invalid/${i + 1}` };
  const { rec, opts } = base({ recorder: { routes } });
  const r = await politeFetch('https://hop.invalid/0', opts);
  assert.equal(r.status, 'too-many-redirects');
  assert.equal(r.body, undefined);
  const pageHits = rec.urls().filter((u) => !u.endsWith('/robots.txt'));
  assert.equal(pageHits.length, MAX_REDIRECTS + 1, JSON.stringify(pageHits));
});

test('同じ cacheDir を相対/絶対で渡しても礼儀の状態は 1 本 (負荷が倍にならない)', async () => {
  const abs = freshCache();
  const rel = relative(process.cwd(), abs);
  const rec = fetchRecorder();
  const slp = sleepRecorder();
  const common = { _fetch: rec.impl, _sleep: slp.sleep, _now: frozenNow };
  await Promise.all([
    politeFetch(TOP, { ...common, cacheDir: abs }),
    politeFetch(OTHER, { ...common, cacheDir: rel }),
  ]);
  assert.equal(rec.state.maxInFlight, 1);
  assert.equal(rec.urls().filter((u) => u === ROBOTS).length, 1);
});

// ---- 本物の fetch で確かめる (ループバックのみ。外には出ない) ----
// リダイレクト処理は「Node の fetch が redirect: 'manual' で本物の 3xx と location を返す」
// ことに全部乗っている。偽 fetch だけで確かめると、ここが違っていたときに
// 「HTTP 0 エラー」が永続キャッシュされ、www へ飛ぶ自治体が二度と取得されなくなる。
test('本物の fetch でも 3xx を自分で追い、移転先の robots.txt を見る', { timeout: 10000 }, async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(ALLOW_ALL); return; }
    if (req.url === '/') { res.writeHead(301, { location: '/dest' }); res.end(); return; }
    if (req.url === '/dest') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>移転先</html>'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    // _fetch は注入しない (本物の fetch を使う)。待ちだけ潰してテストを速く保つ。
    const r = await politeFetch(`${origin}/`, { cacheDir: freshCache(), _sleep: async () => {} });
    assert.equal(r.status, 'ok');
    assert.equal(r.httpStatus, 200);
    assert.equal(r.body, '<html>移転先</html>');
    assert.equal(r.url, `${origin}/dest`);
    assert.deepEqual(r.redirects, [`${origin}/`]);
    assert.deepEqual(seen, ['/robots.txt', '/', '/dest']);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('robots.txt が取れない理由を cause に残す (判断は拒否のまま)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-cause-'));
  const _fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  const r = await politeFetch('https://nx.example.invalid/', { cacheDir: dir, _fetch, _sleep: async () => {} });
  assert.equal(r.status, 'robots-denied');
  assert.equal(r.reason, 'robots-unavailable');
  assert.equal(r.cause, 'network:ENOTFOUND');
});
