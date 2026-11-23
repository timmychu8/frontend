/**
 * 台股零股持股雷達 — Cloudflare Workers CORS 代理（單一檔案）
 * ------------------------------------------------------------
 * 只代理「白名單」內的官方一手資料來源：
 *   - 臺灣證券交易所 TWSE OpenAPI      https://openapi.twse.com.tw/v1
 *   - 臺灣證券交易所 三大法人日報 T86     https://www.twse.com.tw/rwd/zh/fund/T86
 *   - 證券櫃檯買賣中心 TPEx OpenAPI     https://www.tpex.org.tw/openapi/v1
 *   - 臺灣集中保管結算所 集保戶股權分散表  https://opendata.tdcc.com.tw/getOD.ashx?id=1-5
 * 不抓任何新聞媒體、不做二手轉述。
 *
 * 設計重點：Workers 免費方案每次請求只有約 10ms CPU，
 * 因此本代理「不解析」大型 JSON / CSV，只做轉送＋快取＋CORS，
 * 欄位正規化全部交給前端（iPhone 解析 1~4MB 資料毫無壓力）。
 *
 * 路由：
 *   GET /                 健康檢查
 *   GET /api/list         列出所有資料集代號
 *   GET /api/probe        逐一測試每個資料集（看哪個官方端點可用）
 *   GET /api/:dataset     取得資料（insti_L 可加 ?date=YYYYMMDD）
 *
 * 可選環境變數（Workers ➜ Settings ➜ Variables）：
 *   ALLOWED_ORIGIN  例如 https://yourname.github.io  （不設則用下方 DEFAULT_ALLOWED_ORIGIN）
 *
 * 注意：來源鎖定只能擋住「別人的網頁」借用這個代理；直接用程式呼叫（不帶 Origin）仍可存取。
 */
const DEFAULT_ALLOWED_ORIGIN = 'https://timmychu8.github.io';

const TWSE = 'https://openapi.twse.com.tw/v1';
const TPEX = 'https://www.tpex.org.tw/openapi/v1';

