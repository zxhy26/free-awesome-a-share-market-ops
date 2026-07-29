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

function copyAppFile(relativePath) {
  const source = path.join(sourceApp, ...relativePath.split("/"));
  const target = path.join(targetApp, ...relativePath.split("/"));
  if (!fs.existsSync(source)) throw new Error(`源文件不存在：${source}`);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.copyFileSync(source, target);
}

function removeAppFile(relativePath) {
  fs.rmSync(path.join(targetApp, ...relativePath.split("/")), {force: true});
}

function replaceRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`未找到可替换的${label}`);
  pattern.lastIndex = 0;
  return source.replace(pattern, replacement);
}

const sharedFiles = [
  "pages/content-detail.html",
  "assets/css/internal-detail.css",
  "assets/js/internal-navigation.js",
  "assets/js/internal-content-detail.js",
  "backend/打开通达信日K.ps1",
];
sharedFiles.forEach(copyAppFile);

const removedFiles = [
  "pages/market-detail.html",
  "assets/js/internal-market-detail.js",
  "backend/market-detail-data.js",
];
removedFiles.forEach(removeAppFile);

const sourceApi = fs.readFileSync(path.join(sourceApp, "assets", "js", "api.js"), "utf8");
const quotePattern =
  /export function exactQuoteUrl\(stock = \{\}\) \{[\s\S]*?export const openTdxStock = openLocalStock;/;
const quoteBlock = sourceApi.match(quotePattern)?.[0];
if (!quoteBlock) throw new Error("源 api.js 未找到交易软件跳转实现");

const targetApiPath = path.join(targetApp, "assets", "js", "api.js");
let targetApi = fs.readFileSync(targetApiPath, "utf8");
if (!/^\s*import "\.\/internal-navigation\.js";/m.test(targetApi)) {
  targetApi = `import "./internal-navigation.js";\n\n${targetApi}`;
}
targetApi = replaceRequired(
  targetApi,
  quotePattern,
  quoteBlock,
  `交易软件跳转实现：${targetApiPath}`,
);
if (/pages\/market-detail\.html|internalMarketDetail|quote\.eastmoney\.com|so\.eastmoney\.com/.test(targetApi)) {
  throw new Error(`目标 api.js 仍包含软件内日K或网页行情导航：${targetApiPath}`);
}
fs.writeFileSync(targetApiPath, targetApi, "utf8");

const targetAppJsPath = path.join(targetApp, "assets", "js", "app.js");
let targetAppJs = fs.readFileSync(targetAppJsPath, "utf8");
targetAppJs = targetAppJs.replace(
  /未检测到可自动操作的本机股票软件，已尝试网页行情兜底。/g,
  "未检测到可自动操作的本机交易软件，请先安装或登录交易软件。",
);
fs.writeFileSync(targetAppJsPath, targetAppJs, "utf8");

const sourceService = fs.readFileSync(path.join(sourceApp, "backend", "复盘同步服务.js"), "utf8");
const runLocalStockPattern =
  /function runLocalStock\(searchParams\) \{[\s\S]*?\n\}\n(?=function minuteOfDay)/;
const runLocalStockBlock = sourceService.match(runLocalStockPattern)?.[0];
if (!runLocalStockBlock) throw new Error("源同步服务未找到本机交易软件调用实现");

const servicePath = path.join(targetApp, "backend", "复盘同步服务.js");
let service = fs.readFileSync(servicePath, "utf8");
service = service
  .replace(/^const \{ createMarketDetailDataService \} = require\("\.\/market-detail-data"\);\r?\n/m, "")
  .replace(/^const marketDetailData = createMarketDetailDataService\([^\n]*\);\r?\n/m, "")
  .replace(
    /\n  if \(url\.pathname === "\/api\/v1\/market-detail" && req\.method === "GET"\) \{[\s\S]*?\n  \}\r?\n(?=\r?\n  if \(url\.pathname === "\/api\/v1\/live\/sector-flows")/,
    "",
  )
  .replace(/,?\s*"\/api\/v1\/market-detail"/g, "");
service = replaceRequired(
  service,
  runLocalStockPattern,
  runLocalStockBlock,
  `本机交易软件调用实现：${servicePath}`,
);
service = service.replace(/endpoints:\s*\[([^\]]*)\]/, (match, endpoints) => {
  if (endpoints.includes("POST /stock-open")) return match;
  return `endpoints: [${endpoints.trim()}, "POST /stock-open"]`;
});
service = service.replace(
  /const SERVICE_VERSION = "[^"]+";/,
  'const SERVICE_VERSION = "3.14.5";',
);
if (!service.includes('["/stock-open", "/tdx-stock", "/tdx-sector"]')) {
  throw new Error(`目标同步服务缺少 /stock-open 路由：${servicePath}`);
}
if (!service.includes('"POST /stock-open"')) {
  throw new Error(`目标同步服务元数据缺少 /stock-open：${servicePath}`);
}
if (/market-detail|createMarketDetailDataService/.test(service)) {
  throw new Error(`目标同步服务仍包含软件内日K接口：${servicePath}`);
}
fs.writeFileSync(servicePath, service, "utf8");

