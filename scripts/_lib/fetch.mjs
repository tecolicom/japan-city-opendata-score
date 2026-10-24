// 取得層。**礼儀はここの責務**で、判定層 (scripts/fingerprint.mjs) とは混ぜない。
//
// 対象は他者の、それも公共機関のサーバである。以下は交渉の余地がない:
//   - robots.txt を尊重する (指紋採取も例外ではない)。禁じられていたら本文を取らない
//   - robots.txt が取れないときは「取ってよい」と解釈しない (RFC 9309 と同じく安全側)
//   - 1 URL につきリクエストは 1 回。結果はキャッシュし、再実行で再取得しない
//   - 同時実行は 1。リクエストの間隔は既定 2 秒以上 (Crawl-delay が長ければそちらに従う)
//   - User-Agent に連絡先 URL を入れる
//   - タイムアウトを設ける
//   - 取得するのは指定された URL と robots.txt だけ。パスの探索はしない
//   - リダイレクトは自分で追う。**移転先のホストの robots.txt を改めて確認する**
//     (lg.jp では `city.x.lg.jp` → `www.city.x.lg.jp` の形が頻出し、別オリジンになる)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// 取得先のログに残る識別子。連絡先 URL (`+https://...`) を必ず含める。
export const UA_PRODUCT_TOKEN = 'japan-public-data-index';
export const USER_AGENT = `${UA_PRODUCT_TOKEN}/0.1 (+https://github.com/tecolicom/japan-public-data-index)`;

export const MIN_INTERVAL_MS = 2000;      // リクエスト間隔の下限
export const DEFAULT_TIMEOUT_MS = 15000;  // 無制限に待たない
export const MAX_REDIRECTS = 5;           // リダイレクトを追う上限

// ---- robots.txt ----

// User-agent グループに分ける。グループ外の行と解釈できない行は捨てる。
function parseGroups(text) {
  const groups = [];
  let current = null;
  let expectingAgents = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === 'user-agent') {
      if (current === null || !expectingAgents) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
        expectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (current === null) continue;
    expectingAgents = false;
    if (field === 'allow' || field === 'disallow') {
      if (value === '') continue;  // 空の Disallow / Allow は「制限なし」。規則にしない
      current.rules.push({ allow: field === 'allow', path: value });
    } else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  return groups;
}

// 自分の product token のグループを * より優先する。該当が無ければ null (= 制限なし)。
function selectGroup(groups, token) {
  const t = String(token).toLowerCase();
  const pick = (name) => groups.filter((g) => g.agents.includes(name));
  const chosen = pick(t).length > 0 ? pick(t) : pick('*');
  if (chosen.length === 0) return null;
  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelay: chosen.reduce((a, g) => (g.crawlDelay == null ? a : Math.max(a ?? 0, g.crawlDelay)), null),
  };
}

