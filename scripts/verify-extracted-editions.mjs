import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";

const stageRoot = path.resolve(process.argv[2] || "");
if (!stageRoot || !fs.existsSync(stageRoot)) {
  throw new Error("用法：node scripts/verify-extracted-editions.mjs <四版本提取目录>");
}

const EDITIONS = [
  {result: "后勤部.json", mode: "member", quant: false, admin: false, privateKey: false, shortline: false},
  {result: "基础版.json", mode: "basic", quant: true, admin: false, privateKey: false, shortline: false},
  {result: "自用版.json", mode: "self", quant: true, admin: true, privateKey: true, shortline: false},
  {result: "定制版.json", mode: "custom", quant: true, admin: false, privateKey: false, shortline: true},
];

function walk(directory, predicate, rows = []) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath, predicate, rows);
    else if (entry.isFile() && predicate(fullPath)) rows.push(fullPath);
  }
  return rows;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function syntaxCheck(appRoot) {
  const files = walk(appRoot, (filePath) => filePath.endsWith(".js"));
  for (const filePath of files) {
    const result = spawnSync(process.execPath, ["--check", filePath], {encoding: "utf8"});
    if (result.status !== 0) {
      throw new Error(`${filePath}\n${result.stderr || result.stdout || "JavaScript 语法检查失败"}`);
    }
  }
  return files.length;
}

