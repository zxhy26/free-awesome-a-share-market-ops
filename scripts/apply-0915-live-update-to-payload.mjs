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

function read(relativePath, root = targetApp) {
  return fs.readFileSync(path.join(root, ...relativePath.split("/")), "utf8");
}

function write(relativePath, content, root = targetApp) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, content, "utf8");
}

function copy(relativePath) {
  write(relativePath, read(relativePath, sourceApp));
}

function replaceRequired(content, pattern, replacement, label) {
  pattern.lastIndex = 0;
  if (!pattern.test(content)) throw new Error(`未找到可替换的${label}`);
  pattern.lastIndex = 0;
  return content.replace(pattern, replacement);
}

function sourceBlock(relativePath, pattern, label) {
  const match = read(relativePath, sourceApp).match(pattern);
  if (!match) throw new Error(`源文件未找到${label}`);
  return match[0];
}

const copiedFiles = [
  "data/a-share-stock-universe.json",
  "assets/js/market-session.js",
  "assets/js/analysis.js",
  "assets/js/sector-flow-chart.js",
  "assets/js/mobile-live.js",
  "backend/live-sector-flow.js",
  "backend/升级数据层.js",
  "backend/板块资金自动纠偏.js",
];
for (const relativePath of copiedFiles) {
  if (
    relativePath.startsWith("data/")
    || fs.existsSync(path.join(targetApp, ...relativePath.split("/")))
  ) copy(relativePath);
}

