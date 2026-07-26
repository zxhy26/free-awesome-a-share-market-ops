import {
  loadNextWeekEventsData,
  logTechnicalError,
  openTdxStock,
  requestNextWeekEventsRefresh,
} from "./api.js?v=20260726-5";
import {initializeTheme} from "./theme.js";

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = String(text);
  return node;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function formatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {hour12: false});
}

function dateLabel(value) {
  const matched = String(value || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return matched ? `${matched[1]}年${Number(matched[2])}月${Number(matched[3])}日` : "日期待核对";
}

function buildShell() {
  const wrapper = element("div", "detail-shell weekly-events-shell");
  const header = element("header", "detail-header");
  const title = document.createElement("div");
  title.append(
    element("h1", "", "下周大事件"),
    element("p", "", "宏观、政策、市场、产业与国际地缘关键日历"),
  );
  const actions = element("nav", "detail-actions");
  const back = element("a", "button", "返回首页");
  back.href = "/app/";
  const refresh = element("button", "button button-primary");
  refresh.type = "button";
  refresh.innerHTML = "<span aria-hidden=\"true\">↻</span><span>更新事件</span>";
  const theme = element("fieldset", "theme-segment");
  theme.setAttribute("aria-label", "主题模式");
  [["system", "跟随"], ["light", "浅色"], ["dark", "深色"]].forEach(([value, text]) => {
    const button = element("button", "", text);
    button.type = "button";
    button.dataset.themeChoice = value;
    theme.append(button);
  });
  actions.append(back, refresh, theme);
  header.append(title, actions);
  const notice = element("div", "notice-bar");
  notice.hidden = true;
  const content = element("section", "weekly-events-content");
  const footer = element("footer", "app-footer");
  footer.append(
    element("p", "", "事件时间和议程可能临时调整，以公开来源最新发布为准。"),
    element("p", "", "影响板块用于复盘观察，不代表涨跌预测或投资建议。"),
  );
  wrapper.append(header, notice, content, footer);
  return {wrapper, content, notice, refresh};
}

function overview(data) {
  const section = element("section", "weekly-overview");
  const values = [
    ["目标周", `${data.weekStart || "--"} 至 ${data.weekEnd || "--"}`, "按北京时间"],
    ["关键事件", data.stats?.total || 0, `核心 ${data.stats?.core || 0} 项`],
    ["国内 / 国际", `${data.stats?.domestic || 0} / ${data.stats?.international || 0}`, "按主要影响范围"],
    ["最近更新", formatDateTime(data.generatedAt), `关联个股 ${data.relatedStocksStatus?.coveredEvents || 0}/${data.relatedStocksStatus?.targetEvents || 0} 项`],
  ];
  values.forEach(([label, value, detail]) => {
    const item = element("div", "weekly-overview-item");
    item.append(
      element("span", "", label),
      element("strong", "", value),
      element("small", "", detail),
    );
    section.append(item);
  });
  return section;
}

function coreFocus(data) {
  const section = element("section", "weekly-core");
  const header = element("header", "weekly-section-heading");
  header.append(
    element("h2", "", "核心关注"),
    element("p", "", data.summary || "等待形成目标周事件序列。"),
  );
  const list = element("div", "weekly-core-list");
  const eventById = new Map(safeArray(data.events).map((event) => [event.id, event]));
  safeArray(data.coreFocus).forEach((item) => {
    const event = eventById.get(item.id) || item;
    const row = element("article", "weekly-core-row");
    const time = element("time", "", `${item.date || "--"}${item.time ? ` ${item.time}` : ""}`);
    const copy = document.createElement("div");
    copy.append(element("strong", "", item.title || "未命名事件"));
    if (safeArray(item.sectors).length) copy.append(element("p", "", `关注行业：${item.sectors.join("、")}`));
    if (safeArray(item.relatedStocks).length) copy.append(element("p", "weekly-core-stocks", `关联个股：${item.relatedStocks.map((stock) => `${stock.name}(${stock.code})`).join("、")}，具体理由见下方事件明细。`));
    const badge = element("span", "weekly-importance core", event.importanceLabel || "核心");
    row.append(time, copy, badge);
    list.append(row);
  });
  if (!list.children.length) list.append(element("div", "empty-state compact-state", "当前目标周没有达到核心级别的事件。"));
  section.append(header, list);
  return section;
}

function relatedStockButton(stock) {
  const button = element("button", "weekly-related-stock");
  button.type = "button";
  button.dataset.stockOpen = "true";
  button.dataset.stockCode = stock.code || "";
  button.dataset.stockMarket = String(stock.market ?? "");
  button.dataset.stockName = stock.name || "";
  button.title = `打开${stock.name || stock.code}日K`;
  const identity = element("span", "weekly-related-stock-identity");
  identity.append(
    element("strong", "", stock.name || stock.code),
    element("span", "", stock.code || ""),
    stock.sector ? element("em", "", stock.sector) : document.createTextNode(""),
  );
  const reason = element("span", "weekly-related-stock-reason");
  const lines = [
    ["事件成因", stock.eventCause],
    ["公司主营", stock.companyBusiness || stock.companyProfile?.businessIntro],
    ["业务传导", stock.companyLink],
    ["验证指标", stock.watchPoint],
  ].filter(([, value]) => String(value || "").trim());
  if (lines.length) {
    lines.forEach(([label, value]) => {
      const line = element("span", "weekly-related-stock-reason-line");
      line.append(element("b", "", label), document.createTextNode(String(value)));
      reason.append(line);
    });
  } else {
    reason.append(element("span", "weekly-related-stock-reason-line", stock.relationReason || "公司资料尚未取回，本页不使用推测内容补足。"));
  }
  button.append(identity, reason);
  return button;
}

function eventRow(event) {
  const article = element("article", "weekly-event-row");
  const timing = element("div", "weekly-event-time");
  timing.append(
    element("strong", "", event.time || "全天"),
    element("span", "", event.weekday || ""),
    event.ongoing ? element("small", "", "持续进行") : document.createTextNode(""),
  );
  const main = element("div", "weekly-event-main");
  const meta = element("div", "weekly-event-meta");
  meta.append(
    element("span", `weekly-scope ${event.scope || "international"}`, event.scopeLabel || "国际"),
    element("span", "weekly-category", event.categoryLabel || "关键事件"),
    element("span", `weekly-importance level-${event.importance || 3}`, event.importanceLabel || "关注"),
  );
  const title = element("a", "weekly-event-title", event.title || "未命名事件");
  title.href = event.sourceUrl || "#";
  title.target = "_blank";
  title.rel = "noopener noreferrer";
  main.append(meta, title);
  if (event.content) main.append(element("p", "weekly-event-content", event.content));
  main.append(element("p", "weekly-event-reason", event.reason || "盘中结合指数、量价和行业资金验证。"));

  const side = element("aside", "weekly-event-side");
  const sectors = element("div", "weekly-sector-list");
  safeArray(event.sectors).forEach((sector) => sectors.append(element("span", "", sector)));
  if (!sectors.children.length) sectors.append(element("span", "muted-sector", "全市场观察"));
  const related = element("div", "weekly-related-stocks");
  related.append(element("strong", "", "关联个股"));
  related.append(element("small", "weekly-related-note", "以下逐项列出具体事件、公司主营和验证指标，不代表公司已披露直接事项。"));
  const relatedList = element("div", "weekly-related-stock-list");
  safeArray(event.relatedStocks).forEach((stock) => relatedList.append(relatedStockButton(stock)));
  if (!relatedList.children.length) relatedList.append(element("span", "weekly-related-empty", "暂无可靠板块成分股匹配"));
  related.append(relatedList);
  const source = element("a", "weekly-event-source", event.source || "公开来源");
  source.href = event.sourceUrl || "#";
  source.target = "_blank";
  source.rel = "noopener noreferrer";
  side.append(sectors, related, source);
  article.append(timing, main, side);
  return article;
}

function timeline(events) {
  const section = element("section", "weekly-timeline");
  if (!events.length) {
    section.append(element("div", "empty-state", "当前筛选条件下没有事件。"));
    return section;
  }
  const groups = new Map();
  events.forEach((event) => {
    if (!groups.has(event.date)) groups.set(event.date, []);
    groups.get(event.date).push(event);
  });
  groups.forEach((rows, date) => {
    const group = element("section", "weekly-day");
    const heading = element("header", "weekly-day-heading");
    heading.append(
      element("h2", "", dateLabel(date)),
      element("span", "", `${rows[0]?.weekday || ""} · ${rows.length} 项`),
    );
    const list = element("div", "weekly-day-list");
    rows.forEach((event) => list.append(eventRow(event)));
    group.append(heading, list);
    section.append(group);
  });
  return section;
}

function buildControls(data, render) {
  const section = element("section", "weekly-controls");
  const tabs = element("nav", "weekly-scope-tabs");
  tabs.setAttribute("aria-label", "事件范围");
  [["all", "全部"], ["core", "核心"], ["domestic", "国内"], ["international", "国际"]].forEach(([value, text]) => {
    const button = element("button", "", text);
    button.type = "button";
    button.dataset.scope = value;
    button.setAttribute("aria-pressed", String(value === "all"));
    tabs.append(button);
  });
  const category = document.createElement("select");
  category.setAttribute("aria-label", "事件类型");
  [
    ["all", "全部类型"],
    ["policy", "政策会议"],
    ["macro", "宏观数据"],
    ["market", "市场日历"],
    ["industry", "产业事件"],
    ["geopolitics", "国际与地缘"],
  ].forEach(([value, text]) => {
    const option = element("option", "", text);
    option.value = value;
    category.append(option);
  });
  const count = element("strong", "weekly-result-count", `${safeArray(data.events).length} 项`);
  section.append(tabs, category, count);
  const state = {scope: "all", category: "all"};
  const update = () => {
    const rows = safeArray(data.events).filter((event) => {
      if (state.scope === "core" && Number(event.importance) < 5) return false;
      if (["domestic", "international"].includes(state.scope) && event.scope !== state.scope) return false;
      return state.category === "all" || event.category === state.category;
    });
    count.textContent = `${rows.length} 项`;
    render(rows);
  };
  tabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-scope]");
    if (!button) return;
    state.scope = button.dataset.scope;
    tabs.querySelectorAll("button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    update();
  });
  category.addEventListener("change", () => {
    state.category = category.value;
    update();
  });
  return {section, update};
}

