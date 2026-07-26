import {loadPolicyNewsData, logTechnicalError, requestPolicyNewsRefresh} from "./api.js?v=20260719-2";
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

function option(value, text) {
  const node = element("option", "", text);
  node.value = value;
  return node;
}

function importanceLabel(value) {
  if (Number(value) >= 5) return "核心";
  if (Number(value) >= 4) return "重要";
  return "关注";
}

function dateKey(value) {
  const matched = String(value || "").match(/\d{4}-\d{2}-\d{2}/);
  return matched ? matched[0] : "时间待核对";
}

function dateLabel(value) {
  const matched = String(value || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return matched ? `${matched[1]}年${Number(matched[2])}月${Number(matched[3])}日` : "时间待核对";
}

function buildShell() {
  const wrapper = element("div", "detail-shell policy-shell");
  const header = element("header", "detail-header");
  const title = document.createElement("div");
  title.append(element("h1", "", "政策新闻"), element("p", "", "国内规划主线与国际关键事件，自动去重并剔除市场评论、荐股、个股业绩和无传导价值的信息。"));
  const actions = element("nav", "detail-actions");
  const back = element("a", "button", "返回首页"); back.href = "/app/";
  const refresh = element("button", "button button-primary", "同步新闻"); refresh.type = "button";
  const theme = element("fieldset", "theme-segment"); theme.setAttribute("aria-label", "主题模式");
  [["system", "跟随"], ["light", "浅色"], ["dark", "深色"]].forEach(([value, text]) => {
    const button = element("button", "", text); button.type = "button"; button.dataset.themeChoice = value; theme.append(button);
  });
  actions.append(back, refresh, theme);
  header.append(title, actions);
  const notice = element("div", "notice-bar"); notice.hidden = true;
  const content = element("section");
  const footer = element("footer", "app-footer");
  footer.append(element("p", "", "专栏只收录可核对的公开信息，事件影响为传导路径整理，不代表市场一定按该方向运行。"), element("p", "", "本软件仅用于市场数据整理和复盘分析，不构成任何投资建议。市场有风险，决策需独立判断。"));
  wrapper.append(header, notice, content, footer);
  return {wrapper, content, notice, refresh};
}

function overview(data) {
  const block = element("section", "policy-overview");
  const stats = data.stats || {};
  const dateRange = stats.oldestDate && stats.latestDate ? `${stats.oldestDate} 至 ${stats.latestDate}` : "等待形成历史序列";
  const cards = [
    ["国内关键消息", stats.domesticCount || 0, `三个五年规划官方基准 ${stats.foundationCount || 0} 条，永久保留`],
    ["国际关键消息", stats.internationalCount || 0, `滚动保留 ${data.retentionDays || 45} 天，覆盖利率、关税、能源、地缘与科技规则`],
    ["历史时间覆盖", `${stats.dateCount || 0} 个日期`, dateRange],
    ["最近更新", data.generatedAt || "--", `后台每 ${data.refreshMinutes || 10} 分钟检查一次`],
  ];
  cards.forEach(([label, value, note]) => {
    const card = document.createElement("div");
    card.append(element("span", "metric-label", label), element("strong", "", value), element("p", "", note));
    block.append(card);
  });
  return block;
}

function planBand(data) {
  const section = element("section", "plan-band");
  const heading = element("header", "policy-section-heading");
  const title = element("h2", "", "三个五年规划官方纲要与关键方向");
  heading.append(title, element("p", "", "方向与板块依据官方纲要归纳；历史基准永久保留，日常政策按发布时间更新。"));
  const grid = element("div", "plan-grid");
  safeArray(data.planReferences).forEach((plan) => {
    const article = element("article", "plan-reference");
    const top = document.createElement("header");
    const identity = element("div", "plan-identity");
    identity.append(element("h3", "", plan.id), element("span", "plan-status", plan.status || "官方纲要"));
    top.append(identity, element("time", "", plan.years));
    const officialTitle = element("p", "plan-official-title", plan.title || "官方规划纲要");
    const focus = element("p", "plan-focus", plan.focus || "方向待补充");
    const directions = element("div", "plan-directions");
    safeArray(plan.directions).forEach((direction) => {
      const row = element("div", "plan-direction");
      row.append(element("strong", "", direction.label || "重点方向"));
      const sectors = element("div", "plan-sector-list");
      safeArray(direction.sectors).forEach((sector) => sectors.append(element("span", "", sector)));
      row.append(sectors);
      directions.append(row);
    });
    const link = element("a", "", "打开官方纲要原文");
    link.href = plan.url; link.target = "_blank"; link.rel = "noopener";
    article.append(top, officialTitle, focus, directions, link);
    grid.append(article);
  });
  section.append(heading, grid);
  return section;
}

function eventChainBand(data) {
  const section = element("section", "event-chain-band");
  const heading = element("header", "policy-section-heading");
  heading.append(
    element("h2", "", "关键事件传导链"),
    element("p", "", "逐项列出事件触发、直接变量、产业传导、A股映射、确认信号和失效条件。"),
  );
  const grid = element("div", "event-chain-grid");
  const chains = safeArray(data.eventChains)
    .filter((event) => Number(event.importance || 0) >= 4 || event.foundation)
    .slice(0, 12);
  chains.forEach((event) => {
    const article = element("article", "event-chain-row");
    const top = element("div", "event-chain-top");
    top.append(
      element("span", "event-type", event.eventType || "关键事件"),
      element("span", `policy-tag policy-impact ${event.impactTone || "watch"}`, event.impact || "待观察"),
      element("span", "event-source", event.source || "公开资讯"),
      element("time", "", event.publishedAt || "时间待核对"),
      element("span", "event-confidence", `${event.confidence?.label || "观察"} ${event.confidence?.score ?? "--"}`),
    );
    const title = element("a", "event-chain-title", event.title || "未命名事件"); title.href = event.url || "#"; title.target = "_blank"; title.rel = "noopener";
    const window = element("p", "event-window", event.impactWindowText || "影响时窗需结合后续执行进展滚动确认。");
    const steps = element("ol", "event-chain-steps");
    const fallbackSteps = [
      {stage: "事件触发", content: event.summary || event.title || "事件内容待核对"},
      {stage: "传导路径", content: event.channel || "传导路径待补充"},
      {stage: "A股映射", content: safeArray(event.sectors).join("、") || "影响板块待确认"},
      {stage: "盘面确认", content: event.verification || "继续核对板块资金和个股承接"},
    ];
    (safeArray(event.transmissionSteps).length ? safeArray(event.transmissionSteps) : fallbackSteps).forEach((step) => {
      const row = element("li", "event-chain-step");
      row.append(element("strong", "", step.stage || "传导"), element("span", "", step.content || "待核对"));
      steps.append(row);
    });
    const directions = element("div", "event-direction-grid");
    const primary = element("section", "event-direction primary");
    primary.append(element("strong", "", event.primaryLabel || "当前偏向"), element("p", "", event.primaryPath || "等待价格和资金确认。"));
    const counter = element("section", "event-direction counter");
    counter.append(element("strong", "", event.counterLabel || "反向风险"), element("p", "", event.counterPath || "后续条件变化时重新评估。"));
    directions.append(primary, counter);
    const audit = element("div", "event-audit");
    audit.append(
      element("p", "", `确认：${safeArray(event.verificationPoints).join("；") || event.verification || "核对板块资金、价格与公司公告。"}`),
      element("p", "", `失效：${event.invalidation || "后续正式文件或市场数据与当前传导方向相反。"}`),
    );
    if (safeArray(event.linkedStocks).length) {
      audit.append(element("p", "event-linked-stocks", `量化交叉：${safeArray(event.linkedStocks).slice(0, 4).map((stock) => `${stock.name}（${stock.sector || "未分类"}）`).join("、")}`));
    }
    article.append(top, title, window, steps, directions, audit);
    grid.append(article);
  });
  if (!grid.children.length) grid.append(element("div", "empty-state", "事件链将在下一次数据同步后形成。"));
  section.append(heading, grid);
  return section;
}

function newsRow(item) {
  const article = element("article", "policy-news-row");
  const meta = element("div", "policy-news-meta");
  meta.append(
    element("span", `policy-scope ${item.scope === "international" ? "international" : "domestic"}`, item.scope === "international" ? "国际" : "国内"),
    element("span", "", item.source || "公开资讯"),
    element("time", "", item.publishedAt || "时间待核对"),
  );
  if (item.foundation) meta.append(element("span", "policy-foundation", "官方规划基准"));
  meta.append(element("span", `policy-importance level-${item.importance || 3}`, importanceLabel(item.importance)));
  const title = element("a", "policy-title", item.title || "未命名消息");
  title.href = item.url; title.target = "_blank"; title.rel = "noopener";
  const summary = element("p", "policy-summary", item.summary || "原文未提供可用摘要，请打开来源核对。" );
  const reason = element("div", "policy-reason");
  reason.append(element("strong", "", "A股传导路径"), element("p", "", item.chainSummary || item.reason || "暂未形成明确传导路径。"));
  if (item.impactWindowText) reason.append(element("small", "", `影响时窗：${item.impactWindowText}`));
  const tags = element("div", "policy-tags");
  tags.append(element("span", `policy-tag policy-impact ${item.impactTone || "watch"}`, item.impact || "待观察"));
  if (item.foundation) tags.append(element("span", "policy-tag foundation", "永久保留"));
  safeArray(item.plans).forEach((value) => tags.append(element("span", "policy-tag", value)));
  safeArray(item.themes).forEach((value) => tags.append(element("span", "policy-tag", value)));
  safeArray(item.sectors).slice(0, 6).forEach((value) => tags.append(element("span", "policy-tag", value)));
  article.append(meta, title, summary, reason, tags);
  return article;
}

function buildControls(items, render) {
  const section = element("section", "policy-controls");
  const tabs = element("nav", "policy-scope-tabs");
  tabs.setAttribute("aria-label", "消息范围");
  [["all", "全部"], ["domestic", "国内"], ["international", "国际"]].forEach(([value, text]) => {
    const button = element("button", "", text); button.type = "button"; button.dataset.scope = value; button.setAttribute("aria-pressed", String(value === "all")); tabs.append(button);
  });
  const grid = element("div", "policy-filter-grid");
  const search = document.createElement("input"); search.type = "search"; search.placeholder = "搜索标题、主题、板块或来源"; search.setAttribute("aria-label", "搜索政策新闻");
  const plan = document.createElement("select"); plan.setAttribute("aria-label", "按五年规划筛选");
  plan.append(option("all", "全部规划"), option("十五五", "十五五"), option("十四五", "十四五"), option("十三五", "十三五"));
  const themes = document.createElement("select"); themes.setAttribute("aria-label", "按主题筛选");
  themes.append(option("all", "全部主题"));
  [...new Set(items.flatMap((item) => safeArray(item.themes)))].sort((a, b) => a.localeCompare(b, "zh-CN")).forEach((value) => themes.append(option(value, value)));
  const importance = document.createElement("select"); importance.setAttribute("aria-label", "按重要程度筛选");
  importance.append(option("3", "全部级别"), option("4", "重要及以上"), option("5", "仅核心"));
  const order = document.createElement("select"); order.setAttribute("aria-label", "按发布时间排序");
  order.append(option("desc", "时间：最新优先"), option("asc", "时间：最早优先"));
  const count = element("strong", "policy-result-count", "0 条");
  grid.append(search, plan, themes, importance, order, count);
  section.append(tabs, grid);
  const state = {scope: "all", query: "", plan: "all", theme: "all", importance: 3, order: "desc"};
  const update = () => render(state, count);
  tabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-scope]");
    if (!button) return;
    state.scope = button.dataset.scope;
    tabs.querySelectorAll("button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    update();
  });
  search.addEventListener("input", () => { state.query = search.value.trim().toLowerCase(); update(); });
  plan.addEventListener("change", () => { state.plan = plan.value; update(); });
  themes.addEventListener("change", () => { state.theme = themes.value; update(); });
  importance.addEventListener("change", () => { state.importance = Number(importance.value) || 3; update(); });
  order.addEventListener("change", () => { state.order = order.value === "asc" ? "asc" : "desc"; update(); });
  return {section, update};
}

