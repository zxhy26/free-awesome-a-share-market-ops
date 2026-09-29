import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {refreshDelay, sampleAtOrBefore, pollSyncTask} from "../app/assets/js/workbench-runtime.js";
import {buildClsIndexAnnotationEvents, attributionTooltip} from "../app/assets/js/charts.js";
const require = createRequire(import.meta.url);
const {buildHealth} = require("../app/backend/升级数据层.js");
const {normalizeUserPreferences} = require("../app/backend/用户设置.js");

test("polling remains scheduled across lunch, close and transient failure", () => {
  assert.equal(refreshDelay({trading: true}), 15000);
  assert.equal(refreshDelay({trading: false}), 60000);
  assert.equal(refreshDelay({failed: true}), 5000);
  assert.equal(refreshDelay({hidden: true, failed: true}), null);
});
test("inspector returns actual earlier samples, never interpolation or a future value", () => {
  const points = [{minute: 1, price: 100}, {minute: 2, price: null}, {minute: 4, price: 110}];
  assert.equal(sampleAtOrBefore(points, 0), null);
  assert.equal(sampleAtOrBefore(points, 3).price, 100);
  assert.equal(sampleAtOrBefore(points, 20).minute, 4);
});
test("CLS labels disclose actual sample alignment and not invented causality", () => {
  const index = {name: "上证指数", tradeDate: "2026-09-29", points: [{minute: 30, price: 4000}]};
  const feed = {tradeDate: index.tradeDate, items: [{label: "银行", sourceType: "plate", sourceDirection: "up", minute: 30.5}]};
  const [item] = buildClsIndexAnnotationEvents(index, feed);
  assert.equal(item.sampleMinute, 30);
  assert.match(attributionTooltip(item), /10:00:00/);
  assert.doesNotMatch(attributionTooltip(item), /同秒|上涨转折/);
  assert.deepEqual(buildClsIndexAnnotationEvents(index, {...feed, tradeDate: "2026-09-28"}), []);
});
test("sync polling survives intermittent disconnect without restarting the job", async () => {
  let calls = 0, clock = 0;
  const progress = [];
  const result = await pollSyncTask({
    readStatus: async () => {
      if (++calls < 3) throw new Error("offline");
      return calls === 3 ? {running: true} : {running: false, lastResult: {ok: true}};
    },
    now: () => clock, sleep: async (ms) => { clock += ms; }, timeoutMs: 10000,
    onProgress: (value) => progress.push(value), failureMessage: () => "failure",
  });
  assert.equal(result.ok, true);
  assert.equal(progress.filter((p) => p.stage === "reconnecting").length, 2);
});
test("sync polling reports failure and has a bounded reconnect budget", async () => {
  let clock = 0, calls = 0;
  const options = {now: () => clock, sleep: async (ms) => { clock += ms; }, timeoutMs: 20000, failureMessage: () => "source failed"};
  await assert.rejects(pollSyncTask({...options, readStatus: async () => ({running: false, lastResult: {ok: false}})}), /source failed/);
  await assert.rejects(pollSyncTask({...options, readStatus: async () => { calls++; throw new Error("offline"); }}), /offline/);
  assert.equal(calls, 4);
});
test("layout and annotation preferences survive normalization", () => {
  assert.equal(normalizeUserPreferences({density: "compact", annotations: false}).annotations, false);
  assert.equal(normalizeUserPreferences({density: "compact"}).density, "compact");
  assert.equal(normalizeUserPreferences({density: "invalid"}).density, "comfortable");
});
test("previous closing strategy is not a current market date failure", () => {
  const date = "2026-09-29";
  const data = {market: {tradeDate: date}, indices: {tradeDate: date, items: []}, sectors: {tradeDate: date}, stocks: {tradeDate: date}, analysis: {tradeDate: date}, quant: {tradeDate: "2026-09-28"}};
  const health = buildHealth(data, 30);
  assert.equal(health.crossChecks.find((c) => c.key === "trade-date").status, "ok");
  assert.equal(health.crossChecks.find((c) => c.key === "quant-date").status, "warning");
  data.indices.tradeDate = "2026-09-28";
  assert.equal(buildHealth(data, 30).crossChecks.find((c) => c.key === "trade-date").status, "error");
});
