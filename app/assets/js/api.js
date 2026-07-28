const runtimeLocation = globalThis.location || {protocol: "http:", origin: "http://127.0.0.1:18765"};
const SERVICE_ORIGIN = runtimeLocation.protocol === "http:" || runtimeLocation.protocol === "https:"
  ? runtimeLocation.origin
  : "http://127.0.0.1:18765";

const DATA_URLS = {
  market: new URL("../../data/market.json", import.meta.url),
  indices: new URL("../../data/indices.json", import.meta.url),
  sectors: new URL("../../data/sectors.json", import.meta.url),
  stocks: new URL("../../data/stocks.json", import.meta.url),
  analysis: new URL("../../data/analysis.json", import.meta.url),
  derivatives: new URL("../../data/derivatives.json", import.meta.url),
  indexContribution: new URL("../../data/index-contribution.json", import.meta.url),
  config: new URL("../../data/config.json", import.meta.url),
  policyNews: new URL("../../data/policy-news.json", import.meta.url),
  nextWeekEvents: new URL("../../data/next-week-events.json", import.meta.url),
  quant: new URL("../../data/quant.json", import.meta.url),
  health: new URL("../../data/health.json", import.meta.url),
  historyIndex: new URL("../../data/history-index.json", import.meta.url),
};

const API_MODULE_NAMES = {
  market: "market",
  indices: "indices",
  sectors: "sectors",
  stocks: "stocks",
  analysis: "analysis",
  derivatives: "derivatives",
  indexContribution: "index-contribution",
  config: "config",
  policyNews: "policy-news",
  nextWeekEvents: "next-week-events",
  quant: "quant",
  health: "health",
  historyIndex: "history-index",
};

const DATA_SNAPSHOT_PREFIX = "a-share-review:data:";
const CORE_DATA_SNAPSHOT_KEY = "a-share-review:core-snapshot:v2";

function dataSnapshotKey(url) {
  try {
    const parsed = new URL(String(url), SERVICE_ORIGIN);
    if (!/\/data\/[^/]+\.json$/i.test(parsed.pathname)) return "";
    return `${DATA_SNAPSHOT_PREFIX}${parsed.pathname}`;
  } catch (_) {
    return "";
  }
}

function readDataSnapshot(url) {
  const key = dataSnapshotKey(url);
  if (!key) return null;
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    return snapshot?.data ?? null;
  } catch (_) {
    return null;
  }
}

function writeDataSnapshot(url, data) {
  const key = dataSnapshotKey(url);
  if (!key) return;
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify({savedAt: new Date().toISOString(), data}));
  } catch (_) {
    // The service worker remains the fallback when storage is unavailable or full.
  }
}

export class AppError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AppError";
    this.code = options.code || "APP_ERROR";
    this.technical = options.technical || "";
    this.status = options.status || 0;
  }
}

function friendlyFetchError(error, label) {
  if (error?.name === "AbortError") return new AppError(`${label}读取超时，请稍后重试。`, {code: "TIMEOUT", technical: error.message});
  if (error instanceof AppError) return error;
  return new AppError(`${label}暂时无法读取，请确认复盘服务已经启动。`, {code: "NETWORK", technical: error?.message || String(error)});
}

export async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 5000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      cache: options.cache || "no-store",
      headers: {Accept: "application/json", ...(options.headers || {})},
      body: options.body,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new AppError(`${options.label || "数据"}读取失败（${response.status}）。`, {
        code: "HTTP_ERROR",
        status: response.status,
        technical: `${response.status} ${response.statusText}`,
      });
    }
    try {
      const data = await response.json();
      if (options.allowSnapshot !== false) writeDataSnapshot(url, data);
      return data;
    } catch (error) {
      throw new AppError(`${options.label || "数据"}格式异常，请重新同步。`, {code: "INVALID_JSON", technical: error.message});
    }
  } catch (error) {
    const snapshot = options.allowSnapshot === false ? null : readDataSnapshot(url);
    if (snapshot !== null) {
      console.info(`[离线快照] ${options.label || "数据"}使用最近一次成功数据。`);
      return snapshot;
    }
    throw friendlyFetchError(error, options.label || "数据");
  } finally {
    clearTimeout(timer);
  }
}

