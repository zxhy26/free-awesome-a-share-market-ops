const assert = require("node:assert/strict");
const test = require("node:test");

const {createClsMarketWatchService} = require("../app/backend/财联社盯盘服务");

function response(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}

test("CLS watch publishes original plate events and excludes stocks", async () => {
  let calls = 0;
  const current = new Date("2026-08-13T10:00:00+08:00");
  const service = createClsMarketWatchService({
    now: () => current,
    getTradeDate: () => "2026-08-13",
    fetchImpl: async () => {
      calls += 1;
      return response({
        errno: 0,
        data: [
          {symbol_code: "cls81083", symbol_name: "AI应用", article_id: 2453041, c_time: "2026-08-13 09:33:06", float: "up", schema: "cailianshe://plate_detail?plate_id=cls81083"},
          {symbol_code: "sz002229", symbol_name: "鸿博股份", article_id: 2453021, c_time: "2026-08-13 09:26:09", float: "up", schema: "cailianshe://stock_detail?stock_id=sz002229"},
        ],
      });
    },
  });

  const feed = await service.forceRefresh();
  assert.equal(feed.status, "ok");
  assert.equal(feed.source, "财联社盯盘");
  assert.equal(feed.delivery, "direct");
  assert.equal(feed.itemCount, 1);
  assert.equal(feed.excludedStockCount, 1);
  assert.equal(feed.items[0].label, "AI应用");
  assert.equal(feed.items[0].sourceTime, "2026-08-13 09:33:06");

  await service.getFeed();
  assert.equal(calls, 1, "five-second cache should avoid duplicate remote requests");
});

test("CLS watch never invents a replacement when the source is unavailable", async () => {
  const current = new Date("2026-08-13T10:00:00+08:00");
  const service = createClsMarketWatchService({
    now: () => current,
    getTradeDate: () => "2026-08-13",
    fetchImpl: async () => { throw new Error("offline"); },
    readCachedFeed: () => null,
  });

  const feed = await service.forceRefresh();
  assert.equal(feed.status, "unavailable");
  assert.equal(feed.itemCount, 0);
  assert.deepEqual(feed.items, []);
  assert.doesNotMatch(JSON.stringify(feed), /待确认|未知题材|模拟|推测/);
});
