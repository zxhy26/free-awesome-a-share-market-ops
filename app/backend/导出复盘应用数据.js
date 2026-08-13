const fs = require("fs");
const path = require("path");
const {enhanceAppData} = require("./升级数据层");

const LEGACY_STRUCTURE_KEY = "high" + "Low" + "Switches";
const BANNED_GUIDANCE = /建议买入|建议卖出|加仓|减仓|止损|目标价|满仓|半仓|抄底|追涨|控制仓位|提高仓位|小仓|中等仓位|轻仓/;

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function brokenBoardStats(limitUpCount, brokenCount) {
  const limitUp = finite(limitUpCount);
  const broken = finite(brokenCount);
  if (limitUp === null || broken === null || limitUp < 0 || broken < 0) {
    return {touchedLimitCount: null, brokenRate: null};
  }
  const touchedLimitCount = limitUp + broken;
  return {
    touchedLimitCount,
    brokenRate: touchedLimitCount > 0 ? Math.round((broken / touchedLimitCount) * 1000) / 10 : null,
  };
}

function nowText() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function sanitizeLegacyFields(value) {
  if (Array.isArray(value)) return value.map(sanitizeLegacyFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== LEGACY_STRUCTURE_KEY)
    .map(([key, item]) => [key, sanitizeLegacyFields(item)]));
}

function sanitizeGuidance(value) {
  return String(value || "")
    .split(/(?<=[。；])/)
    .filter((sentence) => !BANNED_GUIDANCE.test(sentence))
    .join("")
    .trim();
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(temporaryPath, content, "utf8");
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (_) {
    fs.copyFileSync(temporaryPath, filePath);
    fs.unlinkSync(temporaryPath);
  }
}

function writeJson(filePath, value) {
  atomicWrite(filePath, JSON.stringify(value));
}

function duplicateCodes(rows) {
  const seen = new Set();
  const duplicates = new Set();
  for (const row of rows || []) {
    const code = String(row?.code || "");
    if (!code) continue;
    if (seen.has(code)) duplicates.add(code);
    seen.add(code);
  }
  return [...duplicates];
}

function validateMarketData(marketData) {
  const market = marketData?.market || {};
  const definitions = [
    ["涨停", market.limitUpCount, market.limitUpStocks],
    ["跌停", market.limitDownCount, market.limitDownStocks],
    ["当日炸板", market.brokenCount, market.brokenStocks],
    ["昨日涨停", market.yesterdayLimitUp?.count, market.yesterdayLimitUp?.stocks],
    ["昨日炸板", market.yesterdayBroken?.count, market.yesterdayBroken?.stocks],
  ];
  const errors = [];
  const warnings = [];
  const checks = {};
  for (const [label, reportedValue, rawRows] of definitions) {
    const rows = Array.isArray(rawRows) ? rawRows : [];
    const reported = finite(reportedValue);
    const consistent = reported !== null && reported === rows.length;
    checks[label] = {reported, displayed: rows.length, consistent};
    if (reported !== null && !consistent) errors.push(`${label}统计共${reported}只，当前可展示${rows.length}只`);
    const duplicates = duplicateCodes(rows);
    if (duplicates.length) errors.push(`${label}详情存在${duplicates.length}个重复股票代码`);
    const missingIdentity = rows.filter((row) => !/^\d{6}$/.test(String(row?.code || "")) || !String(row?.name || "").trim()).length;
    if (missingIdentity) errors.push(`${label}详情有${missingIdentity}条缺少代码或名称`);
    const missingCore = rows.filter((row) => finite(row?.changePct) === null || finite(row?.amountYi) === null).length;
    if (missingCore) warnings.push(`${label}详情有${missingCore}条缺少涨跌幅或成交额`);
  }
  const breadth = [market.upCount, market.downCount, market.flatCount].map(finite);
  if (breadth.some((value) => value === null)) warnings.push("全市场上涨、下跌或平盘家数不完整，红盘率暂不可核验");
  else if (finite(market.stockCount) !== null && breadth.reduce((sum, value) => sum + value, 0) !== finite(market.stockCount)) warnings.push("市场涨跌家数之和与股票总数不一致");
  const structureRows = [...(marketData?.marketStructure?.mainline || []), ...(marketData?.marketStructure?.subline || [])];
  if (finite(market.limitUpCount) !== null && structureRows.some((row) => (finite(row.limitUpCount) || 0) > finite(market.limitUpCount))) errors.push("存在板块涨停数量超过全市场涨停数量");
  const tradeDate = market.tradeDate || marketData?.index?.tradeDate || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) errors.push("交易日期格式不正确");
  if (market.brokenQuoteDate && market.brokenQuoteDate !== tradeDate) errors.push("当日炸板池日期与交易日期不一致");
  const calculatedBroken = brokenBoardStats(market.limitUpCount, market.brokenCount);
  const reportedTouched = finite(market.touchedLimitCount);
  const reportedBrokenRate = finite(market.brokenRate);
  checks["炸板率"] = {
    reportedCount: finite(market.brokenCount),
    touchedLimitCount: reportedTouched,
    calculatedTouchedLimitCount: calculatedBroken.touchedLimitCount,
    reportedRate: reportedBrokenRate,
    calculatedRate: calculatedBroken.brokenRate,
    consistent: calculatedBroken.touchedLimitCount !== null &&
      reportedTouched === calculatedBroken.touchedLimitCount &&
      reportedBrokenRate !== null &&
      Math.abs(reportedBrokenRate - calculatedBroken.brokenRate) < 0.05,
  };
  if (calculatedBroken.touchedLimitCount === null || reportedTouched === null || reportedBrokenRate === null) {
    warnings.push("当日炸板数量、触及涨停数量或炸板率不完整");
  } else {
    if (reportedTouched !== calculatedBroken.touchedLimitCount) errors.push(`触及涨停数量应为${calculatedBroken.touchedLimitCount}，当前为${reportedTouched}`);
    if (Math.abs(reportedBrokenRate - calculatedBroken.brokenRate) >= 0.05) errors.push(`炸板率应为${calculatedBroken.brokenRate.toFixed(1)}%，当前为${reportedBrokenRate.toFixed(1)}%`);
  }
  return {
    status: errors.length ? "error" : warnings.length ? "warning" : "ok",
    label: errors.length ? "部分数据异常" : warnings.length ? "部分数据缺失" : "数据校验通过",
    checkedAt: nowText(),
    errors,
    warnings,
    checks,
  };
}

