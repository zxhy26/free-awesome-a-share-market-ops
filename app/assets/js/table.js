import {finiteNumber, formatNumber, signed, valueClass} from "./analysis.js";
import {logTechnicalError, openTdxStock} from "./api.js?v=20260719-2";

const SORT_COLUMNS = [
  ["changePct", "涨跌幅"],
  ["amountYi", "成交额"],
  ["sealAmountYi", "封单额"],
  ["turnoverRate", "换手率"],
  ["streak", "连板数"],
  ["firstLimitTime", "首次涨停"],
  ["lastLimitTime", "最后涨停"],
  ["openCount", "开板次数"],
];

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = String(text);
  return node;
}

export function marketBoard(row) {
  const code = String(row.code || "");
  if (/^30/.test(code)) return "创业板";
  if (/^68/.test(code)) return "科创板";
  if (/^(?:8|4)/.test(code)) return "北交所";
  return "主板";
}

export function limitType(row) {
  if (/ST/i.test(String(row.name || ""))) return "5厘米";
  return ["创业板", "科创板"].includes(marketBoard(row)) ? "20厘米" : "10厘米";
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function option(value, label = value) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}

function selectControl(label, name, values) {
  const select = document.createElement("select");
  select.name = name;
  select.setAttribute("aria-label", label);
  values.forEach(([value, text]) => select.append(option(value, text)));
  return select;
}

function normalizeTime(value) {
  const text = String(value || "").replace(/\D/g, "");
  return text ? Number(text) : -1;
}

function sectorLabel(row) {
  const value = String(row?.sector || "").trim();
  return value && value !== "--" ? value : "未分类";
}

export function buildSectorCounts(rows) {
  const counts = new Map();
  (rows || []).forEach((row) => {
    const sector = sectorLabel(row);
    counts.set(sector, (counts.get(sector) || 0) + 1);
  });
  return counts;
}

function sortableValue(row, key, sectorCounts) {
  if (key === "sectorGroup") return sectorCounts.get(sectorLabel(row)) || finiteNumber(row.sectorPeerCount) || 0;
  if (key === "firstLimitTime" || key === "lastLimitTime") return normalizeTime(row[key]);
  const number = finiteNumber(row[key]);
  return number === null ? -Infinity : number;
}