const sourceAppJs = read("assets/js/app.js", sourceApp);
const appBlocks = [
  {
    label: "集合竞价资金合并逻辑",
    pattern: /function mergeLiveFlowGroup\(groupName, snapshot\) \{[\s\S]*?\n\}\n\n(?=function applyLiveIndexQuotes)/,
  },
  {
    label: "集合竞价指数报价逻辑",
    pattern: /function applyLiveIndexQuotes\(snapshot\) \{[\s\S]*?\n\}\n\n(?=function updateLiveFlowStatus)/,
  },
  {
    label: "集合竞价状态逻辑",
    pattern: /function updateLiveFlowStatus\(snapshot, error = null\) \{[\s\S]*?\n\}\n\n(?=function applyLiveFlowSnapshot)/,
  },
  {
    label: "集合竞价资金排名逻辑",
    pattern: /function renderFlow\(groupName, minute\) \{[\s\S]*?\n\}\n\n(?=function scoreDetails)/,
  },
];
let appJs = read("assets/js/app.js");
appJs = replaceRequired(
  appJs,
  /import \{[^}]*inTradingWindow[^}]*\} from "\.\/market-session\.js\?v=[^"]+";/,
  'import {inTradingWindow, shouldAppendRegularSessionSample} from "./market-session.js?v=20260730-1";',
  "交易时段模块引用",
);
appJs = appJs
  .replace(/\.\/analysis\.js\?v=[^"]+/g, "./analysis.js?v=20260730-1")
  .replace(/\.\/charts\.js\?v=[^"]+/g, "./charts.js?v=20260730-1");
for (const block of appBlocks) {
  const replacement = sourceAppJs.match(block.pattern)?.[0];
  if (!replacement) throw new Error(`源 app.js 未找到${block.label}`);
  appJs = replaceRequired(appJs, block.pattern, replacement, block.label);
}
write("assets/js/app.js", appJs);

const chartPattern =
  /export function updateIndexCharts\(charts, minute\) \{[\s\S]*?\n\}\n\n(?=export function createPlaybackController)/;
const chartBlock = sourceBlock("assets/js/charts.js", chartPattern, "竞价指数显示逻辑");
let charts = read("assets/js/charts.js");
charts = replaceRequired(charts, chartPattern, chartBlock, "竞价指数显示逻辑");
write("assets/js/charts.js", charts);

const customWorkspacePath = path.join(targetApp, "assets", "js", "custom-sector-workspace.js");
if (fs.existsSync(customWorkspacePath)) {
  let customWorkspace = read("assets/js/custom-sector-workspace.js");
  customWorkspace = replaceRequired(
    customWorkspace,
    /<div class="custom-sector-axis"><span>[^<]+<\/span><span>[^<]+<\/span><span>[^<]+<\/span><\/div>/,
    '<div class="custom-sector-axis"><span>09:30:00</span><span>11:30:00 / 13:00:00</span><span>15:00:00</span></div>',
    "自选板块秒级坐标",
  );
  write("assets/js/custom-sector-workspace.js", customWorkspace);
}

let history = read("assets/js/history-page.js");
history = history
  .replace(/周一 --:--(?:"|\))/g, (value) => value.replace("--:--", "--:--:--"))
  .replace(/周五 --:--(?:"|\))/g, (value) => value.replace("--:--", "--:--:--"));
write("assets/js/history-page.js", history);

let indexHtml = read("index.html");
indexHtml = indexHtml
  .replace(/(<strong id="timelineTime">)[^<]*(<\/strong>)/, "$115:00:00$2")
  .replace(/(<span id="timelineEnd">)[^<]*(<\/span>)/, "$115:00:00$2")
  .replace(/(<div class="timeline-wrap">\s*<span>)[^<]*(<\/span>)/, "$109:30:00$2")
  .replace(/assets\/js\/app\.js\?v=[^"']+/g, "assets/js/app.js?v=20260730-1");
write("index.html", indexHtml);

let service = read("backend/复盘同步服务.js");
const shortlineService = /shortline/i.test(service);
service = replaceRequired(
  service,
  /const SERVICE_VERSION = "[^"]+";/,
  `const SERVICE_VERSION = "${shortlineService ? "3.15.1-shortline-v1" : "3.15.0"}";`,
  "同步服务版本",
);
service = replaceRequired(
  service,
  /const PREOPEN_WATCH_START_MINUTE = 9 \* 60 \+ \d+;/,
  "const PREOPEN_WATCH_START_MINUTE = 9 * 60 + 15;",
  "盘前监控开始时间",
);
service = replaceRequired(
  service,
  /return \(minute >= 9 \* 60 \+ \d+ && minute <= 11 \* 60 \+ 30\) \|\| \(minute >= 13 \* 60 && minute <= 15 \* 60\);/,
  "return (minute >= 9 * 60 + 15 && minute <= 11 * 60 + 30) || (minute >= 13 * 60 && minute <= 15 * 60);",
  "同步服务交易时段",
);
write("backend/复盘同步服务.js", service);

copy("backend/盘中实时更新.ps1");

let installer = read("backend/安装盘中实时任务.ps1");
installer = replaceRequired(
  installer,
  /Register-XmlTask -taskName "A股盘中实时自动更新"[^\r\n]*/,
  'Register-XmlTask -taskName "A股盘中实时自动更新" -scriptPath (Join-Path $scriptDir "盘中实时更新.ps1") -startTime ([TimeSpan]"09:15") -repeatInterval "PT1M" -repeatDuration "PT5H45M"',
  "盘中任务触发器",
);
installer = installer.replace(
  /Write-RunLog "复盘软件自动同步已安装：[^\r\n"]*"/,
  'Write-RunLog "复盘软件自动同步已安装：登录后启动本地同步服务；09:15集合竞价起逐秒获取板块与指数实时快照、每1分钟完整同步市场；15:05收盘最终更新；17:15更新中金所机构衍生品；15:00后开机自动补更新。"',
);
write("backend/安装盘中实时任务.ps1", installer);

const minuteToTimePattern =
  /function minuteToTime\(minute\) \{[\s\S]*?\n\}\n\n(?=function timeTextToMinute)/;
const minuteToTimeBlock = sourceBlock("backend/自动更新A股田字格.js", minuteToTimePattern, "秒级分钟转换");
const stockUniversePattern =
  /function loadBundledAStockUniverse\(\) \{[\s\S]*?\n\}\n\n(?=function tencentSymbolForCode)/;
const stockUniverseBlock = sourceBlock(
  "backend/自动更新A股田字格.js",
  stockUniversePattern,
  "内置全A基础名单读取逻辑",
);
let updater = read("backend/自动更新A股田字格.js");
if (!updater.includes("bundledStockUniversePath:")) {
  updater = replaceRequired(
    updater,
    /(stockUniversePath:\s*path\.join\(PORTABLE_CACHE_DIR,\s*"全A基础代码表\.json"\),)/,
    '$1\n  bundledStockUniversePath: path.join(PORTABLE_APP_DIR, "data", "a-share-stock-universe.json"),',
    "内置全A基础名单路径",
  );
}
updater = replaceRequired(
  updater,
  /minutes < 9 \* 60 \+ \d+/,
  "minutes < 9 * 60 + 15",
  "当日行情切换时间",
);
updater = replaceRequired(
  updater,
  /const liveTrading = \(minute >= \d+ && minute <= 690\) \|\| \(minute >= 780 && minute <= 900\);/,
  "const liveTrading = (minute >= 555 && minute <= 690) || (minute >= 780 && minute <= 900);",
  "市场广度实时缓存时段",
);
updater = replaceRequired(updater, minuteToTimePattern, minuteToTimeBlock, "秒级分钟转换");
updater = replaceRequired(
  updater,
  stockUniversePattern,
  stockUniverseBlock,
  "内置全A基础名单读取逻辑",
);
updater = replaceRequired(
  updater,
  /function minuteToTime\(minute\)\{minute=Math\.max\(0,Math\.min\(DAY_MINUTES,minute\)\);[\s\S]*?\}/,
  'function minuteToTime(minute){minute=Math.max(0,Math.min(DAY_MINUTES,minute));const total=minute<=120?570+minute:780+(minute-120);const seconds=Math.round(total*60),h=Math.floor(seconds/3600),m=Math.floor((seconds%3600)/60),s=seconds%60;return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0")}',
  "内嵌页面秒级分钟转换",
);
updater = replaceRequired(
  updater,
  /function inTradingWindow\(\)\{const d=new Date\(\);const day=d\.getDay\(\);if\(day===0\|\|day===6\)return false;const m=d\.getHours\(\)\*60\+d\.getMinutes\(\);return \(m>=9\*60\+\d+&&m<=11\*60\+30\)\|\|\(m>=13\*60&&m<=15\*60\)\}/,
  "function inTradingWindow(){const d=new Date();const day=d.getDay();if(day===0||day===6)return false;const m=d.getHours()*60+d.getMinutes();return (m>=9*60+15&&m<=11*60+30)||(m>=13*60&&m<=15*60)}",
  "内嵌页面实时刷新时段",
);
updater = replaceRequired(
  updater,
  /function shouldKeepAutoReloadCheck\(\)\{const d=new Date\(\);const day=d\.getDay\(\);if\(day===0\|\|day===6\)return false;const m=d\.getHours\(\)\*60\+d\.getMinutes\(\);return m>=9\*60\+\d+&&m<=15\*60\}/,
  "function shouldKeepAutoReloadCheck(){const d=new Date();const day=d.getDay();if(day===0||day===6)return false;const m=d.getHours()*60+d.getMinutes();return m>=9*60+15&&m<=15*60}",
  "内嵌页面刷新监控时段",
);
updater = updater.replace(
  /开盘后实时更新，午休停在 11:30，收盘停在 15:00。/,
  "09:15:00集合竞价起实时更新，午休停在11:30:00，13:00:00恢复，收盘停在15:00:00。",
);
write("backend/自动更新A股田字格.js", updater);

const bundledUniverse = path.join(sourceApp, "data", "a-share-stock-universe.json");
const runtimeUniverse = path.join(payloadRoot, "缓存", "全A基础代码表.json");
fs.mkdirSync(path.dirname(runtimeUniverse), {recursive: true});
fs.copyFileSync(bundledUniverse, runtimeUniverse);

const serviceWorkerPath = path.join(targetApp, "sw.js");
if (fs.existsSync(serviceWorkerPath)) {
  let serviceWorker = read("sw.js");
  serviceWorker = serviceWorker.replace(
    /const CACHE_VERSION = "[^"]+";/,
    'const CACHE_VERSION = "a-share-review-v80-0915-seconds";',
  );
  write("sw.js", serviceWorker);
}

const checks = {
  payloadRoot,
  serviceVersion: read("backend/复盘同步服务.js").match(/SERVICE_VERSION = "([^"]+)"/)?.[1] || "",
  auctionStart: /9 \* 60 \+ 15/.test(read("backend/复盘同步服务.js")),
  taskStart: /startTime \(\[TimeSpan\]"09:15"\)/.test(read("backend/安装盘中实时任务.ps1")),
  frontendAuction: /shouldAppendRegularSessionSample/.test(read("assets/js/app.js")),
  secondClock: /marketMinuteToTime\(minute, includeSeconds = true\)/.test(read("assets/js/market-session.js")),
  stockUniverseCount: JSON.parse(read("data/a-share-stock-universe.json")).items?.length || 0,
  quant: fs.existsSync(path.join(targetApp, "pages", "quant.html")),
  shortline: fs.existsSync(path.join(targetApp, "pages", "shortline.html")),
  admin: fs.existsSync(path.join(targetApp, "pages", "member-admin.html")),
};

if (
  !checks.auctionStart
  || !checks.taskStart
  || !checks.frontendAuction
  || !checks.secondClock
  || checks.stockUniverseCount < 4000
) {
  throw new Error(`09:15实时补丁验证失败：${JSON.stringify(checks)}`);
}

console.log(JSON.stringify(checks, null, 2));
