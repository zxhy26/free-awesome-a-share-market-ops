const ZOOM_STORAGE_KEY = "a-share-review:page-zoom:v1";
const FONT_STORAGE_KEY = "a-share-review:font-size:v1";
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
  const state = {
    zoom: clampZoom(readNumber(storage, ZOOM_STORAGE_KEY, 100)),
    fontChoice: readFontChoice(storage),
  };

  function persist() {
    try {
      storage?.setItem(ZOOM_STORAGE_KEY, String(state.zoom));
      storage?.setItem(FONT_STORAGE_KEY, state.fontChoice);
    } catch (_) {
    }
  }

  function render() {
    const zoomScale = state.zoom / 100;
    const font = FONT_SCALES[state.fontChoice];
    document.documentElement.style.setProperty("--app-font-unit", `${font.scale}px`);
    document.documentElement.dataset.fontSize = state.fontChoice;
    document.documentElement.dataset.pageZoom = String(state.zoom);
    viewport.style.zoom = String(zoomScale);
    viewport.style.width = "100%";
    viewport.style.minHeight = "100vh";
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
    persist();
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent("a-share-display-change", {
        detail: {zoom: state.zoom, fontChoice: state.fontChoice, fontScale: font.scale},
      }));
      onChange?.({...state, fontScale: font.scale});
    });
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

  render();
  return {
    getState: () => ({...state}),
    reset: () => {
      state.zoom = 100;
      state.fontChoice = "standard";
      render();
    },
    setZoom,
  };
}

export {
  FONT_SCALES,
  FONT_STORAGE_KEY,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STORAGE_KEY,
  createDisplaySettings,
};
