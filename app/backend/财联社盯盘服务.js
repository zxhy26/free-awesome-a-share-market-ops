"use strict";

const {
  CLS_INDEX_ANNOTATION_ENDPOINTS,
  fallbackClsAnnotationFeed,
  normalizeClsAnchorPayload,
} = require("./财联社指数标注");
const {marketPhaseAt} = require("./live-sector-flow");

const ACTIVE_REFRESH_MS = 5 * 1000;
const IDLE_REFRESH_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;

function normalizeTradeDate(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || "";
}

async function fetchJson(fetchImpl, url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Referer: "https://www.cls.cn/finance",
        "User-Agent": "Mozilla/5.0 AShareReview/2.21.18",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function createClsMarketWatchService(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const log = typeof options.log === "function" ? options.log : () => {};
  const readCachedFeed = typeof options.readCachedFeed === "function" ? options.readCachedFeed : () => null;
  const getTradeDate = typeof options.getTradeDate === "function" ? options.getTradeDate : () => "";
  const state = {
    feed: null,
    inFlight: null,
    lastAttemptAt: "",
    lastSuccessAt: "",
    lastError: "",
    lastErrorAt: "",
    consecutiveErrors: 0,
    timer: null,
    polling: false,
  };

  function targetTradeDate(explicit = "") {
    return normalizeTradeDate(explicit)
      || normalizeTradeDate(getTradeDate())
      || marketPhaseAt(now()).tradeDate;
  }

  function publicFeed(feed = state.feed) {
    const fetchedAtMs = Date.parse(String(feed?.syncedAt || ""));
    return {
      ...(feed || fallbackClsAnnotationFeed(null, {
        tradeDate: targetTradeDate(),
        syncedAt: now().toISOString(),
        error: state.lastError || "财联社盯盘尚未取得同日板块事件",
      })),
      refreshRunning: Boolean(state.inFlight),
      refreshIntervalMs: ACTIVE_REFRESH_MS,
      cacheAgeMs: Number.isFinite(fetchedAtMs) ? Math.max(0, now().getTime() - fetchedAtMs) : null,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      consecutiveErrors: state.consecutiveErrors,
    };
  }

  async function refresh(options = {}) {
    if (state.inFlight) return state.inFlight;
    state.inFlight = (async () => {
      const tradeDate = targetTradeDate(options.tradeDate);
      const syncedAt = now().toISOString();
      state.lastAttemptAt = syncedAt;
      const errors = [];
      for (const endpoint of CLS_INDEX_ANNOTATION_ENDPOINTS) {
        try {
          const separator = endpoint.includes("?") ? "&" : "?";
          const payload = await fetchJson(
            fetchImpl,
            `${endpoint}${separator}cdate=${encodeURIComponent(tradeDate)}&_=${now().getTime()}`,
            options.timeoutMs || DEFAULT_TIMEOUT_MS,
          );
          const feed = normalizeClsAnchorPayload(payload, {tradeDate, syncedAt});
          state.feed = {...feed, delivery: "direct"};
          state.lastSuccessAt = syncedAt;
          state.lastError = "";
          state.lastErrorAt = "";
          state.consecutiveErrors = 0;
          return publicFeed(state.feed);
        } catch (error) {
          errors.push(`${new URL(endpoint).host}: ${error.message || error}`);
        }
      }
      const message = `财联社盯盘接口连续失败：${errors.join("；")}`;
      state.lastError = message;
      state.lastErrorAt = syncedAt;
      state.consecutiveErrors += 1;
      state.feed = fallbackClsAnnotationFeed(state.feed || readCachedFeed(), {
        tradeDate,
        syncedAt,
        error: message,
      });
      return publicFeed(state.feed);
    })().finally(() => {
      state.inFlight = null;
    });
    return state.inFlight;
  }

  async function getFeed(options = {}) {
    const tradeDate = targetTradeDate(options.tradeDate);
    const phase = marketPhaseAt(now());
    const sameTradeDate = normalizeTradeDate(state.feed?.tradeDate) === tradeDate;
    const syncedAtMs = Date.parse(String(state.feed?.syncedAt || ""));
    const ageMs = Number.isFinite(syncedAtMs) ? Math.max(0, now().getTime() - syncedAtMs) : Infinity;
    const maximumAge = phase.active ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
    if (options.force || !sameTradeDate || ageMs >= maximumAge) {
      if (options.nonBlocking && sameTradeDate && state.feed) {
        refresh({tradeDate}).catch((error) => log(`财联社盯盘后台刷新失败：${error.message}`));
      } else {
        await refresh({tradeDate});
      }
    }
    return publicFeed(state.feed);
  }

  function clearTimer() {
    if (!state.timer) return;
    clearTimeout(state.timer);
    state.timer = null;
  }

  function schedule(delayMs) {
    clearTimer();
    if (!state.polling) return;
    state.timer = setTimeout(runPoll, Math.max(100, delayMs));
    if (typeof state.timer.unref === "function") state.timer.unref();
  }

  async function runPoll() {
    state.timer = null;
    if (!state.polling) return;
    const phase = marketPhaseAt(now());
    try {
      await getFeed({force: true});
    } catch (error) {
      log(`财联社盯盘轮询失败：${error.message}`);
    }
    schedule(phase.active ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);
  }

  function startPolling() {
    if (state.polling) return;
    state.polling = true;
    schedule(0);
  }

  function stopPolling() {
    state.polling = false;
    clearTimer();
  }

  function getState() {
    const feed = publicFeed(state.feed);
    return {
      ok: feed.status === "ok" || feed.status === "retained",
      source: feed.source,
      status: feed.status,
      tradeDate: feed.tradeDate,
      itemCount: feed.itemCount || 0,
      excludedStockCount: feed.excludedStockCount || 0,
      refreshIntervalMs: ACTIVE_REFRESH_MS,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError,
      consecutiveErrors: state.consecutiveErrors,
      polling: state.polling,
    };
  }

  return {
    forceRefresh: (options = {}) => getFeed({...options, force: true}),
    getFeed,
    getState,
    startPolling,
    stopPolling,
  };
}

module.exports = {
  ACTIVE_REFRESH_MS,
  DEFAULT_TIMEOUT_MS,
  IDLE_REFRESH_MS,
  createClsMarketWatchService,
};
