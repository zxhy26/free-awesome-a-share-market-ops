const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = path.join(root, "app");
const readApp = (relativePath) => fs.readFileSync(path.join(app, relativePath), "utf8");
const readRoot = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const {
  APP_PROFILES,
  buildDeepLink,
  normalizeTarget,
  platformName,
} = require("../mobile/mobile-trading-app");

test("desktop quote actions use the current-device trading application service", () => {
  const api = readApp(path.join("assets", "js", "api.js"));
  assert.match(api, /new URL\("\/stock-open", SERVICE_ORIGIN\)/);
  assert.match(api, /method:\s*"POST"/);
  assert.match(api, /result\.directNavigation === true/);
  assert.match(api, /result\.verifiedTarget === true/);
  assert.match(api, /result\.verifiedPage === true/);
  assert.match(api, /result\.targetPage === "dailyK"/);
  assert.match(api, /globalThis\.AShareTradingApp/);
  assert.doesNotMatch(api, /pages\/market-detail\.html|internalMarketDetail/);

  const service = readApp(path.join("backend", "复盘同步服务.js"));
  assert.match(service, /\["\/stock-open", "\/tdx-stock", "\/tdx-sector"\]/);
  assert.match(service, /args\.push\("-Market", market, "-Name", name, "-NoWebFallback"\)/);
  assert.doesNotMatch(service, /"-PreferredApp", "tongdaxin", "-StrictPreferred"/);
  assert.doesNotMatch(service, /api\/v1\/market-detail|createMarketDetailDataService/);
});

test("Windows adapter discovers installed market applications without a webpage fallback", () => {
  const adapter = readApp(path.join("backend", "打开通达信日K.ps1"));
  assert.match(adapter, /Add-Running;Add-Configured;Add-Shortcuts;Add-Registry;Add-CommonPaths/);
  assert.match(adapter, /CurrentVersion\\Uninstall/);
  assert.match(adapter, /通达信/);
  assert.match(adapter, /同花顺/);
  assert.match(adapter, /大智慧/);
  assert.match(adapter, /指南针/);
  assert.match(adapter, /券商行情软件/);
  assert.match(adapter, /verifiedTarget=\$true/);
  assert.match(adapter, /directNavigation=\$true/);
  assert.match(adapter, /verifiedPage=\$true/);
  assert.match(adapter, /targetPage="dailyK"/);
  assert.match(adapter, /method="exec_to_tdx"/);
  assert.match(adapter, /http:\/\/www\.treeid\/code_\$stockCode/);
  assert.match(adapter, /targetAndDailyKWindow/);
  assert.match(adapter, /TRADING_APP_LOGIN_REQUIRED/);
  assert.match(adapter, /function Resolve-TdxSectorCode/);
  assert.match(adapter, /T0002\\hq_cache\\\$name/);
  assert.match(adapter, /GetEncoding\(936\)/);
  assert.match(adapter, /Invoke-TdxDirectNavigation \$query/);
  assert.match(adapter, /function Match-TitleTarget/);
  assert.match(adapter, /板块标题误命中拦截自检失败/);
  assert.match(adapter, /webFallback=\$false/);
  assert.match(adapter, /function Find-StockApps/);
  assert.match(adapter, /FeatureUsage\\\$category/);
  assert.match(adapter, /function Candidate-Usage/);
  assert.match(adapter, /function Sort-CandidatesByUsage/);
  assert.match(adapter, /selectedCandidateCount=1/);
  assert.match(adapter, /不会继续启动其他候选/);
  assert.doesNotMatch(adapter, /foreach\(\$candidate in \$candidates\)/);
  assert.doesNotMatch(adapter, /已自动尝试本机 \$\(\$candidates\.Count\) 个交易软件候选/);
  assert.doesNotMatch(adapter, /quote\.eastmoney\.com|so\.eastmoney\.com|Open-Web|Web-Url/);
});

test("generated Windows pages use the active local service origin", () => {
  const updater = readApp(path.join("backend", "自动更新A股田字格.js"));
  assert.match(updater, /return "\/stock-open\?code="/);
  assert.doesNotMatch(updater, /127\.0\.0\.1:18765\/stock-open/);
  assert.doesNotMatch(updater, /网页行情兜底/);
});

test("mobile adapter normalizes stocks and sectors and builds device deep links", () => {
  assert.deepEqual(APP_PROFILES.map((item) => item.id), [
    "eastmoney",
    "tonghuashun",
    "xueqiu",
    "tongdaxin",
  ]);
  const stock = normalizeTarget({code: "600000", name: "浦发银行"});
  assert.equal(stock.symbol, "SH600000");
  assert.equal(
    buildDeepLink("eastmoney", stock, "ios"),
    "eastmoney://page/geguxiangqing/stockcode=SH|600000",
  );
  assert.equal(
    buildDeepLink("eastmoney", stock, "android"),
    "dfcft://stock?stockcode=SH|600000",
  );
  assert.equal(buildDeepLink("xueqiu", stock, "android"), "xueqiu://stock/SH600000");

  const sector = normalizeTarget({code: "880123", market: "sector", name: "通信设备"});
  assert.equal(sector.query, "通信设备");
  assert.match(buildDeepLink("tongdaxin", sector, "android"), /^tdx:\/\/search\?keyword=/);
  assert.equal(platformName("Mozilla/5.0 (iPhone)"), "ios");
});

test("text content remains internal while market-detail assets are removed", () => {
  const navigation = readApp(path.join("assets", "js", "internal-navigation.js"));
  assert.match(navigation, /pages\/content-detail\.html/);
  assert.match(navigation, /MutationObserver/);
  assert.equal(fs.existsSync(path.join(app, "pages", "market-detail.html")), false);
  assert.equal(fs.existsSync(path.join(app, "assets", "js", "internal-market-detail.js")), false);
  assert.equal(fs.existsSync(path.join(app, "backend", "market-detail-data.js")), false);

  const serviceWorker = readApp("sw.js");
  assert.match(serviceWorker, /pages\/content-detail\.html/);
  assert.doesNotMatch(serviceWorker, /market-detail/);

  const mobileBuilder = readRoot(path.join("scripts", "build-mobile-pwa.mjs"));
  assert.match(mobileBuilder, /mobile-trading-app\.js/);
  assert.doesNotMatch(mobileBuilder, /mobile-market-detail\.js/);

  const payloadPatcher = readRoot(path.join("scripts", "apply-trading-app-navigation-to-payload.mjs"));
  assert.match(payloadPatcher, /POST \/stock-open/);
  assert.match(payloadPatcher, /internalMarketPageRemoved/);
});