function compactHistory(history) {
  return {
    version: history?.version || 1,
    updatedAt: history?.updatedAt || "",
    days: (history?.days || []).slice(0, 60).map((day) => ({
      date: day.date,
      fetchedAt: day.fetchedAt,
      source: day.source,
      market: day.market ? {
        stockCount: finite(day.market.stockCount),
        limitUpCount: finite(day.market.limitUpCount),
        limitDownCount: finite(day.market.limitDownCount),
        brokenCount: finite(day.market.brokenCount),
        touchedLimitCount: finite(day.market.touchedLimitCount),
        brokenRate: finite(day.market.brokenRate),
        upCount: finite(day.market.upCount),
        downCount: finite(day.market.downCount),
        flatCount: finite(day.market.flatCount),
        totalAmountYi: finite(day.market.totalAmountYi),
        totalVolumeYiHands: finite(day.market.totalVolumeYiHands),
      } : null,
      indices: day.indices || [],
      flows: day.flows || {industry: [], concept: []},
      structure: day.structure ? {summary: day.structure.summary, mainline: day.structure.mainline, subline: day.structure.subline, interSectorSwitch: day.structure.interSectorSwitch} : null,
      diagnosis: day.diagnosis || null,
    })),
  };
}

function enrichStructure(rawStructure) {
  const structure = sanitizeLegacyFields(rawStructure || {});
  const enrich = (row) => {
    const limitCluster = Math.min(6, (finite(row.limitUpCount) || 0) * 1.5);
    const continuity = Math.min(3, (finite(row.continuingCount) || 0) * 1.5);
    const history = Math.min(3, finite(row.historyHits) || 0);
    const negative = -Math.min(4, (finite(row.limitDownCount) || 0) * 2);
    const total = finite(row.score) || 0;
    const flow = Math.round((total - limitCluster - continuity - history - negative) * 100) / 100;
    return {...row, scoreBreakdown: row.scoreBreakdown || {flow, limitCluster, continuity, history, negative}};
  };
  return {...structure, mainline: (structure.mainline || []).map(enrich), subline: (structure.subline || []).map(enrich)};
}

function compactGroup(group) {
  if (!group) return {};
  const {stocks, ...rest} = group;
  return {...rest, displayedCount: Array.isArray(stocks) ? stocks.length : 0};
}

