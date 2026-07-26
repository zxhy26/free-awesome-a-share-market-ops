import {loadDerivativesData, logTechnicalError, requestDerivativesRefresh} from "./api.js?v=20260725-2";
import {initializeTheme} from "./theme.js";

const EASTMONEY_ENDPOINT = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const CFFEX_MARKET_CODE = "069001009";
const FUTURES_CODES = new Set(["IF", "IH", "IC", "IM"]);
const PREFERRED_MEMBERS = [
  {name: "中信期货", code: "10058975", required: true},
  {name: "中金期货", code: "10123048", required: true},
  {name: "国泰君安期货", code: "10083138"},
  {name: "华泰期货", code: "10054000"},
  {name: "东证期货", code: "10123207"},
  {name: "海通期货", code: "10064967"},
  {name: "广发期货", code: "10067322"},
  {name: "银河期货", code: "10106342"},
  {name: "中信建投期货", code: "10098596"},
];
const PRODUCT_NAMES = {
  IF: "沪深300",
  IH: "上证50",
  IC: "中证500",
  IM: "中证1000",
};

let callbackSeed = 0;
let currentData = null;
let refreshRunning = false;

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = String(text);
  return node;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberClass(value) {
  const number = finiteNumber(value);
  if (number === null || number === 0) return "";
  return number > 0 ? "gain" : "loss";
}

function formatSignedHands(value) {
  const number = finiteNumber(value);
  if (number === null) return "--";
  return `${number > 0 ? "+" : ""}${Math.round(number).toLocaleString("zh-CN")}`;
}

function normalizeDate(value) {
  const matched = String(value || "").match(/\d{4}-\d{2}-\d{2}/);
  return matched ? matched[0] : "";
}

function stanceFromNet(value, threshold = 300) {
  const number = finiteNumber(value) || 0;
  if (number > threshold) return "偏多";
  if (number < -threshold) return "偏空";
  return "中性";
}

function stanceClass(stance) {
  if (stance === "偏多") return "gain";
  if (stance === "偏空") return "loss";
  return "warning";
}

function isStaticRuntime() {
  return location.protocol === "file:" || location.hostname === "appassets.androidplatform.net";
}

function jsonp(params, timeoutMs = 16000) {
  return new Promise((resolve, reject) => {
    const callbackName = `__aShareSeat_${Date.now()}_${callbackSeed += 1}`;
    const url = new URL(EASTMONEY_ENDPOINT);
    Object.entries({...params, callback: callbackName}).forEach(([key, value]) => url.searchParams.set(key, value));
    const script = document.createElement("script");
    const cleanup = () => {
      clearTimeout(timer);
      script.remove();
      try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("公开席位接口响应超时"));
    }, timeoutMs);
    window[callbackName] = (payload) => {
      cleanup();
      if (!payload?.result?.data?.length) {
        reject(new Error(payload?.message || "公开席位接口没有返回数据"));
        return;
      }
      resolve(payload.result.data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error("公开席位接口连接失败"));
    };
    script.src = url.toString();
    document.head.append(script);
  });
}

async function loadMemberRows(member) {
  const rows = await jsonp({
    reportName: "RPT_FUTU_DAILYPOSITION",
    columns: "ALL",
    filter: `(TRADE_MARKET_CODE="${CFFEX_MARKET_CODE}")(ORG_CODE="${member.code}")`,
    sortColumns: "TRADE_DATE,SECURITY_CODE",
    sortTypes: "-1,1",
    pageNumber: "1",
    pageSize: "120",
    source: "WEB",
    client: "WEB",
  });
  const latestDate = normalizeDate(rows[0]?.TRADE_DATE);
  return {
    ...member,
    latestDate,
    rows: rows.filter((row) => normalizeDate(row.TRADE_DATE) === latestDate && FUTURES_CODES.has(row.TRADE_CODE)),
  };
}

function aggregateRows(rows) {
  const total = {
    longPosition: 0,
    longChange: 0,
    shortPosition: 0,
    shortChange: 0,
    appearanceCount: 0,
    products: {},
  };
  rows.forEach((row) => {
    const code = row.TRADE_CODE;
    if (!total.products[code]) {
      total.products[code] = {code, shortName: PRODUCT_NAMES[code] || code, longPosition: 0, longChange: 0, shortPosition: 0, shortChange: 0};
    }
    const product = total.products[code];
    const longPosition = finiteNumber(row.LONG_POSITION) || 0;
    const longChange = finiteNumber(row.LP_CHANGE) || 0;
    const shortPosition = finiteNumber(row.SHORT_POSITION) || 0;
    const shortChange = finiteNumber(row.SP_CHANGE) || 0;
    product.longPosition += longPosition;
    product.longChange += longChange;
    product.shortPosition += shortPosition;
    product.shortChange += shortChange;
    total.longPosition += longPosition;
    total.longChange += longChange;
    total.shortPosition += shortPosition;
    total.shortChange += shortChange;
    total.appearanceCount += 1;
  });
  total.netPosition = total.longPosition - total.shortPosition;
  total.netChange = total.longChange - total.shortChange;
  total.activity = Math.abs(total.longChange) + Math.abs(total.shortChange);
  total.stance = stanceFromNet(total.netChange, 180);
  return total;
}