function renderData(view, data) {
  const items = safeArray(data.items);
  const list = element("section", "policy-news-list");
  const controls = buildControls(items, (state, count) => {
    const filtered = items.filter((item) => {
      if (state.scope !== "all" && item.scope !== state.scope) return false;
      if (state.plan !== "all" && !safeArray(item.plans).includes(state.plan)) return false;
      if (state.theme !== "all" && !safeArray(item.themes).includes(state.theme)) return false;
      if (Number(item.importance || 0) < state.importance) return false;
      const haystack = [item.title, item.summary, item.source, item.reason, ...safeArray(item.plans), ...safeArray(item.themes), ...safeArray(item.sectors)].join(" ").toLowerCase();
      return !state.query || haystack.includes(state.query);
    }).sort((a, b) => {
      const timeDifference = Number(a.publishedMs || 0) - Number(b.publishedMs || 0);
      if (timeDifference) return state.order === "asc" ? timeDifference : -timeDifference;
      return Number(b.importance || 0) - Number(a.importance || 0) || Number(b.score || 0) - Number(a.score || 0);
    });
    count.textContent = `${filtered.length} 条`;
    const dailyCounts = new Map();
    filtered.forEach((item) => dailyCounts.set(dateKey(item.publishedAt), (dailyCounts.get(dateKey(item.publishedAt)) || 0) + 1));
    let currentDate = "";
    const rows = [];
    filtered.forEach((item) => {
      const itemDate = dateKey(item.publishedAt);
      if (itemDate !== currentDate) {
        currentDate = itemDate;
        const divider = element("header", "policy-date-divider");
        divider.append(element("h2", "", dateLabel(itemDate)), element("span", "", `${dailyCounts.get(itemDate) || 0} 条`));
        rows.push(divider);
      }
      rows.push(newsRow(item));
    });
    list.replaceChildren(...rows);
    if (!filtered.length) list.append(element("div", "empty-state", "当前筛选条件下没有关键消息。"));
  });
  const source = element("section", "policy-source-note", data.sourceNote || "数据来源与筛选口径暂缺。" );
  if (data.error) source.append(document.createTextNode(` 当前状态：${data.error}`));
  view.content.replaceChildren(overview(data), planBand(data), eventChainBand(data), controls.section, list, source);
  controls.update();
}

