import {getHealth, loadBoardIntradayTrend, loadCoreData, loadIndexContributionData, loadLiveSectorFlows, logTechnicalError, openTdxStock, requestLiveSectorFlowRefresh, requestMarketSync} from "./api.js?v=20260729-8";
import {analyzeMarket, buildMoneyMetrics, dataFreshness, finiteNumber, formatNumber, formatPercent, formatYi, signed, summarizeMoneyEffect, valueClass} from "./analysis.js?v=20260726-1";
import {createIndexCharts, createPlaybackController, marketMinuteToTime, updateIndexCharts, visiblePoints} from "./charts.js?v=20260728-5";
import {createSummaryDialog} from "./dialog.js";
import {initializePwa} from "./pwa.js?v=20260719-2";
import {createSectorFlowChart} from "./sector-flow-chart.js?v=20260727-2";
import {createCustomSectorWorkspace} from "./custom-sector-workspace.js?v=20260728-5";
import {initializeTheme} from "./theme.js";
import {inTradingWindow} from "./market-session.js?v=20260727-4";

const dom = {
  tradeDate: document.querySelector("#tradeDate"),
  marketState: document.querySelector("#marketState"),
  lastSync: document.querySelector("#lastSync"),
  syncAge: document.querySelector("#syncAge"),
  liveFlowStatus: document.querySelector("#liveFlowStatus"),
  syncButton: document.querySelector("#syncButton"),
  reloadButton: document.querySelector("#reloadButton"),
  noticeBar: document.querySelector("#noticeBar"),
  dataAlert: document.querySelector("#dataAlert"),
  emotionValue: document.querySelector("#emotionValue"),
  emotionReason: document.querySelector("#emotionReason"),
  riskGauge: document.querySelector("#riskGauge"),
  riskValue: document.querySelector("#riskValue"),
  riskReason: document.querySelector("#riskReason"),
  headlineMetrics: document.querySelector("#headlineMetrics"),
  indexGrid: document.querySelector("#indexGrid"),
  contributionTabs: document.querySelector("#contributionTabs"),
  indexContribution: document.querySelector("#indexContribution"),
  customSectorAdd: document.querySelector("#customSectorAdd"),
  customSectorCount: document.querySelector("#customSectorCount"),
  customSectorPicker: document.querySelector("#customSectorPicker"),
  customSectorPickerClose: document.querySelector("#customSectorPickerClose"),
  customSectorSearch: document.querySelector("#customSectorSearch"),
  customSectorFilters: document.querySelector("#customSectorFilters"),
  customSectorOptions: document.querySelector("#customSectorOptions"),
  customSectorGrid: document.querySelector("#customSectorGrid"),
  timeline: document.querySelector("#timeline"),
  timelineTime: document.querySelector("#timelineTime"),
  timelineEnd: document.querySelector("#timelineEnd"),
  playButton: document.querySelector("#playButton"),
  speedSelect: document.querySelector("#speedSelect"),
  industryInflowChart: document.querySelector("#industryInflowChart"),
  industryInflow: document.querySelector("#industryInflow"),
  industryOutflowChart: document.querySelector("#industryOutflowChart"),
  industryOutflow: document.querySelector("#industryOutflow"),
  conceptInflowChart: document.querySelector("#conceptInflowChart"),
  conceptInflow: document.querySelector("#conceptInflow"),
  conceptOutflowChart: document.querySelector("#conceptOutflowChart"),
  conceptOutflow: document.querySelector("#conceptOutflow"),
  marketStructure: document.querySelector("#marketStructure"),
  moneyMetrics: document.querySelector("#moneyMetrics"),
  moneySummary: document.querySelector("#moneySummary"),
  historyTable: document.querySelector("#historyTable"),
  sourceNote: document.querySelector("#sourceNote"),
  summaryBackdrop: document.querySelector("#summaryBackdrop"),
  summaryDialog: document.querySelector("#summaryDialog"),
  summaryButton: document.querySelector("#summaryButton"),
  closeSummary: document.querySelector("#closeSummary"),
  copySummary: document.querySelector("#copySummary"),
  exportSummary: document.querySelector("#exportSummary"),
  printSummary: document.querySelector("#printSummary"),
  summaryDate: document.querySelector("#summaryDate"),
  summaryContent: document.querySelector("#summaryContent"),
  structureHelp: document.querySelector("#structureHelp"),
};

const state = {
  data: null,
  analysis: null,
  charts: [],
  playback: null,
  flowCharts: {
    industry: {inflow: null, outflow: null},
    concept: {inflow: null, outflow: null},
  },
  flowRenderVersion: {industry: 0, concept: 0},
  contributionIndexKey: "",
  contributionTabsSignature: "",
  customSectorWorkspace: null,
  autoReloadTimer: 0,
  liveRefreshRunning: false,
  liveFlowTimer: 0,
  liveFlowRequestRunning: false,
  liveFlowSnapshot: null,
  liveFlowGroups: {industry: null, concept: null},
  membershipActive: false,
  contributionLoading: false,
  summaryText: "",
};

const flowScaleCache = new WeakMap();

function el(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== "") element.textContent = String(text);
  return element;
}

function showNotice(message, type = "", persistent = false) {
  dom.noticeBar.textContent = message;
  dom.noticeBar.className = `notice-bar ${type}`.trim();
  dom.noticeBar.hidden = false;
  if (!persistent) setTimeout(() => { if (dom.noticeBar.textContent === message) dom.noticeBar.hidden = true; }, 4200);
}

function contributionChartKey(chart, index = 0) {
  return String(chart?.data?.code || chart?.data?.name || index);
}

function isAshareContributionChart(chart) {
  const index = chart?.data;
  return Boolean(index && index.session !== "us" && index.code !== "IXIC" && index.name !== "纳斯达克");
}

function contributionPointAtMinute(index, minute) {
  const point = visiblePoints(index?.points || [], minute).at(-1) || {};
  const price = finiteNumber(point.price);
  const preClose = finiteNumber(index?.preClose);
  const change = price !== null && preClose !== null ? price - preClose : null;
  return {
    price,
    change,
    pct: change !== null && preClose ? (change / preClose) * 100 : null,
    minute: finiteNumber(point.minute) ?? minute,
  };
}

function formatContributionPoints(value) {
  const points = finiteNumber(value);
  if (points === null) return "--";
  return `${points > 0 ? "+" : ""}${points.toFixed(2)}点`;
}

function contributionStockMarket(code) {
  const text = String(code || "");
  if (/^(6|68)/.test(text)) return "sh";
  if (/^(0|3)/.test(text)) return "sz";
  if (/^(4|8|9)/.test(text)) return "bj";
  return "";
}

function contributionRows(indexData, direction) {
  const key = direction > 0 ? "positive" : "negative";
  return [...(indexData?.[key] || [])]
    .filter((item) => Math.sign(Number(item.points)) === direction)
    .sort((left, right) => direction > 0
      ? Number(right.points) - Number(left.points)
      : Number(left.points) - Number(right.points))
    .slice(0, 10);
}