function productSummary(products) {
  const sorted = [...products].sort((a, b) => Math.abs(b.netChange) - Math.abs(a.netChange));
  if (!sorted.length) return "产品方向样本不足。";
  return sorted.slice(0, 2).map((item) => `${item.shortName}${item.netChange >= 0 ? "净增多" : "净增空"}${Math.abs(Math.round(item.netChange)).toLocaleString("zh-CN")}手`).join("，");
}

function memberSummary(institutions) {
  const visible = institutions.filter((item) => item.futures.appearanceCount > 0).sort((a, b) => Math.abs(b.futures.netChange) - Math.abs(a.futures.netChange));
  if (!visible.length) return "重点席位未形成可比较样本。";
  return visible.slice(0, 3).map((item) => `${item.member}${item.futures.netChange >= 0 ? "净增多" : "净增空"}${Math.abs(Math.round(item.futures.netChange)).toLocaleString("zh-CN")}手`).join("，");
}

function synthesizePublicSnapshot(bundled, settled) {
  const successful = settled.filter((item) => item.status === "fulfilled").map((item) => item.value);
  const latestDate = successful.map((item) => item.latestDate).filter(Boolean).sort().at(-1);
  if (!latestDate) throw new Error("没有取得重点席位最新交易日");
  const institutions = PREFERRED_MEMBERS.map((member) => {
    const result = successful.find((item) => item.code === member.code && item.latestDate === latestDate);
    const futures = aggregateRows(result?.rows || []);
    return {member: member.name, code: member.code, required: Boolean(member.required), futures};
  });
  const productMap = new Map();
  institutions.forEach((institution) => {
    Object.values(institution.futures.products).forEach((product) => {
      const current = productMap.get(product.code) || {...product};
      if (productMap.has(product.code)) {
        current.longPosition += product.longPosition;
        current.longChange += product.longChange;
        current.shortPosition += product.shortPosition;
        current.shortChange += product.shortChange;
      }
      current.netPosition = current.longPosition - current.shortPosition;
      current.netChange = current.longChange - current.shortChange;
      current.stance = stanceFromNet(current.netChange, 300);
      productMap.set(product.code, current);
    });
  });
  const products = [...productMap.values()].sort((a, b) => ["IF", "IH", "IC", "IM"].indexOf(a.code) - ["IF", "IH", "IC", "IM"].indexOf(b.code));
  const longChange = institutions.reduce((sum, item) => sum + item.futures.longChange, 0);
  const shortChange = institutions.reduce((sum, item) => sum + item.futures.shortChange, 0);
  const netChange = longChange - shortChange;
  const stance = stanceFromNet(netChange, 800);
  const optionSameDate = normalizeDate(bundled?.tradeDate) === latestDate;
  const optionNote = optionSameDate
    ? (bundled?.analysis?.optionTone || "期权榜单变化不直接等同于方向判断。")
    : `股指期权仍显示安装包内置的${bundled?.tradeDate || "最近有效日"}中金所官方快照。`;
  const visibleCount = institutions.filter((item) => item.futures.appearanceCount > 0).length;
  return {
    ...bundled,
    tradeDate: latestDate,
    targetTradeDate: latestDate,
    fetchedAt: new Date().toISOString(),
    stale: false,
    runtimeSource: "eastmoney-jsonp",
    institutions,
    analysis: {
      ...(bundled?.analysis || {}),
      stance,
      score: Math.max(-100, Math.min(100, Math.round(netChange / 180))),
      confidence: visibleCount >= 7 ? "中等" : "较低",
      headline: `${visibleCount}家重点期货公司代客席位：多单日变${formatSignedHands(longChange)}手，空单日变${formatSignedHands(shortChange)}手，净方向${formatSignedHands(netChange)}手。`,
      futuresLongChange: longChange,
      futuresShortChange: shortChange,
      futuresNetChange: netChange,
      futuresProducts: products,
      optionTone: optionNote,
      paragraphs: [
        `本页聚合${visibleCount}家重点期货公司在中金所股指期货合约上的代客持仓日变化。`,
        productSummary(products),
        memberSummary(institutions),
        `综合判断为${stance}。该结果仅反映公开榜单中的期货公司结算会员代客持仓，不代表中信、中金等机构自营观点；未进入可见样本不等于零持仓。`,
      ],
    },
    source: {
      ...(bundled?.source || {}),
      provider: "东方财富公开数据中心 / 中国金融期货交易所",
      disclosure: `移动独立更新使用东方财富公开JSONP整理中金所期货公司代客席位日变化；期权部分以包内中金所官方快照为准。榜单席位不是机构自营账户，不能直接视为券商自营多空单。`,
    },
  };
}

