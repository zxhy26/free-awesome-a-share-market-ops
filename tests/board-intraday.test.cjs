const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createBoardIntradayService,
  marketMinuteFromTime,
  parseBoardDetailsPayload,
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
