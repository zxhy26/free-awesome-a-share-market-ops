import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const sourceApp = path.join(repoRoot, "app");
const stageRoot = path.resolve(process.argv[2] || "");

if (!stageRoot || !fs.existsSync(stageRoot)) {
  throw new Error("用法：node scripts/apply-display-index-to-extracted-editions.mjs <四版本提取目录>");
}

const EDITIONS = [
  {result: "后勤部.json", mode: "member"},
  {result: "基础版.json", mode: "basic"},
  {result: "自用版.json", mode: "self"},
  {result: "定制版.json", mode: "custom"},
];

function copyTree(source, destination, options = {}) {
  fs.mkdirSync(destination, {recursive: true});
  for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const relativePath = path.relative(sourceApp, sourcePath).replaceAll("\\", "/");
    if (options.skip?.has(relativePath)) continue;
    if (entry.isDirectory()) {
      copyTree(sourcePath, destinationPath, options);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(destinationPath), {recursive: true});
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function insertAfter(html, needle, addition, label) {
  if (!html.includes(needle)) throw new Error(`首页缺少${label}插入点。`);
  return html.replace(needle, `${needle}\n${addition}`);
}

function buildIndex(mode) {
  let html = fs.readFileSync(path.join(sourceApp, "index.html"), "utf8");
  const derivativesLink = '      <a class="button" href="/app/pages/derivatives.html" data-member-feature="机构动向"><span aria-hidden="true">⇄</span><span>机构动向</span></a>';
  const summaryButton = '      <button class="button" id="summaryButton" type="button"><span aria-hidden="true">▤</span><span>市场总结</span></button>';

  if (mode === "basic" || mode === "self" || mode === "custom") {
    html = insertAfter(
      html,
      derivativesLink,
      '      <a class="button" href="/app/pages/quant.html"><span aria-hidden="true">⌁</span><span>量化选股</span></a>',
      "量化选股",
    );
  }
  if (mode === "self") {
    html = insertAfter(
      html,
      '      <a class="button" href="/app/pages/quant.html"><span aria-hidden="true">⌁</span><span>量化选股</span></a>',
      '      <a class="button" href="/app/pages/member-admin.html"><span aria-hidden="true">◇</span><span>会员管理</span></a>',
      "会员管理",
    );
  }
  if (mode === "custom") {
    html = insertAfter(
      html,
      summaryButton,
      '      <a class="button shortline-entry" href="/app/pages/shortline.html"><span aria-hidden="true">↗</span><span>短线</span></a>',
      "短线模型",
    );
  }
  if (mode === "basic" || mode === "custom") {
    html = html
      .replaceAll(/ data-member-feature="[^"]+"/g, "")
      .replace(/\r?\n\s*<button class="button membership-trigger"[\s\S]*?<\/button>/, "")
      .replace(/\r?\n\s*<link rel="stylesheet" href="assets\/css\/membership\.css[^"]*">/, "")
      .replace(/\r?\n\s*<script type="module" src="assets\/js\/membership\.js[^"]*"><\/script>/, "");
  }
  return html;
}

function buildServiceWorker(mode) {
  let source = fs.readFileSync(path.join(sourceApp, "sw.js"), "utf8");
  source = source.replace(
    /const CACHE_VERSION = "[^"]+";/,
    `const CACHE_VERSION = "a-share-review-v84-cls-index-annotations-${mode}";`,
  );
  const extras = [];
  if (["basic", "self", "custom"].includes(mode)) {
    extras.push(
      "/app/pages/quant.html",
      "/app/assets/js/quant-page.js",
      "/app/data/quant.json",
    );
  }
  if (mode === "self") {
    extras.push(
      "/app/pages/member-admin.html",
      "/app/assets/js/member-admin.js",
      "/app/assets/css/member-admin.css",
    );
  }
  if (mode === "custom") {
    extras.push(
      "/app/pages/shortline.html",
      "/app/assets/js/shortline-page.js",
      "/app/assets/css/shortline.css",
    );
  }
  const marker = '  "/app/manifest.webmanifest"';
  if (!source.includes(marker)) throw new Error("Service Worker 缺少资源插入点。");
  if (extras.length) {
    source = source.replace(marker, `${extras.map((item) => `  "${item}",`).join("\n")}\n${marker}`);
  }
  return source;
}

function insertBefore(source, needle, addition, label) {
  if (source.includes(addition.trim())) return source;
  if (!source.includes(needle)) throw new Error(`定制版服务缺少${label}插入点。`);
  return source.replace(needle, `${addition}${needle}`);
}

