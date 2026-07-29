import {initializeTheme} from "./theme.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const rootUrl = new URL(globalThis.__A_SHARE_ROOT_URL__ || "../../", import.meta.url);
const params = new URLSearchParams(location.search);
const state = {
  range: 60,
  klines: [],
  target: null,
  context: null,
};

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function svgElement(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value, digits = 2) {
  const number = finite(value);
  return number === null ? "--" : number.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function signed(value, suffix = "%") {
  const number = finite(value);
  if (number === null) return "--";
  return `${number > 0 ? "+" : ""}${formatNumber(number, 2)}${suffix}`;
}

function formatAmount(value) {
  const number = finite(value);
  if (number === null) return "--";
  const yi = Math.abs(number) >= 1000000 ? number / 100000000 : number;
  return `${yi > 0 ? "+" : ""}${formatNumber(yi, 2)}亿`;
}

async function fetchJson(name) {
  try {
    const response = await fetch(new URL(`data/${name}`, rootUrl), {cache: "no-store"});
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  }
}

function sectorRows(sectors) {
  return [
    ...(sectors?.industry?.rows || []),
    ...(sectors?.concept?.rows || []),
  ];
}

function findBoard(sectors, target) {
  const code = String(target.boardCode || target.code || "").toUpperCase();
  const name = String(target.name || "").trim();
  return sectorRows(sectors).find((row) => {
    const rowCode = String(row.code || "").toUpperCase();
    const tdxCode = String(row.tdxCode || "").toUpperCase();
    return (code && [rowCode, tdxCode].includes(code)) || (name && row.name === name);
  }) || null;
}

function stockRows(stocks) {
  return Object.values(stocks?.groups || {}).flatMap((group) => group?.rows || []);
}

function findStock(stocks, code) {
  return stockRows(stocks).find((row) => String(row.code || "") === code) || null;
}

async function loadContext(target) {
  const [sectors, stocks, quant, directory] = await Promise.all([
    fetchJson("sectors.json"),
    fetchJson("stocks.json"),
    fetchJson("quant.json"),
    fetchJson("mobile-stock-directory.json"),
  ]);
  const board = target.isSector ? findBoard(sectors, target) : null;
  const stock = target.isSector ? null : findStock(stocks, target.code);
  const quantRow = target.isSector
    ? null
    : (quant?.formal || []).find((row) => String(row.code || "") === target.code) || null;
  const directoryRow = target.isSector
    ? null
    : (directory?.items || []).find((row) => String(row.code || "") === target.code) || null;
  return {sectors, stocks, quant, board, stock, quantRow, directoryRow};
}

function queryTarget() {
  const code = String(params.get("code") || "").trim().toUpperCase();
  const boardCode = String(params.get("boardCode") || "").trim().toUpperCase();
  const market = String(params.get("market") || "").trim().toLowerCase();
  const name = String(params.get("name") || "").trim();
  const action = String(params.get("action") || "日K").trim();
  const isSector = market === "sector"
    || /^BK\d{4}$/.test(boardCode)
    || /^BK\d{4}$/.test(code)
    || /^880\d{3}$/.test(code);
  return {code, boardCode, market, name, action, isSector};
}

function resolveTarget(target, context) {
  if (target.isSector) {
    const exactBoardCode = /^BK\d{4}$/.test(target.boardCode)
      ? target.boardCode
      : (/^BK\d{4}$/.test(target.code) ? target.code : context.board?.code || "");
    return {
      ...target,
      boardCode: exactBoardCode,
      code: target.code || exactBoardCode,
      name: target.name || context.board?.name || exactBoardCode || "板块",
      market: "sector",
    };
  }
  return {
    ...target,
    name: target.name || context.stock?.name || context.quantRow?.name || context.directoryRow?.name || target.code || "股票",
  };
}

function metric(label, value, hint = "", tone = "") {
  const item = element("div", `market-metric${tone ? ` ${tone}` : ""}`);
  item.append(element("span", "", label), element("strong", "", value));
  if (hint) item.append(element("small", "", hint));
  return item;
}

function renderMetrics(target, context, quote, lastKline) {
  const container = document.querySelector("#marketDetailMetrics");
  const snapshot = target.isSector ? context.board : context.stock;
  const price = finite(quote?.price) ?? finite(lastKline?.close) ?? finite(snapshot?.price) ?? finite(context.quantRow?.close);
  const changePct = finite(quote?.changePct) ?? finite(lastKline?.changePct) ?? finite(snapshot?.changePct) ?? finite(context.quantRow?.changePct);
  const changeTone = changePct === null ? "" : (changePct >= 0 ? "gain" : "loss");
  const amount = finite(quote?.amount) ?? (finite(snapshot?.amountYi) === null ? null : snapshot.amountYi);
  const flow = finite(context.board?.amount);
  const turnover = finite(quote?.turnoverRate) ?? finite(lastKline?.turnoverRate) ?? finite(snapshot?.turnoverRate);
  container.replaceChildren(
    metric(target.isSector ? "板块点位" : "最新价", formatNumber(price, 2), target.code || target.boardCode, changeTone),
    metric("涨跌幅", signed(changePct), lastKline?.date || quote?.date || "", changeTone),
    metric(target.isSector ? "主力净额" : "成交额", target.isSector ? formatAmount(flow) : formatAmount(amount), target.isSector ? "发行包已验证资金快照" : "公开行情或发行包快照"),
    metric("换手率", turnover === null ? "--" : `${formatNumber(turnover, 2)}%`, target.isSector ? "板块暂不提供时显示 --" : ""),
    metric("最高", formatNumber(quote?.high ?? lastKline?.high, 2)),
    metric("最低", formatNumber(quote?.low ?? lastKline?.low, 2)),
  );
}

function movingAverage(items, period) {
  return items.map((_, index) => {
    if (index + 1 < period) return null;
    const window = items.slice(index + 1 - period, index + 1);
    return window.reduce((sum, item) => sum + item.close, 0) / period;
  });
}

function renderCandles() {
  const chart = document.querySelector("#marketCandleChart");
  const empty = document.querySelector("#marketChartEmpty");
  const rows = state.klines.slice(-state.range);
  chart.replaceChildren();
  if (rows.length < 2) {
    empty.hidden = false;
    empty.textContent = "没有足够的真实日K样本。页面保留行情指标，不生成模拟K线。";
    return;
  }
  empty.hidden = true;
  const width = 920;
  const height = 430;
  const margin = {top: 22, right: 18, bottom: 34, left: 58};
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const minimum = Math.min(...rows.map((row) => row.low));
  const maximum = Math.max(...rows.map((row) => row.high));
  const span = Math.max(maximum - minimum, Math.abs(maximum) * 0.01, 0.01);
  const lower = minimum - span * 0.08;
  const upper = maximum + span * 0.08;
  const xStep = plotWidth / rows.length;
  const candleWidth = Math.max(2, Math.min(9, xStep * 0.58));
  const x = (index) => margin.left + xStep * (index + 0.5);
  const y = (value) => margin.top + ((upper - value) / (upper - lower)) * plotHeight;
  const svg = svgElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `${state.target.name}最近${rows.length}个交易日日K`,
    preserveAspectRatio: "none",
  });

  for (let index = 0; index <= 4; index += 1) {
    const value = upper - ((upper - lower) * index) / 4;
    const lineY = margin.top + (plotHeight * index) / 4;
    svg.append(
      svgElement("line", {x1: margin.left, y1: lineY, x2: width - margin.right, y2: lineY, class: "chart-grid-line"}),
    );
    const label = svgElement("text", {x: margin.left - 8, y: lineY + 4, class: "chart-axis-label", "text-anchor": "end"});
    label.textContent = formatNumber(value, 2);
    svg.append(label);
  }

  rows.forEach((row, index) => {
    const center = x(index);
    const up = row.close >= row.open;
    const top = y(Math.max(row.open, row.close));
    const bottom = y(Math.min(row.open, row.close));
    svg.append(
      svgElement("line", {
        x1: center,
        y1: y(row.high),
        x2: center,
        y2: y(row.low),
        class: up ? "candle-stem candle-up" : "candle-stem candle-down",
      }),
      svgElement("rect", {
        x: center - candleWidth / 2,
        y: top,
        width: candleWidth,
        height: Math.max(1.5, bottom - top),
        class: up ? "candle-body candle-up" : "candle-body candle-down",
      }),
    );
  });

  const averages = [
    {values: movingAverage(rows, 5), className: "ma-line ma-five"},
    {values: movingAverage(rows, 10), className: "ma-line ma-ten"},
  ];
  averages.forEach((average) => {
    const points = average.values
      .map((value, index) => value === null ? null : `${x(index)},${y(value)}`)
      .filter(Boolean);
    if (points.length > 1) svg.append(svgElement("polyline", {points: points.join(" "), class: average.className}));
  });

  [0, Math.floor((rows.length - 1) / 2), rows.length - 1].forEach((index) => {
    const label = svgElement("text", {
      x: x(index),
      y: height - 10,
      class: "chart-axis-label",
      "text-anchor": index === 0 ? "start" : (index === rows.length - 1 ? "end" : "middle"),
    });
    label.textContent = rows[index].date.slice(5);
    svg.append(label);
  });
  chart.append(svg);
  document.querySelector("#marketChartCaption").textContent =
    `显示最近 ${rows.length} 个真实交易日 · 前复权 · ${state.context.klineSource || "公开行情接口"}`;
}

