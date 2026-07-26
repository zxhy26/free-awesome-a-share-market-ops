import {loadHistoryDate, loadHistoryDates, logTechnicalError} from "./api.js?v=20260719-2";
import {clampMarketMinute, interpolateRealSamples, marketMinuteToTime} from "./market-session.js?v=20260719-2";
import {initializeTheme} from "./theme.js?v=20260719-2";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function node(tag, className = "", text = "") {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== "") item.textContent = String(text);
  return item;
}

function parseDate(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function isoDate(date) {
  return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")].join("-");
}

function shiftDate(value, days) {
  const date = parseDate(value);
  if (!date) return value;
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function weekStart(value) {
  const date = parseDate(value);
  if (!date) return value;
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - weekday + 1);
  return isoDate(date);
}

function weekdayLabel(value) {
  const date = parseDate(value);
  return date ? WEEKDAYS[date.getUTCDay()] : "交易日";
}

function shortDate(value) {
  return String(value || "").slice(5);
}

function groupHistoryWeeks(items) {
  const groups = new Map();
  (items || []).forEach((item) => {
    if (!parseDate(item.date)) return;
    const start = weekStart(item.date);
    if (!groups.has(start)) groups.set(start, {start, end: shiftDate(start, 4), items: []});
    groups.get(start).items.push(item);
  });
  return [...groups.values()]
    .map((week) => ({...week, items: week.items.sort((a, b) => a.date.localeCompare(b.date))}))
    .sort((a, b) => b.start.localeCompare(a.start));
}

function weekOptionText(week) {
  return `${week.start} 至 ${shortDate(week.end)} · ${week.items.length}个交易日`;
}

function shell() {
  const wrapper = node("div", "detail-shell upgrade-shell history-shell");
  const header = node("header", "detail-header");
  const title = node("div");
  title.append(node("h1", "", "历史周回放"), node("p", "", "按交易周连续回放指数、二级行业与概念资金，跨日自动衔接。"));
  const actions = node("nav", "detail-actions");
  const back = node("a", "button", "返回首页"); back.href = "../index.html";
  const health = node("a", "button", "数据状态"); health.href = "data-health.html";
  const theme = node("fieldset", "theme-segment"); theme.setAttribute("aria-label", "主题模式");
  [["system", "跟随"], ["light", "浅色"], ["dark", "深色"]].forEach(([value, text]) => {
    const button = node("button", "", text); button.type = "button"; button.dataset.themeChoice = value; theme.append(button);
  });
  actions.append(back, health, theme); header.append(title, actions);

  const notice = node("div", "notice-bar"); notice.hidden = true;
  const controls = node("section", "history-controls");
  const weekSelect = document.createElement("select"); weekSelect.className = "history-week-select"; weekSelect.setAttribute("aria-label", "选择回放周");
  const play = node("button", "icon-button", "▶"); play.type = "button"; play.title = "播放本周分时"; play.setAttribute("aria-label", "播放本周分时");
  const speed = document.createElement("select"); speed.setAttribute("aria-label", "回放速度");
  [[1, "1倍速"], [5, "5倍速"], [10, "10倍速"]].forEach(([value, text]) => {
    const option = node("option", "", text); option.value = value; if (value === 5) option.selected = true; speed.append(option);
  });
  const weekStatus = node("span", "history-week-status", "--个交易日");
  const clock = node("strong", "history-clock", "---- -- --:--:--");
  controls.append(node("label", "", "回放周"), weekSelect, play, speed, weekStatus, clock);

  const timelineWrap = node("section", "history-timeline");
  const timelineStart = node("span", "history-timeline-edge", "周一 --:--");
  const timeline = document.createElement("input"); timeline.type = "range"; timeline.min = "0"; timeline.max = "1"; timeline.step = "0.001"; timeline.value = "0"; timeline.setAttribute("aria-label", "本周连续回放时间轴");
  const timelineEnd = node("span", "history-timeline-edge history-timeline-end", "周五 --:--");
  const dayTabs = node("div", "history-week-days"); dayTabs.setAttribute("aria-label", "本周交易日");
  timelineWrap.append(timelineStart, timeline, timelineEnd, dayTabs);

  const content = node("section", "upgrade-content");
  wrapper.append(header, notice, controls, timelineWrap, content);
  return {wrapper, notice, weekSelect, play, speed, weekStatus, clock, timeline, timelineStart, timelineEnd, dayTabs, content};
}

function indexPoints(bundle) {
  const items = bundle.indices?.items || [];
  return items.find((item) => item.name === "上证指数") || items.find((item) => item.session !== "us") || bundle.market?.index || {};
}

function pointRange(points) {
  let first = Infinity;
  let last = -Infinity;
  (points || []).forEach((point) => {
    const minute = Number(point.minute);
    if (!Number.isFinite(minute)) return;
    first = Math.min(first, minute);
    last = Math.max(last, minute);
  });
  return Number.isFinite(first) && Number.isFinite(last) ? {first, last} : null;
}

function sectorRange(group) {
  let first = Infinity;
  let last = -Infinity;
  (group?.rows || []).forEach((row) => {
    const range = pointRange(row.points);
    if (!range) return;
    first = Math.min(first, range.first);
    last = Math.max(last, range.last);
  });
  return Number.isFinite(first) && Number.isFinite(last) ? {first, last} : null;
}

function completeMinuteRange(bundle) {
  const ranges = [
    pointRange(indexPoints(bundle).points),
    sectorRange(bundle.sectors?.industry),
    sectorRange(bundle.sectors?.concept),
  ].filter(Boolean);
  if (!ranges.length) return {first: 0, last: 240};
  const first = Math.max(0, ...ranges.map((range) => range.first));
  const last = Math.min(240, ...ranges.map((range) => range.last));
  return {first, last: Math.max(first, last)};
}

function buildWeekSegments(entries) {
  let cursor = 0;
  return entries.map((entry, index) => {
    const range = completeMinuteRange(entry.bundle);
    const segment = {
      index,
      date: entry.item.date,
      bundle: entry.bundle,
      firstMinute: range.first,
      lastMinute: range.last,
      start: cursor,
      end: cursor + Math.max(0, range.last - range.first),
    };
    cursor = segment.end + 1;
    return segment;
  });
}

function locateWeekPosition(segments, rawPosition) {
  const position = Number(rawPosition) || 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (position <= segment.end || index === segments.length - 1) {
      const minute = segment.firstMinute + Math.max(0, Math.min(segment.end - segment.start, position - segment.start));
      return {segment, minute};
    }
    const next = segments[index + 1];
    if (next && position < next.start) return {segment: next, minute: next.firstMinute};
  }
  return null;
}

