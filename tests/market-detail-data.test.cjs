const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createMarketDetailDataService,
  normalizeTarget,
} = require("../app/backend/market-detail-data");

function response(body) {
  const buffer = Buffer.from(body, "utf8");
  return {
    ok: true,
    async arrayBuffer() {
      return buffer;
    },
  };
}

function fetchImpl(url) {
  const target = String(url);
  if (target.includes("push2his.eastmoney.com")) {
    return Promise.resolve(response(JSON.stringify({
      data: {
        code: target.includes("90.BK1046") ? "BK1046" : "600351",
        name: target.includes("90.BK1046") ? "游戏Ⅱ" : "亚宝药业",
        klines: [
          "2026-07-28,10,10.2,10.4,9.9,1000,1000000,5,2,0.2,3",
          "2026-07-29,10.2,10.5,10.8,10.1,1200,1300000,6,2.94,0.3,3.2",
        ],
      },
    })));
  }
  if (target.includes("qt.gtimg.cn")) {
    const fields = Array(50).fill("");
    fields[1] = "亚宝药业";
    fields[2] = "600351";
    fields[3] = "10.50";
    fields[4] = "10.00";
    fields[5] = "10.10";
    fields[6] = "123";
    fields[30] = "20260729140000";
    fields[31] = "0.50";
    fields[32] = "5.00";
    fields[33] = "10.80";
    fields[34] = "9.90";
    fields[37] = "123456";
    fields[38] = "3.20";
    return Promise.resolve(response(`v_sh600351="${fields.join("~")}";`));
  }
  return Promise.reject(new Error(`unexpected URL: ${target}`));
}

const boardIntraday = {
  async getTimeline() {
    return {
      ok: true,
      tradeDate: "2026-07-29",
      source: "板块真实分时测试源",
      points: [
        {price: 1200, changePct: 0},
        {price: 1212, changePct: 1},
      ],
    };
  },
};

test("market detail service returns real stock K lines and quote through local backend", async () => {
  const service = createMarketDetailDataService({fetchImpl, boardIntraday});
  const result = await service.getDetail({code: "600351", market: "1", name: "亚宝药业"});
  assert.equal(result.ok, true);
  assert.equal(result.kline.items.length, 2);
  assert.equal(result.quote.price, 10.5);
  assert.equal(result.quote.changePct, 5);
  assert.deepEqual(result.errors, []);
});

test("market detail service supports sector K lines and board timeline quote", async () => {
  const service = createMarketDetailDataService({fetchImpl, boardIntraday});
  const result = await service.getDetail({
    code: "BK1046",
    boardCode: "BK1046",
    market: "sector",
    name: "游戏Ⅱ",
  });
  assert.equal(result.ok, true);
  assert.equal(result.kline.items.length, 2);
  assert.equal(result.quote.price, 1212);
  assert.equal(result.quote.changePct, 1);
});

test("market detail target validation rejects invalid codes", () => {
  assert.throws(() => normalizeTarget({code: "abc"}), /股票代码无效/);
  assert.throws(() => normalizeTarget({market: "sector"}), /板块缺少/);
});
