const MAX_SELECTED_INDICES = 8;
const MIN_SELECTED_INDICES = 1;
const STORAGE_KEY = "a-share-review:selected-indices:v1";
const DEFAULT_INDEX_KEYS = [
  "sh000001",
  "sz399001",
  "sz399006",
  "sh000688",
  "sh000300",
  "sh000905",
  "bj899050",
  "usIXIC",
];

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

function normalizeKey(value) {
  const key = String(value?.key || value || "").trim();
  return /^(?:sh|sz|bj|us)[A-Za-z0-9]+$/.test(key) ? key : "";
}

function readSelections(storage) {
  try {
    const raw = JSON.parse(storage?.getItem(STORAGE_KEY) || "[]");
    const unique = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      const key = normalizeKey(item);
      if (key && !unique.includes(key)) unique.push(key);
    }
    if (unique.length) return unique.slice(0, MAX_SELECTED_INDICES);
  } catch (_) {
  }
  return [...DEFAULT_INDEX_KEYS];
}

function writeSelections(storage, selections) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(selections));
  } catch (_) {
  }
}

function groupLabel(group) {
  return ({
    shanghai: "沪市指数",
    shenzhen: "深市指数",
    csi: "中证指数",
    beijing: "北交所",
    overseas: "海外指数",
  })[group] || "主要指数";
}

function valueClass(value) {
  const number = finite(value);
  if (number === null || number === 0) return "neutral";
  return number > 0 ? "gain" : "loss";
}

