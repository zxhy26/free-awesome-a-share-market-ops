import {fetchJson, logTechnicalError, openTdxStock} from "./api.js";
import {initializeTheme} from "./theme.js";

const numberFormatter = new Intl.NumberFormat("zh-CN", {maximumFractionDigits: 2});
let resizeObserver = null;

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = String(text);
  return node;
}

function formatNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return number.toFixed(digits).replace(/\.?0+$/, "");
}

function signed(value, suffix = "") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${number > 0 ? "+" : ""}${number.toFixed(2)}${suffix}`;
}

function toneClass(tone) {
  return ["positive", "negative", "watch", "mixed", "neutral"].includes(tone) ? `tone-${tone}` : "tone-neutral";
}

function buildThemeControl() {
  const fieldset = element("fieldset", "theme-segment");
  fieldset.setAttribute("aria-label", "主题模式");
  [["system", "跟随"], ["light", "浅色"], ["dark", "深色"]].forEach(([value, label]) => {
    const button = element("button", "", label);
    button.type = "button";
    button.dataset.themeChoice = value;
    fieldset.append(button);
  });
  return fieldset;
}

function buildShell() {
  const shell = element("div", "detail-shell stock-search-shell");
  const header = element("header", "detail-header");
  const heading = document.createElement("div");
  heading.append(
    element("h1", "", "个股搜索"),
    element("p", "", "输入股票代码或名称，分别查看技术面、基本面与可核验消息面。"),
  );
  const actions = element("nav", "detail-actions");
  const back = element("a", "button", "返回首页");
  back.href = "/app/";
  actions.append(back, buildThemeControl());
  header.append(heading, actions);

  const searchPanel = element("section", "stock-search-panel");
  const form = element("form", "stock-search-form");
  form.setAttribute("role", "search");
  const inputWrap = element("div", "stock-search-input-wrap");
  const label = element("label", "visually-hidden", "股票代码或名称");
  label.htmlFor = "stockSearchInput";
  const input = document.createElement("input");
  input.id = "stockSearchInput";
  input.type = "search";
  input.autocomplete = "off";
  input.placeholder = "例如：300750 或 宁德时代";
  input.setAttribute("aria-label", "输入股票代码或名称");
  input.setAttribute("aria-controls", "stockSearchSuggestions");
  input.setAttribute("aria-expanded", "false");
  const clear = element("button", "stock-search-clear", "×");
  clear.type = "button";
  clear.title = "清空搜索";
  clear.setAttribute("aria-label", "清空搜索");
  clear.hidden = true;
  inputWrap.append(label, input, clear);
  const submit = element("button", "button button-primary", "搜索");
  submit.type = "submit";
  const suggestions = element("div", "stock-search-suggestions");
  suggestions.id = "stockSearchSuggestions";
  suggestions.setAttribute("role", "listbox");
  suggestions.hidden = true;
  const hint = element("p", "stock-search-hint", "支持沪深北 A 股代码、中文名称和名称片段。");
  form.append(inputWrap, submit);
  searchPanel.append(form, suggestions, hint);

  const notice = element("div", "notice-bar stock-search-notice");
  notice.hidden = true;
  const content = element("section", "stock-analysis-content");
  const empty = element("div", "stock-search-empty");
  empty.append(
    element("strong", "", "搜索一只股票开始复盘"),
    element("p", "", "技术面按前复权行情计算；基本面使用公开财务报告；消息面只显示公告、直接相关新闻和匹配的政策行业事件。"),
  );
  content.append(empty);
  const footer = element("footer", "app-footer");
  footer.append(
    element("p", "", "数据来自公开行情、F10财务报告、上市公司公告、公开新闻检索和应用内政策新闻库。"),
    element("p", "", "本页面仅用于信息整理和复盘分析，不构成任何投资建议。市场有风险，决策需独立判断。"),
  );
  shell.append(header, searchPanel, notice, content, footer);
  return {shell, form, input, clear, submit, suggestions, hint, notice, content};
}

async function searchStocks(query) {
  return fetchJson(`/api/v1/stocks/search?q=${encodeURIComponent(query)}`, {
    label: "个股搜索",
    timeoutMs: 15000,
  });
}

async function loadStockAnalysis(stock) {
  const params = new URLSearchParams({
    code: stock.code,
    name: stock.name || "",
    market: String(stock.market ?? ""),
  });
  return fetchJson(`/api/v1/stocks/analyze?${params}`, {
    label: "个股分析",
    timeoutMs: 30000,
  });
}

function showNotice(view, text, className = "") {
  view.notice.hidden = !text;
  view.notice.className = `notice-bar stock-search-notice ${className}`.trim();
  view.notice.textContent = text || "";
}

function suggestionButton(stock) {
  const button = element("button", "stock-suggestion");
  button.type = "button";
  button.setAttribute("role", "option");
  button.dataset.code = stock.code;
  button.dataset.name = stock.name || "";
  button.dataset.market = String(stock.market ?? "");
  const identity = element("span", "stock-suggestion-identity");
  identity.append(element("strong", "", stock.name || stock.code), element("small", "", stock.code));
  button.append(identity, element("span", "stock-suggestion-market", stock.marketLabel || ""));
  return button;
}

function renderSuggestions(view, data) {
  const rows = Array.isArray(data?.items) ? data.items : [];
  view.suggestions.replaceChildren();
  if (!rows.length) {
    view.suggestions.append(element("div", "stock-suggestion-empty", "没有找到匹配的 A 股，请核对代码或完整名称。"));
  } else {
    rows.forEach((stock) => view.suggestions.append(suggestionButton(stock)));
  }
  view.suggestions.hidden = false;
  view.input.setAttribute("aria-expanded", "true");
  view.hint.textContent = data?.index?.ready
    ? `已检索本机全 A 名称索引，共 ${numberFormatter.format(data.index.count || 0)} 只。`
    : "已使用实时证券联想；本机全 A 名称索引正在后台补齐。";
}

function metricCard(metric) {
  const card = element("div", `stock-metric ${toneClass(metric.tone)}`);
  const value = element("strong", "");
  value.textContent = metric.value === null || metric.value === undefined
    ? "--"
    : `${formatNumber(metric.value, Math.abs(Number(metric.value)) < 1 ? 3 : 2)}${metric.suffix || ""}`;
  card.append(element("span", "", metric.label), value, element("small", "", metric.detail || ""));
  return card;
}

function judgementBlock(title, judgement, fallbackText) {
  const data = judgement || {};
  const section = element("section", `analysis-judgement ${toneClass(data.tone)}`);
  const heading = element("div", "analysis-judgement-heading");
  heading.append(
    element("h3", "", title),
    element("strong", `analysis-judgement-label ${toneClass(data.tone)}`, data.label || "待判断"),
  );
  section.append(heading, element("p", "", data.text || fallbackText || "当前数据不足，暂时无法形成综合判断。"));
  const evidenceRows = Array.isArray(data.evidence) ? data.evidence.filter(Boolean) : [];
  if (evidenceRows.length) {
    const list = element("ul", "analysis-judgement-evidence");
    evidenceRows.forEach((item) => list.append(element("li", "", item)));
    section.append(list);
  }
  return section;
}

function drawTechnicalChart(canvas, points) {
  const rows = Array.isArray(points) ? points.filter((point) => Number.isFinite(Number(point.close))) : [];
  if (!rows.length) return;
  const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(300, Math.floor(rect.width));
  const height = Math.max(190, Math.floor(rect.height));
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const styles = getComputedStyle(document.documentElement);
  const colors = {
    border: styles.getPropertyValue("--border").trim(),
    muted: styles.getPropertyValue("--muted").trim(),
    text: styles.getPropertyValue("--text").trim(),
    close: styles.getPropertyValue("--accent").trim(),
    ma5: styles.getPropertyValue("--gain").trim(),
    ma20: styles.getPropertyValue("--warning").trim(),
  };
  const padding = {left: 46, right: 12, top: 16, bottom: 26};
  const values = rows.flatMap((row) => [row.close, row.ma5, row.ma20]).map(Number).filter(Number.isFinite);
  let minimum = Math.min(...values);
  let maximum = Math.max(...values);
  const span = Math.max(0.01, maximum - minimum);
  minimum -= span * 0.08;
  maximum += span * 0.08;
  const x = (index) => padding.left + index / Math.max(1, rows.length - 1) * (width - padding.left - padding.right);
  const y = (value) => padding.top + (maximum - value) / (maximum - minimum) * (height - padding.top - padding.bottom);
  context.font = "10px Microsoft YaHei UI";
  context.lineWidth = 1;
  for (let line = 0; line <= 4; line += 1) {
    const value = maximum - (maximum - minimum) * line / 4;
    const top = padding.top + (height - padding.top - padding.bottom) * line / 4;
    context.strokeStyle = colors.border;
    context.beginPath();
    context.moveTo(padding.left, top);
    context.lineTo(width - padding.right, top);
    context.stroke();
    context.fillStyle = colors.muted;
    context.fillText(value.toFixed(2), 4, top + 3);
  }
  [["close", colors.close, 2], ["ma5", colors.ma5, 1.4], ["ma20", colors.ma20, 1.4]].forEach(([key, color, lineWidth]) => {
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.beginPath();
    let started = false;
    rows.forEach((row, index) => {
      const value = Number(row[key]);
      if (!Number.isFinite(value)) return;
      if (!started) {
        context.moveTo(x(index), y(value));
        started = true;
      } else {
        context.lineTo(x(index), y(value));
      }
    });
    context.stroke();
  });
  context.fillStyle = colors.muted;
  context.textAlign = "left";
  context.fillText(rows[0].date.slice(5), padding.left, height - 7);
  context.textAlign = "center";
  context.fillText(rows[Math.floor(rows.length / 2)].date.slice(5), x(Math.floor(rows.length / 2)), height - 7);
  context.textAlign = "right";
  context.fillText(rows.at(-1).date.slice(5), width - padding.right, height - 7);
}

function technicalPanel(data) {
  const technical = data.technical || {};
  const panel = element("section", "analysis-panel technical-panel");
  const header = element("header", "analysis-panel-heading");
  const heading = document.createElement("div");
  heading.append(element("h2", "", "技术面解析"), element("p", "", technical.dataDate ? `日线截至 ${technical.dataDate}` : "日线数据状态"));
  const badge = element("span", `analysis-badge ${toneClass(technical.tone)}`, technical.stance || "暂无");
  header.append(heading, badge);
  panel.append(header);
  if (technical.status !== "ok") {
    panel.append(element("div", "error-state compact-state", technical.message || "技术面暂时无法读取。"));
    return panel;
  }
  panel.append(
    judgementBlock("技术面综合判断", technical.judgement, technical.summary),
    element("p", "analysis-lead", technical.summary),
  );
  const metrics = element("div", "stock-metric-grid");
  (technical.metrics || []).forEach((metric) => metrics.append(metricCard(metric)));
  panel.append(metrics);

  const cycleSection = element("section", "cycle-analysis");
  const cycleHeader = element("div", "compact-section-heading");
  cycleHeader.append(
    element("h3", "", "多周期方向"),
    element("span", "", "大周期定方向，小周期只做确认"),
  );
  const cycleGrid = element("div", "cycle-analysis-grid");
  (technical.cycleAnalysis || []).forEach((cycle) => {
    const block = element("article", `cycle-analysis-item ${toneClass(cycle.tone)}`);
    const headingRow = element("div", "cycle-analysis-item-heading");
    headingRow.append(
      element("h4", "", cycle.title),
      element("span", `cycle-analysis-label ${toneClass(cycle.tone)}`, cycle.label || "待判断"),
    );
    block.append(headingRow, element("p", "", cycle.text || "当前周期数据不足。"));
    cycleGrid.append(block);
  });
  cycleSection.append(cycleHeader, cycleGrid);
  panel.append(cycleSection);

  const chartBox = element("section", "technical-chart-box");
  const chartHeader = element("div", "technical-chart-header");
  chartHeader.append(
    element("strong", "", "近90日收盘与均线"),
    (() => {
      const legend = element("span", "technical-chart-legend");
      legend.innerHTML = "<i class=\"close\"></i>收盘 <i class=\"ma5\"></i>MA5 <i class=\"ma20\"></i>MA20";
      return legend;
    })(),
  );
  const canvas = document.createElement("canvas");
  canvas.className = "technical-chart";
  canvas.setAttribute("aria-label", "近90日收盘、MA5和MA20走势图");
  chartBox.append(chartHeader, canvas);
  panel.append(chartBox);
  requestAnimationFrame(() => drawTechnicalChart(canvas, technical.chart));
  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => drawTechnicalChart(canvas, technical.chart));
  resizeObserver.observe(canvas);

  const sections = element("div", "technical-sections");
  (technical.sections || []).forEach((section) => {
    const block = element("article", `technical-section ${toneClass(section.tone)}`);
    block.append(element("h3", "", section.title), element("p", "", section.text));
    sections.append(block);
  });
  const risks = element("section", "risk-list");
  risks.append(element("h3", "", "风险观察"));
  const list = document.createElement("ul");
  (technical.risks || []).forEach((item) => list.append(element("li", "", item)));
  risks.append(list);

  const tradePlan = technical.tradePlan || {};
  const levelSection = element("section", "technical-levels");
  const levelHeader = element("div", "compact-section-heading");
  levelHeader.append(
    element("h3", "", tradePlan.title || "关键位置与风险收益"),
    element("span", "", "只显示实际结构位置"),
  );
  const levelGrid = element("div", "technical-level-grid");
  (tradePlan.items || []).forEach((item) => {
    const block = element("article", "technical-level-item");
    block.append(
      element("span", "", item.label),
      element("strong", "", item.value || "--"),
      element("small", "", item.detail || ""),
    );
    levelGrid.append(block);
  });
  levelSection.append(levelHeader, levelGrid, element("p", "technical-method-note", tradePlan.note || ""));

  const coverageSection = element("section", "data-coverage");
  const coverageHeader = element("div", "compact-section-heading");
  coverageHeader.append(
    element("h3", "", "数据完整性"),
    element("span", "", "缺失项不参与判断"),
  );
  const coverageList = element("div", "data-coverage-list");
  (technical.dataCoverage || []).forEach((item) => {
    const row = element("div", "data-coverage-row");
    row.append(
      element("strong", "", item.label),
      element("span", `data-coverage-status ${toneClass(item.tone)}`, item.status || "待确认"),
      element("p", "", item.detail || ""),
    );
    coverageList.append(row);
  });
  coverageSection.append(coverageHeader, coverageList, element("p", "technical-method-note", technical.methodology || ""));

  panel.append(
    sections,
    levelSection,
    coverageSection,
    risks,
    judgementBlock("技术面总结", technical.finalSummary, technical.summary),
  );
  return panel;
}

function fundamentalPanel(data) {
  const fundamental = data.fundamental || {};
  const latest = fundamental.latestReport || {};
  const panel = element("section", "analysis-panel fundamental-panel");
  const header = element("header", "analysis-panel-heading");
  const heading = document.createElement("div");
  heading.append(
    element("h2", "", "基本面分析"),
    element("p", "", latest.reportName ? `最新报告 ${latest.reportName} · 公告日 ${latest.noticeDate || "--"}` : "公开财务报告状态"),
  );
  header.append(
    heading,
    element("span", `analysis-badge ${toneClass(fundamental.tone)}`, fundamental.label || "数据有限"),
  );
  panel.append(header);
  if (fundamental.status !== "ok") {
    panel.append(element("div", "error-state compact-state", fundamental.message || "基本面暂时无法读取。"));
    return panel;
  }
  panel.append(judgementBlock("基本面综合判断", fundamental.judgement, fundamental.summary));

  const metrics = element("div", "stock-metric-grid fundamental-metric-grid");
  (fundamental.metrics || []).forEach((metric) => metrics.append(metricCard(metric)));
  panel.append(metrics);

  const sections = element("div", "fundamental-sections");
  (fundamental.sections || []).forEach((section) => {
    const block = element("article", `fundamental-section ${toneClass(section.tone)}`);
    block.append(element("h3", "", section.title), element("p", "", section.text));
    sections.append(block);
  });
  panel.append(sections);

  const history = Array.isArray(fundamental.history) ? fundamental.history : [];
  if (history.length) {
    const trend = element("section", "fundamental-trend");
    const trendHeader = element("div", "compact-section-heading");
    trendHeader.append(element("h3", "", "近五期财务趋势"), element("span", "", "按公开报告期排列"));
    const tableWrap = element("div", "fundamental-table-wrap");
    const table = document.createElement("table");
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["报告期", "营收同比", "净利同比", "ROE", "现金含量"].forEach((label) => headRow.append(element("th", "", label)));
    head.append(headRow);
    const body = document.createElement("tbody");
    history.forEach((row) => {
      const tr = document.createElement("tr");
      [
        row.reportName || row.reportDate || "--",
        row.revenueYoY === null || row.revenueYoY === undefined ? "--" : signed(row.revenueYoY, "%"),
        row.netProfitYoY === null || row.netProfitYoY === undefined ? "--" : signed(row.netProfitYoY, "%"),
        row.roe === null || row.roe === undefined ? "--" : `${formatNumber(row.roe)}%`,
        row.cashToProfit === null || row.cashToProfit === undefined ? "--" : `${formatNumber(row.cashToProfit)}倍`,
      ].forEach((value) => tr.append(element("td", "", value)));
      body.append(tr);
    });
    table.append(head, body);
    tableWrap.append(table);
    trend.append(trendHeader, tableWrap);
    panel.append(trend);
  }
  panel.append(element("p", "fundamental-method", fundamental.methodology || ""));
  return panel;
}

function newsItem(item, type) {
  const article = element("article", `news-item ${toneClass(item.tone)}`);
  const meta = element("div", "news-item-meta");
  meta.append(
    element("span", "", item.date ? String(item.date).slice(0, 16) : "时间未标注"),
    element("span", "", item.source || type),
    item.category ? element("span", "news-category", item.category) : document.createTextNode(""),
  );
  const title = item.url ? element("a", "", item.title || "未命名事件") : element("strong", "", item.title || "未命名事件");
  if (item.url) {
    title.href = item.url;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
  }
  article.append(meta, title);
  if (item.summary) article.append(element("p", "", item.summary));
  if (item.reason) article.append(element("p", "news-reason", item.reason));
  if (Array.isArray(item.matchedTerms) && item.matchedTerms.length) article.append(element("small", "", `关联：${item.matchedTerms.join("、")}`));
  return article;
}

function newsGroup(title, subtitle, rows, emptyText, type) {
  const section = element("section", "news-group");
  const header = element("header", "news-group-heading");
  const copy = document.createElement("div");
  copy.append(element("h3", "", title), element("p", "", subtitle));
  header.append(copy, element("span", "", `${rows.length}条`));
  const list = element("div", "news-list");
  if (rows.length) rows.forEach((item) => list.append(newsItem(item, type)));
  else list.append(element("div", "empty-state compact-state", emptyText));
  section.append(header, list);
  return section;
}

function newsPanel(data) {
  const news = data.news || {};
  const judgement = news.judgement || {};
  const panel = element("section", "analysis-panel news-panel");
  const header = element("header", "analysis-panel-heading");
  const heading = document.createElement("div");
  heading.append(element("h2", "", "消息面解析"), element("p", "", `公开信息截至 ${data.fetchedAt || "--"}`));
  header.append(
    heading,
    element(
      "span",
      `analysis-badge ${toneClass(judgement.tone || (news.status === "ok" ? "neutral" : "watch"))}`,
      judgement.label || (news.status === "ok" ? "已核验" : "数据有限"),
    ),
  );
  panel.append(
    header,
    judgementBlock("消息面综合判断", judgement, news.summary),
    element("p", "analysis-lead", news.summary || "暂无可核验消息。"),
  );
  const groups = element("div", "news-groups");
  groups.append(
    newsGroup("公司公告", "上市公司公开披露，优先级最高", news.announcements || [], "近期没有读取到公司公告。", "公司公告"),
    newsGroup("直接相关新闻", "仅保留标题或摘要直接出现公司名称、代码的条目", news.items || [], "近期没有读取到直接相关新闻，不使用传闻补足。", "公开新闻"),
    newsGroup("政策与行业关联", "从应用内政策新闻库按公司行业与主营关键词匹配", news.policyEvents || [], "当前政策新闻库没有匹配到高相关事件。", "政策新闻"),
  );
  const method = element("p", "news-method", news.methodology || "");
  panel.append(groups, method);
  return panel;
}

function identityHeader(data) {
  const section = element("section", "stock-identity");
  const main = document.createElement("div");
  const title = element("div", "stock-identity-title");
  title.append(element("h2", "", data.name || data.code), element("span", "", data.code));
  const tags = element("div", "stock-tags");
  [data.marketLabel, data.profile?.industry, data.profile?.region].filter(Boolean).forEach((tag) => tags.append(element("span", "", tag)));
  main.append(title, tags);
  if (data.profile?.intro) main.append(element("p", "stock-intro", data.profile.intro));
  const quote = element("div", "stock-quote");
  const price = data.quote?.price;
  const changePct = data.quote?.changePct;
  quote.append(
    element("span", "", data.quote?.date ? `行情 ${data.quote.date}` : "行情暂缺"),
    element("strong", Number(changePct) >= 0 ? "gain" : "loss", price === null || price === undefined ? "--" : formatNumber(price)),
    element("b", Number(changePct) >= 0 ? "gain" : "loss", signed(changePct, "%")),
  );
  const kButton = element("button", "button", "打开日K");
  kButton.type = "button";
  kButton.dataset.stockOpen = "true";
  kButton.dataset.stockCode = data.code || "";
  kButton.dataset.stockMarket = String(data.market ?? "");
  kButton.dataset.stockName = data.name || "";
  quote.append(kButton);
  section.append(main, quote);
  return section;
}

function renderAnalysis(view, data) {
  const fragment = document.createDocumentFragment();
  fragment.append(identityHeader(data));
  if (data.sourceStatus?.partial && data.sourceStatus.errors?.length) {
    const partial = element("div", "data-partial-note");
    partial.append(element("strong", "", "部分数据源暂不可用"), element("span", "", data.sourceStatus.errors.join("；")));
    fragment.append(partial);
  }
  fragment.append(fundamentalPanel(data));
  const grid = element("div", "stock-analysis-grid");
  grid.append(technicalPanel(data), newsPanel(data));
  fragment.append(grid);
  view.content.replaceChildren(fragment);
}

async function analyzeSelection(view, stock) {
  view.suggestions.hidden = true;
  view.input.setAttribute("aria-expanded", "false");
  view.input.value = `${stock.name || ""} ${stock.code}`.trim();
  view.clear.hidden = false;
  view.submit.disabled = true;
  showNotice(view, `正在读取 ${stock.name || stock.code} 的行情、财务报告、公告和直接相关新闻…`);
  view.content.replaceChildren(element("div", "loading-state", "正在生成个股技术面、基本面与消息面解析…"));
  try {
    const data = await loadStockAnalysis(stock);
    renderAnalysis(view, data);
    showNotice(view, data.sourceStatus?.partial ? "分析已完成，部分数据源暂时不可用，页面已明确标注。" : "分析已完成。", data.sourceStatus?.partial ? "" : "success");
    history.replaceState(null, "", `?code=${encodeURIComponent(data.code)}&name=${encodeURIComponent(data.name || "")}`);
  } catch (error) {
    view.content.replaceChildren(element("div", "error-state", error.message));
    showNotice(view, error.message, "error");
    logTechnicalError(error, "个股分析页面");
  } finally {
    view.submit.disabled = false;
  }
}

async function performSearch(view) {
  const query = view.input.value.trim();
  if (!query) {
    view.input.focus();
    showNotice(view, "请输入股票代码或名称。", "error");
    return;
  }
  view.submit.disabled = true;
  view.submit.textContent = "检索中";
  showNotice(view, "");
  try {
    const data = await searchStocks(query);
    renderSuggestions(view, data);
    const exact = (data.items || []).find((item) => item.code === query || item.name === query);
    if (exact || data.items?.length === 1) await analyzeSelection(view, exact || data.items[0]);
  } catch (error) {
    showNotice(view, error.message, "error");
    view.suggestions.hidden = true;
    logTechnicalError(error, "个股搜索");
  } finally {
    view.submit.disabled = false;
    view.submit.textContent = "搜索";
  }
}

function bind(view) {
  view.form.addEventListener("submit", (event) => {
    event.preventDefault();
    performSearch(view);
  });
  view.input.addEventListener("input", () => {
    view.clear.hidden = !view.input.value;
    if (!view.input.value.trim()) {
      view.suggestions.hidden = true;
      view.input.setAttribute("aria-expanded", "false");
    }
  });
  view.clear.addEventListener("click", () => {
    view.input.value = "";
    view.clear.hidden = true;
    view.suggestions.hidden = true;
    view.input.setAttribute("aria-expanded", "false");
    view.input.focus();
  });
  view.suggestions.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-code]");
    if (!button) return;
    analyzeSelection(view, {
      code: button.dataset.code,
      name: button.dataset.name,
      market: Number(button.dataset.market),
    });
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
      logTechnicalError(error, "个股搜索日K");
    } finally {
      setTimeout(() => {
        button.disabled = false;
        button.textContent = original;
      }, 1600);
    }
  });
  document.addEventListener("click", (event) => {
    if (!view.suggestions.contains(event.target) && event.target !== view.input) {
      view.suggestions.hidden = true;
      view.input.setAttribute("aria-expanded", "false");
    }
  });
}

async function initialize() {
  const root = document.querySelector("#stockSearchApp");
  const view = buildShell();
  root.replaceChildren(view.shell);
  initializeTheme();
  bind(view);
  const params = new URLSearchParams(location.search);
  const code = String(params.get("code") || "").replace(/\D/g, "");
  if (/^\d{6}$/.test(code)) {
    await analyzeSelection(view, {code, name: params.get("name") || "", market: ""});
  } else {
    view.input.focus();
  }
}

initialize();
