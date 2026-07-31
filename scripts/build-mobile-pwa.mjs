import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const mobileTemplateDir = path.join(repoRoot, "mobile");
const packageInfo = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const mobileReleaseRevision = "cls-plate-prefs-1";

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const [key, inlineValue] = token.slice(2).split("=", 2);
    values[key] = inlineValue ?? argv[++index];
  }
  return values;
}

function requiredDirectory(value, label) {
  const resolved = path.resolve(String(value || ""));
  if (!value || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label}不存在：${resolved}`);
  }
  return resolved;
}

function copyDirectory(source, target) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(target, {recursive: true});
  for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, content.replace(/\r?\n/g, "\n"), "utf8");
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, value, pretty = false) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, JSON.stringify(value, null, pretty ? 2 : 0), "utf8");
}

function marketMinuteToTime(rawMinute) {
  const minute = Math.max(0, Math.min(240, Number(rawMinute) || 0));
  const totalMinutes = minute <= 120 ? 570 + minute : 780 + minute - 120;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.floor(totalMinutes % 60);
  const seconds = Math.round((totalMinutes - Math.floor(totalMinutes)) * 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function latestMarketMinute(indices) {
  const values = [];
  for (const item of indices?.items || []) {
    const overseas = item?.session === "us"
      || item?.key === "usIXIC"
      || item?.code === "IXIC"
      || item?.name === "纳斯达克";
    if (overseas) continue;
    for (const point of item?.points || []) {
      const minute = Number(point?.minute);
      if (Number.isFinite(minute)) values.push(minute);
    }
  }
  return values.length ? Math.max(...values) : 240;
}

function createLiveFallback(dataDir) {
  const sectors = readJson(path.join(dataDir, "sectors.json"), {});
  const indices = readJson(path.join(dataDir, "indices.json"), {});
  const market = readJson(path.join(dataDir, "market.json"), {});
  const minute = latestMarketMinute(indices);
  const groups = {};
  for (const key of ["industry", "concept"]) {
    const group = sectors?.[key] || {};
    groups[key] = {
      key,
      title: group.title || (key === "industry" ? "二级行业板块" : "概念板块"),
      rows: (group.rows || []).map((row) => ({
        code: row.code || row.boardCode || "",
        name: row.name || row.tdxName || "",
        amount: Number(row.amount),
        changePct: Number.isFinite(Number(row.changePct)) ? Number(row.changePct) : null,
        sourceTimestamp: Number.isFinite(Number(row.timestamp)) ? Number(row.timestamp) : null,
      })).filter((row) => /^BK\d{4}$/.test(row.code) && row.name && Number.isFinite(row.amount)),
    };
  }
  return {
    ok: true,
    active: false,
    marketPhase: "已验证快照",
    tradeDate: sectors.tradeDate || indices.tradeDate || market.tradeDate || market.market?.tradeDate || "",
    sequence: 0,
    fetchedAt: sectors.syncedAt || indices.syncedAt || market.syncedAt || "",
    sourceTimestamp: null,
    sourceTime: marketMinuteToTime(minute),
    marketMinute: minute,
    sourceLatencyMs: 0,
    groupTimestampSkewMs: 0,
    consecutiveErrors: 0,
    source: "发行包内已验证真实快照",
    methodology: "公开实时接口完整性不足时，仅保留发行包中的最后一份已验证真实数据，不生成或外推数据。",
    groups,
    indices: [],
  };
}

function buildHistory(historySource, targetDataDir, latestTradeDate) {
  const targetDir = path.join(targetDataDir, "history");
  fs.mkdirSync(targetDir, {recursive: true});
  if (!historySource || !fs.existsSync(historySource)) {
    writeJson(path.join(targetDataDir, "history-index.json"), {
      version: 1,
      generatedAt: new Date().toISOString(),
      latestDate: "",
      count: 0,
      dates: [],
    });
    return [];
  }
  const dates = fs.readdirSync(historySource, {withFileTypes: true})
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((date) => !latestTradeDate || date <= latestTradeDate)
    .sort();
  const built = [];
  for (const date of dates) {
    const sourceDir = path.join(historySource, date);
    const market = readJson(path.join(sourceDir, "market.json"));
    const indices = readJson(path.join(sourceDir, "indices.json"));
    const sectors = readJson(path.join(sourceDir, "sectors.json"));
    const analysis = readJson(path.join(sourceDir, "analysis.json"));
    if (!market || !indices || !sectors || !analysis) continue;
    writeJson(path.join(targetDir, `${date}.json`), {
      ok: true,
      tradeDate: date,
      market,
      indices,
      sectors,
      analysis,
    });
    built.push(date);
  }
  const descending = [...built].sort().reverse();
  writeJson(path.join(targetDataDir, "history-index.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    latestDate: descending[0] || "",
    count: descending.length,
    dates: descending.map((date) => ({date, type: "structured"})),
  });
  return descending;
}

function injectMobileHead(html, prefix, edition) {
  if (html.includes("mobile-runtime.js")) return html;
  const additions = [
    `<meta name="apple-mobile-web-app-capable" content="yes">`,
    `<meta name="apple-mobile-web-app-status-bar-style" content="default">`,
    `<meta name="apple-mobile-web-app-title" content="${edition === "self" ? "复盘自用版" : "大A后勤部"}">`,
    `<meta name="format-detection" content="telephone=no">`,
    `<link rel="apple-touch-icon" href="${prefix}assets/icons/icon-192.png">`,
    `<link rel="manifest" href="${prefix}manifest.webmanifest">`,
    `<link rel="stylesheet" href="${prefix}assets/css/mobile.css?v=${packageInfo.version}">`,
    `<script src="${prefix}assets/js/mobile-runtime.js" data-edition="${edition}"></script>`,
    `<script src="${prefix}assets/js/mobile-live.js"></script>`,
    `<script src="${prefix}assets/js/mobile-trading-app.js"></script>`,
    `<script src="${prefix}assets/js/mobile-api-shim.js"></script>`,
    `<script src="${prefix}assets/js/mobile-internal-navigation.js"></script>`,
  ].join("\n  ");
  const withoutDuplicateManifest = html.replace(/\s*<link rel="manifest" href="[^"]+">\s*/i, "\n  ");
  return withoutDuplicateManifest.replace("</head>", `  ${additions}\n</head>`);
}

function rewriteHtmlFiles(targetDir, edition) {
  const htmlFiles = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.name.endsWith(".html")) htmlFiles.push(fullPath);
    }
  };
  visit(targetDir);
  for (const filePath of htmlFiles) {
    const isHome = path.basename(filePath).toLowerCase() === "index.html"
      && path.dirname(filePath) === targetDir;
    const prefix = isHome ? "" : "../";
    let html = fs.readFileSync(filePath, "utf8");
    html = injectMobileHead(html, prefix, edition);
    if (isHome) {
      html = html
        .replaceAll('href="/app/pages/', 'href="pages/')
        .replaceAll("href='/app/pages/", "href='pages/")
        .replaceAll(">A股复盘</h1>", edition === "self" ? ">A股复盘自用版</h1>" : ">大A后勤部</h1>")
        .replace(/<title>[^<]*<\/title>/i, `<title>${edition === "self" ? "A股复盘自用手机版" : "大A后勤部手机版"}</title>`);
      if (edition === "self") {
        html = html
          .replace(/^\s*<link rel="stylesheet" href="assets\/css\/membership\.css[^"]*">\s*$/m, "")
          .replace(/^\s*<script type="module" src="assets\/js\/membership\.js[^"]*"><\/script>\s*$/m, "")
          .replace(/^\s*<a class="button" href="pages\/member-admin\.html"[^>]*>.*?<\/a>\s*$/m, "")
          .replace(/\sdata-member-feature="[^"]*"/g, "")
          .replace(
            /<button class="button membership-trigger" id="membershipButton"[\s\S]*?<\/button>/,
            '<span class="button mobile-edition-badge" aria-label="自用手机版">自用手机版</span>',
          );
      }
    } else {
      html = html
        .replaceAll('href="/app/pages/', 'href="')
        .replaceAll("href='/app/pages/", "href='")
        .replaceAll('href="/app/"', 'href="../index.html"')
        .replaceAll("href='/app/'", "href='../index.html'");
    }
    writeText(filePath, html);
  }
}

function rewriteFrontendScripts(targetDir, edition) {
  const jsDir = path.join(targetDir, "assets", "js");
  for (const entry of fs.readdirSync(jsDir, {withFileTypes: true})) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const filePath = path.join(jsDir, entry.name);
    if ([
      "mobile-runtime.js",
      "mobile-live.js",
      "mobile-trading-app.js",
      "mobile-api-shim.js",
      "mobile-internal-navigation.js",
      "mobile-content-detail.js",
      "pwa.js",
      "membership-guard.js",
    ].includes(entry.name)) continue;
    let source = fs.readFileSync(filePath, "utf8");
    if (entry.name === "app.js") {
      source = source
        .replaceAll('"/app/pages/', '"pages/')
        .replaceAll("'/app/pages/", "'pages/")
        .replaceAll("`/app/pages/", "`pages/")
        .replace(
          "await refreshIndexContributionData({probe: true, silent: true});",
          `await refreshIndexContributionData({probe: ${edition === "self" ? "true" : "state.membershipActive"}, silent: true});`,
        );
      if (edition === "self") {
        source = source.replace("membershipActive: false,", "membershipActive: true,");
      }
    } else {
      source = source
        .replaceAll('back.href = "/app/";', 'back.href = "../index.html";')
        .replaceAll("back.href = '/app/';", "back.href = '../index.html';");
    }
    if (entry.name === "api.js") {
      source = source
        .replace(
          /const runtimeLocation = globalThis\.location \|\| \{protocol: "http:", origin: "http:\/\/127\.0\.0\.1:18765"\};\r?\nconst SERVICE_ORIGIN = runtimeLocation\.protocol === "http:" \|\| runtimeLocation\.protocol === "https:"\r?\n  \? runtimeLocation\.origin\r?\n  : "http:\/\/127\.0\.0\.1:18765";/,
          `const runtimeLocation = globalThis.location || {protocol: "https:", origin: ""};
const SERVICE_ORIGIN = runtimeLocation.protocol === "http:" || runtimeLocation.protocol === "https:"
  ? runtimeLocation.origin
  : new URL(globalThis.__A_SHARE_ROOT_URL__ || "../../", import.meta.url).origin;`,
        )
        .replace(
          'return runtimeLocation.protocol === "file:"',
          'return globalThis.__A_SHARE_MOBILE__ === true\n    || runtimeLocation.protocol === "file:"',
        );
    }
    writeText(filePath, source);
  }

  writeText(path.join(jsDir, "membership-guard.js"), `
async function enforceMembership() {
  try {
    const response = await fetch("/api/v1/membership/status", {cache: "no-store"});
    const membership = await response.json();
    if (response.ok && membership.active) return;
  } catch (_) {
  }
  const feature = document.title.split("｜")[0] || "该功能";
  location.replace(\`../index.html?member=required&feature=\${encodeURIComponent(feature)}\`);
}

enforceMembership();
`.trimStart());

  writeText(path.join(jsDir, "pwa.js"), `
export function initializePwa() {
  if (!("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;
  const toast = document.querySelector("#updateToast");
  const applyButton = document.querySelector("#applyUpdate");
  let waitingWorker = null;
  let reloading = false;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  const serviceWorkerUrl = new URL("../../sw.js", import.meta.url);
  navigator.serviceWorker.register(serviceWorkerUrl, {scope: new URL("../../", import.meta.url).pathname})
    .then((registration) => {
      const applyUpdate = (worker) => {
        if (!worker) return;
        waitingWorker = worker;
        if (toast) toast.hidden = true;
        worker.postMessage({type: "SKIP_WAITING"});
      };
      const showUpdate = (worker) => applyUpdate(worker);
      if (registration.waiting) showUpdate(registration.waiting);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdate(worker);
        });
      });
      applyButton?.addEventListener("click", () => {
        if (!waitingWorker) return location.reload();
        applyUpdate(waitingWorker);
      });
      registration.update().catch(() => null);
    })
    .catch((error) => console.error("[PWA] Service Worker 注册失败", error));
}
`.trimStart());
}

function createManifest(targetDir, edition) {
  const selfEdition = edition === "self";
  writeJson(path.join(targetDir, "manifest.webmanifest"), {
    id: selfEdition ? "./?edition=self-mobile" : "./?edition=member-mobile",
    name: selfEdition ? "A股复盘自用手机版" : "大A后勤部手机版",
    short_name: selfEdition ? "复盘自用版" : "大A后勤部",
    description: selfEdition
      ? "A股市场、板块、资金、情绪与量化战法复盘工具"
      : "A股市场、板块、资金、情绪与会员复盘工具",
    lang: "zh-CN",
    start_url: "./index.html",
    scope: "./",
    display: "standalone",
    orientation: "any",
    background_color: "#eef0f2",
    theme_color: "#eef0f2",
    icons: [
      {src: "assets/icons/icon-192.png", sizes: "192x192", type: "image/png"},
      {src: "assets/icons/icon-512.png", sizes: "512x512", type: "image/png"},
      {src: "assets/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable"},
    ],
  }, true);
}

function listCoreAssets(targetDir) {
  const assets = ["./", "./index.html", "./manifest.webmanifest"];
  const includeExtensions = new Set([".html", ".js", ".css", ".png", ".ico"]);
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const fullPath = path.join(directory, entry.name);
      const relative = path.relative(targetDir, fullPath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (relative === "data/history") continue;
        visit(fullPath);
        continue;
      }
      if (includeExtensions.has(path.extname(entry.name).toLowerCase())) assets.push(`./${relative}`);
    }
  };
  visit(path.join(targetDir, "pages"));
  visit(path.join(targetDir, "assets"));
  for (const name of [
    "market.json",
    "indices.json",
    "sectors.json",
    "stocks.json",
    "analysis.json",
    "health.json",
    "config.json",
    "live-sector-flows.json",
    "mobile-stock-directory.json",
  ]) {
    if (fs.existsSync(path.join(targetDir, "data", name))) assets.push(`./data/${name}`);
  }
  return [...new Set(assets)].sort();
}