function addTagList(container, title, values) {
  const rows = Array.isArray(values) ? values.filter(Boolean) : [values].filter(Boolean);
  if (!rows.length) return;
  const block = element("div", "market-context-block");
  block.append(element("strong", "", title));
  const tags = element("div", "market-tag-list");
  rows.forEach((value) => tags.append(element("span", "", String(value))));
  block.append(tags);
  container.append(block);
}

function addParagraph(container, title, value) {
  const text = String(value || "").trim();
  if (!text) return;
  const block = element("div", "market-context-block");
  block.append(element("strong", "", title), element("p", "", text));
  container.append(block);
}

function renderContext(target, context) {
  const container = document.querySelector("#marketDetailContext");
  container.replaceChildren();
  if (target.isSector) {
    addTagList(container, "类型", [context.board ? "二级行业或题材概念" : "板块"]);
    addParagraph(container, "板块代码", target.boardCode || target.code || "暂无可核验代码");
    addParagraph(container, "资金快照", finite(context.board?.amount) === null
      ? "发行包未找到该板块的已验证资金快照。"
      : `${context.board.amount > 0 ? "净流入" : "净流出"} ${formatNumber(Math.abs(context.board.amount), 2)} 亿元`);
  } else {
    addTagList(container, "所属行业", context.stock?.sector || context.quantRow?.sector);
    addTagList(container, "相关概念", context.stock?.concepts || context.quantRow?.concepts);
    addTagList(container, "量化战法", context.quantRow?.signals);
    addTagList(container, "技术要点", context.quantRow?.reasons);
    addTagList(container, "风险项", context.quantRow?.risks);
    addParagraph(container, "近期涨跌原因", context.quantRow?.moveReason);
  }
  if (!container.childElementCount) {
    addParagraph(container, "说明", "发行包中没有该目标的更多已验证关联信息，软件不会生成未经验证的归因。");
  }
}