function renderContributionTabs(charts) {
  const signature = charts.map((chart, index) => `${contributionChartKey(chart, index)}:${chart.data?.name || ""}`).join("|");
  if (signature !== state.contributionTabsSignature) {
    const fragment = document.createDocumentFragment();
    charts.forEach((chart, index) => {
      const key = contributionChartKey(chart, index);
      const button = el("button", "contribution-tab", chart.data?.name || "指数");
      button.type = "button";
      button.dataset.contributionIndex = key;
      button.setAttribute("role", "tab");
      fragment.append(button);
    });
    dom.contributionTabs.replaceChildren(fragment);
    state.contributionTabsSignature = signature;
  }
  dom.contributionTabs.querySelectorAll("[data-contribution-index]").forEach((button) => {
    const selected = button.dataset.contributionIndex === state.contributionIndexKey;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
}

function contributionColumn(title, rows, direction, emptyMessage = "") {
  const column = el("section", `contribution-column ${direction > 0 ? "gain-side" : "loss-side"}`);
  const heading = el("div", "contribution-column-heading");
  heading.append(el("h3", "", title), el("span", "", `${rows.length}只成分股`));
  column.append(heading);
  if (!rows.length) {
    column.append(el("p", "contribution-empty", emptyMessage || "当前公开行情未形成该方向的贡献记录"));
    return column;
  }
  const list = el("div", "contribution-list");
  rows.forEach((item, index) => {
    const row = el("button", "contribution-row");
    row.type = "button";
    row.dataset.contributionStockOpen = "1";
    row.dataset.stockCode = item.code || "";
    row.dataset.stockName = item.name || "";
    row.dataset.stockMarket = contributionStockMarket(item.code);
    row.title = `在当前设备的股票软件中打开 ${item.name || item.code || "成分股"} 日K`;
    const rank = el("span", "contribution-rank", String(index + 1).padStart(2, "0"));
    const identity = el("div", "contribution-identity");
    const weight = finiteNumber(item.weightPct);
    const sourceRank = finiteNumber(item.rank);
    identity.append(
      el("strong", "contribution-name", item.name || item.code || "成分股"),
      el("span", "contribution-meta", `${item.code || "------"} · 权重 ${weight === null ? "--" : `${weight.toFixed(2)}%`}`),
    );
    const values = el("div", "contribution-values");
    values.append(
      el("strong", "contribution-amount", formatContributionPoints(item.points)),
      el("span", `contribution-delta ${valueClass(item.changePct)}`, `涨跌 ${signed(item.changePct, 2, "%")}`),
    );
    const sourceOrder = el("span", "contribution-confidence", sourceRank === null ? "贡献 --" : `贡献 #${formatNumber(sourceRank)}`);
    sourceOrder.title = "按实时计算贡献点排序";
    row.append(rank, identity, values, sourceOrder);
    list.append(row);
  });
  column.append(list);
  return column;
}

function renderIndexContribution(minute) {
  if (!dom.contributionTabs || !dom.indexContribution) return;
  const charts = state.charts.filter(isAshareContributionChart);
  if (!charts.length) {
    dom.contributionTabs.replaceChildren();
    dom.indexContribution.replaceChildren(el("p", "contribution-empty contribution-empty-panel", "暂无可用的A股指数归因数据"));
    return;
  }
  if (!state.data?.indexContribution) {
    dom.contributionTabs.replaceChildren();
    dom.indexContribution.replaceChildren(el(
      "p",
      "contribution-empty contribution-empty-panel",
      state.membershipActive ? "指数贡献数据读取中" : "开通会员后可查看指数贡献前十",
    ));
    return;
  }
  const selectedExists = charts.some((chart, index) => contributionChartKey(chart, index) === state.contributionIndexKey);
  if (!selectedExists) state.contributionIndexKey = contributionChartKey(charts[0], 0);
  renderContributionTabs(charts);
  const chart = charts.find((item, index) => contributionChartKey(item, index) === state.contributionIndexKey) || charts[0];
  const snapshot = contributionPointAtMinute(chart.data, minute);
  const dataset = state.data?.indexContribution || {};
  const source = dataset.source || {};
  const indexData = dataset.indices?.[state.contributionIndexKey]
    || Object.values(dataset.indices || {}).find((item) => item?.name === chart.data?.name)
    || null;
  const available = source.status === "ok" && indexData;
  const positive = available ? contributionRows(indexData, 1) : [];
  const negative = available ? contributionRows(indexData, -1) : [];
  const summary = el("section", "contribution-summary");
  const name = el("span", "contribution-index-name", chart.data?.name || "指数");
  const price = el("strong", "contribution-index-price", snapshot.price === null
    ? "--"
    : snapshot.price.toLocaleString("zh-CN", {minimumFractionDigits: 2, maximumFractionDigits: 2}));
  const change = el("div", `contribution-index-change ${valueClass(snapshot.change)}`);
  change.append(el("span", "", signed(snapshot.change, 2)), el("span", "", signed(snapshot.pct, 2, "%")));
  const status = el("p", "contribution-status", available
    ? `${marketMinuteToTime(snapshot.minute)} 指数行情 · 在线贡献 ${dataset.tradeDate || "--"} ${dataset.fetchedAt || "--"}`
    : `${marketMinuteToTime(snapshot.minute)} 指数行情 · 公开行情贡献暂不可用`);
  const sourceName = indexData?.componentSource || (Array.isArray(source.providers) ? source.providers.join("、") : source.provider) || "公开行情";
  const methodology = indexData?.methodology || source.methodology || "指数前收盘点位 × 成分权重 × 个股涨跌幅";
  const note = el("p", "contribution-note", available
    ? `来源：${sourceName}；计算：${methodology}。${formatNumber(indexData.constituentCount)}只样本中分别取拉动前十、拖累前十；后台自动更新，无需启动股票软件。回放时间轴只改变指数行情，不伪造历史贡献榜。`
    : `公开行情贡献暂不可用：${source.message || "数据尚未生成"}。完整性校验失败时保留上一份有效结果，不使用行业资金推断替代。`);
  summary.append(name, price, change, status, note);
  dom.indexContribution.replaceChildren(
    summary,
    contributionColumn("拉动前十", positive, 1, available ? "当前没有正贡献成分股" : "等待公开行情贡献榜"),
    contributionColumn("拖累前十", negative, -1, available ? "当前没有负贡献成分股" : "等待公开行情贡献榜"),
  );
}

async function refreshIndexContributionData(options = {}) {
  if (!state.data || state.contributionLoading || (!state.membershipActive && !options.probe)) return false;
  state.contributionLoading = true;
  try {
    const indexContribution = await loadIndexContributionData();
    state.membershipActive = true;
    state.data = {...state.data, indexContribution};
    renderIndexContribution(Number(dom.timeline.value));
    return true;
  } catch (error) {
    if (error?.status === 402) {
      state.membershipActive = false;
      state.data = {...state.data, indexContribution: null};
      renderIndexContribution(Number(dom.timeline.value));
      return false;
    }
    if (!options.silent) logTechnicalError(error, "指数贡献数据");
    return false;
  } finally {
    state.contributionLoading = false;
  }
}

function currentFlowAmount(row, minute) {
  const points = Array.isArray(row?.points) ? row.points : [];
  let selected = null;
  let next = null;
  for (const point of points) {
    const pointMinute = finiteNumber(point.minute) ?? -1;
    if (finiteNumber(point.amount) === null) continue;
    const carriedFrom = finiteNumber(point.carriedFrom);
    const isBackfilled = carriedFrom !== null && carriedFrom > pointMinute;
    if (pointMinute <= minute) {
      if (!isBackfilled || carriedFrom <= minute) selected = point;
    } else if (!isBackfilled) {
      next = point;
      break;
    }
  }
  const selectedAmount = finiteNumber(selected?.amount);
  if (selectedAmount === null || !next) return selectedAmount;
  const selectedMinute = finiteNumber(selected.minute) ?? minute;
  const nextMinute = finiteNumber(next.minute) ?? selectedMinute;
  const nextAmount = finiteNumber(next.amount);
  if (nextAmount === null || nextMinute <= selectedMinute || minute <= selectedMinute) return selectedAmount;
  const ratio = Math.max(0, Math.min(1, (minute - selectedMinute) / (nextMinute - selectedMinute)));
  return selectedAmount + (nextAmount - selectedAmount) * ratio;
}

function liveRowKey(row) {
  const code = String(row?.code || row?.tdxCode || "").trim().toUpperCase();
  return code || String(row?.name || row?.tdxName || "").trim();
}

function liveTradeDateMatches(snapshot) {
  const coreTradeDate = state.data?.sectors?.tradeDate || state.data?.market?.tradeDate || state.data?.market?.market?.tradeDate || "";
  return Boolean(snapshot?.tradeDate && coreTradeDate && snapshot.tradeDate === coreTradeDate);
}

function livePointForRow(row, snapshot, previousPoint = null) {
  return {
    minute: finiteNumber(snapshot?.marketMinute) ?? finiteNumber(previousPoint?.minute) ?? 0,
    time: snapshot?.sourceTime || marketMinuteToTime(snapshot?.marketMinute || 0, true),
    amount: finiteNumber(row?.amount),
    changePct: finiteNumber(row?.changePct),
    source: "eastmoney-live-board-ranking",
    sampledAt: snapshot?.fetchedAt || "",
    sourceTimestamp: snapshot?.sourceTimestamp || null,
  };
}

function mergeLiveFlowGroup(groupName, snapshot) {
  const baseGroup = state.data?.sectors?.[groupName];
  const liveGroup = snapshot?.groups?.[groupName];
  if (!baseGroup || !Array.isArray(liveGroup?.rows)) return null;
  const baseRows = Array.isArray(baseGroup.rows) ? baseGroup.rows : [];
  const liveByKey = new Map(liveGroup.rows.map((row) => [liveRowKey(row), row]).filter(([key]) => key));
  const mergedRows = [];
  const usedKeys = new Set();

  for (const baseRow of baseRows) {
    const key = liveRowKey(baseRow);
    const liveRow = liveByKey.get(key);
    if (!liveRow) {
      mergedRows.push(baseRow);
      continue;
    }
    usedKeys.add(key);
    const points = Array.isArray(baseRow.points) ? baseRow.points : [];
    const livePoint = livePointForRow(liveRow, snapshot, points.at(-1));
    mergedRows.push({
      ...baseRow,
      amount: liveRow.amount,
      changePct: liveRow.changePct,
      liveValidated: true,
      liveSampledAt: snapshot.fetchedAt,
      liveSourceTime: snapshot.sourceTime,
      points: [...points, livePoint],
    });
  }

  for (const liveRow of liveGroup.rows) {
    const key = liveRowKey(liveRow);
    if (!key || usedKeys.has(key)) continue;
    mergedRows.push({
      ...liveRow,
      tdxName: liveRow.name,
      liveValidated: true,
      liveSampledAt: snapshot.fetchedAt,
      liveSourceTime: snapshot.sourceTime,
      points: [livePointForRow(liveRow, snapshot)],
    });
  }

  return {
    ...baseGroup,
    rows: mergedRows,
    flowSampleMinute: snapshot.marketMinute,
    scaleOwner: baseGroup,
    liveSnapshot: {
      sequence: snapshot.sequence,
      source: snapshot.source,
      sourceTime: snapshot.sourceTime,
      sourceLatencyMs: snapshot.sourceLatencyMs,
      fetchedAt: snapshot.fetchedAt,
      active: snapshot.active,
      marketPhase: snapshot.marketPhase,
    },
  };
}

function applyLiveIndexQuotes(snapshot) {
  const indices = state.data?.indices?.items || [];
  const quotes = Array.isArray(snapshot?.indices) ? snapshot.indices : [];
  const quoteByKey = new Map();
  quotes.forEach((quote) => {
    quoteByKey.set(String(quote.key || ""), quote);
    quoteByKey.set(String(quote.code || ""), quote);
  });
  for (const index of indices) {
    const quote = quoteByKey.get(String(index.key || "")) || quoteByKey.get(String(index.code || ""));
    if (!quote || finiteNumber(quote.price) === null) continue;
    const points = (Array.isArray(index.points) ? index.points : []).filter((point) => point?.source !== "tencent-live-index-quote");
    const previous = [...points].reverse().find((point) => (finiteNumber(point.minute) ?? -1) <= quote.minute) || points.at(-1) || {};
    index.points = [...points, {
      ...previous,
      minute: quote.minute,
      time: marketMinuteToTime(quote.minute, true),
      dateTime: `${snapshot.tradeDate} ${marketMinuteToTime(quote.minute, true)}`,
      price: quote.price,
      amount: finiteNumber(quote.amount) ?? finiteNumber(previous.amount),
      source: "tencent-live-index-quote",
      sampledAt: snapshot.fetchedAt,
    }].sort((left, right) => (finiteNumber(left.minute) ?? 0) - (finiteNumber(right.minute) ?? 0));
  }
}

function updateLiveFlowStatus(snapshot, error = null) {
  if (!dom.liveFlowStatus) return;
  if (error) {
    dom.liveFlowStatus.dataset.state = state.liveFlowSnapshot ? "stale" : "error";
    dom.liveFlowStatus.textContent = state.liveFlowSnapshot
      ? `逐秒资金暂缓 · 保留 ${state.liveFlowSnapshot.sourceTime || "--"}`
      : "逐秒资金连接失败";
    dom.liveFlowStatus.title = error.message || String(error);
    return;
  }
  if (!snapshot) {
    dom.liveFlowStatus.dataset.state = "connecting";
    dom.liveFlowStatus.textContent = "逐秒资金连接中";
    return;
  }
  const latencySeconds = Math.max(0, Number(snapshot.sourceLatencyMs) || 0) / 1000;
  if (snapshot.active) {
    const stale = snapshot.consecutiveErrors > 0 || latencySeconds > 8;
    dom.liveFlowStatus.dataset.state = stale ? "stale" : "live";
    dom.liveFlowStatus.textContent = stale
      ? `逐秒资金延迟 · ${snapshot.sourceTime || "--"}`
      : `逐秒资金 ${snapshot.sourceTime || "--"} · ${latencySeconds.toFixed(1)}秒`;
  } else {
    dom.liveFlowStatus.dataset.state = "stopped";
    dom.liveFlowStatus.textContent = `${snapshot.marketPhase || "休市"} · ${snapshot.sourceTime || "--"}已冻结`;
  }
  dom.liveFlowStatus.title = `${snapshot.source || "实时资金源"}；${snapshot.methodology || "只显示真实快照"}；行业/概念同轮采集完成时差 ${Number(snapshot.groupTimestampSkewMs || 0)} 毫秒`;
}

function applyLiveFlowSnapshot(snapshot, options = {}) {
  if (!snapshot?.ok || !state.data) return false;
  state.liveFlowSnapshot = snapshot;
  updateLiveFlowStatus(snapshot);
  if (!liveTradeDateMatches(snapshot)) {
    state.liveFlowGroups = {industry: null, concept: null};
    dom.liveFlowStatus.dataset.state = "stale";
    dom.liveFlowStatus.textContent = `逐秒资金 ${snapshot.tradeDate || "--"} · 等待同日基础数据`;
    return false;
  }
  state.liveFlowGroups.industry = mergeLiveFlowGroup("industry", snapshot);
  state.liveFlowGroups.concept = mergeLiveFlowGroup("concept", snapshot);
  state.customSectorWorkspace?.applyLiveSnapshot(snapshot);
  applyLiveIndexQuotes(snapshot);

  const previousMaximum = Number(dom.timeline.max) || 0;
  const previousValue = Number(dom.timeline.value) || 0;
  const wasFollowingLive = previousValue >= previousMaximum - 0.05;
  const liveMinute = Math.max(0, Math.min(240, finiteNumber(snapshot.marketMinute) ?? previousMaximum));
  const nextMaximum = Math.max(previousMaximum, liveMinute);
  dom.timeline.max = String(nextMaximum);
  dom.timelineEnd.textContent = marketMinuteToTime(nextMaximum);
  if (options.forceFollow || wasFollowingLive) dom.timeline.value = liveMinute.toFixed(3);
  const displayMinute = Number(dom.timeline.value) || liveMinute;
  if (state.charts.length) {
    updateIndexCharts(state.charts, displayMinute);
    renderIndexContribution(displayMinute);
  }
  renderFlow("industry", displayMinute);
  renderFlow("concept", displayMinute);
  state.customSectorWorkspace?.render(displayMinute);
  dom.timelineTime.textContent = marketMinuteToTime(displayMinute, true);
  return true;
}

function flowGroupAtMinute(groupName, minute) {
  const liveGroup = state.liveFlowGroups[groupName];
  const liveMinute = finiteNumber(state.liveFlowSnapshot?.marketMinute);
  if (liveGroup && liveMinute !== null && minute >= liveMinute - 0.01) return liveGroup;
  return state.data?.sectors?.[groupName];
}

function stableFlowMaximum(group, view) {
  const cacheOwner = group?.scaleOwner || group;
  const cached = flowScaleCache.get(cacheOwner) || {};
  let rawMaximum = 0;
  for (const row of group.rows || []) {
    const values = [row.amount, ...(row.points || []).map((point) => point.amount)];
    for (const value of values) {
      const amount = finiteNumber(value);
      if (amount === null || (view === "inflow" ? amount <= 0 : amount >= 0)) continue;
      rawMaximum = Math.max(rawMaximum, Math.abs(amount));
    }
  }
  if (!rawMaximum) {
    cached[view] = cached[view] || 1;
    flowScaleCache.set(cacheOwner, cached);
    return cached[view];
  }
  const magnitude = 10 ** Math.floor(Math.log10(rawMaximum));
  const step = Math.max(0.01, magnitude / 10);
  const maximum = Math.ceil((rawMaximum * 1.08) / step) * step;
  cached[view] = Math.max(cached[view] || 0, maximum);
  flowScaleCache.set(cacheOwner, cached);
  return cached[view];
}

function compareFlowRank(a, b) {
  const amountDifference = Math.abs(b.currentAmount) - Math.abs(a.currentAmount);
  if (Math.abs(amountDifference) > 1e-9) return amountDifference;
  const aName = String(a.tdxName || a.name || "");
  const bName = String(b.tdxName || b.name || "");
  const nameDifference = aName.localeCompare(bName, "zh-CN", {numeric: true, sensitivity: "base"});
  if (nameDifference) return nameDifference;
  return String(a.tdxCode || a.code || "").localeCompare(String(b.tdxCode || b.code || ""), "zh-CN", {numeric: true});
}

function flowRowKey(row) {
  return String(row?.code || row?.tdxCode || row?.name || "").trim();
}

function flowBaseName(row) {
  return String(row?.tdxName || row?.name || "--").trim() || "--";
}

function addDistinctFlowLabels(rows) {
  const counts = new Map();
  rows.forEach((row) => counts.set(flowBaseName(row), (counts.get(flowBaseName(row)) || 0) + 1));
  return rows.map((row) => {
    const mappedName = flowBaseName(row);
    const originalName = String(row?.name || "").trim();
    const suffix = originalName && originalName !== mappedName ? originalName : flowRowKey(row);
    return {...row, displayName: counts.get(mappedName) > 1 && suffix ? `${mappedName}·${suffix}` : mappedName};
  });
}

function buildHeadlineMetric(label, value, note, className = "neutral", href = "", actionLabel = "") {
  const item = el(href ? "a" : "div", `headline-metric${href ? " headline-metric-button" : ""}`);
  const noteNode = el("small", "", note);
  if (href) {
    item.href = href;
    item.setAttribute("aria-label", `${actionLabel}，当前${label}${value}`);
    item.title = actionLabel;
    noteNode.append(el("span", "metric-action", `${actionLabel} →`));
  }
  item.append(el("span", "metric-label", label), el("strong", className, value), noteNode);
  return item;
}

function renderHeaderAndOverview() {
  const marketData = state.data.market;
  const market = marketData.market || {};
  const freshness = dataFreshness(marketData, marketData.validation || state.data.analysis.validation || {});
  dom.tradeDate.textContent = freshness.tradeDate || "--";
  dom.marketState.textContent = freshness.status;
  dom.marketState.className = `status-label ${freshness.className}`;
  dom.lastSync.textContent = `最后同步 ${freshness.syncedAt || "--"}`;
  dom.syncAge.textContent = freshness.ageText;
  const regimeScore = finiteNumber(state.data.analysis.marketRegime?.score);
  dom.emotionValue.textContent = state.analysis.stage;
  dom.emotionValue.className = `metric-emphasis ${regimeScore !== null ? (regimeScore >= 10 ? "gain" : regimeScore <= -10 ? "loss" : "warning") : (["强势", "修复"].includes(state.analysis.stage) ? "gain" : ["弱势", "退潮"].includes(state.analysis.stage) ? "loss" : "warning")}`;
  dom.emotionReason.textContent = state.analysis.explanation;
  dom.riskValue.textContent = state.analysis.risk.level;
  dom.riskReason.textContent = state.analysis.risk.explanation;
  dom.riskGauge.style.width = `${(state.analysis.risk.score / 4) * 100}%`;

  const yesterdayLimit = state.analysis.metrics.yesterdayLimit;
  const yesterdayBroken = state.analysis.metrics.yesterdayBroken;
  const metrics = [
    ["市场成交额", formatYi(market.totalAmountYi), `成交量 ${formatNumber(market.totalVolumeYiHands, 1)}亿手`, "neutral"],
    ["涨停家数", formatNumber(market.limitUpCount), `全市场 ${formatNumber(market.stockCount)} 只`, "gain", "/app/pages/limit-up.html", "查看涨停个股及所属板块"],
    ["跌停家数", formatNumber(market.limitDownCount), `红盘率 ${formatPercent(state.analysis.metrics.redRate)}`, "loss", "/app/pages/limit-down.html", "查看跌停个股及所属板块"],
    ["昨日涨停延续", yesterdayLimit.strength, `晋级 ${formatPercent(yesterdayLimit.limitRate)}`, valueClass(yesterdayLimit.avgChangePct)],
    ["昨日炸板修复", formatNumber(yesterdayBroken.count), `${yesterdayBroken.strength} · 红盘 ${formatNumber(yesterdayBroken.upCount)} 家 · 再涨停 ${formatNumber(yesterdayBroken.limitUpCount)} 家`, valueClass(yesterdayBroken.avgChangePct), "/app/pages/yesterday-broken.html", "查看昨日炸板股票、所属板块与今日修复情况"],
  ];
  dom.headlineMetrics.replaceChildren(...metrics.map((metric) => buildHeadlineMetric(...metric)));

  const validation = marketData.validation || state.data.analysis.validation || {};
  const messages = [...(validation.errors || []), ...(validation.warnings || [])];
  dom.dataAlert.hidden = messages.length === 0;
  if (messages.length) dom.dataAlert.textContent = `部分数据异常：${messages.slice(0, 2).join("；")}${messages.length > 2 ? `（另有${messages.length - 2}项）` : ""}`;
}

function ensureFlowTable(target, view) {
  let rowsTarget = target.querySelector(".flow-rows");
  if (rowsTarget) return rowsTarget;
  target.dataset.flowDirection = view;
  const head = el("div", "flow-head");
  ["排名", "板块", view === "inflow" ? "净流入↓" : "净流出↓", "日K"].forEach((text) => {
    head.append(el("span", "", text));
  });
  rowsTarget = el("div", "flow-rows");
  target.replaceChildren(head, rowsTarget);
  return rowsTarget;
}

function renderFlowTable(groupName, target, view, rows, maximum, renderVersion) {
  const rowsTarget = ensureFlowTable(target, view);
  target.dataset.flowCount = String(rows.length);
  rowsTarget.querySelector(".empty-state")?.remove();
  const existing = new Map([...rowsTarget.querySelectorAll(".flow-row")].map((line) => [line.dataset.flowKey, line]));
  const activeKeys = new Set();
  rows.forEach((row, index) => {
    const key = flowRowKey(row) || `${groupName}-${view}-${index}`;
    let line = existing.get(key);
    const isNew = !line;
    if (!line) {
      line = el("div", "flow-row");
      line.dataset.flowKey = key;
      const track = el("span", "flow-bar-track");
      track.setAttribute("role", "meter");
      track.append(el("span", "flow-bar"));
      const localKButton = el("button", "k-button");
      localKButton.type = "button";
      line.append(el("span", "flow-rank"), el("span", "flow-name"), el("span", "flow-value"), track, localKButton);
    }
    activeKeys.add(key);
    line.dataset.flowDirection = view;
    const rankAmount = Math.abs(row.currentAmount);
    line.classList.toggle("outflow", view === "outflow");
    line.dataset.flowRankAmount = rankAmount.toFixed(4);
    line.querySelector(".flow-rank").textContent = String(index + 1);
    const name = line.querySelector(".flow-name");
    name.textContent = row.displayName;
    name.title = row.tdxName && row.tdxName !== row.name ? `${row.tdxName} / 原：${row.name}` : row.name || "";
    const value = line.querySelector(".flow-value");
    value.className = `flow-value ${valueClass(row.currentAmount)}`;
    value.textContent = `${view === "inflow" ? "+" : "-"}${rankAmount.toFixed(2)}亿`;
    value.title = `${view === "inflow" ? "净流入" : "净流出"}${rankAmount.toFixed(2)}亿元，按金额从高到低排列`;
    const track = line.querySelector(".flow-bar-track");
    const bar = track.querySelector(".flow-bar");
    const percent = Math.max(2, Math.min(100, rankAmount / maximum * 100));
    const targetWidth = `${percent.toFixed(2)}%`;
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", maximum.toFixed(2));
    track.setAttribute("aria-valuenow", rankAmount.toFixed(2));
    track.setAttribute("aria-valuetext", `${view === "inflow" ? "净流入" : "净流出"}${rankAmount.toFixed(1)}亿元`);
    track.title = `固定线性刻度 0～${maximum.toFixed(1)}亿`;
    if (isNew) {
      bar.style.width = "0%";
      requestAnimationFrame(() => {
        if (state.flowRenderVersion[groupName] === renderVersion && bar.isConnected && line.dataset.flowDirection === view) {
          bar.style.width = targetWidth;
        }
      });
    } else {
      bar.style.width = targetWidth;
    }
    const link = line.querySelector(".k-button");
    const tdxCode = /^880\d{3}$/.test(String(row.tdxCode || "").toUpperCase()) ? String(row.tdxCode).toUpperCase() : "";
    const boardCode = /^BK\d{4}$/.test(String(row.code || "").toUpperCase()) ? String(row.code).toUpperCase() : "";
    const localCode = tdxCode || boardCode;
    const localName = String(row.name || row.tdxName || "").trim();
    const hasTarget = Boolean(localCode || localName);
    link.textContent = hasTarget ? "日K" : "无名称";
    link.disabled = !hasTarget;
    link.dataset.stockOpen = "true";
    link.dataset.stockCode = localCode;
    link.dataset.stockBoardCode = boardCode;
    link.dataset.stockName = localName;
    link.dataset.stockMarket = "sector";
    link.title = hasTarget
      ? `自动检索当前设备的股票软件并打开${localName || localCode}日K`
      : "该板块缺少可搜索名称";
    rowsTarget.append(line);
  });
  existing.forEach((line, key) => { if (!activeKeys.has(key)) line.remove(); });
  if (!rows.length) rowsTarget.append(el("div", "empty-state", "当前方向尚未形成可展示的板块。"));
}

function renderFlow(groupName, minute) {
  const targets = groupName === "industry"
    ? {inflow: dom.industryInflow, outflow: dom.industryOutflow}
    : {inflow: dom.conceptInflow, outflow: dom.conceptOutflow};
  const group = flowGroupAtMinute(groupName, minute);
  if (!group) return;
  const rows = (group.rows || []).map((row) => ({...row, currentAmount: currentFlowAmount(row, minute)}));
  const inflowRows = addDistinctFlowLabels(rows
    .filter((row) => row.currentAmount > 0)
    .sort(compareFlowRank)
    .slice(0, 10));
  const outflowRows = addDistinctFlowLabels(rows
    .filter((row) => row.currentAmount < 0)
    .sort(compareFlowRank)
    .slice(0, 10));
  const inflowMaximum = stableFlowMaximum(group, "inflow");
  const outflowMaximum = stableFlowMaximum(group, "outflow");
  const renderVersion = ++state.flowRenderVersion[groupName];
  state.flowCharts[groupName].inflow?.render(group, {
    minute,
    view: "inflow",
    maximum: inflowMaximum,
  });
  state.flowCharts[groupName].outflow?.render(group, {
    minute,
    view: "outflow",
    maximum: outflowMaximum,
  });
  renderFlowTable(groupName, targets.inflow, "inflow", inflowRows, inflowMaximum, renderVersion);
  renderFlowTable(groupName, targets.outflow, "outflow", outflowRows, outflowMaximum, renderVersion);
}

function scoreDetails(row) {
  const score = row.scoreBreakdown || {};
  return `资金 ${signed(score.flow, 1)}；涨停集群 ${signed(score.limitCluster, 1)}；延续性 ${signed(score.continuity, 1)}；历史持续性 ${signed(score.history, 1)}；负反馈 ${signed(score.negative, 1)}`;
}

function structureColumn(title, rows) {
  const column = el("section", "structure-column");
  column.append(el("h3", "", title));
  const list = el("div", "structure-list");
  if (!(rows || []).length) list.append(el("p", "metric-note", "暂未形成可确认方向。"));
  for (const row of rows || []) {
    const item = el("div", "structure-row");
    item.append(el("strong", "", row.name || "--"));
    const score = el("button", "score-button", `${formatNumber(row.score, 1)}分`);
    score.type = "button";
    score.dataset.score = scoreDetails(row);
    score.title = "点击查看评分组成";
    item.append(score, el("span", "", `${formatNumber(row.limitUpCount)}涨停`));
    const evidence = el("span", "structure-evidence", row.evidence || "数据不足");
    evidence.dataset.defaultText = evidence.textContent;
    item.append(evidence);
    list.append(item);
  }
  column.append(list);
  return column;
}

function renderStructure() {
  const structure = state.data.analysis.structure || state.data.market.marketStructure || {};
  const rotation = el("section", "structure-column");
  rotation.append(el("h3", "", "板块轮动"));
  rotation.append(el("p", "rotation-text", structure.interSectorText || "历史样本不足，暂不确认板块发生切换。"));
  const history = el("p", "metric-note", `已参考 ${formatNumber(structure.historyDaysUsed)} 个此前交易日；点击评分可查看构成。`);
  rotation.append(history);
  dom.marketStructure.replaceChildren(structureColumn("主线", structure.mainline), structureColumn("支线", structure.subline), rotation);
}

function renderMoneyMetrics() {
  const moneyEffect = state.data.analysis.moneyEffect || {};
  const metrics = buildMoneyMetrics(state.data.market, null, moneyEffect);
  dom.moneyMetrics.replaceChildren(...metrics.map((metric) => {
    const item = el("div", "money-item");
    const label = el("span", "metric-label tooltip-help", metric.label);
    label.title = metric.tip;
    const value = el("strong", metric.className, metric.format(metric.value));
    item.append(label, value, el("small", "", metric.tip));
    return item;
  }));
  const summary = summarizeMoneyEffect(moneyEffect);
  dom.moneySummary.className = `money-summary ${summary.level}`;
  dom.moneySummary.textContent = summary.text;
}

function renderHistory() {
  const market = state.data.market.market || {};
  const days = market.recentDays || [];
  const table = el("table", "history-table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["交易日", "涨停", "跌停", "成交额", "上证涨跌", "较当日量能"].forEach((title) => headRow.append(el("th", "", title)));
  head.append(headRow);
  const body = document.createElement("tbody");
  const currentAmount = finiteNumber(market.totalAmountYi);
  days.slice(0, 8).forEach((day) => {
    const row = document.createElement("tr");
    const amount = finiteNumber(day.totalAmountYi);
    const amountCompare = currentAmount && amount ? ((amount - currentAmount) / currentAmount) * 100 : null;
    [day.date || "--", formatNumber(day.limitUpCount), formatNumber(day.limitDownCount), formatYi(amount), signed(day.indexChangePct, 2, "%"), signed(amountCompare, 1, "%")]
      .forEach((value) => row.append(el("td", "", value)));
    body.append(row);
  });
  table.append(head, body);
  dom.historyTable.replaceChildren(table);
}

function summarySection(title, paragraphs = [], list = []) {
  const section = el("section", "summary-section");
  section.append(el("h3", "", title));
  paragraphs.filter(Boolean).forEach((text) => section.append(el("p", "", text)));
  if (list.length) {
    const ul = document.createElement("ul");
    list.forEach((text) => ul.append(el("li", "", text)));
    section.append(ul);
  }
  return section;
}

function renderSummary() {
  const marketData = state.data.market;
  const market = marketData.market || {};
  const structure = state.data.analysis.structure || marketData.marketStructure || {};
  const diagnosis = state.data.analysis.diagnosis || {};
  const flow = state.data.analysis.flowAnalysis || {};
  const sections = [
    summarySection("一、市场情绪", [`市场情绪：${state.analysis.stage}。${state.analysis.explanation}`], state.analysis.positives.slice(0, 4)),
    summarySection("二、整体风险", [`整体风险：${state.analysis.risk.level}。${state.analysis.risk.explanation}`], state.analysis.negatives.slice(0, 4)),
    summarySection("三、主线、支线与轮动", [structure.summary || "主线和支线暂未确认。", structure.interSectorText || "板块间轮动样本不足。"]),
    summarySection("四、资金流入前三", [], (flow.inflow || []).map((row) => `${row.name} ${signed(row.amount, 1, "亿")}。${row.policyNews || ""} ${row.macroGeo || ""}`)),
    summarySection("五、资金流出前三", [], (flow.outflow || []).map((row) => `${row.name} ${signed(row.amount, 1, "亿")}。${row.policyNews || ""} ${row.macroGeo || ""}`)),
    summarySection("六、数据依据", [
      `交易日${market.tradeDate || "--"}，涨停${formatNumber(market.limitUpCount)}家、跌停${formatNumber(market.limitDownCount)}家、成交额${formatYi(market.totalAmountYi)}。`,
      `已参考${formatNumber(diagnosis.historyDaysUsed ?? structure.historyDaysUsed)}个此前交易日，并结合主要指数、市场广度、板块资金、昨日涨停延续和昨日炸板修复。`,
    ]),
  ];
  dom.summaryDate.textContent = `${market.tradeDate || "--"}｜${marketData.syncedAt || "--"}`;
  dom.summaryContent.replaceChildren(...sections);
  state.summaryText = sections.map((section) => section.innerText.trim()).join("\n\n") + "\n\n本软件仅用于市场数据整理和复盘分析，不构成任何投资建议。";
}

function renderAll() {
  renderHeaderAndOverview();
  const industryAttributionRows = state.data.sectors?.industry?.attributionRows || state.data.sectors?.industry?.rows || [];
  const conceptAttributionRows = state.data.sectors?.concept?.attributionRows || state.data.sectors?.concept?.rows || [];
  const attributionRows = [
    ...industryAttributionRows.map((row) => ({...row, sectorKind: "industry", sectorKindLabel: "行业"})),
    ...conceptAttributionRows.map((row) => ({...row, sectorKind: "concept", sectorKindLabel: "题材"})),
  ];
  state.charts = createIndexCharts(dom.indexGrid, state.data.indices.items || [], attributionRows);
  updateIndexCharts(state.charts, Number(dom.timeline.value));
  renderIndexContribution(Number(dom.timeline.value));
  renderFlow("industry", Number(dom.timeline.value));
  renderFlow("concept", Number(dom.timeline.value));
  state.customSectorWorkspace?.setDirectory({
    industry: state.liveFlowGroups.industry || state.data.sectors?.industry,
    concept: state.liveFlowGroups.concept || state.data.sectors?.concept,
  });
  state.customSectorWorkspace?.render(Number(dom.timeline.value));
  renderStructure();
  renderMoneyMetrics();
  renderHistory();
  renderSummary();
  dom.sourceNote.textContent = state.data.market.sourceNote || "数据来源：公开行情接口、通达信本地日线与本地历史缓存。";
}

function latestAshareMinute(indices) {
  const shanghai = (indices || []).find((item) => item?.name === "上证指数") || (indices || []).find((item) => item?.session !== "us");
  const minutes = (shanghai?.points || []).map((point) => finiteNumber(point?.minute)).filter((minute) => minute !== null);
  return minutes.length ? Math.max(0, Math.min(240, Math.max(...minutes))) : 0;
}

function initializePlayback() {
  const latestMinute = latestAshareMinute(state.data?.indices?.items || []);
  dom.timeline.max = String(latestMinute);
  dom.timeline.value = String(latestMinute);
  dom.timelineEnd.textContent = marketMinuteToTime(latestMinute);
  state.playback = createPlaybackController({
    timeline: dom.timeline,
    playButton: dom.playButton,
    speedSelect: dom.speedSelect,
    onFrame: (minute) => {
      updateIndexCharts(state.charts, minute);
      renderIndexContribution(minute);
      renderFlow("industry", minute);
      renderFlow("concept", minute);
      state.customSectorWorkspace?.render(minute);
    },
    onTime: (text) => { dom.timelineTime.textContent = text; },
  });
}

async function checkService() {
  try {
    const health = await getHealth();
    dom.syncButton.disabled = false;
    dom.syncButton.title = `同步服务 ${health.version || ""} 正常`;
    return true;
  } catch (error) {
    dom.syncButton.disabled = true;
    dom.syncButton.title = "同步服务未启动，请重新打开桌面软件。";
    showNotice("本地同步服务没有启动。请重新打开软件启动程序后再试。", "error", true);
    logTechnicalError(error, "健康检查");
    return false;
  }
}

async function syncMarket() {
  dom.syncButton.disabled = true;
  dom.syncButton.querySelector("span:last-child").textContent = "正在同步";
  try {
    try {
      const liveSnapshot = await requestLiveSectorFlowRefresh();
      applyLiveFlowSnapshot(liveSnapshot, {forceFollow: true});
    } catch (error) {
      logTechnicalError(error, "手动逐秒资金刷新");
    }
    await requestMarketSync((progress) => showNotice(`${progress.message || "正在同步"}${progress.percent ? ` ${progress.percent}%` : ""}`, "", true));
    await refreshLiveData({force: true, forceFollow: true});
    showNotice("同步成功，逐秒资金与完整复盘数据均已更新。", "success");
    dom.syncButton.disabled = false;
    dom.syncButton.querySelector("span:last-child").textContent = "同步市场";
  } catch (error) {
    showNotice(error.message, "error", true);
    logTechnicalError(error, "手动同步");
    dom.syncButton.disabled = false;
    dom.syncButton.querySelector("span:last-child").textContent = "同步市场";
  }
}

function setupInteractions() {
  initializeTheme();
  initializePwa();
  state.customSectorWorkspace = createCustomSectorWorkspace({
    grid: dom.customSectorGrid,
    picker: dom.customSectorPicker,
    pickerList: dom.customSectorOptions,
    searchInput: dom.customSectorSearch,
    filterControls: dom.customSectorFilters,
    addButton: dom.customSectorAdd,
    closeButton: dom.customSectorPickerClose,
    count: dom.customSectorCount,
    loadTimeline: loadBoardIntradayTrend,
    showNotice,
    openDayK: async (selection) => {
      try {
        const result = await openTdxStock({
          code: selection.code,
          boardCode: selection.code,
          market: "sector",
          name: selection.name,
        });
        showNotice(result.message || `已在当前设备的股票软件中打开${selection.name}日K。`);
      } catch (error) {
        showNotice(error.message || "板块日K打开失败。", "error", true);
        logTechnicalError(error, "自选板块日K");
      }
    },
  });
  state.flowCharts.industry.inflow = createSectorFlowChart(dom.industryInflowChart);
  state.flowCharts.industry.outflow = createSectorFlowChart(dom.industryOutflowChart);
  state.flowCharts.concept.inflow = createSectorFlowChart(dom.conceptInflowChart);
  state.flowCharts.concept.outflow = createSectorFlowChart(dom.conceptOutflowChart);
  dom.reloadButton.addEventListener("click", () => location.reload());
  dom.syncButton.addEventListener("click", syncMarket);
  dom.contributionTabs?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-contribution-index]");
    if (!button) return;
    state.contributionIndexKey = button.dataset.contributionIndex;
    renderIndexContribution(Number(dom.timeline.value));
  });
  dom.indexContribution?.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-contribution-stock-open]");
    if (!button || button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const result = await openTdxStock({
        code: button.dataset.stockCode,
        market: button.dataset.stockMarket,
        name: button.dataset.stockName,
      });
      showNotice(result.message || "已在当前设备的股票软件中打开日K。");
    } catch (error) {
      showNotice(error.message, "error", true);
      logTechnicalError(error, "指数贡献成分股日K");
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  });
  [dom.industryInflow, dom.industryOutflow, dom.conceptInflow, dom.conceptOutflow].forEach((container) => {
    container.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-stock-open]");
      if (!button || button.disabled) return;
      const oldText = button.textContent;
      button.disabled = true;
      button.textContent = "打开中";
      try {
        const result = await openTdxStock({
          code: button.dataset.stockCode,
          boardCode: button.dataset.stockBoardCode,
          market: button.dataset.stockMarket,
          name: button.dataset.stockName,
        });
        button.textContent = "已打开";
        showNotice(result.message || "已在当前设备的股票软件中打开日K。", "", true);
      } catch (error) {
        button.textContent = "未打开";
        button.title = error.message;
        showNotice(error.message || "未检测到可自动操作的本机交易软件，请先安装或登录交易软件。", "error", true);
        logTechnicalError(error, "本机板块日K");
      } finally {
        window.setTimeout(() => {
          button.disabled = false;
          button.textContent = oldText;
        }, 1800);
      }
    });
  });
  dom.marketStructure.addEventListener("click", (event) => {
    const button = event.target.closest("button.score-button");
    if (!button) return;
    const evidence = button.parentElement.querySelector(".structure-evidence");
    const showingScore = evidence.dataset.showingScore === "true";
    evidence.textContent = showingScore ? evidence.dataset.defaultText : button.dataset.score;
    evidence.dataset.showingScore = String(!showingScore);
  });
  dom.structureHelp.addEventListener("click", () => {
    showNotice("板块评分由资金、涨停集群、昨日前排延续、近5日持续性和跌停负反馈共同构成。", "", true);
  });
  createSummaryDialog({
    backdrop: dom.summaryBackdrop,
    dialog: dom.summaryDialog,
    openButton: dom.summaryButton,
    closeButton: dom.closeSummary,
    copyButton: dom.copySummary,
    exportButton: dom.exportSummary,
    printButton: dom.printSummary,
    getText: () => state.summaryText,
    getFilename: () => `A股市场总结_${state.data?.market?.tradeDate || "最新"}.txt`,
  });
}