async function loadDataModule(key, label, timeoutMs = 5000) {
  const moduleName = API_MODULE_NAMES[key];
  if (moduleName) {
    try {
      return await fetchJson(`${SERVICE_ORIGIN}/api/v1/data/${moduleName}`, {label, timeoutMs});
    } catch (error) {
      console.info(`[静态数据回退] ${label}：${error.message}`);
    }
  }
  return fetchJson(DATA_URLS[key], {label, timeoutMs});
}

export async function loadCoreData() {
  let lastReason = "数据文件尚未形成同一快照";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const coreKeys = ["market", "indices", "sectors", "analysis", "config", "indexContribution"];
    const entries = await Promise.all(coreKeys.map(async (key) => [key, await loadDataModule(key, `${key} 数据`)]));
    const data = Object.fromEntries(entries);
    const consistency = coreDataConsistency(data);
    if (consistency.ok) {
      try {
        globalThis.localStorage?.setItem(CORE_DATA_SNAPSHOT_KEY, JSON.stringify({savedAt: new Date().toISOString(), data}));
      } catch (_) {
        // A validated network snapshot is still returned when local storage is unavailable.
      }
      return data;
    }
    lastReason = consistency.reason;
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 180 * (attempt + 1)));
  }
  try {
    const stored = globalThis.localStorage?.getItem(CORE_DATA_SNAPSHOT_KEY);
    const snapshot = stored ? JSON.parse(stored)?.data : null;
    if (snapshot && coreDataConsistency(snapshot).ok) {
      console.info(`[完整快照] 发布切换期间沿用上一份已验证数据：${lastReason}`);
      return snapshot;
    }
  } catch (_) {
    // Fall through to a clear user-facing error when no complete snapshot exists.
  }
  throw new AppError(`市场数据正在完成同一时点切换，请稍后重试。${lastReason}`, {
    code: "INCONSISTENT_SNAPSHOT",
    technical: lastReason,
  });
}

function latestAshareMinute(items) {
  const index = (items || []).find((item) => item?.name === "上证指数") || (items || []).find((item) => item?.session !== "us");
  const minutes = (index?.points || []).map((point) => Number(point?.minute)).filter(Number.isFinite);
  return minutes.length ? Math.max(...minutes) : null;
}

function coreDataConsistency(data) {
  const dates = [
    data?.market?.tradeDate || data?.market?.market?.tradeDate,
    data?.indices?.tradeDate,
    data?.sectors?.tradeDate,
    data?.analysis?.tradeDate,
  ].filter(Boolean);
  if (dates.length < 4 || new Set(dates).size !== 1) {
    return {ok: false, reason: `交易日不一致：${dates.join(" / ") || "空"}`};
  }
  const syncedAt = [
    data?.market?.syncedAt,
    data?.indices?.syncedAt,
    data?.sectors?.syncedAt,
    data?.analysis?.syncedAt,
  ].filter(Boolean);
  if (syncedAt.length < 4 || new Set(syncedAt).size !== 1) {
    return {ok: false, reason: `同步批次不一致：${syncedAt.join(" / ") || "空"}`};
  }
  const indexMinute = latestAshareMinute(data?.indices?.items);
  const industryMinute = Number(data?.sectors?.industry?.flowSampleMinute);
  const conceptMinute = Number(data?.sectors?.concept?.flowSampleMinute);
  if (!Number.isFinite(indexMinute) || !Number.isFinite(industryMinute) || !Number.isFinite(conceptMinute)
    || indexMinute !== industryMinute || indexMinute !== conceptMinute) {
    return {ok: false, reason: `分时时点不一致：指数 ${indexMinute ?? "空"} / 行业 ${industryMinute || 0} / 概念 ${conceptMinute || 0}`};
  }
  return {ok: true, reason: ""};
}

export function loadStockData() {
  return loadDataModule("stocks", "个股详情");
}

export function loadQuantData() {
  return loadDataModule("quant", "量化选股", 15000);
}

export function loadDerivativesData() {
  return loadDataModule("derivatives", "机构衍生品", 15000);
}

export function refreshIndexContribution() {
  return fetchJson(`${SERVICE_ORIGIN}/api/v1/index-contribution/refresh`, {
    label: "指数贡献公开行情",
    timeoutMs: 10000,
    method: "POST",
    allowSnapshot: false,
  });
}

export function loadPolicyNewsData() {
  return loadDataModule("policyNews", "政策新闻", 10000);
}

