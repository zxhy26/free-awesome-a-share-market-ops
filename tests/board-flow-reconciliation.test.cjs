const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CORRECTION_POLICY,
  CORRECTION_SOURCE,
  reconcileBoardFlowGroups,
} = require("../app/backend/板块资金自动纠偏");

test("sector flow reconciliation corrects only the current real sample", () => {
  const earlyPoint = {
    minute: 1,
    time: "09:31",
    amount: 1.25,
    source: "eastmoney-board-minute-flow",
  };
  const futurePoint = {
    minute: 11,
    time: "09:41",
    amount: 99,
    source: "future-test-point",
  };
  const cache = {
    groups: {
      industry: {
        BK1001: {
          code: "BK1001",
          name: "行业甲",
          flowValidated: true,
          points: [
            earlyPoint,
            { minute: 10, time: "09:40", amount: 2.5, source: "eastmoney-board-minute-flow" },
            futurePoint,
          ],
        },
        BK1002: {
          code: "BK1002",
          name: "行业乙",
          points: [{ minute: 9, time: "09:39", amount: -1.2, source: "eastmoney-board-minute-flow" }],
        },
        BK1003: {
          code: "BK1003",
          name: "行业丙",
          points: [{ minute: 10, time: "09:40", amount: 4, source: "eastmoney-board-minute-flow" }],
        },
      },
      concept: {
        BK2001: {
          code: "BK2001",
          name: "概念甲",
          points: [{ minute: 10, time: "09:40", amount: -3, source: "eastmoney-board-minute-flow" }],
        },
      },
    },
  };
  const groups = {
    industry: {
      rows: [
        { code: "BK1001", name: "行业甲", amount: 3.2, changePct: 1.1 },
        { code: "BK1002", name: "行业乙", amount: -2.4, changePct: -0.5 },
        { code: "BK1003", name: "行业丙", amount: 4, changePct: 0.3 },
      ],
    },
    concept: {
      rows: [{ code: "BK2001", name: "概念甲", amount: -3.5, changePct: -1.2 }],
    },
  };

  const first = reconcileBoardFlowGroups(cache, groups, 10, "2026/07/27 09:40:00");
  assert.equal(cache.version, 3);
  assert.equal(first.industry.checked, 3);
  assert.equal(first.industry.corrected, 2);
  assert.equal(first.industry.unchanged, 1);
  assert.equal(first.industry.matchedAfter, 3);
  assert.equal(first.concept.corrected, 1);
  assert.equal(first.policy, CORRECTION_POLICY);

  const industryOne = cache.groups.industry.BK1001;
  assert.deepEqual(industryOne.points.find((point) => point.minute === 1), earlyPoint);
  assert.deepEqual(industryOne.points.find((point) => point.minute === 11), futurePoint);
  assert.equal(industryOne.points.find((point) => point.minute === 10).amount, 3.2);
  assert.equal(industryOne.points.find((point) => point.minute === 10).source, CORRECTION_SOURCE);
  assert.equal(industryOne.reconciliation.previousAmount, 2.5);
  assert.equal(industryOne.reconciliation.rankingAmount, 3.2);
  assert.equal(industryOne.reconciliation.corrected, true);

  const industryTwo = cache.groups.industry.BK1002;
  assert.deepEqual(industryTwo.points.find((point) => point.minute === 9), {
    minute: 9,
    time: "09:39",
    amount: -1.2,
    source: "eastmoney-board-minute-flow",
  });
  assert.equal(industryTwo.points.find((point) => point.minute === 10).amount, -2.4);
  assert.equal(industryTwo.reconciliation.reason, "missing-current-sample");

  const industryThree = cache.groups.industry.BK1003;
  assert.equal(industryThree.points[0].source, "eastmoney-board-minute-flow");
  assert.equal(industryThree.reconciliation.corrected, false);

  const second = reconcileBoardFlowGroups(cache, groups, 10, "2026/07/27 09:40:10");
  assert.equal(second.industry.corrected, 0);
  assert.equal(second.industry.unchanged, 3);
  assert.equal(second.concept.corrected, 0);
});
