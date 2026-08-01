"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  compareLegacyArchives,
  selectBetterDataset,
} = require("../app/backend/history-quality");

function indexItem(points) {
  return {points: Array.from({length: points}, (_, minute) => ({minute}))};
}

test("history repair keeps the richer same-day index timeline and plate annotations", () => {
  const existing = {
    tradeDate: "2026-07-31",
    items: Array.from({length: 8}, () => indexItem(120)),
    annotations: {
      status: "ok",
      items: [
        {name: "银行", sourceType: "plate", sourceSchema: "plate_detail", sourceCode: "cls1001"},
        {name: "示例个股", sourceType: "stock", sourceSchema: "stock_detail", sourceCode: "sh600000"},
      ],
    },
  };
  const incoming = {
    tradeDate: "2026-07-31",
    items: Array.from({length: 8}, () => indexItem(242)),
    annotations: {status: "unavailable", items: []},
  };
  const selected = selectBetterDataset("indices", incoming, existing);
  assert.equal(selected.source, "incoming");
  assert.equal(selected.value.items.reduce((sum, item) => sum + item.points.length, 0), 1936);
  assert.deepEqual(selected.value.annotations.items.map((item) => item.name), ["银行"]);
  assert.equal(selected.value.annotations.itemCount, 1);
});

test("history repair prevents a low-sample sector snapshot from replacing a complete archive", () => {
  const existing = {
    tradeDate: "2026-07-30",
    industry: {rows: Array(20).fill({}), flowTimelineCount: 20, flowSampleCount: 4800, attributionRows: Array(20).fill({})},
    concept: {rows: Array(20).fill({}), flowTimelineCount: 20, flowSampleCount: 4800, attributionRows: Array(20).fill({})},
  };
  const incoming = {
    tradeDate: "2026-07-30",
    industry: {rows: Array(20).fill({}), flowTimelineCount: 4, flowSampleCount: 600, attributionRows: []},
    concept: {rows: Array(20).fill({}), flowTimelineCount: 3, flowSampleCount: 500, attributionRows: []},
  };
  const selected = selectBetterDataset("sectors", incoming, existing);
  assert.equal(selected.source, "existing");
  assert.equal(selected.value.industry.flowSampleCount, 4800);
});

test("legacy candidate selection favors real sampling coverage instead of file recency", () => {
  const base = {
    validation: {status: "ok"},
    index: {tradeDate: "2026-07-30", points: Array(242).fill({})},
    indices: Array.from({length: 8}, () => indexItem(242)),
    market: {tradeDate: "2026-07-30", limitUpStocks: Array(50).fill({}), limitDownStocks: Array(20).fill({})},
    industry: {rows: Array(20).fill({}), flowTimelineCount: 20, flowSampleCount: 4800, attributionRows: Array(20).fill({})},
    concept: {rows: Array(20).fill({}), flowTimelineCount: 20, flowSampleCount: 4800, attributionRows: Array(20).fill({})},
  };
  const partial = {
    ...base,
    indices: Array.from({length: 8}, () => indexItem(120)),
    industry: {...base.industry, flowSampleCount: 1200},
    concept: {...base.concept, flowSampleCount: 1100},
  };
  assert.equal(compareLegacyArchives(base, partial, "2026-07-30"), 1);
  assert.equal(compareLegacyArchives(partial, base, "2026-07-30"), -1);
});
