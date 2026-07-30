"use strict";

const fs = require("fs");
const {execFile} = require("child_process");
const {INDEX_CATALOG, DEFAULT_INDEX_KEYS, findIndexDefinition, publicIndexCatalog} = require("./index-catalog");

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_CACHE_TTL_MS = 10000;
const INDEX_KEY_PATTERN = /^(?:sh|sz|bj|us)[A-Za-z0-9]+$/;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function normalizeIndexKey(value) {
  const key = String(value || "").trim();
  if (!INDEX_KEY_PATTERN.test(key) || !findIndexDefinition(key)) {
    throw Object.assign(new Error("指数选项无效。"), {
      statusCode: 400,
      code: "INDEX_KEY_INVALID",
    });
  }
  return findIndexDefinition(key).key;
}

function regularMarketMinute(time) {
  const match = String(time || "").match(/^(\d{2}):(\d{2})/);
  if (!match) return null;
  const total = Number(match[1]) * 60 + Number(match[2]);
  if (total < 570 || total > 900 || (total > 690 && total < 780)) return null;
  return total <= 690 ? total - 570 : 120 + total - 780;
}

function indexMinute(time, definition) {
  if (definition.session !== "us") return regularMarketMinute(time);
  const match = String(time || "").match(/^(\d{2}):(\d{2})/);
  if (!match) return null;
  const elapsed = Number(match[1]) * 60 + Number(match[2]) - 570;
  if (elapsed < 0 || elapsed > 390) return null;
  return round((elapsed / 390) * 240, 4);
}

function parseTencentIndexPayload(payload, definition) {
  const block = payload?.data?.[definition.symbol]?.data || {};
  const rows = Array.isArray(block.data) ? block.data : [];
  const quote = payload?.data?.[definition.symbol]?.qt?.[definition.symbol] || [];
  const rawDate = String(block.date || "");
  const quoteDate = String(quote[30] || "");
  const tradeDate = /^\d{8}$/.test(rawDate)
    ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
    : quoteDate.slice(0, 10);
  const preClose = finite(quote[4]) ?? finite(String(rows[0] || "").trim().split(/\s+/)[1]);
  if (!rows.length || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || preClose === null || preClose <= 0) {
    throw Object.assign(new Error(`${definition.name}分时没有返回有效数据。`), {
      statusCode: 502,
      code: "INDEX_INTRADAY_EMPTY",
    });
  }
  const byMinute = new Map();
  for (const row of rows) {
    const fields = String(row || "").trim().split(/\s+/);
    const compactTime = String(fields[0] || "");
    if (!/^\d{4}$/.test(compactTime)) continue;
    const time = `${compactTime.slice(0, 2)}:${compactTime.slice(2, 4)}`;
    const minute = indexMinute(time, definition);
    const price = finite(fields[1]);
    if (minute === null || price === null || price <= 0) continue;
    byMinute.set(minute, {
      dateTime: `${tradeDate} ${time}`,
      tradeDate,
      time: `${time}:00`,
      minute,
      price: round(price, 4),
      volume: finite(fields[2]) ?? 0,
      amount: finite(fields[3]),
      source: "tencent-index-minute",
    });
  }
  const points = [...byMinute.values()].sort((left, right) => left.minute - right.minute);
  if (!points.length) {
    throw Object.assign(new Error(`${definition.name}分时没有交易时段样本。`), {
      statusCode: 502,
      code: "INDEX_INTRADAY_SESSION_EMPTY",
    });
  }
  return {
    key: definition.key,
    name: definition.name,
    code: definition.code,
    group: definition.group,
    session: definition.session || "cn",
    preClose: round(preClose, 4),
    tradeDate,
    points,
    latestMinute: points.at(-1).minute,
    latestPrice: points.at(-1).price,
  };
}

