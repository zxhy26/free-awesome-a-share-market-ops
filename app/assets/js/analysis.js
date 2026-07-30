export const DEFINITIONS = {
  brokenRate: "炸板率 = 当日炸板数量 ÷（当日涨停数量 + 当日炸板数量），分母为当日触及过涨停的股票总数。",
  redRate: "红盘率 = 上涨家数 ÷ 上涨、下跌和平盘家数之和。",
  promotionRate: "昨日涨停晋级率 = 今日继续涨停数量 ÷ 昨日涨停总数。",
  yesterdayBrokenPositive: "昨日炸板红盘修复率 = 今日上涨的昨日炸板数量 ÷ 昨日炸板总数。",
  yesterdayBrokenLimit: "昨日炸板涨停修复率 = 今日涨停的昨日炸板数量 ÷ 昨日炸板总数。",
  limitUpRate: "涨停率 = 当日涨停数量 ÷ 全市场股票数量。",
};

export function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function safeRate(numerator, denominator) {
  const n = finiteNumber(numerator);
  const d = finiteNumber(denominator);
  return n === null || d === null || d <= 0 ? null : (n / d) * 100;
}

export function formatNumber(value, digits = 0) {
  const number = finiteNumber(value);
  if (number === null) return "暂无数据";
  return number.toLocaleString("zh-CN", {minimumFractionDigits: digits, maximumFractionDigits: digits});
}

export function formatPercent(value, digits = 1) {
  const number = finiteNumber(value);
  return number === null ? "暂无数据" : `${number.toFixed(digits)}%`;
}

export function formatYi(value) {
  const number = finiteNumber(value);
  if (number === null) return "暂无数据";
  if (Math.abs(number) >= 10000) return `${(number / 10000).toFixed(2)}万亿`;
  return `${number.toFixed(1)}亿`;
}

export function signed(value, digits = 2, suffix = "") {
  const number = finiteNumber(value);
  if (number === null) return "--";
  return `${number > 0 ? "+" : ""}${number.toFixed(digits)}${suffix}`;
}

export function valueClass(value) {
  const number = finiteNumber(value);
  return number === null || number === 0 ? "neutral" : number > 0 ? "gain" : "loss";
}

function groupMetrics(market, groupName) {
  const group = market?.[groupName] || {};
  const count = finiteNumber(group.count);
  const upCount = finiteNumber(group.upCount);
  const limitUpCount = finiteNumber(group.limitUpCount);
  return {
    count,
    upCount,
    limitUpCount,
    positiveRate: finiteNumber(group.positiveRate) ?? safeRate(upCount, count),
    limitRate: safeRate(limitUpCount, count),
    avgChangePct: finiteNumber(group.avgChangePct),
    strength: group.strength || "数据不足",
  };
}

