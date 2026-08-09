import {
  loadThemeTreasure,
  loadThemeTreasureDetail,
  logTechnicalError,
  openTdxStock,
  refreshThemeTreasure,
} from "./api.js";
import {initializeTheme} from "./theme.js";

const dom = {
  status: document.querySelector("#themeStatus"),
  refresh: document.querySelector("#themeRefresh"),
  query: document.querySelector("#themeQuery"),
  sort: document.querySelector("#themeSort"),
  sourceTime: document.querySelector("#themeSourceTime"),
  rankingMeta: document.querySelector("#themeRankingMeta"),
  rankingList: document.querySelector("#themeRankingList"),
  code: document.querySelector("#themeCode"),
  title: document.querySelector("#themeDetailTitle"),
  headline: document.querySelector("#themeHeadline"),
  rank: document.querySelector("#themeRank"),
  metrics: document.querySelector("#themeMetrics"),
  evidence: document.querySelector("#themeEvidence"),
  risks: document.querySelector("#themeRisks"),
  mapMeta: document.querySelector("#themeMapMeta"),
  map: document.querySelector("#themeMapContent"),
  methodology: document.querySelector("#themeMethodology"),
};

const state = {
  sort: "score",
  query: "",
  ranking: null,
  selectedCode: "",
  detailCache: new Map(),
  loadId: 0,
  detailLoadId: 0,
  timer: null,
};

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = String(text);
  return node;
}