function patchCustomService(servicePath) {
  let source = fs.readFileSync(servicePath, "utf8");
  source = insertBefore(
    source,
    'const { createBoardIntradayService } = require("./board-intraday");',
    'const { createBoardMinuteFlowService } = require("./board-minute-flow");\n',
    "板块资金模块",
  );
  if (!source.includes('require("./index-contribution-online")')) {
    source = insertBefore(
      source,
      'const { createMarketDetailDataService } = require("./market-detail-data");',
      'const { refreshIndexContribution } = require("./index-contribution-online");\n',
      "在线指数贡献",
    );
  }
  source = insertBefore(
    source,
    'const { createMarketDetailDataService } = require("./market-detail-data");',
    'const { createIndexIntradayService } = require("./index-intraday");\nconst { createAppUpdateService } = require("./app-update");\n',
    "指数与更新服务",
  );
  source = source.replace(
    /const SERVICE_VERSION = "[^"]+";/,
    'const SERVICE_VERSION = "3.17.1-shortline-v1";',
  );

  source = insertBefore(
    source,
    "const membership = createMembershipService({",
    `const appUpdate = createAppUpdateService({
  edition: APP_EDITION,
  appDir: APP_DIR,
  runtimeRoot: PORTABLE_ROOT || path.resolve(APP_DIR, "..", ".."),
  workDir: WORK_DIR,
  log,
});
`,
    "软件更新实例",
  );
  source = insertBefore(
    source,
    "const boardIntraday = createBoardIntradayService();",
    `const boardMinuteFlow = createBoardMinuteFlowService({
  cachePaths: [
    PORTABLE_ROOT ? path.join(PORTABLE_ROOT, "缓存", "A股板块资金分时缓存.json") : "",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "A股复盘软件运行文件", "定制版", "共享数据", "A股板块资金分时缓存.json")
      : "",
  ].filter(Boolean),
});
`,
    "板块资金实例",
  );
  source = insertBefore(
    source,
    "const marketDetailData = createMarketDetailDataService({boardIntraday});",
    `const indexIntraday = createIndexIntradayService({
  marketDataPath: path.join(DATA_DIR, "market.json"),
});
`,
    "指数分时实例",
  );

  const liveRoute = '  if (url.pathname === "/api/v1/live/sector-flows" && req.method === "GET") {';
  const routeBlock = `  if (url.pathname === "/api/v1/app-update/status" && req.method === "GET") {
    sendJson(res, 200, appUpdate.getStatus());
    return;
  }

  if (url.pathname === "/api/v1/app-update/check" && req.method === "GET") {
    const result = await appUpdate.checkForUpdates({force: url.searchParams.get("force") === "1"});
    sendJson(res, result.ok ? 200 : 502, result);
    return;
  }

  if (url.pathname === "/api/v1/app-update/install") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }
    const result = appUpdate.startInstall();
    sendJson(res, result.ok ? 202 : 409, result);
    return;
  }

  if (url.pathname === "/api/v1/index-catalog" && req.method === "GET") {
    sendJson(res, 200, indexIntraday.getCatalog());
    return;
  }

  if (url.pathname === "/api/v1/index-trend" && req.method === "GET") {
    try {
      sendJson(res, 200, await indexIntraday.getTimeline(
        url.searchParams.get("key") || "",
        url.searchParams.get("tradeDate") || "",
      ));
    } catch (error) {
      sendJson(res, error.statusCode || 502, {
        ok: false,
        errorCode: error.code || "INDEX_INTRADAY_UNAVAILABLE",
        message: error.message || "指数分时暂不可用",
      });
    }
    return;
  }

`;
  source = insertBefore(source, liveRoute, routeBlock, "指数 API");

  const stockRoute = '  if (url.pathname === "/api/v1/stocks/search" && req.method === "GET") {';
  const boardRoutes = `  if (url.pathname === "/api/v1/sector-flow" && req.method === "GET") {
    try {
      sendJson(res, 200, await boardMinuteFlow.getTimeline(
        url.searchParams.get("code") || "",
        url.searchParams.get("name") || "",
      ));
    } catch (error) {
      sendJson(res, error.statusCode || 502, {
        ok: false,
        errorCode: error.code || "BOARD_FLOW_UNAVAILABLE",
        message: error.message || "板块分钟资金暂不可用",
      });
    }
    return;
  }

  if (url.pathname === "/api/v1/sector-trend" && req.method === "GET") {
    try {
      sendJson(res, 200, await boardIntraday.getTimeline(
        url.searchParams.get("code") || "",
        url.searchParams.get("name") || "",
        url.searchParams.get("tradeDate") || "",
      ));
    } catch (error) {
      sendJson(res, error.statusCode || 502, {
        ok: false,
        errorCode: error.code || "BOARD_INTRADAY_UNAVAILABLE",
        message: error.message || "板块指数分时暂不可用",
      });
    }
    return;
  }

`;
  source = insertBefore(source, stockRoute, boardRoutes, "板块 API");
  fs.writeFileSync(servicePath, source, "utf8");
}

const results = [];
for (const edition of EDITIONS) {
  const resultPath = path.join(stageRoot, edition.result);
  if (!fs.existsSync(resultPath)) throw new Error(`缺少提取结果：${resultPath}`);
  const extraction = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const targetApp = path.join(extraction.runtimeRoot, "程序", "应用");
  if (!fs.existsSync(path.join(targetApp, "index.html"))) {
    throw new Error(`找不到${edition.mode}应用目录：${targetApp}`);
  }

  copyTree(path.join(sourceApp, "assets"), path.join(targetApp, "assets"));
  copyTree(path.join(sourceApp, "pages"), path.join(targetApp, "pages"));
  copyTree(path.join(sourceApp, "backend"), path.join(targetApp, "backend"), {
    skip: edition.mode === "custom" ? new Set(["backend/复盘同步服务.js"]) : new Set(),
  });
  fs.copyFileSync(path.join(sourceApp, "manifest.webmanifest"), path.join(targetApp, "manifest.webmanifest"));
  fs.writeFileSync(path.join(targetApp, "index.html"), buildIndex(edition.mode), "utf8");
  fs.writeFileSync(path.join(targetApp, "sw.js"), buildServiceWorker(edition.mode), "utf8");
  if (edition.mode === "custom") {
    patchCustomService(path.join(targetApp, "backend", "复盘同步服务.js"));
  }
  results.push({
    mode: edition.mode,
    appRoot: targetApp,
    files: fs.readdirSync(targetApp, {recursive: true}).length,
  });
}

console.log(JSON.stringify({ok: true, stageRoot, editions: results}, null, 2));