// 每個資料集可列多個候選 URL：官方偶爾改路徑，代理會依序嘗試，第一個回傳非空資料者勝出。
// ttl：邊緣快取秒數。type：json（陣列）或 csv。
const DATASETS = {
  // 1. 每日重大訊息
  news_L:   { label: '上市 每日重大訊息', ttl: 300,  type: 'json', urls: [`${TWSE}/opendata/t187ap04_L`] },
  news_O:   { label: '上櫃 每日重大訊息', ttl: 300,  type: 'json', urls: [`${TPEX}/mopsfe_t187ap04_O`, `${TPEX}/t187ap04_O`] },
  // 2. 每月營業收入
  rev_L:    { label: '上市 月營收彙總', ttl: 3600, type: 'json', urls: [`${TWSE}/opendata/t187ap05_L`] },
  rev_O:    { label: '上櫃 月營收彙總', ttl: 3600, type: 'json', urls: [`${TPEX}/mopsfe_t187ap05_O`, `${TPEX}/t187ap05_O`] },
  // 3. 季報 EPS 與三率
  eps_L:    { label: '上市 EPS 統計', ttl: 21600, type: 'json', urls: [`${TWSE}/opendata/t187ap14_L`] },
  eps_O:    { label: '上櫃 EPS 統計', ttl: 21600, type: 'json', urls: [`${TPEX}/mopsfe_t187ap14_O`, `${TPEX}/t187ap14_O`] },
  prof_L:   { label: '上市 營益分析(三率)', ttl: 21600, type: 'json', urls: [`${TWSE}/opendata/t187ap17_L`] },
  prof_O:   { label: '上櫃 營益分析(三率)', ttl: 21600, type: 'json', urls: [`${TPEX}/mopsfe_t187ap17_O`, `${TPEX}/t187ap17_O`] },
  // 4. 股利分派、除權息、殖利率、收盤價
  div_L:    { label: '上市 股利分派', ttl: 21600, type: 'json', urls: [`${TWSE}/opendata/t187ap45_L`] },
  div_O:    { label: '上櫃 股利分派', ttl: 21600, type: 'json', urls: [`${TPEX}/mopsfe_t187ap45_O`, `${TPEX}/t187ap45_O`] },
  exdiv_L:  { label: '上市 除權息預告', ttl: 3600, type: 'json', urls: [`${TWSE}/exchangeReport/TWT48U_ALL`] },
  exdiv_O:  { label: '上櫃 除權息預告', ttl: 3600, type: 'json', urls: [`${TPEX}/tpex_exright_prepost_schedule`, `${TPEX}/tpex_exright_daily`] },
  pe_L:     { label: '上市 本益比/殖利率', ttl: 3600, type: 'json', urls: [`${TWSE}/exchangeReport/BWIBBU_ALL`] },
  pe_O:     { label: '上櫃 本益比/殖利率', ttl: 3600, type: 'json', urls: [`${TPEX}/tpex_mainboard_peratio_analysis`] },
  price_L:  { label: '上市 日收盤行情', ttl: 1800, type: 'json', urls: [`${TWSE}/exchangeReport/STOCK_DAY_ALL`] },
  price_O:  { label: '上櫃 日收盤行情', ttl: 1800, type: 'json', urls: [`${TPEX}/tpex_mainboard_daily_close_quotes`] },
  // 5. 三大法人
  insti_L:  { label: '上市 三大法人(T86)', ttl: 1800, type: 't86' },
  insti_O:  { label: '上櫃 三大法人', ttl: 1800, type: 'json', urls: [`${TPEX}/tpex_3insti_daily_trading`] },
  // 6. 融資融券
  credit_L: { label: '上市 融資融券餘額', ttl: 1800, type: 'json', urls: [`${TWSE}/exchangeReport/MI_MARGN`] },
  credit_O: { label: '上櫃 融資融券餘額', ttl: 1800, type: 'json', urls: [`${TPEX}/tpex_mainboard_margin_balance`] },
  // 8. 公司基本資料（取得已發行股數，計算「占股本比例」）
  basic_L:  { label: '上市 公司基本資料', ttl: 86400, type: 'json', urls: [`${TWSE}/opendata/t187ap03_L`] },
  basic_O:  { label: '上櫃 公司基本資料', ttl: 86400, type: 'json', urls: [`${TPEX}/mopsfin_t187ap03_O`, `${TPEX}/mopsfe_t187ap03_O`, `${TPEX}/t187ap03_O`] },
  // 9. 處置股、注意股
  punish_L: { label: '上市 處置股', ttl: 1800, type: 'json', urls: [`${TWSE}/announcement/punish`] },
  punish_O: { label: '上櫃 處置股', ttl: 1800, type: 'json', urls: [`${TPEX}/tpex_disposal_information`, `${TPEX}/tpex_disposal_info`] },
  notice_L: { label: '上市 注意股', ttl: 1800, type: 'json', urls: [`${TWSE}/announcement/notice`] },
  notice_O: { label: '上櫃 注意股', ttl: 1800, type: 'json', urls: [`${TPEX}/tpex_trading_warning_information`, `${TPEX}/tpex_trading_warning_info`] },
  // 10. 股東會日期、董監質押
  agm_L:    { label: '上市 股東會日期', ttl: 21600, type: 'json', urls: [`${TWSE}/opendata/t187ap41_L`] },
  agm_O:    { label: '上櫃 股東會日期', ttl: 21600, type: 'json', urls: [`${TPEX}/mopsfe_t187ap41_O`, `${TPEX}/t187ap41_O`] },
  pledge_L: { label: '上市 董監設質', ttl: 21600, type: 'json', urls: [`${TWSE}/opendata/t187ap09_L`] },
  pledge_O: { label: '上櫃 董監設質', ttl: 21600, type: 'json', urls: [`${TPEX}/mopsfe_t187ap09_O`, `${TPEX}/t187ap09_O`] },
  // 7. 集保戶股權分散表（每週）
  tdcc:     { label: '集保 股權分散表(週)', ttl: 21600, type: 'csv', urls: ['https://opendata.tdcc.com.tw/getOD.ashx?id=1-5'] },
};

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    // 來自其他網站的瀏覽器請求一律拒絕（健康檢查除外）
    const origin = request.headers.get('Origin');
    if (origin && cors['Access-Control-Allow-Origin'] === 'null' && url.pathname.startsWith('/api/')) {
      return json({ error: 'Origin not allowed' }, 403, cors);
    }
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, cors);

    const path = url.pathname.replace(/\/+$/, '');
    try {
      if (path === '' || path === '/') {
        return json({ ok: true, service: 'tw-stock-radar-proxy', datasets: Object.keys(DATASETS).length, time: new Date().toISOString() }, 200, cors);
      }
      if (path === '/api/list') {
        return json(Object.fromEntries(Object.entries(DATASETS).map(([k, v]) => [k, v.label])), 200, cors);
      }
      if (path === '/api/probe') {
        return json(await probeAll(), 200, cors);
      }
      const m = path.match(/^\/api\/([a-zA-Z0-9_]+)$/);
      if (!m || !DATASETS[m[1]]) return json({ error: 'Unknown dataset', available: Object.keys(DATASETS) }, 404, cors);

      const key = m[1];
      const ds = DATASETS[key];
      const date = (url.searchParams.get('date') || '').replace(/\D/g, '');
      const fresh = url.searchParams.get('fresh') === '1';

      // 邊緣快取
      const cacheKey = new Request(`https://cache.local/${key}?date=${date}`);
      const cache = caches.default;
      if (!fresh) {
        const hit = await cache.match(cacheKey);
        if (hit) return withHeaders(hit, { ...cors, 'X-Cache': 'HIT' });
      }

      let result;
      if (ds.type === 't86') result = await fetchT86(date);
      else result = await fetchFirstGood(ds.urls, ds.type);

      if (!result) {
        // 沒資料（例如假日或官方暫停服務）：回 200 + 空陣列，前端據此顯示「無資料」
        return new Response('[]', { status: 200, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'X-Empty': '1', 'X-Dataset': key } });
      }

      // 歷史日期（T86 指定日期）資料不會再變，快取 7 天
      const ttl = date ? 604800 : ds.ttl;
      const headers = {
        'Content-Type': result.contentType,
        'Cache-Control': `public, max-age=60, s-maxage=${ttl}`,
        'X-Source-Url': result.src,
        'X-Data-Date': result.dataDate || '',
        'X-Fetched-At': new Date().toISOString(),
        'X-Dataset': key,
      };
      const resp = new Response(result.body, { status: 200, headers });
      ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return withHeaders(resp, { ...cors, 'X-Cache': 'MISS' });
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 502, cors);
    }
  },
};

