import {
  buildConceptTurningAnnotations,
  GENERIC_CONCEPT_PATTERN,
  selectSignificantConceptAnnotations,
  selectVisibleConceptAnnotations,
} from "./concept-turning-annotations.js?v=20260813-4";

const MAX_CUSTOM_SECTORS = 6;
const MAX_CONCEPT_HISTORY_ROWS = 36;
const MAX_CONCEPT_HISTORY_CONCURRENCY = 6;
const CONCEPT_HISTORY_RETRY_MS = 60 * 1000;
const STORAGE_KEY = "a-share-review:custom-sectors:v1";
const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_WIDTH = 300;
const PLOT_TOP = 39;
const PLOT_BOTTOM = 118;
const ANNOTATION_LANES = [6.5, 15.5, 24.5, 33.5];

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function el(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== "") element.textContent = String(text);
  return element;
}

function normalizeSelection(item) {
  const code = String(item?.code || "").trim().toUpperCase();
  const group = item?.group === "concept" ? "concept" : "industry";
  if (!/^BK\d{4}$/.test(code)) return null;
  return {
    code,
    name: String(item?.name || code).trim() || code,
    group,
  };
}

function readSelections(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || "[]");
    const unique = new Map();
    for (const item of Array.isArray(parsed) ? parsed : []) {
      const normalized = normalizeSelection(item);
      if (normalized && !unique.has(normalized.code)) unique.set(normalized.code, normalized);
    }
    return [...unique.values()].slice(0, MAX_CUSTOM_SECTORS);
  } catch (_) {
    return [];
  }
}

function writeSelections(storage, selections) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(selections));
  } catch (_) {
    // The selection still remains available for the current session.
  }
}

function groupLabel(group) {
  return group === "concept" ? "题材概念" : "二级行业";
}

function percentText(value, signed = true) {
  const percentage = finite(value);
  if (percentage === null) return "--";
  return `${signed && percentage > 0 ? "+" : ""}${percentage.toFixed(2)}%`;
}

function valueClass(value) {
  const percentage = finite(value);
  if (percentage === null || percentage === 0) return "neutral";
  return percentage > 0 ? "gain" : "loss";
}

function uniquePoints(points, tradeDate = "") {
  const byMinute = new Map();
  for (const point of points || []) {
    const minute = finite(point?.minute);
    const changePct = finite(point?.changePct);
    if (minute === null || changePct === null) continue;
    if (tradeDate && point.tradeDate && point.tradeDate !== tradeDate) continue;
    byMinute.set(minute, {...point, minute, changePct});
  }
  return [...byMinute.values()].sort((left, right) => left.minute - right.minute);
}

function selectConceptHistoryCandidates(rows, limit = MAX_CONCEPT_HISTORY_ROWS) {
  const eligible = (rows || []).filter((row) => {
    const code = String(row?.code || row?.tdxCode || "").trim().toUpperCase();
    const name = String(row?.name || row?.tdxName || "").trim();
    return /^BK\d{4}$/.test(code) && name && !GENERIC_CONCEPT_PATTERN.test(name);
  });
  const selected = new Map();
  const append = (items) => items.forEach((row) => {
    const code = String(row?.code || row?.tdxCode || "").trim().toUpperCase();
    if (!selected.has(code) && selected.size < limit) selected.set(code, row);
  });
  const byAmount = eligible.filter((row) => finite(row.amount) !== null);
  const perDirection = Math.max(1, Math.floor(limit / 3));
  append([...byAmount].sort((left, right) => finite(right.amount) - finite(left.amount)).slice(0, perDirection));
  append([...byAmount].sort((left, right) => finite(left.amount) - finite(right.amount)).slice(0, perDirection));
  append([...eligible].sort((left, right) => (
    Math.abs(finite(right.changePct) || 0) - Math.abs(finite(left.changePct) || 0)
  )).slice(0, limit - selected.size));
  append([...byAmount].sort((left, right) => (
    Math.abs(finite(right.amount) || 0) - Math.abs(finite(left.amount) || 0)
  )).slice(0, limit - selected.size));
  return [...selected.values()].slice(0, limit);
}

