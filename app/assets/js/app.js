import {getHealth, loadCoreData, logTechnicalError, openTdxStock, requestMarketSync} from "./api.js?v=20260719-2";
import {analyzeMarket, buildMoneyMetrics, dataFreshness, finiteNumber, formatNumber, formatPercent, formatYi, signed, summarizeMoneyEffect, valueClass} from "./analysis.js?v=20260726-1";
import {createIndexCharts, createPlaybackController, marketMinuteToTime, updateIndexCharts} from "./charts.js?v=20260719-2";
import {createSummaryDialog} from "./dialog.js";
import {initializePwa} from "./pwa.js?v=20260719-2";
import {createSectorFlowChart} from "./sector-flow-chart.js?v=20260719-2";
import {initializeTheme} from "./theme.js";
import {inTradingWindow} from "./market-session.js";

const dom = {
  tradeDate: document.querySelector("#tradeDate"),
  marketState: document.querySelector("#marketState"),
  lastSync: document.querySelector("#lastSync"),
  syncAge: document.querySelector("#syncAge"),
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
  timeline: document.querySelector("#timeline"),
  timelineTime: document.querySelector("#timelineTime"),
  timelineEnd: document.querySelector("#timelineEnd"),
  playButton: document.querySelector("#playButton"),
  speedSelect: document.querySelector("#speedSelect"),
  industryFlowChart: document.querySelector("#industryFlowChart"),
  industryFlow: document.querySelector("#industryFlow"),
  conceptFlowChart: document.querySelector("#conceptFlowChart"),
  conceptFlow: document.querySelector("#conceptFlow"),
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
  flowCharts: {industry: null, concept: null},
  flowView: {industry: "inflow", concept: "inflow"},
  flowRenderedView: {industry: "", concept: ""},
  flowRenderVersion: {industry: 0, concept: 0},
  autoReloadTimer: 0,
  liveRefreshRunning: false,
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

function stableFlowMaximum(group, view) {
  const cached = flowScaleCache.get(group) || {};
  if (cached[view]) return cached[view];
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
    cached[view] = 1;
    flowScaleCache.set(group, cached);
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(rawMaximum));
  const step = Math.max(0.01, magnitude / 10);
  const maximum = Math.ceil((rawMaximum * 1.08) / step) * step;
  cached[view] = maximum;
  flowScaleCache.set(group, cached);
  return maximum;
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

function syncFlowTabs(groupName) {
  const tabs = document.querySelector(`[data-flow-tabs="${groupName}"]`);
  if (!tabs) return;
  const view = state.flowView[groupName] === "outflow" ? "outflow" : "inflow";
  tabs.dataset.activeFlowView = view;
  tabs.querySelectorAll("button[data-flow-view]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.flowView === view));
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

function renderFlow(groupName, minute) {
  const target = groupName === "industry" ? dom.industryFlow : dom.conceptFlow;
  const group = state.data?.sectors?.[groupName];
  if (!group) return;
  const rows = (group.rows || []).map((row) => ({...row, currentAmount: currentFlowAmount(row, minute)}));
  const view = state.flowView[groupName];
  const filtered = addDistinctFlowLabels(rows
    .filter((row) => view === "inflow" ? row.currentAmount > 0 : row.currentAmount < 0)
    .sort(compareFlowRank)
    .slice(0, 10));
  const maximum = stableFlowMaximum(group, view);
  const viewChanged = state.flowRenderedView[groupName] !== view;
  const renderVersion = ++state.flowRenderVersion[groupName];
  state.flowRenderedView[groupName] = view;
  syncFlowTabs(groupName);
  state.flowCharts[groupName]?.render(group, {minute, view, maximum});
  let head = target.querySelector(".flow-head");
  if (!head) {
    head = el("div", "flow-head");
    ["排名", "板块", "资金金额", "资金长度", "日K"].forEach((text, index) => {
      const column = el("span", "", text);
      if (index === 2) column.dataset.flowAmountHead = "";
      head.append(column);
    });
    target.prepend(head);
  }
  head.querySelector("[data-flow-amount-head]").textContent = view === "inflow" ? "净流入↓" : "净流出↓";
  if (viewChanged) {
    target.querySelectorAll(".flow-row, .empty-state").forEach((node) => node.remove());
    target.scrollTop = 0;
  }
  target.querySelector(".empty-state")?.remove();
  const existing = new Map([...target.querySelectorAll(".flow-row")].map((line) => [line.dataset.flowKey, line]));
  const activeKeys = new Set();
  filtered.forEach((row, index) => {
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
    line.dataset.flowView = view;
    const rankAmount = Math.abs(row.currentAmount);
    line.classList.toggle("outflow", row.currentAmount < 0);
    line.dataset.flowRankAmount = rankAmount.toFixed(4);
    line.querySelector(".flow-rank").textContent = String(index + 1);
    const name = line.querySelector(".flow-name");
    name.textContent = row.displayName;
    name.title = row.tdxName && row.tdxName !== row.name ? `${row.tdxName} / 原：${row.name}` : row.name || "";
    const value = line.querySelector(".flow-value");
    value.className = `flow-value ${valueClass(row.currentAmount)}`;
    value.textContent = `${rankAmount.toFixed(1)}亿`;
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
        if (state.flowRenderVersion[groupName] === renderVersion && bar.isConnected && line.dataset.flowView === view) {
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
    target.append(line);
  });
  existing.forEach((line, key) => { if (!activeKeys.has(key)) line.remove(); });
  if (!filtered.length) target.append(el("div", "empty-state", "当前方向尚未形成可展示的板块。"));
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
  state.charts = createIndexCharts(dom.indexGrid, state.data.indices.items || [], industryAttributionRows);
  updateIndexCharts(state.charts, Number(dom.timeline.value));
  renderFlow("industry", Number(dom.timeline.value));
  renderFlow("concept", Number(dom.timeline.value));
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
      renderFlow("industry", minute);
      renderFlow("concept", minute);
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
    await requestMarketSync((progress) => showNotice(`${progress.message || "正在同步"}${progress.percent ? ` ${progress.percent}%` : ""}`, "", true));
    await refreshLiveData({force: true, forceFollow: true});
    showNotice("同步成功，指数与板块资金已更新到同一时间点。", "success");
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
  state.flowCharts.industry = createSectorFlowChart(dom.industryFlowChart);
  state.flowCharts.concept = createSectorFlowChart(dom.conceptFlowChart);
  dom.reloadButton.addEventListener("click", () => location.reload());
  dom.syncButton.addEventListener("click", syncMarket);
  [dom.industryFlow, dom.conceptFlow].forEach((container) => {
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
        showNotice(error.message || "未检测到可自动操作的本机股票软件，已尝试网页行情兜底。", "error", true);
        logTechnicalError(error, "本机板块日K");
      } finally {
        window.setTimeout(() => {
          button.disabled = false;
          button.textContent = oldText;
        }, 1800);
      }
    });
  });
  document.querySelectorAll("[data-flow-tabs]").forEach((tabs) => {
    tabs.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-flow-view]");
      if (!button) return;
      const group = tabs.dataset.flowTabs;
      const nextView = button.dataset.flowView === "outflow" ? "outflow" : "inflow";
      if (!state.flowView[group] || state.flowView[group] !== nextView) state.flowView[group] = nextView;
      syncFlowTabs(group);
      renderFlow(group, Number(dom.timeline.value));
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
  state.data = nextData;
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
  if (state.playback) state.playback.paint(performance.now(), Number(dom.timeline.value), true);
}

async function refreshLiveData(options = {}) {
  if (state.liveRefreshRunning) return false;
  state.liveRefreshRunning = true;
  try {
    const nextData = await loadCoreData();
    const changed = options.force || dataStamp(nextData) !== dataStamp(state.data);
    if (changed) applyCoreData(nextData, options);
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

async function initialize() {
  setupInteractions();
  try {
    applyCoreData(await loadCoreData(), {forceFollow: true});
    initializePlayback();
  } catch (error) {
    dom.dataAlert.hidden = false;
    dom.dataAlert.textContent = error.message;
    showNotice("复盘数据未能完整载入，可点击刷新页面重试。", "error", true);
    logTechnicalError(error, "首页加载");
  }
  await checkService();
  scheduleAutoReload();
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) scheduleAutoReload();
  else refreshLiveData({force: true}).finally(scheduleAutoReload);
});
window.addEventListener("pagehide", () => clearTimeout(state.autoReloadTimer), {once: true});
initialize();