function sourceNote(data) {
  const section = element("section", "weekly-source-note");
  const link = element("a", "", data.source?.name || "公开财经日历");
  link.href = data.source?.url || "#";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  section.append(
    element("strong", "", "数据与筛选口径"),
    element("p", "", data.source?.filter || "只保留与A股复盘相关的关键事件。"),
    element("p", "", `关联个股按${data.relatedStocksStatus?.source || "公开板块成分股与公司资料"}匹配，并优先展示对应板块总市值靠前的代表公司；每只股票分别列出具体事件成因、F10主营业务、业务传导和验证指标。当前覆盖 ${data.relatedStocksStatus?.coveredEvents || 0}/${data.relatedStocksStatus?.targetEvents || 0} 项含行业事件，公司资料覆盖 ${data.relatedStocksStatus?.profileCovered || 0}/${data.relatedStocksStatus?.stockCount || 0} 只。`),
    link,
  );
  safeArray(data.warnings).forEach((warning) => section.append(element("p", "weekly-warning", warning)));
  return section;
}

function renderData(view, data) {
  const timelineHost = element("div", "weekly-timeline-host");
  const controls = buildControls(data, (events) => timelineHost.replaceChildren(timeline(events)));
  view.content.replaceChildren(
    overview(data),
    coreFocus(data),
    controls.section,
    timelineHost,
    sourceNote(data),
  );
  controls.update();
}

