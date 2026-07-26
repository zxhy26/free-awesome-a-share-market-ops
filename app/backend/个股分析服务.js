"use strict";

const fs = require("fs");
const path = require("path");
const {TextDecoder} = require("util");

const SEARCH_TOKEN = "D43BF722C8E33BECE2ED3B5BB7FDC1E";
const STOCK_CODE_RE = /^(000|001|002|003|300|301|600|601|603|605|688|689|430|830|831|832|833|834|835|836|837|838|839|870|871|872|873|874|875|876|877|878|879|920)\d{3}$/;
const INDEX_MIN_COUNT = 4000;
const INDEX_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const ANALYSIS_CACHE_MS = 3 * 60 * 1000;
const REQUEST_HEADERS = Object.freeze({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
  "Referer": "https://quote.eastmoney.com/",
});
const POSITIVE_EVENT_RE = /回购|增持|中标|签订.*合同|重大合同|订单|预增|扭亏|分红|获批|批准|突破|战略合作|产能投产|上调|创新高|解除质押/;
const NEGATIVE_EVENT_RE = /减持|亏损|预亏|立案|调查|处罚|警示函|诉讼|仲裁|终止|暂停|下修|退市|风险提示|违约|质押|冻结|监管措施|事故/;
const PROFILE_THEME_TERMS = Object.freeze([
  "半导体", "芯片", "集成电路", "人工智能", "算力", "通信", "软件", "网络安全", "机器人",
  "工业母机", "机械", "高端装备", "军工", "航空", "航天", "卫星", "船舶", "汽车", "零部件",
  "电池", "储能", "新能源", "光伏", "风电", "电力", "电网", "核电", "煤炭", "石油", "天然气",
  "化工", "有色", "稀土", "黄金", "钢铁", "建材", "房地产", "银行", "证券", "保险", "消费",
  "食品", "白酒", "医药", "医疗", "生物", "农业", "物流", "航运", "港口", "环保", "新材料",
]);

function nowText() {
  return new Date().toLocaleString("zh-CN", {hour12: false});
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  const number = finite(value);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .replace(/　+/g, " ")
    .trim();
}

function unique(items, keySelector = (item) => String(item)) {
  const seen = new Set();
  return (items || []).filter((item) => {
    const key = keySelector(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchBytes(url, options = {}) {
  let lastError = null;
  const attempts = Math.max(1, Number(options.attempts) || 2);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 15000);
    try {
      const response = await fetch(url, {
        cache: "no-store",
        redirect: "follow",
        headers: {...REQUEST_HEADERS, ...(options.headers || {})},
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(260 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  const detail = lastError?.name === "AbortError" ? "请求超时" : (lastError?.message || "网络请求失败");
  throw new Error(detail);
}

async function fetchUtf8(url, options = {}) {
  return (await fetchBytes(url, options)).toString("utf8");
}

async function fetchJson(url, options = {}) {
  const text = await fetchUtf8(url, options);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`接口返回格式异常：${error.message}`);
  }
}

async function fetchJsonp(url, options = {}) {
  const text = await fetchUtf8(url, options);
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  if (start < 0 || end <= start) throw new Error("接口没有返回有效 JSONP");
  try {
    return JSON.parse(text.slice(start + 1, end));
  } catch (error) {
    throw new Error(`接口返回格式异常：${error.message}`);
  }
}

async function mapLimit(items, concurrency, worker) {
  const source = Array.from(items || []);
  const output = new Array(source.length);
  let cursor = 0;
  async function run() {
    while (cursor < source.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(source[index], index);
    }
  }
  await Promise.all(Array.from({length: Math.min(Math.max(1, concurrency), source.length || 1)}, run));
  return output;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), "utf8");
  fs.rmSync(filePath, {force: true});
  fs.renameSync(temporary, filePath);
}

function marketForCode(code, market = null) {
  const supplied = Number(market);
  if (supplied === 0 || supplied === 1) return supplied;
  return /^(6|9)/.test(String(code || "")) ? 1 : 0;
}

function tencentSymbol(code) {
  const text = String(code || "");
  if (/^(430|83\d|87\d|920)/.test(text)) return `bj${text}`;
  if (/^(6|9)/.test(text)) return `sh${text}`;
  return `sz${text}`;
}

function f10Code(code) {
  const text = String(code || "");
  if (/^(430|83\d|87\d|920)/.test(text)) return `BJ${text}`;
  if (/^(6|9)/.test(text)) return `SH${text}`;
  return `SZ${text}`;
}

function normalizeSearchItem(item) {
  const code = String(item?.Code || item?.code || "").trim();
  if (!STOCK_CODE_RE.test(code)) return null;
  const quoteId = String(item?.QuoteID || item?.quoteId || "");
  const market = quoteId.includes(".") ? Number(quoteId.split(".")[0]) : marketForCode(code, item?.MktNum ?? item?.market);
  return {
    code,
    name: cleanText(item?.Name || item?.name || code),
    market: market === 1 ? 1 : 0,
    marketLabel: /^(430|83\d|87\d|920)/.test(code) ? "北交所" : market === 1 ? "上交所" : "深交所",
    pinyin: cleanText(item?.PinYin || item?.pinyin).toUpperCase(),
  };
}

function searchSuggestUrl(query) {
  return "https://searchapi.eastmoney.com/api/suggest/get" +
    `?input=${encodeURIComponent(query)}&type=14&token=${SEARCH_TOKEN}`;
}

async function fetchSearchSuggestions(query) {
  const json = await fetchJson(searchSuggestUrl(query), {timeoutMs: 10000, attempts: 3});
  const rows = Array.isArray(json?.QuotationCodeTable?.Data) ? json.QuotationCodeTable.Data : [];
  return rows
    .filter((item) => item?.Classify === "AStock" || STOCK_CODE_RE.test(String(item?.Code || "")))
    .map(normalizeSearchItem)
    .filter(Boolean);
}

function parseTencentQuotes(buffer) {
  const text = new TextDecoder("gb18030").decode(buffer);
  return text.split(/;\s*/).map((line) => {
    const match = line.match(/^v_[a-z]{2}(\d{6})="([^"]*)"/i);
    if (!match) return null;
    const fields = match[2].split("~");
    const code = String(fields[2] || match[1]);
    if (!STOCK_CODE_RE.test(code)) return null;
    const timestamp = String(fields[30] || "").replace(/\D/g, "");
    const date = timestamp.length >= 8
      ? `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`
      : "";
    return {
      code,
      name: cleanText(fields[1] || code),
      market: marketForCode(code),
      marketLabel: /^(430|83\d|87\d|920)/.test(code) ? "北交所" : /^(6|9)/.test(code) ? "上交所" : "深交所",
      price: finite(fields[3]),
      previousClose: finite(fields[4]),
      open: finite(fields[5]),
      change: finite(fields[31]),
      changePct: finite(fields[32]),
      high: finite(fields[33]),
      low: finite(fields[34]),
      volume: finite(fields[36]),
      amount: finite(fields[37]) === null ? null : round(Number(fields[37]) * 10000, 0),
      turnoverRate: finite(fields[38]),
      pe: finite(fields[39]),
      floatMarketCap: finite(fields[44]),
      totalMarketCap: finite(fields[45]),
      pb: finite(fields[46]),
      date,
      timestamp,
      source: "腾讯实时行情",
    };
  }).filter(Boolean);
}

async function fetchTencentQuoteBatch(items) {
  const symbols = items.map((item) => tencentSymbol(item.code)).join(",");
  if (!symbols) return [];
  const buffer = await fetchBytes(`http://qt.gtimg.cn/q=${symbols}`, {
    timeoutMs: 15000,
    attempts: 2,
    headers: {Referer: "https://gu.qq.com/"},
  });
  return parseTencentQuotes(buffer);
}

async function fetchTencentQuote(code) {
  const rows = await fetchTencentQuoteBatch([{code}]);
  if (!rows.length) throw new Error("实时行情接口没有返回该股票");
  return rows[0];
}

async function fetchTencentKlineBySymbol(symbol, limit = 640) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${limit},qfq`;
  const json = await fetchJson(url, {timeoutMs: 16000, attempts: 3, headers: {Referer: "https://gu.qq.com/"}});
  const payload = json?.data?.[symbol] || {};
  const rows = Array.isArray(payload.qfqday) ? payload.qfqday : Array.isArray(payload.day) ? payload.day : [];
  const history = rows.map((row) => ({
    date: String(row?.[0] || ""),
    open: finite(row?.[1]),
    close: finite(row?.[2]),
    high: finite(row?.[3]),
    low: finite(row?.[4]),
    volume: finite(row?.[5]),
  })).filter((row) => row.date && row.close !== null && row.close > 0);
  if (history.length < 35) throw new Error(`有效日线只有 ${history.length} 根`);
  return history;
}

async function fetchTencentKline(code, limit = 640) {
  return fetchTencentKlineBySymbol(tencentSymbol(code), limit);
}

function formatTencentDate(value) {
  const text = String(value || "").replace(/\D/g, "");
  return text.length >= 8 ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : "";
}

async function fetchTencentMinute(code) {
  const symbol = tencentSymbol(code);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}`;
  const json = await fetchJson(url, {timeoutMs: 14000, attempts: 3, headers: {Referer: "https://gu.qq.com/"}});
  const payload = json?.data?.[symbol]?.data || {};
  const rows = (Array.isArray(payload.data) ? payload.data : []).map((line) => {
    const fields = String(line || "").trim().split(/\s+/);
    return {
      time: fields[0] || "",
      price: finite(fields[1]),
      volume: finite(fields[2]),
      amount: finite(fields[3]),
    };
  }).filter((row) => /^\d{4}$/.test(row.time) && row.price !== null && row.price > 0);
  if (rows.length < 20) throw new Error(`有效分钟线只有 ${rows.length} 根`);
  return {
    date: formatTencentDate(payload.date),
    rows,
    source: "腾讯分钟行情",
  };
}

function mergeQuoteIntoHistory(history, quote) {
  const rows = (history || []).map((row) => ({...row}));
  if (!quote?.date || quote.price === null) return rows;
  const current = {
    date: quote.date,
    open: quote.open ?? quote.previousClose ?? quote.price,
    close: quote.price,
    high: quote.high ?? quote.price,
    low: quote.low ?? quote.price,
    volume: quote.volume,
  };
  const index = rows.findIndex((row) => row.date === quote.date);
  if (index >= 0) rows[index] = {...rows[index], ...current};
  else if (!rows.length || rows.at(-1).date < quote.date) rows.push(current);
  return rows.sort((left, right) => left.date.localeCompare(right.date)).slice(-640);
}

function smaSeries(values, period) {
  const output = new Array(values.length).fill(null);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += Number(values[index]) || 0;
    if (index >= period) sum -= Number(values[index - period]) || 0;
    if (index >= period - 1) output[index] = sum / period;
  }
  return output;
}

function emaSeries(values, period) {
  const factor = 2 / (period + 1);
  const output = [];
  values.forEach((value, index) => {
    output[index] = index === 0 ? value : value * factor + output[index - 1] * (1 - factor);
  });
  return output;
}

