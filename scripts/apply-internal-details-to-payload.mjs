import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const sourceApp = path.join(repoRoot, "app");
const payloadRoot = path.resolve(process.argv[2] || "");
const targetApp = path.join(payloadRoot, "程序", "应用");

if (!process.argv[2] || !fs.existsSync(targetApp)) {
  throw new Error(`载荷应用目录不存在：${targetApp}`);
}

const files = [
  ["pages/market-detail.html", "pages/market-detail.html"],
  ["pages/content-detail.html", "pages/content-detail.html"],
  ["assets/css/internal-detail.css", "assets/css/internal-detail.css"],
  ["assets/js/internal-navigation.js", "assets/js/internal-navigation.js"],
  ["assets/js/mobile-live.js", "assets/js/mobile-live.js"],
  ["assets/js/internal-market-detail.js", "assets/js/internal-market-detail.js"],
  ["assets/js/internal-content-detail.js", "assets/js/internal-content-detail.js"],
  ["backend/board-intraday.js", "backend/board-intraday.js"],
  ["backend/market-detail-data.js", "backend/market-detail-data.js"],
];

for (const [sourceRelative, targetRelative] of files) {
  const source = path.join(sourceApp, ...sourceRelative.split("/"));
  const target = path.join(targetApp, ...targetRelative.split("/"));
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.copyFileSync(source, target);
}

const sourceApi = fs.readFileSync(path.join(sourceApp, "assets", "js", "api.js"), "utf8");
const quoteBlockMatch = sourceApi.match(
  /export function exactQuoteUrl\(stock = \{\}\) \{[\s\S]*?export const openTdxStock = openLocalStock;/,
);
if (!quoteBlockMatch) throw new Error("源代码中未找到内置行情跳转实现。");

const targetApiPath = path.join(targetApp, "assets", "js", "api.js");
let targetApi = fs.readFileSync(targetApiPath, "utf8");
if (!/^\s*import "\.\/internal-navigation\.js";/m.test(targetApi)) {
  targetApi = `import "./internal-navigation.js";\n\n${targetApi}`;
}
const oldQuotePattern =
  /export function exactQuoteUrl\(stock = \{\}\) \{[\s\S]*?export const openTdxStock = openLocalStock;/;
if (!oldQuotePattern.test(targetApi)) {
  throw new Error(`目标 api.js 未找到可替换的行情跳转实现：${targetApiPath}`);
}
targetApi = targetApi.replace(oldQuotePattern, quoteBlockMatch[0]);
if (/quote\.eastmoney\.com|so\.eastmoney\.com|\/stock-open/.test(targetApi)) {
  throw new Error(`目标 api.js 仍包含外部行情导航：${targetApiPath}`);
}
fs.writeFileSync(targetApiPath, targetApi, "utf8");

const serviceWorkerPath = path.join(targetApp, "sw.js");
let serviceWorker = fs.readFileSync(serviceWorkerPath, "utf8");
serviceWorker = serviceWorker.replace(
  /const CACHE_VERSION = "[^"]+";/,
  'const CACHE_VERSION = "a-share-review-v76-internal-details";',
);
const cacheAssets = [
  "/app/pages/market-detail.html",
  "/app/pages/content-detail.html",
  "/app/assets/css/internal-detail.css",
  "/app/assets/js/internal-navigation.js",
  "/app/assets/js/mobile-live.js",
  "/app/assets/js/internal-market-detail.js",
  "/app/assets/js/internal-content-detail.js",
];
const assetsMatch = serviceWorker.match(/const CORE_ASSETS = \[[\s\S]*?\n\];/);
if (!assetsMatch) throw new Error(`目标 sw.js 未找到 CORE_ASSETS：${serviceWorkerPath}`);
const missingAssets = cacheAssets.filter((asset) => !assetsMatch[0].includes(`"${asset}"`));
if (missingAssets.length) {
  const replacement = assetsMatch[0].replace(
    /\n\];$/,
    `${missingAssets.map((asset) => `,\n  "${asset}"`).join("")}\n];`,
  );
  serviceWorker = serviceWorker.replace(assetsMatch[0], replacement);
}
fs.writeFileSync(serviceWorkerPath, serviceWorker, "utf8");

