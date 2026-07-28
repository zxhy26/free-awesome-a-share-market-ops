const fs = require("fs");
const path = require("path");

const EASTMONEY_UT = "fa5fd1943c7b386f172d6893dbfba10b";
const DATA_CENTER_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const CNINDEX_SAMPLE_URL = "https://www.cnindex.com.cn/sample-detail/detail";
const QUOTE_HOSTS = Object.freeze([
  "https://push2delay.eastmoney.com",
  "https://push2.eastmoney.com",
]);
const INDEX_DEFINITIONS = Object.freeze([
  {code: "399001", name: "深证成指", secid: "0.399001", source: "cnindex", minimumCount: 495},
  {code: "399006", name: "创业板指", secid: "0.399006", source: "cnindex", minimumCount: 98},
  {code: "899050", name: "北证50", secid: "0.899050", source: "eastmoney-cap", type: "10", minimumCount: 48},
  {code: "000688", name: "科创50", secid: "1.000688", source: "eastmoney", type: "4", minimumCount: 48},
  {code: "000001", name: "上证指数", secid: "1.000001", source: "sse-composite", minimumCount: 2000},
  {code: "000905", name: "中证500", secid: "1.000905", source: "eastmoney", type: "3", minimumCount: 495},
  {code: "000300", name: "沪深300", secid: "1.000300", source: "eastmoney", type: "1", minimumCount: 295},
]);
const EASTMONEY_COMPONENT_TYPES = Object.freeze(["1", "3", "4", "10"]);
const REQUEST_TIMEOUT_MS = 18000;

function finiteNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && (!value.trim() || /^-+$/u.test(value.trim()))) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  const number = finiteNumber(value);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round((number + Number.EPSILON) * factor) / factor;
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function chinaDateParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const result = {};
  parts.forEach((part) => {
    if (part.type !== "literal") result[part.type] = part.value;
  });
  return result;
}

function chinaDateText(value = new Date()) {
  const parts = chinaDateParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function chinaDateTimeText(value = new Date()) {
  const parts = chinaDateParts(value);
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function tradeDateFromTimestamp(timestamp) {
  const seconds = finiteNumber(timestamp);
  return seconds === null || seconds <= 0 ? "" : chinaDateText(new Date(seconds * 1000));
}

function toQuery(params) {
  return new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null)).toString();
}