function finite(value) {
  if (value === null || value === undefined || value === "" || value === "-") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function signed(value, suffix = "") {
  const number = finite(value);
  return number === null ? "--" : `${number > 0 ? "+" : ""}${number.toFixed(2)}${suffix}`;
}

function amountText(value) {
  const number = finite(value);
  if (number === null) return "--";
  return `${number > 0 ? "+" : ""}${number.toFixed(Math.abs(number) >= 100 ? 1 : 2)}亿`;
}

function tone(value) {
  const number = finite(value);
  return number === null || number === 0 ? "" : number > 0 ? "gain" : "loss";
}

function rowButton(row) {
  const button = element("button", "theme-row");
  button.type = "button";
  button.dataset.code = row.code;
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", String(row.code === state.selectedCode));
  const main = element("span", "theme-row-main");
  main.append(element("span", "theme-row-rank", String(row.rank)), (() => {
    const identity = element("span", "theme-row-name");
    identity.append(element("strong", "", row.name), element("small", "", `${row.code} · 扩散${row.breadthPct === null ? "--" : `${row.breadthPct.toFixed(0)}%`}`));
    return identity;
  })());
  button.append(
    main,
    element("span", `theme-row-value ${tone(row.changePct)}`, signed(row.changePct, "%")),
    element("span", `theme-row-value ${tone(row.amount)}`, amountText(row.amount)),
    element("span", "theme-row-value theme-row-score", finite(row.score) === null ? "--" : row.score.toFixed(1)),
  );
  return button;
}

function selectedTheme() {
  return state.ranking?.items?.find((item) => item.code === state.selectedCode) || null;
}

function renderRanking() {
  const rows = Array.isArray(state.ranking?.items) ? state.ranking.items : [];
  dom.rankingList.replaceChildren();
  if (!rows.length) {
    dom.rankingList.append(element("div", "theme-empty", state.query ? "没有匹配的题材" : "题材榜单暂不可用"));
    return;
  }
  const fragment = document.createDocumentFragment();
  rows.forEach((row) => fragment.append(rowButton(row)));
  dom.rankingList.append(fragment);
  dom.rankingMeta.textContent = `${state.ranking.total || rows.length} 个有效题材 · 当前显示 ${rows.length} 个`;
}

function metric(label, value, className = "") {
  const item = element("div", "theme-metric");
  item.append(element("span", "", label), element("strong", className, value));
  return item;
}

function renderBaseDetail(theme) {
  if (!theme) {
    dom.code.textContent = "--";
    dom.title.textContent = "请选择题材";
    dom.headline.textContent = "从左侧榜单选择题材后查看解读和成分关系。";
    dom.rank.textContent = "--";
    dom.metrics.replaceChildren();
    dom.evidence.replaceChildren();
    dom.risks.replaceChildren();
    dom.map.replaceChildren(element("div", "theme-empty", "等待选择题材"));
    return;
  }
  dom.code.textContent = theme.code;
  dom.title.textContent = theme.name;
  dom.headline.textContent = theme.interpretation?.headline || "正在生成量化解读";
  dom.rank.textContent = `#${theme.ranks?.score || theme.rank || "--"}`;
  dom.metrics.replaceChildren(
    metric("题材涨跌", signed(theme.changePct, "%"), tone(theme.changePct)),
    metric("主力净额", amountText(theme.amount), tone(theme.amount)),
    metric("上涨 / 下跌", theme.upCount === null ? "--" : `${theme.upCount} / ${theme.downCount}`),
    metric("上涨占比", theme.breadthPct === null ? "--" : `${theme.breadthPct.toFixed(1)}%`),
    metric("系统综合分", finite(theme.score) === null ? "--" : theme.score.toFixed(1)),
  );
  dom.evidence.replaceChildren(...(theme.interpretation?.evidence || []).map((item) => element("li", "", item)));
  dom.risks.replaceChildren(...(theme.interpretation?.risks || []).map((item) => element("span", "theme-risk-tag", item)));
  dom.mapMeta.textContent = "正在读取高成交活跃成分股";
  dom.map.replaceChildren(element("div", "theme-empty", "题材图谱读取中"));
}

function stockNode(stock) {
  const row = element("div", "theme-stock-row");
  const identity = element("div", "theme-stock-identity");
  identity.append(
    element("strong", "", `${stock.name} ${stock.code}`),
    element("small", "", stock.relationReason || stock.industry || "题材成分股"),
  );
  const quote = element("div", "theme-stock-quote");
  quote.append(element("span", tone(stock.changePct), signed(stock.changePct, "%")));
  const open = element("button", "", "日K");
  open.type = "button";
  open.title = `在本机交易软件中打开${stock.name}日K`;
  open.addEventListener("click", async () => {
    open.disabled = true;
    try {
      await openTdxStock(stock);
    } catch (error) {
      dom.status.textContent = error.message || "日K打开失败";
      logTechnicalError(error, "题材成分股日K");
    } finally {
      open.disabled = false;
    }
  });
  quote.append(open);
  row.append(identity, quote);
  return row;
}

function renderDetail(detail) {
  const theme = detail?.theme || selectedTheme();
  if (!theme) return;
  dom.headline.textContent = detail?.interpretation?.headline || theme.interpretation?.headline || "暂无解读";
  dom.evidence.replaceChildren(...(detail?.interpretation?.evidence || theme.interpretation?.evidence || []).map((item) => element("li", "", item)));
  dom.risks.replaceChildren(...(detail?.interpretation?.risks || theme.interpretation?.risks || []).map((item) => element("span", "theme-risk-tag", item)));
  const groups = Array.isArray(detail?.groups) ? detail.groups : [];
  dom.map.replaceChildren();
  dom.map.append(element("div", "theme-root-node", `${theme.name} · ${signed(theme.changePct, "%")}`));
  if (!groups.length) {
    dom.map.append(element("div", "theme-empty", detail?.warning || "成分股真实样本暂不可用"));
  } else {
    const tree = element("div", "theme-tree-groups");
    groups.forEach((group) => {
      const section = element("section", "theme-stock-group");
      const list = element("div", "theme-stock-list");
      group.items.forEach((stock) => list.append(stockNode(stock)));
      section.append(element("div", "theme-role-label", group.role), list);
      tree.append(section);
    });
    dom.map.append(tree);
  }
  dom.mapMeta.textContent = detail?.constituentCount
    ? `已核验 ${detail.constituentCount} 只高成交活跃成分股 · 点击日K打开本机交易软件`
    : "成分股接口暂未形成可核验样本";
}

async function loadDetail(code, options = {}) {
  if (!code) return;
  const requestId = ++state.detailLoadId;
  if (!options.force && state.detailCache.has(code)) {
    renderDetail(state.detailCache.get(code));
    return;
  }
  try {
    const detail = await loadThemeTreasureDetail(code);
    if (requestId !== state.detailLoadId || code !== state.selectedCode) return;
    state.detailCache.set(code, detail);
    renderDetail(detail);
  } catch (error) {
    if (requestId !== state.detailLoadId) return;
    dom.map.replaceChildren(element("div", "theme-empty", error.message || "题材图谱读取失败"));
    logTechnicalError(error, "题材解读");
  }
}

function selectTheme(code, options = {}) {
  state.selectedCode = code;
  renderRanking();
  const theme = selectedTheme();
  renderBaseDetail(theme);
  if (theme) loadDetail(theme.code, options);
}

function updateStatus(data) {
  const sourceTime = data?.sourceTime || "--";
  dom.status.textContent = `${data?.marketPhase || "行情快照"} · ${data?.tradeDate || "--"} ${sourceTime}`;
  dom.sourceTime.textContent = `行情时间 ${data?.tradeDate || "--"} ${sourceTime}${data?.fallback ? " · 最近快照" : ""}`;
  dom.methodology.textContent = data?.methodology || "系统综合分仅用于应用内题材排序，不是行情源官方评级。";
}

async function loadRanking(options = {}) {
  const requestId = ++state.loadId;
  try {
    const data = await loadThemeTreasure({sort: state.sort, query: state.query, limit: 160});
    if (requestId !== state.loadId) return;
    state.ranking = data;
    updateStatus(data);
    const rows = Array.isArray(data?.items) ? data.items : [];
    const selectedExists = rows.some((row) => row.code === state.selectedCode);
    if (!selectedExists) state.selectedCode = rows[0]?.code || "";
    renderRanking();
    const theme = selectedTheme();
    renderBaseDetail(theme);
    if (theme) loadDetail(theme.code, {force: Boolean(options.forceDetail)});
  } catch (error) {
    if (requestId !== state.loadId) return;
    dom.status.textContent = error.message || "题材榜单读取失败";
    dom.rankingList.replaceChildren(element("div", "theme-empty", error.message || "题材榜单读取失败"));
    logTechnicalError(error, "题材宝典");
  }
}

function scheduleNext() {
  clearTimeout(state.timer);
  const delay = state.ranking?.active ? 3000 : 30000;
  state.timer = setTimeout(async () => {
    if (!document.hidden) await loadRanking();
    scheduleNext();
  }, delay);
}

let queryTimer = null;
dom.query.addEventListener("input", () => {
  clearTimeout(queryTimer);
  queryTimer = setTimeout(() => {
    state.query = dom.query.value.trim();
    state.selectedCode = "";
    loadRanking();
  }, 220);
});

dom.sort.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-sort]");
  if (!button || button.dataset.sort === state.sort) return;
  state.sort = button.dataset.sort;
  dom.sort.querySelectorAll("button[data-sort]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  state.selectedCode = "";
  loadRanking();
});

dom.rankingList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-code]");
  if (button) selectTheme(button.dataset.code);
});

dom.refresh.addEventListener("click", async () => {
  dom.refresh.disabled = true;
  dom.status.textContent = "正在重采题材行情";
  try {
    await refreshThemeTreasure();
    state.detailCache.clear();
    await loadRanking({forceDetail: true});
  } catch (error) {
    dom.status.textContent = error.message || "题材更新失败";
    logTechnicalError(error, "题材宝典手动刷新");
  } finally {
    dom.refresh.disabled = false;
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadRanking();
});
window.addEventListener("beforeunload", () => clearTimeout(state.timer), {once: true});

initializeTheme();
loadRanking().finally(scheduleNext);