function compactMarket(marketData, validation, structure) {
  const market = marketData.market || {};
  return {
    version: 3,
    generatedAt: nowText(),
    tradeDate: market.tradeDate || marketData.index?.tradeDate || "",
    syncedAt: marketData.syncedAt || market.fetchedAt || marketData.index?.fetchedAt || "",
    sourceNote: marketData.sourceNote || "",
    validation,
    market: {
      tradeDate: market.tradeDate,
      fetchedAt: market.fetchedAt,
      stockCount: finite(market.stockCount),
      limitUpCount: finite(market.limitUpCount),
      limitDownCount: finite(market.limitDownCount),
      brokenCount: finite(market.brokenCount),
      touchedLimitCount: finite(market.touchedLimitCount),
      brokenRate: finite(market.brokenRate),
      brokenQuoteDate: market.brokenQuoteDate || "",
      brokenSource: market.brokenSource || "",
      upCount: finite(market.upCount),
      downCount: finite(market.downCount),
      flatCount: finite(market.flatCount),
      totalAmountYi: finite(market.totalAmountYi),
      totalVolumeYiHands: finite(market.totalVolumeYiHands),
      recentDays: market.recentDays || [],
      yesterdayLimitUp: compactGroup(market.yesterdayLimitUp),
      yesterdayBroken: compactGroup(market.yesterdayBroken),
    },
    marketStructure: structure,
    marketHistory: compactHistory(marketData.marketHistory),
  };
}

function stockGroups(marketData) {
  const market = marketData.market || {};
  return {
    version: 3,
    tradeDate: market.tradeDate || marketData.index?.tradeDate || "",
    syncedAt: marketData.syncedAt || market.fetchedAt || "",
    groups: {
      limitUp: {reportedCount: finite(market.limitUpCount) ?? (market.limitUpStocks || []).length, rows: market.limitUpStocks || []},
      limitDown: {reportedCount: finite(market.limitDownCount) ?? (market.limitDownStocks || []).length, rows: market.limitDownStocks || []},
      broken: {reportedCount: finite(market.brokenCount) ?? (market.brokenStocks || []).length, rows: market.brokenStocks || []},
      yesterdayLimit: {reportedCount: finite(market.yesterdayLimitUp?.count) ?? (market.yesterdayLimitUp?.stocks || []).length, rows: market.yesterdayLimitUp?.stocks || []},
      yesterdayBroken: {reportedCount: finite(market.yesterdayBroken?.count) ?? (market.yesterdayBroken?.stocks || []).length, rows: market.yesterdayBroken?.stocks || []},
    },
  };
}

function compactDiagnosis(diagnosis, structure, marketData) {
  const market = marketData.market || {};
  const value = diagnosis || {};
  return {
    score: finite(value.score),
    tone: value.tone || "数据不足",
    observation: sanitizeGuidance(value.action) || "结合指数、市场广度、量能和板块延续性继续观察。",
    reasons: value.reasons || [],
    risks: value.risks || [],
    averages: value.averages || {},
    compares: value.compares || {},
    indexBreadth: value.indexBreadth || {},
    flowBalance: value.flowBalance || {},
    historyDaysUsed: finite(value.historyDaysUsed) ?? finite(structure.historyDaysUsed),
    dataBasis: `交易日${market.tradeDate || "--"}，涨停${market.limitUpCount ?? "--"}家、跌停${market.limitDownCount ?? "--"}家、成交额${market.totalAmountYi ?? "--"}亿元。`,
  };
}

function diagnosisFromQuant(quantData) {
  const regime = quantData?.amvRegime || {};
  const text = sanitizeGuidance(regime.text);
  const scoreMatch = String(regime.text || "").match(/综合强度评分\s*([-+]?\d+(?:\.\d+)?)/);
  const historyMatch = String(regime.text || "").match(/历史样本\s*(\d+)\s*个交易日/);
  const sentences = text.split(/[。；]/).map((item) => item.trim()).filter(Boolean);
  return {
    tone: regime.state || "数据不足",
    score: scoreMatch ? Number(scoreMatch[1]) : null,
    action: sentences.at(-1) || "结合指数、市场广度、量能和板块延续性继续观察。",
    reasons: sentences.slice(0, 3).map((item) => `${item}。`),
    risks: [],
    historyDaysUsed: historyMatch ? Number(historyMatch[1]) : null,
  };
}

