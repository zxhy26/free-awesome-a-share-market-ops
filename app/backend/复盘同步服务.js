const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { createMembershipService } = require("./会员授权服务");
const { createStockAnalysisService } = require("./个股分析服务");
const { applyLocalResponseHeaders, validateLocalRequest } = require("./local-request-security");
const { derivativesPublicationState, mergeHealthModule } = require("./health-semantics");
const { createLiveSectorFlowService } = require("./live-sector-flow");
const { createBoardMinuteFlowService } = require("./board-minute-flow");
const { createBoardIntradayService } = require("./board-intraday");
const { createIndexIntradayService } = require("./index-intraday");
const { refreshIndexContribution } = require("./index-contribution-online");
const { createAppUpdateService } = require("./app-update");
const { createUserPreferencesService } = require("./用户设置");

const PORT = Number(process.env.A_SHARE_REVIEW_PORT) || 18765;
const HOST = process.env.A_SHARE_REVIEW_HOST || "127.0.0.1";
const SERVICE_VERSION = "3.18.0";
const ALLOW_REMOTE = process.env.A_SHARE_REVIEW_ALLOW_REMOTE === "1";
const TEST_MODE = process.env.A_SHARE_REVIEW_TEST_MODE === "1";
const DISABLE_SCHEDULES = process.env.A_SHARE_REVIEW_DISABLE_SCHEDULES === "1";
const WORK_DIR = __dirname;
const PORTABLE_ROOT = process.env.A_SHARE_REVIEW_PORTABLE_ROOT
  ? path.resolve(process.env.A_SHARE_REVIEW_PORTABLE_ROOT)
  : "";
const APP_DIR = resolveAppDir();
const DATA_DIR = path.join(APP_DIR, "data");
const USER_PREFERENCES_PATH = process.env.A_SHARE_REVIEW_PREFERENCES_PATH
  || (PORTABLE_ROOT ? path.join(PORTABLE_ROOT, "数据历史", "用户设置.json") : path.join(DATA_DIR, "user-preferences.json"));
const STRUCTURED_HISTORY_DIR = process.env.A_SHARE_REVIEW_HISTORY_DIR
  || (PORTABLE_ROOT ? path.join(PORTABLE_ROOT, "数据历史", "结构化复盘历史") : "D:\\ai素材\\A股自动更新\\结构化复盘历史");
const LEGACY_HISTORY_DIR = process.env.A_SHARE_REVIEW_LEGACY_HISTORY_DIR
  || (PORTABLE_ROOT ? path.join(PORTABLE_ROOT, "数据历史", "每日完整数据") : "D:\\ai素材\\A股自动更新\\每日完整数据");
const PAGE_PATH = PORTABLE_ROOT ? path.join(APP_DIR, "index.html") : "D:\\ai素材\\A股三项同步复盘_最新.html";
const LOG_PATH = process.env.A_SHARE_REVIEW_LOG_PATH || path.join(WORK_DIR, "自动更新日志.txt");
const REFRESH_SCRIPT = path.join(WORK_DIR, "盘中实时更新.ps1");
const QUANT_SCRIPT = path.join(WORK_DIR, "运行量化选股.ps1");
const POLICY_SCRIPT = path.join(WORK_DIR, "更新政策新闻.ps1");
const NEXT_WEEK_EVENTS_SCRIPT = path.join(WORK_DIR, "next-week-events-updater.js");
const DERIVATIVES_SCRIPT = path.join(WORK_DIR, "更新机构衍生品.ps1");
const STOCK_APP_SCRIPT = path.join(WORK_DIR, "打开通达信日K.ps1");
const APP_EDITION = resolveAppEdition();
const appUpdate = createAppUpdateService({
  edition: APP_EDITION,
  appDir: APP_DIR,
  runtimeRoot: PORTABLE_ROOT || path.resolve(APP_DIR, "..", ".."),
  workDir: WORK_DIR,
  log,
});
const userPreferences = createUserPreferencesService({filePath: USER_PREFERENCES_PATH});
const membership = createMembershipService({
  edition: APP_EDITION,
  appDir: APP_DIR,
  dataDir: DATA_DIR,
  keyDir: WORK_DIR,
});
const stockAnalysis = createStockAnalysisService({
  appDir: APP_DIR,
  portableRoot: PORTABLE_ROOT || path.resolve(APP_DIR, "..", ".."),
  log,
});
const liveSectorFlow = createLiveSectorFlowService({log});
const boardMinuteFlow = createBoardMinuteFlowService({
  cachePaths: [
    PORTABLE_ROOT ? path.join(PORTABLE_ROOT, "缓存", "A股板块资金分时缓存.json") : "",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "A股复盘软件运行文件", "定制版", "共享数据", "A股板块资金分时缓存.json")
      : "",
  ].filter(Boolean),
});
const boardIntraday = createBoardIntradayService();
const indexIntraday = createIndexIntradayService({
  marketDataPath: path.join(DATA_DIR, "market.json"),
});

let running = false;
let lastRunAt = "";
let lastResult = null;
let quantRunning = false;
let lastQuantResult = null;
const AUTO_SYNC_INTERVAL_MS = 30 * 1000;
const AUTO_IDLE_INTERVAL_MS = 60 * 1000;
const POLICY_NEWS_INTERVAL_MS = 10 * 60 * 1000;
const NEXT_WEEK_EVENTS_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DERIVATIVES_INTERVAL_MS = 30 * 60 * 1000;
const INDEX_CONTRIBUTION_ACTIVE_INTERVAL_MS = 90 * 1000;
const INDEX_CONTRIBUTION_IDLE_INTERVAL_MS = 10 * 60 * 1000;
const PREOPEN_WATCH_START_MINUTE = 9 * 60 + 15;
const MARKET_CLOSE_MINUTE = 15 * 60;
let autoSyncTimer = null;
let autoSyncEnabled = !DISABLE_SCHEDULES;
let lastAutoSyncAt = "";
let lastAutoSyncResult = null;
let syncProgress = { stage: "idle", message: "等待同步", percent: 0, updatedAt: "" };
let refreshRequestCount = 0;
let policyNewsRunning = false;
let policyNewsTimer = null;
let lastPolicyNewsAt = "";
let lastPolicyNewsResult = null;
let nextWeekEventsRunning = false;
let nextWeekEventsTimer = null;
let lastNextWeekEventsAt = "";
let lastNextWeekEventsResult = null;
let derivativesRunning = false;
let derivativesTimer = null;
let lastDerivativesAt = "";
let lastDerivativesResult = null;
let indexContributionRunning = false;
let indexContributionTimer = null;
let lastIndexContributionAt = "";
let lastIndexContributionResult = null;

function resolveAppDir() {
  const bundledAppDir = PORTABLE_ROOT ? path.join(PORTABLE_ROOT, "程序", "应用") : "";
  const candidates = [
    process.env.A_SHARE_REVIEW_APP_DIR,
    bundledAppDir,
    path.resolve(__dirname, ".."),
    "D:\\ai素材\\A股复盘软件\\程序文件\\应用",
    path.resolve(__dirname, "..", "A股复盘软件", "程序文件", "应用"),
    path.resolve(__dirname, "..", "A股复盘_Windows版"),
    "D:\\ai素材\\A股复盘_Windows版",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) || candidates.at(-1);
}