function timelineEdge(segment, minute) {
  return `${weekdayLabel(segment.date)} ${shortDate(segment.date)} ${marketMinuteToTime(minute)}`;
}

function indexChart(index, minute) {
  const section = node("section", "replay-index");
  const points = (index.points || []).filter((point) => Number(point.minute) <= minute && Number.isFinite(Number(point.price)));
  const latest = points.at(-1);
  const preClose = Number(index.preClose) || Number(points[0]?.price) || 1;
  const change = latest ? (Number(latest.price) / preClose - 1) * 100 : null;
  const heading = node("header", "upgrade-heading");
  heading.append(node("h2", "", index.name || "上证指数"), node("p", change === null ? "暂无样本" : `${Number(latest.price).toFixed(2)}  ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 760 500"); svg.setAttribute("role", "img");
  const domain = (index.points || []).map((point) => Number(point.price)).filter(Number.isFinite);
  const min = Math.min(preClose, ...domain); const max = Math.max(preClose, ...domain); const spread = Math.max(max - min, preClose * .002);
  const x = (value) => 24 + clampMarketMinute(value) / 240 * 716;
  const y = (value) => 30 + (max - Number(value)) / spread * 420;
  const baseline = document.createElementNS(svg.namespaceURI, "line"); baseline.setAttribute("x1", "24"); baseline.setAttribute("x2", "740"); baseline.setAttribute("y1", y(preClose)); baseline.setAttribute("y2", y(preClose)); baseline.setAttribute("class", "replay-baseline");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", points.map((point, indexValue) => `${indexValue ? "L" : "M"}${x(point.minute).toFixed(2)},${y(point.price).toFixed(2)}`).join(" "));
  path.setAttribute("class", change !== null && change < 0 ? "replay-line loss" : "replay-line gain");
  svg.append(baseline, path); section.append(heading, svg); return section;
}

function flowRows(group, minute) {
  return (group?.rows || []).map((row) => ({...row, value: interpolateRealSamples(row.points || [], minute, "amount")})).filter((row) => Number.isFinite(row.value));
}

function flowColumn(title, rows, direction) {
  const block = node("section", "replay-flow-column");
  block.append(node("h3", direction > 0 ? "gain" : "loss", title));
  const selected = rows.filter((row) => Math.sign(row.value) === direction).sort((a, b) => direction > 0 ? b.value - a.value : a.value - b.value).slice(0, 10);
  const maximum = Math.max(1, ...selected.map((row) => Math.abs(row.value)));
  selected.forEach((row) => {
    const item = node("div", "replay-flow-row");
    const label = node("span", "", row.tdxName || row.name || "--");
    const track = node("span", "replay-flow-track"); const fill = node("span", direction > 0 ? "gain" : "loss"); fill.style.width = `${Math.max(2, Math.abs(row.value) / maximum * 100)}%`; track.append(fill);
    const value = node("strong", direction > 0 ? "gain" : "loss", `${row.value > 0 ? "+" : ""}${row.value.toFixed(1)}亿`);
    item.append(label, track, value); block.append(item);
  });
  if (!selected.length) block.append(node("div", "empty-state", "该时点暂无真实样本。"));
  return block;
}

function flowPanel(title, group, minute) {
  const section = node("section", "replay-flow-panel");
  const rows = flowRows(group, minute);
  const heading = node("header", "upgrade-heading"); heading.append(node("h2", "", title), node("p", "", `${marketMinuteToTime(minute)} 资金前十`));
  const grid = node("div", "replay-flow-grid"); grid.append(flowColumn("净流入", rows, 1), flowColumn("净流出", rows, -1));
  section.append(heading, grid); return section;
}

function render(view, segment, minute, week) {
  const bundle = segment.bundle;
  const data = bundle.analysis || {};
  const regime = data.marketRegime || data.diagnosis || {};
  const summary = node("section", "replay-summary");
  summary.append(
    node("strong", "", `${segment.date} · 本周第 ${segment.index + 1}/${week.items.length} 个交易日 · ${regime.state || regime.tone || "市场判断待补充"}`),
    node("p", "", regime.text || data.diagnosis?.summary || "历史归档已载入。"),
  );
  const grid = node("div", "replay-grid");
  grid.append(indexChart(indexPoints(bundle), minute), flowPanel("二级行业资金", bundle.sectors?.industry, minute), flowPanel("概念板块资金", bundle.sectors?.concept, minute));
  view.content.replaceChildren(summary, grid);
}

async function initialize() {
  const root = document.querySelector("#historyApp");
  const view = shell();
  root.replaceChildren(view.wrapper);
  initializeTheme();

  let segments = [];
  let currentWeek = null;
  let playing = false;
  let animationFrame = 0;
  let previousFrame = 0;
  let activeDayIndex = -1;
  let loadGeneration = 0;

  const historyIndex = await loadHistoryDates().catch((error) => {
    view.notice.hidden = false;
    view.notice.className = "notice-bar error";
    view.notice.textContent = error.message;
    logTechnicalError(error, "历史索引");
    return {dates: []};
  });
  const weeks = groupHistoryWeeks(historyIndex.dates || []);
  weeks.forEach((week) => {
    const option = node("option", "", weekOptionText(week));
    option.value = week.start;
    view.weekSelect.append(option);
  });

  function stopPlayback() {
    playing = false;
    cancelAnimationFrame(animationFrame);
    view.play.textContent = "▶";
    view.play.setAttribute("aria-label", "播放本周分时");
    view.play.title = "播放本周分时";
  }

  function updateActiveDay(index) {
    if (index === activeDayIndex) return;
    activeDayIndex = index;
    [...view.dayTabs.children].forEach((button, buttonIndex) => button.setAttribute("aria-pressed", String(buttonIndex === index)));
  }

  function update() {
    const located = locateWeekPosition(segments, view.timeline.value);
    if (!located || !currentWeek) return;
    const {segment, minute} = located;
    view.clock.textContent = `${segment.date} ${marketMinuteToTime(minute, true)}`;
    updateActiveDay(segment.index);
    render(view, segment, minute, currentWeek);
  }

  function renderDayTabs() {
    view.dayTabs.replaceChildren();
    view.dayTabs.style.setProperty("--history-day-count", String(Math.max(1, segments.length)));
    segments.forEach((segment) => {
      const button = node("button", "history-week-day");
      button.type = "button";
      button.setAttribute("aria-pressed", "false");
      button.title = `跳转到 ${segment.date}`;
      button.append(node("strong", "", weekdayLabel(segment.date)), node("span", "", shortDate(segment.date)));
      button.addEventListener("click", () => {
        view.timeline.value = String(segment.start);
        update();
      });
      view.dayTabs.append(button);
    });
    activeDayIndex = -1;
  }

  async function loadWeek() {
    stopPlayback();
    const generation = ++loadGeneration;
    const week = weeks.find((item) => item.start === view.weekSelect.value);
    if (!week) return;
    currentWeek = week;
    segments = [];
    activeDayIndex = -1;
    view.play.disabled = true;
    view.weekStatus.textContent = `读取 ${week.items.length} 个交易日`;
    view.dayTabs.replaceChildren();
    view.content.replaceChildren(node("div", "loading-state", `正在读取 ${week.start} 当周归档…`));

    const results = await Promise.allSettled(week.items.map(async (item) => ({item, bundle: await loadHistoryDate(item.date)})));
    if (generation !== loadGeneration) return;
    const loaded = results.filter((result) => result.status === "fulfilled").map((result) => result.value).sort((a, b) => a.item.date.localeCompare(b.item.date));
    const failed = results.length - loaded.length;
    if (!loaded.length) {
      view.content.replaceChildren(node("div", "error-state", "本周归档读取失败，请同步市场后重试。"));
      view.weekStatus.textContent = "读取失败";
      results.filter((result) => result.status === "rejected").forEach((result) => logTechnicalError(result.reason, "历史周回放"));
      return;
    }

    segments = buildWeekSegments(loaded);
    currentWeek = {...week, items: loaded.map((entry) => entry.item)};
    const lastSegment = segments.at(-1);
    view.timeline.min = "0";
    view.timeline.max = String(Math.max(1, lastSegment.end));
    view.timeline.value = "0";
    view.timelineStart.textContent = timelineEdge(segments[0], segments[0].firstMinute);
    view.timelineEnd.textContent = timelineEdge(lastSegment, lastSegment.lastMinute);
    view.weekStatus.textContent = `${segments.length} 个交易日连续回放`;
    view.play.disabled = false;
    renderDayTabs();
    if (failed) {
      view.notice.hidden = false;
      view.notice.className = "notice-bar warning";
      view.notice.textContent = `本周 ${failed} 个归档读取失败，已连续回放其余 ${segments.length} 个交易日。`;
    } else {
      view.notice.hidden = true;
    }
    update();
  }

  view.timeline.addEventListener("input", update);
  view.weekSelect.addEventListener("change", loadWeek);
  view.play.addEventListener("click", () => {
    if (!segments.length) return;
    const maximum = Number(view.timeline.max) || 1;
    if (!playing && Number(view.timeline.value) >= maximum) view.timeline.value = "0";
    playing = !playing;
    view.play.textContent = playing ? "Ⅱ" : "▶";
    view.play.setAttribute("aria-label", playing ? "暂停本周回放" : "播放本周分时");
    view.play.title = playing ? "暂停本周回放" : "播放本周分时";
    previousFrame = performance.now();
    if (playing) animationFrame = requestAnimationFrame(step);
  });

  function step(now) {
    if (!playing) return;
    const elapsed = Math.max(0, now - previousFrame);
    previousFrame = now;
    const maximum = Number(view.timeline.max) || 1;
    const next = Number(view.timeline.value) + elapsed / 1000 * 4 * Number(view.speed.value || 1);
    view.timeline.value = String(Math.min(maximum, next));
    update();
    if (next >= maximum) {
      stopPlayback();
      return;
    }
    animationFrame = requestAnimationFrame(step);
  }

  if (weeks.length) await loadWeek();
  else {
    view.play.disabled = true;
    view.weekSelect.disabled = true;
    view.weekStatus.textContent = "暂无归档";
    view.content.replaceChildren(node("div", "empty-state", "尚无可回放交易周。完成一次同步后会自动形成归档。"));
  }
}

initialize();