function verifyCachedAssets(appRoot, serviceWorker) {
  const assets = [...serviceWorker.matchAll(/^\s*"\/app\/([^"]*)",?$/gm)].map((match) => match[1]);
  const missing = assets.filter((relative) => {
    const target = relative ? path.join(appRoot, ...relative.split("/")) : path.join(appRoot, "index.html");
    return !fs.existsSync(target);
  });
  assert(!missing.length, `离线缓存缺少资源：${missing.join(", ")}`);
  return assets.length;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function verifyHistory(runtimeRoot, mode) {
  const historyRoot = path.join(runtimeRoot, "数据历史");
  const structuredRoot = path.join(historyRoot, "结构化复盘历史");
  const dailyRoot = path.join(historyRoot, "每日完整数据");
  assert(fs.existsSync(structuredRoot), `${mode} 缺少结构化历史目录`);
  assert(fs.existsSync(dailyRoot), `${mode} 缺少每日完整数据目录`);
  const dates = fs.readdirSync(structuredRoot, {withFileTypes: true})
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert(dates.length >= 15, `${mode} 近期结构化历史少于15个交易日`);
  const required = ["market.json", "indices.json", "sectors.json", "stocks.json", "analysis.json", "health.json", "manifest.json"];
  let limitedDates = 0;
  for (const date of dates) {
    const root = path.join(structuredRoot, date);
    for (const filename of required) assert(fs.existsSync(path.join(root, filename)), `${mode} ${date} 缺少 ${filename}`);
    const indices = readJson(path.join(root, "indices.json"));
    const sectors = readJson(path.join(root, "sectors.json"));
    const manifest = readJson(path.join(root, "manifest.json"));
    assert(indices.tradeDate === date, `${mode} ${date} 指数交易日不一致`);
    assert(sectors.tradeDate === date, `${mode} ${date} 板块交易日不一致`);
    assert(Array.isArray(indices.items) && indices.items.length >= 8, `${mode} ${date} 主要指数不完整`);
    assert((sectors.industry?.rows || []).length >= 20, `${mode} ${date} 行业榜不完整`);
    assert((sectors.concept?.rows || []).length >= 20, `${mode} ${date} 概念榜不完整`);
    if ((manifest.limitations || []).length) limitedDates += 1;
  }
  const dailyDates = fs.readdirSync(dailyRoot)
    .map((name) => name.match(/^(\d{4}-\d{2}-\d{2})_完整复盘数据\.json$/u)?.[1])
    .filter(Boolean);
  assert(dailyDates.length >= 15, `${mode} 每日完整数据少于15个交易日`);
  return {dates: dates.length, dailyDates: dailyDates.length, limitedDates};
}

const results = [];
for (const edition of EDITIONS) {
  const extraction = JSON.parse(fs.readFileSync(path.join(stageRoot, edition.result), "utf8"));
  const appRoot = path.join(extraction.runtimeRoot, "程序", "应用");
  const index = fs.readFileSync(path.join(appRoot, "index.html"), "utf8");
  const service = fs.readFileSync(path.join(appRoot, "backend", "复盘同步服务.js"), "utf8");
  const serviceWorker = fs.readFileSync(path.join(appRoot, "sw.js"), "utf8");
  const backend = path.join(appRoot, "backend");
  const tradingAdapter = fs.readFileSync(path.join(backend, "打开通达信日K.ps1"), "utf8");

  assert(tradingAdapter.includes("FeatureUsage\\$category"), `${edition.mode} 缺少本机交易软件使用频率读取`);
  assert(tradingAdapter.includes("selectedCandidateCount=1"), `${edition.mode} 未锁定唯一交易软件候选`);
  assert(!tradingAdapter.includes("foreach($candidate in $candidates)"), `${edition.mode} 仍会顺序启动多个交易软件`);

  assert(index.includes('id="appViewport"'), `${edition.mode} 缺少页面缩放容器`);
  assert(index.includes('id="zoomRange"'), `${edition.mode} 缺少页面缩放控件`);
  assert(index.includes('id="fontSizeButton"'), `${edition.mode} 缺少字号控件`);
  assert(index.includes('id="indexPicker"'), `${edition.mode} 缺少指数选择器`);
  assert(index.includes('id="indexCount">8/8'), `${edition.mode} 缺少指数上限状态`);
  assert(fs.existsSync(path.join(appRoot, "assets", "js", "display-settings.js")), `${edition.mode} 缺少显示设置模块`);
  assert(fs.existsSync(path.join(appRoot, "assets", "js", "index-workspace.js")), `${edition.mode} 缺少指数工作区模块`);
  assert(fs.existsSync(path.join(appRoot, "assets", "js", "persistent-settings.js")), `${edition.mode} 缺少持久设置模块`);
  assert(fs.existsSync(path.join(backend, "用户设置.js")), `${edition.mode} 缺少用户设置服务`);
  assert(fs.existsSync(path.join(backend, "index-catalog.js")), `${edition.mode} 缺少指数目录服务`);
  assert(fs.existsSync(path.join(backend, "index-intraday.js")), `${edition.mode} 缺少指数分时服务`);
  assert(service.includes('"/api/v1/index-catalog"'), `${edition.mode} 缺少指数目录 API`);
  assert(service.includes('"/api/v1/index-trend"'), `${edition.mode} 缺少指数分时 API`);
  assert(service.includes('"/api/v1/app-update/status"'), `${edition.mode} 缺少软件更新状态 API`);
  assert(service.includes("userPreferences.handleRequest"), `${edition.mode} 缺少用户设置 API`);

  const hasQuant = index.includes("quant.html");
  const hasAdmin = index.includes("member-admin.html");
  const hasShortline = index.includes("shortline.html");
  const hasPrivateKey = fs.existsSync(path.join(backend, "会员私钥.pem"));
  assert(hasQuant === edition.quant, `${edition.mode} 量化功能边界错误`);
  assert(hasAdmin === edition.admin, `${edition.mode} 会员管理边界错误`);
  assert(hasShortline === edition.shortline, `${edition.mode} 短线功能边界错误`);
  assert(hasPrivateKey === edition.privateKey, `${edition.mode} 私钥边界错误`);
  if (edition.mode === "member") assert(index.includes('data-member-feature="自选板块分时"'), "会员版解锁边界丢失");
  if (edition.mode === "basic" || edition.mode === "custom") {
    assert(!index.includes("data-member-feature="), `${edition.mode} 不应保留会员遮罩`);
    assert(!index.includes('id="membershipButton"'), `${edition.mode} 不应显示会员开通按钮`);
  }
  if (edition.mode === "custom") {
    assert(service.includes("createShortlineService"), "定制版短线服务丢失");
    assert(service.includes("handleShortlineRequest"), "定制版短线路由丢失");
    assert(service.includes("3.20.1-shortline-v1"), "定制版服务版本未升级");
  }
  assert(
    serviceWorker.includes(`a-share-review-v87-single-trading-app-${edition.mode}`),
    `${edition.mode} 离线缓存版本未隔离`,
  );

  const history = verifyHistory(extraction.runtimeRoot, edition.mode);
  results.push({
    mode: edition.mode,
    appRoot,
    jsFiles: syntaxCheck(appRoot),
    cachedAssets: verifyCachedAssets(appRoot, serviceWorker),
    quant: hasQuant,
    admin: hasAdmin,
    privateKey: hasPrivateKey,
    shortline: hasShortline,
    history,
  });
}

console.log(JSON.stringify({ok: true, results}, null, 2));
