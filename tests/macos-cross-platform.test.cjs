const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createMacTradingAppService,
  discoverMacTradingApps,
  navigationQuery,
  profileForAppName,
} = require("../app/backend/macos-trading-app");

const repositoryRoot = path.resolve(__dirname, "..");

test("macOS trading app detection selects one installed app and navigates to the named sector", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "a-share-macos-apps-"));
  const applications = path.join(directory, "Applications");
  const statePath = path.join(directory, "state", "trading.json");
  const tdxPath = path.join(applications, "通达信.app");
  const thsPath = path.join(applications, "同花顺.app");
  fs.mkdirSync(tdxPath, {recursive: true});
  fs.mkdirSync(thsPath, {recursive: true});
  fs.mkdirSync(path.dirname(statePath), {recursive: true});
  fs.writeFileSync(statePath, JSON.stringify({
    usage: {
      [thsPath]: {count: 8, lastUsedAt: "2026-08-02T01:00:00.000Z"},
      [tdxPath]: {count: 2, lastUsedAt: "2026-08-02T02:00:00.000Z"},
    },
  }));
  const calls = [];
  const service = createMacTradingAppService({
    platform: "darwin",
    roots: [applications],
    statePath,
    execute: async (command, args) => {
      calls.push({command, args});
      return {ok: true, code: 0, stdout: "", stderr: ""};
    },
  });
  try {
    const result = await service.openTarget({code: "BK1036", market: "sector", name: "通信设备"});
    assert.equal(result.ok, true);
    assert.equal(result.appName, "同花顺");
    assert.equal(result.query, "通信设备");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], {command: "/usr/bin/open", args: [thsPath]});
    assert.equal(calls[1].command, "/usr/bin/osascript");
    assert.match(calls[1].args.join("\n"), /通信设备/);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test("macOS trading app helpers identify known apps without opening every installed market app", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "a-share-macos-discovery-"));
  const applications = path.join(directory, "Applications");
  fs.mkdirSync(path.join(applications, "东方财富.app"), {recursive: true});
  fs.mkdirSync(path.join(applications, "Notes.app"), {recursive: true});
  try {
    const apps = discoverMacTradingApps({roots: [applications]});
    assert.equal(apps.length, 1);
    assert.equal(apps[0].id, "eastmoney");
    assert.equal(profileForAppName("通达信.app").id, "tongdaxin");
    assert.equal(navigationQuery({code: "600000", name: "浦发银行", market: "sh"}, apps[0]), "600000");
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test("desktop backend exposes native Node refresh paths on macOS", () => {
  const service = fs.readFileSync(path.join(repositoryRoot, "app", "backend", "复盘同步服务.js"), "utf8");
  const updater = fs.readFileSync(path.join(repositoryRoot, "app", "backend", "自动更新A股田字格.js"), "utf8");
  const membership = fs.readFileSync(path.join(repositoryRoot, "app", "backend", "会员授权服务.js"), "utf8");
  assert.match(service, /process\.platform === "win32"/);
  assert.match(service, /--intraday/);
  assert.match(service, /--quant-only/);
  assert.match(service, /--policy-news-only/);
  assert.match(service, /DERIVATIVES_NODE_SCRIPT/);
  assert.match(service, /createMacTradingAppService/);
  assert.match(updater, /process\.platform === "win32" \? "curl\.exe" : "\/usr\/bin\/curl"/);
  assert.match(updater, /当前系统不提供 Windows PowerShell 备用通道/);
  assert.match(membership, /Library", "Application Support/);
});

test("macOS release pipeline builds a real universal WebKit app without C-drive staging", () => {
  const swift = fs.readFileSync(path.join(repositoryRoot, "macos-launcher", "AshareReviewLauncher.swift"), "utf8");
  const workflow = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "macos-runtime.yml"), "utf8");
  const builder = fs.readFileSync(path.join(repositoryRoot, "scripts", "build-cross-platform-release.ps1"), "utf8");
  const verifier = fs.readFileSync(path.join(repositoryRoot, "scripts", "verify-cross-platform-release.ps1"), "utf8");
  assert.match(swift, /import WebKit/);
  assert.match(swift, /applicationSupportDirectory/);
  assert.match(swift, /cleanupOldRuntimes/);
  assert.match(workflow, /arm64-apple-macos12\.0/);
  assert.match(workflow, /x86_64-apple-macos12\.0/);
  assert.match(workflow, /lipo -create/);
  assert.match(workflow, /A_SHARE_REVIEW_MAC_LAUNCHER_TEST_ONLY=1/);
  assert.doesNotMatch(builder, /GetTempPath|\$env:TEMP|C:\\/i);
  assert.match(builder, /ExternalAttributes/);
  assert.match(verifier, /0x0100000C/);
  assert.match(verifier, /0x01000007/);
});
