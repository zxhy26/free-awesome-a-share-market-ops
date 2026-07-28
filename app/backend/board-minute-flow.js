"use strict";

const dns = require("dns").promises;
const {execFile} = require("child_process");
const fs = require("fs");
const path = require("path");

const BOARD_CODE_PATTERN = /^BK\d{4}$/;
const DEFAULT_CACHE_TTL_MS = 12000;
const DEFAULT_TIMEOUT_MS = 12000;
const SOURCE_NAME = "东方财富板块分钟资金";
const EASTMONEY_HOST = "push2.eastmoney.com";
const EASTMONEY_FALLBACK_IPS = Object.freeze(["120.79.191.232"]);

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

function marketMinuteFromTime(value) {
  const match = String(value || "").match(/(\d{2}):(\d{2})(?::(\d{2}))?$/);
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

function parseBoardFlowPayload(payload, options = {}) {
  const rows = Array.isArray(payload?.data?.klines) ? payload.data.klines : [];
  const parsed = [];
  for (const raw of rows) {
    const fields = String(raw || "").split(",");
    const dateTime = String(fields[0] || "").trim();
    const dateMatch = dateTime.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)/);
    const amountYuan = finite(fields[1]);
    if (!dateMatch || amountYuan === null) continue;
    const minute = marketMinuteFromTime(dateMatch[2]);
    if (minute === null) continue;
    parsed.push({
      tradeDate: dateMatch[1],
      minute,
      time: dateMatch[2].length === 5 ? `${dateMatch[2]}:00` : dateMatch[2],
      amount: round(amountYuan / 100000000, 4),
      amountYuan: Math.round(amountYuan),
      source: "eastmoney-board-minute-flow",
    });
  }
  if (!parsed.length) {
    throw Object.assign(new Error("板块分钟资金接口没有返回有效交易时段数据。"), {
      statusCode: 502,
      code: "BOARD_FLOW_EMPTY",
    });
  }
  const tradeDate = String(options.tradeDate || parsed.map((point) => point.tradeDate).sort().at(-1));
  const byMinute = new Map();
  parsed
    .filter((point) => point.tradeDate === tradeDate)
    .sort((left, right) => left.minute - right.minute || left.time.localeCompare(right.time))
    .forEach((point) => byMinute.set(point.minute, point));
  const points = [...byMinute.values()].sort((left, right) => left.minute - right.minute);
  if (!points.length) {
    throw Object.assign(new Error(`${tradeDate}没有有效的板块分钟资金数据。`), {
      statusCode: 502,
      code: "BOARD_FLOW_DATE_EMPTY",
    });
  }
  return {
    tradeDate,
    name: String(payload?.data?.name || options.name || options.code || "板块").trim(),
    points,
    latestMinute: points.at(-1).minute,
    latestAmount: points.at(-1).amount,
  };
}

function localTimelineFromCache(cache, code, name = "") {
  if (!cache || typeof cache !== "object") return null;
  const tradeDate = String(cache.tradeDate || "");
  let entry = null;
  let group = "";
  for (const groupName of ["industry", "concept"]) {
    const candidate = cache.groups?.[groupName]?.[code];
    if (candidate) {
      entry = candidate;
      group = groupName;
      break;
    }
  }
  if (!entry || !Array.isArray(entry.points)) return null;
  const byMinute = new Map();
  for (const raw of entry.points) {
    const minute = finite(raw?.minute);
    const amount = finite(raw?.amount);
    if (minute === null || amount === null || minute < 0 || minute > 240) continue;
    byMinute.set(minute, {
      tradeDate,
      minute,
      time: String(raw.time || ""),
      amount: round(amount, 4),
      amountYuan: Math.round(amount * 100000000),
      source: String(raw.source || "local-live-board-cache"),
      sampledAt: String(raw.syncedAt || ""),
    });
  }
  const points = [...byMinute.values()].sort((left, right) => left.minute - right.minute);
  if (!points.length) return null;
  return {
    code,
    name: String(entry.name || name || code),
    group,
    tradeDate,
    points,
    latestMinute: points.at(-1).minute,
    latestAmount: points.at(-1).amount,
  };
}