// robots の path パターン (`*` と末尾 `$`) を正規表現にする。
function ruleRegex(pattern) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = [...body]
    .map((ch) => (ch === '*' ? '.*' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${re}${anchored ? '$' : ''}`);
}

// RFC 9309 の最長一致。同じ長さなら Allow を優先する。該当規則が無ければ許可。
export function robotsAllows(text, path, token = UA_PRODUCT_TOKEN) {
  const group = selectGroup(parseGroups(text), token);
  if (group === null) return true;
  let best = null;
  for (const rule of group.rules) {
    if (!ruleRegex(rule.path).test(path)) continue;
    const len = rule.path.replace(/\$$/, '').length;
    if (best === null || len > best.len || (len === best.len && rule.allow)) best = { len, allow: rule.allow };
  }
  return best === null ? true : best.allow;
}

// Crawl-delay (ミリ秒)。指定が無ければ null。
export function robotsCrawlDelayMs(text, token = UA_PRODUCT_TOKEN) {
  const group = selectGroup(parseGroups(text), token);
  return group === null || group.crawlDelay == null ? null : Math.round(group.crawlDelay * 1000);
}

// ---- キャッシュ ----

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const pagePath = (cacheDir, href) => join(cacheDir, 'pages', `${sha256(href)}.json`);
const robotsPath = (cacheDir, origin) => join(cacheDir, 'robots', `${origin.replace(/[^a-z0-9.-]+/gi, '_')}.json`);

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;  // 壊れたキャッシュは「無い」として扱う (再取得はする)
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ---- 間隔と同時実行 ----

// 礼儀の状態 (直列化キュー・直近リクエスト時刻・robots の記憶) は cacheDir 単位で持つ。
// 実運用では cacheDir は 1 つなので事実上プロセス全体で 1 本。テストは別 cacheDir で隔離される。
const states = new Map();

function stateFor(cacheDir) {
  // 絶対パスに正規化する。同じディレクトリを相対/絶対で渡されて状態が 2 本に割れると、
  // 同時実行が 2 になり間隔も共有されなくなる (= 取得先に 2 倍の負荷がかかる)。
  const key = resolve(cacheDir);
  if (!states.has(key)) {
    states.set(key, { queue: Promise.resolve(), robots: new Map(), lastRequestAt: -Infinity });
  }
  return states.get(key);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const headersToObject = (headers) => {
  const out = {};
  if (headers && typeof headers.forEach === 'function') headers.forEach((v, k) => { out[String(k).toLowerCase()] = v; });
  return out;
};

// 間隔を空けてから 1 回だけ HTTP GET する。ここを通らないリクエストは存在しない。
async function request(href, ctx) {
  const wait = ctx.interval - (ctx._now() - ctx.st.lastRequestAt);
  if (wait > 0) await ctx._sleep(wait);
  ctx.st.lastRequestAt = ctx._now();

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`timeout after ${ctx.timeoutMs}ms`));
  }, ctx.timeoutMs);
  try {
    const res = await ctx._fetch(href, {
      headers: { 'user-agent': ctx.userAgent, accept: 'text/html,application/xhtml+xml,*/*;q=0.1' },
      redirect: 'manual',   // 追うかどうかは robots を見てから決める
      signal: controller.signal,
    });
    const headers = headersToObject(res.headers);
    if (res.status >= 300 && res.status < 400 && headers.location) {
      return { url: href, status: 'redirect', httpStatus: res.status, headers, location: headers.location };
    }
    if (!res.ok) return { url: href, status: 'http-error', httpStatus: res.status, headers };
    return { url: href, status: 'ok', httpStatus: res.status, headers, body: await res.text() };
  } catch (e) {
    return {
      url: href,
      status: timedOut ? 'timeout' : 'network-error',
      httpStatus: null,
      headers: {},
      error: String(e?.message ?? e),
    };
  } finally {
    clearTimeout(timer);
  }
}

// robots.txt 自身のリダイレクトは RFC 9309 に従って追う (移転先の robots.txt が正。
// ページと違い「その robots.txt を読む許可」を robots.txt に問うことはできない)。
async function requestFollowingRedirects(href, ctx) {
  let current = href;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await request(current, ctx);
    if (res.status !== 'redirect') return res;
    if (hop === MAX_REDIRECTS) return { ...res, status: 'too-many-redirects' };
    current = new URL(res.location, current).href;
  }
  return { url: href, status: 'too-many-redirects', httpStatus: null, headers: {} };
}

// ---- robots.txt の解決 (ホストごとに 1 回) ----

async function robotsRecordFor(origin, ctx) {
  if (ctx.st.robots.has(origin)) return ctx.st.robots.get(origin);
  const disk = readJson(robotsPath(ctx.cacheDir, origin));
  let record = disk;
  if (record === null) {
    const res = await requestFollowingRedirects(new URL('/robots.txt', origin).href, { ...ctx, interval: ctx.minIntervalMs });
    if (res.status === 'ok') record = { status: 'ok', body: res.body };
    else if (res.status === 'http-error' && res.httpStatus >= 400 && res.httpStatus < 500) record = { status: 'absent' };
    else record = { status: 'unavailable' };
    // 取れなかった (5xx / 通信障害 / タイムアウト) ものはディスクに焼かない。
    // 一時障害で永久に「取得禁止」に固定されるのを避ける。
    if (record.status !== 'unavailable') writeJson(robotsPath(ctx.cacheDir, origin), record);
  }
  ctx.st.robots.set(origin, record);
  return record;
}

// ---- 本体 ----

/**
 * robots.txt を尊重し、間隔を置き、結果をキャッシュして 1 URL を 1 回だけ取得する。
 *
 * 返り値: `{url, status, httpStatus, headers, body?, fromCache, reason?}`
 *   status: 'ok' | 'robots-denied' | 'http-error' | 'timeout' | 'network-error'
 *         | 'redirect-loop' | 'too-many-redirects'
 *   body は status が 'ok' のときだけ存在する。
 *
 * options:
 *   cacheDir   必須。キャッシュの置き場所 (無指定は拒否する)
 *   _robots    robots.txt の本文を注入する (テスト用。注入時は robots.txt を取得しない)
 *   _fetch / _sleep / _now  注入点 (テスト用)
 */
export async function politeFetch(url, options = {}) {
  const {
    cacheDir,
    _robots = null,
    _fetch = fetch,
    _sleep = sleep,
    _now = Date.now,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    minIntervalMs = MIN_INTERVAL_MS,
    userAgent = USER_AGENT,
    productToken = UA_PRODUCT_TOKEN,
  } = options;
  if (!cacheDir) {
    throw new TypeError('politeFetch: cacheDir は必須 (キャッシュ無しで他者のサーバを叩き直させない)');
  }
  const st = stateFor(cacheDir);
  const ctx = { cacheDir, _robots, _fetch, _sleep, _now, timeoutMs, minIntervalMs, userAgent, productToken, st };
  // 同時実行 1: すべての取得を 1 本のキューに直列化する。
  const run = st.queue.then(() => fetchOne(url, ctx));
  st.queue = run.then(() => undefined, () => undefined);
  return run;
}

// この URL を取ってよいか、間隔をどれだけ空けるかを robots.txt に問う。
async function robotsGate(u, ctx) {
  const record = ctx._robots == null
    ? await robotsRecordFor(u.origin, ctx)
    : { status: 'ok', body: ctx._robots };
  if (record.status === 'ok') {
    return {
      allowed: robotsAllows(record.body, `${u.pathname}${u.search}`, ctx.productToken),
      reason: 'rule',
      crawlDelayMs: robotsCrawlDelayMs(record.body, ctx.productToken),
    };
  }
  if (record.status === 'absent') return { allowed: true, reason: 'absent', crawlDelayMs: null };
  return { allowed: false, reason: 'robots-unavailable', crawlDelayMs: null };  // 取れないものを許可と解釈しない
}

const persist = (ctx, key, result) => {
  writeJson(pagePath(ctx.cacheDir, key), { ...result, fetched_at: new Date().toISOString() });
};

async function fetchOne(url, ctx) {
  const requested = new URL(url);
  const cached = readJson(pagePath(ctx.cacheDir, requested.href));
  if (cached !== null) return { ...cached, fromCache: true };

  const redirects = [];
  let current = requested;
  for (let hop = 0; ; hop += 1) {
    // リダイレクトを追うたびに、その**移転先のホストの** robots.txt を確認する。
    const gate = await robotsGate(current, ctx);
    if (!gate.allowed) {
      const result = {
        url: current.href,
        status: 'robots-denied',
        httpStatus: null,
        headers: {},
        reason: gate.reason,
        ...(redirects.length > 0 ? { redirects } : {}),
      };
      // 規則による禁止は永続化する (再実行で叩き直さない)。
      // robots.txt が取れなかっただけのものは焼かない (一時障害を恒久の禁止にしない)。
      if (gate.reason === 'rule') persist(ctx, requested.href, result);
      return { ...result, fromCache: false };
    }

    const res = await request(current.href, {
      ...ctx,
      interval: Math.max(ctx.minIntervalMs, gate.crawlDelayMs ?? 0),
    });

    if (res.status === 'redirect' && hop < MAX_REDIRECTS) {
      const next = new URL(res.location, current);
      if (next.href === current.href || redirects.includes(next.href)) {
        const loop = { ...res, status: 'redirect-loop', redirects: [...redirects, current.href] };
        persist(ctx, requested.href, loop);
        return { ...loop, fromCache: false };
      }
      redirects.push(current.href);
      current = next;
      continue;
    }

    const result = {
      ...(res.status === 'redirect' ? { ...res, status: 'too-many-redirects' } : res),
      ...(redirects.length > 0 ? { redirects } : {}),
    };
    // 一時障害はキャッシュしない (永久に再取得不能にならないように)。
    if (result.status !== 'timeout' && result.status !== 'network-error') persist(ctx, requested.href, result);
    return { ...result, fromCache: false };
  }
}