function dataStamp(data) {
  return [
    data?.market?.tradeDate || data?.market?.market?.tradeDate || "",
    data?.market?.syncedAt || "",
    data?.indices?.syncedAt || "",
    data?.sectors?.syncedAt || "",
  ].join("|");
}

function applyCoreData(nextData, options = {}) {
  const previousMaximum = Number(dom.timeline.max) || 0;
  const previousValue = Number(dom.timeline.value) || 0;
  const wasFollowingLive = !state.data || previousValue >= previousMaximum - 0.05;
  state.data = {...nextData, indexContribution: state.data?.indexContribution || null};
  const latestMinute = latestAshareMinute(nextData?.indices?.items || []);
  dom.timeline.max = String(latestMinute);
  dom.timelineEnd.textContent = marketMinuteToTime(latestMinute);
  const followLive = options.forceFollow || wasFollowingLive;
  dom.timeline.value = String(followLive ? latestMinute : Math.min(previousValue, latestMinute));
  const localAnalysis = analyzeMarket(nextData.market, null, nextData.config, {
    ...(nextData.analysis.moneyEffect || {}),
    diagnosis: nextData.analysis.diagnosis || {},
  });
  const sharedRegime = nextData.analysis.marketRegime;
  state.analysis = sharedRegime?.state ? {
    ...localAnalysis,
    stage: sharedRegime.state,
    explanation: sharedRegime.text || localAnalysis.explanation,
  } : localAnalysis;
  renderAll();
  if (state.liveFlowSnapshot) {
    applyLiveFlowSnapshot(state.liveFlowSnapshot, {forceFollow: options.forceFollow});
  }
  if (state.playback) state.playback.paint(performance.now(), Number(dom.timeline.value), true);
}