function createServiceWorker(targetDir, edition, tradeDate) {
  const coreAssets = listCoreAssets(targetDir);
  const cacheVersion = `a-share-mobile-${edition}-${packageInfo.version}-${tradeDate || "latest"}-${mobileReleaseRevision}`;
  writeText(path.join(targetDir, "sw.js"), `
const CACHE_VERSION = ${JSON.stringify(cacheVersion)};
const CORE_CACHE = \`\${CACHE_VERSION}-core\`;
const DATA_CACHE = \`\${CACHE_VERSION}-data\`;
const APP_BASE = new URL("./", self.location.href);
const APP_PATH = APP_BASE.pathname;
const CORE_ASSETS = ${JSON.stringify(coreAssets, null, 2)}.map((item) => new URL(item, APP_BASE).href);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CORE_CACHE).then((cache) => cache.addAll(CORE_ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(CACHE_VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

async function networkFirst(request, cacheName, fallbackUrl = "") {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (_) {
    const cached = await cache.match(request) || await cache.match(request, {ignoreSearch: true});
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl) || await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    return new Response("离线状态下没有该资源的缓存。", {
      status: 503,
      headers: {"Content-Type": "text/plain; charset=utf-8"},
    });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CORE_CACHE);
  const cached = await cache.match(request);
  const update = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  if (cached) {
    update.catch(() => null);
    return cached;
  }
  return await update || new Response("资源暂不可用", {status: 503});
}

self.addEventListener("fetch", (event) => {
  const {request} = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(APP_PATH)) return;
  if (url.pathname.includes("/data/") || url.pathname.endsWith(".json") || url.pathname.endsWith(".pem")) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, CORE_CACHE, new URL("./index.html", APP_BASE).href));
    return;
  }
  if (/\\.(?:js|css|webmanifest)$/.test(url.pathname)) {
    event.respondWith(networkFirst(request, CORE_CACHE));
    return;
  }
  if (/\\.(?:png|ico|svg)$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
`.trimStart());
}

