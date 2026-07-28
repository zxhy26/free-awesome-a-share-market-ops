"use strict";

const dns = require("dns").promises;
const {execFile} = require("child_process");

const BOARD_CODE_PATTERN = /^BK\d{4}$/;
const EASTMONEY_HOST = "push2.eastmoney.com";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_CACHE_TTL_MS = 12000;
const SOURCE_NAME = "东方财富板块指数逐笔分时";
const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function normalizeBoardCode(value) {
  const code = String(value || "").trim().toUpperCase();
  if (!BOARD_CODE_PATTERN.test(code)) {
    throw Object.assign(new Error("板块代码无效。"), {
      statusCode: 400,
      code: "BOARD_CODE_INVALID",
    });
  }
  return code;
}

function normalizeTradeDate(value, date = new Date()) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : SHANGHAI_DATE_FORMATTER.format(date);
}

function tradeDateFromQuotePayload(payload) {
  const timestamp = finite(payload?.data?.f86);
  return timestamp && timestamp > 1000000000
    ? SHANGHAI_DATE_FORMATTER.format(new Date(timestamp * 1000))
    : "";
}

function marketMinuteFromTime(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  const seconds = hour * 3600 + minute * 60 + second;
  const morningStart = 9 * 3600 + 30 * 60;
  const morningEnd = 11 * 3600 + 30 * 60;
  const afternoonStart = 13 * 3600;
  const afternoonEnd = 15 * 3600;
  if (seconds < morningStart || seconds > afternoonEnd || (seconds > morningEnd && seconds < afternoonStart)) return null;
  if (seconds <= morningEnd) return (seconds - morningStart) / 60;
  return 120 + (seconds - afternoonStart) / 60;
}