export function loadNextWeekEventsData() {
  return loadDataModule("nextWeekEvents", "下周大事件", 15000);
}

export function loadDataHealth() {
  return fetchJson(`${SERVICE_ORIGIN}/api/v1/health`, {label: "数据健康", timeoutMs: 5000})
    .catch(() => loadDataModule("health", "数据健康"));
}

export function loadHistoryDates() {
  return fetchJson(`${SERVICE_ORIGIN}/api/v1/history/dates`, {label: "历史交易日", timeoutMs: 5000})
    .catch(() => loadDataModule("historyIndex", "历史交易日"));
}

export function loadHistoryDate(date) {
  return fetchJson(`${SERVICE_ORIGIN}/api/v1/history/${encodeURIComponent(date)}`, {label: `${date} 复盘归档`, timeoutMs: 10000});
}

export async function getHealth() {
  return fetchJson(`${SERVICE_ORIGIN}/health`, {label: "本地同步服务", timeoutMs: 5000});
}

export async function loadLiveSectorFlows() {
  return fetchJson(`${SERVICE_ORIGIN}/api/v1/live/sector-flows`, {
    label: "逐秒板块资金",
    timeoutMs: 12000,
    allowSnapshot: false,
  });
}

export async function requestLiveSectorFlowRefresh() {
  return fetchJson(`${SERVICE_ORIGIN}/api/v1/live/sector-flows/refresh`, {
    label: "逐秒板块资金手动刷新",
    timeoutMs: 15000,
    method: "POST",
    allowSnapshot: false,
  });
}

export async function getSyncStatus() {
  return fetchJson(`${SERVICE_ORIGIN}/status`, {label: "同步状态", timeoutMs: 5000});
}

let syncPromise = null;

function syncErrorMessage(payload) {
  const messages = {
    TIMEOUT: "同步超时，后台任务已经停止。",
    FILE_WRITE_FAILED: "数据文件写入失败，可能正被其他程序占用。",
    DATA_SOURCE_ERROR: "行情数据接口暂时异常，现有数据没有被覆盖。",
    INCOMPLETE_DATA: "新数据完整性校验未通过，已保留上一份完整结果，后台会继续补采。",
    GENERATE_FAILED: "复盘结果生成失败，现有数据没有被覆盖。",
  };
  return messages[payload?.errorCode] || payload?.message || "同步失败，请稍后重试。";
}

async function pollSync(onProgress, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await getSyncStatus();
    onProgress?.(status.progress || {stage: "working", message: "正在同步", percent: 0});
    if (!status.running) {
      if (status.lastResult?.ok) return status.lastResult;
      if (status.lastResult) throw new AppError(syncErrorMessage(status.lastResult), {code: status.lastResult.errorCode || "SYNC_FAILED", technical: status.lastResult.stderr || status.lastResult.stdout || ""});
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  throw new AppError("同步等待超时，后台可能仍在处理，请稍后查看状态。", {code: "POLL_TIMEOUT"});
}

export function requestMarketSync(onProgress) {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    let response;
    try {
      try {
        response = await fetchJson(`${SERVICE_ORIGIN}/api/v1/sync`, {label: "同步请求", timeoutMs: 30000, method: "POST"});
      } catch (_) {
        response = await fetchJson(`${SERVICE_ORIGIN}/refresh?async=1`, {label: "同步请求", timeoutMs: 30000, method: "POST"});
      }
    } catch (error) {
      throw friendlyFetchError(error, "本地同步服务");
    }
    if (response.accepted === false && !response.running) {
      throw new AppError(syncErrorMessage(response), {code: response.errorCode || "SYNC_REJECTED"});
    }
    onProgress?.(response.progress || {stage: "starting", message: response.message || "正在同步", percent: 5});
    return pollSync(onProgress, 6 * 60 * 1000);
  })().finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}

export async function requestPolicyNewsRefresh() {
  let result = await fetchJson(`${SERVICE_ORIGIN}/policy-refresh`, {label: "政策新闻同步", timeoutMs: 120000, method: "POST"});
  if (result.running) {
    const deadline = Date.now() + 100000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const status = await getSyncStatus();
      if (!status.policyNews?.running) {
        result = status.policyNews?.lastResult || result;
        break;
      }
    }
  }
  if (!result.ok) throw new AppError(result.message || "政策新闻同步失败。", {code: "POLICY_NEWS_FAILED", technical: result.stderr || result.stdout || ""});
  return result;
}