/* ---------------- 上游抓取 ---------------- */

async function upstream(u, timeoutMs = 25000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort('timeout'), timeoutMs);
  try {
    return await fetch(u, {
      signal: ac.signal,
      headers: { 'User-Agent': UA, 'Accept': 'application/json,text/csv,*/*', 'Accept-Language': 'zh-TW,zh;q=0.9' },
      cf: { cacheTtl: 120, cacheEverything: true },
    });
  } finally {
    clearTimeout(t);
  }
}

// 依序嘗試候選 URL；只做「字串層級」的有效性檢查，不 JSON.parse（省 CPU）
async function fetchFirstGood(urls, type) {
  for (const u of urls) {
    try {
      const r = await upstream(u);
      if (!r.ok) continue;
      const body = await r.text();
      const head = body.slice(0, 200).trimStart();
      if (type === 'json') {
        if (head.startsWith('[') && body.length > 10) {
          return { body, src: u, contentType: 'application/json; charset=utf-8' };
        }
      } else if (type === 'csv') {
        if (body.length > 200 && !head.startsWith('<')) {
          return { body, src: u, contentType: 'text/csv; charset=utf-8' };
        }
      }
    } catch (_) { /* 換下一個候選 */ }
  }
  return null;
}

// TWSE 三大法人買賣超日報（全部，不含權證牛熊證）
// 未指定日期：從今天（台灣時間）往前找最近一個有資料的交易日
async function fetchT86(dateStr) {
  const tryDate = async (ymd) => {
    const u = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd}&selectType=ALLBUT0999&response=json`;
    const r = await upstream(u, 20000);
    if (!r.ok) return null;
    const body = await r.text();
    if (body.includes('"stat":"OK"') && body.includes('"data"')) {
      return { body, src: u, contentType: 'application/json; charset=utf-8', dataDate: ymd };
    }
    return null;
  };
  if (dateStr && dateStr.length === 8) return tryDate(dateStr);

  const now = new Date(Date.now() + 8 * 3600 * 1000); // 台灣時間
  // 盤後資料約 16:00 後才出，當天 16 點前從昨天開始找
  if (now.getUTCHours() < 16) now.setUTCDate(now.getUTCDate() - 1);
  for (let i = 0; i < 8; i++) {
    const d = new Date(now);
    d.setUTCDate(now.getUTCDate() - i);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const res = await tryDate(ymd);
    if (res) return res;
  }
  return null;
}

async function probeAll() {
  const out = {};
  const keys = Object.keys(DATASETS);
  await Promise.all(keys.map(async (k) => {
    const ds = DATASETS[k];
    const t0 = Date.now();
    try {
      const res = ds.type === 't86' ? await fetchT86('') : await fetchFirstGood(ds.urls, ds.type);
      out[k] = res
        ? { ok: true, label: ds.label, src: res.src, bytes: res.body.length, ms: Date.now() - t0 }
        : { ok: false, label: ds.label, tried: ds.urls || ['T86'], ms: Date.now() - t0 };
    } catch (e) {
      out[k] = { ok: false, label: ds.label, error: String(e), ms: Date.now() - t0 };
    }
  }));
  return out;
}

/* ---------------- 工具 ---------------- */

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '*';
  const allowed = (env && env.ALLOWED_ORIGIN) || DEFAULT_ALLOWED_ORIGIN;
  const allow = !allowed ? '*' : (allowed.split(',').map(s => s.trim()).includes(origin) ? origin : 'null');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-Source-Url, X-Data-Date, X-Fetched-At, X-Cache, X-Empty, X-Dataset',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function withHeaders(resp, extra) {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(resp.body, { status: resp.status, headers: h });
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