function fallbackFlowAnalysis(marketData) {
  const rows = [...(marketData.industry?.rows || []), ...(marketData.concept?.rows || [])]
    .filter((row) => finite(row.amount) !== null);
  const describe = (row, direction) => ({
    name: row.tdxName || row.name || "--",
    amount: finite(row.amount),
    behavior: direction === "in" ? "资金净流入显示该方向获得阶段性主动配置，需继续核对持续性。" : "资金净流出显示该方向出现兑现或轮动，需观察尾盘和下一交易日是否回流。",
    policyNews: "政策和消息因素以公开行业信息、公司公告与盘中异动核验为准，不使用传闻替代。",
    macroGeo: "宏观与地缘影响需结合利率、风险偏好、供应链和外需暴露度判断。",
    micro: "微观验证看成交额、涨停集群、龙头承接和成分股扩散。",
  });
  return {
    inflow: rows.filter((row) => row.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 3).map((row) => describe(row, "in")),
    outflow: rows.filter((row) => row.amount < 0).sort((a, b) => a.amount - b.amount).slice(0, 3).map((row) => describe(row, "out")),
  };
}

function moneyEffectSummary(marketData) {
  const market = marketData.market || {};
  const limitRows = market.limitUpStocks || [];
  const streak = (row) => finite(row.streak) || 1;
  return {
    firstBoard: limitRows.filter((row) => streak(row) <= 1).length,
    secondBoard: limitRows.filter((row) => streak(row) === 2).length,
    highBoard: limitRows.filter((row) => streak(row) >= 3).length,
    highestStreak: Math.max(0, ...limitRows.map(streak)),
    twentyCm: limitRows.filter((row) => /^(?:30|68)/.test(String(row.code || "")) && !/^8/.test(String(row.code || ""))).length,
    tenCm: limitRows.filter((row) => !/^(?:30|68|8|4)/.test(String(row.code || "")) && !/ST/i.test(String(row.name || ""))).length,
  };
}

function compactQuant(data) {
  if (!data) return null;
  const rows = (data.formal || data.allRows || []).filter((row) => row && (row.official !== false) && (row.signals || []).length);
  const marketRegime = data.marketRegime || data.amvRegime || {state: "数据不足", text: "市场环境只作提示，不直接过滤股票。"};
  const compactRegime = {...marketRegime, text: sanitizeGuidance(marketRegime.text)};
  return {
    version: finite(data.version) || 4,
    ruleVersion: data.ruleVersion || "",
    ruleBasis: data.ruleBasis || "",
    ruleOverrides: data.ruleOverrides || {},
    minimumHistoryDays: finite(data.minimumHistoryDays),
    tradeDate: data.tradeDate || "",
    fetchedAt: data.fetchedAt || nowText(),
    error: data.error || "",
    marketRegime: compactRegime,
    amvRegime: compactRegime,
    universeCount: finite(data.universeCount),
    excludedCount: finite(data.excludedCount),
    scannedCount: finite(data.scannedCount),
    formalCount: rows.length,
    stockPoolSource: data.stockPoolSource || "",
    dataStats: data.dataStats || {},
    formalSlotStats: data.formalSlotStats || [],
    backtestBasis: data.backtestBasis || "",
    backtests: data.backtests || [],
    excludedReasons: data.excludedReasons || [],
    formal: rows.map((row) => ({
      code: String(row.code || ""),
      market: row.market,
      name: String(row.name || ""),
      date: row.date,
      close: finite(row.close),
      changePct: finite(row.changePct),
      amplitude: finite(row.amplitude),
      score: finite(row.score),
      ruleVersion: row.ruleVersion || data.ruleVersion || "",
      formulaBasis: row.formulaBasis || "",
      primarySignal: row.primarySignal || "",
      signals: row.signals || [],
      sector: row.sector || "未分类",
      concepts: row.concepts || [],
      moveReason: row.moveReason || row.businessIntro || "",
      source: row.source || "",
      strategyBacktests: row.strategyBacktests || [],
      linkedEvents: row.linkedEvents || [],
      reasons: row.reasons || [],
      risks: row.risks || [],
      metrics: row.metrics || {},
    })),
  };
}

function shouldPreserveQuantData(nextData, quantPath) {
  if (!nextData || !fs.existsSync(quantPath)) return false;
  const rows = Array.isArray(nextData.formal) ? nextData.formal : [];
  const scanned = finite(nextData.scannedCount) || 0;
  const evaluated = finite(nextData.dataStats?.evaluatedHistory) || 0;
  const unavailable = (finite(nextData.dataStats?.missingHistory) || 0)
    + (finite(nextData.dataStats?.insufficientHistory) || 0);
  const weakScan = rows.length === 0
    && scanned > 0
    && (evaluated === 0 || unavailable >= scanned * 0.8);
  if (!weakScan) return false;
  try {
    const previous = JSON.parse(fs.readFileSync(quantPath, "utf8"));
    return (finite(previous.formalCount) || 0) > 0
      && Array.isArray(previous.formal)
      && previous.formal.length > 0;
  } catch (_) {
    return false;
  }
}