function percentText(value) {
  const number = finite(value);
  if (number === null) return "--";
  return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function uniquePoints(points, tradeDate = "") {
  const byMinute = new Map();
  for (const point of points || []) {
    const minute = finite(point?.minute);
    const price = finite(point?.price);
    if (minute === null || price === null) continue;
    if (tradeDate && point.tradeDate && point.tradeDate !== tradeDate) continue;
    byMinute.set(minute, {...point, minute, price});
  }
  return [...byMinute.values()].sort((left, right) => left.minute - right.minute);
}

function currentChangePct(record) {
  const latest = record?.points?.at(-1);
  const price = finite(record?.liveAuctionQuote?.price) ?? finite(latest?.price);
  const preClose = finite(record?.preClose);
  return price !== null && preClose !== null && preClose > 0 ? ((price - preClose) / preClose) * 100 : null;
}

function createIndexWorkspace(options) {
  const {
    picker,
    pickerList,
    searchInput,
    filterControls,
    addButton,
    closeButton,
    count,
    loadCatalog,
    loadTimeline,
    onSelectionChange,
    onLiveUpdate,
    showNotice,
  } = options;
  const storage = options.storage || globalThis.localStorage;
  const state = {
    selections: readSelections(storage),
    directory: [],
    series: new Map(),
    filter: "all",
    tradeDate: "",
  };

  function save() {
    writeSelections(storage, state.selections);
    if (count) count.textContent = `${state.selections.length}/${MAX_SELECTED_INDICES}`;
  }

  function directoryItem(key) {
    return state.directory.find((item) => item.key === key) || null;
  }

  function ensureRecord(raw) {
    const key = normalizeKey(raw);
    if (!key) return null;
    let record = state.series.get(key);
    if (!record) {
      record = {
        key,
        name: String(raw?.name || key),
        code: String(raw?.code || ""),
        group: String(raw?.group || ""),
        session: String(raw?.session || "cn"),
        points: [],
      };
      state.series.set(key, record);
    }
    Object.assign(record, {
      key,
      name: String(raw?.name || record.name || key),
      code: String(raw?.code || record.code || ""),
      group: String(raw?.group || record.group || ""),
      session: String(raw?.session || record.session || "cn"),
    });
    return record;
  }

  function selectedItems() {
    return state.selections.map((key) => {
      const definition = directoryItem(key) || {key, name: key};
      return ensureRecord(definition);
    }).filter(Boolean);
  }

  function notifySelectionChange() {
    save();
    renderPicker();
    onSelectionChange?.(selectedItems());
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
    if (!pickerList) return;
    const selected = new Set(state.selections);
    const atLimit = selected.size >= MAX_SELECTED_INDICES;
    const rows = directoryRows();
    const fragment = document.createDocumentFragment();
    for (const item of rows) {
      const isSelected = selected.has(item.key);
      const record = state.series.get(item.key);
      const button = el("button", `custom-sector-option index-option${isSelected ? " is-selected" : ""}`);
      button.type = "button";
      button.dataset.indexOption = item.key;
      button.disabled = atLimit && !isSelected;
      button.setAttribute("aria-pressed", String(isSelected));
      const identity = el("span", "custom-sector-option-identity");
      identity.append(
        el("strong", "", item.name),
        el("small", "", `${groupLabel(item.group)} · ${item.code}`),
      );
      const change = currentChangePct(record);
      button.append(
        identity,
        el("span", `custom-sector-option-amount ${valueClass(change)}`, isSelected ? "已添加" : percentText(change)),
      );
      fragment.append(button);
    }
    if (!rows.length) {
      fragment.append(el("p", "custom-sector-option-empty", state.directory.length ? "没有匹配的指数。" : "指数目录读取中。"));
    }
    pickerList.replaceChildren(fragment);
    filterControls?.querySelectorAll("[data-index-filter]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.indexFilter === state.filter));
    });
    save();
  }

  async function ensureTimeline(key) {
    const definition = directoryItem(key) || state.series.get(key);
    const record = definition ? ensureRecord(definition) : null;
    if (!record || record.loading) return;
    if (record.timelineLoaded && record.points.length && (!state.tradeDate || record.tradeDate === state.tradeDate || record.session === "us")) return;
    record.loading = true;
    record.error = "";
    try {
      const result = await loadTimeline(key, state.tradeDate);
      const timelineDate = String(result.tradeDate || record.tradeDate || "");
      Object.assign(record, {
        ...result,
        key,
        name: result.name || record.name,
        code: result.code || record.code,
        group: result.group || record.group,
        session: result.session || record.session || "cn",
        points: uniquePoints([...(result.points || []), ...(record.points || [])], timelineDate),
        tradeDate: timelineDate,
        timelineLoaded: true,
        loading: false,
        error: "",
      });
      onSelectionChange?.(selectedItems());
    } catch (error) {
      record.loading = false;
      record.error = error.message || String(error);
      if (!record.points.length) showNotice?.(`${record.name}分时正在重新连接。`, "warning");
      onSelectionChange?.(selectedItems());
    }
    renderPicker();
  }

  function loadSelectedTimelines() {
    state.selections.forEach((key) => ensureTimeline(key));
  }

  function add(key) {
    if (state.selections.includes(key)) return;
    if (state.selections.length >= MAX_SELECTED_INDICES) {
      showNotice?.("主要指数最多添加八个，请先移除一个。", "warning");
      return;
    }
    state.selections.push(key);
    ensureRecord(directoryItem(key) || {key, name: key});
    notifySelectionChange();
    ensureTimeline(key);
  }

  function remove(key) {
    if (!state.selections.includes(key)) return;
    if (state.selections.length <= MIN_SELECTED_INDICES) {
      showNotice?.("主要指数区至少保留一个指数。", "warning");
      return;
    }
    state.selections = state.selections.filter((item) => item !== key);
    notifySelectionChange();
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

  function setCatalog(payload) {
    const unique = new Map();
    for (const raw of payload?.items || []) {
      const key = normalizeKey(raw);
      const name = String(raw?.name || "").trim();
      if (!key || !name) continue;
      unique.set(key, {
        key,
        name,
        code: String(raw.code || ""),
        group: String(raw.group || ""),
        session: String(raw.session || "cn"),
      });
    }
    state.directory = [...unique.values()];
    state.selections = state.selections.filter((key) => unique.has(key));
    if (!state.selections.length) {
      state.selections = (payload?.defaultSelected || DEFAULT_INDEX_KEYS)
        .map(normalizeKey)
        .filter((key) => key && unique.has(key))
        .slice(0, MAX_SELECTED_INDICES);
    }
    state.directory.forEach(ensureRecord);
    notifySelectionChange();
    loadSelectedTimelines();
  }

  function setBaseIndices(indices) {
    const uniqueDirectory = new Map(state.directory.map((item) => [item.key, item]));
    for (const raw of indices || []) {
      const key = normalizeKey(raw);
      if (!key) continue;
      const item = {
        key,
        name: String(raw.name || key),
        code: String(raw.code || ""),
        group: String(raw.group || uniqueDirectory.get(key)?.group || ""),
        session: String(raw.session || uniqueDirectory.get(key)?.session || "cn"),
      };
      uniqueDirectory.set(key, {...uniqueDirectory.get(key), ...item});
      const record = ensureRecord(item);
      const rawTradeDate = String(raw.tradeDate || "");
      const keepNewerTimeline = Boolean(
        record.timelineLoaded
        && record.points.length > 1
        && record.tradeDate
        && rawTradeDate
        && record.tradeDate > rawTradeDate
      );
      if (keepNewerTimeline) {
        Object.assign(record, item, {loading: false});
      } else {
        Object.assign(record, raw, {
          ...item,
          points: uniquePoints(raw.points || [], rawTradeDate),
          timelineLoaded: Array.isArray(raw.points) && raw.points.length > 1,
          loading: false,
        });
      }
      if (!state.tradeDate && record.session !== "us" && record.tradeDate) state.tradeDate = record.tradeDate;
    }
    state.directory = [...uniqueDirectory.values()];
    renderPicker();
  }

  function applyLiveSnapshot(snapshot) {
    if (!snapshot?.ok) return;
    if (snapshot.tradeDate) state.tradeDate = snapshot.tradeDate;
    const byKey = new Map((snapshot.indices || []).map((item) => [normalizeKey(item), item]));
    let changed = false;
    for (const key of state.selections) {
      const quote = byKey.get(key);
      if (!quote) continue;
      const definition = directoryItem(key) || quote;
      const record = ensureRecord(definition);
      record.preClose = finite(quote.preClose) ?? record.preClose;
      if (snapshot.auction === true) {
        record.liveAuctionQuote = {
          ...quote,
          sourceTime: snapshot.sourceTime,
          fetchedAt: snapshot.fetchedAt,
        };
        changed = true;
        continue;
      }
      record.liveAuctionQuote = null;
      if (snapshot.regularSession !== true || finite(quote.price) === null || finite(quote.minute) === null) continue;
      const point = {
        minute: finite(quote.minute),
        time: snapshot.sourceTime || "",
        dateTime: `${snapshot.tradeDate} ${snapshot.sourceTime || ""}`,
        tradeDate: snapshot.tradeDate,
        price: finite(quote.price),
        amount: finite(quote.amount),
        source: "tencent-live-index-quote",
        sampledAt: snapshot.fetchedAt,
      };
      record.points = uniquePoints([...(record.points || []), point], snapshot.tradeDate || record.tradeDate);
      record.tradeDate = snapshot.tradeDate || record.tradeDate;
      changed = true;
    }
    if (changed) {
      renderPicker();
      onLiveUpdate?.(selectedItems());
    }
  }

  async function loadDirectory() {
    try {
      setCatalog(await loadCatalog());
    } catch (error) {
      renderPicker();
      showNotice?.("指数选择目录暂时不可用，已保留当前八个指数。", "warning");
    }
  }

  addButton?.addEventListener("click", () => togglePicker());
  closeButton?.addEventListener("click", () => togglePicker(false));
  pickerList?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-index-option]");
    if (!button || button.disabled) return;
    const key = button.dataset.indexOption;
    if (state.selections.includes(key)) remove(key);
    else add(key);
  });
  searchInput?.addEventListener("input", renderPicker);
  filterControls?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-index-filter]");
    if (!button) return;
    state.filter = button.dataset.indexFilter || "all";
    renderPicker();
  });
  picker?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") togglePicker(false);
  });

  save();
  renderPicker();
  loadDirectory();

  return {
    applyLiveSnapshot,
    getSelectedItems: selectedItems,
    loadSelectedTimelines,
    remove,
    setBaseIndices,
    togglePicker,
  };
}

export {
  DEFAULT_INDEX_KEYS,
  MAX_SELECTED_INDICES,
  STORAGE_KEY,
  createIndexWorkspace,
};
