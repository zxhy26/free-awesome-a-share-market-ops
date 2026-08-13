import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConceptTurningAnnotations,
  MAX_SIGNIFICANT_TURNS,
  selectSignificantConceptAnnotations,
  selectVisibleConceptAnnotations,
} from "../app/assets/js/concept-turning-annotations.js";
import {buildIndexTurningPoints, selectIndexTurningAnnotations} from "../app/assets/js/charts.js";
import {
  MAX_CONCEPT_HISTORY_ROWS,
  selectConceptHistoryCandidates,
} from "../app/assets/js/custom-sector-workspace.js";

function boardPoints() {
  const anchors = [
    [0, 100], [20, 100.7], [40, 99.8], [60, 100.8], [80, 99.7],
    [100, 100.9], [120, 99.6], [140, 100.8], [160, 99.5],
    [180, 100.7], [200, 99.4], [220, 100.6], [240, 99.3],
  ];
  const points = [];
  for (let anchorIndex = 0; anchorIndex < anchors.length - 1; anchorIndex += 1) {
    const [startMinute, startPrice] = anchors[anchorIndex];
    const [endMinute, endPrice] = anchors[anchorIndex + 1];
    for (let minute = startMinute; minute < endMinute; minute += 1) {
      const ratio = (minute - startMinute) / (endMinute - startMinute);
      const price = startPrice + (endPrice - startPrice) * ratio;
      points.push({minute, price, changePct: price - 100});
    }
  }
  points.push({minute: 240, price: 99.3, changePct: -.7});
  return points;
}

function conceptRow(direction, name, code, multiplier = 1) {
  return {
    code,
    name,
    group: "concept",
    points: boardPoints().map((point) => ({
      minute: point.minute,
      time: `10:${String(point.minute % 60).padStart(2, "0")}:00`,
      amount: direction * multiplier * (1 + point.minute * .08),
      changePct: direction * multiplier * point.minute * .004,
      source: "test-real-concept-sample",
    })),
  };
}

test("every confirmed board turn receives the strongest same-time concept label", () => {
  const points = boardPoints();
  const board = {code: "BK9000", name: "测试板块", tradeDate: "2026-08-07", preClose: 100, points};
  const turns = buildIndexTurningPoints({...board, session: "cn"}, 0);
  const events = buildConceptTurningAnnotations(board, [
    conceptRow(1, "机器人", "BK1001"),
    conceptRow(-1, "算力", "BK1002"),
    conceptRow(1, "融资融券", "BK1003", 20),
    {...conceptRow(1, "电子行业", "BK1004", 20), group: "industry"},
  ]);

  assert.equal(events.length, turns.length);
  assert.ok(events.length >= 10);
  assert.deepEqual([...new Set(events.map((event) => event.label))].sort(), ["机器人", "算力"]);
  assert.ok(events.every((event) => event.sampleMinute <= event.revealMinute));
  assert.ok(events.every((event) => event.direction > 0 ? event.label === "机器人" : event.label === "算力"));
  assert.ok(events.every((event) => /不使用个股、收盘倒推或未来样本/.test(event.methodology)));
});

test("main-index attribution requires matching real concept price action when strict confirmation is enabled", () => {
  const points = boardPoints();
  const board = {code: "000001", name: "上证指数", tradeDate: "2026-08-07", preClose: 100, points};
  const rows = [
    conceptRow(1, "机器人", "BK1001"),
    conceptRow(-1, "算力", "BK1002"),
  ];
  const priceSeries = new Map(rows.map((row) => [row.code, {
    code: row.code,
    tradeDate: board.tradeDate,
    preClose: 100,
    source: "eastmoney-board-index-details",
    points: row.points.map((point) => ({
      minute: point.minute,
      changePct: point.changePct,
      price: 100 + point.changePct,
      tradeDate: board.tradeDate,
    })),
  }]));
  const events = buildConceptTurningAnnotations(board, rows, {
    priceSeriesByCode: priceSeries,
    requirePriceConfirmation: true,
    minimumConfidence: 0,
  });

  assert.ok(events.length > 0);
  assert.ok(events.every((event) => event.resolved === true));
  assert.ok(events.every((event) => event.hasFreshPrice === true));
  assert.ok(events.every((event) => event.priceAligned === true));
  assert.ok(events.every((event) => event.sampleMinute <= event.evidenceEndMinute));
});