function createInstructions(targetDir, edition, historyDates, tradeDate) {
  const name = edition === "self" ? "A股复盘自用手机版" : "大A后勤部手机版";
  writeText(path.join(targetDir, "使用说明.txt"), `${name}

兼容系统：Android 8 及以上、iOS 15 及以上。
推荐浏览器：Android 使用 Chrome；iPhone 使用 Safari。

安装方法：
1. 将本文件夹完整上传到任意 HTTPS 静态网站，不能只上传 index.html。
2. Android 打开网站后，使用浏览器菜单“添加到主屏幕”。
3. iPhone 用 Safari 打开网站，点击分享按钮，再选择“添加到主屏幕”。

数据说明：
- 首页和历史回放内置最后一份已验证真实数据，当前数据交易日为 ${tradeDate || "待读取"}。
- 盘中联网时，指数与板块资金优先读取公开实时行情；接口不完整时保留最后一份已验证快照，不生成假数据。
- “同步市场”会重新读取公开行情和网站上发布的最新数据文件。
- 历史周回放已打包 ${historyDates.length} 个交易日。

安全说明：
- 手机版不包含 Windows 后台程序、通达信路径或会员私钥。
- 手机中的股票和板块日K按钮调用当前设备已安装的交易软件；首次选择后会记住该设备的交易软件。
- 政策、新闻和事件文字详情仍在复盘软件内展示，不跳转第三方行情网页。
- ${edition === "self"
    ? "自用手机版保留量化选股查看功能；激活码签发仍只在自用 Windows 版中进行。"
    : "后勤部手机版不包含量化选股；会员激活码仅在当前手机本地校验，激活码签发仍由自用 Windows 版完成。"}
`);
}

