import {buildClsIndexAnnotationEvents, createIndexCharts, updateIndexCharts, marketMinuteToTime} from "./charts.js?v=20260929-1";
import {sampleAtOrBefore} from "./workbench-runtime.js?v=20260929-1";

export function createWorkbench({storage, onSeek, onLive}) {
  const density = document.querySelector("#densitySelect");
  const annotations = document.querySelector("#annotationToggle");
  const mode = document.querySelector("#viewMode");
  const liveButton = document.querySelector("#returnLive");
  const events = document.querySelector("#watchEvents");
  const connection = document.querySelector("#connectionStatus");
  const dialog = document.querySelector("#chartInspector");
  const grid = document.querySelector("#inspectorChart");
  const readout = document.querySelector("#inspectorReadout");
  let focusKey = "";
  let focusData = null;
  let focusFeed = null;
  let focusCharts = [];
  let signature = "";
  let pointerMinute = null;
  let visibleMinute = 240;
  let focusReturn = null;
  const key = (name) => `a-share-review:${name}:v1`;
  try {
    density.value = storage.getItem(key("density")) === "compact" ? "compact" : "comfortable";
    annotations.checked = storage.getItem(key("annotations")) !== "false";
  } catch (_) { /* Storage can be disabled in a browser profile. */ }
  function applySettings() {
    document.documentElement.dataset.density = density.value;
    document.documentElement.dataset.annotations = String(annotations.checked);
  }
  applySettings();
  density.addEventListener("change", () => {
    applySettings();
    try { storage.setItem(key("density"), density.value); } catch (_) {}
  });
  annotations.addEventListener("change", () => {
    applySettings();
    try { storage.setItem(key("annotations"), String(annotations.checked)); } catch (_) {}
  });
  liveButton.addEventListener("click", onLive);
  document.querySelector("#closeInspector").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => { focusKey = ""; focusReturn?.focus(); });

  function showSample() {
    const sample = sampleAtOrBefore(focusData?.points, Math.min(pointerMinute ?? visibleMinute, visibleMinute));
    if (!sample) { readout.textContent = "该时刻无已发布的指数样本"; return; }
    const price = Number(sample.price);
    const change = focusData.preClose ? (price / focusData.preClose - 1) * 100 : null;
    readout.textContent = `${focusData.tradeDate || ""} ${marketMinuteToTime(sample.minute, true)}　${price.toFixed(2)}　${change === null ? "--" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}　成交额 ${sample.amount == null ? "--" : `${(sample.amount / 1e8).toFixed(2)}亿`}`;
    grid.style.setProperty("--crosshair-x", `${sample.minute / 240 * 100}%`);
  }
  grid.addEventListener("pointermove", (event) => {
    const svg = grid.querySelector("svg");
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    pointerMinute = Math.max(0, Math.min(240, (event.clientX - rect.left) / rect.width * 240));
    grid.classList.add("inspecting");
    showSample();
  });
  grid.addEventListener("pointerleave", () => {
    pointerMinute = null;
    grid.classList.remove("inspecting");
    showSample();
  });
  events.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-minute]");
    if (button) onSeek(Number(button.dataset.minute));
  });

  return {
    connection(ok, message) {
      connection.dataset.state = ok ? "ok" : "error";
      connection.textContent = message || (ok ? "行情服务已连接" : "连接中断 · 自动重连中");
    },
    open(index, feed) {
      focusKey = index.key || index.code;
      focusData = null;
      focusFeed = null;
      focusReturn = document.activeElement;
      pointerMinute = null;
      document.querySelector("#inspectorTitle").textContent = `${index.name} · 分时详情`;
      if (!dialog.open) dialog.showModal();
      this.update([index], feed, visibleMinute, mode.dataset.mode === "live");
    },
    update(indices, feed, minute, following) {
      visibleMinute = minute;
      mode.dataset.mode = following ? "live" : "replay";
      mode.textContent = following ? "最新行情" : `回放 ${marketMinuteToTime(minute, true)}`;
      liveButton.hidden = following;
      if (focusKey && dialog.open) {
        const index = indices.find((item) => (item.key || item.code) === focusKey);
        if (index) {
          if (index !== focusData || feed !== focusFeed) {
            focusData = index;
            focusFeed = feed;
            focusCharts = createIndexCharts(grid, [index], feed);
            grid.querySelector(".index-card-remove").hidden = true;
          }
          updateIndexCharts(focusCharts, minute);
          showSample();
        }
      }
      const index = indices.find((item) => item.name === "上证指数") || indices.find((item) => item.session !== "us");
      const items = buildClsIndexAnnotationEvents(index, feed).filter((item) => item.minute <= minute);
      const nextSignature = JSON.stringify([feed?.tradeDate, feed?.status, items]);
      if (nextSignature === signature) return;
      signature = nextSignature;
      document.querySelector("#watchEventCount").textContent = `${items.length} 条`;
      events.replaceChildren();
      if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "watch-empty";
        empty.textContent = "当前时段没有已发布的财联社板块异动记录";
        events.append(empty);
      }
      for (const item of items.slice().reverse()) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `watch-event ${item.sourceDirection === "up" ? "gain" : "loss"}`;
        button.dataset.minute = String(item.minute);
        const time = document.createElement("time");
        time.textContent = marketMinuteToTime(item.minute, true);
        const label = document.createElement("strong");
        label.textContent = item.displayLabel;
        button.title = `${item.source} · ${item.sourceTime} · 查看这一时刻`;
        button.append(time, label);
        events.append(button);
      }
    },
  };
}