const servicePath = path.join(targetApp, "backend", "复盘同步服务.js");
let service = fs.readFileSync(servicePath, "utf8");
if (!service.includes('require("./board-intraday")')) {
  service = service.replace(
    'const { createLiveSectorFlowService } = require("./live-sector-flow");',
    'const { createLiveSectorFlowService } = require("./live-sector-flow");\n'
      + 'const { createBoardIntradayService } = require("./board-intraday");',
  );
}
if (!service.includes('require("./market-detail-data")')) {
  service = service.replace(
    'const { createBoardIntradayService } = require("./board-intraday");',
    'const { createBoardIntradayService } = require("./board-intraday");\n'
      + 'const { createMarketDetailDataService } = require("./market-detail-data");',
  );
}
service = service.replace(
  /const SERVICE_VERSION = "[^"]+";/,
  'const SERVICE_VERSION = "3.14.4";',
);
if (!service.includes("const boardIntraday = createBoardIntradayService();")) {
  service = service.replace(
    "const liveSectorFlow = createLiveSectorFlowService({log});",
    "const liveSectorFlow = createLiveSectorFlowService({log});\n"
      + "const boardIntraday = createBoardIntradayService();",
  );
}
if (!service.includes("const marketDetailData = createMarketDetailDataService")) {
  service = service.replace(
    "const boardIntraday = createBoardIntradayService();",
    "const boardIntraday = createBoardIntradayService();\n"
      + "const marketDetailData = createMarketDetailDataService({boardIntraday});",
  );
}
if (!service.includes('"/api/v1/market-detail"')) {
  service = service.replace(
    'endpoints: ["/api/v1/market/snapshot",',
    'endpoints: ["/api/v1/market/snapshot", "/api/v1/market-detail",',
  );
}
if (!service.includes('url.pathname === "/api/v1/market-detail"')) {
  const marker = '  if (url.pathname === "/api/v1/live/sector-flows" && req.method === "GET") {';
  const route = `  if (url.pathname === "/api/v1/market-detail" && req.method === "GET") {
    try {
      sendJson(res, 200, await marketDetailData.getDetail({
        code: url.searchParams.get("code"),
        boardCode: url.searchParams.get("boardCode"),
        market: url.searchParams.get("market"),
        name: url.searchParams.get("name"),
        limit: url.searchParams.get("limit"),
      }));
    } catch (error) {
      sendJson(res, error.statusCode || 502, {
        ok: false,
        errorCode: "MARKET_DETAIL_UNAVAILABLE",
        message: error.message || "行情详情暂不可用",
      });
    }
    return;
  }

`;
  if (!service.includes(marker)) {
    throw new Error(`目标同步服务未找到行情路由插入点：${servicePath}`);
  }
  service = service.replace(marker, `${route}${marker}`);
}
for (const required of [
  'require("./market-detail-data")',
  "createMarketDetailDataService({boardIntraday})",
  'url.pathname === "/api/v1/market-detail"',
]) {
  if (!service.includes(required)) throw new Error(`目标同步服务补丁不完整：${required}`);
}
fs.writeFileSync(servicePath, service, "utf8");

const result = {
  payloadRoot,
  targetApp,
  copiedFiles: files.length,
  apiInternal: targetApi.includes("internalMarketDetail"),
  externalNavigationRemoved: !/quote\.eastmoney\.com|so\.eastmoney\.com|\/stock-open/.test(targetApi),
  cacheAssets: cacheAssets.filter((asset) => serviceWorker.includes(`"${asset}"`)).length,
  marketDetailApi: service.includes('url.pathname === "/api/v1/market-detail"'),
  quantPage: fs.existsSync(path.join(targetApp, "pages", "quant.html")),
  membershipAdminPage: fs.existsSync(path.join(targetApp, "pages", "membership-admin.html")),
};

console.log(JSON.stringify(result, null, 2));