async function initialize() {
  const root = document.querySelector("#policyNewsApp");
  const view = buildShell();
  root.replaceChildren(view.wrapper);
  initializeTheme();
  view.content.append(element("div", "loading-state", "正在读取政策新闻…"));
  let currentGeneratedAt = "";
  let polling = false;

  async function load({silent = false} = {}) {
    if (polling) return;
    polling = true;
    try {
      const data = await loadPolicyNewsData();
      if (!silent || data.generatedAt !== currentGeneratedAt) {
        currentGeneratedAt = data.generatedAt || "";
        renderData(view, data);
      }
    } catch (error) {
      if (!silent) view.content.replaceChildren(element("div", "error-state", error.message));
      logTechnicalError(error, "政策新闻页面");
    } finally {
      polling = false;
    }
  }

  view.refresh.addEventListener("click", async () => {
    const old = view.refresh.textContent;
    view.refresh.disabled = true;
    view.refresh.textContent = "同步中";
    view.notice.className = "notice-bar";
    view.notice.hidden = false;
    view.notice.textContent = "正在重新检索并筛选国内外关键政策新闻。";
    try {
      await requestPolicyNewsRefresh();
      await load();
      view.notice.className = "notice-bar success";
      view.notice.textContent = "政策新闻已同步到最新筛选结果。";
    } catch (error) {
      view.notice.className = "notice-bar error";
      view.notice.textContent = error.message;
      logTechnicalError(error, "政策新闻同步");
    } finally {
      view.refresh.disabled = false;
      view.refresh.textContent = old;
    }
  });

  await load();
  setInterval(() => { if (!document.hidden) load({silent: true}); }, 60 * 1000);
}

initialize();