export async function requestNextWeekEventsRefresh() {
  let result = await fetchJson(`${SERVICE_ORIGIN}/next-week-events-refresh`, {label: "下周大事件更新", timeoutMs: 120000, method: "POST"});
  if (result.running) {
    const deadline = Date.now() + 100000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const status = await getSyncStatus();
      if (!status.nextWeekEvents?.running) {
        result = status.nextWeekEvents?.lastResult || result;
        break;
      }
    }
  }
  if (!result.ok) {
    throw new AppError(result.message || "下周大事件更新失败。", {
      code: "NEXT_WEEK_EVENTS_FAILED",
      technical: result.stderr || result.stdout || "",
    });
  }
  return result;
}

export function requestDerivativesRefresh() {
  return fetchJson(`${SERVICE_ORIGIN}/derivatives-refresh`, {label: "机构衍生品刷新", timeoutMs: 150000, method: "POST"})
    .then((result) => {
      if (!result.ok) throw new AppError(result.message || "机构衍生品刷新失败。", {code: result.errorCode || "DERIVATIVES_REFRESH_FAILED", technical: result.stderr || result.stdout || ""});
      return result;
    });
}

export function requestQuantRefresh() {
  return fetchJson(`${SERVICE_ORIGIN}/quant-refresh`, {
    label: "量化选股更新",
    timeoutMs: 17 * 60 * 1000,
    method: "POST",
    allowSnapshot: false,
  }).then((result) => {
    if (!result.ok) {
      throw new AppError(result.message || "量化选股更新失败。", {
        code: result.errorCode || "QUANT_REFRESH_FAILED",
        technical: result.stderr || result.stdout || "",
      });
    }
    return result;
  });
}

export function exactQuoteUrl(stock = {}) {
  const code = String(stock.code || "").trim().toUpperCase();
  const boardCode = String(stock.boardCode || "").trim().toUpperCase();
  const market = String(stock.market ?? "").trim().toLowerCase();
  const name = String(stock.name || "").trim();
  const exactBoardCode = /^BK\d{4}$/.test(boardCode)
    ? boardCode
    : (/^BK\d{4}$/.test(code) ? code : "");
  if (market === "sector" || exactBoardCode || /^880\d{3}$/.test(code)) {
    if (exactBoardCode) return `https://quote.eastmoney.com/bk/90.${exactBoardCode}.html`;
    return `https://so.eastmoney.com/web/s?keyword=${encodeURIComponent(`${name || code} 板块 日K`)}`;
  }
  if (/^\d{6}$/.test(code)) {
    if (/^(4|8|92)/.test(code)) return `https://quote.eastmoney.com/bj/${code}.html`;
    if (/^(5|6|9)/.test(code)) return `https://quote.eastmoney.com/sh${code}.html`;
    return `https://quote.eastmoney.com/sz${code}.html`;
  }
  return `https://so.eastmoney.com/web/s?keyword=${encodeURIComponent(`${code || name} 股票 日K`)}`;
}

function usesPackagedStaticRuntime() {
  return runtimeLocation.protocol === "file:"
    || runtimeLocation.hostname === "appassets.androidplatform.net";
}

function openExactQuote(stock) {
  const url = exactQuoteUrl(stock);
  runtimeLocation.assign(url);
  return {
    ok: true,
    mode: "exactWebQuote",
    url,
    targetUrlExact: !url.includes("/web/s?"),
    message: `已打开${String(stock.name || stock.code || "目标")}的具体行情页。`,
  };
}
export async function openLocalStock(stock) {
  if (usesPackagedStaticRuntime()) return openExactQuote(stock);
  const params = new URLSearchParams({
    code: String(stock.code || ""),
    market: String(stock.market ?? ""),
    name: String(stock.name || ""),
  });
  const result = await fetchJson(`${SERVICE_ORIGIN}/stock-open?${params}`, {label: "本机股票软件日K", timeoutMs: 95000, method: "POST"});
  if (!result.ok) throw new AppError(result.message || "本机股票软件没有打开日K。", {code: "STOCK_APP_FAILED"});
  return result;
}

export const openTdxStock = openLocalStock;
export function logTechnicalError(error, context = "应用") {
  console.error(`[${context}]`, error?.technical || error?.stack || error);
}
