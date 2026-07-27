const test = require("node:test");
const assert = require("node:assert/strict");
const {buildSnapshotOnlyIndex} = require("../app/backend/market-data-contract");

test("fallback index contains one real snapshot and no synthetic pre-close line", () => {
  const result = buildSnapshotOnlyIndex({
    def: {key: "sh000001", name: "上证指数", code: "000001"},
    data: {f47: 123, f48: 456},
    tradeDate: "2026-07-27",
    price: 3612.34,
    preClose: 3599.12,
    minute: 72,
    time: "10:42",
    reason: "minute endpoint unavailable",
  });
  assert.equal(result.snapshotOnly, true);
  assert.equal(result.continuity, "single-real-snapshot");
  assert.equal(result.points.length, 1);
  assert.equal(result.points[0].price, 3612.34);
  assert.equal(result.points[0].minute, 72);
  assert.notEqual(result.points[0].price, result.preClose);
});