function lineGeometry(points, minute) {
  const visible = (points || []).filter((point) => point.minute <= minute);
  const percentages = (points || []).map((point) => point.changePct).filter(Number.isFinite);
  const emptyY = (PLOT_TOP + PLOT_BOTTOM) / 2;
  if (!visible.length || !percentages.length) {
    return {
      path: "",
      zeroY: emptyY,
      latest: null,
      latestX: 0,
      latestY: emptyY,
      xForMinute: () => 0,
      yForChangePct: () => emptyY,
    };
  }
  const rawMin = Math.min(0, ...percentages);
  const rawMax = Math.max(0, ...percentages);
  const spread = Math.max(rawMax - rawMin, Math.max(Math.abs(rawMax), Math.abs(rawMin)) * .08, .1);
  const padding = spread * .08;
  const min = rawMin - padding;
  const max = rawMax + padding;
  const x = (value) => Math.max(0, Math.min(CHART_WIDTH, (value / 240) * CHART_WIDTH));
  const y = (value) => PLOT_BOTTOM - ((value - min) / (max - min)) * (PLOT_BOTTOM - PLOT_TOP);
  const latest = visible.at(-1);
  return {
    path: visible.map((point, index) => `${index ? "L" : "M"}${x(point.minute).toFixed(2)},${y(point.changePct).toFixed(2)}`).join(" "),
    zeroY: y(0),
    latest,
    latestX: x(latest.minute),
    latestY: y(latest.changePct),
    xForMinute: x,
    yForChangePct: y,
  };
}

function flowEvidenceText(event) {
  const delta = finite(event?.flowDelta);
  const amount = finite(event?.flowAmount);
  const change = finite(event?.conceptChangeDelta);
  const parts = [];
  if (delta !== null) parts.push(`资金增量${delta > 0 ? "+" : ""}${delta.toFixed(2)}亿`);
  else if (amount !== null) parts.push(`累计净额${amount > 0 ? "+" : ""}${amount.toFixed(2)}亿`);
  if (change !== null) parts.push(`题材同期${change > 0 ? "+" : ""}${change.toFixed(2)}%`);
  return parts.join("，") || "真实题材资金样本方向一致";
}

function labelMetrics(label) {
  const length = Math.max(1, [...String(label || "")].length);
  const fontSize = Math.max(6.2, Math.min(8.2, 96 / length));
  return {fontSize, width: Math.max(30, Math.min(122, length * fontSize + 8)), height: 9};
}

function overlaps(left, right) {
  return !(left.right + 2 <= right.left || right.right + 2 <= left.left);
}

function layoutAnnotations(events, geometry) {
  const laneBoxes = ANNOTATION_LANES.map(() => []);
  return [...events].sort((left, right) => left.minute - right.minute).map((event, eventIndex) => {
    const metrics = labelMetrics(event.label);
    const pivotX = geometry.xForMinute(event.minute);
    const naturalCenter = Math.max(metrics.width / 2 + 2, Math.min(CHART_WIDTH - metrics.width / 2 - 2, pivotX));
    let placement = null;
    for (let laneOffset = 0; laneOffset < ANNOTATION_LANES.length && !placement; laneOffset += 1) {
      const lane = (eventIndex + laneOffset) % ANNOTATION_LANES.length;
      const boxes = laneBoxes[lane];
      const centers = [naturalCenter];
      if (boxes.length) {
        centers.push(
          Math.max(metrics.width / 2 + 2, boxes.at(-1).right + 3 + metrics.width / 2),
          Math.min(CHART_WIDTH - metrics.width / 2 - 2, boxes[0].left - 3 - metrics.width / 2),
        );
      }
      for (const center of [...new Set(centers)].sort((left, right) => Math.abs(left - naturalCenter) - Math.abs(right - naturalCenter))) {
        const box = {left: center - metrics.width / 2, right: center + metrics.width / 2};
        if (box.left < 2 || box.right > CHART_WIDTH - 2 || boxes.some((other) => overlaps(box, other))) continue;
        placement = {event, lane, center, pivotX, metrics, box};
        boxes.push(box);
        boxes.sort((left, right) => left.left - right.left);
        break;
      }
    }
    if (placement) return placement;
    const lane = eventIndex % ANNOTATION_LANES.length;
    const center = naturalCenter;
    return {
      event,
      lane,
      center,
      pivotX,
      metrics,
      box: {left: center - metrics.width / 2, right: center + metrics.width / 2},
    };
  });
}

