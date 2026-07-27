import {interpolateRealSamples, marketMinuteToTime} from "./market-session.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEWBOX_WIDTH = 460;
const VIEWBOX_HEIGHT = 116;
const PLOT = Object.freeze({left: 42, right: 8, top: 8, bottom: 20});
const SERIES_LIMIT = 10;
const SERIES_COLORS = Object.freeze({
  inflow: Object.freeze(["#d62728", "#ff7f0e", "#9467bd", "#1f77b4", "#2ca02c", "#8c564b", "#e13b9b", "#5f6368", "#7a8400", "#0099b5"]),
  outflow: Object.freeze(["#178f5f", "#1f77b4", "#ff7f0e", "#9467bd", "#d62728", "#0099b5", "#8c564b", "#c23b8a", "#6f7f00", "#5f6368"]),
});
const SERIES_DASHES = Object.freeze(["none", "8 2", "2 1.4", "8 2 2 2", "5 1.5", "1.2 1.5", "10 2", "5 1 1 1", "3 2", "12 3"]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function svgElement(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  return node;
}

function validPoints(row) {
  return (Array.isArray(row?.points) ? row.points : [])
    .map((point) => ({minute: finite(point?.minute), amount: finite(point?.amount), source: point?.source || ""}))
    .filter((point) => point.minute !== null && point.amount !== null && point.minute >= 0 && point.minute <= 240)
    .sort((a, b) => a.minute - b.minute);
}

function valueAt(row, minute) {
  return interpolateRealSamples(validPoints(row), minute, "amount");
}

function visibleSeriesPoints(row, minute) {
  const points = validPoints(row);
  const visible = points.filter((point) => point.minute <= minute);
  const previous = visible.at(-1);
  const next = points.find((point) => point.minute > minute);
  if (previous && next && minute > previous.minute && next.minute > previous.minute) {
    const amount = valueAt(row, minute);
    if (amount !== null) visible.push({minute, amount, displayOnly: true});
  }
  return visible;
}

function formatAmount(amount) {
  const value = finite(amount);
  if (value === null) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}亿`;
}

function baseName(row) {
  return String(row?.tdxName || row?.name || "--").trim() || "--";
}

function withDistinctNames(items) {
  const counts = new Map();
  items.forEach(({row}) => counts.set(baseName(row), (counts.get(baseName(row)) || 0) + 1));
  return items.map((item) => {
    const mappedName = baseName(item.row);
    const originalName = String(item.row?.name || "").trim();
    const suffix = originalName && originalName !== mappedName ? originalName : String(item.row?.code || "").trim();
    return {
      ...item,
      displayName: counts.get(mappedName) > 1 && suffix ? `${mappedName}·${suffix}` : mappedName,
    };
  });
}

function styleSeries(node, view, index) {
  node.style.setProperty("--series-color", SERIES_COLORS[view][index % SERIES_COLORS[view].length]);
  node.style.setProperty("--series-dash", SERIES_DASHES[index % SERIES_DASHES.length]);
}

function seriesKey(row) {
  return String(row?.code || row?.tdxCode || row?.name || "").trim();
}

function chooseRows(group, view, minute) {
  return withDistinctNames((group?.rows || [])
    .map((row) => ({row, currentAmount: valueAt(row, minute)}))
    .filter((item) => item.currentAmount !== null && (view === "inflow" ? item.currentAmount > 0 : item.currentAmount < 0))
    .sort((a, b) => Math.abs(b.currentAmount) - Math.abs(a.currentAmount)
      || String(a.row?.name || "").localeCompare(String(b.row?.name || ""), "zh-CN"))
    .slice(0, SERIES_LIMIT));
}

function createBase(container) {
  const header = document.createElement("div");
  header.className = "sector-flow-chart-header";
  const status = document.createElement("strong");
  const source = document.createElement("span");
  const scale = document.createElement("div");
  scale.className = "sector-flow-scale";
  scale.setAttribute("role", "group");
  scale.setAttribute("aria-label", "资金曲线刻度");
  [["absolute", "金额"], ["relative", "相对"]].forEach(([value, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.flowScale = value;
    button.textContent = label;
    button.title = value === "absolute" ? "按统一资金金额刻度比较" : "按各板块自身区间归一化比较走势";
    scale.append(button);
  });
  header.append(status, source, scale);

  const stage = document.createElement("div");
  stage.className = "sector-flow-chart-stage";
  const svg = svgElement("svg", {
    viewBox: `0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`,
    preserveAspectRatio: "none",
    role: "img",
  });
  const title = svgElement("title");
  svg.append(title);
  const tooltip = document.createElement("div");
  tooltip.className = "sector-flow-tooltip";
  tooltip.hidden = true;
  stage.append(svg, tooltip);

  const legend = document.createElement("div");
  legend.className = "sector-flow-legend";
  const empty = document.createElement("div");
  empty.className = "sector-flow-empty";
  empty.hidden = true;

  container.replaceChildren(header, stage, legend, empty);
  return {header, status, source, scale, stage, svg, title, tooltip, legend, empty};
}

function addAxis(svg, maximum, view, minute, scaleMode) {
  const width = VIEWBOX_WIDTH - PLOT.left - PLOT.right;
  const height = VIEWBOX_HEIGHT - PLOT.top - PLOT.bottom;
  [0, 0.5, 1].forEach((ratio) => {
    const y = PLOT.top + height * ratio;
    svg.append(svgElement("line", {class: "sector-flow-grid", x1: PLOT.left, x2: VIEWBOX_WIDTH - PLOT.right, y1: y, y2: y}));
    const label = svgElement("text", {class: "sector-flow-axis-label", x: PLOT.left - 5, y: y + 3, "text-anchor": "end"});
    const magnitude = (scaleMode === "relative" ? 100 : maximum) * (1 - ratio);
    label.textContent = scaleMode === "relative"
      ? `${magnitude.toFixed(0)}%`
      : `${view === "outflow" && magnitude ? "-" : ""}${magnitude.toFixed(maximum < 10 ? 1 : 0)}`;
    svg.append(label);
  });
  [[0, "09:30"], [120, "11:30/13:00"], [240, "15:00"]].forEach(([tickMinute, labelText]) => {
    const x = PLOT.left + width * tickMinute / 240;
    svg.append(svgElement("line", {class: "sector-flow-grid vertical", x1: x, x2: x, y1: PLOT.top, y2: PLOT.top + height}));
    const label = svgElement("text", {class: "sector-flow-axis-label", x, y: VIEWBOX_HEIGHT - 4, "text-anchor": tickMinute === 0 ? "start" : tickMinute === 240 ? "end" : "middle"});
    label.textContent = labelText;
    svg.append(label);
  });
  const cursorX = PLOT.left + width * Math.max(0, Math.min(240, minute)) / 240;
  svg.append(svgElement("line", {class: "sector-flow-time-cursor", x1: cursorX, x2: cursorX, y1: PLOT.top, y2: PLOT.top + height}));
}

function drawSeries(svg, selectedRows, maximum, minute, view, scaleMode) {
  const width = VIEWBOX_WIDTH - PLOT.left - PLOT.right;
  const height = VIEWBOX_HEIGHT - PLOT.top - PLOT.bottom;
  selectedRows.forEach(({row}, index) => {
    const points = visibleSeriesPoints(row, minute);
    if (!points.length) return;
    const seriesMaximum = scaleMode === "relative"
      ? Math.max(0.0001, ...points.map((point) => Math.abs(point.amount)))
      : maximum;
    const coordinates = points.map((point) => {
      const x = PLOT.left + width * point.minute / 240;
      const y = PLOT.top + height * (1 - Math.min(1, Math.abs(point.amount) / seriesMaximum));
      return {x, y, point};
    });
    if (coordinates.length >= 2) {
      const path = svgElement("path", {
        class: `sector-flow-line ${view} series-${index + 1}`,
        d: coordinates.map((item, pointIndex) => `${pointIndex ? "L" : "M"}${item.x.toFixed(2)},${item.y.toFixed(2)}`).join(" "),
      });
      path.dataset.seriesKey = seriesKey(row);
      styleSeries(path, view, index);
      svg.append(path);
    }
    const last = coordinates.at(-1);
    const dot = svgElement("circle", {
      class: `sector-flow-dot ${view} series-${index + 1}`,
      cx: last.x,
      cy: last.y,
      r: index < 3 ? 2.5 : 2,
    });
    dot.dataset.seriesKey = seriesKey(row);
    styleSeries(dot, view, index);
    svg.append(dot);
  });
}

function renderLegend(target, selectedRows, view) {
  const fragment = document.createDocumentFragment();
  selectedRows.forEach(({row, currentAmount, displayName}, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "sector-flow-legend-item";
    item.dataset.seriesKey = seriesKey(row);
    item.setAttribute("aria-pressed", "false");
    item.title = `突出显示${displayName}曲线`;
    styleSeries(item, view, index);
    const swatch = document.createElement("span");
    swatch.className = `sector-flow-swatch ${view} series-${index + 1}`;
    styleSeries(swatch, view, index);
    const name = document.createElement("strong");
    name.textContent = `${index + 1}. ${displayName}`;
    name.title = row.tdxName && row.tdxName !== row.name ? `${row.tdxName} / 原：${row.name}` : row.name || "";
    const amount = document.createElement("span");
    amount.textContent = formatAmount(currentAmount);
    item.append(swatch, name, amount);
    fragment.append(item);
  });
  target.replaceChildren(fragment);
}

function renderTooltip(target, selectedRows, minute) {
  const time = document.createElement("strong");
  time.className = "sector-flow-tooltip-time";
  time.textContent = marketMinuteToTime(minute);
  const grid = document.createElement("div");
  grid.className = "sector-flow-tooltip-grid";
  selectedRows.forEach(({row, displayName}, index) => {
    const item = document.createElement("span");
    item.className = "sector-flow-tooltip-item";
    const swatch = document.createElement("i");
    styleSeries(swatch, "inflow", index);
    swatch.style.setProperty("--series-color", SERIES_COLORS[valueAt(row, minute) < 0 ? "outflow" : "inflow"][index % SERIES_COLORS.inflow.length]);
    const name = document.createElement("span");
    name.textContent = displayName;
    const amount = document.createElement("b");
    amount.textContent = formatAmount(valueAt(row, minute));
    item.append(swatch, name, amount);
    grid.append(item);
  });
  target.replaceChildren(time, grid);
}

export function createSectorFlowChart(container) {
  const dom = createBase(container);
  let snapshot = null;
  let lockedSeriesKey = "";
  let hoveredSeriesKey = "";
  let scaleMode = "absolute";
  try {
    scaleMode = localStorage.getItem("a-share-review:sector-flow-scale") === "relative" ? "relative" : "absolute";
  } catch (_) {
    scaleMode = "absolute";
  }

  function applySeriesHighlight() {
    const activeKey = hoveredSeriesKey || lockedSeriesKey;
    container.classList.toggle("has-series-highlight", Boolean(activeKey));
    container.querySelectorAll("[data-series-key]").forEach((node) => {
      const matches = Boolean(activeKey) && node.dataset.seriesKey === activeKey;
      node.classList.toggle("is-highlighted", matches);
      node.classList.toggle("is-dimmed", Boolean(activeKey) && !matches);
      if (node.classList.contains("sector-flow-legend-item")) {
        node.setAttribute("aria-pressed", String(node.dataset.seriesKey === lockedSeriesKey));
      }
    });
  }

  function legendItem(target) {
    return target instanceof Element ? target.closest(".sector-flow-legend-item") : null;
  }

  dom.legend.addEventListener("pointerover", (event) => {
    const item = legendItem(event.target);
    if (!item) return;
    hoveredSeriesKey = item.dataset.seriesKey || "";
    applySeriesHighlight();
  });
  dom.legend.addEventListener("pointerout", (event) => {
    const item = legendItem(event.target);
    if (!item || (event.relatedTarget instanceof Node && item.contains(event.relatedTarget))) return;
    hoveredSeriesKey = "";
    applySeriesHighlight();
  });
  dom.legend.addEventListener("focusin", (event) => {
    const item = legendItem(event.target);
    if (!item) return;
    hoveredSeriesKey = item.dataset.seriesKey || "";
    applySeriesHighlight();
  });
  dom.legend.addEventListener("focusout", (event) => {
    const item = legendItem(event.target);
    if (!item || (event.relatedTarget instanceof Node && item.contains(event.relatedTarget))) return;
    hoveredSeriesKey = "";
    applySeriesHighlight();
  });
  dom.legend.addEventListener("click", (event) => {
    const item = legendItem(event.target);
    if (!item) return;
    const key = item.dataset.seriesKey || "";
    lockedSeriesKey = lockedSeriesKey === key ? "" : key;
    hoveredSeriesKey = "";
    applySeriesHighlight();
  });
  dom.scale.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-flow-scale]") : null;
    if (!button) return;
    const nextMode = button.dataset.flowScale === "relative" ? "relative" : "absolute";
    if (nextMode === scaleMode) return;
    scaleMode = nextMode;
    try { localStorage.setItem("a-share-review:sector-flow-scale", scaleMode); } catch (_) {}
    if (snapshot) render(snapshot.group, snapshot);
  });

  function render(group, options = {}) {
    const minute = Math.max(0, Math.min(240, finite(options.minute) ?? 0));
    const view = options.view === "outflow" ? "outflow" : "inflow";
    const maximum = Math.max(1, finite(options.maximum) ?? 1);
    const selectedRows = chooseRows(group, view, minute);
    if (snapshot?.view && snapshot.view !== view) {
      lockedSeriesKey = "";
      hoveredSeriesKey = "";
    }
    snapshot = {group, minute, view, maximum, selectedRows};
    container.dataset.flowView = view;
    container.classList.toggle("outflow", view === "outflow");
    const drawableCount = selectedRows.filter(({row}) => validPoints(row).length >= 2).length;
    dom.status.textContent = `${marketMinuteToTime(minute)} ${view === "inflow" ? "净流入" : "净流出"}前十${drawableCount ? "轨迹" : "（轨迹补齐中）"}`;
    const verifiedCount = selectedRows.filter(({row}) => row.flowValidated).length;
    dom.source.textContent = verifiedCount
      ? `官方分钟序列 ${verifiedCount}/${selectedRows.length}`
      : drawableCount
        ? `真实采样轨迹 ${drawableCount}/${selectedRows.length}`
        : `真实采样点 ${selectedRows.length}条，正在补齐轨迹`;
    dom.title.textContent = `${group?.title || "板块"}${view === "inflow" ? "净流入" : "净流出"}前十分时图，时间 ${marketMinuteToTime(minute)}`;
    dom.scale.querySelectorAll("button").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.flowScale === scaleMode));
    });
    dom.svg.replaceChildren(dom.title);
    addAxis(dom.svg, maximum, view, minute, scaleMode);
    drawSeries(dom.svg, selectedRows, maximum, minute, view, scaleMode);
    renderLegend(dom.legend, selectedRows, view);
    if (lockedSeriesKey && !selectedRows.some(({row}) => seriesKey(row) === lockedSeriesKey)) lockedSeriesKey = "";
    applySeriesHighlight();
    dom.empty.hidden = selectedRows.length > 0;
    dom.stage.hidden = selectedRows.length === 0;
    dom.legend.hidden = selectedRows.length === 0;
    if (!selectedRows.length) {
      dom.empty.textContent = minute < 1
        ? "09:31 生成首笔官方板块资金数据。"
        : `截至 ${marketMinuteToTime(minute)}，当前方向尚未形成可展示的板块。`;
    }
  }

  dom.svg.addEventListener("pointermove", (event) => {
    if (!snapshot?.selectedRows?.length) return;
    const rect = dom.svg.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    const minute = Math.min(snapshot.minute, Math.max(0, (ratio * VIEWBOX_WIDTH - PLOT.left) / (VIEWBOX_WIDTH - PLOT.left - PLOT.right) * 240));
    renderTooltip(dom.tooltip, snapshot.selectedRows, minute);
    dom.tooltip.style.left = "50%";
    dom.tooltip.style.top = "24px";
    dom.tooltip.hidden = false;
  });
  dom.svg.addEventListener("pointerleave", () => { dom.tooltip.hidden = true; });

  return {render};
}
