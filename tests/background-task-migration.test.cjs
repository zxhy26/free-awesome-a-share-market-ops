const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const launcher = fs.readFileSync(
  path.join(root, "windows-launcher", "single-file-launcher.cs"),
  "utf8",
);
const installer = fs.readFileSync(
  path.join(root, "app", "backend", "安装盘中实时任务.ps1"),
  "utf8",
);

test("launcher silently rebinds background tasks before opening the app", () => {
  const ensureIndex = launcher.indexOf("EnsurePayload(runtimeRoot, expectedHash)");
  const refreshIndex = launcher.indexOf("RefreshBackgroundTasks(runtimeRoot)");
  const launchIndex = launcher.indexOf("Process innerProcess = Process.Start(startInfo)");

  assert.ok(ensureIndex >= 0);
  assert.ok(refreshIndex > ensureIndex);
  assert.ok(launchIndex > refreshIndex);
  assert.match(launcher, /安装盘中实时任务\.ps1/);
  assert.match(launcher, /UseShellExecute = false/);
  assert.match(launcher, /CreateNoWindow = true/);
  assert.match(launcher, /ProcessWindowStyle\.Hidden/);
  assert.match(launcher, /WaitForExit\(45000\)/);
});

test("task installer replaces stale service paths and handles quant by edition", () => {
  for (const taskName of [
    "A股盘中实时自动更新",
    "A股收盘最终复盘更新",
    "A股机构衍生品收盘更新",
    "A股复盘同步服务",
    "A股开机后补更新",
    "A股量化选股收盘自动更新",
  ]) {
    assert.ok(installer.includes(taskName), `missing task ${taskName}`);
  }

  assert.match(installer, /Test-Path -LiteralPath \$quantScript -PathType Leaf/);
  assert.match(installer, /Unregister-ScheduledTask -TaskName "A股量化选股收盘自动更新"/);
  assert.match(installer, /Get-CimInstance Win32_Process -Filter "Name = 'node\.exe'"/);
  assert.match(installer, /commandLine\.IndexOf\("复盘同步服务\.js"/);
  assert.match(installer, /commandLine\.IndexOf\(\$currentScriptDir/);
  assert.match(installer, /Stop-Process -Id \$process\.ProcessId -Force/);
  assert.ok(
    installer.indexOf("Stop-LegacySyncService") <
      installer.lastIndexOf('Start-ScheduledTask -TaskName "A股复盘同步服务"'),
  );
});
