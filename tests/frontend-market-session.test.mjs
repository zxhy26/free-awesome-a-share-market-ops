import test from "node:test";
import assert from "node:assert/strict";
import {
  inTradingWindow,
  interpolateRealSamples,
  isAuctionWindow,
  marketPhase,
  marketMinuteToTime,
  shouldAppendRegularSessionSample,
} from "../app/assets/js/market-session.js";
import {visiblePoints} from "../app/assets/js/charts.js";

test("market clock keeps the lunch break out of the 240-minute axis", () => {
  assert.equal(marketMinuteToTime(0), "09:30:00");
  assert.equal(marketMinuteToTime(120), "11:30:00");
  assert.equal(marketMinuteToTime(121), "13:01:00");
  assert.equal(marketMinuteToTime(240), "15:00:00");
  assert.equal(marketMinuteToTime(0.5), "09:30:30");
});

test("real samples interpolate only between known points", () => {
  const points = [{minute: 10, amount: 2}, {minute: 20, amount: 6}];
  assert.equal(interpolateRealSamples(points, 5, "amount"), null);
  assert.equal(interpolateRealSamples(points, 15, "amount"), 4);
  assert.equal(interpolateRealSamples(points, 25, "amount"), 6);
});

test("index rendering does not backfill a future snapshot into earlier time", () => {
  const points = [{minute: 72, price: 3612.34}];
  assert.deepEqual(visiblePoints(points, 60), []);
  assert.deepEqual(visiblePoints(points, 72), points);
});

test("live polling stops immediately after lunch and market close", () => {
  assert.equal(inTradingWindow(new Date("2026-07-27T09:14:59+08:00")), false);
  assert.equal(inTradingWindow(new Date("2026-07-27T09:15:00+08:00")), true);
  assert.equal(inTradingWindow(new Date("2026-07-27T09:29:59+08:00")), true);
  assert.equal(inTradingWindow(new Date("2026-07-27T09:30:00+08:00")), true);
  assert.equal(isAuctionWindow(new Date("2026-07-27T09:15:00+08:00")), true);
  assert.equal(isAuctionWindow(new Date("2026-07-27T09:30:00+08:00")), false);
  assert.equal(marketPhase("2026-07-27", 0, new Date("2026-07-27T09:20:00+08:00")), "集合竞价");
  assert.equal(inTradingWindow(new Date("2026-07-27T11:30:00+08:00")), true);
  assert.equal(inTradingWindow(new Date("2026-07-27T11:30:01+08:00")), false);
  assert.equal(inTradingWindow(new Date("2026-07-27T15:00:00+08:00")), true);
  assert.equal(inTradingWindow(new Date("2026-07-27T15:00:01+08:00")), false);
});

test("auction snapshots never append a fake 09:30 regular-session point", () => {
  assert.equal(shouldAppendRegularSessionSample({auction: true, marketMinute: 0}), false);
  assert.equal(shouldAppendRegularSessionSample({auction: false, marketMinute: 0}), true);
  assert.equal(shouldAppendRegularSessionSample({marketMinute: 12.5}), true);
});
