const test = require("node:test");
const assert = require("node:assert/strict");
const {
  clampQuoteTimestampToTradingSession,
  GROUP_DEFINITIONS,
  createLiveSectorFlowService,
  marketPhaseAt,
} = require("../app/backend/live-sector-flow");

function epochSeconds(text) {
  return Math.floor(new Date(text).getTime() / 1000);
}

function mockGroup(definition, timestamp, offset = 0) {
  const count = definition.minimumRows;
  return {
    key: definition.key,
    title: definition.title,
    route: "test",
    sourceTimestamp: timestamp,
    rows: Array.from({length: count}, (_, index) => ({
      code: `BK${String(1000 + index).padStart(4, "0")}`,
      name: `${definition.title}${index + 1}`,
      amount: offset + index / 10 + 1,
      amountYuan: Math.round((offset + index / 10 + 1) * 100000000),
      changePct: index / 100,
      sourceTimestamp: timestamp,
    })),
  };
}

function mockIndices(timestamp) {
  return ["sh000001", "sz399001", "sz399006"].map((key, index) => ({
    key,
    code: String(index + 1).padStart(6, "0"),
    name: `测试指数${index + 1}`,
    price: 3600 + index,
    preClose: 3590 + index,
    change: 10,
    changePct: 0.28,
    amount: 500000000000,
    sourceTimestamp: timestamp,
    minute: 30,
    source: "test",
  }));
}

test("live sector flow refreshes once per second and freezes during lunch", async () => {
  let current = new Date("2026-07-27T10:00:00+08:00");
  let groupCalls = 0;
  let generation = 0;
  const service = createLiveSectorFlowService({
    now: () => new Date(current),
    fetchBoardGroup: async (definition) => {
      groupCalls += 1;
      const timestamp = epochSeconds(current.toISOString());
      return mockGroup(definition, timestamp, generation);
    },
    fetchIndexQuotes: async () => mockIndices(epochSeconds(current.toISOString())),
  });

  const first = await service.getSnapshot();
  assert.equal(first.active, true);
  assert.equal(first.sequence, 1);
  assert.equal(groupCalls, 2);
  assert.equal(first.groups.industry.rows.length, GROUP_DEFINITIONS.industry.minimumRows);
  assert.equal(first.groups.concept.rows.length, GROUP_DEFINITIONS.concept.minimumRows);

  const cached = await service.getSnapshot();
  assert.equal(cached.sequence, 1);
  assert.equal(groupCalls, 2);

  generation = 10;
  current = new Date("2026-07-27T10:00:01+08:00");
  const second = await service.getSnapshot();
  assert.equal(second.sequence, 2);
  assert.equal(second.changed, true);
  assert.equal(groupCalls, 4);

  current = new Date("2026-07-27T12:00:00+08:00");
  const lunch = await service.getSnapshot();
  assert.equal(lunch.active, false);
  assert.match(lunch.marketPhase, /午间休市/);
  assert.equal(lunch.sequence, 2);
  assert.equal(groupCalls, 4);

  const manual = await service.forceRefresh();
  assert.equal(manual.sequence, 3);
  assert.equal(groupCalls, 6);
});

test("live sector flow keeps the previous atomic snapshot when one group fails", async () => {
  let current = new Date("2026-07-27T10:20:00+08:00");
  let failConcept = false;
  const service = createLiveSectorFlowService({
    now: () => new Date(current),
    fetchBoardGroup: async (definition) => {
      if (failConcept && definition.key === "concept") throw new Error("concept unavailable");
      return mockGroup(definition, epochSeconds(current.toISOString()));
    },
    fetchIndexQuotes: async () => mockIndices(epochSeconds(current.toISOString())),
  });

  const complete = await service.getSnapshot();
  const previousConceptAmount = complete.groups.concept.rows[0].amount;
  failConcept = true;
  current = new Date("2026-07-27T10:20:01+08:00");
  const retained = await service.getSnapshot();

  assert.equal(retained.sequence, complete.sequence);
  assert.equal(retained.groups.concept.rows[0].amount, previousConceptAmount);
  assert.equal(retained.consecutiveErrors, 1);
  assert.match(retained.lastError, /concept unavailable/);
});

test("live sector flow rejects snapshots whose group times are too far apart", async () => {
  const current = new Date("2026-07-27T10:30:00+08:00");
  const timestamp = epochSeconds(current.toISOString());
  const service = createLiveSectorFlowService({
    now: () => new Date(current),
    fetchBoardGroup: async (definition) => mockGroup(
      definition,
      definition.key === "industry" ? timestamp : timestamp + 3,
    ),
    fetchIndexQuotes: async () => mockIndices(timestamp),
  });

  await assert.rejects(
    service.getSnapshot(),
    /采集时间相差 3000 毫秒/,
  );
});

test("trading boundaries stop immediately after the closing second", () => {
  assert.equal(marketPhaseAt(new Date("2026-07-27T11:30:00+08:00")).active, true);
  assert.equal(marketPhaseAt(new Date("2026-07-27T11:30:01+08:00")).active, false);
  assert.equal(marketPhaseAt(new Date("2026-07-27T15:00:00+08:00")).active, true);
  assert.equal(marketPhaseAt(new Date("2026-07-27T15:00:01+08:00")).active, false);
});

test("quote timestamps are frozen at lunch and close", () => {
  assert.equal(
    clampQuoteTimestampToTradingSession(epochSeconds("2026-07-27T12:15:20+08:00")),
    epochSeconds("2026-07-27T11:30:00+08:00"),
  );
  assert.equal(
    clampQuoteTimestampToTradingSession(epochSeconds("2026-07-27T16:20:00+08:00")),
    epochSeconds("2026-07-27T15:00:00+08:00"),
  );
});