function renderConceptAnnotations(card, events, geometry) {
  const layer = card.querySelector(".custom-sector-annotations");
  if (!layer) return;
  const nodes = layoutAnnotations(events, geometry).map((placement) => {
    const {event, lane, center, pivotX, metrics} = placement;
    const targetChangePct = finite(event.targetChangePct) ?? 0;
    const pivotY = geometry.yForChangePct(targetChangePct);
    const labelY = ANNOTATION_LANES[lane];
    const group = document.createElementNS(SVG_NS, "g");
    group.classList.add("custom-sector-annotation", event.direction > 0 ? "turn-up" : "turn-down");
    group.dataset.conceptCode = event.conceptCode || "";
    group.dataset.turnMinute = String(event.minute);
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = `${event.sampleTime || "--"}｜${event.directionName}｜主导题材：${event.label}｜${flowEvidenceText(event)}｜置信度${event.confidenceLabel}`;
    const stem = document.createElementNS(SVG_NS, "line");
    stem.classList.add("custom-sector-annotation-stem");
    stem.setAttribute("x1", pivotX.toFixed(2));
    stem.setAttribute("y1", pivotY.toFixed(2));
    stem.setAttribute("x2", center.toFixed(2));
    stem.setAttribute("y2", (labelY + 3).toFixed(2));
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.classList.add("custom-sector-annotation-dot");
    dot.setAttribute("cx", pivotX.toFixed(2));
    dot.setAttribute("cy", pivotY.toFixed(2));
    dot.setAttribute("r", "1.7");
    const background = document.createElementNS(SVG_NS, "rect");
    background.classList.add("custom-sector-annotation-bg");
    background.setAttribute("x", (center - metrics.width / 2).toFixed(2));
    background.setAttribute("y", (labelY - metrics.height / 2).toFixed(2));
    background.setAttribute("width", metrics.width.toFixed(2));
    background.setAttribute("height", metrics.height.toFixed(2));
    background.setAttribute("rx", "1.8");
    const text = document.createElementNS(SVG_NS, "text");
    text.classList.add("custom-sector-annotation-label");
    text.setAttribute("x", center.toFixed(2));
    text.setAttribute("y", (labelY + .2).toFixed(2));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "middle");
    text.setAttribute("font-size", metrics.fontSize.toFixed(2));
    text.textContent = event.label;
    group.append(title, stem, dot, background, text);
    return group;
  });
  layer.replaceChildren(...nodes);
}

function createCard(selection) {
  const card = el("article", "custom-sector-card");
  card.dataset.customSectorCode = selection.code;
  card.innerHTML = `
    <header class="custom-sector-card-header">
      <div class="custom-sector-identity">
        <strong></strong>
        <span class="custom-sector-kind"></span>
      </div>
      <strong class="custom-sector-amount neutral">--</strong>
      <div class="custom-sector-actions">
        <button class="custom-sector-k" type="button" data-custom-sector-k title="在当前设备的股票软件中打开板块日K">日K</button>
        <button class="custom-sector-remove" type="button" data-custom-sector-remove title="移除板块" aria-label="移除板块">×</button>
      </div>
    </header>
    <div class="custom-sector-chart-wrap">
      <svg class="custom-sector-chart" viewBox="0 0 300 120" preserveAspectRatio="none" role="img">
        <title></title>
        <line class="custom-sector-chart-grid" x1="0" x2="300" y1="59" y2="59"></line>
        <line class="custom-sector-zero" x1="0" x2="300" y1="76" y2="76"></line>
        <line class="custom-sector-chart-grid" x1="0" x2="300" y1="98" y2="98"></line>
        <path class="custom-sector-line"></path>
        <g class="custom-sector-annotations"></g>
        <circle class="custom-sector-cursor" r="3"></circle>
      </svg>
      <div class="custom-sector-axis"><span>09:30:00</span><span>11:30:00 / 13:00:00</span><span>15:00:00</span></div>
    </div>
    <footer class="custom-sector-card-footer">
      <span class="custom-sector-source">读取真实板块指数分时</span>
      <span class="custom-sector-time">--</span>
    </footer>`;
  card.querySelector(".custom-sector-identity strong").textContent = selection.name;
  card.querySelector(".custom-sector-kind").textContent = groupLabel(selection.group);
  card.querySelector("title").textContent = `${selection.name}${groupLabel(selection.group)}指数分时`;
  return card;
}

