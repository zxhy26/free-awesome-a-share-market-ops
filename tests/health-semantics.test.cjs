const test = require("node:test");
const assert = require("node:assert/strict");
const {
  derivativesPublicationState,
  mergeHealthModule,
} = require("../app/backend/health-semantics");

const staleStatus = {
  exists: true,
  stale: true,
  tradeDate: "2026-07-24",
  targetTradeDate: "2026-07-27",
};

test("derivatives are pending before the normal publication window", () => {
  const result = derivativesPublicationState(staleStatus, new Date(2026, 6, 27, 11, 30, 0));
  assert.equal(result.status, "pending");
  assert.equal(result.pending, true);
});

test("derivatives become a warning after the publication window", () => {
  const result = derivativesPublicationState(staleStatus, new Date(2026, 6, 27, 18, 0, 0));
  assert.equal(result.status, "warning");
  assert.equal(result.pending, false);
});

test("market trade date overrides an old non-stale file flag", () => {
  const result = derivativesPublicationState(
    {exists: true, stale: false, tradeDate: "2026-07-24", targetTradeDate: "2026-07-24"},
    new Date(2026, 6, 27, 12, 30, 0),
    undefined,
    "2026-07-27",
  );
  assert.equal(result.status, "pending");
  assert.equal(result.pending, true);
});

test("overall health score cannot stay at 100 while warnings exist", () => {
  const merged = mergeHealthModule({
    modules: [{key: "market", status: "ok", completeness: 100}],
    crossChecks: [{key: "backup", status: "warning"}],
    overall: {},
  }, {key: "derivatives", status: "pending", completeness: 100});
  assert.equal(merged.overall.status, "warning");
  assert.equal(merged.overall.warningCount, 1);
  assert.equal(merged.overall.pendingCount, 1);
  assert.ok(merged.overall.score < 100);
});
