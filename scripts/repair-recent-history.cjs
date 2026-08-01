"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {exportOptimizedAppData} = require("../app/backend/导出复盘应用数据");
const {
  compareLegacyArchives,
  datasetQuality,
  legacyArchiveQuality,
  selectBetterDataset,
} = require("../app/backend/history-quality");

const DATASETS = Object.freeze({
  market: "market.json",
  indices: "indices.json",
  sectors: "sectors.json",
  stocks: "stocks.json",
  analysis: "analysis.json",
  policyNews: "policy-news.json",
});

function progress(message) {
  if (process.env.A_SHARE_HISTORY_REPAIR_VERBOSE === "1") process.stderr.write(`[history-repair] ${message}\n`);
}

function argument(name, fallback = "") {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
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
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value), "utf8");
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (_) {
    fs.copyFileSync(temporaryPath, filePath);
    fs.unlinkSync(temporaryPath);
  }
}

function findDailyArchiveDirectories(searchRoot) {
  const result = [];
  const stack = [searchRoot];
  const skipped = new Set(["运行环境", "程序", "缓存", "生成文件", "node_modules"]);
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, {withFileTypes: true});
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = path.join(current, entry.name);
      if (entry.name === "每日完整数据") {
        result.push(target);
        continue;
      }
      if (!skipped.has(entry.name)) stack.push(target);
    }
  }
  return result;
}

function discoverCandidates(searchRoot) {
  const filesByDate = new Map();
  for (const directory of findDailyArchiveDirectories(searchRoot)) {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      if (!entry.isFile()) continue;
      const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})_完整复盘数据\.json$/u);
      if (!match) continue;
      const date = match[1];
      const filePath = path.join(directory, entry.name);
      const candidate = {date, filePath, bytes: fs.statSync(filePath).size};
      if (!filesByDate.has(date)) filesByDate.set(date, []);
      filesByDate.get(date).push(candidate);
    }
  }
  const candidates = new Map();
  for (const [date, files] of filesByDate.entries()) {
    const finalists = files.sort((left, right) => right.bytes - left.bytes).slice(0, 8);
    for (const candidate of finalists) {
      const value = readJson(candidate.filePath, null);
      if (!value || compareLegacyArchives(value, {}, date) <= 0) continue;
      const qualified = {...candidate, value};
      const existing = candidates.get(date);
      if (!existing || compareLegacyArchives(qualified.value, existing.value, date) > 0) {
        candidates.set(date, qualified);
      }
    }
  }
  return candidates;
}

function chooseBestCandidates(candidates, limit) {
  return [...candidates.values()]
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, limit)
    .sort((left, right) => left.date.localeCompare(right.date));
}

function policyNewsForDate(existingHistoryDir, date, legacy) {
  const existing = readJson(path.join(existingHistoryDir, date, "policy-news.json"), null);
  if (existing) return existing;
  if (legacy.policyNews && typeof legacy.policyNews === "object") return legacy.policyNews;
  return {
    version: 3,
    tradeDate: date,
    generatedAt: "",
    items: [],
    eventChains: [],
    sourceNote: "该历史交易日没有留存可验证的政策新闻快照，未生成替代内容。",
  };
}

function annotationsForDate(existingHistoryDir, date) {
  return readJson(path.join(existingHistoryDir, date, "indices.json"), {})?.annotations || null;
}

function resetWorkApp(workApp) {
  fs.rmSync(workApp, {recursive: true, force: true});
  fs.mkdirSync(path.join(workApp, "data"), {recursive: true});
}

function generatedLimitations(root, date) {
  const indices = readJson(path.join(root, "indices.json"), {});
  const sectors = readJson(path.join(root, "sectors.json"), {});
  const items = Array.isArray(indices.items) ? indices.items : [];
  const totalIndexPoints = items.reduce((sum, item) => sum + (Array.isArray(item.points) ? item.points.length : 0), 0);
  const sectorRows = [
    ...(Array.isArray(sectors.industry?.rows) ? sectors.industry.rows : []),
    ...(Array.isArray(sectors.concept?.rows) ? sectors.concept.rows : []),
  ];
  const timelineCount = Math.max(
    Number(sectors.industry?.flowTimelineCount || 0) + Number(sectors.concept?.flowTimelineCount || 0),
    sectorRows.filter((item) => Array.isArray(item?.points) && item.points.length > 1).length,
  );
  const limitations = [];
  if (items.length < 8 || totalIndexPoints < 1500) limitations.push("指数分时采样少于完整近期归档基准");
  if (timelineCount < 20) limitations.push("部分板块分钟资金样本在原交易日未留存，未使用模拟数据补写");
  return {date, items: items.length, totalIndexPoints, timelineCount, limitations};
}