function createCustomSectorWorkspace(options) {
  const {
    grid,
    picker,
    pickerList,
    searchInput,
    filterControls,
    addButton,
    closeButton,
    count,
    loadTimeline,
    loadFlowTimeline,
    openDayK,
    showNotice,
  } = options;
  const storage = options.storage || globalThis.localStorage;
  const state = {
    selections: readSelections(storage),
    directory: [],
    series: new Map(),
    cards: new Map(),
    filter: "all",
    currentMinute: 240,
    latestMarketMinute: null,
    tradeDate: "",
    latestSourceTime: "",
    conceptSeries: new Map(),
    conceptRevision: 0,
    conceptHistoryDate: "",
    conceptHistoryLoads: new Map(),
    conceptHistoryQueue: [],
    conceptHistoryActive: 0,
  };

  function ingestConceptRows(rows, tradeDate = state.tradeDate, fallbackMinute = null, fallbackTime = "") {
    const normalizedTradeDate = String(tradeDate || state.tradeDate || "");
    let changed = false;
    for (const row of rows || []) {
      const code = String(row?.code || row?.tdxCode || "").trim().toUpperCase();
      const name = String(row?.name || row?.tdxName || "").trim();
      if (!/^BK\d{4}$/.test(code) || !name) continue;
      const previous = state.conceptSeries.get(code);
      const reset = previous?.tradeDate && normalizedTradeDate && previous.tradeDate !== normalizedTradeDate;
      const byMinute = new Map((reset ? [] : previous?.points || []).map((point) => [point.minute, point]));
      const additions = [...(row.points || [])];
      if (finite(row.amount) !== null && finite(fallbackMinute) !== null) {
        additions.push({
          minute: fallbackMinute,
          time: fallbackTime,
          amount: row.amount,
          changePct: row.changePct,
          source: row.source || "eastmoney-live-board-ranking",
        });
      }
      for (const raw of additions) {
        const minute = finite(raw?.minute);
        const amount = finite(raw?.amount);
        if (minute === null || amount === null || minute < 0 || minute > 240) continue;
        const bucket = Math.max(0, Math.min(240, Math.floor(minute)));
        const next = {
          tradeDate: String(raw.tradeDate || normalizedTradeDate),
          minute: bucket,
          time: String(raw.time || fallbackTime || ""),
          amount,
          changePct: finite(raw.changePct),
          source: String(raw.source || row.source || "真实概念板块资金样本"),
        };
        const current = byMinute.get(bucket);
        if (!current || current.amount !== next.amount || current.changePct !== next.changePct || current.time !== next.time) {
          byMinute.set(bucket, next);
          changed = true;
        }
      }
      state.conceptSeries.set(code, {
        code,
        name,
        group: "concept",
        tradeDate: normalizedTradeDate,
        points: [...byMinute.values()].sort((left, right) => left.minute - right.minute).slice(-241),
      });
    }
    if (changed) state.conceptRevision += 1;
  }

  function drainConceptHistoryQueue() {
    if (typeof loadFlowTimeline !== "function") return;
    while (state.conceptHistoryActive < MAX_CONCEPT_HISTORY_CONCURRENCY && state.conceptHistoryQueue.length) {
      const task = state.conceptHistoryQueue.shift();
      const key = `${task.tradeDate}:${task.code}`;
      state.conceptHistoryActive += 1;
      state.conceptHistoryLoads.set(key, {status: "loading", updatedAt: Date.now()});
      Promise.resolve(loadFlowTimeline(task.code, task.name)).then((result) => {
        if (!result?.ok || result.tradeDate !== task.tradeDate || state.tradeDate !== task.tradeDate) {
          throw new Error("题材分钟资金交易日不一致");
        }
        ingestConceptRows([{
          code: task.code,
          name: result.name || task.name,
          points: result.points || [],
          source: result.source || "真实题材概念分钟资金",
        }], task.tradeDate);
        state.conceptHistoryLoads.set(key, {status: "done", updatedAt: Date.now()});
        render(state.currentMinute);
      }).catch(() => {
        state.conceptHistoryLoads.set(key, {status: "failed", updatedAt: Date.now()});
      }).finally(() => {
        state.conceptHistoryActive = Math.max(0, state.conceptHistoryActive - 1);
        drainConceptHistoryQueue();
      });
    }
  }

  function queueConceptHistories(rows, tradeDate) {
    const normalizedTradeDate = String(tradeDate || state.tradeDate || "");
    if (typeof loadFlowTimeline !== "function" || !/^\d{4}-\d{2}-\d{2}$/.test(normalizedTradeDate)) return;
    if (state.conceptHistoryDate !== normalizedTradeDate) {
      state.conceptHistoryDate = normalizedTradeDate;
      state.conceptHistoryLoads.clear();
      state.conceptHistoryQueue = [];
    }
    const now = Date.now();
    for (const row of selectConceptHistoryCandidates(rows)) {
      const code = String(row?.code || row?.tdxCode || "").trim().toUpperCase();
      const name = String(row?.name || row?.tdxName || "").trim();
      const key = `${normalizedTradeDate}:${code}`;
      const existing = state.conceptHistoryLoads.get(key);
      if (existing?.status === "queued" || existing?.status === "loading" || existing?.status === "done") continue;
      if (existing?.status === "failed" && now - existing.updatedAt < CONCEPT_HISTORY_RETRY_MS) continue;
      state.conceptHistoryLoads.set(key, {status: "queued", updatedAt: now});
      state.conceptHistoryQueue.push({code, name, tradeDate: normalizedTradeDate});
    }
    drainConceptHistoryQueue();
  }

  function annotationsFor(selection, record, points) {
    const latestPoint = points.at(-1);
    const signature = `${state.conceptRevision}:${record.tradeDate || state.tradeDate}:${points.length}:${latestPoint?.minute ?? ""}:${latestPoint?.changePct ?? ""}`;
    if (record.annotationSignature === signature) return record.annotations || [];
    record.annotations = selectSignificantConceptAnnotations(buildConceptTurningAnnotations({
      code: selection.code,
      name: selection.name,
      tradeDate: record.tradeDate || state.tradeDate,
      preClose: record.preClose,
      points,
    }, [...state.conceptSeries.values()], {visibleMinute: 240}));
    record.annotationSignature = signature;
    return record.annotations;
  }

  function save() {
    writeSelections(storage, state.selections);
    if (count) count.textContent = `${state.selections.length}/${MAX_CUSTOM_SECTORS}`;
  }

  function selectionByCode(code) {
    return state.selections.find((item) => item.code === code);
  }

  function renderCard(selection) {
    let card = state.cards.get(selection.code);
    if (!card) {
      card = createCard(selection);
      state.cards.set(selection.code, card);
    }
    const record = state.series.get(selection.code) || {points: [], loading: false, error: ""};
    const points = uniquePoints(record.points, state.tradeDate || record.tradeDate);
    const geometry = lineGeometry(points, state.currentMinute);
    const visibleAnnotations = selectVisibleConceptAnnotations(
      annotationsFor(selection, record, points),
      state.currentMinute,
    );
    const current = geometry.latest?.changePct ?? finite(record.currentChangePct);
    const amount = card.querySelector(".custom-sector-amount");
    amount.className = `custom-sector-amount ${valueClass(current)}`;
    amount.textContent = percentText(current);
    const path = card.querySelector(".custom-sector-line");
    path.setAttribute("d", geometry.path);
    path.classList.toggle("loss-line", finite(current) < 0);
    renderConceptAnnotations(card, visibleAnnotations, geometry);
    const zero = card.querySelector(".custom-sector-zero");
    zero.setAttribute("y1", geometry.zeroY.toFixed(2));
    zero.setAttribute("y2", geometry.zeroY.toFixed(2));
    const cursor = card.querySelector(".custom-sector-cursor");
    if (geometry.latest) {
      cursor.setAttribute("cx", geometry.latestX.toFixed(2));
      cursor.setAttribute("cy", geometry.latestY.toFixed(2));
      cursor.classList.toggle("loss-cursor", finite(current) < 0);
      cursor.hidden = false;
    } else {
      cursor.hidden = true;
    }
    const source = card.querySelector(".custom-sector-source");
    source.className = `custom-sector-source${record.error ? " warning" : ""}`;
    source.textContent = record.loading
      ? "正在读取真实板块指数分时"
      : record.error && points.length
        ? "当前真实快照 · 完整轨迹后台重试中"
        : record.error
          ? "真实板块指数分时连接中"
        : points.length
          ? `${record.source || "真实指数分时"} · ${points.length}点 · ${visibleAnnotations.length}个题材拐点`
          : "等待真实指数样本";
    card.querySelector(".custom-sector-time").textContent = geometry.latest?.time || "--";
    return card;
  }

  function renderGrid() {
    const activeCodes = new Set(state.selections.map((item) => item.code));
    state.cards.forEach((card, code) => {
      if (!activeCodes.has(code)) {
        card.remove();
        state.cards.delete(code);
      }
    });
    const fragment = document.createDocumentFragment();
    for (const selection of state.selections) fragment.append(renderCard(selection));
    if (!state.selections.length) {
      const empty = el("button", "custom-sector-empty");
      empty.type = "button";
      empty.dataset.customSectorEmptyAdd = "1";
      empty.innerHTML = "<strong>添加行业或题材概念</strong><span>最多六个，按 3 × 2 排列</span>";
      fragment.append(empty);
    }
    grid.replaceChildren(fragment);
    save();
  }

  function directoryRows() {
    const query = String(searchInput?.value || "").trim().toLocaleLowerCase("zh-CN");
    return state.directory.filter((item) => {
      if (state.filter !== "all" && item.group !== state.filter) return false;
      if (!query) return true;
      return `${item.name} ${item.code} ${groupLabel(item.group)}`.toLocaleLowerCase("zh-CN").includes(query);
    });
  }

  function renderPicker() {
    const rows = directoryRows();
    const selectedCodes = new Set(state.selections.map((item) => item.code));
    const atLimit = selectedCodes.size >= MAX_CUSTOM_SECTORS;
    const fragment = document.createDocumentFragment();
    for (const item of rows) {
      const selected = selectedCodes.has(item.code);
      const button = el("button", `custom-sector-option${selected ? " is-selected" : ""}`);
      button.type = "button";
      button.dataset.customSectorOption = item.code;
      button.disabled = atLimit && !selected;
      button.setAttribute("aria-pressed", String(selected));
      const identity = el("span", "custom-sector-option-identity");
      identity.append(el("strong", "", item.name), el("small", "", `${groupLabel(item.group)} · ${item.code}`));
      button.append(identity, el("span", `custom-sector-option-amount ${valueClass(item.changePct)}`, percentText(item.changePct)));
      fragment.append(button);
    }
    if (!rows.length) fragment.append(el("p", "custom-sector-option-empty", "没有匹配的板块。"));
    pickerList.replaceChildren(fragment);
    filterControls?.querySelectorAll("[data-custom-sector-filter]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.customSectorFilter === state.filter));
    });
  }

  async function ensureTimeline(selection) {
    const existing = state.series.get(selection.code);
    if (existing?.loading || (existing?.timelineLoaded && existing?.points?.length && existing.tradeDate === state.tradeDate)) return;
    state.series.set(selection.code, {...existing, loading: true, error: ""});
    renderGrid();
    try {
      const result = await loadTimeline(selection.code, selection.name, state.tradeDate);
      const current = state.series.get(selection.code) || {};
      state.series.set(selection.code, {
        ...current,
        points: uniquePoints([...(result.points || []), ...(current.points || [])], result.tradeDate || state.tradeDate),
        tradeDate: result.tradeDate || "",
        preClose: finite(result.preClose),
        source: result.source || "真实板块指数分时",
        timelineLoaded: true,
        loading: false,
        error: "",
      });
    } catch (error) {
      state.series.set(selection.code, {
        ...(state.series.get(selection.code) || {}),
        timelineLoaded: false,
        loading: false,
        error: error.message || String(error),
      });
    }
    renderGrid();
  }

  function loadSelectedTimelines() {
    state.selections.forEach((selection) => ensureTimeline(selection));
  }

  function add(selection) {
    if (selectionByCode(selection.code)) return;
    if (state.selections.length >= MAX_CUSTOM_SECTORS) {
      showNotice?.("最多只能添加六个板块，请先移除一个。", "warning");
      return;
    }
    state.selections.push({code: selection.code, name: selection.name, group: selection.group});
    const currentChangePct = finite(selection.changePct);
    if (currentChangePct !== null) {
      state.series.set(selection.code, {
        ...(state.series.get(selection.code) || {}),
        currentChangePct,
        tradeDate: state.tradeDate,
        timelineLoaded: false,
        points: [{
          tradeDate: state.tradeDate,
          minute: finite(state.latestMarketMinute) ?? state.currentMinute,
          time: state.latestSourceTime,
          changePct: currentChangePct,
          source: "eastmoney-live-board-quote",
        }],
      });
    }
    renderGrid();
    renderPicker();
    ensureTimeline(selection);
  }

  function remove(code) {
    state.selections = state.selections.filter((item) => item.code !== code);
    renderGrid();
    renderPicker();
  }

  function togglePicker(force) {
    const shouldOpen = typeof force === "boolean" ? force : picker.hidden;
    picker.hidden = !shouldOpen;
    addButton?.setAttribute("aria-expanded", String(shouldOpen));
    if (shouldOpen) {
      renderPicker();
      searchInput?.focus();
    }
  }

  function setDirectory(groups) {
    const directoryTradeDate = String(
      groups?.tradeDate || groups?.industry?.tradeDate || groups?.concept?.tradeDate || "",
    ).trim();
    const tradeDateChanged = /^\d{4}-\d{2}-\d{2}$/.test(directoryTradeDate) && directoryTradeDate !== state.tradeDate;
    if (tradeDateChanged) {
      state.tradeDate = directoryTradeDate;
      state.series.forEach((record, code) => {
        state.series.set(code, {
          ...record,
          points: uniquePoints(record.points || [], directoryTradeDate),
          timelineLoaded: false,
        });
      });
    }
    ingestConceptRows(
      groups?.concept?.rows || [],
      directoryTradeDate || state.tradeDate,
      finite(groups?.concept?.flowSampleMinute),
      String(groups?.concept?.liveSnapshot?.sourceTime || ""),
    );
    queueConceptHistories(groups?.concept?.rows || [], directoryTradeDate || state.tradeDate);
    const unique = new Map();
    for (const group of ["industry", "concept"]) {
      for (const row of groups?.[group]?.rows || []) {
        const code = String(row?.code || row?.tdxCode || "").trim().toUpperCase();
        const name = String(row?.name || row?.tdxName || "").trim();
        if (!/^BK\d{4}$/.test(code) || !name) continue;
        const key = `${group}:${code}`;
        unique.set(key, {code, name, group, changePct: finite(row.changePct)});
      }
    }
    state.directory = [...unique.values()].sort((left, right) => (
      left.group.localeCompare(right.group)
      || left.name.localeCompare(right.name, "zh-CN", {numeric: true})
    ));
    state.selections = state.selections.map((selection) => {
      const current = state.directory.find((item) => item.code === selection.code) || selection;
      return {code: selection.code, name: current.name || selection.name, group: current.group || selection.group};
    });
    renderPicker();
    renderGrid();
    if (tradeDateChanged) loadSelectedTimelines();
  }

  function applyLiveSnapshot(snapshot) {
    if (!snapshot?.ok) return;
    state.tradeDate = snapshot.tradeDate || state.tradeDate;
    state.latestSourceTime = snapshot.sourceTime || state.latestSourceTime;
    state.latestMarketMinute = finite(snapshot.marketMinute) ?? state.latestMarketMinute;
    ingestConceptRows(
      snapshot.groups?.concept?.rows || [],
      snapshot.tradeDate || state.tradeDate,
      finite(snapshot.marketMinute),
      snapshot.sourceTime || "",
    );
    const rows = [...(snapshot.groups?.industry?.rows || []).map((row) => ({...row, group: "industry"})),
      ...(snapshot.groups?.concept?.rows || []).map((row) => ({...row, group: "concept"}))];
    const byCode = new Map(rows.map((row) => [String(row.code || "").toUpperCase(), row]));
    for (const selection of state.selections) {
      const row = byCode.get(selection.code);
      const changePct = finite(row?.changePct);
      if (changePct === null) continue;
      const record = state.series.get(selection.code) || {points: []};
      const point = {
        tradeDate: snapshot.tradeDate,
        minute: finite(snapshot.marketMinute) ?? state.currentMinute,
        time: snapshot.sourceTime || "",
        changePct,
        source: "eastmoney-live-board-quote",
      };
      state.series.set(selection.code, {
        ...record,
        currentChangePct: changePct,
        tradeDate: snapshot.tradeDate || record.tradeDate,
        points: uniquePoints([...(record.points || []), point], snapshot.tradeDate || record.tradeDate),
      });
    }
    setDirectory({
      tradeDate: snapshot.tradeDate || state.tradeDate,
      industry: {rows: snapshot.groups?.industry?.rows || []},
      concept: {rows: snapshot.groups?.concept?.rows || []},
    });
    render(state.currentMinute);
  }

  function render(minute) {
    state.currentMinute = Math.max(0, Math.min(240, finite(minute) ?? 240));
    const fragment = document.createDocumentFragment();
    for (const selection of state.selections) fragment.append(renderCard(selection));
    if (!state.selections.length) {
      const empty = el("button", "custom-sector-empty");
      empty.type = "button";
      empty.dataset.customSectorEmptyAdd = "1";
      empty.innerHTML = "<strong>添加行业或题材概念</strong><span>最多六个，按 3 × 2 排列</span>";
      fragment.append(empty);
    }
    grid.replaceChildren(fragment);
  }

  addButton?.addEventListener("click", () => togglePicker());
  closeButton?.addEventListener("click", () => togglePicker(false));
  grid.addEventListener("click", async (event) => {
    if (event.target.closest("[data-custom-sector-empty-add]")) {
      togglePicker(true);
      return;
    }
    const card = event.target.closest("[data-custom-sector-code]");
    if (!card) return;
    const code = card.dataset.customSectorCode;
    if (event.target.closest("[data-custom-sector-remove]")) {
      remove(code);
      return;
    }
    if (event.target.closest("[data-custom-sector-k]")) {
      const selection = selectionByCode(code);
      if (selection) await openDayK(selection);
    }
  });
  pickerList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-custom-sector-option]");
    if (!button || button.disabled) return;
    const item = state.directory.find((row) => row.code === button.dataset.customSectorOption);
    if (!item) return;
    if (selectionByCode(item.code)) remove(item.code);
    else add({code: item.code, name: item.name, group: item.group, changePct: item.changePct});
  });
  searchInput?.addEventListener("input", renderPicker);
  filterControls?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-custom-sector-filter]");
    if (!button) return;
    state.filter = button.dataset.customSectorFilter || "all";
    renderPicker();
  });
  picker.addEventListener("keydown", (event) => {
    if (event.key === "Escape") togglePicker(false);
  });
  window.addEventListener("a-share-membership-change", (event) => {
    if (event.detail?.active) loadSelectedTimelines();
  });

  renderGrid();
  loadSelectedTimelines();
  return {
    applyLiveSnapshot,
    loadSelectedTimelines,
    render,
    setDirectory,
    getSelections: () => [...state.selections],
  };
}

export {
  MAX_CONCEPT_HISTORY_ROWS,
  MAX_CUSTOM_SECTORS,
  STORAGE_KEY,
  createCustomSectorWorkspace,
  selectConceptHistoryCandidates,
};