async function initialize() {
  const root = document.querySelector("#nextWeekEventsApp");
  const view = buildShell();
  root.replaceChildren(view.wrapper);
  initializeTheme();
  view.content.append(element("div", "loading-state", "正在读取目标周关键事件…"));
  let loading = false;
  let generatedAt = "";

  async function load({silent = false} = {}) {
    if (loading) return;
    loading = true;
    try {
      const data = await loadNextWeekEventsData();
      if (!silent || data.generatedAt !== generatedAt) {
        generatedAt = data.generatedAt || "";
        renderData(view, data);
      }
    } catch (error) {
      if (!silent) view.content.replaceChildren(element("div", "error-state", error.message));
      logTechnicalError(error, "下周大事件页面");
    } finally {
      loading = false;
    }
  }

  view.refresh.addEventListener("click", async () => {
    const previous = view.refresh.innerHTML;
    view.refresh.disabled = true;
    view.refresh.textContent = "更新中";
    view.notice.className = "notice-bar";
    view.notice.hidden = false;
    view.notice.textContent = "正在核对并筛选目标周公开财经日历。";
    try {
      await requestNextWeekEventsRefresh();
      await load();
      view.notice.className = "notice-bar success";
      view.notice.textContent = "下周大事件已更新。";
    } catch (error) {
      view.notice.className = "notice-bar error";
      view.notice.textContent = error.message;
      logTechnicalError(error, "下周大事件更新");
    } finally {
      view.refresh.disabled = false;
      view.refresh.innerHTML = previous;
    }
  });

  view.content.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-stock-open]");
    if (!button) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "打开中";
    try {
      await openTdxStock({
        code: button.dataset.stockCode,
        market: button.dataset.stockMarket,
        name: button.dataset.stockName,
      });
      button.textContent = "已打开";
    } catch (error) {
      button.textContent = "未打开";
      button.title = error.message;
      logTechnicalError(error, "下周事件关联个股日K");
    } finally {
      setTimeout(() => {
        button.disabled = false;
        button.textContent = original;
      }, 1600);
    }
  });

  await load();
  setInterval(() => {
    if (!document.hidden) load({silent: true});
  }, 60 * 1000);
}

initialize();