function mergeGeneratedDate(generatedDir, existingDir, targetDir, date) {
  fs.mkdirSync(targetDir, {recursive: true});
  const preservedModules = [];
  const moduleQuality = {};
  for (const [key, filename] of Object.entries(DATASETS)) {
    const incoming = readJson(path.join(generatedDir, filename), null);
    const existing = readJson(path.join(existingDir, filename), null);
    const selected = selectBetterDataset(key, incoming, existing);
    if (selected.source === "existing") preservedModules.push(key);
    moduleQuality[key] = selected.quality;
    if (selected.value) writeJsonAtomic(path.join(targetDir, filename), selected.value);
  }
  const selectedHealth = selectBetterDataset(
    "health",
    readJson(path.join(generatedDir, "health.json"), null),
    readJson(path.join(existingDir, "health.json"), null),
  );
  if (selectedHealth.source === "existing") preservedModules.push("health");
  moduleQuality.health = selectedHealth.quality;
  if (selectedHealth.value) writeJsonAtomic(path.join(targetDir, "health.json"), selectedHealth.value);
  const limitations = generatedLimitations(targetDir, date);
  writeJsonAtomic(path.join(targetDir, "manifest.json"), {
    version: 2,
    tradeDate: date,
    repairedAt: new Date().toISOString(),
    status: limitations.limitations.length ? "warning" : "ok",
    source: "本机历次版本留存的真实交易日快照择优合并",
    methodology: "逐日期比较指数分时采样、板块资金采样、市场明细和文件完整性；不生成模拟数据。",
    files: [...Object.values(DATASETS), "health.json"],
    preservedModules,
    moduleQuality,
    limitations: limitations.limitations,
  });
  return limitations;
}

function main() {
  const searchRoot = path.resolve(argument("--search-root"));
  const runtimeRoot = path.resolve(argument("--runtime-root"));
  const limit = Math.max(1, Math.min(60, Number(argument("--limit", "30")) || 30));
  if (!fs.existsSync(searchRoot)) throw new Error(`历史搜索目录不存在：${searchRoot}`);
  if (!fs.existsSync(path.join(runtimeRoot, "程序", "应用", "data"))) {
    throw new Error(`运行版本目录无效：${runtimeRoot}`);
  }

  const historyRoot = path.join(runtimeRoot, "数据历史");
  const dailyDir = path.join(historyRoot, "每日完整数据");
  const structuredDir = path.join(historyRoot, "结构化复盘历史");
  const appDataDir = path.join(runtimeRoot, "程序", "应用", "data");
  fs.mkdirSync(dailyDir, {recursive: true});
  fs.mkdirSync(structuredDir, {recursive: true});

  progress(`scan ${searchRoot}`);
  const selected = chooseBestCandidates(discoverCandidates(searchRoot), limit);
  progress(`selected ${selected.length} dates`);
  if (!selected.length) throw new Error("没有发现可验证的真实历史归档。");

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "a-share-history-repair-"));
  const workApp = path.join(workRoot, "app");
  const generatedRoot = path.join(workRoot, "structured");
  const results = [];
  try {
    for (const candidate of selected) {
      const date = candidate.date;
      progress(`rebuild ${date}`);
      const dailyTarget = path.join(dailyDir, `${date}_完整复盘数据.json`);
      fs.copyFileSync(candidate.filePath, dailyTarget);
      progress(`copied legacy ${date}`);
      resetWorkApp(workApp);
      progress(`reset work app ${date}`);
      const legacy = JSON.parse(JSON.stringify(candidate.value));
      const annotations = annotationsForDate(structuredDir, date);
      if (annotations) legacy.indexAnnotations = annotations;
      progress(`export ${date}`);
      exportOptimizedAppData({
        appDir: workApp,
        marketData: legacy,
        diagnosis: legacy.diagnosis || {},
        structure: legacy.marketStructure || {},
        flowAnalysis: legacy.flowAnalysis || {},
        policyNews: policyNewsForDate(structuredDir, date, legacy),
        archiveDir: generatedRoot,
        legacyArchiveDir: dailyDir,
      });
      progress(`exported ${date}`);
      const generatedDir = path.join(generatedRoot, date);
      const targetDir = path.join(structuredDir, date);
      const limitations = mergeGeneratedDate(generatedDir, targetDir, targetDir, date);
      progress(`merged ${date}`);
      results.push({
        date,
        sourcePath: candidate.filePath,
        bytes: candidate.bytes,
        legacyQuality: legacyArchiveQuality(candidate.value, date),
        ...limitations,
      });
      progress(`completed ${date}`);
    }

    const dates = results.map((item) => ({date: item.date, type: "structured"})).sort((a, b) => b.date.localeCompare(a.date));
    const historyIndex = {
      version: 2,
      generatedAt: new Date().toISOString(),
      latestDate: dates[0]?.date || "",
      count: dates.length,
      source: "真实历史快照择优修复",
      dates,
    };
    writeJsonAtomic(path.join(structuredDir, "index.json"), historyIndex);
    writeJsonAtomic(path.join(appDataDir, "history-index.json"), historyIndex);
    progress("write report");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      runtimeRoot,
      selectedDates: dates.length,
      completeDates: results.filter((item) => item.limitations.length === 0).length,
      limitedDates: results.filter((item) => item.limitations.length > 0).map((item) => ({date: item.date, limitations: item.limitations})),
      results,
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(workRoot, {recursive: true, force: true});
  }
}

main();
