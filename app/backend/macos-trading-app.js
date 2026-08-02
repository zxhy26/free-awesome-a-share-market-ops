const fs = require("fs");
const os = require("os");
const path = require("path");
const {execFile} = require("child_process");

const APP_PROFILES = Object.freeze([
  {id: "tongdaxin", priority: 100, names: ["通达信", "TongDaXin", "TDX"]},
  {id: "ths", priority: 90, names: ["同花顺", "iFinD", "THS"]},
  {id: "eastmoney", priority: 80, names: ["东方财富", "EastMoney", "Choice"]},
  {id: "broker", priority: 70, names: ["中信证券", "中金财富", "华泰证券", "国泰海通", "证券"]},
  {id: "xueqiu", priority: 50, names: ["雪球", "Xueqiu", "Snowball"]},
]);

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function profileForAppName(value) {
  const normalized = String(value || "").replace(/\.app$/i, "").trim().toLowerCase();
  return APP_PROFILES.find((profile) => profile.names.some((name) => normalized.includes(name.toLowerCase()))) || null;
}

function discoverMacTradingApps(options = {}) {
  const roots = options.roots || ["/Applications", path.join(os.homedir(), "Applications")];
  const configuredPath = String(options.configuredPath || process.env.A_SHARE_REVIEW_MAC_TRADING_APP || "").trim();
  const candidates = [];
  const seen = new Set();
  const add = (appPath, configured = false) => {
    const resolved = path.resolve(String(appPath || ""));
    if (!resolved.toLowerCase().endsWith(".app") || !fs.existsSync(resolved)) return;
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    const name = path.basename(resolved, ".app");
    const profile = profileForAppName(name);
    if (!profile && !configured) return;
    seen.add(key);
    candidates.push({
      id: profile?.id || "configured",
      name,
      path: resolved,
      priority: configured ? 1000 : profile.priority,
      configured,
    });
  };
  if (configuredPath) add(configuredPath, true);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
      if (entry.isDirectory() && entry.name.toLowerCase().endsWith(".app")) {
        add(path.join(root, entry.name));
      }
    }
  }
  return candidates;
}

function runFile(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {timeout: options.timeout || 20000, encoding: "utf8"}, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: Number.isInteger(error?.code) ? error.code : error ? null : 0,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || error?.message || "").trim(),
      });
    });
  });
}

function navigationQuery(target, app) {
  const code = String(target.code || "").trim();
  const name = String(target.name || "").trim();
  if (target.market === "sector" && app.id !== "tongdaxin") return name || code;
  return code || name;
}

function createMacTradingAppService(options = {}) {
  const platform = options.platform || process.platform;
  const statePath = path.resolve(
    options.statePath
      || process.env.A_SHARE_REVIEW_MAC_TRADING_STATE
      || path.join(os.homedir(), "Library", "Application Support", "A股复盘软件", "macOS交易软件.json"),
  );
  const execute = options.execute || runFile;

  function rankedApps() {
    const state = readJson(statePath, {});
    const usage = state.usage || {};
    return discoverMacTradingApps(options)
      .map((app) => ({...app, used: Number(usage[app.path]?.count) || 0, lastUsedAt: usage[app.path]?.lastUsedAt || ""}))
      .sort((left, right) => right.used - left.used
        || String(right.lastUsedAt).localeCompare(String(left.lastUsedAt))
        || right.priority - left.priority
        || left.name.localeCompare(right.name, "zh-CN"));
  }

  async function openTarget(target = {}) {
    if (platform !== "darwin") return {ok: false, message: "当前系统不是 macOS"};
    const apps = rankedApps();
    if (!apps.length) {
      return {ok: false, message: "这台 Mac 没有检测到支持的股票软件"};
    }
    const app = apps[0];
    const query = navigationQuery(target, app);
    if (!query) return {ok: false, message: "股票或板块目标无效"};
    if (target.dryRun) {
      return {ok: true, dryRun: true, appName: app.name, appPath: app.path, query};
    }

    const opened = await execute("/usr/bin/open", [app.path], {timeout: 20000});
    if (!opened.ok) {
      return {ok: false, appName: app.name, message: `无法打开 ${app.name}：${opened.stderr || "启动失败"}`};
    }
    const script = [
      'tell application "System Events"',
      "delay 1.2",
      'keystroke "f" using {command down}',
      "delay 0.35",
      `keystroke ${JSON.stringify(query)}`,
      "delay 0.35",
      "key code 36",
      "end tell",
    ].join("\n");
    const located = await execute("/usr/bin/osascript", ["-e", script], {timeout: 20000});
    if (!located.ok) {
      return {
        ok: false,
        appOpened: true,
        appName: app.name,
        query,
        message: `${app.name} 已打开，但 macOS 未允许自动定位。请在“系统设置 > 隐私与安全性 > 辅助功能”中允许本软件控制键盘。`,
      };
    }

    const state = readJson(statePath, {});
    const usage = {...(state.usage || {})};
    usage[app.path] = {count: (Number(usage[app.path]?.count) || 0) + 1, lastUsedAt: new Date().toISOString()};
    writeJsonAtomic(statePath, {selectedPath: app.path, usage});
    return {
      ok: true,
      appName: app.name,
      appPath: app.path,
      query,
      message: `已在 ${app.name} 中搜索并定位 ${target.name || target.code || query}`,
    };
  }

  return {openTarget, rankedApps};
}

module.exports = {
  APP_PROFILES,
  createMacTradingAppService,
  discoverMacTradingApps,
  navigationQuery,
  profileForAppName,
};