function fetchCurlText(url, timeoutMs) {
  const timeoutSeconds = Math.max(6, Math.ceil(timeoutMs / 1000));
  return new Promise((resolve, reject) => {
    execFile("curl.exe", [
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
      "Referer: https://gu.qq.com/",
      "-H",
      "User-Agent: Mozilla/5.0",
      url,
    ], {
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

async function fetchTextWithFetch(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      cache: "no-store",
      headers: {
        Accept: "application/json,text/plain,*/*",
        "Cache-Control": "no-cache",
        Referer: "https://gu.qq.com/",
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

function readCachedIndex(marketDataPath, definition, tradeDate = "") {
  try {
    const payload = JSON.parse(fs.readFileSync(marketDataPath, "utf8"));
    const indices = [payload?.index, ...(payload?.indices || [])].filter(Boolean);
    const cached = indices.find((item) => item.key === definition.key || item.code === definition.code);
    if (!cached || !Array.isArray(cached.points) || !cached.points.length) return null;
    if (tradeDate && cached.tradeDate !== tradeDate && definition.session !== "us") return null;
    return {
      ...cached,
      key: definition.key,
      name: definition.name,
      code: definition.code,
      group: definition.group,
      session: definition.session || "cn",
    };
  } catch (_) {
    return null;
  }
}

function createIndexIntradayService(options = {}) {
  const fetchImpl = options.fetchImpl || null;
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const cacheTtlMs = Math.max(1000, Number(options.cacheTtlMs) || DEFAULT_CACHE_TTL_MS);
  const marketDataPath = String(options.marketDataPath || "");
  const cache = new Map();

  async function getTimeline(rawKey, requestedTradeDate = "") {
    const key = normalizeIndexKey(rawKey);
    const definition = findIndexDefinition(key);
    const cached = cache.get(key);
    const nowMs = now().getTime();
    if (cached && nowMs - cached.cachedAtMs < cacheTtlMs) {
      return {...cached.payload, cached: true, cacheAgeMs: Math.max(0, nowMs - cached.cachedAtMs)};
    }
    const endpoint = definition.session === "us" ? "usMinute" : "minute";
    const url = `https://web.ifzq.gtimg.cn/appstock/app/${endpoint}/query?code=${encodeURIComponent(definition.symbol)}&_=${nowMs}`;
    try {
      const text = fetchImpl
        ? await fetchTextWithFetch(fetchImpl, url, timeoutMs)
        : await fetchCurlText(url, timeoutMs);
      const timeline = parseTencentIndexPayload(JSON.parse(text), definition);
      const dateMismatch = Boolean(
        requestedTradeDate
        && timeline.tradeDate !== requestedTradeDate
        && definition.session !== "us"
      );
      const result = {
        ok: true,
        ...timeline,
        source: "腾讯指数真实分时",
        methodology: "按所选指数读取真实分钟分时，并由同一轮逐秒指数报价追加当前真实点；不生成模拟轨迹。",
        fetchedAt: now().toISOString(),
        cached: false,
        cacheAgeMs: 0,
        dateMismatch,
        warning: dateMismatch
          ? `指数行情源最新交易日为${timeline.tradeDate}，主面板基础数据为${requestedTradeDate}；已优先展示最新真实分时。`
          : "",
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
      const local = marketDataPath ? readCachedIndex(marketDataPath, definition, requestedTradeDate) : null;
      if (local) {
        return {
          ok: true,
          ...local,
          source: local.source || "本机同日指数缓存",
          cached: true,
          stale: true,
          warning: error.message || String(error),
          fetchedAt: now().toISOString(),
        };
      }
      throw Object.assign(new Error(`${definition.name}分时读取失败：${error.message || error}`), {
        statusCode: error.statusCode || 502,
        code: error.code || "INDEX_INTRADAY_UNAVAILABLE",
      });
    }
  }

  return {
    getCatalog: () => ({
      ok: true,
      maxSelected: 8,
      defaultSelected: [...DEFAULT_INDEX_KEYS],
      items: publicIndexCatalog(),
    }),
    getTimeline,
    getState: () => ({
      catalogSize: INDEX_CATALOG.length,
      cacheEntries: cache.size,
      cacheTtlMs,
      source: "腾讯指数真实分时",
    }),
  };
}

module.exports = {
  createIndexIntradayService,
  indexMinute,
  normalizeIndexKey,
  parseTencentIndexPayload,
  regularMarketMinute,
};
