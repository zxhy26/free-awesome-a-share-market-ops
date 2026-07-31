"use strict";

const CLS_INDEX_ANNOTATION_SOURCE = "财联社盘面直播";
const CLS_INDEX_ANNOTATION_PAGE = "https://www.cls.cn/finance";
const CLS_INDEX_ANNOTATION_ENDPOINTS = Object.freeze([
  "https://api3.cls.cn/v3/transaction/anchor",
  "https://www.cls.cn/v3/transaction/anchor",
]);

function normalizeTradeDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function marketMinuteFromClsTime(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] || 0);
  if (![hour, minute, second].every(Number.isFinite)) return null;
  const seconds = hour * 3600 + minute * 60 + second;
  const morningOpen = 9 * 3600 + 30 * 60;
  const morningClose = 11 * 3600 + 30 * 60;
  const afternoonOpen = 13 * 3600;
  const afternoonClose = 15 * 3600;
  if (seconds >= morningOpen && seconds <= morningClose) return (seconds - morningOpen) / 60;
  if (seconds >= afternoonOpen && seconds <= afternoonClose) return 120 + (seconds - afternoonOpen) / 60;
  return null;
}

function normalizeClsAnchorPayload(payload, options = {}) {
  if (Number(payload?.errno) !== 0 || !Array.isArray(payload?.data)) {
    throw new Error(`财联社盘面直播返回异常：${payload?.msg || payload?.errno || "缺少事件列表"}`);
  }
  const tradeDate = normalizeTradeDate(options.tradeDate);
  const syncedAt = String(options.syncedAt || "");
  const seen = new Set();
  const items = [];
  for (const row of payload.data) {
    const sourceTime = String(row?.c_time || "").trim();
    if (!sourceTime || (tradeDate && normalizeTradeDate(sourceTime) !== tradeDate)) continue;
    const minute = marketMinuteFromClsTime(sourceTime);
    if (!Number.isFinite(minute)) continue;
    const label = String(row?.symbol_name || "").trim();
    if (!label) continue;
    const sourceDirection = row?.float === "up" ? "up" : row?.float === "down" ? "down" : "neutral";
    const articleId = /^\d+$/.test(String(row?.article_id || "")) ? String(row.article_id) : "";
    const symbolCode = String(row?.symbol_code || "").trim();
    const identity = articleId || `${sourceTime}|${symbolCode}|${label}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    items.push({
      id: `cls-${identity}`,
      minute,
      sourceTime,
      label,
      sourceDirection,
      symbolCode,
      articleId,
      articleUrl: articleId ? `https://www.cls.cn/detail/${articleId}` : "",
      source: CLS_INDEX_ANNOTATION_SOURCE,
    });
  }
  items.sort((left, right) => left.minute - right.minute || left.sourceTime.localeCompare(right.sourceTime, "zh-CN"));
  return {
    version: 1,
    tradeDate,
    syncedAt,
    source: CLS_INDEX_ANNOTATION_SOURCE,
    sourcePage: CLS_INDEX_ANNOTATION_PAGE,
    status: "ok",
    originalCount: payload.data.length,
    itemCount: items.length,
    items,
  };
}

function fallbackClsAnnotationFeed(cachedFeed, options = {}) {
  const tradeDate = normalizeTradeDate(options.tradeDate);
  const syncedAt = String(options.syncedAt || "");
  const error = String(options.error || "财联社盘面直播暂时无法读取").slice(0, 300);
  if (
    cachedFeed
    && normalizeTradeDate(cachedFeed.tradeDate) === tradeDate
    && Array.isArray(cachedFeed.items)
  ) {
    return {
      ...cachedFeed,
      tradeDate,
      syncedAt,
      source: CLS_INDEX_ANNOTATION_SOURCE,
      sourcePage: CLS_INDEX_ANNOTATION_PAGE,
      status: "retained",
      itemCount: cachedFeed.items.length,
      lastError: error,
    };
  }
  return {
    version: 1,
    tradeDate,
    syncedAt,
    source: CLS_INDEX_ANNOTATION_SOURCE,
    sourcePage: CLS_INDEX_ANNOTATION_PAGE,
    status: "unavailable",
    originalCount: 0,
    itemCount: 0,
    items: [],
    lastError: error,
  };
}

module.exports = {
  CLS_INDEX_ANNOTATION_ENDPOINTS,
  CLS_INDEX_ANNOTATION_PAGE,
  CLS_INDEX_ANNOTATION_SOURCE,
  fallbackClsAnnotationFeed,
  marketMinuteFromClsTime,
  normalizeClsAnchorPayload,
};