function resolveAppEdition() {
  const configured = String(process.env.A_SHARE_REVIEW_EDITION || "").trim().toLowerCase();
  if (["member", "basic", "self"].includes(configured)) return configured;
  if (fs.existsSync(path.join(WORK_DIR, "会员私钥.pem"))) return "self";
  const hasQuantRuntime = fs.existsSync(QUANT_SCRIPT)
    && fs.existsSync(path.join(APP_DIR, "pages", "quant.html"));
  return hasQuantRuntime ? "basic" : "member";
}

function appDataStatus() {
  const filePath = path.join(APP_DIR, "data", "market.json");
  const status = {exists: fs.existsSync(filePath), path: filePath, tradeDate: "", syncedAt: "", validation: "", mtime: ""};
  if (!status.exists) return status;
  try {
    const stat = fs.statSync(filePath);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    status.mtime = stat.mtime.toISOString();
    status.tradeDate = data.tradeDate || data.market?.tradeDate || "";
    status.syncedAt = data.syncedAt || data.generatedAt || "";
    status.validation = data.validation?.status || "";
  } catch (error) {
    status.parseError = error.message;
  }
  return status;
}

function flowDataStatus() {
  const filePath = path.join(DATA_DIR, "sectors.json");
  const status = {
    exists: fs.existsSync(filePath),
    path: filePath,
    tradeDate: "",
    complete: false,
    groups: {},
  };
  if (!status.exists) return status;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    status.tradeDate = String(data.tradeDate || "");
    for (const groupKey of ["industry", "concept"]) {
      const rows = Array.isArray(data?.[groupKey]?.rows) ? data[groupKey].rows : [];
      const multiPointRows = rows.filter((row) => Array.isArray(row?.points) && row.points.length >= 2).length;
      const validatedRows = rows.filter((row) => row?.flowValidated && Array.isArray(row?.points) && row.points.length >= 2).length;
      const inflowMultiPointRows = rows.filter((row) => Number(row?.amount) > 0 && Array.isArray(row?.points) && row.points.length >= 2).length;
      const outflowMultiPointRows = rows.filter((row) => Number(row?.amount) < 0 && Array.isArray(row?.points) && row.points.length >= 2).length;
      const reconciliation = data?.[groupKey]?.flowReconciliation || {};
      const reconciliationChecked = Math.max(0, Number(reconciliation.checked) || 0);
      const autoCorrected = Math.max(0, Number(reconciliation.corrected) || 0);
      const matchedAfter = Math.max(0, Number(reconciliation.matchedAfter) || 0);
      status.groups[groupKey] = {
        rows: rows.length,
        multiPointRows,
        validatedRows,
        inflowMultiPointRows,
        outflowMultiPointRows,
        reconciliationChecked,
        autoCorrected,
        matchedAfter,
      };
    }
    status.complete = ["industry", "concept"].every((groupKey) =>
      status.groups[groupKey]?.inflowMultiPointRows >= 10
      && status.groups[groupKey]?.outflowMultiPointRows >= 10
      && status.groups[groupKey]?.reconciliationChecked >= status.groups[groupKey]?.rows
      && status.groups[groupKey]?.matchedAfter >= status.groups[groupKey]?.rows
    );
  } catch (error) {
    status.parseError = error.message;
  }
  return status;
}

function scheduleFlowIntegrityRepair(delayMs = 1200) {
  if (TEST_MODE || DISABLE_SCHEDULES) return;
  const status = flowDataStatus();
  if (status.complete) return;
  setTimeout(async () => {
    if (running) {
      scheduleFlowIntegrityRepair(15000);
      return;
    }
    log(`资金走势图完整性不足，后台补齐真实分钟序列：${JSON.stringify(status.groups)}`);
    try {
      await runRefresh({source: "auto", force: true, timeoutMs: 5 * 60 * 1000});
    } catch (error) {
      log("资金走势图自动补齐失败：" + error.message);
    }
  }, delayMs);
}

function policyNewsStatus() {
  const filePath = path.join(APP_DIR, "data", "policy-news.json");
  const status = {exists: fs.existsSync(filePath), path: filePath, generatedAt: "", itemCount: 0, domesticCount: 0, internationalCount: 0, mtime: ""};
  if (!status.exists) return status;
  try {
    const stat = fs.statSync(filePath);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    status.mtime = stat.mtime.toISOString();
    status.generatedAt = data.generatedAt || "";
    status.itemCount = Array.isArray(data.items) ? data.items.length : 0;
    status.domesticCount = Number(data.stats?.domesticCount) || 0;
    status.internationalCount = Number(data.stats?.internationalCount) || 0;
    status.status = data.status || "";
  } catch (error) {
    status.parseError = error.message;
  }
  return status;
}

function nextWeekEventsStatus() {
  const filePath = path.join(DATA_DIR, "next-week-events.json");
  const status = {
    exists: fs.existsSync(filePath),
    path: filePath,
    generatedAt: "",
    weekStart: "",
    weekEnd: "",
    eventCount: 0,
    coreCount: 0,
    mtime: "",
    status: "",
  };
  if (!status.exists) return status;
  try {
    const stat = fs.statSync(filePath);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    status.mtime = stat.mtime.toISOString();
    status.generatedAt = data.generatedAt || "";
    status.weekStart = data.weekStart || "";
    status.weekEnd = data.weekEnd || "";
    status.eventCount = Array.isArray(data.events) ? data.events.length : 0;
    status.coreCount = Number(data.stats?.core) || 0;
    status.status = data.status || "";
  } catch (error) {
    status.parseError = error.message;
  }
  return status;
}

function derivativesStatus() {
  const filePath = path.join(APP_DIR, "data", "derivatives.json");
  const status = {exists: fs.existsSync(filePath), path: filePath, tradeDate: "", fetchedAt: "", stance: "", score: null, stale: false, productCount: 0, institutionCount: 0, mtime: ""};
  if (!status.exists) return status;
  try {
    const stat = fs.statSync(filePath);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    status.mtime = stat.mtime.toISOString();
    status.tradeDate = data.tradeDate || "";
    status.targetTradeDate = data.targetTradeDate || "";
    status.fetchedAt = data.fetchedAt || "";
    status.stance = data.analysis?.stance || "";
    status.score = Number.isFinite(Number(data.analysis?.score)) ? Number(data.analysis.score) : null;
    status.stale = Boolean(data.stale);
    status.status = data.status || "";
    status.productCount = Array.isArray(data.products) ? data.products.length : 0;
    status.institutionCount = Array.isArray(data.institutions) ? data.institutions.length : 0;
  } catch (error) {
    status.parseError = error.message;
  }
  return status;
}

