const assert = require("node:assert/strict");
const path = require("node:path");
const {spawn} = require("node:child_process");

const root = path.resolve(__dirname, "..");
const servicePath = path.join(root, "app", "backend", "复盘同步服务.js");
const port = 18816;
const origin = `http://127.0.0.1:${port}`;

async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError || new Error(`等待超时 ${timeoutMs}ms`);
}

async function getJson(pathname) {
  const response = await fetch(`${origin}${pathname}`);
  if (!response.ok) throw new Error(`${pathname} HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const output = [];
  const child = spawn(process.execPath, [servicePath], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      A_SHARE_REVIEW_PORT: String(port),
      A_SHARE_REVIEW_TEST_MODE: "1",
      A_SHARE_REVIEW_DISABLE_SCHEDULES: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  try {
    const health = await waitFor(() => getJson("/api/v1/health"), 20000);
    assert.equal(health.indexContribution.sourceProvider, "公开行情自动计算");
    assert.equal(health.indexContribution.complete, true);
    assert.equal(health.indexContribution.indexCount, 7);

    const acceptedResponse = await fetch(`${origin}/api/v1/index-contribution/refresh`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: "{}",
    });
    assert.equal(acceptedResponse.status, 202);
    const accepted = await acceptedResponse.json();
    assert.equal(accepted.accepted, true);

    let sawRunning = false;
    const status = await waitFor(async () => {
      const current = await getJson("/api/v1/status");
      sawRunning ||= Boolean(current.indexContributionRunning);
      return sawRunning && !current.indexContributionRunning ? current : null;
    }, 120000, 500);
    assert.equal(status.indexContribution.sourceProvider, "公开行情自动计算");
    assert.equal(status.indexContribution.complete, true);
    assert.equal(status.indexContribution.indexCount, 7);
    assert.match(status.indexContribution.tradeDate, /^\d{4}-\d{2}-\d{2}$/u);
    process.stdout.write(`指数贡献在线服务验收通过：${status.indexContribution.tradeDate}，7 个指数完整。\n`);
  } finally {
    if (!child.killed) child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
