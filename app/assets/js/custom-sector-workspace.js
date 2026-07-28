const MAX_CUSTOM_SECTORS = 6;
const STORAGE_KEY = "a-share-review:custom-sectors:v1";

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

function lineGeometry(points, minute) {
  const visible = (points || []).filter((point) => point.minute <= minute);
  const percentages = (points || []).map((point) => point.changePct).filter(Number.isFinite);
  if (!visible.length || !percentages.length) return {path: "", zeroY: 42, latest: null, latestX: 0, latestY: 42};
  const rawMin = Math.min(0, ...percentages);
  const rawMax = Math.max(0, ...percentages);
  const spread = Math.max(rawMax - rawMin, Math.max(Math.abs(rawMax), Math.abs(rawMin)) * .08, .1);
  const padding = spread * .08;
  const min = rawMin - padding;
  const max = rawMax + padding;
  const width = 300;
  const height = 84;
  const x = (value) => Math.max(0, Math.min(width, (value / 240) * width));
  const y = (value) => height - ((value - min) / (max - min)) * height;
  const latest = visible.at(-1);
  return {
    path: visible.map((point, index) => `${index ? "L" : "M"}${x(point.minute).toFixed(2)},${y(point.changePct).toFixed(2)}`).join(" "),
    zeroY: y(0),
    latest,
    latestX: x(latest.minute),
    latestY: y(latest.changePct),
  };
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
      <svg class="custom-sector-chart" viewBox="0 0 300 84" preserveAspectRatio="none" role="img">
        <title></title>
        <line class="custom-sector-chart-grid" x1="0" x2="300" y1="21" y2="21"></line>
        <line class="custom-sector-zero" x1="0" x2="300" y1="42" y2="42"></line>
        <line class="custom-sector-chart-grid" x1="0" x2="300" y1="63" y2="63"></line>
        <path class="custom-sector-line"></path>
        <circle class="custom-sector-cursor" r="3"></circle>
      </svg>
      <div class="custom-sector-axis"><span>09:30</span><span>11:30 / 13:00</span><span>15:00</span></div>
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
  };

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
    const current = geometry.latest?.changePct ?? finite(record.currentChangePct);
    const amount = card.querySelector(".custom-sector-amount");
    amount.className = `custom-sector-amount ${valueClass(current)}`;
    amount.textContent = percentText(current);
    const path = card.querySelector(".custom-sector-line");
    path.setAttribute("d", geometry.path);
    path.classList.toggle("loss-line", finite(current) < 0);
    const zero = card.querySelector(".custom-sector-zero");
    zero.setAttribute("y1", geometry.zeroY.toFixed(2));
    zero.setAttribute("y2", geometry.zeroY.toFixed(2));
    const cursor = card.querySelector(".custom-sector-cursor");
    if (geometry.latest) {
      cursor.setAttribute("cx", geometry.latestX.toFixed(2));
      cursor.setAttribute("cy", geometry.latestY.toFixed(2));
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
          ? `${record.source || "真实指数分时"} · ${points.length}点`
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
    const directoryTradeDate = String(groups?.industry?.tradeDate || groups?.concept?.tradeDate || "").trim();
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
  MAX_CUSTOM_SECTORS,
  STORAGE_KEY,
  createCustomSectorWorkspace,
};