async function fetchTextWithFetch(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json,text/plain,*/*",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Referer: "https://data.eastmoney.com/",
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
  const timeoutSeconds = Math.max(6, Math.ceil((Number(timeoutMs) || DEFAULT_TIMEOUT_MS) / 1000));
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
    "Referer: https://data.eastmoney.com/",
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
  let resolvedIps = [];
  try {
    resolvedIps = await dns.resolve4(EASTMONEY_HOST);
  } catch (_) {
    resolvedIps = [];
  }
  const candidates = [...new Set([...EASTMONEY_FALLBACK_IPS, ...resolvedIps].filter(Boolean))];
  for (const ip of candidates) {
    try {
      const text = await fetchCurlText(url, timeoutMs, ip);
      const payload = parseJsonOrJsonp(text);
      if (Number(payload?.rc) !== 0 || !payload?.data) throw new Error(`接口状态异常：${payload?.rc}`);
      return text;
    } catch (error) {
      errors.push(`${ip}: ${error.message}`);
    }
  }
  try {
    const text = await fetchCurlText(url, timeoutMs);
    const payload = parseJsonOrJsonp(text);
    if (Number(payload?.rc) !== 0 || !payload?.data) throw new Error(`接口状态异常：${payload?.rc}`);
    return text;
  } catch (error) {
    errors.push(`系统解析: ${error.message}`);
  }
  throw new Error(`东方财富板块分钟资金接口不可用：${errors.at(-1) || "未知错误"}`);
}

function createBoardMinuteFlowService(options = {}) {
  const fetchImpl = options.fetchImpl || null;
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const cacheTtlMs = Math.max(1000, Number(options.cacheTtlMs) || DEFAULT_CACHE_TTL_MS);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const cachePaths = [...new Set((options.cachePaths || []).map((value) => path.resolve(String(value))).filter(Boolean))];
  const cache = new Map();
  const fileCache = new Map();

  function readLocalTimeline(code, name) {
    let best = null;
    for (const filePath of cachePaths) {
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        let file = fileCache.get(filePath);
        if (!file || file.mtimeMs !== stat.mtimeMs || file.size !== stat.size) {
          file = {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            data: JSON.parse(fs.readFileSync(filePath, "utf8")),
          };
          fileCache.set(filePath, file);
        }
        const timeline = localTimelineFromCache(file.data, code, name);
        if (!timeline) continue;
        const score = `${timeline.tradeDate}|${String(timeline.latestMinute).padStart(3, "0")}|${String(file.mtimeMs).padStart(20, "0")}`;
        if (!best || score > best.score) best = {score, timeline, file};
      } catch (_) {
        // Try the next validated local cache before using the online fallback.
      }
    }
    return best;
  }

  async function getTimeline(rawCode, name = "") {
    const code = normalizeBoardCode(rawCode);
    const nowMs = now().getTime();
    const cached = cache.get(code);
    if (cached && nowMs - cached.cachedAtMs < cacheTtlMs) {
      return {...cached.payload, cacheAgeMs: Math.max(0, nowMs - cached.cachedAtMs), cached: true};
    }
    const local = readLocalTimeline(code, name);
    if (local) {
      const result = {
        ok: true,
        code,
        name: local.timeline.name,
        group: local.timeline.group,
        tradeDate: local.timeline.tradeDate,
        points: local.timeline.points,
        latestMinute: local.timeline.latestMinute,
        latestAmount: local.timeline.latestAmount,
        source: "本机全量板块资金实时缓存",
        methodology: "读取后台按盘面持续采集的行业与题材概念分钟资金原始样本；不插值、不生成模拟点。外部分钟端点仅在本机缓存缺失时补充。",
        fetchedAt: new Date(local.file.mtimeMs).toISOString(),
        cached: false,
        cacheAgeMs: 0,
      };
      cache.set(code, {cachedAtMs: nowMs, payload: result});
      return result;
    }
    const params = new URLSearchParams({
      lmt: "0",
      klt: "1",
      fields1: "f1,f2,f3,f7",
      fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
      secid: `90.${code}`,
      ut: "b2884a393a59ad64002292a3e90d46a5",
    });
    const url = `https://${EASTMONEY_HOST}/api/qt/stock/fflow/kline/get?${params}`;
    try {
      const text = fetchImpl
        ? await fetchTextWithFetch(fetchImpl, url, timeoutMs)
        : await fetchEastmoneyText(url, timeoutMs);
      const payload = parseJsonOrJsonp(text);
      const timeline = parseBoardFlowPayload(payload, {code, name});
      const fetchedAt = now().toISOString();
      const result = {
        ok: true,
        code,
        name: timeline.name,
        tradeDate: timeline.tradeDate,
        points: timeline.points,
        latestMinute: timeline.latestMinute,
        latestAmount: timeline.latestAmount,
        source: SOURCE_NAME,
        methodology: "直接读取所选行业或题材概念板块的官方分钟主力净流入，不插值、不生成模拟点。",
        fetchedAt,
        cached: false,
        cacheAgeMs: 0,
      };
      cache.set(code, {cachedAtMs: nowMs, payload: result});
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
      throw Object.assign(new Error(`板块分钟资金读取失败：${error.message || error}`), {
        statusCode: error.statusCode || 502,
        code: error.code || "BOARD_FLOW_UNAVAILABLE",
      });
    }
  }

  return {
    getTimeline,
    getState: () => ({cacheEntries: cache.size, cacheTtlMs, cachePaths: cachePaths.length, source: SOURCE_NAME}),
  };
}

module.exports = {
  BOARD_CODE_PATTERN,
  DEFAULT_CACHE_TTL_MS,
  SOURCE_NAME,
  createBoardMinuteFlowService,
  marketMinuteFromTime,
  normalizeBoardCode,
  localTimelineFromCache,
  parseBoardFlowPayload,
};