function macdSeries(values) {
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);
  const dif = values.map((_, index) => fast[index] - slow[index]);
  const dea = emaSeries(dif, 9);
  const histogram = dif.map((value, index) => 2 * (value - dea[index]));
  return {dif, dea, histogram};
}

function rsiSeries(values, period = 14) {
  const output = new Array(values.length).fill(null);
  if (values.length <= period) return output;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let averageGain = gain / period;
  let averageLoss = loss / period;
  output[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    output[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return output;
}

function average(values) {
  const usable = (values || []).map(Number).filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function detectMacdDivergence(rows, dif) {
  if (rows.length < 50) return "";
  const currentIndex = rows.length - 1;
  const priorStart = Math.max(0, currentIndex - 45);
  const priorEnd = Math.max(priorStart, currentIndex - 5);
  let peakIndex = priorStart;
  let troughIndex = priorStart;
  for (let index = priorStart + 1; index <= priorEnd; index += 1) {
    if (rows[index].close > rows[peakIndex].close) peakIndex = index;
    if (rows[index].close < rows[troughIndex].close) troughIndex = index;
  }
  const currentClose = rows[currentIndex].close;
  if (currentClose > rows[peakIndex].close * 1.005 && dif[currentIndex] < dif[peakIndex] * 0.96) return "价格创阶段新高，但 MACD 快线未同步创新高，存在顶背离迹象。";
  if (currentClose < rows[troughIndex].close * 0.995 && dif[currentIndex] > dif[troughIndex] * 0.96) return "价格创阶段新低，但 MACD 快线未同步创新低，存在底背离迹象。";
  return "";
}

function formatTechnicalNumber(value) {
  return finite(value) === null ? "--" : Number(value).toFixed(2);
}

function signedTechnicalNumber(value, digits = 2) {
  const number = finite(value);
  if (number === null) return "--";
  return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}`;
}

function seriesSlopePercent(series, index, lookback) {
  if (index < lookback || finite(series[index]) === null || finite(series[index - lookback]) === null || Number(series[index - lookback]) === 0) {
    return null;
  }
  return (Number(series[index]) / Number(series[index - lookback]) - 1) * 100;
}

function weeklyKey(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateText;
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
}

function aggregateWeekly(rows) {
  const groups = new Map();
  (rows || []).forEach((row) => {
    const key = weeklyKey(row.date);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        date: row.date,
        open: row.open ?? row.close,
        close: row.close,
        high: row.high ?? row.close,
        low: row.low ?? row.close,
        volume: row.volume || 0,
      });
      return;
    }
    existing.date = row.date;
    existing.close = row.close;
    existing.high = Math.max(existing.high, row.high ?? row.close);
    existing.low = Math.min(existing.low, row.low ?? row.close);
    existing.volume += row.volume || 0;
  });
  return Array.from(groups.values()).sort((left, right) => left.date.localeCompare(right.date));
}

function stochasticKdj(rows, period = 9) {
  const k = new Array(rows.length).fill(null);
  const d = new Array(rows.length).fill(null);
  const j = new Array(rows.length).fill(null);
  let previousK = 50;
  let previousD = 50;
  rows.forEach((row, index) => {
    const start = Math.max(0, index - period + 1);
    const window = rows.slice(start, index + 1);
    const lowest = Math.min(...window.map((item) => item.low ?? item.close));
    const highest = Math.max(...window.map((item) => item.high ?? item.close));
    const rsv = highest === lowest ? 50 : (row.close - lowest) / (highest - lowest) * 100;
    previousK = previousK * 2 / 3 + rsv / 3;
    previousD = previousD * 2 / 3 + previousK / 3;
    k[index] = previousK;
    d[index] = previousD;
    j[index] = 3 * previousK - 2 * previousD;
  });
  return {k, d, j};
}

function periodReturn(rows, period) {
  if (!Array.isArray(rows) || rows.length <= period) return null;
  const current = finite(rows.at(-1)?.close);
  const previous = finite(rows.at(-(period + 1))?.close);
  return current === null || previous === null || previous === 0 ? null : (current / previous - 1) * 100;
}

function relativeStrengthAnalysis(rows, benchmarkRows) {
  if (!Array.isArray(benchmarkRows) || benchmarkRows.length < 25) {
    return {
      status: "unavailable",
      label: "数据暂缺",
      tone: "watch",
      return20: null,
      return60: null,
      return120: null,
      text: "上证指数对照日线暂未取得，无法计算同期相对强弱。精确 RPS 需要全 A 横截面百分位，本页不会用单一指数近似值冒充 RPS。",
    };
  }
  const periods = [20, 60, 120];
  const excess = {};
  periods.forEach((period) => {
    const stockReturn = periodReturn(rows, period);
    const benchmarkReturn = periodReturn(benchmarkRows, period);
    excess[period] = stockReturn === null || benchmarkReturn === null ? null : stockReturn - benchmarkReturn;
  });
  let label = "相对强弱分化";
  let tone = "neutral";
  if (excess[20] !== null && excess[60] !== null && excess[20] > 0 && excess[60] > 0) {
    label = "相对大盘偏强";
    tone = "positive";
  } else if (excess[20] !== null && excess[60] !== null && excess[20] < 0 && excess[60] < 0) {
    label = "相对大盘偏弱";
    tone = "negative";
  }
  const parts = periods
    .filter((period) => excess[period] !== null)
    .map((period) => `${period}日超额${signedTechnicalNumber(excess[period])}%`);
  return {
    status: "ok",
    label,
    tone,
    return20: round(excess[20]),
    return60: round(excess[60]),
    return120: round(excess[120]),
    text: `${parts.length ? parts.join("，") : "可比区间不足"}，当前为${label}。这是相对上证指数的同期收益差，不是全 A 横截面 RPS 百分位；精确 RPS 数据暂缺。`,
  };
}

function sessionMinuteIndex(timeText) {
  const text = String(timeText || "").padStart(4, "0");
  const hour = Number(text.slice(0, 2));
  const minute = Number(text.slice(2, 4));
  const total = hour * 60 + minute;
  if (total <= 11 * 60 + 30) return Math.max(0, total - (9 * 60 + 30));
  return Math.max(120, 120 + total - 13 * 60);
}

function aggregateMinuteBars(rows, intervalMinutes) {
  const bars = [];
  (rows || []).forEach((row, index) => {
    const bucket = Math.floor(Math.max(0, sessionMinuteIndex(row.time) - (index ? 1 : 0)) / intervalMinutes);
    const previousVolume = index ? Number(rows[index - 1].volume) || 0 : 0;
    const incrementalVolume = Math.max(0, (Number(row.volume) || 0) - previousVolume);
    let bar = bars.find((item) => item.bucket === bucket);
    if (!bar) {
      bar = {
        bucket,
        time: row.time,
        open: row.price,
        close: row.price,
        high: row.price,
        low: row.price,
        volume: 0,
      };
      bars.push(bar);
    }
    bar.close = row.price;
    bar.high = Math.max(bar.high, row.price);
    bar.low = Math.min(bar.low, row.price);
    bar.volume += incrementalVolume;
  });
  return bars;
}

function intradayBarState(bars, label) {
  if (!Array.isArray(bars) || bars.length < 3) return `${label}样本不足`;
  const closes = bars.map((bar) => bar.close);
  const averagePeriod = Math.min(5, closes.length);
  const movingAverage = smaSeries(closes, averagePeriod);
  const index = bars.length - 1;
  const comparableIndex = Math.max(0, index - Math.min(2, Math.max(0, index - averagePeriod + 1)));
  const slope = comparableIndex < index && movingAverage[comparableIndex] !== null
    ? (movingAverage[index] / movingAverage[comparableIndex] - 1) * 100
    : null;
  if (movingAverage[index] !== null && closes[index] > movingAverage[index] && (slope === null || slope >= 0)) return `${label}结构偏强`;
  if (movingAverage[index] !== null && closes[index] < movingAverage[index] && (slope === null || slope <= 0)) return `${label}结构偏弱`;
  return `${label}结构震荡`;
}

function analyzeMinuteStructure(minuteData) {
  const rows = Array.isArray(minuteData?.rows) ? minuteData.rows : [];
  if (rows.length < 20) {
    return {
      status: "unavailable",
      label: "分钟数据暂缺",
      tone: "watch",
      date: minuteData?.date || "",
      text: "当日分钟线不足，30分钟、60分钟和分时均价关系暂时无法验证。",
    };
  }
  const enriched = rows.map((row) => ({
    ...row,
    vwap: row.volume > 0 && row.amount > 0 ? row.amount / (row.volume * 100) : null,
  }));
  const latest = enriched.at(-1);
  const validVwapRows = enriched.filter((row) => row.vwap !== null);
  const aboveRatio = validVwapRows.length
    ? validVwapRows.filter((row) => row.price >= row.vwap).length / validVwapRows.length * 100
    : null;
  const vwap = latest.vwap;
  const priceVsVwapPct = vwap ? (latest.price / vwap - 1) * 100 : null;
  let peak = null;
  for (let index = 1; index < rows.length; index += 1) {
    const incremental = Math.max(0, (rows[index].volume || 0) - (rows[index - 1].volume || 0));
    if (!peak || incremental > peak.volume) peak = {time: rows[index].time, volume: incremental};
  }
  const state30 = intradayBarState(aggregateMinuteBars(rows, 30), "30分钟");
  const state60 = intradayBarState(aggregateMinuteBars(rows, 60), "60分钟");
  const tone = priceVsVwapPct === null ? "neutral" : priceVsVwapPct >= 0.2 ? "positive" : priceVsVwapPct <= -0.2 ? "negative" : "neutral";
  return {
    status: "ok",
    label: tone === "positive" ? "分时偏强" : tone === "negative" ? "分时偏弱" : "分时均衡",
    tone,
    date: minuteData.date,
    vwap: round(vwap),
    priceVsVwapPct: round(priceVsVwapPct),
    aboveRatio: round(aboveRatio),
    peakTime: peak?.time || "",
    state30,
    state60,
    text: `${state60}，${state30}；最新价相对当日分时均价${priceVsVwapPct === null ? "暂无可比值" : `${signedTechnicalNumber(priceVsVwapPct)}%`}，约${aboveRatio === null ? "--" : aboveRatio.toFixed(0)}%的有效分钟价格位于均价线上方${peak?.time ? `，分钟增量成交峰值出现在${peak.time}` : ""}。分钟结构只用于时点确认，不改变大周期方向。`,
  };
}

function pricePositionAnalysis(rows) {
  const window = rows.slice(-Math.min(250, rows.length));
  const lowest = Math.min(...window.map((row) => row.low ?? row.close));
  const highest = Math.max(...window.map((row) => row.high ?? row.close));
  const current = rows.at(-1).close;
  const percentile = highest === lowest ? 50 : (current - lowest) / (highest - lowest) * 100;
  const label = percentile <= 30 ? "低位区" : percentile >= 75 ? "高位区" : "中位区";
  return {
    label,
    percentile: round(percentile),
    lowest: round(lowest),
    highest: round(highest),
    sampleCount: window.length,
  };
}

function latestUnfilledGap(rows) {
  const start = Math.max(1, rows.length - 80);
  for (let index = rows.length - 1; index >= start; index -= 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if ((current.low ?? current.close) > (previous.high ?? previous.close)) {
      const floor = previous.high ?? previous.close;
      const ceiling = current.low ?? current.close;
      const filled = rows.slice(index + 1).some((row) => (row.low ?? row.close) <= floor);
      if (!filled) return {direction: "向上", date: current.date, floor: round(floor), ceiling: round(ceiling)};
    }
    if ((current.high ?? current.close) < (previous.low ?? previous.close)) {
      const floor = current.high ?? current.close;
      const ceiling = previous.low ?? previous.close;
      const filled = rows.slice(index + 1).some((row) => (row.high ?? row.close) >= ceiling);
      if (!filled) return {direction: "向下", date: current.date, floor: round(floor), ceiling: round(ceiling)};
    }
  }
  return null;
}

function keyLevelAnalysis(rows, currentClose, movingAverages) {
  const prior20 = rows.slice(-21, -1);
  const prior60 = rows.slice(-61, -1);
  const low20 = prior20.length ? Math.min(...prior20.map((row) => row.low ?? row.close)) : null;
  const low60 = prior60.length ? Math.min(...prior60.map((row) => row.low ?? row.close)) : null;
  const high20 = prior20.length ? Math.max(...prior20.map((row) => row.high ?? row.close)) : null;
  const high60 = prior60.length ? Math.max(...prior60.map((row) => row.high ?? row.close)) : null;
  const supportCandidates = [low20, low60, movingAverages.ma20, movingAverages.ma60]
    .map(finite)
    .filter((value) => value !== null && value <= currentClose * 1.02)
    .sort((left, right) => right - left);
  const support = supportCandidates[0] ?? finite(low20);
  const resistanceCandidates = [high20, high60]
    .map(finite)
    .filter((value) => value !== null && value > currentClose * 1.005)
    .sort((left, right) => left - right);
  const firstResistance = resistanceCandidates[0] ?? null;
  const secondResistance = resistanceCandidates.find((value) => firstResistance === null || value > firstResistance * 1.01) ?? null;
  const invalidation = support === null ? null : support * 0.97;
  const riskReward = firstResistance !== null && invalidation !== null && currentClose > invalidation
    ? (firstResistance - currentClose) / (currentClose - invalidation)
    : null;
  return {
    low20: round(low20),
    low60: round(low60),
    high20: round(high20),
    high60: round(high60),
    support: round(support),
    observationLow: round(support === null ? null : support * 0.99),
    observationHigh: round(support === null ? null : support * 1.01),
    invalidation: round(invalidation),
    firstResistance: round(firstResistance),
    secondResistance: round(secondResistance),
    riskReward: round(riskReward),
  };
}

function technicalLevelText(value) {
  return finite(value) === null ? "区间内暂无明确位置" : Number(value).toFixed(2);
}

function analyzeTechnical(history, context = {}) {
  const rows = history.filter((row) => row.close !== null && row.close > 0);
  if (rows.length < 35) return {status: "error", message: "日线样本不足，暂时无法形成技术面解析。"};
  const closes = rows.map((row) => row.close);
  const volumes = rows.map((row) => row.volume || 0);
  const ma5 = smaSeries(closes, 5);
  const ma10 = smaSeries(closes, 10);
  const ma20 = smaSeries(closes, 20);
  const ma60 = smaSeries(closes, 60);
  const ma120 = smaSeries(closes, 120);
  const ma250 = smaSeries(closes, 250);
  const macd = macdSeries(closes);
  const rsi = rsiSeries(closes, 14);
  const kdj = stochasticKdj(rows);
  const index = rows.length - 1;
  const previous = rows[index - 1];
  const current = rows[index];
  const currentChange = previous?.close ? (current.close / previous.close - 1) * 100 : null;
  const volumeBaseline = average(volumes.slice(Math.max(0, index - 5), index));
  const volumeRatio = volumeBaseline ? current.volume / volumeBaseline : null;
  const volumeMa5 = average(volumes.slice(-5));
  const volumeMa60 = average(volumes.slice(-60));
  const ma20Slope = seriesSlopePercent(ma20, index, 5);
  const ma60Slope = seriesSlopePercent(ma60, index, 10);
  const ma120Slope = seriesSlopePercent(ma120, index, 20);
  const ma250Slope = seriesSlopePercent(ma250, index, 20);
  const goldenCross = macd.dif[index] > macd.dea[index] && macd.dif[index - 1] <= macd.dea[index - 1];
  const deathCross = macd.dif[index] < macd.dea[index] && macd.dif[index - 1] >= macd.dea[index - 1];
  const divergence = detectMacdDivergence(rows, macd.dif);
  const position = pricePositionAnalysis(rows);
  const gap = latestUnfilledGap(rows);
  const levels = keyLevelAnalysis(rows, current.close, {
    ma20: ma20[index],
    ma60: ma60[index],
  });
  const benchmark = relativeStrengthAnalysis(rows, context.benchmarkHistory);
  const minute = analyzeMinuteStructure(context.minuteData);

  const weeklyRows = aggregateWeekly(rows);
  const weeklyCloses = weeklyRows.map((row) => row.close);
  const weeklyMa20 = smaSeries(weeklyCloses, 20);
  const weeklyMa60 = smaSeries(weeklyCloses, 60);
  const weeklyIndex = weeklyRows.length - 1;
  const weeklyMa20Slope = seriesSlopePercent(weeklyMa20, weeklyIndex, 4);
  const longBull = ma250[index] !== null && current.close >= ma250[index] && (ma250Slope === null || ma250Slope >= 0);
  const longBear = ma250[index] !== null && current.close < ma250[index] && ma250Slope !== null && ma250Slope < 0;
  const weeklyBull = weeklyMa20[weeklyIndex] !== null && weeklyMa60[weeklyIndex] !== null &&
    weeklyMa20[weeklyIndex] > weeklyMa60[weeklyIndex] && (weeklyMa20Slope === null || weeklyMa20Slope >= 0);
  const weeklyBear = weeklyMa20[weeklyIndex] !== null && weeklyMa60[weeklyIndex] !== null &&
    weeklyMa20[weeklyIndex] < weeklyMa60[weeklyIndex] && weeklyMa20Slope !== null && weeklyMa20Slope < 0;
  const dailyBull = ma5[index] !== null && ma10[index] !== null && ma20[index] !== null && ma60[index] !== null &&
    ma5[index] > ma10[index] && ma10[index] > ma20[index] && ma20[index] > ma60[index] && (ma20Slope === null || ma20Slope >= 0);
  const dailyBear = ma5[index] !== null && ma10[index] !== null && ma20[index] !== null && ma60[index] !== null &&
    ma5[index] < ma10[index] && ma10[index] < ma20[index] && ma20[index] < ma60[index] && ma20Slope !== null && ma20Slope < 0;
  const regime = dailyBull || dailyBear ? "趋势" : "震荡";

  const prior20High = levels.high20;
  const breakout = prior20High !== null && current.close > prior20High;
  const breakoutConfirmed = breakout && volumeRatio !== null && volumeRatio >= 1.3;
  const breakoutWeak = breakout && volumeRatio !== null && volumeRatio < 1.3;
  const shrinkPullback = currentChange !== null && currentChange < 0 && volumeRatio !== null && volumeRatio <= 0.8;
  const highVolumeStall = position.percentile >= 75 && volumeRatio !== null && volumeRatio >= 1.5 && Math.abs(currentChange || 0) <= 1;
  const heavyDown = currentChange !== null && currentChange < -1 && volumeRatio !== null && volumeRatio >= 1.5;
  const turnoverRate = finite(context.quote?.turnoverRate);
  const floatMarketCap = finite(context.quote?.floatMarketCap);
  const activeTurnoverThreshold = floatMarketCap !== null && floatMarketCap >= 200 ? 3 : 10;
  const turnoverActive = turnoverRate !== null && turnoverRate >= activeTurnoverThreshold;
  const highTurnoverRisk = turnoverRate !== null && turnoverRate > 20 && position.percentile >= 75;
  const volumeStructurePositive = breakoutConfirmed ||
    (currentChange !== null && currentChange > 0 && volumeRatio !== null && volumeRatio >= 1.2) ||
    shrinkPullback;
  const volumeStructureNegative = heavyDown || highVolumeStall || highTurnoverRisk || breakoutWeak;

  let score = 0;
  if (longBull) score += 2;
  else if (longBear) score -= 2;
  if (weeklyBull) score += 2;
  else if (weeklyBear) score -= 2;
  if (dailyBull) score += 2;
  else if (dailyBear) score -= 2;
  if (volumeStructurePositive) score += 2;
  else if (volumeStructureNegative) score -= 2;
  if (macd.dif[index] > 0 && macd.histogram[index] > 0) score += 1;
  else if (macd.dif[index] < 0 && macd.histogram[index] < 0) score -= 1;
  if (benchmark.tone === "positive") score += 1;
  else if (benchmark.tone === "negative") score -= 1;
  if (context.sectorState?.tone === "positive") score += 0.5;
  else if (context.sectorState?.tone === "negative") score -= 0.5;
  if (highVolumeStall || highTurnoverRisk) score -= 1;
  if (/顶背离/.test(divergence)) score -= 1.5;
  if (/底背离/.test(divergence)) score += 1;
  if (regime === "震荡" && rsi[index] !== null) {
    if (rsi[index] < 20) score += 0.5;
    else if (rsi[index] > 80) score -= 0.5;
  }
  score = round(score, 1);

  const stance = score >= 5 ? "偏强" : score <= -4 ? "偏弱" : "震荡";
  const tone = stance === "偏强" ? "positive" : stance === "偏弱" ? "negative" : "watch";
  const longTone = longBull ? "positive" : longBear ? "negative" : "neutral";
  const weeklyTone = weeklyBull ? "positive" : weeklyBear ? "negative" : "neutral";
  const dailyTone = dailyBull ? "positive" : dailyBear ? "negative" : "neutral";
  const longText = ma250[index] === null
    ? `现有${rows.length}根日线不足以形成MA250年线，长期方向暂不下结论；MA120为${formatTechnicalNumber(ma120[index])}。`
    : `收盘价${current.close >= ma250[index] ? "位于" : "低于"}MA250年线，MA250为${formatTechnicalNumber(ma250[index])}、近20日${ma250Slope === null ? "方向暂不明确" : `${ma250Slope >= 0 ? "上行" : "下行"}${Math.abs(ma250Slope).toFixed(2)}%`}；MA120为${formatTechnicalNumber(ma120[index])}、近20日${ma120Slope === null ? "方向暂不明确" : `${ma120Slope >= 0 ? "上行" : "下行"}${Math.abs(ma120Slope).toFixed(2)}%`}。${longBear ? "长期结构仍按弱势反弹框架观察。" : longBull ? "长期趋势基础保持向上。" : "长期方向处于过渡状态。"}`;
  const weeklyText = weeklyMa60[weeklyIndex] === null
    ? `现有${weeklyRows.length}根周线，MA60周线样本不足；MA20周线为${formatTechnicalNumber(weeklyMa20[weeklyIndex])}。`
    : `周线MA20为${formatTechnicalNumber(weeklyMa20[weeklyIndex])}，MA60为${formatTechnicalNumber(weeklyMa60[weeklyIndex])}，MA20近4周${weeklyMa20Slope === null ? "方向暂不明确" : `${weeklyMa20Slope >= 0 ? "上行" : "下行"}${Math.abs(weeklyMa20Slope).toFixed(2)}%`}，周线结构${weeklyBull ? "偏多" : weeklyBear ? "偏空" : "尚未形成单边排列"}。`;
  const dailyText = `日线MA5、MA10、MA20、MA60依次为${formatTechnicalNumber(ma5[index])}、${formatTechnicalNumber(ma10[index])}、${formatTechnicalNumber(ma20[index])}、${formatTechnicalNumber(ma60[index])}；当前${dailyBull ? "形成多头排列" : dailyBear ? "形成空头排列" : "均线交错"}，MA20近5日${ma20Slope === null ? "方向暂不明确" : `${ma20Slope >= 0 ? "上行" : "下行"}${Math.abs(ma20Slope).toFixed(2)}%`}。`;

  const histogramDirection = macd.histogram[index] >= 0
    ? macd.histogram[index] >= macd.histogram[index - 1] ? "红柱扩张" : "红柱收敛"
    : Math.abs(macd.histogram[index]) >= Math.abs(macd.histogram[index - 1]) ? "绿柱扩张" : "绿柱收敛";
  const macdText = `${goldenCross ? "MACD当日形成金叉" : deathCross ? "MACD当日形成死叉" : macd.dif[index] >= macd.dea[index] ? "MACD快线位于慢线上方" : "MACD快线位于慢线下方"}，DIF位于${macd.dif[index] >= 0 ? "零轴上方" : "零轴下方"}，当前${histogramDirection}；DIF ${formatTechnicalNumber(macd.dif[index])}，DEA ${formatTechnicalNumber(macd.dea[index])}，柱体 ${formatTechnicalNumber(macd.histogram[index])}。${divergence || "当前未识别到明确的日线级 MACD 价格背离。"}`;
  const oscillatorText = regime === "趋势"
    ? `当前属于趋势结构，RSI14 ${formatTechnicalNumber(rsi[index])}、KDJ的K/D/J为${formatTechnicalNumber(kdj.k[index])}/${formatTechnicalNumber(kdj.d[index])}/${formatTechnicalNumber(kdj.j[index])}，仅作状态记录，不用于逆势判断。`
    : `当前属于震荡结构，RSI14为${formatTechnicalNumber(rsi[index])}，KDJ的K/D/J为${formatTechnicalNumber(kdj.k[index])}/${formatTechnicalNumber(kdj.d[index])}/${formatTechnicalNumber(kdj.j[index])}；低于20视为超卖区，高于80视为超买区，仍需量价确认。`;
  const volumeText = volumeRatio === null
    ? "成交量基准不足。"
    : `最新成交量为前5日均量的${volumeRatio.toFixed(2)}倍，5日均量相对60日均量${volumeMa60 ? `${(volumeMa5 / volumeMa60).toFixed(2)}倍` : "暂无可比值"}；当日${currentChange >= 0 ? "上涨" : "下跌"}${Math.abs(currentChange || 0).toFixed(2)}%。${breakoutConfirmed ? "价格突破近20日上沿且量能超过此前5日均量30%，突破得到量价确认。" : breakoutWeak ? "价格越过近20日上沿但量能不足30%，需要防范弱突破。" : shrinkPullback ? "回落过程中成交缩量，属于相对健康的回踩特征。" : heavyDown ? "放量下跌，量价结构偏弱。" : highVolumeStall ? "高位明显放量但价格停滞，存在筹码松动风险。" : "量价关系处于常态，尚无明确突破或破位确认。"}${turnoverRate === null ? "换手率数据暂缺。" : `换手率${turnoverRate.toFixed(2)}%，按流通市值${floatMarketCap !== null && floatMarketCap >= 200 ? "较大" : "较小"}口径，活跃参考线为${activeTurnoverThreshold}%；当前${turnoverActive ? "达到" : "未达到"}活跃参考线${highTurnoverRisk ? "，且高位换手超过20%，风险上升" : ""}。`}`;
  const gapText = gap
    ? `最近仍未回补的${gap.direction}缺口形成于${gap.date}，区间${gap.floor.toFixed(2)}至${gap.ceiling.toFixed(2)}。`
    : "最近80个交易日未识别到仍未回补的日线缺口。";
  const locationText = `价格处于近${position.sampleCount}日区间的${position.label}，位置约${position.percentile.toFixed(1)}%，区间低点${position.lowest.toFixed(2)}、高点${position.highest.toFixed(2)}。近20日结构观察位${technicalLevelText(levels.support)}，第一压力位${technicalLevelText(levels.firstResistance)}。${gapText}`;
  const sectorText = context.sectorState?.status === "ok"
    ? `所属行业“${context.sectorState.name}”在${context.sectorState.tradeDate || "最近交易日"}的资金净额为${signedTechnicalNumber(context.sectorState.amount)}亿元${context.sectorState.changePct === null ? "" : `、涨跌幅${signedTechnicalNumber(context.sectorState.changePct)}%`}，仅作板块联动验证。精确筹码分布、北向席位、龙虎榜、两融明细和盘口委托数据暂缺，不参与结论。`
    : `${String(context.sectorState?.detail || "所属行业资金暂未匹配到该行业").replace(/[。；]+$/, "")}。精确筹码分布、北向席位、龙虎榜、两融明细和盘口委托数据暂缺，不参与结论。`;

  const risks = [];
  if (longBear) risks.push("价格位于下行年线下方，长期结构仍偏弱。");
  if (weeklyBear) risks.push("周线MA20低于MA60且继续下行，中周期压力仍在。");
  if (ma60[index] !== null && current.close < ma60[index]) risks.push("收盘价低于MA60，多空分界尚未收复。");
  if (heavyDown) risks.push("放量下跌，卖盘释放明显高于近5日常态。");
  if (highVolumeStall) risks.push("高位放量但价格停滞，存在筹码松动迹象。");
  if (highTurnoverRisk) risks.push("高位换手率超过20%，短线波动和筹码交换风险上升。");
  if (breakoutWeak) risks.push("突破近20日上沿但放量不足30%，突破有效性需要继续验证。");
  if (/顶背离/.test(divergence)) risks.push(divergence);
  if (!risks.length) risks.push("当前未触发明显的长周期转弱、放量下跌、高位滞涨或顶背离风险项。");

  const cycleEvidence = `长周期${longBull ? "偏多" : longBear ? "偏空" : "过渡"}，周线${weeklyBull ? "偏多" : weeklyBear ? "偏空" : "震荡"}，日线${dailyBull ? "多头排列" : dailyBear ? "空头排列" : "均线交错"}`;
  const volumeEvidence = volumeRatio === null
    ? "量价样本不足"
    : `量比${volumeRatio.toFixed(2)}倍，${volumeStructurePositive ? "量价验证偏正面" : volumeStructureNegative ? "量价验证偏负面" : "量价尚未给出明确确认"}`;
  const relativeEvidence = benchmark.status === "ok" ? benchmark.label : "相对大盘强度数据暂缺";
  const activeRisks = risks.filter((item) => !item.startsWith("当前未触发明显"));
  const mainRisk = activeRisks[0] || "当前没有触发文档列出的主要风险条件，但仍需跟踪关键均线和量价变化。";
  const judgement = {
    label: stance,
    tone,
    score,
    text: `按“大周期定方向、小周期找时点、量价优先、指标确认”的顺序，当前技术面为${stance}。${cycleEvidence}；${volumeEvidence}；${relativeEvidence}。该判断只描述公开行情形成的技术结构，不构成收益承诺或交易指令。`,
    evidence: [cycleEvidence, volumeEvidence, relativeEvidence],
  };

  const observationText = levels.observationLow === null
    ? "暂无可靠区间"
    : `${levels.observationLow.toFixed(2)} - ${levels.observationHigh.toFixed(2)}`;
  const riskRewardText = levels.riskReward === null
    ? "缺少明确上方压力，暂不计算"
    : `约1:${Math.max(0, levels.riskReward).toFixed(2)}，${levels.riskReward >= 2 ? "达到1:2结构参考线" : "低于1:2结构参考线"}`;
  const keyLevelsText = `结构关注区${observationText}，结构失效位${technicalLevelText(levels.invalidation)}，第一压力位${technicalLevelText(levels.firstResistance)}，第二压力位${technicalLevelText(levels.secondResistance)}。`;
  const finalSummary = {
    label: stance,
    tone,
    score,
    text: `综合${rows.length}根前复权日线、${weeklyRows.length}根周线${minute.status === "ok" ? "及当日分钟线" : ""}，当前技术结构为${stance}。主要依据是${cycleEvidence}，同时${volumeEvidence}，${relativeEvidence}。主要风险：${mainRisk.replace(/[。；]+$/, "")}。后续重点观察MA20、MA60与量能是否相互确认。`,
    evidence: [
      `核心证据：${cycleEvidence}；${volumeEvidence}；${relativeEvidence}。`,
      `主要风险：${mainRisk}`,
      `关键位置：${keyLevelsText}`,
    ],
    mainRisk,
    keyLevels: keyLevelsText,
  };

  const chartRows = rows.slice(-90);
  const chartOffset = rows.length - chartRows.length;
  return {
    status: "ok",
    stance,
    tone,
    score,
    dataDate: current.date,
    summary: `基于${rows.length}根前复权日线，先判断长周期与周线，再由日线、量价和分钟结构确认，当前结论为${stance}。`,
    judgement,
    metrics: [
      {label: "最新收盘", value: round(current.close), detail: current.date, tone: currentChange >= 0 ? "positive" : "negative"},
      {label: "日涨跌幅", value: round(currentChange), suffix: "%", detail: "相对前一交易日", tone: currentChange >= 0 ? "positive" : "negative"},
      {label: "MA250", value: round(ma250[index]), detail: longBull ? "长周期偏多" : longBear ? "长周期偏空" : "长周期过渡", tone: longTone},
      {label: "周线MA20", value: round(weeklyMa20[weeklyIndex]), detail: weeklyBull ? "周线偏多" : weeklyBear ? "周线偏空" : "周线震荡", tone: weeklyTone},
      {label: "量比", value: round(volumeRatio), suffix: "倍", detail: "相对此前5日均量", tone: volumeStructurePositive ? "positive" : volumeStructureNegative ? "negative" : "neutral"},
      {label: "相对大盘20日", value: benchmark.return20, suffix: "%", detail: benchmark.status === "ok" ? "同期收益差，非RPS" : "数据暂缺", tone: benchmark.tone},
    ],
    cycleAnalysis: [
      {title: "长周期", label: longBull ? "偏多" : longBear ? "偏空" : "过渡", tone: longTone, text: longText},
      {title: "周线", label: weeklyBull ? "偏多" : weeklyBear ? "偏空" : "震荡", tone: weeklyTone, text: weeklyText},
      {title: "日线", label: dailyBull ? "多头排列" : dailyBear ? "空头排列" : "均线交错", tone: dailyTone, text: dailyText},
      {title: "60/30分钟", label: minute.label, tone: minute.tone, text: minute.text},
    ],
    sections: [
      {title: "趋势与位置", tone: position.label === "高位区" ? "watch" : dailyTone, text: `${dailyText}${locationText}`},
      {title: "量价验证", tone: volumeStructurePositive ? "positive" : volumeStructureNegative ? "negative" : "neutral", text: volumeText},
      {title: "MACD动能", tone: macd.histogram[index] >= 0 ? "positive" : "negative", text: macdText},
      {title: "相对大盘强度", tone: benchmark.tone, text: benchmark.text},
      {title: "震荡指标", tone: regime === "震荡" ? "watch" : "neutral", text: oscillatorText},
      {title: "板块、筹码与资金", tone: context.sectorState?.tone || "watch", text: sectorText},
    ],
    tradePlan: {
      title: "关键位置与风险收益",
      note: "以下位置来自均线与近20/60日高低点，只用于结构复盘；若缺少明确压力位，不强行生成价格。",
      items: [
        {label: "结构关注区", value: observationText, detail: "由最近支撑与MA20/MA60择近计算"},
        {label: "结构失效位", value: technicalLevelText(levels.invalidation), detail: "跌破后原有支撑假设不再成立"},
        {label: "第一压力位", value: technicalLevelText(levels.firstResistance), detail: "取近20/60日实际上沿"},
        {label: "第二压力位", value: technicalLevelText(levels.secondResistance), detail: "仅在历史区间存在时显示"},
        {label: "风险收益参考", value: riskRewardText, detail: "以最新价、失效位和第一压力位估算"},
      ],
    },
    dataCoverage: [
      {label: "前复权日线", status: rows.length >= 250 ? "完整" : "部分", tone: rows.length >= 250 ? "positive" : "watch", detail: `${rows.length}根，${rows.length >= 250 ? "可计算年线" : "年线样本不足"}`},
      {label: "周线推导", status: weeklyRows.length >= 60 ? "完整" : "部分", tone: weeklyRows.length >= 60 ? "positive" : "watch", detail: `${weeklyRows.length}根，来自日线聚合`},
      {label: "当日分钟线", status: minute.status === "ok" ? "完整" : "暂缺", tone: minute.status === "ok" ? "positive" : "watch", detail: minute.status === "ok" ? `${minute.date}，含分时均价及30/60分钟结构` : minute.text},
      {label: "换手率", status: turnoverRate === null ? "暂缺" : "完整", tone: turnoverRate === null ? "watch" : "positive", detail: turnoverRate === null ? "实时行情未返回" : `${turnoverRate.toFixed(2)}%`},
      {label: "行业资金联动", status: context.sectorState?.status === "ok" ? "已匹配" : "暂缺", tone: context.sectorState?.status === "ok" ? context.sectorState.tone : "watch", detail: context.sectorState?.status === "ok" ? `${context.sectorState.name}，${context.sectorState.tradeDate}` : context.sectorState?.detail || "当前行业资金榜未覆盖"},
      {label: "精确RPS百分位", status: "暂缺", tone: "watch", detail: "需全A同周期横截面，本页只显示相对上证收益差"},
      {label: "筹码与机构明细", status: "暂缺", tone: "watch", detail: "筹码分布、北向席位、龙虎榜、两融与盘口委托未取得可靠公开数据"},
    ],
    risks,
    finalSummary,
    methodology: "分析顺序：长周期与周线定方向，日线和量价验真，MACD与震荡指标确认，分钟线只负责时点；缺失维度明确标注，不参与评分。",
    chart: chartRows.map((row, chartIndex) => {
      const sourceIndex = chartOffset + chartIndex;
      return {
        date: row.date,
        close: round(row.close),
        ma5: round(ma5[sourceIndex]),
        ma20: round(ma20[sourceIndex]),
      };
    }),
  };
}

function eventTone(text) {
  const value = cleanText(text);
  const positive = POSITIVE_EVENT_RE.test(value);
  const negative = NEGATIVE_EVENT_RE.test(value);
  if (positive && negative) return "mixed";
  if (negative) return "negative";
  if (positive) return "positive";
  return "neutral";
}

function normalizeFundamentalRow(row) {
  const reportDate = String(row?.REPORT_DATE || "").slice(0, 10);
  if (!reportDate) return null;
  return {
    reportName: cleanText(row?.REPORT_DATE_NAME) || reportDate,
    reportDate,
    noticeDate: String(row?.NOTICE_DATE || "").slice(0, 10),
    revenue: finite(row?.TOTALOPERATEREVE),
    revenueYoY: finite(row?.TOTALOPERATEREVETZ),
    netProfit: finite(row?.PARENTNETPROFIT),
    netProfitYoY: finite(row?.PARENTNETPROFITTZ),
    deductedProfit: finite(row?.KCFJCXSYJLR),
    deductedProfitYoY: finite(row?.KCFJCXSYJLRTZ),
    roe: finite(row?.ROEJQ),
    roic: finite(row?.ROIC),
    grossMargin: finite(row?.XSMLL),
    netMargin: finite(row?.XSJLL),
    debtRatio: finite(row?.ZCFZL),
    currentRatio: finite(row?.LD),
    quickRatio: finite(row?.SD),
    cashFlowPerShare: finite(row?.MGJYXJJE),
    cashToProfit: finite(row?.NCO_NETPROFIT),
    eps: finite(row?.EPSJB),
    bookValuePerShare: finite(row?.BPS),
    capitalAdequacy: finite(row?.NEWCAPITALADER),
    nonPerformingLoanRatio: finite(row?.NONPERLOAN),
    solvencyRatio: finite(row?.SOLVENCY_AR),
  };
}

async function fetchFundamentalData(code) {
  const url = "https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew" +
    `?type=0&code=${encodeURIComponent(f10Code(code))}`;
  const json = await fetchJson(url, {timeoutMs: 14000, attempts: 3});
  const rows = (Array.isArray(json?.data) ? json.data : [])
    .map(normalizeFundamentalRow)
    .filter(Boolean)
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate));
  if (!rows.length) throw new Error("F10财务接口没有返回有效报告期");
  return rows;
}

function fundamentalTone(value, positiveThreshold = 0, negativeThreshold = 0) {
  const number = finite(value);
  if (number === null) return "watch";
  if (number >= positiveThreshold) return "positive";
  if (number <= negativeThreshold) return "negative";
  return "neutral";
}

function formatFundamentalValue(value, suffix = "", digits = 2) {
  const number = finite(value);
  return number === null ? "暂缺" : `${round(number, digits)}${suffix}`;
}

function analyzeFundamental(rows, quote = {}, profile = {}) {
  const history = (rows || []).filter(Boolean).slice(0, 9);
  if (!history.length) {
    return {
      status: "error",
      tone: "watch",
      label: "信息不足",
      message: "暂未取得有效财务报告。",
      judgement: {
        label: "信息不足",
        tone: "watch",
        text: "暂未取得有效财务报告，页面不会使用估算值补足。",
        evidence: [],
      },
      metrics: [],
      sections: [],
      history: [],
      methodology: "基本面只使用公开财务报告与实时估值字段，缺失项不参与判断。",
    };
  }

  const latest = history[0];
  const industry = cleanText(profile?.industry);
  const financialIndustry = /银行|保险|证券|多元金融|信托/iu.test(industry);
  let score = 0;
  const evidence = [];
  const addGrowthScore = (value, label, strong = 20, weak = 5) => {
    const number = finite(value);
    if (number === null) return;
    if (number >= strong) {
      score += 2;
      evidence.push(`${label}同比增长${round(number)}%，增长较快。`);
    } else if (number >= weak) {
      score += 1;
      evidence.push(`${label}同比增长${round(number)}%，保持增长。`);
    } else if (number <= -10) {
      score -= 2;
      evidence.push(`${label}同比下降${round(Math.abs(number))}%，经营承压。`);
    } else if (number < 0) {
      score -= 1;
      evidence.push(`${label}同比下降${round(Math.abs(number))}%。`);
    }
  };
  addGrowthScore(latest.revenueYoY, "营业收入");
  addGrowthScore(latest.netProfitYoY, "归母净利润");
  addGrowthScore(latest.deductedProfitYoY, "扣非净利润", 18, 3);

  const reportMonth = Number(latest.reportDate.slice(5, 7)) || 12;
  const roeBase = Math.max(3, 12 * reportMonth / 12);
  if (latest.roe !== null) {
    if (latest.roe >= roeBase * 1.25) {
      score += 2;
      evidence.push(`报告期加权ROE为${round(latest.roe)}%，盈利效率较强。`);
    } else if (latest.roe >= roeBase * 0.75) {
      score += 1;
    } else if (latest.roe < 0) {
      score -= 2;
      evidence.push(`报告期加权ROE为负，盈利质量需要重点核对。`);
    } else if (latest.roe < roeBase * 0.35) {
      score -= 1;
    }
  }
  if (latest.cashToProfit !== null) {
    if (latest.cashToProfit >= 1) {
      score += 2;
      evidence.push(`经营现金流与净利润比值为${round(latest.cashToProfit)}，利润现金含量较好。`);
    } else if (latest.cashToProfit >= 0.7) {
      score += 1;
    } else if (latest.cashToProfit < 0) {
      score -= 2;
      evidence.push("经营现金流为负，利润与现金流方向不一致。");
    } else if (latest.cashToProfit < 0.5) {
      score -= 1;
      evidence.push(`经营现金流与净利润比值仅${round(latest.cashToProfit)}，现金转化偏弱。`);
    }
  }
  if (!financialIndustry && latest.debtRatio !== null) {
    if (latest.debtRatio > 85) {
      score -= 2;
      evidence.push(`资产负债率为${round(latest.debtRatio)}%，偿债压力偏高。`);
    } else if (latest.debtRatio > 75) {
      score -= 1;
    } else if (latest.debtRatio < 55) {
      score += 1;
    }
    if (latest.currentRatio !== null && latest.currentRatio < 0.8) score -= 1;
  }
  if (quote?.pe !== null && quote?.pe !== undefined && Number(quote.pe) <= 0) {
    evidence.push("当前市盈率为负，估值倍数不能按常规盈利口径解释。");
  }

  let label = "中性观察";
  let tone = "neutral";
  if (score >= 6) {
    label = "基本面偏强";
    tone = "positive";
  } else if (score >= 2) {
    label = "经营稳健";
    tone = "positive";
  } else if (score <= -5) {
    label = "基本面风险偏高";
    tone = "negative";
  } else if (score <= -2) {
    label = "经营承压";
    tone = "negative";
  }

  const latestName = latest.reportName || latest.reportDate;
  const growthSummary = [
    latest.revenueYoY === null ? "" : `营收同比${latest.revenueYoY >= 0 ? "增长" : "下降"}${round(Math.abs(latest.revenueYoY))}%`,
    latest.netProfitYoY === null ? "" : `归母净利润同比${latest.netProfitYoY >= 0 ? "增长" : "下降"}${round(Math.abs(latest.netProfitYoY))}%`,
    latest.deductedProfitYoY === null ? "" : `扣非净利润同比${latest.deductedProfitYoY >= 0 ? "增长" : "下降"}${round(Math.abs(latest.deductedProfitYoY))}%`,
  ].filter(Boolean).join("，") || "营收与利润同比数据暂缺";
  const profitabilitySummary = [
    `ROE ${formatFundamentalValue(latest.roe, "%")}`,
    `毛利率 ${formatFundamentalValue(latest.grossMargin, "%")}`,
    `净利率 ${formatFundamentalValue(latest.netMargin, "%")}`,
    `ROIC ${formatFundamentalValue(latest.roic, "%")}`,
  ].join("，");
  const solvencySummary = financialIndustry
    ? [
      latest.capitalAdequacy === null ? "" : `资本充足率 ${formatFundamentalValue(latest.capitalAdequacy, "%")}`,
      latest.nonPerformingLoanRatio === null ? "" : `不良贷款率 ${formatFundamentalValue(latest.nonPerformingLoanRatio, "%")}`,
      latest.solvencyRatio === null ? "" : `偿付能力充足率 ${formatFundamentalValue(latest.solvencyRatio, "%")}`,
      `经营现金含量 ${formatFundamentalValue(latest.cashToProfit, "倍")}`,
    ].filter(Boolean).join("，") || "金融行业专用资本与资产质量指标暂缺"
    : `经营现金含量 ${formatFundamentalValue(latest.cashToProfit, "倍")}，每股经营现金流 ${formatFundamentalValue(latest.cashFlowPerShare, "元")}，资产负债率 ${formatFundamentalValue(latest.debtRatio, "%")}，流动比率 ${formatFundamentalValue(latest.currentRatio, "倍")}`;
  const valuationSummary = `市盈率 ${formatFundamentalValue(quote?.pe, "倍")}，市净率 ${formatFundamentalValue(quote?.pb, "倍")}，每股收益 ${formatFundamentalValue(latest.eps, "元")}，每股净资产 ${formatFundamentalValue(latest.bookValuePerShare, "元")}。估值仅展示当前倍数，未取得可靠行业横截面对照时不判断高低。`;
  const judgementText = `${latestName}公开财务数据综合判断为${label}。${growthSummary}；${financialIndustry ? "金融行业使用资本与资产质量口径，不套用普通企业负债率阈值。" : "同时结合盈利效率、现金转化和偿债结构核对。"}基本面结论用于描述经营状态，不等同于股价方向预测。`;

  return {
    status: "ok",
    latestReport: latest,
    label,
    tone,
    score,
    summary: judgementText,
    judgement: {
      label,
      tone,
      score,
      text: judgementText,
      evidence: evidence.slice(0, 5),
    },
    metrics: [
      {label: "营业收入", value: latest.revenue === null ? null : round(latest.revenue / 1e8), suffix: "亿", detail: latest.revenueYoY === null ? "同比暂缺" : `同比${latest.revenueYoY >= 0 ? "+" : ""}${round(latest.revenueYoY)}%`, tone: fundamentalTone(latest.revenueYoY, 5, -5)},
      {label: "归母净利润", value: latest.netProfit === null ? null : round(latest.netProfit / 1e8), suffix: "亿", detail: latest.netProfitYoY === null ? "同比暂缺" : `同比${latest.netProfitYoY >= 0 ? "+" : ""}${round(latest.netProfitYoY)}%`, tone: fundamentalTone(latest.netProfitYoY, 5, -5)},
      {label: "扣非净利润", value: latest.deductedProfit === null ? null : round(latest.deductedProfit / 1e8), suffix: "亿", detail: latest.deductedProfitYoY === null ? "同比暂缺" : `同比${latest.deductedProfitYoY >= 0 ? "+" : ""}${round(latest.deductedProfitYoY)}%`, tone: fundamentalTone(latest.deductedProfitYoY, 3, -5)},
      {label: "加权ROE", value: round(latest.roe), suffix: "%", detail: latestName, tone: latest.roe === null ? "watch" : latest.roe >= roeBase ? "positive" : latest.roe < 0 ? "negative" : "neutral"},
      {label: "经营现金含量", value: round(latest.cashToProfit), suffix: "倍", detail: "经营现金流 / 净利润", tone: fundamentalTone(latest.cashToProfit, 0.8, 0.4)},
      {label: financialIndustry ? "资本充足率" : "资产负债率", value: round(financialIndustry ? latest.capitalAdequacy : latest.debtRatio), suffix: "%", detail: financialIndustry ? "金融行业专用指标" : "普通企业偿债结构", tone: financialIndustry ? "neutral" : latest.debtRatio === null ? "watch" : latest.debtRatio > 80 ? "negative" : "neutral"},
      {label: "市盈率", value: round(quote?.pe), suffix: "倍", detail: "实时估值，仅展示", tone: Number(quote?.pe) > 0 ? "neutral" : "watch"},
      {label: "市净率", value: round(quote?.pb), suffix: "倍", detail: "实时估值，仅展示", tone: Number(quote?.pb) > 0 ? "neutral" : "watch"},
    ],
    sections: [
      {title: "成长与利润", text: growthSummary, tone: fundamentalTone(Math.min(latest.revenueYoY ?? 0, latest.netProfitYoY ?? 0), 5, -5)},
      {title: "盈利能力", text: profitabilitySummary, tone: latest.roe === null ? "watch" : latest.roe >= roeBase ? "positive" : latest.roe < 0 ? "negative" : "neutral"},
      {title: financialIndustry ? "资本与资产质量" : "现金流与偿债", text: solvencySummary, tone: latest.cashToProfit === null ? "watch" : latest.cashToProfit >= 0.8 ? "positive" : latest.cashToProfit < 0.4 ? "negative" : "neutral"},
      {title: "估值与每股指标", text: valuationSummary, tone: "neutral"},
    ],
    history: history.slice(0, 5),
    methodology: `基本面取自东方财富F10公开财务报告，最新为${latestName}，公告日${latest.noticeDate || "暂缺"}。同比字段按接口原值展示；${financialIndustry ? "金融行业不使用普通企业资产负债率规则。" : "现金流和偿债指标与增长、盈利指标共同判断。"}市盈率和市净率只展示，不作行业高低结论。`,
    source: "东方财富F10财务分析",
  };
}

async function fetchCompanyProfile(code) {
  const url = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/CompanySurveyAjax?code=${encodeURIComponent(f10Code(code))}`;
  const json = await fetchJson(url, {timeoutMs: 12000, attempts: 2});
  const row = json?.jbzl || {};
  return {
    fullName: cleanText(row.gsmc),
    name: cleanText(row.agjc),
    industry: cleanText(row.sshy || row.sszjhhy),
    region: cleanText(row.qy),
    intro: cleanText(row.gsjj),
    businessScope: cleanText(row.jyfw),
    website: cleanText(row.gswz),
    source: "东方财富F10公司资料",
  };
}

async function fetchAnnouncements(code) {
  const url = "https://np-anotice-stock.eastmoney.com/api/security/ann" +
    `?sr=-1&page_size=12&page_index=1&ann_type=A&client_source=web&stock_list=${encodeURIComponent(code)}`;
  const json = await fetchJson(url, {timeoutMs: 12000, attempts: 2});
  const rows = Array.isArray(json?.data?.list) ? json.data.list : [];
  return rows.map((row) => {
    const title = cleanText(row.title_ch || row.title);
    const category = cleanText(row?.columns?.[0]?.column_name || "公司公告");
    return {
      date: String(row.notice_date || row.display_time || "").slice(0, 10),
      title,
      source: "上市公司公告",
      category,
      tone: eventTone(`${title} ${category}`),
      url: row.art_code ? `https://data.eastmoney.com/notices/detail/${code}/${row.art_code}.html` : "",
    };
  }).filter((row) => row.title);
}

function companyNewsUrl(keyword, pageSize = 12) {
  const param = {
    uid: "",
    keyword,
    type: ["cmsArticleWebOld"],
    client: "web",
    clientType: "web",
    clientVersion: "curr",
    param: {
      cmsArticleWebOld: {
        searchScope: "default",
        sort: "time",
        pageIndex: 1,
        pageSize,
        preTag: "",
        postTag: "",
      },
    },
  };
  return "https://search-api-web.eastmoney.com/search/jsonp?cb=jQueryStockAnalysis" +
    `&param=${encodeURIComponent(JSON.stringify(param))}&_=${Date.now()}`;
}

async function fetchCompanyNews(code, name) {
  const query = name || code;
  const json = await fetchJsonp(companyNewsUrl(query), {timeoutMs: 14000, attempts: 3});
  const rows = Array.isArray(json?.result?.cmsArticleWebOld) ? json.result.cmsArticleWebOld : [];
  return rows.map((row) => {
    const title = cleanText(row.title);
    const summary = cleanText(row.content);
    const combined = `${title} ${summary}`;
    const relevance = name && title.includes(name) ? 3 : title.includes(code) ? 3 : name && combined.includes(name) ? 2 : combined.includes(code) ? 2 : 0;
    return {
      date: cleanText(row.date),
      title,
      summary,
      source: cleanText(row.mediaName || row.source),
      url: cleanText(row.url),
      tone: eventTone(combined),
      relevance,
      category: relevance >= 3 ? "标题直接事件" : "正文直接提及",
    };
  }).filter((row) => row.title && row.relevance > 0)
    .sort((left, right) => right.relevance - left.relevance || String(right.date).localeCompare(String(left.date)))
    .slice(0, 8);
}

function profileTerms(profile) {
  const text = [profile?.industry, profile?.intro, profile?.businessScope].join(" ");
  const terms = PROFILE_THEME_TERMS.filter((term) => text.includes(term));
  if (profile?.industry && profile.industry.length >= 2) terms.unshift(profile.industry);
  return unique(terms).slice(0, 12);
}

function relatedPolicyEvents(appDir, profile) {
  const data = readJson(path.join(appDir, "data", "policy-news.json"), {});
  const terms = profileTerms(profile);
  if (!terms.length) return [];
  return (Array.isArray(data?.items) ? data.items : []).map((item) => {
    const sectors = Array.isArray(item.sectors) ? item.sectors : [];
    const combined = [item.title, item.summary, item.reason, ...sectors].join(" ");
    const matchedTerms = terms.filter((term) => combined.includes(term) || sectors.some((sector) => sector.includes(term) || term.includes(sector)));
    return matchedTerms.length ? {
      date: cleanText(item.publishedAt),
      title: cleanText(item.title),
      summary: cleanText(item.summary),
      source: cleanText(item.source),
      url: cleanText(item.url),
      impact: cleanText(item.impact || "待观察"),
      tone: item.impactTone === "positive" ? "positive" : item.impactTone === "negative" ? "negative" : "mixed",
      matchedTerms,
      reason: cleanText(item.reason),
      importance: Number(item.importance) || 0,
    } : null;
  }).filter(Boolean)
    .sort((left, right) => right.importance - left.importance || String(right.date).localeCompare(String(left.date)))
    .slice(0, 5);
}

function normalizeSectorName(value) {
  return cleanText(value)
    .replace(/[ⅠⅡⅢIV]+$/i, "")
    .replace(/(申万|中信|行业|板块)$/g, "")
    .trim();
}

function relatedSectorState(appDir, industryName) {
  const industry = normalizeSectorName(industryName);
  if (!industry) {
    return {
      status: "unavailable",
      tone: "watch",
      detail: "公司行业资料暂缺，无法匹配行业资金。",
    };
  }
  const data = readJson(path.join(appDir, "data", "sectors.json"), {});
  const rows = Array.isArray(data?.industry?.rows) ? data.industry.rows : [];
  const ranked = rows.map((row) => {
    const name = normalizeSectorName(row?.name);
    let matchScore = 0;
    if (name === industry) matchScore = 4;
    else if (name.length >= 2 && industry.includes(name)) matchScore = 3;
    else if (industry.length >= 2 && name.includes(industry)) matchScore = 2;
    return {row, name, matchScore};
  }).filter((item) => item.matchScore > 0)
    .sort((left, right) => right.matchScore - left.matchScore);
  if (!ranked.length) {
    return {
      status: "unavailable",
      tone: "watch",
      detail: `当前行业资金榜未覆盖“${industryName}”。`,
    };
  }
  const row = ranked[0].row;
  const amount = finite(row.amount);
  const changePct = finite(row.changePct);
  const tone = amount === null ? "neutral" : amount > 0 ? "positive" : amount < 0 ? "negative" : "neutral";
  return {
    status: "ok",
    tone,
    name: cleanText(row.name),
    code: cleanText(row.code),
    amount: round(amount),
    changePct: round(changePct),
    tradeDate: cleanText(data.tradeDate),
    syncedAt: cleanText(data.syncedAt),
    detail: amount === null ? "行业资金净额暂缺" : `行业资金净额${signedTechnicalNumber(amount)}亿元`,
  };
}

function newsSummary(announcements, news) {
  const titleDirect = news.filter((item) => item.relevance >= 3);
  const bodyMentions = news.filter((item) => item.relevance < 3);
  const all = [...announcements, ...titleDirect];
  if (!all.length) return "当前接口没有返回可核验的公司公告或直接相关新闻，页面不会使用传闻补足。";
  const positive = all.filter((item) => item.tone === "positive").length;
  const negative = all.filter((item) => item.tone === "negative").length;
  const mixed = all.filter((item) => item.tone === "mixed").length;
  const highRelevance = titleDirect[0] || announcements[0] || news[0];
  const headline = highRelevance ? `最近的高相关事件为“${highRelevance.title}”。` : "";
  return `读取到${announcements.length}条最新公司公告、${titleDirect.length}条标题直接事件和${bodyMentions.length}条正文提及；仅对公告与标题直接事件按关键词归类，偏正面${positive}条、风险${negative}条、双向${mixed}条，其余为中性信息。${headline}`;
}

function buildNewsJudgement(announcements, news, policies) {
  const titleDirect = news.filter((item) => item.relevance >= 3);
  const bodyMentions = news.filter((item) => item.relevance < 3);
  const coreEvents = [
    ...announcements.map((item) => ({...item, evidenceType: "公司公告", weight: 2})),
    ...titleDirect.map((item) => ({...item, evidenceType: "标题直接事件", weight: 1.5})),
  ].sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")));
  const counts = {
    announcements: announcements.length,
    titleDirect: titleDirect.length,
    bodyMentions: bodyMentions.length,
    policies: policies.length,
    positive: coreEvents.filter((item) => item.tone === "positive").length,
    negative: coreEvents.filter((item) => item.tone === "negative").length,
    mixed: coreEvents.filter((item) => item.tone === "mixed").length,
    neutral: coreEvents.filter((item) => item.tone === "neutral").length,
  };
  const directScore = coreEvents.reduce((total, item) => {
    if (item.tone === "positive") return total + item.weight;
    if (item.tone === "negative") return total - item.weight;
    return total;
  }, 0);
  const rawPolicyScore = policies.reduce((total, item) => {
    if (item.tone === "positive") return total + 0.5;
    if (item.tone === "negative") return total - 0.5;
    return total;
  }, 0);
  const policyAdjustment = Math.max(-1, Math.min(1, rawPolicyScore));
  const score = directScore + policyAdjustment;
  let label = "中性观察";
  let tone = "neutral";
  if (!coreEvents.length) {
    label = "信息不足";
    tone = "watch";
  } else if (score >= 2.5 && counts.positive > counts.negative) {
    label = "偏正面";
    tone = "positive";
  } else if (score <= -2.5 && counts.negative > counts.positive) {
    label = "偏负面";
    tone = "negative";
  } else if (counts.positive > 0 && counts.negative > 0) {
    label = "多空交织";
    tone = "mixed";
  }

  const latestPositive = coreEvents.find((item) => item.tone === "positive");
  const latestNegative = coreEvents.find((item) => item.tone === "negative");
  const latestCore = coreEvents[0];
  const evidence = [];
  if (latestPositive) evidence.push(`正面线索：${latestPositive.title}`);
  if (latestNegative) evidence.push(`风险线索：${latestNegative.title}`);
  if (!latestPositive && !latestNegative && latestCore) evidence.push(`最新直接事件：${latestCore.title}`);
  if (policies[0]) evidence.push(`政策背景：${policies[0].title}`);

  const policyText = policies.length
    ? `另匹配到${policies.length}条政策或行业事件，只作为次级背景，最多影响1分，不替代公司直接信息。`
    : "当前未匹配到高相关政策或行业事件。";
  const text = coreEvents.length
    ? `综合${counts.announcements}条公司公告和${counts.titleDirect}条标题直接事件，偏正面${counts.positive}条、风险${counts.negative}条、双向${counts.mixed}条、中性${counts.neutral}条，消息面判断为${label}。${policyText}${counts.bodyMentions}条正文顺带提及未计入核心正负结论；事件标签由公开标题关键词归类，不等同于收益预测。`
    : `当前没有取得可核验的公司公告或标题直接事件，消息面判断为信息不足。${policyText}${counts.bodyMentions}条正文顺带提及不参与核心正负结论，页面不会用传闻补足。`;
  return {
    label,
    tone,
    score: round(score),
    text,
    evidence,
    counts,
  };
}

function mergeSearchResults(items) {
  return unique(items.filter(Boolean), (item) => item.code);
}

function createStockAnalysisService(options = {}) {
  const appDir = path.resolve(options.appDir || path.join(__dirname, ".."));
  const portableRoot = path.resolve(options.portableRoot || path.join(appDir, "..", ".."));
  const cacheDir = path.join(portableRoot, "缓存");
  const indexCachePath = path.join(cacheDir, "个股搜索索引.json");
  const baseUniversePath = path.join(cacheDir, "全A基础代码表.json");
  const logger = typeof options.log === "function" ? options.log : () => {};
  let indexItems = [];
  let indexSource = "";
  let indexUpdatedAt = "";
  let indexPromise = null;
  const analysisCache = new Map();

  function loadIndexCache() {
    if (indexItems.length >= INDEX_MIN_COUNT) return indexItems;
    const cached = readJson(indexCachePath, null);
    const rows = Array.isArray(cached?.items) ? cached.items.map(normalizeSearchItem).filter((item) => item?.name && item.name !== item.code) : [];
    if (rows.length >= INDEX_MIN_COUNT) {
      indexItems = rows;
      indexSource = "本机全A名称索引";
      indexUpdatedAt = cached.updatedAt || "";
    }
    return indexItems;
  }

  async function rebuildIndex() {
    const base = readJson(baseUniversePath, null);
    const rawItems = Array.isArray(base) ? base : Array.isArray(base?.items) ? base.items : [];
    const universe = unique(rawItems.map((item) => {
      const code = String(item?.code || "").trim();
      if (!STOCK_CODE_RE.test(code)) return null;
      return {code, name: cleanText(item?.name), market: marketForCode(code), prefix: item?.prefix || ""};
    }).filter(Boolean), (item) => item.code);
    if (universe.length < INDEX_MIN_COUNT) throw new Error(`本机全A基础代码只有${universe.length}只`);
    const chunks = [];
    for (let index = 0; index < universe.length; index += 75) chunks.push(universe.slice(index, index + 75));
    const quotes = [];
    let failedChunks = 0;
    await mapLimit(chunks, 7, async (chunk) => {
      try {
        quotes.push(...await fetchTencentQuoteBatch(chunk));
      } catch (error) {
        failedChunks += 1;
        if (failedChunks <= 3) logger(`个股名称索引分段更新失败：${error.message}`);
      }
    });
    const byCode = new Map(quotes.map((item) => [item.code, item]));
    const items = universe.map((item) => normalizeSearchItem(byCode.get(item.code) || item)).filter((item) => item?.name && item.name !== item.code);
    if (items.length < INDEX_MIN_COUNT) throw new Error(`只取得${items.length}只有效股票名称`);
    const payload = {version: 1, updatedAt: nowText(), count: items.length, source: "腾讯全A实时行情", items};
    writeJsonAtomic(indexCachePath, payload);
    indexItems = items;
    indexSource = payload.source;
    indexUpdatedAt = payload.updatedAt;
    return items;
  }

  async function warmStockIndex(force = false) {
    const cached = readJson(indexCachePath, null);
    const cachedAt = Date.parse(String(cached?.updatedAt || "").replace(/\//g, "-"));
    const fresh = Number.isFinite(cachedAt) && Date.now() - cachedAt < INDEX_CACHE_MS;
    loadIndexCache();
    if (!force && indexItems.length >= INDEX_MIN_COUNT && fresh) return indexItems;
    if (indexPromise) return indexPromise;
    indexPromise = rebuildIndex()
      .catch((error) => {
        logger(`个股搜索索引暂未完整更新：${error.message}`);
        if (indexItems.length >= INDEX_MIN_COUNT) return indexItems;
        throw error;
      })
      .finally(() => { indexPromise = null; });
    return indexPromise;
  }

  function localMatches(query) {
    const normalized = String(query || "").trim().toLowerCase();
    if (!normalized) return [];
    return indexItems.map((item) => {
      const name = String(item.name || "").toLowerCase();
      const pinyin = String(item.pinyin || "").toLowerCase();
      let rank = 99;
      if (item.code === normalized) rank = 0;
      else if (name === normalized) rank = 1;
      else if (name.startsWith(normalized)) rank = 2;
      else if (item.code.startsWith(normalized)) rank = 3;
      else if (name.includes(normalized)) rank = 4;
      else if (pinyin.startsWith(normalized)) rank = 5;
      return rank < 99 ? {item, rank} : null;
    }).filter(Boolean)
      .sort((left, right) => left.rank - right.rank || left.item.code.localeCompare(right.item.code))
      .slice(0, 20)
      .map((row) => row.item);
  }

  async function searchStocks(query) {
    const normalized = cleanText(query);
    if (!normalized) {
      const error = new Error("请输入股票代码或名称");
      error.statusCode = 400;
      throw error;
    }
    if (normalized.length > 40) {
      const error = new Error("搜索内容过长");
      error.statusCode = 400;
      throw error;
    }
    loadIndexCache();
    const remotePromise = fetchSearchSuggestions(normalized).catch((error) => {
      logger(`个股搜索联想接口暂不可用：${error.message}`);
      return [];
    });
    const remote = await remotePromise;
    if (indexItems.length < INDEX_MIN_COUNT && !remote.length) {
      await Promise.race([
        warmStockIndex().catch(() => []),
        sleep(8500),
      ]);
    } else {
      warmStockIndex().catch(() => []);
    }
    const local = localMatches(normalized);
    let items = mergeSearchResults([...remote, ...local]).slice(0, 20);
    if (!items.length && STOCK_CODE_RE.test(normalized)) {
      try {
        const quote = await fetchTencentQuote(normalized);
        items = [normalizeSearchItem(quote)].filter(Boolean);
      } catch (_) {
        // The clear empty state below is preferable to an invented stock name.
      }
    }
    return {
      ok: true,
      query: normalized,
      count: items.length,
      items,
      index: {
        ready: indexItems.length >= INDEX_MIN_COUNT,
        count: indexItems.length,
        source: indexSource || (remote.length ? "东方财富证券联想" : "实时检索"),
        updatedAt: indexUpdatedAt,
      },
    };
  }

  async function analyzeStock(input = {}) {
    const code = String(input.code || "").replace(/\D/g, "");
    if (!STOCK_CODE_RE.test(code)) {
      const error = new Error("股票代码无效");
      error.statusCode = 400;
      throw error;
    }
    const cached = analysisCache.get(code);
    if (cached && Date.now() - cached.savedAt < ANALYSIS_CACHE_MS) {
      return {...cached.data, servedFromCache: true};
    }
    const suppliedName = cleanText(input.name);
    const suppliedMarket = marketForCode(code, input.market);
    const identityPromise = suppliedName
      ? Promise.resolve({code, name: suppliedName, market: suppliedMarket})
      : fetchSearchSuggestions(code).then((rows) => rows.find((item) => item.code === code)).catch(() => null);
    const [identityResult, quoteResult, historyResult, benchmarkResult, minuteResult, profileResult, announcementsResult, fundamentalResult] = await Promise.allSettled([
      identityPromise,
      fetchTencentQuote(code),
      fetchTencentKline(code),
      fetchTencentKlineBySymbol("sh000001", 640),
      fetchTencentMinute(code),
      fetchCompanyProfile(code),
      fetchAnnouncements(code),
      fetchFundamentalData(code),
    ]);
    const identity = identityResult.status === "fulfilled" && identityResult.value
      ? identityResult.value
      : {code, name: suppliedName || code, market: suppliedMarket};
    const quote = quoteResult.status === "fulfilled" ? quoteResult.value : null;
    const profile = profileResult.status === "fulfilled" ? profileResult.value : {
      fullName: "",
      name: identity.name,
      industry: "",
      region: "",
      intro: "",
      businessScope: "",
      source: "",
    };
    const name = cleanText(identity.name || quote?.name || profile.name || code);
    const newsResult = await Promise.allSettled([
      fetchCompanyNews(code, name),
    ]);
    const announcements = announcementsResult.status === "fulfilled" ? announcementsResult.value : [];
    const companyNews = newsResult[0].status === "fulfilled" ? newsResult[0].value : [];
    const policies = relatedPolicyEvents(appDir, profile);
    const sectorState = relatedSectorState(appDir, profile.industry);
    const mergedHistory = historyResult.status === "fulfilled"
      ? mergeQuoteIntoHistory(historyResult.value, quote)
      : [];
    const technical = mergedHistory.length
      ? analyzeTechnical(mergedHistory, {
        benchmarkHistory: benchmarkResult.status === "fulfilled" ? benchmarkResult.value : [],
        minuteData: minuteResult.status === "fulfilled" ? minuteResult.value : null,
        quote,
        sectorState,
      })
      : {status: "error", message: `日线读取失败：${historyResult.reason?.message || "接口暂不可用"}`};
    const fundamental = fundamentalResult.status === "fulfilled"
      ? analyzeFundamental(fundamentalResult.value, quote, profile)
      : analyzeFundamental([], quote, profile);
    const directErrors = [
      quoteResult.status === "rejected" ? `实时行情：${quoteResult.reason.message}` : "",
      historyResult.status === "rejected" ? `日线：${historyResult.reason.message}` : "",
      benchmarkResult.status === "rejected" ? `上证对照日线：${benchmarkResult.reason.message}` : "",
      minuteResult.status === "rejected" ? `分钟线：${minuteResult.reason.message}` : "",
      profileResult.status === "rejected" ? `公司资料：${profileResult.reason.message}` : "",
      announcementsResult.status === "rejected" ? `公告：${announcementsResult.reason.message}` : "",
      fundamentalResult.status === "rejected" ? `基本面：${fundamentalResult.reason.message}` : "",
      newsResult[0].status === "rejected" ? `新闻：${newsResult[0].reason.message}` : "",
    ].filter(Boolean);
    const data = {
      ok: true,
      code,
      name,
      market: identity.market ?? suppliedMarket,
      marketLabel: /^(430|83\d|87\d|920)/.test(code) ? "北交所" : marketForCode(code, identity.market) === 1 ? "上交所" : "深交所",
      fetchedAt: nowText(),
      quote: quote ? {
        price: quote.price,
        previousClose: quote.previousClose,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        change: quote.change,
        changePct: quote.changePct,
        volume: quote.volume,
        amount: quote.amount,
        turnoverRate: quote.turnoverRate,
        pe: quote.pe,
        floatMarketCap: quote.floatMarketCap,
        totalMarketCap: quote.totalMarketCap,
        pb: quote.pb,
        date: quote.date,
        source: quote.source,
      } : null,
      profile,
      technical,
      fundamental,
      news: {
        status: announcements.length || companyNews.length || policies.length ? "ok" : "empty",
        summary: newsSummary(announcements, companyNews),
        judgement: buildNewsJudgement(announcements, companyNews, policies),
        announcements,
        items: companyNews,
        policyEvents: policies,
        methodology: "公司公告取自公开公告聚合接口；新闻仅保留标题或摘要直接出现该公司名称、代码的条目；正负标签来自事件关键词，用于整理线索，不代表收益预测。",
      },
      sourceStatus: {
        partial: directErrors.length > 0,
        errors: directErrors,
        sources: ["腾讯实时行情、前复权日线与分钟线", "上证指数同期日线", "应用内行业资金榜", "上市公司公告", "东方财富公开新闻检索", "东方财富F10公司资料与财务分析", "应用内政策新闻库"],
      },
    };
    analysisCache.set(code, {savedAt: Date.now(), data});
    if (analysisCache.size > 80) analysisCache.delete(analysisCache.keys().next().value);
    return data;
  }

  return {
    analyzeStock,
    searchStocks,
    warmStockIndex,
  };
}

function runSelfTest() {
  const rows = [];
  const cursor = new Date("2023-01-02T00:00:00Z");
  for (let index = 0; index < 640; index += 1) {
    while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) cursor.setUTCDate(cursor.getUTCDate() + 1);
    const close = 10 + index * 0.035 + Math.sin(index / 7) * 0.18;
    rows.push({
      date: cursor.toISOString().slice(0, 10),
      open: close - 0.04,
      close,
      high: close + 0.12,
      low: close - 0.12,
      volume: 100000 + index * 500,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const benchmarkRows = rows.map((row, index) => ({
    ...row,
    open: 3000 + index * 0.6,
    close: 3000 + index * 0.6,
    high: 3003 + index * 0.6,
    low: 2997 + index * 0.6,
  }));
  const minuteRows = Array.from({length: 90}, (_, index) => {
    const totalMinutes = 9 * 60 + 30 + index;
    const price = rows.at(-1).close + index * 0.001;
    const volume = 1000 + index * 140;
    return {
      time: `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}${String(totalMinutes % 60).padStart(2, "0")}`,
      price,
      volume,
      amount: volume * 100 * price,
    };
  });
  const analysis = analyzeTechnical(rows, {
    benchmarkHistory: benchmarkRows,
    minuteData: {date: rows.at(-1).date, rows: minuteRows},
    quote: {turnoverRate: 4.2, floatMarketCap: 500},
    sectorState: {status: "ok", name: "测试行业", amount: 2.5, changePct: 1.1, tradeDate: rows.at(-1).date, tone: "positive"},
  });
  if (analysis.status !== "ok" || analysis.metrics.length !== 6 || analysis.chart.length !== 90 || !analysis.judgement?.text ||
      analysis.cycleAnalysis?.length !== 4 || !analysis.finalSummary?.text || analysis.dataCoverage?.length < 7) {
    throw new Error("技术面自检失败");
  }
  if (!analysis.dataCoverage.some((item) => item.label === "精确RPS百分位" && item.status === "暂缺")) {
    throw new Error("RPS数据边界自检失败");
  }
  if (/买入|卖出|加仓|减仓|止损|目标价/.test(JSON.stringify(analysis))) {
    throw new Error("技术面输出包含交易指令");
  }
  const item = normalizeSearchItem({Code: "300750", Name: "宁德时代", QuoteID: "0.300750", Classify: "AStock"});
  if (!item || item.market !== 0 || item.name !== "宁德时代") throw new Error("证券检索标准化自检失败");
  const newsJudgement = buildNewsJudgement(
    [{date: "2026-07-25", title: "公司签署重大合同", tone: "positive"}],
    [
      {date: "2026-07-24", title: "公司收到监管警示", tone: "negative", relevance: 3},
      {date: "2026-07-23", title: "行业综述提及公司", tone: "positive", relevance: 2},
    ],
    [{date: "2026-07-22", title: "行业支持政策发布", tone: "positive"}],
  );
  if (newsJudgement.label !== "多空交织" || newsJudgement.counts.bodyMentions !== 1 || newsJudgement.counts.positive !== 1) {
    throw new Error("消息面综合判断自检失败");
  }
  const fundamental = analyzeFundamental([
    normalizeFundamentalRow({
      REPORT_DATE_NAME: "2026中报",
      REPORT_DATE: "2026-06-30",
      NOTICE_DATE: "2026-07-25",
      TOTALOPERATEREVE: 276916580000,
      TOTALOPERATEREVETZ: 54.8,
      PARENTNETPROFIT: 43284002000,
      PARENTNETPROFITTZ: 41.98,
      KCFJCXSYJLR: 39013300000,
      KCFJCXSYJLRTZ: 43.44,
      ROEJQ: 12.08,
      ROIC: 8.26,
      XSMLL: 23.93,
      XSJLL: 16.98,
      ZCFZL: 63.65,
      LD: 1.56,
      SD: 1.29,
      MGJYXJJE: 13.02,
      NCO_NETPROFIT: 1.28,
      EPSJB: 9.51,
      BPS: 81.99,
    }),
  ], {pe: 25.2, pb: 4.1}, {industry: "电池"});
  if (fundamental.status !== "ok" || fundamental.metrics.length !== 8 || fundamental.history.length !== 1 || fundamental.label !== "基本面偏强") {
    throw new Error("基本面综合判断自检失败");
  }
  if (/买入|卖出|加仓|减仓|止损|目标价/.test(JSON.stringify(fundamental))) {
    throw new Error("基本面输出包含交易指令");
  }
  process.stdout.write("个股分析服务自检通过\n");
}

module.exports = {
  analyzeFundamental,
  analyzeTechnical,
  buildNewsJudgement,
  createStockAnalysisService,
  normalizeSearchItem,
};

if (require.main === module && process.argv.includes("--self-test")) runSelfTest();
