const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {exportOptimizedAppData} = require("../app/backend/导出复盘应用数据");
const updaterSource = fs.readFileSync(
  path.join(__dirname, "..", "app", "backend", "自动更新A股田字格.js"),
  "utf8",
);

function createApp(options = {}) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "a-share-quant-export-"));
  fs.mkdirSync(path.join(appDir, "data"), {recursive: true});
  fs.mkdirSync(path.join(appDir, "pages"), {recursive: true});
  if (options.quantEnabled) {
    fs.writeFileSync(path.join(appDir, "pages", "quant.html"), "<!doctype html>", "utf8");
  }
  return appDir;
}

function quantFixture() {
  return {
    version: 5,
    tradeDate: "2026-07-28",
    fetchedAt: "2026/07/28 15:10:00",
    universeCount: 5500,
    scannedCount: 5200,
    formal: [{
      code: "000001",
      name: "平安银行",
      market: 0,
      signals: ["B1"],
      score: 88,
      sector: "银行",
    }],
  };
}

test("quant-only refresh writes readable data without requiring a market snapshot", () => {
  const appDir = createApp({quantEnabled: true});
  try {
    const result = exportOptimizedAppData({appDir, quantData: quantFixture()});
    const data = JSON.parse(fs.readFileSync(path.join(appDir, "data", "quant.json"), "utf8"));
    assert.equal(result.quantOnly, true);
    assert.equal(result.quantWritten, true);
    assert.equal(data.tradeDate, "2026-07-28");
    assert.equal(data.formalCount, 1);
    assert.equal(data.formal[0].code, "000001");
  } finally {
    fs.rmSync(appDir, {recursive: true, force: true});
  }
});

test("market refresh preserves quant data in quant-enabled editions", () => {
  const appDir = createApp({quantEnabled: true});
  const quantPath = path.join(appDir, "data", "quant.json");
  fs.writeFileSync(quantPath, JSON.stringify(quantFixture()), "utf8");
  try {
    assert.throws(
      () => exportOptimizedAppData({appDir}),
      /缺少市场数据/,
    );
    assert.equal(fs.existsSync(quantPath), true);
  } finally {
    fs.rmSync(appDir, {recursive: true, force: true});
  }
});

test("member edition removes stale quant data when no quant page exists", () => {
  const appDir = createApp({quantEnabled: false});
  const quantPath = path.join(appDir, "data", "quant.json");
  fs.writeFileSync(quantPath, JSON.stringify(quantFixture()), "utf8");
  try {
    assert.throws(
      () => exportOptimizedAppData({appDir}),
      /缺少市场数据/,
    );
    assert.equal(fs.existsSync(quantPath), false);
  } finally {
    fs.rmSync(appDir, {recursive: true, force: true});
  }
});

test("quant-only completion does not read a missing market validation result", () => {
  assert.match(updaterSource, /if \(result\.quantOnly\)/);
  assert.doesNotMatch(updaterSource, /result\.validation\.status/);
});
