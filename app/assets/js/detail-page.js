import {loadStockData, logTechnicalError} from "./api.js?v=20260719-2";
import {createStockTable} from "./table.js?v=20260719-2";
import {initializeTheme} from "./theme.js";

const TYPE_INFO = {
  limitUp: {title: "涨停个股", description: "按同一行业个股数量从多到少分组排列，同组顺序固定。"},
  limitDown: {title: "跌停个股", description: "按同一行业个股数量从多到少分组排列，同组顺序固定。"},
  yesterdayLimit: {title: "昨日涨停延续", description: "查看昨日涨停股票今天的红盘、晋级和板块分布。"},
  yesterdayBroken: {title: "昨日炸板修复", description: "查看昨日炸板股票今天的修复力度和板块分布。"},
};

function node(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== "") element.textContent = text;
  return element;
}

function shell(info) {
  const wrapper = node("div", "detail-shell");
  const header = node("header", "detail-header");
  const titleBlock = document.createElement("div");
  titleBlock.append(node("h1", "", info.title), node("p", "", info.description));
  const actions = node("nav", "detail-actions");
  const back = node("a", "button", "返回首页");
  back.href = "../index.html";
  const theme = node("fieldset", "theme-segment");
  theme.setAttribute("aria-label", "主题模式");
  [["system", "跟随"], ["light", "浅色"], ["dark", "深色"]].forEach(([value, text]) => {
    const button = node("button", "", text); button.type = "button"; button.dataset.themeChoice = value; theme.append(button);
  });
  actions.append(back, theme);
  header.append(titleBlock, actions);
  const content = node("section", "");
  const footer = node("footer", "app-footer");
  footer.append(node("p", "", "本软件仅用于市场数据整理和复盘分析，不构成任何投资建议。市场有风险，决策需独立判断。"));
  wrapper.append(header, content, footer);
  return {wrapper, content};
}

async function initialize() {
  const type = document.documentElement.dataset.detailType;
  const info = TYPE_INFO[type] || TYPE_INFO.limitUp;
  const root = document.querySelector("#detailApp");
  const view = shell(info);
  root.replaceChildren(view.wrapper);
  initializeTheme();
  view.content.append(node("div", "loading-state", "正在读取个股详情…"));
  try {
    const data = await loadStockData();
    const group = data.groups?.[type] || {rows: [], reportedCount: 0};
    createStockTable(view.content, {rows: group.rows || [], reportedCount: Number(group.reportedCount) || 0, title: info.title, tradeDate: data.tradeDate});
  } catch (error) {
    const box = node("div", "error-state");
    box.append(node("p", "", error.message));
    const retry = node("button", "button", "重试");
    retry.type = "button";
    retry.addEventListener("click", () => location.reload());
    box.append(retry);
    view.content.replaceChildren(box);
    logTechnicalError(error, "详情页");
  }
}

initialize();