function renderSources(target, errors, sources) {
  const container = document.querySelector("#marketDetailSources");
  container.replaceChildren();
  const list = element("ul", "market-source-list");
  [...new Set(sources.filter(Boolean))].forEach((source) => list.append(element("li", "", source)));
  list.append(element("li", "", "所有图表均在软件内绘制，不打开东财或其他外部行情网页。"));
  list.append(element("li", "", "公开接口不完整时保留发行包快照，并明确显示缺失状态，不生成模拟走势。"));
  errors.forEach((error) => list.append(element("li", "market-source-warning", error)));
  container.append(list);
}

async function loadData() {
  const status = document.querySelector("#marketDetailStatus");
  const refresh = document.querySelector("#marketDetailRefresh");
  refresh.disabled = true;
  status.textContent = "正在软件内读取公开行情与发行包数据";
  status.dataset.state = "loading";
  const initialTarget = queryTarget();
  const context = await loadContext(initialTarget);
  const target = resolveTarget(initialTarget, context);
  state.target = target;
  state.context = context;
  document.querySelector("#marketDetailTitle").textContent = `${target.name} ${target.action}`;
  document.querySelector("#marketDetailSubtitle").textContent =
    `${target.isSector ? "板块" : "股票"} ${target.code || target.boardCode || "--"} · 内容在软件内生成`;
  document.title = `${target.name} ${target.action}｜软件内行情`;

  const errors = [];
  const sources = [];
  let quote = null;
  let klineResult = null;
  const live = globalThis.AShareMobileLive;
  if (!live) {
    errors.push("手机公开行情模块未加载，当前仅展示发行包快照。");
  } else {
    const tasks = [
      live.loadDailyK({...target, limit: 160}),
      target.isSector
        ? (target.boardCode
          ? live.loadBoardTrend(target.boardCode, target.name, "")
          : Promise.reject(new Error("板块缺少公开行情代码")))
        : live.loadStockQuote(target.code, target.market),
    ];
    const [klineState, quoteState] = await Promise.allSettled(tasks);
    if (klineState.status === "fulfilled") {
      klineResult = klineState.value;
      state.klines = klineResult.items || [];
      context.klineSource = klineResult.source;
      sources.push(klineResult.source);
    } else {
      state.klines = [];
      errors.push(`日K：${klineState.reason?.message || "公开接口读取失败"}`);
    }
    if (quoteState.status === "fulfilled") {
      const value = quoteState.value;
      if (target.isSector) {
        const points = value.points || [];
        const last = points[points.length - 1];
        quote = last ? {
          price: last.price,
          changePct: last.changePct,
          date: value.tradeDate,
        } : null;
      } else {
        quote = value;
      }
      sources.push(value.source);
    } else {
      errors.push(`实时行情：${quoteState.reason?.message || "公开接口读取失败"}`);
    }
  }

  const lastKline = state.klines[state.klines.length - 1] || null;
  renderMetrics(target, context, quote, lastKline);
  renderCandles();
  renderContext(target, context);
  renderSources(target, errors, sources);
  if (state.klines.length >= 2) {
    status.textContent = `已在软件内生成 · ${state.klines.length} 个真实日K样本`;
    status.dataset.state = "ready";
  } else {
    status.textContent = "日K公开接口暂不可用，已保留可核验行情与发行包快照";
    status.dataset.state = "warning";
  }
  refresh.disabled = false;
}

document.querySelector("#marketDetailBack").addEventListener("click", () => {
  if (history.length > 1) history.back();
  else location.href = new URL("index.html", rootUrl).href;
});

document.querySelector("#marketDetailRefresh").addEventListener("click", () => {
  loadData().catch((error) => {
    const status = document.querySelector("#marketDetailStatus");
    status.textContent = `刷新失败：${error.message}`;
    status.dataset.state = "error";
    document.querySelector("#marketDetailRefresh").disabled = false;
  });
});

document.querySelector("#marketRangeControl").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-range]");
  if (!button) return;
  state.range = Number(button.dataset.range) || 60;
  document.querySelectorAll("#marketRangeControl button").forEach((item) => {
    item.setAttribute("aria-pressed", String(item === button));
  });
  renderCandles();
});

initializeTheme();
loadData().catch((error) => {
  const status = document.querySelector("#marketDetailStatus");
  status.textContent = `详情生成失败：${error.message}`;
  status.dataset.state = "error";
  document.querySelector("#marketDetailRefresh").disabled = false;
});
