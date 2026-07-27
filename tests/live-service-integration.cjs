"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const {spawn} = require("child_process");

const repositoryRoot = path.resolve(__dirname, "..");
const servicePath = path.join(repositoryRoot, "app", "backend", "复盘同步服务.js");
const port = Number(process.env.A_SHARE_REVIEW_TEST_PORT) || 18837;
const origin = `http://127.0.0.1:${port}`;
const logPath = path.join(os.tmpdir(), `a-share-live-service-${process.pid}.log`);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${body.message || url}`);
  return body;
}

async function waitForService() {
  let lastError = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await fetchJson(`${origin}/health`);
    } catch (error) {
      lastError = error;
      await wait(250);
    }
  }
  throw lastError || new Error("本地服务未启动");
}

async function timedRequest(url, options) {
  const startedAt = Date.now();
  const body = await fetchJson(url, options);
  return {body, milliseconds: Date.now() - startedAt};
}

async function main() {
  const child = spawn(process.execPath, [servicePath], {
    cwd: repositoryRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      A_SHARE_REVIEW_PORT: String(port),
      A_SHARE_REVIEW_DISABLE_SCHEDULES: "1",
      A_SHARE_REVIEW_TEST_MODE: "0",
      A_SHARE_REVIEW_LOG_PATH: logPath,
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  try {
    const health = await waitForService();
    const first = await timedRequest(`${origin}/api/v1/live/sector-flows`);
    const second = await timedRequest(`${origin}/api/v1/live/sector-flows`);
    const manual = await timedRequest(`${origin}/api/v1/live/sector-flows/refresh`, {method: "POST"});
    const snapshot = manual.body;
    process.stdout.write(JSON.stringify({
      ok: true,
      serviceVersion: health.service?.version,
      firstMs: first.milliseconds,
      secondMs: second.milliseconds,
      manualMs: manual.milliseconds,
      firstSequence: first.body.sequence,
      secondSequence: second.body.sequence,
      manualSequence: snapshot.sequence,
      tradeDate: snapshot.tradeDate,
      sourceTime: snapshot.sourceTime,
      marketPhase: snapshot.marketPhase,
      industryRows: snapshot.groups?.industry?.rows?.length || 0,
      conceptRows: snapshot.groups?.concept?.rows?.length || 0,
      indexRows: snapshot.indices?.length || 0,
      groupTimestampSkewMs: snapshot.groupTimestampSkewMs,
      methodology: snapshot.methodology,
    }, null, 2));
  } finally {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      wait(3000),
    ]);
    if (!child.killed) child.kill("SIGKILL");
    try {
      fs.unlinkSync(logPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (stderr.trim()) process.stderr.write(stderr);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