function recentAverage(days, key) {
  const values = (days || []).map((day) => finiteNumber(day?.[key])).filter((value) => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function analyzeMarket(marketData, stocksData, config, precomputed = {}) {
  const market = marketData.market || {};
  const thresholds = config.emotion || {};
  const yesterdayLimit = groupMetrics(market, "yesterdayLimitUp");
  const yesterdayBroken = groupMetrics(market, "yesterdayBroken");
  const totalBreadth = [market.upCount, market.downCount, market.flatCount]
    .map(finiteNumber).filter((value) => value !== null).reduce((sum, value) => sum + value, 0);
  const redRate = safeRate(market.upCount, totalBreadth);
  const recent = (market.recentDays || []).filter((day) => day?.date && day.date !== market.tradeDate).slice(0, 5);
  const avgAmount = recentAverage(recent, "totalAmountYi");
  const amountChange = avgAmount ? ((finiteNumber(market.totalAmountYi) - avgAmount) / avgAmount) * 100 : null;
  const highestStreak = finiteNumber(precomputed.highestStreak) ?? Math.max(0, ...(stocksData?.groups?.limitUp?.rows || []).map((row) => finiteNumber(row.streak) || 1));
  let score = 0;
  const positive = [];
  const negative = [];
  const add = (points, text) => {
    score += points;
    (points >= 0 ? positive : negative).push(text);
  };
  const limitUp = finiteNumber(market.limitUpCount);
  const limitDown = finiteNumber(market.limitDownCount);
  if (limitUp !== null) {
    if (limitUp >= (thresholds.strong?.limitUpMin ?? 70)) add(3, `涨停${limitUp}家，短线活跃度较高`);
    else if (limitUp >= (thresholds.repair?.limitUpMin ?? 40)) add(1, `涨停${limitUp}家，情绪具备修复基础`);
    else add(-2, `涨停仅${limitUp}家，赚钱效应偏弱`);
  }
  if (limitDown !== null) {
    if (limitDown <= (thresholds.strong?.limitDownMax ?? 5)) add(2, `跌停${limitDown}家，极端负反馈较少`);
    else if (limitDown >= (thresholds.ebb?.limitDownMin ?? 20)) add(-3, `跌停${limitDown}家，风险扩散明显`);
    else if (limitDown > (thresholds.weak?.limitDownMin ?? 10)) add(-1, `跌停${limitDown}家，风险仍需观察`);
  }
  if (yesterdayLimit.limitRate !== null) {
    if (yesterdayLimit.limitRate >= (thresholds.strong?.promotionRateMin ?? 25)) add(2, `昨日涨停晋级率${formatPercent(yesterdayLimit.limitRate)}`);
    else if (yesterdayLimit.limitRate < (thresholds.divergence?.promotionRateMax ?? 15)) add(-2, `昨日涨停晋级率仅${formatPercent(yesterdayLimit.limitRate)}`);
  }
  if (redRate !== null) {
    if (redRate >= (thresholds.strong?.redRateMin ?? 55)) add(1, `全市场红盘率${formatPercent(redRate)}`);
    else if (redRate <= (thresholds.weak?.redRateMax ?? 35)) add(-2, `全市场红盘率仅${formatPercent(redRate)}`);
  }
  if (yesterdayBroken.positiveRate !== null) {
    if (yesterdayBroken.positiveRate >= (thresholds.repair?.brokenRepairMin ?? 55)) add(1, `昨日炸板红盘修复率${formatPercent(yesterdayBroken.positiveRate)}`);
    else if (yesterdayBroken.positiveRate < 35) add(-1, `昨日炸板红盘修复率仅${formatPercent(yesterdayBroken.positiveRate)}`);
  }
  if (amountChange !== null) {
    if (amountChange >= 10) add(1, `成交额较近5日均值增加${formatPercent(amountChange)}`);
    else if (amountChange <= -10) add(-1, `成交额较近5日均值减少${formatPercent(Math.abs(amountChange))}`);
  }
  const structure = marketData.marketStructure || {};
  if (structure.mainline?.length) {
    const sustained = structure.mainline.some((row) => (finiteNumber(row.continuingCount) || 0) > 0 || (finiteNumber(row.historyHits) || 0) >= 2);
    add(sustained ? 1 : 0, sustained ? "主线存在跨日延续" : "主线已形成，但持续性仍待确认");
  }
  if (structure.interSectorSwitch) add(-1, "主线发生板块间切换，资金稳定性下降");

  let stage = "分化";
  if ([limitUp, limitDown, yesterdayLimit.limitRate].some((value) => value === null)) stage = "数据不足";
  else if (score >= 7) stage = "强势";
  else if (score >= 3) stage = "修复";
  else if (score <= -5) stage = "退潮";
  else if (score <= -2) stage = "弱势";

  const diagnosisTone = String(precomputed.diagnosis?.tone || "");
  if (diagnosisTone && diagnosisTone !== "数据不足") {
    if (/强势|进攻/.test(diagnosisTone) && !/分化/.test(diagnosisTone)) stage = "强势";
    else if (/修复/.test(diagnosisTone) && !/分化/.test(diagnosisTone)) stage = "修复";
    else if (/退潮/.test(diagnosisTone)) stage = "退潮";
    else if (/弱势|防守/.test(diagnosisTone)) stage = "弱势";
    else if (/分化|震荡/.test(diagnosisTone)) stage = "分化";
  }

  let riskScore = 2;
  const riskReasons = [...negative];
  if ((limitDown || 0) >= 20) riskScore += 2;
  else if ((limitDown || 0) >= 10) riskScore += 1;
  if ((yesterdayLimit.limitRate ?? 100) < 15) riskScore += 1;
  if (amountChange !== null && amountChange <= -10) riskScore += 1;
  if (structure.interSectorSwitch) riskScore += 1;
  if (/高波动|分化/.test(diagnosisTone)) riskScore += 1;
  if (/弱势|退潮|防守/.test(diagnosisTone)) riskScore += 1;
  if ((limitUp || 0) >= 70 && (limitDown || 0) <= 5) riskScore -= 1;
  riskScore = Math.max(0, Math.min(4, riskScore));
  const riskLevels = ["低", "中低", "中", "中高", "高"];

  return {
    stage,
    score,
    explanation: [
      ...(precomputed.diagnosis?.reasons || []).slice(0, 1),
      ...(precomputed.diagnosis?.risks || []).slice(0, 1),
      ...positive.slice(0, 1),
      ...negative.slice(0, 1),
    ].join("；") || "关键数据不足，暂不确认情绪阶段。",
    positives: positive,
    negatives: negative,
    risk: {level: riskLevels[riskScore], score: riskScore, explanation: riskReasons.slice(0, 2).join("；") || "主要风险指标暂未出现明显异常。"},
    metrics: {redRate, amountChange, avgAmount, highestStreak, yesterdayLimit, yesterdayBroken},
  };
}

export function buildMoneyMetrics(marketData, stocksData, precomputed = {}) {
  const market = marketData.market || {};
  const limitRows = stocksData?.groups?.limitUp?.rows || [];
  const yesterdayLimit = groupMetrics(market, "yesterdayLimitUp");
  const yesterdayBroken = groupMetrics(market, "yesterdayBroken");
  const limitUpCount = finiteNumber(market.limitUpCount);
  const brokenCount = finiteNumber(market.brokenCount);
  const touchedLimitCount = finiteNumber(market.touchedLimitCount) ??
    (limitUpCount !== null && brokenCount !== null ? limitUpCount + brokenCount : null);
  const brokenRate = finiteNumber(market.brokenRate) ?? safeRate(brokenCount, touchedLimitCount);
  const firstBoard = finiteNumber(precomputed.firstBoard) ?? limitRows.filter((row) => (finiteNumber(row.streak) || 1) <= 1).length;
  const secondBoard = finiteNumber(precomputed.secondBoard) ?? limitRows.filter((row) => finiteNumber(row.streak) === 2).length;
  const highBoard = finiteNumber(precomputed.highBoard) ?? limitRows.filter((row) => (finiteNumber(row.streak) || 0) >= 3).length;
  const highest = finiteNumber(precomputed.highestStreak) ?? Math.max(0, ...limitRows.map((row) => finiteNumber(row.streak) || 1));
  const twentyCm = finiteNumber(precomputed.twentyCm) ?? limitRows.filter((row) => /^(?:30|68)/.test(String(row.code || "")) && !/^8/.test(String(row.code || ""))).length;
  const tenCm = finiteNumber(precomputed.tenCm) ?? limitRows.filter((row) => !/^(?:30|68|8|4)/.test(String(row.code || "")) && !/ST/i.test(String(row.name || ""))).length;
  const breadthTotal = [market.upCount, market.downCount, market.flatCount].map(finiteNumber).filter((value) => value !== null).reduce((sum, value) => sum + value, 0);
  return [
    {label: "涨停数量", value: limitUpCount, format: formatNumber, className: "gain", tip: "按当日涨停池统计。"},
    {label: "跌停数量", value: finiteNumber(market.limitDownCount), format: formatNumber, className: "loss", tip: "按当日跌停池统计。"},
    {label: "当日炸板数量", value: brokenCount, format: formatNumber, className: "neutral", tip: DEFINITIONS.brokenRate},
    {label: "炸板率", value: brokenRate, format: formatPercent, className: "neutral", tip: DEFINITIONS.brokenRate},
    {label: "市场红盘率", value: safeRate(market.upCount, breadthTotal), format: formatPercent, className: "neutral", tip: DEFINITIONS.redRate},
    {label: "昨日涨停红盘率", value: yesterdayLimit.positiveRate, format: formatPercent, className: "neutral", tip: DEFINITIONS.redRate},
    {label: "昨日涨停晋级率", value: yesterdayLimit.limitRate, format: formatPercent, className: "neutral", tip: DEFINITIONS.promotionRate},
    {label: "炸板红盘修复率", value: yesterdayBroken.positiveRate, format: formatPercent, className: "neutral", tip: DEFINITIONS.yesterdayBrokenPositive},
    {label: "炸板涨停修复率", value: yesterdayBroken.limitRate, format: formatPercent, className: "neutral", tip: DEFINITIONS.yesterdayBrokenLimit},
    {label: "首板数量", value: firstBoard, format: formatNumber, className: "neutral", tip: "连板数为1的涨停股票数量。"},
    {label: "二板数量", value: secondBoard, format: formatNumber, className: "neutral", tip: "连板数为2的涨停股票数量。"},
    {label: "三板及以上", value: highBoard, format: formatNumber, className: "neutral", tip: "连板数大于等于3的涨停股票数量。"},
    {label: "最高连板", value: highest, format: (value) => value ? `${value}板` : "暂无数据", className: "neutral", tip: "当日涨停池中的最高连续涨停天数。"},
    {label: "20厘米涨停", value: twentyCm, format: formatNumber, className: "gain", tip: "创业板和科创板中按20%涨停制度统计。"},
    {label: "10厘米涨停", value: tenCm, format: formatNumber, className: "gain", tip: "主板非ST股票按10%涨停制度统计。"},
  ];
}

export function summarizeMoneyEffect(precomputed = {}) {
  const readMetric = (value) => value === null || value === undefined || value === "" ? null : finiteNumber(value);
  const firstBoard = readMetric(precomputed.firstBoard);
  const secondBoard = readMetric(precomputed.secondBoard);
  const highBoard = readMetric(precomputed.highBoard);
  const highestStreak = readMetric(precomputed.highestStreak);
  const twentyCm = readMetric(precomputed.twentyCm);
  const coreValues = [firstBoard, secondBoard, highBoard, highestStreak];

  if (coreValues.some((value) => value === null)) {
    return {
      level: "insufficient",
      text: "短线赚钱效应数据不足：首板、二板、高标或最高连板尚未完整同步，暂不作强弱判断。",
    };
  }

  let level = "weak";
  let lead = "短线赚钱效应偏弱";
  let conclusion = "首板扩散与连板接力均不足，短线交易难度较高";

  if (firstBoard >= 50 && secondBoard >= 8 && highBoard >= 5 && highestStreak >= 5) {
    level = "strong";
    lead = "短线赚钱效应较强";
    conclusion = "首板扩散与高标高度同步增强，短线接力较顺畅";
  } else if (firstBoard >= 40 && secondBoard >= 6 && highBoard >= 3 && highestStreak >= 3) {
    level = "active";
    lead = "短线赚钱效应结构活跃";
    conclusion = highestStreak >= 5
      ? "低位扩散与高标接力均有表现，持续性仍看次日承接"
      : "接力有承接，但高标高度仍待加强";
  } else if (firstBoard >= 25 || secondBoard >= 4 || highestStreak >= 3) {
    level = "divided";
    lead = "短线赚钱效应分化";
    conclusion = firstBoard >= 30
      ? "机会主要集中在首板，高位接力持续性不足"
      : "局部接力尚存，但赚钱机会的扩散范围有限";
  }

  const details = [
    `首板${formatNumber(firstBoard)}只`,
    `二板${formatNumber(secondBoard)}只`,
    `三板及以上${formatNumber(highBoard)}只`,
    `最高${formatNumber(highestStreak)}连板`,
  ];
  if (twentyCm !== null) details.push(`20厘米涨停${formatNumber(twentyCm)}只`);

  return {level, text: `${lead}：${details.join("、")}；${conclusion}。`};
}

export function dataFreshness(marketData, validation = {}) {
  const tradeDate = marketData.tradeDate || marketData.market?.tradeDate || "";
  const syncedAt = marketData.syncedAt || marketData.market?.fetchedAt || "";
  const now = new Date();
  const trade = tradeDate ? new Date(`${tradeDate}T15:00:00`) : null;
  const sync = syncedAt ? new Date(String(syncedAt).replace(/\//g, "-").replace(" ", "T")) : null;
  const ageMinutes = sync && Number.isFinite(sync.getTime()) ? Math.max(0, Math.floor((now - sync) / 60000)) : null;
  const sameDay = trade && now.toDateString() === trade.toDateString();
  const minute = now.getHours() * 60 + now.getMinutes();
  let status = "历史数据";
  let className = "stale";
  if (!tradeDate) status = "数据可能过期";
  else if (sameDay && minute >= 555 && minute <= 900) { status = minute < 570 ? "集合竞价实时" : "实时"; className = "realtime"; }
  else if (sameDay && minute > 900) { status = "已收盘"; className = "closed"; }
  if (validation.status === "error" || validation.errors?.length) {
    status = status === "历史数据" ? "历史数据 · 部分缺失" : "部分数据缺失";
    className = "partial";
  }
  const ageText = ageMinutes === null ? "同步时间未知" : ageMinutes < 1 ? "刚刚同步" : ageMinutes < 60 ? `${ageMinutes}分钟前` : ageMinutes < 1440 ? `${Math.floor(ageMinutes / 60)}小时前` : `${Math.floor(ageMinutes / 1440)}天前`;
  return {tradeDate, syncedAt, ageMinutes, ageText, status, className};
}
