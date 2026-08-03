const ZOOM_STORAGE_KEY = "a-share-review:page-zoom:v1";
const FONT_STORAGE_KEY = "a-share-review:font-size:v1";
const DISPLAY_SYNC_CHANNEL = "a-share-review:display-preferences:v1";
const MIN_ZOOM = 70;
const MAX_ZOOM = 130;
const ZOOM_STEP = 5;
const FONT_SCALES = Object.freeze({
  small: {label: "小", percent: 90, scale: .9},
  standard: {label: "标准", percent: 100, scale: 1},
  large: {label: "大", percent: 110, scale: 1.1},
  xlarge: {label: "特大", percent: 120, scale: 1.2},
});

function readNumber(storage, key, fallback) {
  const value = Number(storage?.getItem(key));
  return Number.isFinite(value) ? value : fallback;
}

function clampZoom(value) {
  const bounded = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(value) || 100));
  return Math.round(bounded / ZOOM_STEP) * ZOOM_STEP;
}

function readFontChoice(storage) {
  const choice = String(storage?.getItem(FONT_STORAGE_KEY) || "standard");
  return FONT_SCALES[choice] ? choice : "standard";
}

function normalizeDisplayState(value = {}) {
  const fontChoice = String(value.fontChoice || value.fontSize || "standard");
  return {
    zoom: clampZoom(value.zoom),
    fontChoice: FONT_SCALES[fontChoice] ? fontChoice : "standard",
  };
}

function readDisplayState(storage = globalThis.localStorage) {
  return normalizeDisplayState({
    zoom: readNumber(storage, ZOOM_STORAGE_KEY, 100),
    fontChoice: readFontChoice(storage),
  });
}

function applyDisplayState(value, options = {}) {
  const state = normalizeDisplayState(value);
  const root = options.root || document.documentElement;
  const viewport = options.viewport || document.body;
  const font = FONT_SCALES[state.fontChoice];
  root.style.setProperty("--app-font-unit", `${font.scale}px`);
  root.dataset.fontSize = state.fontChoice;
  root.dataset.pageZoom = String(state.zoom);
  if (viewport) {
    viewport.style.zoom = String(state.zoom / 100);
    if (options.constrainViewport !== false) {
      viewport.style.width = "100%";
      viewport.style.minHeight = "100vh";
    }
  }
  return {...state, fontScale: font.scale};
}

function openDisplayChannel(onMessage) {
  if (typeof globalThis.BroadcastChannel !== "function") return null;
  try {
    const channel = new BroadcastChannel(DISPLAY_SYNC_CHANNEL);
    channel.addEventListener("message", (event) => onMessage(event.data));
    return channel;
  } catch (_) {
    return null;
  }
}

function emitDisplayChange(detail, onChange) {
  requestAnimationFrame(() => {
    window.dispatchEvent(new CustomEvent("a-share-display-change", {detail}));
    onChange?.(detail);
  });
}

function createPageDisplaySync(options = {}) {
  const storage = options.storage || globalThis.localStorage;
  const viewport = options.viewport || document.body;
  let state = readDisplayState(storage);

  function render(value = state) {
    state = normalizeDisplayState(value);
    const detail = applyDisplayState(state, {
      viewport,
      constrainViewport: options.constrainViewport ?? false,
    });
    emitDisplayChange(detail, options.onChange);
  }

  function accept(value) {
    const next = normalizeDisplayState(value);
    if (next.zoom === state.zoom && next.fontChoice === state.fontChoice) return;
    render(next);
  }

  const channel = openDisplayChannel(accept);
  const handleStorage = (event) => {
    if (event.key !== ZOOM_STORAGE_KEY && event.key !== FONT_STORAGE_KEY) return;
    accept(readDisplayState(storage));
  };
  window.addEventListener("storage", handleStorage);
  render();
  document.documentElement.dataset.displaySync = "ready";

  return {
    getState: () => ({...state}),
    refresh: () => accept(readDisplayState(storage)),
    destroy: () => {
      channel?.close();
      window.removeEventListener("storage", handleStorage);
    },
  };
}