async function loadPublicSnapshot(bundled) {
  const settled = await Promise.allSettled(PREFERRED_MEMBERS.map(loadMemberRows));
  const successful = settled.filter((item) => item.status === "fulfilled").length;
  if (successful < 2) throw new Error("重点席位联网更新失败");
  return synthesizePublicSnapshot(bundled, settled);
}

function productRow(row, maximum) {
  const netChange = finiteNumber(row.netChange) || 0;
  const line = element("div", "derivative-product-row");
  line.append(element("strong", "", row.code || "--"), element("span", "", row.shortName || row.name || "--"));
  const track = element("span", "derivative-product-track");
  const fill = element("span", `derivative-product-fill ${netChange >= 0 ? "gain" : "loss"}`);
  fill.style.width = `${Math.max(2, Math.abs(netChange) / Math.max(maximum, 1) * 50).toFixed(2)}%`;
  track.append(fill);
  track.setAttribute("aria-label", `${row.shortName || row.code}净方向变化${formatSignedHands(netChange)}手`);
  line.append(track, element("b", numberClass(netChange), formatSignedHands(netChange)));
  return line;
}

function memberHeader() {
  const line = element("div", "derivative-member-head");
  ["席位", "多单日变", "空单日变", "净方向", "判断"].forEach((text) => line.append(element("span", "", text)));
  return line;
}

function memberRow(row) {
  const futures = row?.futures || {};
  const hasSample = Number(futures.appearanceCount) > 0;
  const longChange = hasSample ? finiteNumber(futures.longChange) : null;
  const shortChange = hasSample ? finiteNumber(futures.shortChange) : null;
  const netChange = hasSample ? finiteNumber(futures.netChange) : null;
  const stance = hasSample ? (futures.stance || row.stance || "中性") : "未披露";
  const line = element("div", "derivative-member-row");
  const name = element("strong", "member-name", row.member || "--");
  if (row.required) name.append(element("small", "", "重点"));
  const longNode = element("span", `member-long ${longChange === null ? "muted" : numberClass(longChange)}`, formatSignedHands(longChange));
  const shortNode = element("span", `member-short ${shortChange === null ? "muted" : numberClass(shortChange === null ? null : -shortChange)}`, formatSignedHands(shortChange));
  const netNode = element("span", `member-net ${netChange === null ? "muted" : numberClass(netChange)}`, formatSignedHands(netChange));
  const stanceNode = element("b", `member-stance ${stanceClass(stance)}`, stance);
  line.append(name, longNode, shortNode, netNode, stanceNode);
  line.title = hasSample
    ? `${row.member}公开榜单可见多单、空单与净方向日变化`
    : `${row.member}未进入当前可见样本，不能解释为零持仓`;
  return line;
}

