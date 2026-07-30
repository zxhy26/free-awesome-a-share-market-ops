const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const {
  DEFAULT_INDEX_KEYS,
  INDEX_CATALOG,
  findIndexDefinition,
  publicIndexCatalog,
} = require(path.join(root, "app", "backend", "index-catalog.js"));
const {
  createIndexIntradayService,
  normalizeIndexKey,
  parseTencentIndexPayload,
} = require(path.join(root, "app", "backend", "index-intraday.js"));

function payloadFor(definition, date, rows, preClose) {
  const quote = [];
  quote[4] = String(preClose);
  quote[30] = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} 15:00:00`;
  return {
    data: {
      [definition.symbol]: {
        data: {date, data: rows},
        qt: {[definition.symbol]: quote},
      },
    },
  };
}

test("index catalog exposes a fixed default eight and a larger selectable allowlist", () => {
  assert.equal(DEFAULT_INDEX_KEYS.length, 8);
  assert.equal(new Set(DEFAULT_INDEX_KEYS).size, 8);
  assert.ok(INDEX_CATALOG.length > DEFAULT_INDEX_KEYS.length);
  assert.equal(publicIndexCatalog().filter((item) => item.selectedByDefault).length, 8);
  assert.ok(DEFAULT_INDEX_KEYS.every((key) => findIndexDefinition(key)));
  assert.equal(findIndexDefinition("000852")?.key, "sh000852");
  assert.equal(normalizeIndexKey("usIXIC"), "usIXIC");
  assert.throws(() => normalizeIndexKey("sh999999"), /指数选项无效/);
});

test("Tencent parser maps real China and US sessions onto the common 0-240 timeline", () => {
  const shanghai = findIndexDefinition("sh000016");
  const cn = parseTencentIndexPayload(payloadFor(shanghai, "20260730", [
    "0930 2900.00 100 5000",
    "1130 2910.00 200 9000",
    "1300 2912.00 220 9800",
    "1500 2920.00 300 12000",
  ], 2890), shanghai);
  assert.equal(cn.tradeDate, "2026-07-30");
  assert.equal(cn.preClose, 2890);
  assert.deepEqual(cn.points.map((point) => point.minute), [0, 120, 240]);
  assert.equal(cn.points[1].time, "13:00:00");
  assert.equal(cn.points.at(-1).price, 2920);

  const nasdaq = findIndexDefinition("usIXIC");
  const us = parseTencentIndexPayload(payloadFor(nasdaq, "20260729", [
    "0930 24822.32 0",
    "1230 24600.00 100",
    "1600 24442.94 200",
  ], 24876.91), nasdaq);
  assert.equal(us.tradeDate, "2026-07-29");
  assert.deepEqual(us.points.map((point) => point.minute), [0, 110.7692, 240]);
  assert.equal(us.points.at(-1).price, 24442.94);
});

test("on-demand index service uses the strict catalog and ten-second response cache", async () => {
  const definition = findIndexDefinition("sh000016");
  const payload = payloadFor(definition, "20260730", [
    "0930 2900.00 100 5000",
    "0931 2901.00 110 5500",
  ], 2890);
  let fetchCount = 0;
  const service = createIndexIntradayService({
    fetchImpl: async () => {
      fetchCount += 1;
      return {ok: true, text: async () => JSON.stringify(payload)};
    },
    now: () => new Date("2026-07-30T02:00:00.000Z"),
  });

  const first = await service.getTimeline("sh000016", "2026-07-30");
  const second = await service.getTimeline("sh000016", "2026-07-30");
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(fetchCount, 1);
  assert.equal(service.getCatalog().maxSelected, 8);
  await assert.rejects(() => service.getTimeline("sh999999"), /指数选项无效/);
});

test("a stale dashboard date does not suppress the provider's latest real timeline", async () => {
  const definition = findIndexDefinition("sh000852");
  const payload = payloadFor(definition, "20260730", [
    "0930 7340.00 100 5000",
    "0931 7342.00 110 5500",
  ], 7330);
  const service = createIndexIntradayService({
    fetchImpl: async () => ({ok: true, text: async () => JSON.stringify(payload)}),
    now: () => new Date("2026-07-30T02:00:00.000Z"),
  });
  const result = await service.getTimeline("sh000852", "2026-07-24");
  assert.equal(result.ok, true);
  assert.equal(result.tradeDate, "2026-07-30");
  assert.equal(result.dateMismatch, true);
  assert.match(result.warning, /优先展示最新真实分时/);
});