function createDisplaySettings(options) {
  const {
    viewport,
    zoomOut,
    zoomIn,
    zoomRange,
    zoomValue,
    fontButton,
    fontMenu,
    onChange,
  } = options;
  const storage = options.storage || globalThis.localStorage;
  const state = readDisplayState(storage);
  let channel = null;

  function persist() {
    try {
      storage?.setItem(ZOOM_STORAGE_KEY, String(state.zoom));
      storage?.setItem(FONT_STORAGE_KEY, state.fontChoice);
    } catch (_) {
    }
  }

  function render(options = {}) {
    const font = FONT_SCALES[state.fontChoice];
    const detail = applyDisplayState(state, {viewport});
    zoomRange.value = String(state.zoom);
    zoomRange.setAttribute("aria-valuetext", `${state.zoom}%`);
    zoomValue.textContent = `${state.zoom}%`;
    zoomOut.disabled = state.zoom <= MIN_ZOOM;
    zoomIn.disabled = state.zoom >= MAX_ZOOM;
    fontButton.title = `字号：${font.label}（${font.percent}%）`;
    fontMenu.querySelectorAll("[data-font-size]").forEach((button) => {
      const selected = button.dataset.fontSize === state.fontChoice;
      button.setAttribute("aria-checked", String(selected));
      button.classList.toggle("is-selected", selected);
    });
    if (options.persist !== false) persist();
    if (options.broadcast !== false) channel?.postMessage({...state});
    emitDisplayChange(detail, onChange);
  }

  function acceptExternal(value) {
    const next = normalizeDisplayState(value);
    if (next.zoom === state.zoom && next.fontChoice === state.fontChoice) return;
    state.zoom = next.zoom;
    state.fontChoice = next.fontChoice;
    render({persist: false, broadcast: false});
  }

  function setZoom(value) {
    state.zoom = clampZoom(value);
    render();
  }

  function toggleFontMenu(force) {
    const shouldOpen = typeof force === "boolean" ? force : fontMenu.hidden;
    fontMenu.hidden = !shouldOpen;
    fontButton.setAttribute("aria-expanded", String(shouldOpen));
    if (shouldOpen) {
      fontMenu.querySelector(`[data-font-size="${state.fontChoice}"]`)?.focus();
    }
  }

  zoomOut.addEventListener("click", () => setZoom(state.zoom - ZOOM_STEP));
  zoomIn.addEventListener("click", () => setZoom(state.zoom + ZOOM_STEP));
  zoomRange.addEventListener("input", () => setZoom(zoomRange.value));
  zoomValue.addEventListener("click", () => setZoom(100));
  fontButton.addEventListener("click", () => toggleFontMenu());
  fontMenu.addEventListener("click", (event) => {
    const button = event.target.closest("[data-font-size]");
    if (!button || !FONT_SCALES[button.dataset.fontSize]) return;
    state.fontChoice = button.dataset.fontSize;
    render();
    toggleFontMenu(false);
  });
  document.addEventListener("pointerdown", (event) => {
    if (fontMenu.hidden || fontMenu.contains(event.target) || fontButton.contains(event.target)) return;
    toggleFontMenu(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") toggleFontMenu(false);
  });

  channel = openDisplayChannel(acceptExternal);
  const handleStorage = (event) => {
    if (event.key !== ZOOM_STORAGE_KEY && event.key !== FONT_STORAGE_KEY) return;
    acceptExternal(readDisplayState(storage));
  };
  window.addEventListener("storage", handleStorage);

  render();
  return {
    getState: () => ({...state}),
    reset: () => {
      state.zoom = 100;
      state.fontChoice = "standard";
      render();
    },
    setZoom,
    destroy: () => {
      channel?.close();
      window.removeEventListener("storage", handleStorage);
    },
  };
}

export {
  DISPLAY_SYNC_CHANNEL,
  FONT_SCALES,
  FONT_STORAGE_KEY,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STORAGE_KEY,
  applyDisplayState,
  createDisplaySettings,
  createPageDisplaySync,
  normalizeDisplayState,
  readDisplayState,
};
