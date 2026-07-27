import test from "node:test";
import assert from "node:assert/strict";
import {
  interpolateRealSamples,
  marketMinuteToTime,
} from "../app/assets/js/market-session.js";
import {visiblePoints} from "../app/assets/js/charts.js";

test("market clock keeps the lunch break out of the 240-minute axis", () => {
  assert.equal(marketMinuteToTime(0), "09:30");
  assert.equal(marketMinuteToTime(120), "11:30");
  assert.equal(marketMinuteToTime(121), "13:01");
  assert.equal(marketMinuteToTime(240), "15:00");
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
