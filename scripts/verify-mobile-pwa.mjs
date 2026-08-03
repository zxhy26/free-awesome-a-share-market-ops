import fs from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const defaultReleaseRoot = path.resolve(repositoryRoot, "..", "A股复盘手机双版本");
const releaseRoot = path.resolve(process.argv[2] || defaultReleaseRoot);

const editions = [
  {
    key: "member",
    label: "大A后勤部手机版",
    root: path.join(releaseRoot, "大A后勤部_手机版"),
    requiresQuant: false,
  },
  {
    key: "self",
    label: "A股复盘自用版手机版",
    root: path.join(releaseRoot, "A股复盘自用版_手机版"),
    requiresQuant: true,
  },
];

const failures = [];

function assert(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function collectFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    failures.push(`${filePath}: JSON 解析失败：${error.message}`);
    return null;
  }
}

function localReferenceTarget(filePath, reference) {
  const cleanReference = reference.split("#", 1)[0].split("?", 1)[0].trim();
  if (
    !cleanReference ||
    cleanReference.startsWith("#") ||
    cleanReference.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(cleanReference)
  ) {
    return null;
  }

  let decodedReference = cleanReference;
  try {
    decodedReference = decodeURIComponent(cleanReference);
  } catch {
    // The browser will use the original path when a reference is not URI encoded.
  }

  return path.resolve(path.dirname(filePath), decodedReference);
}

function validateDocumentReferences(root, files) {
  const htmlAttributePattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  const cssUrlPattern = /url\(\s*["']?([^"'()]+)["']?\s*\)/gi;

  for (const filePath of files) {
    const extension = path.extname(filePath).toLowerCase();
    if (extension !== ".html" && extension !== ".css") {
      continue;
    }

    const content = fs.readFileSync(filePath, "utf8");
    const pattern = extension === ".html" ? htmlAttributePattern : cssUrlPattern;
    for (const match of content.matchAll(pattern)) {
      const target = localReferenceTarget(filePath, match[1]);
      if (target && !fs.existsSync(target)) {
        failures.push(
          `${path.relative(root, filePath)} 引用了不存在的资源 ${match[1]}`,
        );
      }
    }
  }
}

function validateServiceWorker(root) {
  const serviceWorkerPath = path.join(root, "sw.js");
  const content = fs.readFileSync(serviceWorkerPath, "utf8");
  const match = content.match(/const CORE_ASSETS = (\[[\s\S]*?\])\.map/);
  assert(Boolean(match), `${root}: sw.js 缺少可校验的 CORE_ASSETS`);
  if (!match) {
    return;
  }

  let assets = [];
  try {
    assets = JSON.parse(match[1]);
  } catch (error) {
    failures.push(`${serviceWorkerPath}: CORE_ASSETS 解析失败：${error.message}`);
    return;
  }

  for (const asset of assets) {
    const target = asset === "./" ? root : path.resolve(root, asset);
    assert(
      fs.existsSync(target),
      `${serviceWorkerPath}: 缓存资源不存在 ${asset}`,
    );
  }
}