function indexContributionStatus() {
  const filePath = path.join(DATA_DIR, "index-contribution.json");
  const status = {
    exists: fs.existsSync(filePath),
    path: filePath,
    tradeDate: "",
    fetchedAt: "",
    sourceProvider: "",
    sourceStatus: "",
    sourceMessage: "",
    complete: false,
    indexCount: 0,
    mtime: "",
  };
  if (!status.exists) return status;
  try {
    const stat = fs.statSync(filePath);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    status.mtime = stat.mtime.toISOString();
    status.tradeDate = data.tradeDate || "";
    status.fetchedAt = data.fetchedAt || "";
    status.sourceProvider = data.source?.provider || "";
    status.sourceStatus = data.source?.status || "";
    status.sourceMessage = data.source?.message || "";
    status.complete = Boolean(data.quality?.complete);
    status.indexCount = Object.keys(data.indices || {}).length;
  } catch (error) {
    status.parseError = error.message;
  }
  return status;
}

function derivativesHealthModule(status = derivativesStatus(), now = new Date(), expectedTradeDate = "") {
  const publication = derivativesPublicationState(status, now, undefined, expectedTradeDate);
  const completeness = publication.status === "ok" || publication.status === "pending"
    ? 100
    : status.exists && !status.parseError
      ? 70
      : 0;
  return {
    key: "derivatives",
    label: "机构股指衍生品",
    status: publication.status,
    completeness,
    tradeDate: status.tradeDate,
    syncedAt: status.fetchedAt,
    sources: ["中国金融期货交易所成交持仓排名"],
    sample: {
      productCount: status.productCount,
      institutionCount: status.institutionCount,
      stance: status.stance,
      targetTradeDate: status.targetTradeDate,
    },
    detail: publication.detail || "当前榜单已更新",
    warnings: publication.status === "warning" ? [publication.detail] : [],
    errors: publication.status === "error" ? [publication.detail] : [],
  };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function nowText() {
  const d = new Date();
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function appendTextWithRetry(filePath, text, attempts = 8, delayMs = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.appendFileSync(filePath, text, "utf8");
      return true;
    } catch (_) {
      if (attempt === attempts - 1) break;
      const end = Date.now() + delayMs * (attempt + 1);
      while (Date.now() < end) {
        // The refresh runner and the service share one log file.
      }
    }
  }
  try {
    fs.appendFileSync(`${filePath}.fallback`, text, "utf8");
  } catch (_) {
    return false;
  }
  return false;
}

function log(message) {
  const line = `[${nowText()}] ${message}`;
  appendTextWithRetry(LOG_PATH, `${line}\n`);
  console.log(line);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function methodNotAllowed(res, allowed = "POST") {
  res.setHeader("Allow", allowed);
  sendJson(res, 405, {ok: false, errorCode: "METHOD_NOT_ALLOWED", message: `该接口只接受 ${allowed} 请求。`});
}

const API_DATASETS = {
  market: "market.json",
  indices: "indices.json",
  sectors: "sectors.json",
  stocks: "stocks.json",
  analysis: "analysis.json",
  derivatives: "derivatives.json",
  "index-contribution": "index-contribution.json",
  quant: "quant.json",
  "policy-news": "policy-news.json",
  "next-week-events": "next-week-events.json",
  config: "config.json",
  health: "health.json",
  "history-index": "history-index.json",
};

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function listHistoryDates() {
  const map = new Map();
  const appIndex = readJsonFile(path.join(DATA_DIR, "history-index.json"), {});
  for (const item of appIndex.dates || []) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(item.date || "")) map.set(item.date, {...item});
  }
  if (fs.existsSync(STRUCTURED_HISTORY_DIR)) {
    for (const entry of fs.readdirSync(STRUCTURED_HISTORY_DIR, {withFileTypes: true})) {
      if (entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)) map.set(entry.name, {date: entry.name, type: "structured"});
    }
  }
  if (fs.existsSync(LEGACY_HISTORY_DIR)) {
    for (const name of fs.readdirSync(LEGACY_HISTORY_DIR)) {
      const match = name.match(/^(\d{4}-\d{2}-\d{2})_完整复盘数据\.json$/);
      if (match && !map.has(match[1])) map.set(match[1], {date: match[1], type: "legacy"});
    }
  }
  return [...map.values()].sort((left, right) => right.date.localeCompare(left.date));
}

function structuredHistory(date) {
  const root = path.join(STRUCTURED_HISTORY_DIR, date);
  if (!fs.existsSync(root)) return null;
  const bundle = {version: 1, type: "structured", date};
  for (const [key, filename] of Object.entries(API_DATASETS)) {
    if (["config", "history-index"].includes(key)) continue;
    const data = readJsonFile(path.join(root, filename), null);
    if (data !== null) bundle[key === "policy-news" ? "policyNews" : key] = data;
  }
  return bundle;
}

function legacyHistory(date) {
  const raw = readJsonFile(path.join(LEGACY_HISTORY_DIR, `${date}_完整复盘数据.json`), null);
  if (!raw) return null;
  const market = raw.market || {};
  return {
    version: 1,
    type: "legacy",
    date,
    market: {version: 3, tradeDate: date, syncedAt: raw.syncedAt || "", index: raw.index || {}, market, validation: raw.validation || {}},
    indices: {version: 3, tradeDate: date, syncedAt: raw.syncedAt || "", items: Array.isArray(raw.indices) && raw.indices.length ? raw.indices : [raw.index].filter(Boolean)},
    sectors: {version: 3, tradeDate: date, syncedAt: raw.syncedAt || "", industry: raw.industry || {rows: []}, concept: raw.concept || {rows: []}},
    stocks: {version: 3, tradeDate: date, limitUp: market.limitUpStocks || [], limitDown: market.limitDownStocks || [], continuation: market.yesterdayLimitRows || [], repair: market.yesterdayBrokenRows || []},
    analysis: {version: 3, tradeDate: date, diagnosis: raw.diagnosis || {}, structure: raw.marketStructure || {}, flowAnalysis: raw.flowAnalysis || {}},
    policyNews: raw.policyNews || {},
  };
}

function loadHistory(date) {
  return structuredHistory(date) || legacyHistory(date);
}

function apiServiceState() {
  return {
    version: SERVICE_VERSION,
    edition: APP_EDITION,
    running,
    lastRunAt,
    progress: syncProgress,
    autoSync: {enabled: autoSyncEnabled, inTradingWindow: inTradingWindowDate(), lastAutoSyncAt},
  };
}

function setProgress(stage, message, percent) {
  syncProgress = {
    stage,
    message,
    percent: Math.max(0, Math.min(100, Number(percent) || 0)),
    updatedAt: nowText(),
  };
}

function updateProgressFromOutput(chunk) {
  const text = String(chunk || "");
  if (/完成：|已更新：|同步完成/.test(text)) setProgress("writing", "正在生成复盘结果", 90);
  else if (/涨停|跌停|炸板|市场强度/.test(text)) setProgress("market", "正在统计涨停跌停", 68);
  else if (/板块|资金流/.test(text)) setProgress("sectors", "正在获取板块", 45);
  else if (/指数|上证|深证|创业板/.test(text)) setProgress("indices", "正在获取指数", 22);
}

