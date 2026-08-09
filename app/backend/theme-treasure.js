"use strict";

const fs = require("fs");
const path = require("path");
const themeModelPromise = import("../assets/js/theme-treasure-model.js");

const BOARD_API_HOSTS = Object.freeze([
  "https://push2delay.eastmoney.com",
  "https://push2.eastmoney.com",
]);
const EASTMONEY_TOKEN = "bd1d9ddb04089700cf9c27f6f7426281";
const DETAIL_CACHE_MS = 60 * 1000;
const PROFILE_CACHE_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12000;
const A_SHARE_CODE_RE = /^\d{6}$/;

function finite(value) {
  if (value === null || value === undefined || value === "" || value === "-") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  try {
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, "utf8");
    fs.renameSync(temporaryPath, filePath);
  } catch (_) {
    // A read-only release still serves the in-memory live snapshot.
  }
}

async function fetchJson(fetchImpl, url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      cache: "no-store",
      headers: {
        Accept: "application/json,text/plain,*/*",
        Referer: "https://quote.eastmoney.com/",
        "User-Agent": "Mozilla/5.0",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBoardConstituents(fetchImpl, boardCode) {
  const errors = [];
  for (const host of BOARD_API_HOSTS) {
    const url = new URL("/api/qt/clist/get", host);
    Object.entries({
      pn: "1",
      pz: "80",
      po: "1",
      np: "1",
      fltt: "2",
      invt: "2",
      fid: "f6",
      fs: `b:${boardCode}`,
      fields: "f12,f13,f14,f2,f3,f6,f8,f20,f21,f100,f103",
      ut: EASTMONEY_TOKEN,
      _: String(Date.now()),
    }).forEach(([key, value]) => url.searchParams.set(key, value));
    try {
      const payload = await fetchJson(fetchImpl, url);
      const rows = Array.isArray(payload?.data?.diff) ? payload.data.diff : [];
      const normalized = rows.map((row) => {
        const code = String(row?.f12 || "").trim();
        const name = String(row?.f14 || "").trim();
        if (!A_SHARE_CODE_RE.test(code) || !name || /^(ST|\*ST)|退市/u.test(name)) return null;
        return {
          code,
          name,
          market: finite(row?.f13),
          price: finite(row?.f2),
          changePct: finite(row?.f3),
          amount: finite(row?.f6) === null ? null : Number(row.f6) / 100000000,
          turnoverRate: finite(row?.f8),
          totalMarketCap: finite(row?.f20),
          floatMarketCap: finite(row?.f21),
          industry: String(row?.f100 || "").trim(),
          concepts: String(row?.f103 || "").split(/[，,、;]/u).map((item) => item.trim()).filter(Boolean),
        };
      }).filter(Boolean);
      if (normalized.length < 3) throw new Error(`只返回${normalized.length}只有效成分股`);
      return normalized;
    } catch (error) {
      errors.push(`${host}: ${error.message}`);
    }
  }
  throw new Error(`题材成分股接口失败：${errors.join("；")}`);
}

function f10MarketPrefix(stockCode) {
  const code = String(stockCode || "").trim();
  if (/^(430|83[0-9]|87[0-9]|920)/.test(code)) return "BJ";
  if (/^(6|9)/.test(code)) return "SH";
  return "SZ";
}

async function fetchCompanySurvey(fetchImpl, stockCode) {
  const normalizedCode = String(stockCode || "").trim();
  if (!A_SHARE_CODE_RE.test(normalizedCode)) throw new Error("股票代码无效");
  const securityCode = `${f10MarketPrefix(normalizedCode)}${normalizedCode}`;
  const url = new URL("https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/CompanySurveyAjax");
  url.searchParams.set("code", securityCode);
  const payload = await fetchJson(fetchImpl, url, REQUEST_TIMEOUT_MS);
  if (!payload?.jbzl || typeof payload.jbzl !== "object") throw new Error("公司F10资料为空");
  return payload;
}

function createThemeTreasureService(options = {}) {
  if (!options.liveSectorFlow) throw new Error("题材宝典需要实时板块服务");
  const liveSectorFlow = options.liveSectorFlow;
  const dataDir = path.resolve(options.dataDir || path.join(__dirname, "..", "data"));
  const snapshotPath = path.join(dataDir, "theme-treasure.json");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const log = typeof options.log === "function" ? options.log : () => {};
  const detailCache = new Map();
  const profileCache = new Map();

  async function ranking(parameters = {}) {
    const {buildThemeRanking} = await themeModelPromise;
    let snapshot = null;
    let liveError = "";
    try {
      snapshot = parameters.force
        ? await liveSectorFlow.forceRefresh()
        : await liveSectorFlow.getSnapshot({nonBlocking: true});
    } catch (error) {
      liveError = error.message || String(error);
    }
    let result = snapshot ? buildThemeRanking(snapshot, parameters) : null;
    if (!result?.items?.length) {
      const fallback = readJson(snapshotPath, null);
      if (fallback?.items?.length) {
        result = buildThemeRanking(fallback, parameters);
        result.fallback = true;
        result.warning = liveError || fallback.warning || "实时题材快照暂不可用，展示最近一次已验证快照。";
      }
    }
    if (!result?.items?.length) {
      const error = new Error(liveError || "题材榜单没有可用的真实行情快照");
      error.code = "THEME_TREASURE_UNAVAILABLE";
      throw error;
    }
    if (!result.fallback && snapshot) {
      const canonical = buildThemeRanking(snapshot, {sort: "score", limit: 600});
      writeJsonAtomic(snapshotPath, {
        ...canonical,
        sort: "score",
        query: "",
        count: canonical.items.length,
        cachedAt: now().toISOString(),
      });
    }
    return result;
  }

  async function detail(code, parameters = {}) {
    const {buildThemeDetail} = await themeModelPromise;
    const normalizedCode = String(code || "").trim().toUpperCase();
    if (!/^BK\d{4}$/.test(normalizedCode)) {
      const error = new Error("题材代码无效");
      error.statusCode = 400;
      throw error;
    }
    const list = await ranking({sort: "score", limit: 600, includeGeneric: true});
    const theme = list.items.find((item) => item.code === normalizedCode);
    if (!theme) {
      const error = new Error("当前完整题材快照中找不到该题材");
      error.statusCode = 404;
      throw error;
    }
    const cached = detailCache.get(normalizedCode);
    if (!parameters.force && cached && now().getTime() - cached.savedAt < DETAIL_CACHE_MS) return cached.data;
    try {
      const constituents = await fetchBoardConstituents(fetchImpl, normalizedCode);
      const data = buildThemeDetail(theme, constituents, {
        source: "东方财富概念板块成分股公开行情",
        fetchedAt: now().toISOString(),
      });
      detailCache.set(normalizedCode, {savedAt: now().getTime(), data});
      return data;
    } catch (error) {
      if (cached?.data) return {...cached.data, warning: `成分股刷新失败，保留最近一次结果：${error.message}`};
      log(`题材宝典 ${normalizedCode} 成分股读取失败：${error.message}`);
      return buildThemeDetail(theme, [], {
        source: "东方财富概念板块公开行情",
        fetchedAt: now().toISOString(),
        warning: error.message,
      });
    }
  }

  async function company(themeCode, stockCode, parameters = {}) {
    const {buildCompanyThemeProfile} = await themeModelPromise;
    const normalizedThemeCode = String(themeCode || "").trim().toUpperCase();
    const normalizedStockCode = String(stockCode || "").trim();
    if (!/^BK\d{4}$/.test(normalizedThemeCode)) {
      const error = new Error("题材代码无效");
      error.statusCode = 400;
      throw error;
    }
    if (!A_SHARE_CODE_RE.test(normalizedStockCode)) {
      const error = new Error("股票代码无效");
      error.statusCode = 400;
      throw error;
    }
    const themeDetail = await detail(normalizedThemeCode);
    const visibleStocks = [
      ...(Array.isArray(themeDetail?.constituents) ? themeDetail.constituents : []),
      ...(Array.isArray(themeDetail?.groups) ? themeDetail.groups.flatMap((group) => group.items || []) : []),
    ];
    const stock = visibleStocks.find((item) => item?.code === normalizedStockCode);
    if (!stock) {
      const error = new Error("该股票不在当前题材已核验的成分股中");
      error.statusCode = 404;
      error.code = "THEME_STOCK_NOT_VERIFIED";
      throw error;
    }
    const cached = profileCache.get(normalizedStockCode);
    const cacheFresh = cached && now().getTime() - cached.savedAt < PROFILE_CACHE_MS;
    let profile = cacheFresh && !parameters.force ? cached.profile : null;
    let warning = "";
    if (!profile) {
      try {
        profile = await fetchCompanySurvey(fetchImpl, normalizedStockCode);
        profileCache.set(normalizedStockCode, {savedAt: now().getTime(), profile});
      } catch (error) {
        warning = `公司F10资料刷新失败：${error.message}`;
        profile = cached?.profile || {};
        log(`题材宝典 ${normalizedThemeCode}/${normalizedStockCode} 公司资料读取失败：${error.message}`);
      }
    }
    return buildCompanyThemeProfile(themeDetail.theme, stock, profile, {
      source: "东方财富F10公司资料与概念板块成分股公开行情",
      fetchedAt: now().toISOString(),
      warning,
    });
  }

  return {
    company,
    detail,
    ranking,
    getState: () => ({
      cachedDetails: detailCache.size,
      cachedProfiles: profileCache.size,
      snapshotAvailable: Boolean(readJson(snapshotPath, null)?.items?.length),
    }),
  };
}

module.exports = {
  createThemeTreasureService,
  fetchBoardConstituents,
  fetchCompanySurvey,
  f10MarketPrefix,
};
