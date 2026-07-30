"use strict";

const {TextDecoder} = require("util");
const {INDEX_CATALOG} = require("./index-catalog");

const LIVE_INTERVAL_MS = 1000;
const ACTIVE_REFRESH_AGE_MS = 700;
const HOLIDAY_REFRESH_AGE_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_GROUP_TIMESTAMP_SKEW_MS = 2000;
const GROUP_DEFINITIONS = Object.freeze({
  industry: Object.freeze({
    key: "industry",
    title: "二级行业板块",
    fsCode: "m:90+s:4",
    minimumRows: 100,
  }),
  concept: Object.freeze({
    key: "concept",
    title: "概念板块",
    fsCode: "m:90+t:3",
    minimumRows: 400,
  }),
});
const INDEX_DEFINITIONS = Object.freeze(
  INDEX_CATALOG
    .filter((item) => item.session !== "us")
    .map(({key, code, symbol, name}) => Object.freeze({key, code, symbol, name})),
);
const SHANGHAI_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function shanghaiParts(date = new Date()) {
  const values = {};
  for (const part of SHANGHAI_FORMATTER.formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const day = new Date(Date.UTC(values.year, values.month - 1, values.day)).getUTCDay();
  return {
    year: values.year,
    month: values.month,
    dayOfMonth: values.day,
    day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function dateText(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.dayOfMonth)}`;
}

function timeText(parts) {
  return `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
}

function marketMinuteFromParts(parts) {
  const secondOfDay = parts.hour * 3600 + parts.minute * 60 + parts.second;
  const morningStart = 9 * 3600 + 30 * 60;
  const morningEnd = 11 * 3600 + 30 * 60;
  const afternoonStart = 13 * 3600;
  const afternoonEnd = 15 * 3600;
  if (secondOfDay <= morningStart) return 0;
  if (secondOfDay <= morningEnd) return (secondOfDay - morningStart) / 60;
  if (secondOfDay < afternoonStart) return 120;
  if (secondOfDay <= afternoonEnd) return 120 + (secondOfDay - afternoonStart) / 60;
  return 240;
}

function marketPhaseAt(date = new Date()) {
  const parts = shanghaiParts(date);
  const tradeDate = dateText(parts);
  if (parts.day === 0 || parts.day === 6) {
    return {
      active: false,
      auction: false,
      regularSession: false,
      phase: "周末休市",
      tradeDate,
      marketMinute: marketMinuteFromParts(parts),
    };
  }
  const secondOfDay = parts.hour * 3600 + parts.minute * 60 + parts.second;
  const auctionStart = 9 * 3600 + 15 * 60;
  const morningStart = 9 * 3600 + 30 * 60;
  const morningEnd = 11 * 3600 + 30 * 60;
  const afternoonStart = 13 * 3600;
  const afternoonEnd = 15 * 3600;
  if (secondOfDay < auctionStart) {
    return {active: false, auction: false, regularSession: false, phase: "盘前", tradeDate, marketMinute: 0};
  }
  if (secondOfDay < morningStart) {
    return {active: true, auction: true, regularSession: false, phase: "集合竞价", tradeDate, marketMinute: 0};
  }
  if (secondOfDay <= morningEnd) {
    return {
      active: true,
      auction: false,
      regularSession: true,
      phase: "交易中",
      tradeDate,
      marketMinute: marketMinuteFromParts(parts),
    };
  }
  if (secondOfDay < afternoonStart) {
    return {active: false, auction: false, regularSession: false, phase: "午间休市", tradeDate, marketMinute: 120};
  }
  if (secondOfDay <= afternoonEnd) {
    return {
      active: true,
      auction: false,
      regularSession: true,
      phase: "交易中",
      tradeDate,
      marketMinute: marketMinuteFromParts(parts),
    };
  }
  return {active: false, auction: false, regularSession: false, phase: "已收盘", tradeDate, marketMinute: 240};
}

function clampQuoteTimestampToTradingSession(timestamp) {
  const value = finite(timestamp);
  if (value === null) return null;
  const parts = shanghaiParts(new Date(value * 1000));
  const secondOfDay = parts.hour * 3600 + parts.minute * 60 + parts.second;
  const morningStart = 9 * 3600 + 30 * 60;
  const morningEnd = 11 * 3600 + 30 * 60;
  const afternoonStart = 13 * 3600;
  const afternoonEnd = 15 * 3600;
  let targetSecond = secondOfDay;
  if (secondOfDay > morningEnd && secondOfDay < afternoonStart) targetSecond = morningEnd;
  if (secondOfDay > afternoonEnd) targetSecond = afternoonEnd;
  if (secondOfDay < morningStart) return Math.floor(value);
  const hour = Math.floor(targetSecond / 3600);
  const minute = Math.floor((targetSecond % 3600) / 60);
  const second = targetSecond % 60;
  return Math.floor(Date.parse(
    `${dateText(parts)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}+08:00`,
  ) / 1000);
}

function timestampFromCompactText(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 12) return null;
  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  const hour = digits.slice(8, 10);
  const minute = digits.slice(10, 12);
  const second = digits.length >= 14 ? digits.slice(12, 14) : "00";
  const timestamp = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

async function fetchResponse(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || 2500);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: options.accept || "application/json,text/plain,*/*",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Referer: options.referer || "https://data.eastmoney.com/",
        "User-Agent": "Mozilla/5.0",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchResponse(fetchImpl, url, options);
  const text = (await response.text()).trim();
  const source = /^[\w$]+\(/.test(text)
    ? text.replace(/^[\w$]+\(/, "").replace(/\);?$/, "")
    : text;
  return JSON.parse(source);
}

function normalizeBoardRows(diff, definition, options = {}) {
  if (!Array.isArray(diff)) throw new Error(`${definition.title}接口没有返回数组`);
  const fallbackTimestamp = finite(options.sourceTimestamp);
  const changePctScale = Math.max(1, finite(options.changePctScale) || 1);
  const unique = new Map();
  for (const raw of diff) {
    const code = String(raw?.f12 || "").trim().toUpperCase();
    const name = String(raw?.f14 || code).trim();
    const amountYuan = finite(raw?.f62);
    const timestamp = finite(raw?.f124);
    if (!/^BK\d{4}$/.test(code) || !name || amountYuan === null) continue;
    unique.set(code, {
      code,
      name,
      amount: round(amountYuan / 100000000, 4),
      amountYuan: Math.round(amountYuan),
      changePct: finite(raw?.f3) === null ? null : round(finite(raw.f3) / changePctScale, 4),
      sourceTimestamp: timestamp && timestamp > 1000000000
        ? Math.floor(timestamp)
        : fallbackTimestamp && fallbackTimestamp > 1000000000
          ? Math.floor(fallbackTimestamp)
          : null,
    });
  }
  const rows = [...unique.values()];
  if (rows.length < definition.minimumRows) {
    throw new Error(`${definition.title}仅返回 ${rows.length} 行，低于完整性阈值 ${definition.minimumRows}`);
  }
  const timestamps = rows.map((row) => row.sourceTimestamp).filter(Number.isFinite);
  return {
    key: definition.key,
    title: definition.title,
    rows,
    sourceTimestamp: timestamps.length ? Math.max(...timestamps) : null,
  };
}

function hasAcceptableBoardCoverage(rowCount, reportedRows, minimumRows) {
  const rows = Math.max(0, Number(rowCount) || 0);
  const minimum = Math.max(0, Number(minimumRows) || 0);
  const reported = finite(reportedRows);
  if (rows < minimum) return false;
  if (reported === null || reported <= 0) return true;
  return rows >= Math.max(minimum, Math.ceil(reported * 0.98));
}

async function defaultFetchBoardGroup(definition, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const cacheBust = Number(options.nowMs) || Date.now();
  const primaryUrl = "https://data.eastmoney.com/dataapi/bkzj/getbkzj"
    + `?key=${encodeURIComponent("f62,f3")}&code=${encodeURIComponent(definition.fsCode)}&_=${cacheBust}`;
  const fallbackUrl = "https://push2.eastmoney.com/api/qt/clist/get"
    + "?pn=1&pz=1000&po=1&np=1&fltt=2&invt=2&fid=f62"
    + `&fs=${encodeURIComponent(definition.fsCode)}`
    + `&fields=f12,f14,f3,f62,f124&_=${cacheBust}`;
  const errors = [];
  for (const [url, route, changePctScale] of [
    [primaryUrl, "eastmoney-bkzj", 100],
    [fallbackUrl, "eastmoney-push2", 1],
  ]) {
    try {
      const json = await fetchJson(fetchImpl, url, {timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS});
      const normalized = normalizeBoardRows(json?.data?.diff, definition, {changePctScale});
      const total = finite(json?.data?.total);
      if (!hasAcceptableBoardCoverage(normalized.rows.length, total, definition.minimumRows)) {
        throw new Error(`${definition.title}只返回 ${normalized.rows.length}/${total} 行，低于98%完整性阈值`);
      }
      return {
        ...normalized,
        route,
        reportedRows: total,
        coveragePct: total && total > 0 ? round((normalized.rows.length / total) * 100, 2) : 100,
        capturedAtMs: Date.now(),
      };
    } catch (error) {
      errors.push(`${route}: ${error.message}`);
    }
  }
  throw new Error(`${definition.title}实时资金接口失败：${errors.join("；")}`);
}

function parseTencentIndexQuotes(text) {
  const definitions = new Map(INDEX_DEFINITIONS.map((item) => [item.symbol.toLowerCase(), item]));
  const rows = [];
  for (const line of String(text || "").split(/;\s*/)) {
    const match = line.match(/^v_([^=]+)="([^"]*)"/i);
    if (!match) continue;
    const symbol = match[1].toLowerCase();
    const definition = definitions.get(symbol);
    if (!definition) continue;
    const fields = match[2].split("~");
    const price = finite(fields[3]);
    const preClose = finite(fields[4]);
    const sourceTimestamp = timestampFromCompactText(fields[30]);
    if (price === null || preClose === null || price <= 0 || preClose <= 0 || sourceTimestamp === null) continue;
    const amountWan = finite(fields[37]);
    rows.push({
      key: definition.key,
      code: definition.code,
      name: String(fields[1] || definition.name).trim() || definition.name,
      price,
      preClose,
      change: finite(fields[31]) ?? round(price - preClose, 4),
      changePct: finite(fields[32]) ?? round(((price - preClose) / preClose) * 100, 4),
      amount: amountWan === null ? null : Math.round(amountWan * 10000),
      sourceTimestamp,
      minute: marketMinuteFromParts(shanghaiParts(new Date(sourceTimestamp * 1000))),
      source: "腾讯指数实时行情",
    });
  }
  return rows;
}