function exportOptimizedAppData(options) {
  const appDir = path.resolve(options.appDir);
  const dataDir = path.join(appDir, "data");
  const quantPath = path.join(dataDir, "quant.json");
  const quantEnabled = fs.existsSync(path.join(appDir, "pages", "quant.html"));
  let quantWritten = false;
  let quantPreserved = false;
  if (quantEnabled && options.quantData) {
    const quantData = compactQuant(options.quantData);
    if (quantData) {
      if (shouldPreserveQuantData(quantData, quantPath)) {
        quantPreserved = true;
      } else {
        writeJson(quantPath, quantData);
        quantWritten = true;
      }
    }
  } else if (!quantEnabled && fs.existsSync(quantPath)) {
    fs.unlinkSync(quantPath);
  }

  const marketData = sanitizeLegacyFields(options.marketData || {});
  if (!marketData.market) {
    if (quantWritten || quantPreserved) {
      return {
        appDir,
        tradeDate: options.quantData?.tradeDate || "",
        validation: null,
        quantWritten,
        quantPreserved,
        policyNewsWritten: false,
        upgrade: null,
        quantOnly: true,
      };
    }
    throw new Error("导出失败：缺少市场数据");
  }
  const validation = marketData.validation || validateMarketData(marketData);
  const structure = enrichStructure(options.structure || marketData.marketStructure || marketData.market?.marketStructure);
  const diagnosis = compactDiagnosis(options.diagnosis || diagnosisFromQuant(options.quantData), structure, marketData);
  const flowAnalysis = options.flowAnalysis || fallbackFlowAnalysis(marketData);
  writeJson(path.join(dataDir, "market.json"), compactMarket(marketData, validation, structure));
  writeJson(path.join(dataDir, "indices.json"), {
    version: 3,
    tradeDate: marketData.index?.tradeDate || marketData.market?.tradeDate || "",
    syncedAt: marketData.syncedAt || "",
    annotations: marketData.indexAnnotations || {
      version: 1,
      tradeDate: marketData.index?.tradeDate || marketData.market?.tradeDate || "",
      syncedAt: marketData.syncedAt || "",
      source: "财联社盯盘",
      status: "unavailable",
      itemCount: 0,
      items: [],
    },
    items: Array.isArray(marketData.indices) && marketData.indices.length ? marketData.indices : [marketData.index].filter(Boolean),
  });
  writeJson(path.join(dataDir, "sectors.json"), {
    version: 3,
    tradeDate: marketData.index?.tradeDate || marketData.market?.tradeDate || "",
    syncedAt: marketData.syncedAt || "",
    industry: marketData.industry || {rows: []},
    concept: marketData.concept || {rows: []},
  });
  writeJson(path.join(dataDir, "stocks.json"), stockGroups(marketData));
  writeJson(path.join(dataDir, "analysis.json"), {
    version: 3,
    tradeDate: marketData.market?.tradeDate || marketData.index?.tradeDate || "",
    syncedAt: marketData.syncedAt || "",
    validation,
    diagnosis,
    structure,
    flowAnalysis,
    moneyEffect: moneyEffectSummary(marketData),
  });
  let policyNewsWritten = false;
  if (options.policyNews && typeof options.policyNews === "object") {
    writeJson(path.join(dataDir, "policy-news.json"), options.policyNews);
    policyNewsWritten = true;
  }
  const upgrade = enhanceAppData({
    appDir,
    archiveDir: options.archiveDir || "",
    legacyArchiveDir: options.legacyArchiveDir || "",
  });
  return {appDir, tradeDate: marketData.market?.tradeDate || "", validation, quantWritten, quantPreserved, policyNewsWritten, upgrade};
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const payloadArg = args.find((arg) => arg.startsWith("--payload="));
  const appArg = args.find((arg) => arg.startsWith("--app-dir="));
  if (!payloadArg || !appArg) throw new Error("用法：node 导出复盘应用数据.js --payload=<json> --app-dir=<目录>");
  const payload = JSON.parse(fs.readFileSync(payloadArg.slice("--payload=".length), "utf8"));
  const result = exportOptimizedAppData({...payload, appDir: appArg.slice("--app-dir=".length)});
  console.log(JSON.stringify(result));
}

module.exports = {exportOptimizedAppData, validateMarketData, sanitizeGuidance};