async function requestJson(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 运行环境不支持 fetch");
  const attempts = Math.max(1, Number(options.attempts || 2));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || REQUEST_TIMEOUT_MS));
  const errors = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json,text/plain,*/*",
          Referer: options.referer || "https://quote.eastmoney.com/",
          "User-Agent": "Mozilla/5.0 AShareReview/2.16",
          ...(options.headers || {}),
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload === null || typeof payload !== "object") throw new Error("接口未返回 JSON 对象");
      return payload;
    } catch (error) {
      errors.push(error.name === "AbortError" ? `超时 ${timeoutMs}ms` : error.message);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${options.label || "公开行情接口"}失败：${errors.join("；")}`);
}

async function requestQuoteJson(endpoint, params, options = {}) {
  const errors = [];
  for (const host of QUOTE_HOSTS) {
    try {
      const url = `${host}${endpoint}?${toQuery(params)}`;
      const payload = await requestJson(url, {...options, attempts: 1});
      if (!payload.data) throw new Error("行情数据为空");
      return payload;
    } catch (error) {
      errors.push(`${host.replace(/^https:\/\//u, "")}: ${error.message}`);
    }
  }
  throw new Error(`${options.label || "东方财富行情"}失败：${errors.join("；")}`);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({length: Math.min(Math.max(1, limit), items.length || 1)}, worker));
  return results;
}

async function fetchIndexQuotes(fetchImpl) {
  const payload = await requestQuoteJson("/api/qt/ulist.np/get", {
    fltt: "2",
    invt: "2",
    fields: "f2,f3,f4,f12,f13,f14,f18,f20,f21,f124",
    secids: INDEX_DEFINITIONS.map((definition) => definition.secid).join(","),
  }, {fetchImpl, label: "主要指数实时行情"});
  const rows = Array.isArray(payload.data?.diff) ? payload.data.diff : [];
  const quotes = new Map();
  rows.forEach((row) => {
    const code = cleanText(row.f12);
    if (!code) return;
    quotes.set(code, {
      code,
      name: cleanText(row.f14),
      price: finiteNumber(row.f2),
      changePct: finiteNumber(row.f3),
      changePoints: finiteNumber(row.f4),
      preClose: finiteNumber(row.f18),
      totalMarketCap: finiteNumber(row.f20),
      timestamp: finiteNumber(row.f124),
    });
  });
  if (quotes.size < INDEX_DEFINITIONS.length) {
    throw new Error(`主要指数行情仅返回 ${quotes.size}/${INDEX_DEFINITIONS.length} 条`);
  }
  return quotes;
}

async function fetchCnindexComponents(code, fetchImpl) {
  const payload = await requestJson(`${CNINDEX_SAMPLE_URL}?${toQuery({
    indexcode: code,
    dateStr: "",
    pageNum: "1",
    rows: "700",
    isFirstCall: "1",
  })}`, {
    fetchImpl,
    label: `国证指数 ${code} 样本权重`,
    referer: `https://www.cnindex.com.cn/module/index-detail.html?indexCode=${code}`,
  });
  const rows = Array.isArray(payload.data?.rows) ? payload.data.rows : [];
  const total = Number(payload.total || payload.data?.total || rows.length || 0);
  if (payload.code !== 200 || !rows.length || rows.length < total) {
    throw new Error(`国证指数 ${code} 样本仅返回 ${rows.length}/${total} 条`);
  }
  return rows.map((row) => ({
    code: cleanText(row.seccode),
    name: cleanText(row.secname),
    industry: cleanText(row.trade),
    weightPct: finiteNumber(row.weight),
    weightDate: cleanText(row.dateStr),
  })).filter((row) => /^\d{6}$/u.test(row.code));
}

async function fetchEastmoneyComponentPage(type, pageNumber, pageSize, fetchImpl) {
  const payload = await requestJson(`${DATA_CENTER_URL}?${toQuery({
    reportName: "RPT_INDEX_TS_COMPONENT",
    columns: "SECUCODE,SECURITY_CODE,TYPE,SECURITY_NAME_ABBR,CLOSE_PRICE,INDUSTRY,WEIGHT,FREE_CAP",
    quoteColumns: "f2,f3",
    filter: `(TYPE="${type}")`,
    pageNumber: String(pageNumber),
    pageSize: String(pageSize),
    sortTypes: "-1",
    sortColumns: type === "10" ? "FREE_CAP" : "WEIGHT",
    source: "WEB",
    client: "WEB",
  })}`, {
    fetchImpl,
    label: `东方财富指数成分 ${type}`,
    referer: "https://data.eastmoney.com/other/index/zz500.html",
    timeoutMs: 30000,
  });
  if (payload.success !== true || !payload.result) throw new Error(payload.message || `指数成分 ${type} 返回异常`);
  return payload.result;
}

async function fetchEastmoneyComponents(type, fetchImpl) {
  const pageSize = 100;
  const first = await fetchEastmoneyComponentPage(type, 1, pageSize, fetchImpl);
  const total = Number(first.count || first.data?.length || 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const remaining = await mapWithConcurrency(
    Array.from({length: Math.max(0, pageCount - 1)}, (_, index) => index + 2),
    4,
    (pageNumber) => fetchEastmoneyComponentPage(type, pageNumber, pageSize, fetchImpl),
  );
  const rows = [first, ...remaining].flatMap((page) => Array.isArray(page.data) ? page.data : []);
  if (!rows.length || rows.length < total) {
    throw new Error(`东方财富指数成分 ${type} 仅返回 ${rows.length}/${total} 条`);
  }
  return rows.map((row) => ({
    code: cleanText(row.SECURITY_CODE),
    name: cleanText(row.SECURITY_NAME_ABBR),
    industry: cleanText(row.INDUSTRY),
    weightPct: finiteNumber(row.WEIGHT),
    currentPrice: finiteNumber(row.f2),
    changePct: finiteNumber(row.f3),
    preClose: finiteNumber(row.CLOSE_PRICE),
    marketCap: finiteNumber(row.FREE_CAP),
  })).filter((row) => /^\d{6}$/u.test(row.code));
}

function stockSecid(code) {
  return /^[5689]/u.test(code) ? `1.${code}` : `0.${code}`;
}

async function fetchStockQuoteMap(codes, fetchImpl) {
  const uniqueCodes = [...new Set(codes.filter((code) => /^\d{6}$/u.test(code)))];
  const batches = [];
  for (let index = 0; index < uniqueCodes.length; index += 60) batches.push(uniqueCodes.slice(index, index + 60));
  const pages = await mapWithConcurrency(batches, 4, async (batch) => {
    const payload = await requestQuoteJson("/api/qt/ulist.np/get", {
      fltt: "2",
      invt: "2",
      fields: "f2,f3,f12,f13,f14,f18,f20,f21,f124",
      secids: batch.map(stockSecid).join(","),
    }, {fetchImpl, label: "指数样本实时行情"});
    return Array.isArray(payload.data?.diff) ? payload.data.diff : [];
  });
  const result = new Map();
  pages.flat().forEach((row) => {
    const code = cleanText(row.f12);
    if (!code) return;
    result.set(code, {
      code,
      name: cleanText(row.f14),
      currentPrice: finiteNumber(row.f2),
      changePct: finiteNumber(row.f3),
      preClose: finiteNumber(row.f18),
      totalMarketCap: finiteNumber(row.f20),
      floatMarketCap: finiteNumber(row.f21),
      timestamp: finiteNumber(row.f124),
    });
  });
  return result;
}

async function fetchShanghaiPage(pageNumber, fetchImpl) {
  const payload = await requestQuoteJson("/api/qt/clist/get", {
    ut: EASTMONEY_UT,
    pn: String(pageNumber),
    pz: "100",
    po: "1",
    np: "1",
    fltt: "2",
    invt: "2",
    fid: "f20",
    fs: "m:1+t:2,m:1+t:23",
    fields: "f2,f3,f12,f13,f14,f18,f20,f21,f26,f124",
  }, {fetchImpl, label: `沪市股票行情第 ${pageNumber} 页`});
  return payload.data;
}

async function fetchShanghaiStocks(fetchImpl) {
  const first = await fetchShanghaiPage(1, fetchImpl);
  const total = Number(first.total || first.diff?.length || 0);
  const pageCount = Math.max(1, Math.ceil(total / 100));
  const remaining = await mapWithConcurrency(
    Array.from({length: Math.max(0, pageCount - 1)}, (_, index) => index + 2),
    5,
    (pageNumber) => fetchShanghaiPage(pageNumber, fetchImpl),
  );
  const rows = [first, ...remaining].flatMap((page) => Array.isArray(page?.diff) ? page.diff : []);
  if (!rows.length || rows.length < total) throw new Error(`沪市股票行情仅返回 ${rows.length}/${total} 条`);
  return rows.map((row) => ({
    code: cleanText(row.f12),
    name: cleanText(row.f14),
    currentPrice: finiteNumber(row.f2),
    changePct: finiteNumber(row.f3),
    preClose: finiteNumber(row.f18),
    totalMarketCap: finiteNumber(row.f20),
    floatMarketCap: finiteNumber(row.f21),
    ipoDate: cleanText(row.f26),
    timestamp: finiteNumber(row.f124),
  })).filter((row) => /^6\d{5}$/u.test(row.code));
}

function daysBetweenCompactDate(compact, tradeDate) {
  if (!/^\d{8}$/u.test(compact) || !/^\d{4}-\d{2}-\d{2}$/u.test(tradeDate)) return null;
  const start = Date.UTC(Number(compact.slice(0, 4)), Number(compact.slice(4, 6)) - 1, Number(compact.slice(6, 8)));
  const end = Date.UTC(Number(tradeDate.slice(0, 4)), Number(tradeDate.slice(5, 7)) - 1, Number(tradeDate.slice(8, 10)));
  return Math.floor((end - start) / 86400000);
}

function eligibleSseCompositeStocks(rows, tradeDate) {
  const candidates = rows.filter((row) => {
    if (!row.code || !row.name || /(?:\*?ST|退市|退整理)/iu.test(row.name)) return false;
    return row.totalMarketCap !== null && row.totalMarketCap > 0 && row.changePct !== null;
  });
  const topTen = new Set([...candidates]
    .sort((left, right) => right.totalMarketCap - left.totalMarketCap)
    .slice(0, 10)
    .map((row) => row.code));
  return candidates.filter((row) => {
    const listedDays = daysBetweenCompactDate(row.ipoDate, tradeDate);
    if (listedDays === null) return true;
    return listedDays >= 365 || (listedDays >= 90 && topTen.has(row.code));
  });
}

function cappedWeights(items, options = {}) {
  const maxSingle = Number(options.maxSingle || 100);
  const topGroupCount = Number(options.topGroupCount || 0);
  const topGroupMax = Number(options.topGroupMax || 100);
  const base = items.map((item) => {
    const change = finiteNumber(item.changePct) || 0;
    const currentCap = finiteNumber(item.marketCap);
    const previousCap = currentCap === null || currentCap <= 0 || 1 + change / 100 <= 0
      ? 0
      : currentCap / (1 + change / 100);
    return {...item, previousCap, weightPct: 0};
  });
  const total = base.reduce((sum, item) => sum + item.previousCap, 0);
  if (total <= 0) throw new Error("自由流通市值合计无效");

  const remaining = new Set(base.map((_, index) => index));
  let fixedWeight = 0;
  while (remaining.size) {
    const remainingCap = [...remaining].reduce((sum, index) => sum + base[index].previousCap, 0);
    const available = 100 - fixedWeight;
    const overCap = [...remaining].filter((index) => available * base[index].previousCap / remainingCap > maxSingle);
    if (!overCap.length) {
      remaining.forEach((index) => {
        base[index].weightPct = available * base[index].previousCap / remainingCap;
      });
      break;
    }
    overCap.forEach((index) => {
      base[index].weightPct = maxSingle;
      fixedWeight += maxSingle;
      remaining.delete(index);
    });
  }

  if (topGroupCount > 0 && topGroupMax < 100) {
    const ordered = [...base].sort((left, right) => right.weightPct - left.weightPct);
    const topCodes = new Set(ordered.slice(0, topGroupCount).map((item) => item.code));
    const topWeight = ordered.slice(0, topGroupCount).reduce((sum, item) => sum + item.weightPct, 0);
    if (topWeight > topGroupMax) {
      const remainder = base.filter((item) => !topCodes.has(item.code));
      const remainderWeight = remainder.reduce((sum, item) => sum + item.weightPct, 0);
      base.forEach((item) => {
        if (topCodes.has(item.code)) item.weightPct *= topGroupMax / topWeight;
        else if (remainderWeight > 0) item.weightPct *= (100 - topGroupMax) / remainderWeight;
      });
    }
  }
  return base;
}

function fillMissingWeights(items, options = {}) {
  const maxSingle = Number(options.maxSingle || 100);
  const result = items.map((item) => ({...item}));
  const fixedWeight = result.reduce((sum, item) => sum + (finiteNumber(item.weightPct) || 0), 0);
  const missing = result.filter((item) => finiteNumber(item.weightPct) === null);
  if (!missing.length) return result;
  if (fixedWeight >= 100) throw new Error(`已披露样本权重合计 ${fixedWeight.toFixed(2)}%`);

  missing.forEach((item) => {
    const change = finiteNumber(item.changePct) || 0;
    const currentCap = finiteNumber(item.marketCap);
    item.previousCap = currentCap === null || currentCap <= 0 || 1 + change / 100 <= 0
      ? 0
      : currentCap / (1 + change / 100);
  });
  if (missing.reduce((sum, item) => sum + item.previousCap, 0) <= 0) {
    throw new Error("未披露权重样本的自由流通市值合计无效");
  }

  const active = new Set(missing.map((_, index) => index));
  let assigned = fixedWeight;
  while (active.size) {
    const activeCap = [...active].reduce((sum, index) => sum + missing[index].previousCap, 0);
    const available = 100 - assigned;
    const overCap = [...active].filter((index) => available * missing[index].previousCap / activeCap > maxSingle);
    if (!overCap.length) {
      active.forEach((index) => {
        missing[index].weightPct = available * missing[index].previousCap / activeCap;
      });
      break;
    }
    overCap.forEach((index) => {
      missing[index].weightPct = maxSingle;
      assigned += maxSingle;
      active.delete(index);
    });
  }
  return result;
}

function normalizeWeightedComponents(components, quoteMap) {
  return components.map((component) => {
    const quote = quoteMap?.get(component.code) || null;
    return {
      ...component,
      name: component.name || quote?.name || component.code,
      changePct: quote ? finiteNumber(quote.changePct) : finiteNumber(component.changePct),
      preClose: quote ? finiteNumber(quote.preClose) : finiteNumber(component.preClose),
      currentPrice: quote ? finiteNumber(quote.currentPrice) : finiteNumber(component.currentPrice),
      marketCap: quote
        ? finiteNumber(quote.floatMarketCap) ?? finiteNumber(quote.totalMarketCap)
        : finiteNumber(component.marketCap),
      quoteFound: Boolean(quote) || finiteNumber(component.changePct) !== null,
    };
  });
}

function rankedContributionRows(indexQuote, components) {
  if (indexQuote.preClose === null || indexQuote.preClose <= 0) throw new Error("指数前收盘点位无效");
  let rows = components.map((component) => {
    const changePct = finiteNumber(component.changePct);
    const weightPct = finiteNumber(component.weightPct);
    if (changePct === null || weightPct === null || weightPct < 0) return null;
    return {
      code: component.code,
      name: component.name,
      industry: component.industry || "",
      points: indexQuote.preClose * weightPct / 100 * changePct / 100,
      changePct,
      preClose: finiteNumber(component.preClose),
      weightPct,
    };
  }).filter(Boolean);
  const rawCalculatedChangePoints = rows.reduce((sum, row) => sum + row.points, 0);
  const actualChangePoints = finiteNumber(indexQuote.changePoints);
  const rawFactor = actualChangePoints !== null && Math.abs(rawCalculatedChangePoints) >= 0.01
    ? actualChangePoints / rawCalculatedChangePoints
    : 1;
  const reconciliationFactor = rawFactor > 0 && rawFactor >= 0.5 && rawFactor <= 2 ? rawFactor : 1;
  if (reconciliationFactor !== 1) {
    rows = rows.map((row) => ({...row, points: row.points * reconciliationFactor}));
  }
  const positive = rows.filter((row) => row.points > 0)
    .sort((left, right) => right.points - left.points)
    .slice(0, 10)
    .map((row, index) => ({...row, points: round(row.points, 2), weightPct: round(row.weightPct, 4), rank: index + 1}));
  const negative = rows.filter((row) => row.points < 0)
    .sort((left, right) => left.points - right.points)
    .slice(0, 10)
    .map((row, index) => ({...row, points: round(row.points, 2), weightPct: round(row.weightPct, 4), rank: index + 1}));
  return {
    positive,
    negative,
    calculatedChangePoints: round(rows.reduce((sum, row) => sum + row.points, 0), 2),
    rawCalculatedChangePoints: round(rawCalculatedChangePoints, 2),
    reconciliationFactor: round(reconciliationFactor, 4),
    usableCount: rows.length,
  };
}

function buildWeightedIndex(definition, indexQuote, rawComponents, quoteMap, options = {}) {
  let components = normalizeWeightedComponents(rawComponents, quoteMap);
  if (options.deriveMissingWeights) {
    components = fillMissingWeights(components, options.deriveMissingWeights);
  }
  if (options.deriveWeights) {
    components = cappedWeights(components.map((item) => ({
      ...item,
      marketCap: item.marketCap,
      changePct: item.changePct,
    })), options.deriveWeights);
  }
  const quoteCoverage = components.length
    ? components.filter((item) => item.quoteFound || finiteNumber(item.changePct) !== null).length / components.length * 100
    : 0;
  const weightSum = components.reduce((sum, item) => sum + (finiteNumber(item.weightPct) || 0), 0);
  const ranking = rankedContributionRows(indexQuote, components);
  const minimumCount = definition.minimumCount || 1;
  if (components.length < minimumCount) throw new Error(`${definition.name} 成分股仅 ${components.length}/${minimumCount} 条`);
  if (quoteCoverage < 95) throw new Error(`${definition.name} 实时行情覆盖率仅 ${quoteCoverage.toFixed(1)}%`);
  if (weightSum < 95 || weightSum > 105) throw new Error(`${definition.name} 成分权重合计 ${weightSum.toFixed(2)}%`);
  return {
    code: definition.code,
    name: definition.name,
    positive: ranking.positive,
    negative: ranking.negative,
    constituentCount: components.length,
    componentSource: options.componentSource,
    weightDate: cleanText(components.find((item) => item.weightDate)?.weightDate),
    methodology: `${options.methodology || "指数前收盘点位 × 成分权重 × 个股涨跌幅"}，并用指数实际涨跌点数校准总贡献`,
    quality: {
      quoteCoveragePct: round(quoteCoverage, 1),
      weightSumPct: round(weightSum, 2),
      rawCalculatedChangePoints: ranking.rawCalculatedChangePoints,
      reconciliationFactor: ranking.reconciliationFactor,
      calculatedChangePoints: ranking.calculatedChangePoints,
      actualChangePoints: round(indexQuote.changePoints, 2),
      residualPoints: round((indexQuote.changePoints || 0) - (ranking.calculatedChangePoints || 0), 2),
    },
  };
}

function buildSseComposite(definition, indexQuote, shanghaiRows, tradeDate) {
  const components = eligibleSseCompositeStocks(shanghaiRows, tradeDate);
  const previousCaps = components.map((component) => {
    const changePct = finiteNumber(component.changePct) || 0;
    const previousCap = component.totalMarketCap / (1 + changePct / 100);
    return {...component, previousCap};
  });
  const previousIndexCap = previousCaps.reduce((sum, component) => sum + component.previousCap, 0);
  if (previousIndexCap <= 0) throw new Error("上证指数合格样本总市值无效");
  const weighted = previousCaps.map((component) => {
    return {
      ...component,
      quoteFound: true,
      weightPct: component.previousCap / previousIndexCap * 100,
    };
  });
  const ranking = rankedContributionRows(indexQuote, weighted);
  const coveredWeight = weighted.reduce((sum, item) => sum + item.weightPct, 0);
  if (weighted.length < definition.minimumCount) {
    throw new Error(`${definition.name} 合格沪市样本仅 ${weighted.length}/${definition.minimumCount} 条`);
  }
  if (coveredWeight < 99.5 || coveredWeight > 100.5) {
    throw new Error(`${definition.name} 沪市A股权重覆盖 ${coveredWeight.toFixed(2)}%`);
  }
  return {
    code: definition.code,
    name: definition.name,
    positive: ranking.positive,
    negative: ranking.negative,
    constituentCount: weighted.length,
    componentSource: "上海证券交易所编制规则 + 东方财富沪市全量行情",
    weightDate: tradeDate,
    methodology: "指数总市值口径下，以合格沪市A股上一时点总市值权重初算，并用指数实际涨跌点数校准总贡献",
    quality: {
      quoteCoveragePct: 100,
      weightSumPct: round(coveredWeight, 2),
      rawCalculatedChangePoints: ranking.rawCalculatedChangePoints,
      reconciliationFactor: ranking.reconciliationFactor,
      calculatedChangePoints: ranking.calculatedChangePoints,
      actualChangePoints: round(indexQuote.changePoints, 2),
      residualPoints: round((indexQuote.changePoints || 0) - (ranking.calculatedChangePoints || 0), 2),
    },
  };
}

function validatePayload(payload) {
  if (!payload || payload.source?.status !== "ok") throw new Error("指数贡献数据状态不是 ok");
  const codes = Object.keys(payload.indices || {});
  if (codes.length !== INDEX_DEFINITIONS.length) throw new Error(`指数贡献仅生成 ${codes.length}/${INDEX_DEFINITIONS.length} 个指数`);
  INDEX_DEFINITIONS.forEach((definition) => {
    const item = payload.indices[definition.code];
    if (!item || item.constituentCount < definition.minimumCount) {
      throw new Error(`${definition.name} 指数贡献不完整`);
    }
    if (!Array.isArray(item.positive) || !Array.isArray(item.negative)) {
      throw new Error(`${definition.name} 指数贡献榜结构错误`);
    }
  });
  return true;
}

function readValidPayload(outputPath) {
  try {
    if (!fs.existsSync(outputPath)) return null;
    const payload = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    validatePayload(payload);
    return payload;
  } catch (_) {
    return null;
  }
}

function writeJsonAtomic(outputPath, payload) {
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temporaryPath, outputPath);
  } catch (_) {
    fs.copyFileSync(temporaryPath, outputPath);
    fs.rmSync(temporaryPath, {force: true});
  }
}

async function buildOnlineContribution(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const indexQuotesPromise = fetchIndexQuotes(fetchImpl);
  const cnindexPromise = Promise.all(["399001", "399006"].map((code) => fetchCnindexComponents(code, fetchImpl)));
  const eastmoneyPromise = Promise.all(EASTMONEY_COMPONENT_TYPES.map((type) => fetchEastmoneyComponents(type, fetchImpl)));
  const shanghaiPromise = fetchShanghaiStocks(fetchImpl);
  const [indexQuotes, cnindexLists, eastmoneyLists, shanghaiRows] = await Promise.all([
    indexQuotesPromise,
    cnindexPromise,
    eastmoneyPromise,
    shanghaiPromise,
  ]);

  const tradeDates = [...indexQuotes.values()].map((quote) => tradeDateFromTimestamp(quote.timestamp)).filter(Boolean);
  const tradeDate = tradeDates.sort().at(-1) || chinaDateText();
  const cnindexByCode = new Map([["399001", cnindexLists[0]], ["399006", cnindexLists[1]]]);
  const eastmoneyByType = new Map(EASTMONEY_COMPONENT_TYPES.map((type, index) => [type, eastmoneyLists[index]]));
  const cnindexQuoteMap = await fetchStockQuoteMap(cnindexLists.flat().map((item) => item.code), fetchImpl);
  const indices = {};

  for (const definition of INDEX_DEFINITIONS) {
    const indexQuote = indexQuotes.get(definition.code);
    if (!indexQuote) throw new Error(`${definition.name} 实时行情缺失`);
    if (definition.source === "cnindex") {
      indices[definition.code] = buildWeightedIndex(
        definition,
        indexQuote,
        cnindexByCode.get(definition.code),
        cnindexQuoteMap,
        {
          componentSource: "国证指数官网样本权重 + 东方财富实时行情",
          methodology: definition.code === "399001"
            ? "国证官网披露前十权重，其余样本按实时自由流通市值补齐后计算"
            : "国证官网披露前十权重，其余样本按自由流通市值并施加20%上限补齐后计算",
          deriveMissingWeights: {maxSingle: definition.code === "399006" ? 20 : 100},
        },
      );
    } else if (definition.source === "eastmoney") {
      indices[definition.code] = buildWeightedIndex(
        definition,
        indexQuote,
        eastmoneyByType.get(definition.type),
        null,
        {
          componentSource: "东方财富公开成分权重与实时行情",
          methodology: "指数前收盘点位 × 公开成分权重 × 个股实时涨跌幅",
        },
      );
    } else if (definition.source === "eastmoney-cap") {
      indices[definition.code] = buildWeightedIndex(
        definition,
        indexQuote,
        eastmoneyByType.get(definition.type),
        null,
        {
          componentSource: "东方财富北证50成分与自由流通市值",
          methodology: "按北证50编制规则对自由流通市值施加单股10%、前五大40%上限后计算",
          deriveWeights: {maxSingle: 10, topGroupCount: 5, topGroupMax: 40},
        },
      );
    } else if (definition.source === "sse-composite") {
      indices[definition.code] = buildSseComposite(definition, indexQuote, shanghaiRows, tradeDate);
    }
  }

  const payload = {
    version: 2,
    tradeDate,
    fetchedAt: chinaDateTimeText(),
    source: {
      provider: "公开行情自动计算",
      providers: ["国证指数官网", "东方财富公开行情", "上海证券交易所与北京证券交易所公开编制规则"],
      screen: "在线指数成分权重与实时行情",
      status: "ok",
      message: "已自动获取公开成分权重和实时行情，无需启动通达信或其他股票软件。",
      tradeDateBasis: "公开行情时间戳（北京时间）",
      methodology: "指数前收盘点位 × 成分权重 × 个股涨跌幅，并用指数实际涨跌点数校准总贡献",
      updateMode: "服务启动后后台自动刷新，也可随市场同步手动刷新",
    },
    quality: {
      complete: true,
      requiredIndexCount: INDEX_DEFINITIONS.length,
      validIndexCount: Object.keys(indices).length,
      validation: "全部指数通过成分数量、行情覆盖率和权重合计校验后才覆盖旧数据",
    },
    indices,
  };
  validatePayload(payload);
  return payload;
}

async function refreshIndexContribution(options = {}) {
  const outputPath = path.resolve(options.outputPath || path.join(__dirname, "..", "data", "index-contribution.json"));
  const previous = readValidPayload(outputPath);
  const startedAt = Date.now();
  try {
    const payload = await buildOnlineContribution(options);
    writeJsonAtomic(outputPath, payload);
    return {
      ok: true,
      code: 0,
      message: "指数贡献已通过公开行情自动更新，无需启动股票软件。",
      outputPath,
      tradeDate: payload.tradeDate,
      fetchedAt: payload.fetchedAt,
      indexCount: Object.keys(payload.indices).length,
      elapsedMs: Date.now() - startedAt,
      preserved: false,
    };
  } catch (error) {
    return {
      ok: false,
      code: 1,
      errorCode: "INDEX_CONTRIBUTION_ONLINE_FAILED",
      message: previous
        ? `公开行情本次未通过完整性校验，已保留 ${previous.tradeDate} 的上一份完整指数贡献：${error.message}`
        : `公开行情本次未通过完整性校验：${error.message}`,
      outputPath,
      elapsedMs: Date.now() - startedAt,
      preserved: Boolean(previous),
      preservedTradeDate: previous?.tradeDate || "",
    };
  }
}

module.exports = {
  INDEX_DEFINITIONS,
  buildOnlineContribution,
  buildSseComposite,
  buildWeightedIndex,
  cappedWeights,
  eligibleSseCompositeStocks,
  fillMissingWeights,
  refreshIndexContribution,
  validatePayload,
};

if (require.main === module) {
  refreshIndexContribution({outputPath: process.argv[2]}).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