function validateEdition(edition) {
  const { root, label, key, requiresQuant } = edition;
  assert(fs.existsSync(root), `${label}: 发行目录不存在`);
  if (!fs.existsSync(root)) {
    return null;
  }

  const files = collectFiles(root);
  const relativeFiles = files.map((filePath) =>
    path.relative(root, filePath).replaceAll("\\", "/"),
  );
  const requiredInternalDetailFiles = [
    "pages/content-detail.html",
    "assets/js/display-page-sync.js",
    "assets/js/mobile-trading-app.js",
    "assets/js/mobile-content-detail.js",
    "assets/js/mobile-internal-navigation.js",
    "assets/css/mobile-detail.css",
  ];
  for (const requiredFile of requiredInternalDetailFiles) {
    assert(
      relativeFiles.includes(requiredFile),
      `${label}: missing internal detail asset ${requiredFile}`,
    );
  }
  assert(
    !relativeFiles.includes("pages/market-detail.html") &&
      !relativeFiles.includes("assets/js/mobile-market-detail.js") &&
      !relativeFiles.includes("assets/js/internal-market-detail.js"),
    `${label}: 不得继续包含软件内日K详情页`,
  );
  const textExtensions = new Set([
    ".css",
    ".html",
    ".js",
    ".json",
    ".webmanifest",
    ".txt",
    ".pem",
  ]);
  const forbiddenPatterns = [
    { pattern: /\/app\//i, label: "固定 /app/ 路径" },
    { pattern: /127\.0\.0\.1/i, label: "本机 127.0.0.1 地址" },
    { pattern: /\blocalhost\b/i, label: "本机 localhost 地址" },
    { pattern: /member-admin/i, label: "会员管理页" },
    { pattern: /quote\.eastmoney\.com/i, label: "东财行情页跳转地址", navigationOnly: true },
    { pattern: /so\.eastmoney\.com/i, label: "东财搜索页跳转地址", navigationOnly: true },
  ];

  for (const filePath of files) {
    if (!textExtensions.has(path.extname(filePath).toLowerCase())) {
      continue;
    }
    const content = fs.readFileSync(filePath, "utf8");
    for (const forbidden of forbiddenPatterns) {
      if (
        forbidden.navigationOnly &&
        ![".css", ".html", ".js", ".webmanifest", ".txt"].includes(
          path.extname(filePath).toLowerCase(),
        )
      ) {
        continue;
      }
      assert(
        !forbidden.pattern.test(content),
        `${label}: ${path.relative(root, filePath)} 含有${forbidden.label}`,
      );
    }
  }

  assert(
    !relativeFiles.some((name) => /(^|\/)backend(\/|$)/i.test(name)),
    `${label}: 不得包含 Windows 后台`,
  );
  assert(
    !relativeFiles.some((name) => /私钥|private[-_ ]?key/i.test(name)),
    `${label}: 不得包含会员私钥`,
  );
  assert(
    fs.existsSync(path.join(root, "data", "会员公钥.pem")),
    `${label}: 缺少会员公钥`,
  );

  const quantFiles = relativeFiles.filter((name) => /quant/i.test(name));
  if (requiresQuant) {
    assert(
      quantFiles.includes("pages/quant.html") &&
        quantFiles.includes("assets/js/quant-page.js") &&
        quantFiles.includes("data/quant.json"),
      `${label}: 量化选股文件不完整`,
    );
    assert(
      !relativeFiles.includes("assets/js/membership.js"),
      `${label}: 自用版不应加载会员开通脚本`,
    );
  } else {
    assert(quantFiles.length === 0, `${label}: 不应包含量化选股文件`);
  }

  const manifestPath = path.join(root, "manifest.webmanifest");
  const manifest = readJson(manifestPath);
  if (manifest) {
    assert(manifest.start_url === "./index.html", `${label}: start_url 必须为相对路径`);
    assert(manifest.scope === "./", `${label}: scope 必须为相对路径`);
    assert(manifest.display === "standalone", `${label}: PWA display 必须为 standalone`);
    for (const icon of manifest.icons || []) {
      assert(
        fs.existsSync(path.resolve(root, icon.src)),
        `${label}: PWA 图标不存在 ${icon.src}`,
      );
    }
  }

  const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert(
    indexHtml.includes(`data-edition="${key}"`),
    `${label}: 手机运行模式标记不正确`,
  );
  assert(
    indexHtml.includes('name="viewport"'),
    `${label}: 缺少手机 viewport`,
  );
  assert(
    indexHtml.includes("apple-mobile-web-app-capable"),
    `${label}: 缺少 iOS PWA 元数据`,
  );
  assert(
    indexHtml.includes("mobile-internal-navigation.js"),
    `${label}: 缺少软件内跳转接管脚本`,
  );
  assert(
    indexHtml.includes("mobile-trading-app.js"),
    `${label}: 缺少当前设备交易软件适配脚本`,
  );

  const apiSource = fs.readFileSync(path.join(root, "assets", "js", "api.js"), "utf8");
  assert(
    apiSource.includes("AShareTradingApp") &&
      apiSource.includes("/stock-open") &&
      !apiSource.includes("internalMarketDetail"),
    `${label}: 日K按钮未改为当前设备交易软件`,
  );
  const mobileApiSource = fs.readFileSync(
    path.join(root, "assets", "js", "mobile-api-shim.js"),
    "utf8",
  );
  const mobileLiveSource = fs.readFileSync(
    path.join(root, "assets", "js", "mobile-live.js"),
    "utf8",
  );
  const mobileCssSource = fs.readFileSync(
    path.join(root, "assets", "css", "mobile.css"),
    "utf8",
  );
  assert(
    mobileApiSource.includes("/api/v1/index-catalog") &&
      mobileApiSource.includes("/api/v1/index-trend") &&
      mobileLiveSource.includes("loadIndexCatalog") &&
      mobileLiveSource.includes("loadIndexTrend"),
    `${label}: 主要指数自选和真实分时接口不完整`,
  );
  assert(
    mobileLiveSource.includes("sh000852") &&
      mobileLiveSource.includes("usIXIC"),
    `${label}: 19项主要指数目录未完整打包`,
  );
  assert(
    /\.mobile-pwa\s+#appViewport[\s\S]*?zoom:\s*1\s*!important/.test(mobileCssSource) &&
      /\.mobile-pwa\s+\.zoom-control[\s\S]*?display:\s*none\s*!important/.test(mobileCssSource),
    `${label}: 手机端没有锁定安全缩放布局`,
  );

  assert(
    /\.mobile-pwa\s+\.index-attributions\s+\.index-attribution:nth-child\(n\s*\+\s*4\)[\s\S]*?display:\s*none/.test(
      mobileCssSource,
    ),
    `${label}: mobile index annotations are not capped for narrow screens`,
  );

  const historyIndex = readJson(path.join(root, "data", "history-index.json"));
  if (historyIndex) {
    assert(historyIndex.count >= 15, `${label}: 历史交易日数量不得少于 15`);
    assert(
      historyIndex.dates?.length === historyIndex.count,
      `${label}: 历史索引数量不一致`,
    );
    for (const item of historyIndex.dates || []) {
      const historyPath = path.join(root, "data", "history", `${item.date}.json`);
      assert(fs.existsSync(historyPath), `${label}: 缺少历史数据 ${item.date}`);
      if (fs.existsSync(historyPath)) {
        readJson(historyPath);
      }
    }
  }
  const contentDetailSource = fs.readFileSync(
    path.join(root, "pages", "content-detail.html"),
    "utf8",
  );
  assert(
    /display-page-sync\.js/.test(contentDetailSource),
    `${label}: 内容详情页未接入字号与缩放同步`,
  );

  const liveFallback = readJson(path.join(root, "data", "live-sector-flows.json"));
  const baseIndices = readJson(path.join(root, "data", "indices.json"));
  if (liveFallback && baseIndices) {
    const domesticMinutes = (baseIndices.items || [])
      .filter((item) => item?.session !== "us" && item?.key !== "usIXIC"
        && item?.code !== "IXIC" && item?.name !== "纳斯达克")
      .flatMap((item) => (item?.points || []).map((point) => Number(point?.minute)))
      .filter(Number.isFinite);
    const expectedMinute = domesticMinutes.length ? Math.max(...domesticMinutes) : 240;
    assert(
      Number(liveFallback.marketMinute) === expectedMinute,
      `${label}: 离线快照时点被海外指数或未来时点污染`,
    );
  }

  const stockDirectory = readJson(
    path.join(root, "data", "mobile-stock-directory.json"),
  );
  if (stockDirectory) {
    assert(
      stockDirectory.count === 5544 &&
        stockDirectory.items?.length === stockDirectory.count,
      `${label}: 全 A 股票索引应包含 5544 只股票`,
    );
  }

  for (const filePath of files.filter((item) => item.endsWith(".json"))) {
    readJson(filePath);
  }

  validateDocumentReferences(root, files);
  validateServiceWorker(root);

  const bytes = files.reduce(
    (total, filePath) => total + fs.statSync(filePath).size,
    0,
  );
  return {
    edition: key,
    label,
    files: files.length,
    bytes,
    tradeDate: historyIndex?.latestDate || null,
    historyDates: historyIndex?.count || 0,
    stocks: stockDirectory?.count || 0,
    quant: requiresQuant,
  };
}

const results = editions.map(validateEdition).filter(Boolean);

if (failures.length > 0) {
  process.stderr.write(
    `手机 PWA 验收失败（${failures.length} 项）：\n${failures
      .map((item) => `- ${item}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify({ ok: true, releaseRoot, results }, null, 2)}\n`,
);
