import {
  loadThemeTreasure,
  loadThemeTreasureDetail,
  loadThemeStockProfile,
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
  companyDialog: document.querySelector("#themeCompanyDialog"),
  companyClose: document.querySelector("#themeCompanyClose"),
  companyEyebrow: document.querySelector("#themeCompanyEyebrow"),
  companyName: document.querySelector("#themeCompanyName"),
  companyCode: document.querySelector("#themeCompanyCode"),
  companyChange: document.querySelector("#themeCompanyChange"),
  companyRelation: document.querySelector("#themeCompanyRelation"),
  companyBusiness: document.querySelector("#themeCompanyBusiness"),
  companyFacts: document.querySelector("#themeCompanyFacts"),
  companyConcepts: document.querySelector("#themeCompanyConcepts"),
  companySource: document.querySelector("#themeCompanySource"),
  companyWarning: document.querySelector("#themeCompanyWarning"),
  companyOpenK: document.querySelector("#themeCompanyOpenK"),
};

const state = {
  sort: "score",
  query: "",
  ranking: null,
  selectedCode: "",
  detailCache: new Map(),
  companyCache: new Map(),
  activeStock: null,
  loadId: 0,
  detailLoadId: 0,
  companyLoadId: 0,
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

function dateTimeText(value) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", {hour12: false});
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
  const loadedCount = Number(state.ranking.total) || rows.length;
  const reportedCount = Number(state.ranking.reportedTotal) || loadedCount;
  dom.rankingMeta.textContent = `东财概念板块 ${reportedCount} 个 · 已加载 ${loadedCount} 个 · 当前显示 ${rows.length} 个`;
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
  const profile = element("button", "theme-stock-profile");
  profile.type = "button";
  profile.title = `查看${stock.name}的公司主营与题材关联`;
  const identity = element("div", "theme-stock-identity");
  identity.append(
    element("strong", "", `${stock.name} ${stock.code}`),
    element("small", "", stock.relationReason || stock.industry || "题材成分股"),
  );
  const quote = element("span", `theme-stock-change ${tone(stock.changePct)}`, signed(stock.changePct, "%"));
  profile.append(identity, quote);
  profile.addEventListener("click", () => openCompanyProfile(stock));
  const open = element("button", "theme-stock-k", "日K");
  open.type = "button";
  open.title = `在本机交易软件中打开${stock.name}日K`;
  open.addEventListener("click", async (event) => {
    event.stopPropagation();
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
  row.append(profile, open);
  return row;
}

function renderCompanyLoading(theme, stock) {
  dom.companyEyebrow.textContent = `${theme.name} · ${stock.role || "成分股"}`;
  dom.companyName.textContent = stock.name;
  dom.companyCode.textContent = stock.code;
  dom.companyChange.textContent = signed(stock.changePct, "%");
  dom.companyChange.className = `theme-company-change ${tone(stock.changePct)}`;
  dom.companyRelation.textContent = stock.relationReason || `${stock.name}属于“${theme.name}”公开成分股。`;
  dom.companyBusiness.textContent = "正在读取公司公开主营资料。";
  dom.companyFacts.replaceChildren();
  dom.companyConcepts.replaceChildren();
  dom.companySource.textContent = "资料来源读取中";
  dom.companyWarning.hidden = true;
  dom.companyWarning.textContent = "";
}

function renderCompanyProfile(profile) {
  const stock = profile?.stock || state.activeStock || {};
  dom.companyEyebrow.textContent = `${profile?.theme?.name || "题材"} · ${stock.role || "成分股"}`;
  dom.companyName.textContent = profile?.company?.name || stock.name || "公司资料";
  dom.companyCode.textContent = `${stock.name || ""} ${stock.code || ""}`.trim();
  dom.companyChange.textContent = signed(stock.changePct, "%");
  dom.companyChange.className = `theme-company-change ${tone(stock.changePct)}`;
  dom.companyRelation.textContent = profile?.relationReason || "当前仅确认该股属于所选公开题材成分股。";
  dom.companyBusiness.textContent = profile?.businessSummary || "暂无可核验的公司主营简介。";
  dom.companyFacts.replaceChildren(...(profile?.evidence || []).map((item) => element("span", "theme-company-chip", item)));
  const concepts = Array.isArray(profile?.relevantConcepts) ? profile.relevantConcepts : [];
  dom.companyConcepts.replaceChildren(...(concepts.length ? concepts : ["暂无更多公开概念标签"])
    .map((item) => element("span", "theme-company-chip theme-company-concept", item)));
  dom.companySource.textContent = `${profile?.source || "公开公司资料"} · ${dateTimeText(profile?.fetchedAt)} · ${profile?.disclaimer || "仅作信息整理，不构成投资建议。"}`;
  dom.companyWarning.hidden = !profile?.warning;
  dom.companyWarning.textContent = profile?.warning || "";
}

async function openCompanyProfile(stock) {
  const theme = selectedTheme();
  if (!theme || !stock?.code) return;
  state.activeStock = {...stock, themeCode: theme.code, themeName: theme.name};
  const requestId = ++state.companyLoadId;
  renderCompanyLoading(theme, stock);
  if (!dom.companyDialog.open) dom.companyDialog.showModal();
  const cacheKey = `${theme.code}:${stock.code}`;
  if (state.companyCache.has(cacheKey)) {
    renderCompanyProfile(state.companyCache.get(cacheKey));
    return;
  }
  try {
    const profile = await loadThemeStockProfile(theme.code, stock.code);
    if (requestId !== state.companyLoadId) return;
    state.companyCache.set(cacheKey, profile);
    renderCompanyProfile(profile);
  } catch (error) {
    if (requestId !== state.companyLoadId) return;
    renderCompanyProfile({
      theme: {code: theme.code, name: theme.name},
      stock,
      company: {name: stock.name},
      relationReason: stock.relationReason || `${stock.name}属于“${theme.name}”公开成分股。`,
      businessSummary: "公司F10资料暂时无法读取，已保留可核验的题材成分关系。",
      evidence: [`题材成分：${theme.name}`, stock.industry ? `所属行业：${stock.industry}` : ""].filter(Boolean),
      relevantConcepts: stock.concepts || [],
      warning: error.message || "公司资料读取失败",
      disclaimer: "仅展示已核验的题材成分关系，不补写未经公开资料验证的业务信息。",
    });
    logTechnicalError(error, "题材个股公司详情");
  }
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
      section.append(element("div", "theme-role-label", `${group.role} ${group.items.length}`), list);
      tree.append(section);
    });
    dom.map.append(tree);
  }
  const reportedCount = Number(detail?.reportedConstituentCount) || Number(detail?.constituentCount) || 0;
  const excludedCount = Number(detail?.excludedConstituentCount) || 0;
  dom.mapMeta.textContent = detail?.constituentCount
    ? `东财公开成分 ${reportedCount} 只 · 已完整加载 ${detail.constituentCount} 只${excludedCount ? ` · ${excludedCount} 条无效记录未计入` : ""} · ST及退市风险股保留并按东财口径计数 · 点击个股查看公司主营与题材关联`
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
    const data = await loadThemeTreasure({sort: state.sort, query: state.query, limit: 600});
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
    state.companyCache.clear();
    await loadRanking({forceDetail: true});
  } catch (error) {
    dom.status.textContent = error.message || "题材更新失败";
    logTechnicalError(error, "题材宝典手动刷新");
  } finally {
    dom.refresh.disabled = false;
  }
});

dom.companyClose.addEventListener("click", () => dom.companyDialog.close());
dom.companyDialog.addEventListener("click", (event) => {
  if (event.target === dom.companyDialog) dom.companyDialog.close();
});
dom.companyDialog.addEventListener("close", () => {
  state.companyLoadId += 1;
  state.activeStock = null;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && dom.companyDialog.open) {
    event.preventDefault();
    dom.companyDialog.close();
  }
});
dom.companyOpenK.addEventListener("click", async () => {
  const stock = state.activeStock;
  if (!stock) return;
  dom.companyOpenK.disabled = true;
  try {
    await openTdxStock(stock);
  } catch (error) {
    dom.companyWarning.hidden = false;
    dom.companyWarning.textContent = error.message || "日K打开失败";
    logTechnicalError(error, "题材公司详情日K");
  } finally {
    dom.companyOpenK.disabled = false;
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadRanking();
});
window.addEventListener("beforeunload", () => clearTimeout(state.timer), {once: true});

initializeTheme();
loadRanking().finally(scheduleNext);
