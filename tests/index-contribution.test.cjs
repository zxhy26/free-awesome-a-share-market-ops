const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const contributionPath = path.join(root, "app", "data", "index-contribution.json");
const appSource = fs.readFileSync(path.join(root, "app", "assets", "js", "app.js"), "utf8");
const serviceSource = fs.readFileSync(path.join(root, "app", "backend", "复盘同步服务.js"), "utf8");
const onlineSource = fs.readFileSync(path.join(root, "app", "backend", "index-contribution-online.js"), "utf8");
const {
  buildWeightedIndex,
  cappedWeights,
  fillMissingWeights,
  validatePayload,
} = require(path.join(root, "app", "backend", "index-contribution-online.js"));

test("bundled contribution snapshot is a complete online top-ten result", () => {
  const data = JSON.parse(fs.readFileSync(contributionPath, "utf8"));
  assert.equal(data.source.provider, "公开行情自动计算");
  assert.equal(data.source.status, "ok");
  assert.equal(data.quality.complete, true);
  assert.equal(Object.keys(data.indices).length, 7);
  assert.equal(validatePayload(data), true);

  for (const index of Object.values(data.indices)) {
    assert.ok(index.constituentCount > 0);
    assert.ok(index.positive.length <= 10);
    assert.ok(index.negative.length <= 10);
    assert.ok(index.positive.every((row) => Number(row.points) > 0));
    assert.ok(index.negative.every((row) => Number(row.points) < 0));
    assert.deepEqual(
      index.positive.map((row) => Number(row.points)),
      index.positive.map((row) => Number(row.points)).sort((left, right) => right - left),
    );
    assert.deepEqual(
      index.negative.map((row) => Number(row.points)),
      index.negative.map((row) => Number(row.points)).sort((left, right) => left - right),
    );
  }
});

test("missing public weights are filled without changing disclosed weights", () => {
  const rows = fillMissingWeights([
    {code: "000001", weightPct: 30, marketCap: 300, changePct: 0},
    {code: "000002", weightPct: null, marketCap: 200, changePct: 0},
    {code: "000003", weightPct: null, marketCap: 100, changePct: 0},
  ]);
  assert.equal(rows[0].weightPct, 30);
  assert.equal(Number(rows.reduce((sum, row) => sum + row.weightPct, 0).toFixed(8)), 100);
  assert.equal(Number(rows[1].weightPct.toFixed(4)), 46.6667);
  assert.equal(Number(rows[2].weightPct.toFixed(4)), 23.3333);
});

test("capped free-float weights satisfy the published North Exchange limits", () => {
  const rows = cappedWeights(Array.from({length: 50}, (_, index) => ({
    code: String(920001 + index),
    marketCap: Math.max(10, 1000 - index * 20),
    changePct: 0,
  })), {maxSingle: 10, topGroupCount: 5, topGroupMax: 40});
  const sorted = [...rows].sort((left, right) => right.weightPct - left.weightPct);
  assert.equal(Number(rows.reduce((sum, row) => sum + row.weightPct, 0).toFixed(8)), 100);
  assert.ok(Math.max(...rows.map((row) => row.weightPct)) <= 10);
  assert.ok(sorted.slice(0, 5).reduce((sum, row) => sum + row.weightPct, 0) <= 40.000001);
});

test("calculated contribution is reconciled to the actual index point change", () => {
  const result = buildWeightedIndex(
    {code: "TEST", name: "测试指数", minimumCount: 2},
    {preClose: 1000, changePoints: 15},
    [
      {code: "000001", name: "甲", weightPct: 60, changePct: 2, quoteFound: true},
      {code: "000002", name: "乙", weightPct: 40, changePct: -0.5, quoteFound: true},
    ],
    null,
    {componentSource: "测试", methodology: "测试"},
  );
  assert.equal(result.quality.rawCalculatedChangePoints, 10);
  assert.equal(result.quality.calculatedChangePoints, 15);
  assert.equal(result.quality.actualChangePoints, 15);
  assert.equal(result.quality.residualPoints, 0);
});

test("frontend uses online contribution data and never substitutes sector attribution", () => {
  assert.match(appSource, /state\.data\?\.indexContribution/);
  assert.match(appSource, /公开行情/);
  assert.match(appSource, /无需启动股票软件/);
  assert.doesNotMatch(appSource, /通达信 \.929 原生贡献点数/);
  assert.doesNotMatch(appSource, /selectSectorAttributions/);
  assert.match(appSource, /不使用行业资金推断替代/);
});

test("service refreshes contribution online without launching Tongdaxin", () => {
  assert.match(serviceSource, /index-contribution-online/);
  assert.match(serviceSource, /refreshIndexContribution/);
  assert.match(serviceSource, /\/api\/v1\/index-contribution\/refresh/);
  assert.doesNotMatch(serviceSource, /读取通达信指数贡献\.ps1/);
  assert.match(onlineSource, /www\.cnindex\.com\.cn\/sample-detail\/detail/);
  assert.match(onlineSource, /datacenter-web\.eastmoney\.com/);
  assert.match(onlineSource, /push2delay\.eastmoney\.com/);
  assert.match(onlineSource, /已保留.*上一份完整指数贡献/);
});