export function filterAndSortStockRows(sourceRows, filterState, sectorCounts = null) {
  const state = filterState || {};
  const counts = sectorCounts || buildSectorCounts(sourceRows);
  const query = String(state.search || "").trim().toLowerCase();
  return (sourceRows || []).filter((row) => {
    const searchable = [row.code, row.name, row.sector, ...(row.concepts || [])].join(" ").toLowerCase();
    const streakValue = finiteNumber(row.streak) || 1;
    if (query && !searchable.includes(query)) return false;
    if (state.board && state.board !== "all" && marketBoard(row) !== state.board) return false;
    if (state.st === "st" && !/ST/i.test(String(row.name || ""))) return false;
    if (state.st === "non-st" && /ST/i.test(String(row.name || ""))) return false;
    if (state.streak === "1" && streakValue !== 1) return false;
    if (state.streak === "2" && streakValue !== 2) return false;
    if (state.streak === "3" && streakValue < 3) return false;
    if (state.sector && state.sector !== "all" && row.sector !== state.sector) return false;
    if (state.concept && state.concept !== "all" && !(row.concepts || []).includes(state.concept)) return false;
    if (state.opened === "yes" && !(finiteNumber(row.openCount) > 0)) return false;
    if (state.opened === "no" && finiteNumber(row.openCount) > 0) return false;
    if (state.limitType && state.limitType !== "all" && limitType(row) !== state.limitType) return false;
    return true;
  }).sort((a, b) => {
    const key = state.sort?.key || "sectorGroup";
    if (key === "sectorGroup") {
      const aMissing = sectorLabel(a) === "未分类";
      const bMissing = sectorLabel(b) === "未分类";
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
    }
    const aValue = sortableValue(a, key, counts);
    const bValue = sortableValue(b, key, counts);
    const direction = state.sort?.direction === "asc" ? 1 : -1;
    if (aValue !== bValue) return (aValue > bValue ? 1 : -1) * direction;
    const sectorCompare = sectorLabel(a).localeCompare(sectorLabel(b), "zh-CN", {numeric: true, sensitivity: "base"});
    const codeCompare = String(a.code || "").localeCompare(String(b.code || ""), "zh-CN", {numeric: true, sensitivity: "base"});
    return sectorCompare || codeCompare || String(a.name || "").localeCompare(String(b.name || ""), "zh-CN");
  });
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildStockCsv(rows) {
  const sectorCounts = buildSectorCounts(rows);
  const header = ["代码", "名称", "市场", "行业", "同板块数量", "概念", "价格", "涨跌幅", "成交额(亿)", "封单额(亿)", "换手率", "连板数", "首次涨停", "最后涨停", "开板次数"];
  const body = rows.map((row) => [row.code, row.name, marketBoard(row), row.sector, sectorCounts.get(sectorLabel(row)) || 0, (row.concepts || []).join("、"), row.price, row.changePct, row.amountYi, row.sealAmountYi, row.turnoverRate, row.streak, row.firstLimitTime, row.lastLimitTime, row.openCount].map(csvCell).join(","));
  return `\ufeff${[header.map(csvCell).join(","), ...body].join("\r\n")}`;
}

function exportCsv(filename, rows) {
  const blob = new Blob([buildStockCsv(rows)], {type: "text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function numericCell(value, formatter = (number) => formatNumber(number, 2), className = "") {
  const cell = element("td", `numeric ${className}`.trim(), formatter(finiteNumber(value)));
  return cell;
}

function buildTableHeader(sortState) {
  const head = document.createElement("thead");
  const row = document.createElement("tr");
  const columns = [["name", "股票"], ["board", "市场"], ["sectorGroup", "行业（同板块数）"], ["concepts", "概念"], ["price", "现价"], ...SORT_COLUMNS, ["tdx", "日K"]];
  const sortableKeys = new Set(["sectorGroup", ...SORT_COLUMNS.map(([column]) => column)]);
  columns.forEach(([key, label], index) => {
    const th = element("th", index === 0 ? "sticky-name" : ["price", ...SORT_COLUMNS.map(([column]) => column)].includes(key) ? "numeric" : "");
    if (sortableKeys.has(key)) {
      const button = element("button", "", label);
      button.type = "button";
      button.dataset.sortKey = key;
      button.append(element("span", "sort-arrow", sortState.key === key ? (sortState.direction === "desc" ? "▼" : "▲") : "↕"));
      th.append(button);
    } else th.textContent = label;
    row.append(th);
  });
  head.append(row);
  return head;
}

function buildRow(row, sectorCounts) {
  const tr = document.createElement("tr");
  const nameCell = element("td", "sticky-name stock-name-cell");
  nameCell.append(element("strong", "", row.name || "--"), element("small", "", row.code || "--"));
  const sectorCell = element("td", "sector-group-cell");
  sectorCell.append(
    element("strong", "", sectorLabel(row)),
    element("small", "", `同板块 ${sectorCounts.get(sectorLabel(row)) || 0} 只`),
  );
  tr.append(nameCell, element("td", "", marketBoard(row)), sectorCell);
  const conceptCell = element("td", "concept-cell");
  const concepts = (row.concepts || []).join("、") || "--";
  const conceptText = element("span", "concept-text", concepts);
  conceptText.title = concepts;
  conceptCell.append(conceptText);
  if (concepts.length > 24) {
    const expand = element("button", "expand-button", "展开");
    expand.type = "button";
    expand.dataset.expandConcept = "true";
    conceptCell.append(expand);
  }
  tr.append(conceptCell);
  tr.append(numericCell(row.price));
  tr.append(numericCell(row.changePct, (value) => signed(value, 2, "%"), valueClass(row.changePct)));
  tr.append(numericCell(row.amountYi, (value) => value === null ? "暂无数据" : `${value.toFixed(2)}亿`));
  tr.append(numericCell(row.sealAmountYi, (value) => value === null ? "暂无数据" : `${value.toFixed(2)}亿`));
  tr.append(numericCell(row.turnoverRate, (value) => value === null ? "暂无数据" : `${value.toFixed(2)}%`));
  tr.append(numericCell(row.streak, (value) => value === null ? "暂无数据" : `${value}板`));
  tr.append(element("td", "numeric", row.firstLimitTime || "--"));
  tr.append(element("td", "numeric", row.lastLimitTime || "--"));
  tr.append(numericCell(row.openCount, (value) => value === null ? "暂无数据" : String(value)));
  const action = element("td", "numeric");
  const button = element("button", "k-button", "日K");
  button.type = "button";
  button.dataset.stockOpen = "true";
  button.dataset.stockCode = row.code || "";
  button.dataset.stockMarket = row.market ?? "";
  button.dataset.stockName = row.name || "";
  action.append(button);
  tr.append(action);
  return tr;
}

export function createStockTable(container, options) {
  const sourceRows = Array.isArray(options.rows) ? options.rows : [];
  const sectorCounts = buildSectorCounts(sourceRows);
  const state = {
    search: "", board: "all", st: "all", streak: "all", sector: "all", concept: "all", opened: "all", limitType: "all",
    sort: {key: "sectorGroup", direction: "desc"}, rows: [],
  };
  const filterBar = element("section", "filter-bar");
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "搜索代码、名称、行业或概念";
  search.setAttribute("aria-label", "搜索股票");
  const board = selectControl("市场", "board", [["all", "全部市场"], ["主板", "主板"], ["创业板", "创业板"], ["科创板", "科创板"], ["北交所", "北交所"]]);
  const st = selectControl("ST状态", "st", [["all", "全部ST状态"], ["non-st", "非ST"], ["st", "ST"]]);
  const streak = selectControl("连板", "streak", [["all", "全部连板"], ["1", "首板"], ["2", "二板"], ["3", "三板及以上"]]);
  const sector = selectControl("行业", "sector", [["all", "全部行业"], ...unique(sourceRows.map((row) => row.sector)).map((value) => [value, value])]);
  const conceptValues = unique(sourceRows.flatMap((row) => row.concepts || []));
  const concept = selectControl("概念", "concept", [["all", "全部概念"], ...conceptValues.map((value) => [value, value])]);
  const opened = selectControl("开板", "opened", [["all", "全部开板状态"], ["yes", "有开板"], ["no", "未开板"]]);
  const limit = selectControl("涨跌停制度", "limitType", [["all", "全部涨跌幅制度"], ["5厘米", "5厘米"], ["10厘米", "10厘米"], ["20厘米", "20厘米"]]);
  const exportButton = element("button", "button", "导出CSV");
  exportButton.type = "button";
  filterBar.append(search, board, st, streak, sector, concept, opened, limit, exportButton);
  const resultLine = element("div", "result-line");
  const resultCount = element("strong", "", "0 条");
  const dataNote = element("span", "", options.reportedCount !== sourceRows.length ? `统计共 ${options.reportedCount} 只，当前可展示 ${sourceRows.length} 只；默认按同板块数量降序。` : `共 ${sourceRows.length} 只，默认按同板块数量降序。`);
  resultLine.append(resultCount, dataNote);
  const scroll = element("div", "table-scroll");
  const table = element("table", "data-table");
  const body = document.createElement("tbody");
  table.append(buildTableHeader(state.sort), body);
  scroll.append(table);
  container.replaceChildren(filterBar, resultLine, scroll);

  function filteredRows() {
    return filterAndSortStockRows(sourceRows, state, sectorCounts);
  }

  function render() {
    state.rows = filteredRows();
    resultCount.textContent = `${state.rows.length} 条`;
    table.replaceChild(buildTableHeader(state.sort), table.tHead);
    body.replaceChildren(...state.rows.map((row) => buildRow(row, sectorCounts)));
    if (!state.rows.length) {
      const row = document.createElement("tr");
      const cell = element("td", "empty-state", "当前筛选条件没有结果。调整筛选后会即时更新。");
      cell.colSpan = 14;
      row.append(cell);
      body.append(row);
    }
  }

  search.addEventListener("input", () => { state.search = search.value; render(); });
  [board, st, streak, sector, concept, opened, limit].forEach((control) => control.addEventListener("change", () => { state[control.name] = control.value; render(); }));
  table.addEventListener("click", async (event) => {
    const sortButton = event.target.closest("button[data-sort-key]");
    if (sortButton) {
      const key = sortButton.dataset.sortKey;
      state.sort.direction = state.sort.key === key && state.sort.direction === "desc" ? "asc" : "desc";
      state.sort.key = key;
      render();
      return;
    }
    const expandButton = event.target.closest("button[data-expand-concept]");
    if (expandButton) {
      const text = expandButton.parentElement.querySelector(".concept-text");
      text.classList.toggle("expanded");
      expandButton.textContent = text.classList.contains("expanded") ? "收起" : "展开";
      return;
    }
    const tdxButton = event.target.closest("button[data-stock-open]");
    if (!tdxButton) return;
    const oldText = tdxButton.textContent;
    tdxButton.disabled = true;
    tdxButton.textContent = "打开中";
    try {
      await openTdxStock({code: tdxButton.dataset.stockCode, market: tdxButton.dataset.stockMarket, name: tdxButton.dataset.stockName});
      tdxButton.textContent = "已打开";
    } catch (error) {
      tdxButton.textContent = "未打开";
      tdxButton.title = error.message;
    logTechnicalError(error, "本机股票软件日K");
    } finally {
      setTimeout(() => { tdxButton.disabled = false; tdxButton.textContent = oldText; }, 1600);
    }
  });
  exportButton.addEventListener("click", () => exportCsv(`${options.title}_${options.tradeDate || "最新"}.csv`, state.rows));
  render();
  return {render, getRows: () => state.rows};
}
