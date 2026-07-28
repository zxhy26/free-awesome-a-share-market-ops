const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createBoardMinuteFlowService,
  marketMinuteFromTime,
  normalizeBoardCode,
  parseBoardFlowPayload,
} = require(path.join(__dirname, "..", "app", "backend", "board-minute-flow.js"));

function payload() {
  return {
    data: {
      name: "测试题材",
      klines: [
        "2026-07-27 15:00,100000000,0,0",
        "2026-07-28 09:31,120000000,0,0",
        "2026-07-28 11:30,220000000,0,0",
        "2026-07-28 12:00,999000000,0,0",
        "2026-07-28 13:00,230000000,0,0",
        "2026-07-28 15:00,-310000000,0,0",
      ],
    },
  };
}

test("board timeline parser keeps only the latest real trading session", () => {
  const result = parseBoardFlowPayload(payload(), {code: "BK1234"});
  assert.equal(result.tradeDate, "2026-07-28");
  assert.equal(result.name, "测试题材");
  assert.deepEqual(result.points.map((point) => point.minute), [1, 120, 240]);
  assert.equal(result.points[1].time, "13:00:00");
  assert.equal(result.points.at(-1).amount, -3.1);
  assert.ok(result.points.every((point) => point.source === "eastmoney-board-minute-flow"));
});

test("board code and market-time validation reject unsafe or non-session input", () => {
  assert.equal(normalizeBoardCode("bk0475"), "BK0475");
  assert.throws(() => normalizeBoardCode("https://example.com"), /板块代码无效/);
  assert.equal(marketMinuteFromTime("09:30:00"), 0);
  assert.equal(marketMinuteFromTime("11:30:00"), 120);
  assert.equal(marketMinuteFromTime("13:00:00"), 120);
  assert.equal(marketMinuteFromTime("15:00:00"), 240);
  assert.equal(marketMinuteFromTime("12:00:00"), null);
});

test("board timeline service uses the official minute endpoint and short cache", async () => {
  let calls = 0;
  let requestedUrl = "";
  const service = createBoardMinuteFlowService({
    now: () => new Date("2026-07-28T07:00:00.000Z"),
    fetchImpl: async (url) => {
      calls += 1;
      requestedUrl = String(url);
      return {
        ok: true,
        text: async () => JSON.stringify(payload()),
      };
    },
  });
  const first = await service.getTimeline("BK0475", "银行");
  const second = await service.getTimeline("BK0475", "银行");
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
  assert.match(requestedUrl, /stock\/fflow\/kline\/get/);
  assert.match(requestedUrl, /secid=90\.BK0475/);
  assert.match(first.methodology, /不插值、不生成模拟点/);
});

test("local all-board sampling cache is preferred when the external endpoint is unavailable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-flow-cache-"));
  const cachePath = path.join(root, "A股板块资金分时缓存.json");
  fs.writeFileSync(cachePath, JSON.stringify({
    tradeDate: "2026-07-28",
    groups: {
      industry: {
        BK0475: {
          code: "BK0475",
          name: "银行Ⅱ",
          points: [
            {minute: 1, time: "09:31", amount: 1.2, source: "eastmoney-board-ranking"},
            {minute: 240, time: "15:00", amount: 15.3, source: "eastmoney-board-ranking"},
          ],
        },
      },
      concept: {},
    },
  }), "utf8");
  let onlineCalls = 0;
  const service = createBoardMinuteFlowService({
    cachePaths: [cachePath],
    fetchImpl: async () => {
      onlineCalls += 1;
      throw new Error("online unavailable");
    },
  });
  const result = await service.getTimeline("BK0475", "银行");
  assert.equal(result.source, "本机全量板块资金实时缓存");
  assert.equal(result.group, "industry");
  assert.equal(result.points.length, 2);
  assert.equal(result.latestAmount, 15.3);
  assert.equal(onlineCalls, 0);
  fs.rmSync(root, {recursive: true, force: true});
});
