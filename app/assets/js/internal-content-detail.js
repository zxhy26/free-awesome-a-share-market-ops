import {initializeTheme} from "./theme.js";

const rootUrl = new URL(globalThis.__A_SHARE_ROOT_URL__ || "../../", import.meta.url);
const params = new URLSearchParams(location.search);
const storagePrefix = "a-share-internal-detail:";

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function readStoredPayload() {
  const key = params.get("key") || "";
  if (!key) return null;
  for (const storage of [sessionStorage, localStorage]) {
    try {
      const raw = storage.getItem(`${storagePrefix}${key}`);
      if (raw) return JSON.parse(raw);
    } catch (_) {
    }
  }
  return null;
}

function normalizedLines(text) {
  const lines = [];
  const seen = new Set();
  String(text || "").split(/\r?\n/).forEach((line) => {
    const normalized = line.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    lines.push(normalized);
  });
  return lines;
}

function recordTitle(record) {
  return String(record?.title || record?.name || record?.headline || "").trim();
}

function findRecord(value, title, depth = 0, visited = new Set()) {
  if (!value || depth > 8 || typeof value !== "object" || visited.has(value)) return null;
  visited.add(value);
  if (!Array.isArray(value) && recordTitle(value) === title) return value;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const result = findRecord(child, title, depth + 1, visited);
    if (result) return result;
  }
  return null;
}

async function findPackagedRecord(title) {
  for (const file of [
    "policy-news.json",
    "next-week-events.json",
    "next-week-company-profiles.json",
    "quant.json",
  ]) {
    try {
      const response = await fetch(new URL(`data/${file}`, rootUrl), {cache: "no-store"});
      if (!response.ok) continue;
      const record = findRecord(await response.json(), title);
      if (record) return record;
    } catch (_) {
    }
  }
  return null;
}

function addTextSection(container, title, value) {
  const text = Array.isArray(value) ? value.filter(Boolean).join("、") : String(value || "").trim();
  if (!text) return;
  const section = element("section", "internal-detail-section");
  section.append(element("h2", "", title), element("p", "", text));
  container.append(section);
}

function renderRecord(container, record) {
  addTextSection(container, "摘要", record.summary || record.description || record.content);
  addTextSection(container, "事件触发", record.trigger);
  addTextSection(container, "传导逻辑", record.chainSummary || record.channel || record.reason);
  addTextSection(container, "影响判断", record.impact);
  addTextSection(container, "关联板块", record.sectors || record.themes || record.plans);
  addTextSection(container, "关联理由", record.relatedReason || record.linkReason);
  addTextSection(container, "验证要点", record.verification || record.verificationPoints);
  addTextSection(container, "失效条件", record.invalidation);
  if (Array.isArray(record.transmissionSteps) && record.transmissionSteps.length) {
    const section = element("section", "internal-detail-section");
    section.append(element("h2", "", "关键事件传导链"));
    const list = element("ol", "internal-detail-steps");
    record.transmissionSteps.forEach((step) => {
      const item = element("li");
      item.append(
        element("strong", "", step.stage || "传导环节"),
        element("p", "", step.content || ""),
      );
      list.append(item);
    });
    section.append(list);
    container.append(section);
  }
}

function renderCapturedText(container, text) {
  const lines = normalizedLines(text);
  if (!lines.length) return;
  const section = element("section", "internal-detail-section");
  section.append(element("h2", "", "当前按钮对应内容"));
  const list = element("div", "internal-detail-paragraphs");
  lines.forEach((line) => list.append(element("p", "", line)));
  section.append(list);
  container.append(section);
}

async function init() {
  initializeTheme();
  const title = String(params.get("title") || "内容详情").trim();
  const payload = readStoredPayload();
  const content = payload?.content || params.get("excerpt") || "";
  const heading = document.querySelector("#contentDetailTitle");
  const subtitle = document.querySelector("#contentDetailSubtitle");
  const status = document.querySelector("#contentDetailStatus");
  const container = document.querySelector("#contentDetailContent");
  heading.textContent = payload?.buttonName || title;
  document.title = `${heading.textContent}｜软件内详情`;
  subtitle.textContent = "内容由软件根据当前按钮携带的已发布数据生成，不嵌入或跳转外部网页。";

  renderCapturedText(container, content);
  const record = await findPackagedRecord(title);
  if (record) renderRecord(container, record);

  if (!container.childElementCount) {
    const empty = element("section", "internal-detail-section internal-detail-empty");
    empty.append(
      element("h2", "", "暂无可核验正文"),
      element("p", "", "该按钮当前没有携带可核验的本地正文，软件不会为了填充页面而生成未经验证的内容。"),
    );
    container.append(empty);
    status.textContent = "未找到可核验正文";
    status.dataset.state = "warning";
  } else {
    status.textContent = payload?.sourceHost
      ? `已在软件内生成 · 原始信息来源 ${payload.sourceHost}`
      : "已在软件内生成";
    status.dataset.state = "ready";
  }
}

document.querySelector("#contentDetailBack").addEventListener("click", () => {
  if (history.length > 1) history.back();
  else location.href = new URL("index.html", rootUrl).href;
});

init().catch((error) => {
  const status = document.querySelector("#contentDetailStatus");
  status.textContent = `内容读取失败：${error.message}`;
  status.dataset.state = "error";
});
