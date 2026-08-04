"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  collectClosedLimitDownRows,
  isHistoricalClosedLimit,
  reconcileLimitDownPool,
} = require("../app/backend/market-extremes");
const {hydrateHistoryCacheFromStructuredArchive} = require("../app/backend/recent-market-history");

function quote(code, name, preClose, price) {
  return {
    code,
    name,
    preClose,
    price,
    low: price,
    high: preClose,
    changePct: ((price - preClose) / preClose) * 100,
    quoteDate: "2026-08-04",
  };
}

test("all-A validation repairs a zero limit-down topic count", () => {
  const validated = [
    quote("600001", "主板样例", 10, 9),
    quote("300001", "创业板样例", 10, 8),
    quote("600002", "普通下跌", 10, 9.4),
  ];
  const reconciled = reconcileLimitDownPool({rows: [], total: 0, qdate: "2026-08-04"}, validated, "2026-08-04");
  assert.equal(reconciled.total, 2);
  assert.equal(reconciled.rows.length, 2);
  assert.equal(reconciled.crossCheck.topicReported, 0);
  assert.equal(reconciled.crossCheck.allAValidated, 2);
});

test("topic rows can never be smaller than the displayed limit-down count", () => {
  const topicRow = {c: "600003", n: "专题样例", f3: -10};
  const reconciled = reconcileLimitDownPool({rows: [topicRow], total: 0}, null, "2026-08-04");
  assert.equal(reconciled.total, 1);
  assert.equal(reconciled.rows.length, 1);
});

test("complete all-A validation removes a stale topic row that opened before close", () => {
  const staleTopic = {c: "002409", n: "盘中触及样例", f3: -10};
  const latestQuote = quote("002409", "盘中触及样例", 133.8, 120.91);
  latestQuote.low = 120.42;
  const reconciled = reconcileLimitDownPool({rows: [staleTopic], total: 1}, [latestQuote], "2026-08-04");
  assert.equal(reconciled.total, 0);
  assert.equal(reconciled.rows.length, 0);
  assert.equal(reconciled.crossCheck.authoritative, "all-a-latest-quote");
});

test("limit-down validation uses each board's real price band", () => {
  const rows = [
    quote("600004", "主板非跌停", 10, 8.5),
    quote("300004", "创业板跌停", 10, 8),
    quote("920004", "北交所跌停", 10, 7),
  ];
  assert.deepEqual(collectClosedLimitDownRows(rows, "2026-08-04").map((row) => row.c), ["300004", "920004"]);
  assert.equal(isHistoricalClosedLimit({...quote("600005", "", 10, 9.5), listingIndex: 30}, "down"), true);
  assert.equal(isHistoricalClosedLimit({...quote("600006", "", 10, 8.5), listingIndex: 30}, "down"), false);
});

test("structured archives rebuild at least eight recent trading-day rows", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a-share-history-"));
  try {
    const dates = ["2026-08-04", "2026-08-03", "2026-07-31", "2026-07-30", "2026-07-29", "2026-07-28", "2026-07-27", "2026-07-24"];
    dates.forEach((date, index) => {
      const directory = path.join(root, date);
      fs.mkdirSync(directory, {recursive: true});
      fs.writeFileSync(path.join(directory, "market.json"), JSON.stringify({
        tradeDate: date,
        generatedAt: `${date} 15:01:00`,
        market: {
          tradeDate: date,
          limitUpCount: 40 + index,
          limitDownCount: index + 1,
          totalAmountYi: 10000 + index,
          recentDays: [{date, indexChangePct: index / 10}],
        },
      }), "utf8");
      fs.writeFileSync(path.join(directory, "stocks.json"), JSON.stringify({groups: {limitUp: {rows: []}, limitDown: {rows: []}}}), "utf8");
    });
    const result = hydrateHistoryCacheFromStructuredArchive({version: 1, days: []}, root, 60);
    assert.equal(result.cache.days.length, 8);
    assert.deepEqual(result.cache.days.slice(0, 2).map((day) => day.date), ["2026-08-04", "2026-08-03"]);
    assert.equal(result.cache.days[1].market.limitDownCount, 2);
    assert.equal(result.cache.days[1].market.totalAmountYi, 10001);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("Windows launcher merges all old history roots and keeps the history cache", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "windows-launcher", "single-file-launcher.cs"), "utf8");
  assert.match(source, /FindLegacyRuntimeRoots/u);
  assert.match(source, /foreach \(string preservedRoot in FindLegacyRuntimeRoots/u);
  assert.match(source, /A\\u80a1\\u590d\\u76d8\\u5386\\u53f2\\u5e93\.json/u);
  assert.doesNotMatch(source, /FindLegacyRuntimeRoot\(/u);
});