const serviceWorkerPath = path.join(targetApp, "sw.js");
let serviceWorker = fs.readFileSync(serviceWorkerPath, "utf8");
serviceWorker = serviceWorker
  .replace(
    /const CACHE_VERSION = "[^"]+";/,
    'const CACHE_VERSION = "a-share-review-v77-trading-app";',
  )
  .split(/\r?\n/)
  .filter((line) => !/market-detail/.test(line))
  .join("\n");
fs.writeFileSync(serviceWorkerPath, serviceWorker, "utf8");

const updaterPath = path.join(targetApp, "backend", "自动更新A股田字格.js");
if (fs.existsSync(updaterPath)) {
  let updater = fs.readFileSync(updaterPath, "utf8");
  updater = updater
    .replace(/http:\/\/127\.0\.0\.1:18765\/stock-open/g, "/stock-open")
    .replace(/网页行情兜底/g, "本机交易软件跳转");
  fs.writeFileSync(updaterPath, updater, "utf8");
}

let patchedHtmlFiles = 0;
const visit = (directory) => {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(absolute);
      continue;
    }
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".html") continue;
    const original = fs.readFileSync(absolute, "utf8");
    const updated = original
      .replace(/http:\/\/127\.0\.0\.1:18765\/stock-open/g, "/stock-open")
      .replace(/网页行情兜底/g, "本机交易软件跳转");
    if (updated !== original) {
      fs.writeFileSync(absolute, updated, "utf8");
      patchedHtmlFiles += 1;
    }
  }
};
visit(targetApp);

const result = {
  payloadRoot,
  targetApp,
  copiedFiles: sharedFiles.length,
  removedFiles: removedFiles.length,
  patchedHtmlFiles,
  stockOpenRoute: service.includes('["/stock-open", "/tdx-stock", "/tdx-sector"]'),
  webFallbackRemoved:
    !/quote\.eastmoney\.com|so\.eastmoney\.com|网页行情兜底/.test(targetApi)
    && !/quote\.eastmoney\.com|so\.eastmoney\.com|Open-Web/.test(
      fs.readFileSync(path.join(targetApp, "backend", "打开通达信日K.ps1"), "utf8"),
    ),
  internalMarketPageRemoved: removedFiles.every(
    (relativePath) => !fs.existsSync(path.join(targetApp, ...relativePath.split("/"))),
  ),
  quantPage: fs.existsSync(path.join(targetApp, "pages", "quant.html")),
  membershipAdminPage: fs.existsSync(path.join(targetApp, "pages", "member-admin.html")),
};

if (!result.stockOpenRoute || !result.webFallbackRemoved || !result.internalMarketPageRemoved) {
  throw new Error(`载荷交易软件跳转补丁验证失败：${JSON.stringify(result)}`);
}

console.log(JSON.stringify(result, null, 2));
