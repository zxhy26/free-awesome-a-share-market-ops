const assert = require("node:assert/strict");
const test = require("node:test");

const {
  fallbackClsAnnotationFeed,
  isClsPlateAnchor,
  marketMinuteFromClsTime,
  normalizeClsAnchorPayload,
} = require("../app/backend/财联社指数标注");

test("CLS timestamps map to the A-share session with second precision", () => {
  assert.equal(marketMinuteFromClsTime("2026-07-31 09:30:00"), 0);
  assert.equal(marketMinuteFromClsTime("2026-07-31 09:31:12"), 1.2);
  assert.equal(marketMinuteFromClsTime("2026-07-31 11:30:00"), 120);
  assert.equal(marketMinuteFromClsTime("2026-07-31 13:00:30"), 120.5);
  assert.equal(marketMinuteFromClsTime("2026-07-31 15:00:00"), 240);
  assert.equal(marketMinuteFromClsTime("2026-07-31 12:20:00"), null);
});

test("CLS payload keeps only original plate names, times and directions", () => {
  const feed = normalizeClsAnchorPayload({
    errno: 0,
    data: [
      {symbol_code: "cls80412", symbol_name: "存储器", article_id: 2442153, c_time: "2026-07-31 09:31:12", float: "up", schema: "cailianshe://plate_detail?plate_id=cls80412"},
      {symbol_code: "sh688825", symbol_name: "C长鑫", article_id: 2442174, c_time: "2026-07-31 09:32:35", float: "up", schema: "cailianshe://stock_detail?stock_id=sh688825"},
      {symbol_code: "cls80025", symbol_name: "PCB", article_id: 2442157, c_time: "2026-07-31 10:05:30", float: "down", schema: "cailianshe://plate_detail?plate_id=cls80025"},
      {symbol_code: "sz001309", symbol_name: "德明利", article_id: 2442800, c_time: "2026-07-31 14:46:38", float: "down", schema: "cailianshe://stock_detail?stock_id=sz001309"},
      {symbol_code: "cls00000", symbol_name: "午间事件", article_id: 2442999, c_time: "2026-07-31 12:05:00", float: "up", schema: "cailianshe://plate_detail?plate_id=cls00000"},
      {symbol_code: "cls99999", symbol_name: "其他日期", article_id: 2443000, c_time: "2026-07-30 10:00:00", float: "up", schema: "cailianshe://plate_detail?plate_id=cls99999"},
    ],
  }, {tradeDate: "2026-07-31", syncedAt: "2026/07/31 15:01:00"});

  assert.equal(feed.source, "财联社盯盘");
  assert.equal(feed.status, "ok");
  assert.equal(feed.itemCount, 2);
  assert.equal(feed.excludedStockCount, 2);
  assert.deepEqual(feed.items.map((item) => [item.label, item.sourceDirection, item.sourceTime]), [
    ["存储器", "up", "2026-07-31 09:31:12"],
    ["PCB", "down", "2026-07-31 10:05:30"],
  ]);
  assert.ok(feed.items.every((item) => item.sourceType === "plate" && item.symbolCode.startsWith("cls")));
  assert.ok(feed.items.every((item) => !Object.hasOwn(item, "reason") && !Object.hasOwn(item, "confidence")));
});

test("CLS plate detection excludes stock-detail anchors", () => {
  assert.equal(isClsPlateAnchor({symbol_code: "cls82063", schema: "cailianshe://plate_detail?plate_id=cls82063"}), true);
  assert.equal(isClsPlateAnchor({symbol_code: "sh688825", schema: "cailianshe://stock_detail?stock_id=sh688825"}), false);
  assert.equal(isClsPlateAnchor({symbolCode: "sz001309", sourceSchema: "cailianshe://stock_detail?stock_id=sz001309"}), false);
});

test("CLS outage retains only a same-day CLS feed and otherwise returns no labels", () => {
  const cached = normalizeClsAnchorPayload({
    errno: 0,
    data: [{symbol_code: "cls80180", symbol_name: "银行", c_time: "2026-07-31 10:00:00", float: "up", schema: "cailianshe://plate_detail?plate_id=cls80180"}],
  }, {tradeDate: "2026-07-31", syncedAt: "earlier"});
  const retained = fallbackClsAnnotationFeed(cached, {tradeDate: "2026-07-31", syncedAt: "later", error: "timeout"});
  assert.equal(retained.status, "retained");
  assert.equal(retained.itemCount, 1);

  const unavailable = fallbackClsAnnotationFeed(cached, {tradeDate: "2026-08-03", syncedAt: "later", error: "timeout"});
  assert.equal(unavailable.status, "unavailable");
  assert.deepEqual(unavailable.items, []);
});