test("unverified candidates stay internal and never reach the index chart", () => {
  const board = {code: "000001", name: "上证指数", tradeDate: "2026-08-07", preClose: 100, points: boardPoints()};
  const candidates = buildConceptTurningAnnotations(board, [
    conceptRow(1, "机器人", "BK1001"),
    conceptRow(-1, "算力", "BK1002"),
  ], {
    includeUnresolved: true,
    minimumConfidence: 97,
  });

  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((event) => event.resolved === false));
  assert.ok(candidates.every((event) => event.displayLabel === ""));
  assert.deepEqual(selectIndexTurningAnnotations(candidates, 240), []);
});

test("future-only concept samples are never backfilled into an earlier turn", () => {
  const points = boardPoints().filter((point) => point.minute <= 80);
  const events = buildConceptTurningAnnotations({
    code: "BK9000",
    tradeDate: "2026-08-07",
    preClose: 100,
    points,
  }, [{
    code: "BK1001",
    name: "未来题材",
    group: "concept",
    points: [{minute: 120, amount: 20, changePct: 5, source: "future-sample"}],
  }]);
  assert.deepEqual(events, []);
});

test("turn labels remain visible after their confirmation time", () => {
  const board = {code: "BK9000", tradeDate: "2026-08-07", preClose: 100, points: boardPoints()};
  const events = buildConceptTurningAnnotations(board, [
    conceptRow(1, "机器人", "BK1001"),
    conceptRow(-1, "算力", "BK1002"),
  ]);
  const checkpoint = events[Math.floor(events.length / 2)].revealMinute;
  const atCheckpoint = selectVisibleConceptAnnotations(events, checkpoint);
  const atClose = selectVisibleConceptAnnotations(events, 240);
  assert.ok(atCheckpoint.length > 0 && atCheckpoint.length < atClose.length);
  assert.deepEqual(atClose.slice(0, atCheckpoint.length), atCheckpoint);
});

test("dense tick-level turns are reduced to readable significant pivots", () => {
  const events = Array.from({length: 30}, (_, index) => ({
    minute: index * 8,
    revealMinute: index * 8 + 2,
    turnStrength: index % 5 === 0 ? 3 : 1,
    score: 2 + (index % 7),
    label: `题材${index}`,
  }));
  const selected = selectSignificantConceptAnnotations(events);
  assert.ok(selected.length >= 6);
  assert.ok(selected.length <= MAX_SIGNIFICANT_TURNS);
  assert.deepEqual(selected, [...selected].sort((left, right) => left.minute - right.minute));
  assert.ok(selected.every((event, index) => index === 0 || event.minute - selected[index - 1].minute >= 8));
});

test("history preload balances leading inflow, outflow and volatile real concepts", () => {
  const rows = Array.from({length: 60}, (_, index) => ({
    code: `BK${String(1000 + index).padStart(4, "0")}`,
    name: index === 0 ? "融资融券" : `题材${index}`,
    amount: index - 30,
    changePct: index === 1 ? 12 : (index % 7) - 3,
  }));
  const selected = selectConceptHistoryCandidates(rows);
  assert.ok(selected.length <= MAX_CONCEPT_HISTORY_ROWS);
  assert.ok(selected.some((row) => row.amount >= 29));
  assert.ok(selected.some((row) => row.amount <= -29));
  assert.ok(selected.some((row) => row.changePct === 12));
  assert.ok(selected.every((row) => row.name !== "融资融券"));
});