async function refreshLiveData(options = {}) {
  if (state.liveRefreshRunning) return false;
  state.liveRefreshRunning = true;
  try {
    const nextData = await loadCoreData();
    const changed = options.force || dataStamp(nextData) !== dataStamp(state.data);
    if (changed) applyCoreData(nextData, options);
    if (state.membershipActive) await refreshIndexContributionData({silent: true});
    return changed;
  } catch (error) {
    if (options.force) showNotice("最新数据读取失败，页面继续保留上一份已验证数据。", "error", true);
    logTechnicalError(error, "盘中数据轮询");
    return false;
  } finally {
    state.liveRefreshRunning = false;
  }
}

function scheduleAutoReload() {
  clearTimeout(state.autoReloadTimer);
  if (document.hidden || !inTradingWindow()) return;
  state.autoReloadTimer = window.setTimeout(async () => {
    await refreshLiveData();
    scheduleAutoReload();
  }, 15000);
}

function clearLiveFlowPolling() {
  clearTimeout(state.liveFlowTimer);
  state.liveFlowTimer = 0;
}

async function refreshLiveFlow(options = {}) {
  if (state.liveFlowRequestRunning || document.hidden) return false;
  if (!options.force && !options.allowClosed && !inTradingWindow()) return false;
  state.liveFlowRequestRunning = true;
  try {
    const snapshot = options.force
      ? await requestLiveSectorFlowRefresh()
      : await loadLiveSectorFlows();
    return applyLiveFlowSnapshot(snapshot, {forceFollow: options.forceFollow});
  } catch (error) {
    updateLiveFlowStatus(null, error);
    logTechnicalError(error, "逐秒板块资金");
    return false;
  } finally {
    state.liveFlowRequestRunning = false;
  }
}

