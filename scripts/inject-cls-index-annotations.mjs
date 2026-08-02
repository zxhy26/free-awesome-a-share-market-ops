import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const require = createRequire(import.meta.url);
const {
  CLS_INDEX_ANNOTATION_ENDPOINTS,
  normalizeClsAnchorPayload,
} = require(path.join(repoRoot, "app", "backend", "财联社指数标注.js"));

const appDirs = process.argv.slice(2).map((value) => path.resolve(value));
if (!appDirs.length) throw new Error("用法：node scripts/inject-cls-index-annotations.mjs <应用目录> [更多应用目录]");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

function updateSourceNote(value) {
  const clsNote = "指数分时文字标注仅采用财联社盘面直播公开事件接口返回的行业与题材板块事件，排除所有个股事件；前台只把原始板块事件定位到同期指数线并按原始方向显示红绿；接口异常时仅保留同交易日上一份财联社板块记录，没有记录则不显示，不使用个股、资金拐点、板块强弱或本地规则生成替代标注。";
  let note = String(value || "")
    .replace(/指数线标签只在.*?不等同于成分股精确权重贡献；/g, "")
    .replace(/指数分时线标注只保留.*?绿色为累计净流出。?/g, "")
    .replace(/指数分时文字标注仅采用财联社盘面直播[^。]*。?/g, "")
    .replace(/指数分时文字只展示财联社盘面直播[^。]*。?/g, "");
  if (!note.includes("指数分时文字标注仅采用财联社盘面直播")) note += clsNote;
  return note;
}

async function fetchAnnotations(tradeDate) {
  const errors = [];
  for (const endpoint of CLS_INDEX_ANNOTATION_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}?cdate=${encodeURIComponent(tradeDate)}`, {
        headers: {Accept: "application/json", Referer: "https://www.cls.cn/finance", "User-Agent": "Mozilla/5.0 AShareReview/2.20.0"},
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return normalizeClsAnchorPayload(await response.json(), {
        tradeDate,
        syncedAt: new Date().toISOString(),
      });
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`财联社盘面直播接口连续失败：${errors.join("；")}`);
}

function updateHealth(dataDir, feed) {
  const healthPath = path.join(dataDir, "health.json");
  if (!fs.existsSync(healthPath)) return;
  const health = readJson(healthPath);
  const module = (health.modules || []).find((item) => item.key === "indices");
  if (!module) return;
  module.sources = [...new Set([...(module.sources || []), feed.source].filter(Boolean))];
  module.sample = {
    ...(module.sample || {}),
    annotationCount: feed.itemCount,
    annotationStatus: feed.status,
  };
  module.checks = [
    ...(module.checks || []).filter((item) => item.name !== "指数文字标注"),
    {name: "指数文字标注", status: "ok", detail: `财联社行业/题材板块事件${feed.itemCount}条（已排除${feed.excludedStockCount || 0}条个股）`},
  ];
  writeJson(healthPath, health);
}

const feeds = new Map();
const results = [];
for (const appDir of appDirs) {
  const dataDir = path.join(appDir, "data");
  const indicesPath = path.join(dataDir, "indices.json");
  const marketPath = path.join(dataDir, "market.json");
  if (!fs.existsSync(indicesPath) || !fs.existsSync(marketPath)) throw new Error(`应用数据不完整：${appDir}`);
  const indices = readJson(indicesPath);
  const market = readJson(marketPath);
  const tradeDate = indices.tradeDate || market.tradeDate || market.market?.tradeDate || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error(`交易日无效：${appDir}`);
  if (!feeds.has(tradeDate)) feeds.set(tradeDate, await fetchAnnotations(tradeDate));
  const feed = feeds.get(tradeDate);
  indices.annotations = feed;
  market.sourceNote = updateSourceNote(market.sourceNote);
  writeJson(indicesPath, indices);
  writeJson(marketPath, market);
  updateHealth(dataDir, feed);
  results.push({appDir, tradeDate, annotationCount: feed.itemCount, source: feed.source});
}

process.stdout.write(`${JSON.stringify({ok: true, results}, null, 2)}\n`);