function classifySyncFailure(result) {
  if (result?.ok) return "";
  const text = [result?.message, result?.stdout, result?.stderr].filter(Boolean).join(" ");
  if (/超时|timed?\s*out/i.test(text)) return "TIMEOUT";
  if (/写入|EACCES|EPERM|EROFS|rename|文件.*占用/i.test(text)) return "FILE_WRITE_FAILED";
  if (/接口|curl|fetch|行情|DNS|连接|网络/i.test(text)) return "DATA_SOURCE_ERROR";
  if (/生成|页面模板|MARKET_DATA|JSON|解析/i.test(text)) return "GENERATE_FAILED";
  return "SYNC_FAILED";
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function serveAppFile(url, req, res) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(url.pathname.slice("/app/".length)) || "index.html";
  } catch (_) {
    sendJson(res, 400, { ok: false, message: "页面路径无效" });
    return;
  }
  const root = path.resolve(APP_DIR);
  let filePath = path.resolve(root, relativePath.replace(/^[/\\]+/, ""));
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    sendJson(res, 403, { ok: false, message: "拒绝访问应用目录之外的文件" });
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, "index.html");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("找不到该页面，请重新打开复盘软件。");
    return;
  }
  const extension = path.extname(filePath).toLowerCase();
  const headers = {
    "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
    "Cache-Control": "no-cache",
  };
  if (extension === ".html") {
    headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
  }
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(fs.readFileSync(filePath));
}

function pageStatus(filePath) {
  const status = {
    exists: fs.existsSync(filePath),
    path: filePath,
    mtime: "",
    indexDate: "",
    industryDate: "",
    conceptDate: "",
    marketDate: "",
    syncedAt: "",
    latestMinute: null,
  };
  if (!status.exists) return status;
  status.mtime = fs.statSync(filePath).mtime.toISOString();
  const html = fs.readFileSync(filePath, "utf8");
  const match = html.match(/const MARKET_DATA = (\{[\s\S]*?\});\s*const DAY_MINUTES/);
  if (!match) return status;
  try {
    const data = JSON.parse(match[1]);
    const indexPoints = data.index?.points || [];
    const minutes = indexPoints.map((point) => Number(point.minute) || 0);
    status.indexDate = data.index?.tradeDate || "";
    status.industryDate = data.industry?.tradeDate || "";
    status.conceptDate = data.concept?.tradeDate || "";
    status.marketDate = data.market?.tradeDate || "";
    status.syncedAt = data.syncedAt || data.index?.fetchedAt || data.industry?.fetchedAt || data.concept?.fetchedAt || "";
    status.latestMinute = minutes.length ? Math.max(...minutes) : null;
  } catch (error) {
    status.parseError = error.message;
  }
  return status;
}

function readLogTail() {
  if (!fs.existsSync(LOG_PATH)) return "";
  const lines = fs.readFileSync(LOG_PATH, "utf8").trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-8).join("；");
}