async function defaultFetchIndexQuotes(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const symbols = INDEX_DEFINITIONS.map((item) => item.symbol).join(",");
  const url = `https://qt.gtimg.cn/q=${encodeURIComponent(symbols)}&_=${Number(options.nowMs) || Date.now()}`;
  const response = await fetchResponse(fetchImpl, url, {
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    accept: "text/plain,*/*",
    referer: "https://gu.qq.com/",
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = new TextDecoder("gb18030").decode(bytes);
  const rows = parseTencentIndexQuotes(text);
  if (rows.length < 3) throw new Error(`腾讯主要指数实时行情仅返回 ${rows.length} 条`);
  return rows;
}

function snapshotFingerprint(groups) {
  return ["industry", "concept"].map((key) => (groups[key]?.rows || [])
    .map((row) => `${row.code}:${row.amountYuan}`)
    .sort()
    .join("|")).join("||");
}

function snapshotSourceTimes(groups, indices) {
  return [
    groups.industry?.sourceTimestamp,
    groups.concept?.sourceTimestamp,
    ...(indices || []).map((row) => row.sourceTimestamp),
  ].filter(Number.isFinite);
}

function publicStatus(snapshot, state, date = new Date()) {
  const phase = marketPhaseAt(date);
  const sameTradeDate = Boolean(snapshot?.tradeDate && snapshot.tradeDate === phase.tradeDate);
  const active = phase.active && sameTradeDate;
  const fetchedAtMs = snapshot?.fetchedAtMs || 0;
  const cacheAgeMs = fetchedAtMs ? Math.max(0, date.getTime() - fetchedAtMs) : null;
  return {
    ...(snapshot || {
      ok: false,
      version: 1,
      sequence: 0,
      tradeDate: "",
      groups: {industry: {rows: []}, concept: {rows: []}},
      indices: [],
    }),
    active,
    auction: active && phase.auction,
    regularSession: active && phase.regularSession,
    marketPhase: sameTradeDate ? phase.phase : `${phase.phase}·等待当日行情`,
    cacheAgeMs,
    pollIntervalMs: LIVE_INTERVAL_MS,
    consecutiveErrors: state.consecutiveErrors,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    refreshRunning: Boolean(state.inFlight),
  };
}

function createLiveSectorFlowService(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const fetchBoardGroup = options.fetchBoardGroup || ((definition, context) =>
    defaultFetchBoardGroup(definition, {...context, fetchImpl}));
  const fetchIndexQuotes = options.fetchIndexQuotes || ((context) =>
    defaultFetchIndexQuotes({...context, fetchImpl}));
  const log = typeof options.log === "function" ? options.log : () => {};
  const state = {
    snapshot: null,
    fingerprint: "",
    inFlight: null,
    lastAttemptAt: "",
    lastSuccessAt: "",
    lastError: "",
    lastErrorAt: "",
    consecutiveErrors: 0,
    pollTimer: null,
    polling: false,
  };

  async function refresh() {
    if (state.inFlight) return state.inFlight;
    state.inFlight = (async () => {
      const started = now();
      const startedMs = started.getTime();
      state.lastAttemptAt = started.toISOString();
      const context = {nowMs: startedMs, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS};
      const [industry, concept, indices] = await Promise.all([
        fetchBoardGroup(GROUP_DEFINITIONS.industry, context),
        fetchBoardGroup(GROUP_DEFINITIONS.concept, context),
        fetchIndexQuotes(context),
      ]);
      const indexTimes = indices.map((row) => row.sourceTimestamp).filter(Number.isFinite);
      if (indexTimes.length < 3) throw new Error("主要指数同轮时间校验不足，拒绝发布板块资金快照");
      const indexSourceTimestamp = Math.max(...indexTimes);
      const groups = {industry, concept};
      const explicitGroupTimes = [industry.sourceTimestamp, concept.sourceTimestamp].filter(Number.isFinite);
      const groupCaptureTimes = [industry.capturedAtMs, concept.capturedAtMs].filter(Number.isFinite);
      const groupSkewMs = explicitGroupTimes.length === 2
        ? (Math.max(...explicitGroupTimes) - Math.min(...explicitGroupTimes)) * 1000
        : groupCaptureTimes.length === 2
          ? Math.max(...groupCaptureTimes) - Math.min(...groupCaptureTimes)
          : 0;
      if (groupSkewMs > MAX_GROUP_TIMESTAMP_SKEW_MS) {
        throw new Error(`行业与概念同轮采集时间相差 ${groupSkewMs} 毫秒，拒绝发布非同一时点快照`);
      }
      for (const group of Object.values(groups)) {
        if (!Number.isFinite(group.sourceTimestamp)) group.sourceTimestamp = indexSourceTimestamp;
        group.rows = group.rows.map((row) => ({
          ...row,
          sourceTimestamp: Number.isFinite(row.sourceTimestamp) ? row.sourceTimestamp : group.sourceTimestamp,
        }));
      }
      const sourceTimes = snapshotSourceTimes(groups, indices);
      const quoteSourceTimestamp = Math.max(...sourceTimes);
      const sourceTimestamp = clampQuoteTimestampToTradingSession(quoteSourceTimestamp);
      const sourceParts = shanghaiParts(new Date(sourceTimestamp * 1000));
      const quoteSourceParts = shanghaiParts(new Date(quoteSourceTimestamp * 1000));
      const fingerprint = snapshotFingerprint(groups);
      const finished = now();
      const previousSequence = Number(state.snapshot?.sequence) || 0;
      const snapshot = {
        ok: true,
        version: 1,
        sequence: previousSequence + 1,
        changed: fingerprint !== state.fingerprint,
        tradeDate: dateText(sourceParts),
        sourceTime: timeText(sourceParts),
        sourceTimestamp,
        quoteSourceTimestamp,
        quoteSourceTime: timeText(quoteSourceParts),
        marketMinute: marketMinuteFromParts(sourceParts),
        fetchedAt: finished.toISOString(),
        fetchedAtMs: finished.getTime(),
        fetchLatencyMs: Math.max(0, finished.getTime() - startedMs),
        sourceLatencyMs: Math.max(0, finished.getTime() - quoteSourceTimestamp * 1000),
        source: "东方财富板块实时资金排名 + 腾讯主要指数同轮时间校验",
        methodology: "09:15集合竞价起，行业与概念同轮并发获取，并以同轮主要指数行情校验交易日期和时点；只有两组完整且采集时差合格时才原子发布。不使用随机数，不按时间外推资金金额。",
        groupTimestampSkewMs: groupSkewMs,
        groups,
        indices,
        indexCrossCheckCount: indices.length,
      };
      state.snapshot = snapshot;
      state.fingerprint = fingerprint;
      state.lastSuccessAt = finished.toISOString();
      state.lastError = "";
      state.lastErrorAt = "";
      state.consecutiveErrors = 0;
      return snapshot;
    })().catch((error) => {
      state.lastError = error.message || String(error);
      state.lastErrorAt = now().toISOString();
      state.consecutiveErrors += 1;
      throw error;
    }).finally(() => {
      state.inFlight = null;
    });
    return state.inFlight;
  }

  async function getSnapshot(options = {}) {
    const current = now();
    const phase = marketPhaseAt(current);
    const cacheAgeMs = state.snapshot?.fetchedAtMs
      ? Math.max(0, current.getTime() - state.snapshot.fetchedAtMs)
      : Infinity;
    const sameTradeDate = state.snapshot?.tradeDate === phase.tradeDate;
    const refreshAgeMs = phase.active && sameTradeDate ? ACTIVE_REFRESH_AGE_MS : HOLIDAY_REFRESH_AGE_MS;
    const shouldRefresh = options.force || !state.snapshot || (phase.active && cacheAgeMs >= refreshAgeMs);
    if (shouldRefresh) {
      try {
        if (options.nonBlocking && state.snapshot) {
          refresh().catch((error) => log(`逐秒板块资金后台刷新失败：${error.message}`));
        } else {
          await refresh();
        }
      } catch (error) {
        if (!state.snapshot) throw error;
      }
    }
    return publicStatus(state.snapshot, state, now());
  }

  function getState() {
    const status = publicStatus(state.snapshot, state, now());
    return {
      ok: status.ok,
      active: status.active,
      auction: status.auction,
      regularSession: status.regularSession,
      marketPhase: status.marketPhase,
      tradeDate: status.tradeDate,
      sourceTime: status.sourceTime,
      sequence: status.sequence,
      cacheAgeMs: status.cacheAgeMs,
      pollIntervalMs: LIVE_INTERVAL_MS,
      refreshRunning: status.refreshRunning,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      consecutiveErrors: state.consecutiveErrors,
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
      industryRows: status.groups?.industry?.rows?.length || 0,
      conceptRows: status.groups?.concept?.rows?.length || 0,
      indexCrossCheckCount: status.indexCrossCheckCount || 0,
      polling: state.polling,
    };
  }

  function clearPollTimer() {
    if (!state.pollTimer) return;
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  function schedulePoll(delayMs) {
    clearPollTimer();
    if (!state.polling) return;
    state.pollTimer = setTimeout(runPoll, Math.max(50, delayMs));
    if (typeof state.pollTimer.unref === "function") state.pollTimer.unref();
  }

  async function runPoll() {
    state.pollTimer = null;
    if (!state.polling) return;
    const startedAt = now().getTime();
    const phase = marketPhaseAt(now());
    if (phase.active || !state.snapshot) {
      try {
        await refresh();
      } catch (error) {
        log(`逐秒板块资金轮询失败：${error.message}`);
      }
    }
    const elapsed = Math.max(0, now().getTime() - startedAt);
    schedulePoll(phase.active ? Math.max(50, LIVE_INTERVAL_MS - elapsed) : HOLIDAY_REFRESH_AGE_MS);
  }

  function startPolling() {
    if (state.polling) return;
    state.polling = true;
    schedulePoll(0);
  }

  function stopPolling() {
    state.polling = false;
    clearPollTimer();
  }

  return {
    getSnapshot,
    forceRefresh: () => getSnapshot({force: true}),
    getState,
    startPolling,
    stopPolling,
  };
}

module.exports = {
  ACTIVE_REFRESH_AGE_MS,
  clampQuoteTimestampToTradingSession,
  GROUP_DEFINITIONS,
  DEFAULT_TIMEOUT_MS,
  LIVE_INTERVAL_MS,
  createLiveSectorFlowService,
  hasAcceptableBoardCoverage,
  marketMinuteFromParts,
  marketPhaseAt,
  normalizeBoardRows,
  parseTencentIndexQuotes,
};