function scheduleLiveFlowPolling(delayMs = null) {
  clearLiveFlowPolling();
  if (document.hidden) return;
  const delay = delayMs === null ? (inTradingWindow() ? 0 : 5000) : Math.max(0, delayMs);
  state.liveFlowTimer = window.setTimeout(async () => {
    state.liveFlowTimer = 0;
    if (!inTradingWindow()) {
      scheduleLiveFlowPolling(5000);
      return;
    }
    const startedAt = performance.now();
    await refreshLiveFlow();
    const elapsed = performance.now() - startedAt;
    scheduleLiveFlowPolling(Math.max(50, 1000 - elapsed));
  }, delay);
}

async function initialize() {
  setupInteractions();
  try {
    applyCoreData(await loadCoreData(), {forceFollow: true});
    initializePlayback();
    await refreshIndexContributionData({probe: true, silent: true});
  } catch (error) {
    dom.dataAlert.hidden = false;
    dom.dataAlert.textContent = error.message;
    showNotice("复盘数据未能完整载入，可点击刷新页面重试。", "error", true);
    logTechnicalError(error, "首页加载");
  }
  await checkService();
  await refreshLiveFlow({allowClosed: true, forceFollow: true});
  scheduleAutoReload();
  scheduleLiveFlowPolling();
}

window.addEventListener("a-share-membership-change", (event) => {
  state.membershipActive = Boolean(event.detail?.active);
  if (!state.data) return;
  if (state.membershipActive) {
    refreshIndexContributionData({silent: true});
    return;
  }
  state.data = {...state.data, indexContribution: null};
  renderIndexContribution(Number(dom.timeline.value));
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    scheduleAutoReload();
    clearLiveFlowPolling();
  } else {
    Promise.all([
      refreshLiveData({force: true}),
      refreshLiveFlow({allowClosed: true, forceFollow: true}),
    ]).finally(() => {
      scheduleAutoReload();
      scheduleLiveFlowPolling();
    });
  }
});
window.addEventListener("pagehide", () => {
  clearTimeout(state.autoReloadTimer);
  clearLiveFlowPolling();
}, {once: true});
initialize();
