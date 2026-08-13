const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createBoardIntradayService,
  marketMinuteFromTime,
  parseBoardDetailsPayload,
  parseBoardTrendsPayload,
  tradeDateFromQuotePayload,
} = require("../app/backend/board-intraday");

const detailsPayload = {
  rc: 0,
  data: {
    code: "BK0475",
    prePrice: 100,
    details: [
      "09:25:00,99.00,10,0,1",
      "09:30:03,100.50,20,0,2",
      "11:30:00,101.00,30,0,2",
      "12:01:00,110.00,30,0,2",
      "13:00:03,100.80,40,0,1",
      "15:00:00,101.20,50,0,2",
      "15:00:00,101.25,60,0,2",
    ],
  },
};

const trendsPayload = {
  rc: 0,
  data: {
    code: "BK0475",
    name: "银行Ⅱ",
    preClose: 100,
    trends: [
      "2026-07-28 09:30,100.00,100.50,100.50,100.00,20,2000,100.25",
      "2026-07-28 11:30,100.50,101.00,101.00,100.50,30,3030,100.75",
      "2026-07-28 12:01,101.00,110.00,110.00,101.00,30,3300,105.00",
      "2026-07-28 13:00,101.00,100.80,101.00,100.80,40,4032,100.90",
      "2026-07-28 15:00,100.80,101.20,101.20,100.80,50,5060,101.00",
    ],
  },
};

test("board details become a real session percentage timeline without lunch or auction samples", () => {
  const result = parseBoardDetailsPayload(detailsPayload, {
    code: "BK0475",
    name: "银行Ⅱ",
    tradeDate: "2026-07-28",
  });
  assert.equal(result.tradeDate, "2026-07-28");
  assert.equal(result.preClose, 100);
  assert.equal(result.points.length, 4);
  assert.deepEqual(result.points.map((point) => point.minute), [0.05, 120, 120.05, 240]);
  assert.equal(result.points[0].changePct, 0.5);
  assert.equal(result.points.at(-1).price, 101.25);
  assert.equal(result.points.at(-1).changePct, 1.25);
});

test("market minute conversion freezes outside the two trading sessions", () => {
  assert.equal(marketMinuteFromTime("09:30:00"), 0);
  assert.equal(marketMinuteFromTime("11:30:00"), 120);
  assert.equal(marketMinuteFromTime("12:00:00"), null);
  assert.equal(marketMinuteFromTime("13:00:00"), 120);
  assert.equal(marketMinuteFromTime("15:00:00"), 240);
});

test("board minute trends provide a fast real-price confirmation series for index attribution", () => {
  const result = parseBoardTrendsPayload(trendsPayload, {code: "BK0475", name: "银行Ⅱ"});
  assert.equal(result.tradeDate, "2026-07-28");
  assert.equal(result.preClose, 100);
  assert.deepEqual(result.points.map((point) => point.minute), [0, 120, 120.001, 240]);
  assert.equal(result.points[1].time, "11:30:00");
  assert.equal(result.points[2].time, "13:00:00");
  assert.equal(result.points.at(-1).changePct, 1.2);
  assert.ok(result.points.every((point) => point.source === "eastmoney-board-index-minute-trends"));
});

test("board service exposes the minute-trend channel without changing the tick channel", async () => {
  const fetchImpl = async () => ({ok: true, text: async () => JSON.stringify(trendsPayload)});
  const service = createBoardIntradayService({
    fetchImpl,
    now: () => new Date("2026-07-28T15:01:00+08:00"),
  });
  const result = await service.getMinuteTimeline("BK0475", "银行Ⅱ", "2026-07-28");
  assert.equal(result.ok, true);
  assert.equal(result.source, "东方财富板块指数分钟分时");
  assert.equal(result.points.at(-1).minute, 240);
});

test("board service cross-checks the source trade date before publication", async () => {
  const sourceTimestamp = Math.floor(Date.parse("2026-07-28T15:00:00+08:00") / 1000);
  const quotePayload = {rc: 0, data: {f57: "BK0475", f58: "银行Ⅱ", f86: sourceTimestamp}};
  const fetchImpl = async (url) => ({
    ok: true,
    text: async () => JSON.stringify(String(url).includes("/details/") ? detailsPayload : quotePayload),
  });
  const service = createBoardIntradayService({
    fetchImpl,
    now: () => new Date("2026-07-28T15:01:00+08:00"),
  });
  const result = await service.getTimeline("BK0475", "银行Ⅱ", "2026-07-28");
  assert.equal(result.ok, true);
  assert.equal(result.tradeDate, "2026-07-28");
  assert.equal(result.points.length, 4);
  await assert.rejects(
    service.getTimeline("BK0475", "银行Ⅱ", "2026-07-25"),
    /拒绝将其标记为2026-07-25/,
  );
  assert.equal(tradeDateFromQuotePayload(quotePayload), "2026-07-28");
});