function render(data) {
  currentData = data;
  const analysis = data?.analysis || {};
  const stale = Boolean(data?.stale);
  const online = data?.runtimeSource === "eastmoney-jsonp";
  const status = document.querySelector("#derivativesStatus");
  status.textContent = online ? "重点席位联网更新" : stale ? "沿用最近有效日" : "中金所官方日榜";
  status.className = `status-label ${stale ? "warning" : "fresh"}`;
  document.querySelector("#derivativesDate").textContent = data?.tradeDate || "--";
  document.querySelector("#derivativesFetchedAt").textContent = data?.fetchedAt ? new Date(data.fetchedAt).toLocaleString("zh-CN", {hour12: false}) : "--";

  const overview = element("section", "derivatives-overview");
  overview.append(element("span", "metric-label", "综合判断"));
  const stanceLine = element("div", "derivatives-stance-line");
  stanceLine.append(
    element("strong", stanceClass(analysis.stance), analysis.stance || "中性"),
    element("span", "", `方向分 ${finiteNumber(analysis.score) ?? "--"} · 置信度 ${analysis.confidence || "较低"}`),
  );
  overview.append(stanceLine, element("p", "derivatives-headline", analysis.headline || "机构衍生品暂未形成有效判断。"));
  const products = element("div", "derivative-products");
  const productRows = Array.isArray(analysis.futuresProducts) ? analysis.futuresProducts : [];
  const maximum = Math.max(1, ...productRows.map((row) => Math.abs(finiteNumber(row.netChange) || 0)));
  productRows.forEach((row) => products.append(productRow(row, maximum)));
  overview.append(products);

  const members = element("section", "derivatives-members");
  members.append(element("h3", "", "主要期货公司代客席位日变化"), memberHeader());
  const visibleMembers = [...(data?.institutions || [])]
    .sort((a, b) => Number(b.required) - Number(a.required) || (finiteNumber(b.futures?.activity) || 0) - (finiteNumber(a.futures?.activity) || 0))
    .slice(0, 10);
  visibleMembers.forEach((row) => members.append(memberRow(row)));

  const interpretation = element("section", "derivatives-interpretation");
  interpretation.append(element("h3", "", "期权变化与综合结论"));
  const optionStats = element("div", "derivatives-option-stats");
  optionStats.append(
    element("span", "", `买方 ${formatSignedHands(analysis.optionLongChange)}手`),
    element("span", "", `卖方 ${formatSignedHands(analysis.optionShortChange)}手`),
  );
  interpretation.append(optionStats, element("strong", "derivatives-option-tone", analysis.optionTone || "期权变化暂无结论"));
  const paragraphs = Array.isArray(analysis.paragraphs) ? analysis.paragraphs : [];
  paragraphs.filter(Boolean).forEach((content) => interpretation.append(element("p", "", content)));
  document.querySelector("#derivativesContent").replaceChildren(overview, members, interpretation);
  document.querySelector("#derivativesDisclosure").textContent = data?.source?.disclosure
    || "席位数据为中金所成交持仓排名中的期货公司结算会员代客榜单，不等同于机构自营观点。";
}

function showNotice(message, tone = "") {
  const notice = document.querySelector("#derivativesNotice");
  notice.className = `notice-bar ${tone}`.trim();
  notice.textContent = message;
  notice.hidden = false;
}

async function loadBundled() {
  try {
    const data = await loadDerivativesData();
    render(data);
    return data;
  } catch (error) {
    document.querySelector("#derivativesContent").replaceChildren(element("div", "error-state", error.message));
    showNotice("机构动向数据读取失败。", "error");
    logTechnicalError(error, "机构动向");
    return null;
  }
}

async function refreshPublic(silent = false) {
  if (refreshRunning) return;
  refreshRunning = true;
  const button = document.querySelector("#refreshDerivatives");
  button.disabled = true;
  button.textContent = "联网更新中";
  if (!silent) showNotice("正在读取重点期货公司最新公开席位数据。");
  try {
    const base = currentData || await loadBundled();
    const data = await loadPublicSnapshot(base || {});
    localStorage.setItem("a-share-review:public-derivatives", JSON.stringify(data));
    render(data);
    if (!silent) showNotice(`已更新至${data.tradeDate}重点席位数据。`, "success");
  } catch (error) {
    const cached = (() => {
      try { return JSON.parse(localStorage.getItem("a-share-review:public-derivatives") || "null"); } catch (_) { return null; }
    })();
    if (cached?.analysis) render(cached);
    if (!silent) showNotice(`联网更新失败，继续显示最近有效数据：${error.message}`, "error");
    logTechnicalError(error, "公开席位联网更新");
  } finally {
    refreshRunning = false;
    button.disabled = false;
    button.textContent = "刷新机构数据";
  }
}

async function refreshData() {
  if (isStaticRuntime()) {
    await refreshPublic(false);
    return;
  }
  const button = document.querySelector("#refreshDerivatives");
  button.disabled = true;
  button.textContent = "更新中";
  showNotice("正在请求中金所最新成交持仓排名。");
  try {
    const result = await requestDerivativesRefresh();
    await loadBundled();
    showNotice(result.message || "机构动向已更新。", "success");
  } catch (error) {
    showNotice(`本地服务更新失败，尝试公开席位联网更新：${error.message}`, "error");
    await refreshPublic(true);
  } finally {
    button.disabled = false;
    button.textContent = "刷新机构数据";
  }
}

async function initialize() {
  initializeTheme();
  document.querySelector("#refreshDerivatives").addEventListener("click", refreshData);
  const bundled = await loadBundled();
  if (isStaticRuntime()) {
    const cached = (() => {
      try { return JSON.parse(localStorage.getItem("a-share-review:public-derivatives") || "null"); } catch (_) { return null; }
    })();
    if (cached?.analysis) render(cached);
    await refreshPublic(true);
    setInterval(() => {
      if (!document.hidden) refreshPublic(true);
    }, 30 * 60 * 1000);
  } else {
    setInterval(() => {
      if (!document.hidden && !refreshRunning) loadBundled();
    }, 60 * 1000);
  }
  if (!bundled) showNotice("尚未形成机构动向数据。", "error");
}

initialize();
