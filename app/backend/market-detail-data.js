"use strict";

const {TextDecoder} = require("util");

const EASTMONEY_TOKEN = "bd1d9ddb04089700cf9c27f6f7426281";
const BOARD_CODE_PATTERN = /^BK\d{4}$/;
const STOCK_CODE_PATTERN = /^\d{6}$/;
const CACHE_TTL_MS = 30 * 1000;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 4) {
  const number = finite(value);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function cleanText(value, limit = 80) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function stockMarket(code, market) {
  if (String(market) === "1" || /^(5|6|9)/.test(code)) return 1;
  return 0;
}

function tencentSymbol(code, market) {
  if (/^(4|8|92)/.test(code)) return `bj${code}`;
  return stockMarket(code, market) === 1 ? `sh${code}` : `sz${code}`;
}

function compactTimestamp(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 12) return {date: "", timestamp: null};
  const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  const parsed = Date.parse(
    `${date}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14) || "00"}+08:00`,
  );
  return {
    date,
    timestamp: Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null,
  };
}

async function fetchBytes(fetchImpl, url, options = {}) {
  let lastError = null;
  const attempts = Math.max(1, Number(options.attempts) || 2);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 15000);
    try {
      const response = await fetchImpl(url, {
        cache: "no-store",
        redirect: "follow",
        headers: {
          "Accept": "application/json,text/plain,*/*",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36",
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 220 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError?.name === "AbortError" ? "请求超时" : (lastError?.message || "网络请求失败"));
}

async function fetchJson(fetchImpl, url, options = {}) {
  const text = (await fetchBytes(fetchImpl, url, options)).toString("utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`接口返回格式异常：${error.message}`);
  }
}

function dailySecid(target) {
  if (target.isSector) return `90.${target.boardCode}`;
  return `${stockMarket(target.code, target.market)}.${target.code}`;
}

async function loadDailyK(fetchImpl, target, limit) {
  const url = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
  Object.entries({
    secid: dailySecid(target),
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    klt: "101",
    fqt: "1",
    beg: "0",
    end: "20500101",
    lmt: String(limit),
    ut: EASTMONEY_TOKEN,
    _: String(Date.now()),
  }).forEach(([key, value]) => url.searchParams.set(key, value));
  const payload = await fetchJson(fetchImpl, url, {
    attempts: 3,
    timeoutMs: 18000,
    headers: {Referer: "https://quote.eastmoney.com/"},
  });
  const items = (Array.isArray(payload?.data?.klines) ? payload.data.klines : []).map((raw) => {
    const fields = String(raw || "").split(",");
    const open = finite(fields[1]);
    const close = finite(fields[2]);
    const high = finite(fields[3]);
    const low = finite(fields[4]);
    if (!fields[0] || [open, close, high, low].some((value) => value === null)) return null;
    return {
      date: fields[0],
      open,
      close,
      high,
      low,
      volume: finite(fields[5]),
      amount: finite(fields[6]),
      amplitude: finite(fields[7]),
      changePct: finite(fields[8]),
      change: finite(fields[9]),
      turnoverRate: finite(fields[10]),
    };
  }).filter(Boolean);
  if (items.length < 2) throw new Error("公开行情接口没有返回足够的真实日K样本");
  return {
    items,
    source: "本地服务转发的公开行情接口前复权日K",
    name: cleanText(payload?.data?.name || target.name),
    code: cleanText(payload?.data?.code || target.code || target.boardCode),
  };
}

async function loadStockQuote(fetchImpl, target) {
  const symbol = tencentSymbol(target.code, target.market);
  const buffer = await fetchBytes(fetchImpl, `https://qt.gtimg.cn/q=${symbol}&_=${Date.now()}`, {
    attempts: 2,
    timeoutMs: 15000,
    headers: {Referer: "https://gu.qq.com/"},
  });
  const text = new TextDecoder("gb18030").decode(buffer);
  const match = text.match(/="([^"]*)"/);
  const fields = match ? match[1].split("~") : [];
  const price = finite(fields[3]);
  const previousClose = finite(fields[4]);
  if (price === null || previousClose === null) throw new Error("实时行情接口没有返回有效报价");
  const time = compactTimestamp(fields[30]);
  return {
    price,
    previousClose,
    open: finite(fields[5]),
    volume: finite(fields[6]),
    high: finite(fields[33]),
    low: finite(fields[34]),
    change: finite(fields[31]) ?? round(price - previousClose),
    changePct: finite(fields[32]) ?? round(((price - previousClose) / previousClose) * 100),
    turnoverRate: finite(fields[38]),
    pe: finite(fields[39]),
    amount: finite(fields[37]) === null ? null : Math.round(Number(fields[37]) * 10000),
    date: time.date,
    sourceTimestamp: time.timestamp,
    source: "本地服务转发的腾讯实时行情",
  };
}

function normalizeTarget(input = {}) {
  const code = cleanText(input.code, 12).toUpperCase();
  const boardCode = cleanText(input.boardCode, 12).toUpperCase();
  const market = cleanText(input.market, 12).toLowerCase();
  const exactBoardCode = BOARD_CODE_PATTERN.test(boardCode)
    ? boardCode
    : (BOARD_CODE_PATTERN.test(code) ? code : "");
  const isSector = market === "sector" || Boolean(exactBoardCode);
  if (isSector && !exactBoardCode) {
    throw Object.assign(new Error("板块缺少可核验的公开行情代码"), {statusCode: 400});
  }
  if (!isSector && !STOCK_CODE_PATTERN.test(code)) {
    throw Object.assign(new Error("股票代码无效"), {statusCode: 400});
  }
  return {
    code: isSector ? (code || exactBoardCode) : code,
    boardCode: exactBoardCode,
    market: isSector ? "sector" : market,
    name: cleanText(input.name),
    isSector,
  };
}

function createMarketDetailDataService(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const boardIntraday = options.boardIntraday;
  const cache = new Map();
  if (typeof fetchImpl !== "function") throw new Error("market detail data service requires fetch");

  async function getDetail(input = {}) {
    const target = normalizeTarget(input);
    const limit = Math.max(30, Math.min(240, Number(input.limit) || 160));
    const key = `${target.market}:${target.boardCode || target.code}:${limit}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
      return {...cached.value, cached: true};
    }
    const tasks = [
      loadDailyK(fetchImpl, target, limit),
      target.isSector
        ? boardIntraday.getTimeline(target.boardCode, target.name)
        : loadStockQuote(fetchImpl, target),
    ];
    const [klineState, quoteState] = await Promise.allSettled(tasks);
    const errors = [];
    if (klineState.status === "rejected") errors.push(`日K：${klineState.reason?.message || "读取失败"}`);
    if (quoteState.status === "rejected") errors.push(`实时行情：${quoteState.reason?.message || "读取失败"}`);
    const rawQuote = quoteState.status === "fulfilled" ? quoteState.value : null;
    const quote = target.isSector && rawQuote
      ? (() => {
        const point = rawQuote.points?.at(-1);
        return point ? {
          price: point.price,
          changePct: point.changePct,
          date: rawQuote.tradeDate,
          source: rawQuote.source,
        } : null;
      })()
      : rawQuote;
    const result = {
      ok: klineState.status === "fulfilled" || Boolean(quote),
      target,
      kline: klineState.status === "fulfilled" ? klineState.value : null,
      quote,
      errors,
      fetchedAt: new Date().toISOString(),
      cached: false,
    };
    if (!result.ok) {
      throw Object.assign(new Error(errors.join("；") || "行情详情暂不可用"), {statusCode: 502});
    }
    cache.set(key, {savedAt: Date.now(), value: result});
    if (cache.size > 80) cache.delete(cache.keys().next().value);
    return result;
  }

  return {
    getDetail,
    getState: () => ({cacheEntries: cache.size, cacheTtlMs: CACHE_TTL_MS}),
  };
}

module.exports = {
  createMarketDetailDataService,
  normalizeTarget,
};