function runPowerShell(scriptPath, extraArgs, timeoutMs, onProgress) {
  return new Promise((resolve) => {
    const args = [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      scriptPath,
      ...extraArgs,
    ];
    const ps = spawn("powershell.exe", args, { cwd: WORK_DIR, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ps.kill();
      } catch (_) {
        // The child process may already have exited.
      }
      resolve({ ok: false, code: null, message: "同步超时，后台任务已终止", stdout: stdout.trim(), stderr: stderr.trim() });
    }, timeoutMs);
    ps.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (typeof onProgress === "function") onProgress(text);
    });
    ps.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    ps.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, message: error.message, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    ps.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = `${stdout}\n${stderr}`.trim();
      resolve({
        ok: code === 0,
        code,
        message: code === 0 ? "同步完成" : readLogTail() || output.split(/\r?\n/).slice(-3).join("；") || `同步失败，退出码：${code}`,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function runNodeScript(scriptPath, extraArgs, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...extraArgs], {cwd: WORK_DIR, windowsHide: true});
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch (_) {
        // The child process may already have exited.
      }
      resolve({ok: false, code: null, message: "更新超时，后台任务已经停止", stdout: stdout.trim(), stderr: stderr.trim()});
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ok: false, code: null, message: error.message, stdout: stdout.trim(), stderr: stderr.trim()});
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = `${stdout}\n${stderr}`.trim();
      resolve({
        ok: code === 0,
        code,
        message: code === 0 ? "更新完成" : output.split(/\r?\n/).slice(-3).join("；") || `更新失败，退出码：${code}`,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

async function runRefresh(options = {}) {
  const source = options.source || "manual";
  const force = options.force !== false;
  const timeoutMs = options.timeoutMs || 5 * 60 * 1000;
  if (running) {
    return {
      ok: false,
      running: true,
      message: "已有同步任务正在运行",
      progress: syncProgress,
      page: pageStatus(PAGE_PATH),
    };
  }
  running = true;
  lastRunAt = nowText();
  setProgress("starting", "正在准备同步", 5);
  log(source === "auto" ? "后台实时同步启动" : "页面手动同步请求已接收");
  const startedAt = Date.now();
  const args = force ? ["-Force"] : [];
  const result = await runPowerShell(REFRESH_SCRIPT, args, timeoutMs, updateProgressFromOutput);
  const errorCode = classifySyncFailure(result);
  const body = {
    ...result,
    errorCode,
    source,
    running: false,
    elapsedMs: Date.now() - startedAt,
    page: pageStatus(PAGE_PATH),
    progress: result.ok
      ? { stage: "complete", message: "同步完成", percent: 100, updatedAt: nowText() }
      : { stage: "error", message: result.message || "同步失败", percent: syncProgress.percent, updatedAt: nowText() },
  };
  lastResult = body;
  if (source === "auto") {
    lastAutoSyncAt = nowText();
    lastAutoSyncResult = body;
  }
  running = false;
  syncProgress = body.progress;
  log(source === "auto" ? ("后台实时同步结束，退出码：" + result.code) : ("页面手动同步结束，退出码：" + result.code));
  return body;
}

async function runQuant() {
  if (TEST_MODE) {
    return {ok: true, running: false, testMode: true, message: "量化选股接口测试通过", data: pageStatus(path.join(DATA_DIR, "quant.json"))};
  }
  if (quantRunning) {
    return {
      ok: false,
      running: true,
      message: "量化选股正在更新",
      lastResult: lastQuantResult,
    };
  }
  if (!fs.existsSync(QUANT_SCRIPT)) {
    return {ok: false, running: false, message: "找不到量化选股更新脚本", errorCode: "QUANT_SCRIPT_MISSING"};
  }
  quantRunning = true;
  log("页面量化选股更新请求已接收");
  const startedAt = Date.now();
  try {
    const result = await runPowerShell(QUANT_SCRIPT, [], 16 * 60 * 1000);
    const body = {
      ...result,
      errorCode: result.ok ? "" : classifySyncFailure(result),
      running: false,
      elapsedMs: Date.now() - startedAt,
      data: pageStatus(path.join(DATA_DIR, "quant.json")),
    };
    lastQuantResult = body;
    log("页面量化选股更新结束，退出码：" + result.code);
    return body;
  } finally {
    quantRunning = false;
  }
}

async function runPolicyNews(options = {}) {
  if (policyNewsRunning) return {ok: false, running: true, message: "政策新闻同步正在运行", policyNews: policyNewsStatus()};
  policyNewsRunning = true;
  const source = options.source || "manual";
  const args = options.force === false ? [] : ["-Force"];
  log(source === "auto" ? "后台政策新闻同步启动" : "页面政策新闻同步请求已接收");
  try {
    const result = await runPowerShell(POLICY_SCRIPT, args, 90 * 1000);
    const body = {...result, running: false, source, policyNews: policyNewsStatus()};
    lastPolicyNewsAt = nowText();
    lastPolicyNewsResult = body;
    log(`${source === "auto" ? "后台" : "页面"}政策新闻同步结束，退出码：${result.code}`);
    return body;
  } finally {
    policyNewsRunning = false;
  }
}

async function runNextWeekEvents(options = {}) {
  if (nextWeekEventsRunning) {
    return {ok: false, running: true, message: "下周大事件正在更新", nextWeekEvents: nextWeekEventsStatus()};
  }
  if (!fs.existsSync(NEXT_WEEK_EVENTS_SCRIPT)) {
    return {ok: false, running: false, message: "找不到下周大事件更新脚本", errorCode: "NEXT_WEEK_EVENTS_SCRIPT_MISSING"};
  }
  nextWeekEventsRunning = true;
  const source = options.source || "manual";
  const args = options.force === false ? [] : ["--force"];
  log(source === "auto" ? "后台下周大事件更新启动" : "页面下周大事件更新请求已接收");
  try {
    const result = await runNodeScript(NEXT_WEEK_EVENTS_SCRIPT, args, 90 * 1000);
    const body = {...result, running: false, source, nextWeekEvents: nextWeekEventsStatus()};
    lastNextWeekEventsAt = nowText();
    lastNextWeekEventsResult = body;
    log(`${source === "auto" ? "后台" : "页面"}下周大事件更新结束，退出码：${result.code}`);
    return body;
  } finally {
    nextWeekEventsRunning = false;
  }
}

async function runDerivatives(options = {}) {
  if (derivativesRunning) return {ok: false, running: true, message: "机构衍生品正在更新", derivatives: derivativesStatus()};
  if (!fs.existsSync(DERIVATIVES_SCRIPT)) return {ok: false, running: false, message: "找不到机构衍生品更新脚本", errorCode: "DERIVATIVES_SCRIPT_MISSING"};
  derivativesRunning = true;
  const source = options.source || "manual";
  const args = options.force === false ? [] : ["-Force"];
  log(source === "auto" ? "后台机构衍生品同步启动" : "页面机构衍生品同步请求已接收");
  try {
    const result = await runPowerShell(DERIVATIVES_SCRIPT, args, 2 * 60 * 1000);
    const body = {...result, running: false, source, derivatives: derivativesStatus()};
    lastDerivativesAt = nowText();
    lastDerivativesResult = body;
    log(`${source === "auto" ? "后台" : "页面"}机构衍生品同步结束，退出码：${result.code}`);
    return body;
  } finally {
    derivativesRunning = false;
  }
}

async function runIndexContribution(options = {}) {
  if (indexContributionRunning) {
    return {ok: false, running: true, message: "指数贡献公开行情正在更新", indexContribution: indexContributionStatus()};
  }
  indexContributionRunning = true;
  const source = options.source || "manual";
  const outputPath = path.join(DATA_DIR, "index-contribution.json");
  log(source === "auto" ? "后台指数贡献公开行情更新启动" : "页面指数贡献公开行情更新请求已接收");
  try {
    const result = await refreshIndexContribution({outputPath});
    const body = {...result, running: false, source, indexContribution: indexContributionStatus()};
    lastIndexContributionAt = nowText();
    lastIndexContributionResult = body;
    log(`${source === "auto" ? "后台" : "页面"}指数贡献公开行情更新结束：${result.message}`);
    return body;
  } catch (error) {
    const body = {
      ok: false,
      running: false,
      source,
      errorCode: "INDEX_CONTRIBUTION_ONLINE_FAILED",
      message: `指数贡献公开行情更新异常：${error.message}`,
      indexContribution: indexContributionStatus(),
    };
    lastIndexContributionAt = nowText();
    lastIndexContributionResult = body;
    log(body.message);
    return body;
  } finally {
    indexContributionRunning = false;
  }
}

function runLocalStock(searchParams) {
  const rawCode = String(searchParams.get("code") || "").trim().toUpperCase();
  const market = String(searchParams.get("market") || "").trim().toLowerCase();
  const name = String(searchParams.get("name") || "").trim();
  const dryRun = searchParams.get("dry") === "1";
  const isSector = market === "sector";
  const stockCode = isSector
    ? (/^(?:880\d{3}|BK\d{4}|\d{6})$/.test(rawCode) ? rawCode : "")
    : rawCode.replace(/\D/g, "");
  if (!isSector && !/^\d{6}$/.test(stockCode)) {
    return Promise.resolve({ ok: false, message: "股票代码无效" });
  }
  if (isSector && !/^\d{6}$/.test(stockCode) && !name) {
    return Promise.resolve({ ok: false, message: "板块代码和名称均为空" });
  }
  if (!fs.existsSync(STOCK_APP_SCRIPT)) {
    return Promise.resolve({ ok: false, message: "找不到本机股票软件适配脚本" });
  }
  const args = [];
  if (stockCode) args.push("-Code", stockCode);
  args.push("-Market", market, "-Name", name, "-NoWebFallback");
  if (APP_EDITION === "self") {
    args.push("-PreferredApp", "tongdaxin", "-StrictPreferred");
  }
  if (dryRun) args.push("-DryRun");
  return runPowerShell(STOCK_APP_SCRIPT, args, 90 * 1000).then((result) => {
    let payload = null;
    const lines = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "ok")) {
          payload = parsed;
          break;
        }
      } catch (_) {
        // PowerShell may emit diagnostic lines before the final JSON result.
      }
    }
    const ok = Boolean(result.ok && payload?.ok !== false);
    return {
      ...result,
      ...(payload || {}),
      ok,
      message: payload?.message || (ok ? "已在这台设备的股票软件中定位到对应日K页面" : result.message),
    };
  });
}
function minuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function inTradingWindowDate(date = new Date()) {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  const minute = minuteOfDay(date);
  return (minute >= 9 * 60 + 15 && minute <= 11 * 60 + 30) || (minute >= 13 * 60 && minute <= 15 * 60);
}

function inMarketWatchWindowDate(date = new Date()) {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  const minute = minuteOfDay(date);
  return minute >= PREOPEN_WATCH_START_MINUTE && minute <= MARKET_CLOSE_MINUTE;
}