function parseJsonOrJsonp(text) {
  const source = String(text || "").trim();
  const json = /^[\w$]+\(/.test(source)
    ? source.replace(/^[\w$]+\(/, "").replace(/\);?$/, "")
    : source;
  return JSON.parse(json);
}

function parseBoardDetailsPayload(payload, options = {}) {
  const data = payload?.data;
  const details = Array.isArray(data?.details) ? data.details : [];
  const preClose = finite(data?.prePrice);
  if (Number(payload?.rc) !== 0 || !data || !details.length || preClose === null || preClose <= 0) {
    throw Object.assign(new Error("板块指数分时接口没有返回有效数据。"), {
      statusCode: 502,
      code: "BOARD_INTRADAY_EMPTY",
    });
  }
  const tradeDate = normalizeTradeDate(options.tradeDate, options.now || new Date());
  const byMinute = new Map();
  for (const raw of details) {
    const fields = String(raw || "").split(",");
    const time = String(fields[0] || "").trim();
    const price = finite(fields[1]);
    const minute = marketMinuteFromTime(time);
    if (minute === null || price === null || price <= 0) continue;
    const normalizedMinute = round(minute, 4);
    byMinute.set(normalizedMinute, {
      tradeDate,
      minute: normalizedMinute,
      time: time.length === 5 ? `${time}:00` : time,
      price: round(price, 4),
      changePct: round(((price - preClose) / preClose) * 100, 4),
      volume: finite(fields[2]),
      source: "eastmoney-board-index-details",
    });
  }
  const points = [...byMinute.values()].sort((left, right) => left.minute - right.minute);
  if (!points.length) {
    throw Object.assign(new Error("板块指数分时接口没有返回交易时段样本。"), {
      statusCode: 502,
      code: "BOARD_INTRADAY_SESSION_EMPTY",
    });
  }
  return {
    code: normalizeBoardCode(options.code || data.code),
    name: String(options.name || data.name || data.code || "板块").trim(),
    tradeDate,
    preClose: round(preClose, 4),
    points,
    latestMinute: points.at(-1).minute,
    latestPrice: points.at(-1).price,
    latestChangePct: points.at(-1).changePct,
  };
}

async function fetchTextWithFetch(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json,text/plain,*/*",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Referer: "https://quote.eastmoney.com/",
        "User-Agent": "Mozilla/5.0",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function fetchCurlText(url, timeoutMs, resolveIp = "") {
  const timeoutSeconds = Math.max(6, Math.ceil(timeoutMs / 1000));
  const parsed = new URL(url);
  const args = [
    "-L",
    "--fail",
    "--silent",
    "--show-error",
    "--compressed",
    "--connect-timeout",
    String(Math.min(8, timeoutSeconds)),
    "--max-time",
    String(timeoutSeconds),
    "-H",
    "Referer: https://quote.eastmoney.com/",
    "-H",
    "User-Agent: Mozilla/5.0",
  ];
  if (resolveIp) args.push("--resolve", `${parsed.hostname}:443:${resolveIp}`);
  args.push(url);
  return new Promise((resolve, reject) => {
    execFile("curl.exe", args, {
      encoding: "utf8",
      timeout: (timeoutSeconds + 4) * 1000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message || "curl failed").trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

async function fetchEastmoneyText(url, timeoutMs) {
  const errors = [];
  try {
    return await fetchCurlText(url, timeoutMs);
  } catch (error) {
    errors.push(`系统解析: ${error.message}`);
  }
  let resolvedIps = [];
  try {
    resolvedIps = await dns.resolve4(EASTMONEY_HOST);
  } catch (_) {
    resolvedIps = [];
  }
  for (const ip of [...new Set(resolvedIps)]) {
    try {
      return await fetchCurlText(url, timeoutMs, ip);
    } catch (error) {
      errors.push(`${ip}: ${error.message}`);
    }
  }
  throw new Error(`板块指数分时行情不可用：${errors.at(-1) || "未知错误"}`);
}

function createBoardIntradayService(options = {}) {
  const fetchImpl = options.fetchImpl || null;
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const cacheTtlMs = Math.max(1000, Number(options.cacheTtlMs) || DEFAULT_CACHE_TTL_MS);
  const cache = new Map();

  async function getTimeline(rawCode, name = "", rawTradeDate = "") {
    const code = normalizeBoardCode(rawCode);
    const tradeDate = normalizeTradeDate(rawTradeDate, now());
    const key = `${tradeDate}:${code}`;
    const nowMs = now().getTime();
    const cached = cache.get(key);
    if (cached && nowMs - cached.cachedAtMs < cacheTtlMs) {
      return {...cached.payload, cached: true, cacheAgeMs: Math.max(0, nowMs - cached.cachedAtMs)};
    }
    const params = new URLSearchParams({
      secid: `90.${code}`,
      fields1: "f1,f2,f3,f4,f5",
      fields2: "f51,f52,f53,f54,f55",
      pos: "-10000",
      ut: "bd1d9ddb04089700cf9c27f6f7426281",
    });
    const url = `https://${EASTMONEY_HOST}/api/qt/stock/details/get?${params}`;
    const quoteParams = new URLSearchParams({
      secid: `90.${code}`,
      fields: "f57,f58,f60,f86",
      ut: "bd1d9ddb04089700cf9c27f6f7426281",
    });
    const quoteUrl = `https://${EASTMONEY_HOST}/api/qt/stock/get?${quoteParams}`;
    try {
      const readText = (target) => fetchImpl
        ? fetchTextWithFetch(fetchImpl, target, timeoutMs)
        : fetchEastmoneyText(target, timeoutMs);
      const [text, quoteText] = await Promise.all([
        readText(url),
        readText(quoteUrl).catch(() => ""),
      ]);
      const quotePayload = quoteText ? parseJsonOrJsonp(quoteText) : null;
      const sourceTradeDate = tradeDateFromQuotePayload(quotePayload);
      if (rawTradeDate && sourceTradeDate && rawTradeDate !== sourceTradeDate) {
        throw Object.assign(new Error(`行情源最新交易日为${sourceTradeDate}，拒绝将其标记为${rawTradeDate}。`), {
          statusCode: 409,
          code: "BOARD_INTRADAY_DATE_MISMATCH",
        });
      }
      const timeline = parseBoardDetailsPayload(parseJsonOrJsonp(text), {
        code,
        name: name || quotePayload?.data?.f58 || "",
        tradeDate: sourceTradeDate || tradeDate,
        now: now(),
      });
      const result = {
        ok: true,
        ...timeline,
        source: SOURCE_NAME,
        methodology: "板块指数相对昨收的真实逐笔涨跌幅曲线；盘中由全板块行情每秒轮询补充最新快照，不插值、不外推。",
        fetchedAt: now().toISOString(),
        cached: false,
        cacheAgeMs: 0,
      };
      cache.set(key, {cachedAtMs: nowMs, payload: result});
      return result;
    } catch (error) {
      if (cached) {
        return {
          ...cached.payload,
          cached: true,
          stale: true,
          cacheAgeMs: Math.max(0, nowMs - cached.cachedAtMs),
          warning: error.message || String(error),
        };
      }
      throw Object.assign(new Error(`板块指数分时读取失败：${error.message || error}`), {
        statusCode: error.statusCode || 502,
        code: error.code || "BOARD_INTRADAY_UNAVAILABLE",
      });
    }
  }

  return {
    getTimeline,
    getState: () => ({cacheEntries: cache.size, cacheTtlMs, source: SOURCE_NAME}),
  };
}

module.exports = {
  BOARD_CODE_PATTERN,
  SOURCE_NAME,
  createBoardIntradayService,
  marketMinuteFromTime,
  normalizeBoardCode,
  parseBoardDetailsPayload,
  tradeDateFromQuotePayload,
};
