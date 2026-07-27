import {loadDataHealth, logTechnicalError, requestMarketSync} from "./api.js?v=20260719-2";
import {initializeTheme} from "./theme.js?v=20260719-2";

function node(tag, className = "", text = "") {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== "") item.textContent = String(text);
  return item;
}

function statusText(status) {
  return status === "ok"
    ? "正常"
    : status === "error"
      ? "异常"
      : status === "single"
        ? "单源"
        : status === "pending"
          ? "待发布"
          : "注意";
}

function statusPill(status) {
  return node("span", `health-status ${status || "warning"}`, statusText(status));
}

function shell() {
  const wrapper = node("div", "detail-shell upgrade-shell");
  const header = node("header", "detail-header");
  const title = node("div");
  title.append(node("h1", "", "数据状态"), node("p", "", "交易日、分时采样、数据完整度和核心指数双源校验。"));
  const actions = node("nav", "detail-actions");
  const back = node("a", "button", "返回首页"); back.href = "../index.html";
  const history = node("a", "button", "历史回放"); history.href = "history.html";
  const sync = node("button", "button button-primary", "同步市场"); sync.type = "button";
  const theme = node("fieldset", "theme-segment"); theme.setAttribute("aria-label", "主题模式");
  [["system", "跟随"], ["light", "浅色"], ["dark", "深色"]].forEach(([value, text]) => {
    const button = node("button", "", text); button.type = "button"; button.dataset.themeChoice = value; theme.append(button);
  });
  actions.append(back, history, sync, theme); header.append(title, actions);
  const notice = node("div", "notice-bar"); notice.hidden = true;
  const content = node("section", "upgrade-content");
  wrapper.append(header, notice, content);
  return {wrapper, content, notice, sync};
}

function render(view, data) {
  const overall = data.overall || {};
  const session = data.session || {};
  const historyModule = data.modules?.find((item) => item.key === "history");
  const historyCount = historyModule?.count ?? historyModule?.sample?.archiveCount ?? 0;
  const summary = node("section", "health-summary");
  [
    ["整体状态", statusText(overall.status), `完整度 ${overall.score ?? "--"} 分`],
    ["交易日", data.tradeDate || "--", session.phase || "--"],
    ["最新样本", session.latestTime || "--", `第 ${session.latestMinute ?? "--"} 分钟`],
    ["历史归档", historyCount, "个可回放交易日"],
  ].forEach(([label, value, note]) => {
    const block = node("div"); block.append(node("span", "metric-label", label), node("strong", "", value), node("p", "", note)); summary.append(block);
  });

  const moduleSection = node("section", "upgrade-section");
  const moduleHeader = node("header", "upgrade-heading");
  moduleHeader.append(node("h2", "", "模块健康"), node("p", "", `${overall.errorCount || 0} 项异常，${overall.warningCount || 0} 项注意，${overall.pendingCount || 0} 项待发布`));
  const modules = node("div", "health-modules");
  (data.modules || []).forEach((item) => {
    const row = node("article", "health-module");
    const identity = node("div"); identity.append(node("strong", "", item.label || item.name || item.key), node("p", "", item.detail || item.warnings?.[0] || "当前模块未发现异常"));
    const stats = node("div", "health-module-stats");
    stats.append(node("span", "", `完整度 ${item.completeness ?? "--"}%`));
    if (item.sampleCount !== undefined) stats.append(node("span", "", `样本 ${item.sampleCount}`));
    const itemCount = item.count ?? item.sample?.archiveCount;
    if (itemCount !== undefined) stats.append(node("span", "", `数量 ${itemCount}`));
    row.append(identity, stats, statusPill(item.status)); modules.append(row);
  });
  moduleSection.append(moduleHeader, modules);

  const crossSection = node("section", "upgrade-section");
  const crossHeader = node("header", "upgrade-heading"); crossHeader.append(node("h2", "", "数据交叉校验"), node("p", "", "核心指数主源与备用源、板块分时与实时排名口径核对"));
  const checks = node("div", "health-checks");
  (data.crossChecks || []).forEach((item) => {
    const row = node("article", "health-check");
    const text = node("div"); text.append(node("strong", "", item.label || item.name || "校验项"), node("p", "", item.detail || "--"));
    row.append(text, statusPill(item.status)); checks.append(row);
  });
  if (!checks.children.length) checks.append(node("div", "empty-state", "当前同步批次尚未返回交叉校验结果。"));
  crossSection.append(crossHeader, checks);

  const policy = node("section", "health-policy");
  policy.append(node("strong", "", "分时样本口径"), node("p", "", session.samplePolicy || "只使用真实样本，并在真实样本之间线性显示。"));
  view.content.replaceChildren(summary, moduleSection, crossSection, policy);
}

async function initialize() {
  const root = document.querySelector("#dataHealthApp");
  const view = shell(); root.replaceChildren(view.wrapper); initializeTheme();
  async function load() {
    view.content.replaceChildren(node("div", "loading-state", "正在读取数据状态…"));
    try { render(view, await loadDataHealth()); }
    catch (error) { view.content.replaceChildren(node("div", "error-state", error.message)); logTechnicalError(error, "数据状态"); }
  }
  view.sync.addEventListener("click", async () => {
    view.sync.disabled = true; view.notice.hidden = false; view.notice.textContent = "正在同步市场数据。";
    try { await requestMarketSync((progress) => { view.notice.textContent = `${progress.message || "正在同步"} ${progress.percent || 0}%`; }); await load(); view.notice.className = "notice-bar success"; view.notice.textContent = "同步完成，数据状态已更新。"; }
    catch (error) { view.notice.className = "notice-bar error"; view.notice.textContent = error.message; logTechnicalError(error, "数据状态同步"); }
    finally { view.sync.disabled = false; }
  });
  await load();
  setInterval(() => { if (!document.hidden) load(); }, 30000);
}

initialize();
