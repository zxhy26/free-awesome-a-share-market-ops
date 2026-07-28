const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const contributionPath = path.join(root, "app", "data", "index-contribution.json");
const appSource = fs.readFileSync(path.join(root, "app", "assets", "js", "app.js"), "utf8");
const serviceSource = fs.readFileSync(path.join(root, "app", "backend", "复盘同步服务.js"), "utf8");
const extractorSource = fs.readFileSync(path.join(root, "app", "backend", "读取通达信指数贡献.ps1"), "utf8");

test("bundled contribution snapshot is a Tongdaxin .929 top-ten result", () => {
  const data = JSON.parse(fs.readFileSync(contributionPath, "utf8"));
  assert.equal(data.source.provider, "通达信");
  assert.equal(data.source.screen, ".929 贡献度排名");
  assert.equal(data.source.status, "ok");
  assert.equal(Object.keys(data.indices).length, 7);

  for (const index of Object.values(data.indices)) {
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

test("frontend uses the native contribution snapshot and never substitutes sector attribution", () => {
  assert.match(appSource, /state\.data\?\.indexContribution/);
  assert.match(appSource, /通达信 \.929 原生贡献点数/);
  assert.doesNotMatch(appSource, /selectSectorAttributions/);
  assert.match(appSource, /不会使用行业资金推断结果替代/);
});

test("service exposes a background contribution refresh backed by the Win32 extractor", () => {
  assert.match(serviceSource, /index-contribution\.json/);
  assert.match(serviceSource, /\/api\/v1\/index-contribution\/refresh/);
  assert.match(serviceSource, /读取通达信指数贡献\.ps1/);
  assert.match(extractorSource, /LVM_GETITEMTEXTW/);
  assert.match(extractorSource, /TCM_GETITEMRECT/);
  assert.match(extractorSource, /Select-Object -First 10/);
});