function localDateText(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function targetWeekStart(date = new Date()) {
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  const day = target.getDay();
  if (day === 0) target.setDate(target.getDate() + 1);
  else if (day === 6) target.setDate(target.getDate() + 2);
  else if (day === 5 && minuteOfDay(date) >= MARKET_CLOSE_MINUTE) target.setDate(target.getDate() + 3);
  else target.setDate(target.getDate() - (day - 1));
  return localDateText(target);
}

function nextWeekEventsNeedsRefresh(date = new Date()) {
  const status = nextWeekEventsStatus();
  if (!status.exists || status.parseError || status.status !== "ok") return true;
  if (status.weekStart !== targetWeekStart(date)) return true;
  const isWeekend = date.getDay() === 0 || date.getDay() === 6;
  if (!isWeekend || date.getHours() < 9) return false;
  const generated = new Date(status.generatedAt || status.mtime);
  return !Number.isFinite(generated.getTime()) || localDateText(generated) !== localDateText(date);
}

function scheduleAutoSync(delayMs = AUTO_SYNC_INTERVAL_MS) {
  if (!autoSyncEnabled) return;
  if (autoSyncTimer) clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(autoSyncTick, delayMs);
}

async function autoSyncTick() {
  try {
    if (!inMarketWatchWindowDate()) {
      scheduleAutoSync(AUTO_IDLE_INTERVAL_MS);
      return;
    }
    if (!inTradingWindowDate()) {
      scheduleAutoSync(AUTO_SYNC_INTERVAL_MS);
      return;
    }
    await runRefresh({ source: "auto", force: false, timeoutMs: 4 * 60 * 1000 });
  } catch (error) {
    log("后台实时同步异常：" + error.message);
  } finally {
    scheduleAutoSync(AUTO_SYNC_INTERVAL_MS);
  }
}

function schedulePolicyNews(delayMs = POLICY_NEWS_INTERVAL_MS) {
  if (policyNewsTimer) clearTimeout(policyNewsTimer);
  policyNewsTimer = setTimeout(policyNewsTick, delayMs);
}

async function policyNewsTick() {
  try {
    if (!running) await runPolicyNews({source: "auto", force: false});
  } catch (error) {
    log("后台政策新闻同步异常：" + error.message);
  } finally {
    schedulePolicyNews(POLICY_NEWS_INTERVAL_MS);
  }
}

function scheduleNextWeekEvents(delayMs = NEXT_WEEK_EVENTS_INTERVAL_MS) {
  if (nextWeekEventsTimer) clearTimeout(nextWeekEventsTimer);
  nextWeekEventsTimer = setTimeout(nextWeekEventsTick, delayMs);
}

async function nextWeekEventsTick() {
  try {
    if (!running && nextWeekEventsNeedsRefresh()) {
      await runNextWeekEvents({source: "auto", force: false});
    }
  } catch (error) {
    log("后台下周大事件更新异常：" + error.message);
  } finally {
    scheduleNextWeekEvents(NEXT_WEEK_EVENTS_INTERVAL_MS);
  }
}

function scheduleDerivatives(delayMs = DERIVATIVES_INTERVAL_MS) {
  if (derivativesTimer) clearTimeout(derivativesTimer);
  derivativesTimer = setTimeout(derivativesTick, delayMs);
}

function indexContributionRefreshAge(date = new Date()) {
  if (inTradingWindowDate(date)) return 75 * 1000;
  if (inMarketWatchWindowDate(date)) return 5 * 60 * 1000;
  return date.getDay() === 0 || date.getDay() === 6 ? 18 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
}

function indexContributionNeedsRefresh(date = new Date()) {
  const status = indexContributionStatus();
  if (!status.exists || status.parseError || status.sourceStatus !== "ok" || status.indexCount < 7) return true;
  const marketTradeDate = appDataStatus().tradeDate;
  if (marketTradeDate && status.tradeDate < marketTradeDate) return true;
  const fetched = new Date(status.mtime || status.fetchedAt);
  return !Number.isFinite(fetched.getTime()) || date.getTime() - fetched.getTime() > indexContributionRefreshAge(date);
}

function indexContributionRefreshDelay(date = new Date()) {
  return inTradingWindowDate(date) ? INDEX_CONTRIBUTION_ACTIVE_INTERVAL_MS : INDEX_CONTRIBUTION_IDLE_INTERVAL_MS;
}

function scheduleIndexContribution(delayMs = indexContributionRefreshDelay()) {
  if (indexContributionTimer) clearTimeout(indexContributionTimer);
  indexContributionTimer = setTimeout(indexContributionTick, delayMs);
}

async function indexContributionTick() {
  try {
    if (!running && !indexContributionRunning && indexContributionNeedsRefresh()) {
      await runIndexContribution({source: "auto"});
    }
  } catch (error) {
    log("后台指数贡献公开行情更新异常：" + error.message);
  } finally {
    scheduleIndexContribution(indexContributionRefreshDelay());
  }
}

async function derivativesTick() {
  try {
    if (!running) await runDerivatives({source: "auto", force: false});
  } catch (error) {
    log("后台机构衍生品同步异常：" + error.message);
  } finally {
    scheduleDerivatives(DERIVATIVES_INTERVAL_MS);
  }
}

function startAsyncRefresh(source = "manual") {
  if (running) return {ok: true, accepted: false, running: true, message: "已有同步任务正在运行", progress: syncProgress};
  if (TEST_MODE) {
    running = true;
    lastRunAt = nowText();
    setProgress("testing", "正在执行同步锁测试", 50);
    setTimeout(() => {
      running = false;
      lastResult = {ok: true, running: false, message: "测试同步完成", source: "test", elapsedMs: 350};
      setProgress("complete", "同步完成", 100);
      lastResult.progress = syncProgress;
    }, 350);
    return {ok: true, accepted: true, running: true, message: "正在执行同步锁测试", progress: syncProgress};
  }
  runRefresh({source}).then((result) => {
    if (result.ok && !indexContributionRunning) {
      runIndexContribution({source}).catch((error) => log("指数贡献公开行情异步更新异常：" + error.message));
    }
  }).catch((error) => {
    running = false;
    const result = {
      ok: false,
      running: false,
      errorCode: "GENERATE_FAILED",
      message: error.message || "同步任务异常退出",
      progress: {stage: "error", message: error.message || "同步任务异常退出", percent: syncProgress.percent, updatedAt: nowText()},
    };
    lastResult = result;
    syncProgress = result.progress;
    log("异步同步异常：" + result.message);
  });
  return {ok: true, accepted: true, running: true, message: "正在获取指数", progress: syncProgress};
}

const server = http.createServer(async (req, res) => {
  const security = validateLocalRequest(req, {port: PORT, allowRemote: ALLOW_REMOTE});
  applyLocalResponseHeaders(res, security.ok ? security.corsOrigin : "");
  if (!security.ok) {
    sendJson(res, security.statusCode, {ok: false, errorCode: security.code, message: security.message});
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (await membership.handleRequest(req, res, url)) return;

  const protectedAppFeature = membership.protectedFeatureForPath(url.pathname);
  if (protectedAppFeature && !membership.hasAccess()) {
    if (url.pathname.startsWith("/app/data/")) {
      membership.sendPaymentRequired(res, protectedAppFeature);
      return;
    }
    res.writeHead(302, {
      Location: `/app/?member=required&feature=${encodeURIComponent(protectedAppFeature)}`,
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  const protectedApiFeature = membership.protectedFeatureForApi(url.pathname, req.method);
  if (protectedApiFeature && !membership.hasAccess()) {
    membership.sendPaymentRequired(res, protectedApiFeature);
    return;
  }

  if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(302, { Location: "/app/", "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if ((url.pathname === "/app" || url.pathname.startsWith("/app/")) && (req.method === "GET" || req.method === "HEAD")) {
    if (url.pathname === "/app") {
      res.writeHead(302, { Location: "/app/", "Cache-Control": "no-store" });
      res.end();
      return;
    }
    serveAppFile(url, req, res);
    return;
  }

  if (url.pathname === "/api/v1/meta" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      apiVersion: "v1",
      serviceVersion: SERVICE_VERSION,
      edition: APP_EDITION,
      appData: appDataStatus(),
      flowData: flowDataStatus(),
      historyCount: listHistoryDates().length,
      endpoints: ["/api/v1/market/snapshot", "/api/v1/preferences", "POST /api/v1/preferences", "/api/v1/index-catalog", "/api/v1/index-trend?key=sh000001", "/api/v1/live/sector-flows", "POST /api/v1/live/sector-flows/refresh", "/api/v1/sector-trend?code=BK0000", "/api/v1/sector-flow?code=BK0000", "/api/v1/stocks/search", "/api/v1/stocks/analyze", "/api/v1/health", "/api/v1/history/dates", "/api/v1/history/:date", "/api/v1/data/:module", "/api/v1/status", "/api/v1/app-update/status", "/api/v1/app-update/check", "POST /api/v1/app-update/install", "POST /api/v1/sync", "POST /api/v1/index-contribution/refresh", "POST /stock-open", "POST /derivatives-refresh", "POST /next-week-events-refresh"],
    });
    return;
  }

  if (await userPreferences.handleRequest(req, res, url)) return;

  if (url.pathname === "/api/v1/app-update/status" && req.method === "GET") {
    sendJson(res, 200, appUpdate.getStatus());
    return;
  }

  if (url.pathname === "/api/v1/app-update/check" && req.method === "GET") {
    const result = await appUpdate.checkForUpdates({force: url.searchParams.get("force") === "1"});
    sendJson(res, result.ok ? 200 : 502, result);
    return;
  }

  if (url.pathname === "/api/v1/app-update/install") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    const result = appUpdate.startInstall();
    sendJson(res, result.ok ? 202 : 409, result);
    return;
  }

  if (url.pathname === "/api/v1/index-catalog" && req.method === "GET") {
    sendJson(res, 200, indexIntraday.getCatalog());
    return;
  }

  if (url.pathname === "/api/v1/index-trend" && req.method === "GET") {
    try {
      sendJson(res, 200, await indexIntraday.getTimeline(
        url.searchParams.get("key") || "",
        url.searchParams.get("tradeDate") || "",
      ));
    } catch (error) {
      sendJson(res, error.statusCode || 502, {
        ok: false,
        errorCode: error.code || "INDEX_INTRADAY_UNAVAILABLE",
        message: error.message || "指数分时暂不可用",
      });
    }
    return;
  }

  if (url.pathname === "/api/v1/live/sector-flows" && req.method === "GET") {
    try {
      sendJson(res, 200, await liveSectorFlow.getSnapshot({nonBlocking: true}));
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        errorCode: "LIVE_SECTOR_FLOW_UNAVAILABLE",
        message: error.message || "逐秒板块资金暂不可用",
        service: liveSectorFlow.getState(),
      });
    }
    return;
  }

  if (url.pathname === "/api/v1/live/sector-flows/refresh") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    try {
      sendJson(res, 200, await liveSectorFlow.forceRefresh());
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        errorCode: "LIVE_SECTOR_FLOW_REFRESH_FAILED",
        message: error.message || "逐秒板块资金手动刷新失败",
        service: liveSectorFlow.getState(),
      });
    }
    return;
  }

  if (url.pathname === "/api/v1/sector-flow" && req.method === "GET") {
    try {
      sendJson(res, 200, await boardMinuteFlow.getTimeline(
        url.searchParams.get("code") || "",
        url.searchParams.get("name") || "",
      ));
    } catch (error) {
      sendJson(res, error.statusCode || 502, {
        ok: false,
        errorCode: error.code || "BOARD_FLOW_UNAVAILABLE",
        message: error.message || "板块分钟资金暂不可用",
      });
    }
    return;
  }

  if (url.pathname === "/api/v1/sector-trend" && req.method === "GET") {
    try {
      sendJson(res, 200, await boardIntraday.getTimeline(
        url.searchParams.get("code") || "",
        url.searchParams.get("name") || "",
        url.searchParams.get("tradeDate") || "",
      ));
    } catch (error) {
      sendJson(res, error.statusCode || 502, {
        ok: false,
        errorCode: error.code || "BOARD_INTRADAY_UNAVAILABLE",
        message: error.message || "板块指数分时暂不可用",
      });
    }
    return;
  }

  if (url.pathname === "/api/v1/stocks/search" && req.method === "GET") {
    try {
      sendJson(res, 200, await stockAnalysis.searchStocks(url.searchParams.get("q") || ""));
    } catch (error) {
      sendJson(res, error.statusCode || 502, {ok: false, message: error.message || "个股搜索失败"});
    }
    return;
  }

  if (url.pathname === "/api/v1/stocks/analyze" && req.method === "GET") {
    try {
      sendJson(res, 200, await stockAnalysis.analyzeStock({
        code: url.searchParams.get("code") || "",
        name: url.searchParams.get("name") || "",
        market: url.searchParams.get("market") || "",
      }));
    } catch (error) {
      sendJson(res, error.statusCode || 502, {ok: false, message: error.message || "个股分析失败"});
    }
    return;
  }

  if (url.pathname.startsWith("/api/v1/data/") && req.method === "GET") {
    const name = decodeURIComponent(url.pathname.slice("/api/v1/data/".length));
    const filename = API_DATASETS[name];
    if (!filename) {
      sendJson(res, 404, {ok: false, message: "未知数据模块"});
      return;
    }
    const data = readJsonFile(path.join(DATA_DIR, filename), null);
    if (data === null) {
      sendJson(res, 404, {ok: false, message: "数据模块尚未生成"});
      return;
    }
    sendJson(res, 200, data);
    return;
  }

  if (url.pathname === "/api/v1/market/snapshot" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      market: readJsonFile(path.join(DATA_DIR, "market.json"), {}),
      indices: readJsonFile(path.join(DATA_DIR, "indices.json"), {}),
      sectors: readJsonFile(path.join(DATA_DIR, "sectors.json"), {}),
      analysis: readJsonFile(path.join(DATA_DIR, "analysis.json"), {}),
      service: apiServiceState(),
    });
    return;
  }

  if (url.pathname === "/api/v1/health" && req.method === "GET") {
    const health = readJsonFile(path.join(DATA_DIR, "health.json"), {});
    const derivatives = derivativesStatus();
    const mergedHealth = mergeHealthModule(health, derivativesHealthModule(derivatives, new Date(), health.tradeDate));
    sendJson(res, 200, {...mergedHealth, derivatives, indexContribution: indexContributionStatus(), liveSectorFlow: liveSectorFlow.getState(), service: apiServiceState()});
    return;
  }

  if (url.pathname === "/api/v1/history/dates" && req.method === "GET") {
    const dates = listHistoryDates();
    sendJson(res, 200, {ok: true, latestDate: dates[0]?.date || "", count: dates.length, dates});
    return;
  }

  if (url.pathname.startsWith("/api/v1/history/") && req.method === "GET") {
    const date = decodeURIComponent(url.pathname.slice("/api/v1/history/".length));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      sendJson(res, 400, {ok: false, message: "交易日格式无效"});
      return;
    }
    const data = loadHistory(date);
    sendJson(res, data ? 200 : 404, data || {ok: false, message: "找不到该交易日归档"});
    return;
  }

  if (url.pathname === "/api/v1/status" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      ...apiServiceState(),
      appData: appDataStatus(),
      liveSectorFlow: liveSectorFlow.getState(),
      policyNews: policyNewsStatus(),
      nextWeekEvents: nextWeekEventsStatus(),
      derivatives: derivativesStatus(),
      indexContributionRunning,
      indexContribution: indexContributionStatus(),
      appUpdate: appUpdate.getStatus(),
    });
    return;
  }

  if (url.pathname === "/api/v1/sync" && req.method === "POST") {
    const result = startAsyncRefresh("api");
    sendJson(res, result.accepted === false ? 202 : 202, result);
    return;
  }

  if (url.pathname === "/api/v1/index-contribution/refresh") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    if (indexContributionRunning) {
      sendJson(res, 202, {ok: true, accepted: false, running: true, message: "指数贡献公开行情正在更新"});
      return;
    }
    runIndexContribution({source: "api"}).catch((error) => log("指数贡献公开行情接口异常：" + error.message));
    sendJson(res, 202, {ok: true, accepted: true, running: true, message: "指数贡献已转入后台自动更新"});
    return;
  }

  if (url.pathname === "/health") {
    const page = pageStatus(PAGE_PATH);
    sendJson(res, 200, {
      ok: true,
      version: SERVICE_VERSION,
      edition: APP_EDITION,
      running,
      lastSyncAt: page.syncedAt || lastRunAt || "",
      progress: syncProgress,
      testMode: TEST_MODE,
      appUrl: `http://${HOST}:${PORT}/app/`,
      appData: appDataStatus(),
      flowData: flowDataStatus(),
      liveSectorFlow: liveSectorFlow.getState(),
      policyNewsRunning,
      policyNews: policyNewsStatus(),
      nextWeekEventsRunning,
      nextWeekEvents: nextWeekEventsStatus(),
      derivativesRunning,
      derivatives: derivativesStatus(),
      indexContributionRunning,
      indexContribution: indexContributionStatus(),
      appUpdate: appUpdate.getStatus(),
    });
    return;
  }

  if (url.pathname === "/status") {
    sendJson(res, 200, {
      ok: true,
      version: SERVICE_VERSION,
      edition: APP_EDITION,
      running,
      lastRunAt,
      lastResult,
      progress: syncProgress,
      refreshRequestCount,
      autoSync: {
        enabled: autoSyncEnabled,
        inTradingWindow: inTradingWindowDate(),
        inMarketWatchWindow: inMarketWatchWindowDate(),
        intervalMs: AUTO_SYNC_INTERVAL_MS,
        lastAutoSyncAt,
        lastAutoSyncResult,
      },
      page: pageStatus(PAGE_PATH),
      appData: appDataStatus(),
      flowData: flowDataStatus(),
      liveSectorFlow: liveSectorFlow.getState(),
      derivatives: {
        running: derivativesRunning,
        intervalMs: DERIVATIVES_INTERVAL_MS,
        lastRunAt: lastDerivativesAt,
        lastResult: lastDerivativesResult,
        data: derivativesStatus(),
      },
      policyNews: {
        running: policyNewsRunning,
        intervalMs: POLICY_NEWS_INTERVAL_MS,
        lastRunAt: lastPolicyNewsAt,
        lastResult: lastPolicyNewsResult,
        data: policyNewsStatus(),
      },
      nextWeekEvents: {
        running: nextWeekEventsRunning,
        intervalMs: NEXT_WEEK_EVENTS_INTERVAL_MS,
        lastRunAt: lastNextWeekEventsAt,
        lastResult: lastNextWeekEventsResult,
        data: nextWeekEventsStatus(),
      },
      indexContribution: {
        running: indexContributionRunning,
        intervalMs: indexContributionRefreshDelay(),
        activeIntervalMs: INDEX_CONTRIBUTION_ACTIVE_INTERVAL_MS,
        idleIntervalMs: INDEX_CONTRIBUTION_IDLE_INTERVAL_MS,
        lastRunAt: lastIndexContributionAt,
        lastResult: lastIndexContributionResult,
        data: indexContributionStatus(),
      },
    });
    return;
  }

  if (url.pathname === "/refresh") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    refreshRequestCount += 1;
    if (url.searchParams.get("async") === "1") {
      sendJson(res, 202, startAsyncRefresh("manual"));
      return;
    }
    const result = await runRefresh();
    sendJson(res, result.ok ? 200 : result.running ? 409 : 500, result);
    return;
  }

  if (url.pathname === "/policy-refresh") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    const result = await runPolicyNews({source: "manual", force: true});
    sendJson(res, result.ok ? 200 : result.running ? 202 : 500, result);
    return;
  }

  if (url.pathname === "/next-week-events-refresh") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    const result = await runNextWeekEvents({source: "manual", force: true});
    sendJson(res, result.ok ? 200 : result.running ? 202 : 500, result);
    return;
  }

  if (url.pathname === "/derivatives-refresh") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    const result = await runDerivatives({source: "manual", force: true});
    sendJson(res, result.ok ? 200 : result.running ? 202 : 500, result);
    return;
  }

  if (url.pathname === "/quant-refresh") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    const result = await runQuant();
    sendJson(res, result.ok ? 200 : result.running ? 202 : 500, result);
    return;
  }

  if (["/stock-open", "/tdx-stock", "/tdx-sector"].includes(url.pathname)) {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    const result = await runLocalStock(url.searchParams);
    sendJson(res, result.ok ? 200 : 500, result);
    return;
  }

  sendJson(res, 404, { ok: false, message: "未知请求" });
});

server.on("error", (error) => {
  log(`复盘同步服务启动失败：${error.message}`);
  process.exitCode = 1;
});

server.on("close", () => liveSectorFlow.stopPolling());

server.listen(PORT, HOST, () => {
  log(`复盘同步服务已启动：http://${HOST}:${PORT}；A股复盘应用：http://${HOST}:${PORT}/app/`);
  if (!TEST_MODE) {
    liveSectorFlow.startPolling();
    const timer = setTimeout(() => stockAnalysis.warmStockIndex().catch(() => {}), 18000);
    if (typeof timer.unref === "function") timer.unref();
  }
  if (!DISABLE_SCHEDULES) {
    scheduleFlowIntegrityRepair();
    scheduleAutoSync(5000);
    schedulePolicyNews(15000);
    scheduleNextWeekEvents(25000);
    scheduleDerivatives(20000);
    scheduleIndexContribution(12000);
  }
});