function copyMobileTemplates(targetDir) {
  copyDirectory(mobileTemplateDir, path.join(targetDir, ".mobile-template-copy"));
  for (const name of [
    "mobile-runtime.js",
    "mobile-live.js",
    "mobile-trading-app.js",
    "mobile-api-shim.js",
    "mobile-internal-navigation.js",
    "mobile-content-detail.js",
  ]) {
    fs.copyFileSync(path.join(mobileTemplateDir, name), path.join(targetDir, "assets", "js", name));
  }
  fs.copyFileSync(path.join(mobileTemplateDir, "mobile.css"), path.join(targetDir, "assets", "css", "mobile.css"));
  fs.copyFileSync(path.join(mobileTemplateDir, "mobile-detail.css"), path.join(targetDir, "assets", "css", "mobile-detail.css"));
  fs.copyFileSync(path.join(mobileTemplateDir, "pages", "content-detail.html"), path.join(targetDir, "pages", "content-detail.html"));
  fs.rmSync(path.join(targetDir, ".mobile-template-copy"), {recursive: true, force: true});
}

function buildEdition(options) {
  const edition = options.edition;
  const source = requiredDirectory(options.source, `${edition}版源目录`);
  const target = path.resolve(options.target);
  const dataSource = path.join(source, "data");
  const publicKeySource = path.join(source, "backend", "会员公钥.pem");

  fs.rmSync(target, {recursive: true, force: true});
  fs.mkdirSync(target, {recursive: true});
  fs.copyFileSync(path.join(source, "index.html"), path.join(target, "index.html"));
  copyDirectory(path.join(source, "pages"), path.join(target, "pages"));
  copyDirectory(path.join(source, "assets", "css"), path.join(target, "assets", "css"));
  copyDirectory(path.join(source, "assets", "icons"), path.join(target, "assets", "icons"));
  copyDirectory(path.join(source, "assets", "js"), path.join(target, "assets", "js"));
  copyDirectory(path.join(source, "assets", "payment"), path.join(target, "assets", "payment"));
  copyDirectory(dataSource, path.join(target, "data"));

  fs.rmSync(path.join(target, "pages", "market-detail.html"), {force: true});
  fs.rmSync(path.join(target, "assets", "js", "internal-market-detail.js"), {force: true});
  fs.rmSync(path.join(target, "pages", "member-admin.html"), {force: true});
  fs.rmSync(path.join(target, "assets", "js", "member-admin.js"), {force: true});
  fs.rmSync(path.join(target, "assets", "css", "member-admin.css"), {force: true});
  if (edition === "self") {
    fs.rmSync(path.join(target, "assets", "js", "membership.js"), {force: true});
  }
  if (fs.existsSync(publicKeySource)) {
    fs.copyFileSync(publicKeySource, path.join(target, "data", "会员公钥.pem"));
  } else {
    throw new Error(`会员公钥不存在：${publicKeySource}`);
  }

  copyMobileTemplates(target);

  const market = readJson(path.join(target, "data", "market.json"), {});
  const tradeDate = market.tradeDate || market.market?.tradeDate || "";
  writeJson(path.join(target, "data", "live-sector-flows.json"), createLiveFallback(path.join(target, "data")));
  const historyDates = buildHistory(options.historySource, path.join(target, "data"), tradeDate);

  if (options.stockIndexSource && fs.existsSync(options.stockIndexSource)) {
    fs.copyFileSync(options.stockIndexSource, path.join(target, "data", "mobile-stock-directory.json"));
  } else {
    writeJson(path.join(target, "data", "mobile-stock-directory.json"), {
      version: 1,
      updatedAt: "",
      count: 0,
      source: "全A股票名称索引未打包",
      items: [],
    });
  }

  rewriteHtmlFiles(target, edition);
  rewriteFrontendScripts(target, edition);
  createManifest(target, edition);
  createServiceWorker(target, edition, tradeDate);
  createInstructions(target, edition, historyDates, tradeDate);
  writeJson(path.join(target, "版本信息.json"), {
    name: edition === "self" ? "A股复盘自用手机版" : "大A后勤部手机版",
    edition,
    version: packageInfo.version,
    generatedAt: new Date().toISOString(),
    tradeDate,
    historyDates: historyDates.length,
    platforms: ["Android", "iOS"],
    packageType: "PWA",
    containsPrivateKey: false,
  }, true);

  return {
    edition,
    target,
    tradeDate,
    historyDates: historyDates.length,
    files: fs.readdirSync(target, {recursive: true}).length,
  };
}

const args = parseArguments(process.argv.slice(2));
const outputRoot = path.resolve(args.output || path.join(repoRoot, "dist", "mobile"));
const historySource = args["history-source"] ? path.resolve(args["history-source"]) : "";
const stockIndexSource = args["stock-index-source"] ? path.resolve(args["stock-index-source"]) : "";
const results = [
  buildEdition({
    edition: "member",
    source: args["member-source"],
    target: path.join(outputRoot, "大A后勤部_手机版"),
    historySource,
    stockIndexSource,
  }),
  buildEdition({
    edition: "self",
    source: args["self-source"],
    target: path.join(outputRoot, "A股复盘自用版_手机版"),
    historySource,
    stockIndexSource,
  }),
];

process.stdout.write(`${JSON.stringify({ok: true, outputRoot, results}, null, 2)}\n`);
