"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {spawn} = require("node:child_process");

const repositoryRoot = path.resolve(__dirname, "..");
const servicePath = path.resolve(process.env.A_SHARE_REVIEW_INTEGRATION_SERVICE
  || path.join(repositoryRoot, "app", "backend", "复盘同步服务.js"));
const portableRoot = path.resolve(process.env.A_SHARE_REVIEW_INTEGRATION_PORTABLE_ROOT
  || path.join(path.dirname(servicePath), "..", ".."));
const port = Number(process.env.A_SHARE_REVIEW_TEST_PORT) || 19031;
const origin = `http://127.0.0.1:${port}`;
const temporaryRoot = fs.mkdtempSync(path.join(repositoryRoot, ".tmp-user-preferences-live-"));
const preferencesPath = path.join(temporaryRoot, "用户设置.json");

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${body.message || url}`);
  return body;
}

function startService() {
  const child = spawn(process.execPath, [servicePath], {
    cwd: path.dirname(servicePath),
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      A_SHARE_REVIEW_PORT: String(port),
      A_SHARE_REVIEW_HOST: "127.0.0.1",
      A_SHARE_REVIEW_DISABLE_SCHEDULES: "1",
      A_SHARE_REVIEW_TEST_MODE: "1",
      A_SHARE_REVIEW_PORTABLE_ROOT: portableRoot,
      A_SHARE_REVIEW_PREFERENCES_PATH: preferencesPath,
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return {child, getStderr: () => stderr};
}

async function waitForService(runtime) {
  let lastError = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (runtime.child.exitCode !== null) {
      throw new Error(`服务提前退出 ${runtime.child.exitCode}: ${runtime.getStderr()}`);
    }
    try {
      return await fetchJson(`${origin}/api/v1/preferences`);
    } catch (error) {
      lastError = error;
      await wait(100);
    }
  }
  throw lastError || new Error("用户设置服务启动超时");
}

async function stopService(runtime) {
  if (!runtime || runtime.child.exitCode !== null) return;
  runtime.child.kill();
  await Promise.race([
    new Promise((resolve) => runtime.child.once("close", resolve)),
    wait(3000),
  ]);
  if (runtime.child.exitCode === null) runtime.child.kill("SIGKILL");
}

async function main() {
  let firstRuntime = null;
  let secondRuntime = null;
  try {
    firstRuntime = startService();
    const initial = await waitForService(firstRuntime);
    assert.equal(initial.found, false);

    const saved = await fetchJson(`${origin}/api/v1/preferences`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({settings: {
        selectedIndices: ["sh000001", "sz399006"],
        selectedSectors: [
          {code: "BK0475", name: "银行Ⅱ", group: "industry"},
          {code: "BK0816", name: "人工智能", group: "concept"},
        ],
        zoom: 115,
        fontSize: "large",
      }}),
    });
    assert.equal(saved.ok, true);
    await stopService(firstRuntime);
    firstRuntime = null;

    secondRuntime = startService();
    const reloaded = await waitForService(secondRuntime);
    assert.equal(reloaded.found, true);
    assert.deepEqual(reloaded.settings.selectedIndices, ["sh000001", "sz399006"]);
    assert.equal(reloaded.settings.selectedSectors.length, 2);
    assert.equal(reloaded.settings.zoom, 115);
    assert.equal(reloaded.settings.fontSize, "large");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      servicePath,
      reloaded: true,
      indices: reloaded.settings.selectedIndices.length,
      sectors: reloaded.settings.selectedSectors.length,
      zoom: reloaded.settings.zoom,
      fontSize: reloaded.settings.fontSize,
    }, null, 2)}\n`);
  } finally {
    await stopService(firstRuntime);
    await stopService(secondRuntime);
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
