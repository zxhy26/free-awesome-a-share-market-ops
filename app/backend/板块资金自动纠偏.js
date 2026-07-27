"use strict";

const DAY_MINUTES = 240;
const MATCH_EPSILON_YI = 0.005;
const CORRECTION_SOURCE = "eastmoney-board-ranking-auto-corrected";
const CORRECTION_POLICY = "latest-real-sample-only";

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function clampMinute(value) {
  return Math.max(0, Math.min(DAY_MINUTES, Number(value) || 0));
}

function minuteToTime(value) {
  const minute = clampMinute(value);
  const total = minute <= 120 ? 570 + minute : 780 + (minute - 120);
  const hour = Math.floor(total / 60);
  const minutePart = total % 60;
  return `${String(hour).padStart(2, "0")}:${String(minutePart).padStart(2, "0")}`;
}

function boardCode(row) {
  return String(row?.code || row?.tdxCode || row?.name || "").trim();
}

function normalizePoints(points) {
  const byMinute = new Map();
  for (const point of Array.isArray(points) ? points : []) {
    const minute = finiteNumber(point?.minute);
    const amount = finiteNumber(point?.amount);
    if (minute === null || amount === null) continue;
    const normalizedMinute = clampMinute(minute);
    byMinute.set(normalizedMinute, {
      ...point,
      minute: normalizedMinute,
      time: String(point.time || minuteToTime(normalizedMinute)),
      amount: round2(amount),
    });
  }
  return [...byMinute.values()].sort((left, right) => left.minute - right.minute);
}

function reconcileBoardFlowGroup(entries, rows, sampleMinute, syncedAt) {
  const targetMinute = clampMinute(sampleMinute);
  const targetTime = minuteToTime(targetMinute);
  const group = entries && typeof entries === "object" ? entries : {};
  const uniqueRows = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const code = boardCode(row);
    if (code) uniqueRows.set(code, row);
  }

  const stats = {
    version: 1,
    checkedAt: String(syncedAt || ""),
    sampleMinute: targetMinute,
    sampleTime: targetTime,
    checked: 0,
    beforeMatched: 0,
    corrected: 0,
    unchanged: 0,
    skipped: 0,
    matchedAfter: 0,
    source: "eastmoney-board-ranking",
    correctionSource: CORRECTION_SOURCE,
    policy: CORRECTION_POLICY,
    correctedRows: [],
  };

  for (const [code, row] of uniqueRows) {
    const rankingAmount = finiteNumber(row?.amount);
    if (rankingAmount === null) {
      stats.skipped += 1;
      continue;
    }
    stats.checked += 1;
    const roundedRanking = round2(rankingAmount);
    const entry = group[code] || {
      code,
      name: String(row?.name || code),
      tdxName: String(row?.tdxName || ""),
      tdxCode: String(row?.tdxCode || ""),
      points: [],
    };
    const points = normalizePoints(entry.points);
    const exactPoint = points.find((point) => point.minute === targetMinute) || null;
    const previousPoint = exactPoint || [...points].reverse().find((point) => point.minute <= targetMinute) || null;
    const previousAmount = finiteNumber(previousPoint?.amount);
    const exactAmount = finiteNumber(exactPoint?.amount);
    const difference = previousAmount === null ? null : round2(Math.abs(previousAmount - roundedRanking));
    const matchedBefore = exactAmount !== null
      && Math.abs(exactAmount - roundedRanking) <= MATCH_EPSILON_YI;
    const correctionReason = exactPoint ? "amount-mismatch" : "missing-current-sample";

    if (matchedBefore) {
      stats.beforeMatched += 1;
      stats.unchanged += 1;
    } else {
      const replacement = {
        ...(exactPoint || {}),
        minute: targetMinute,
        time: targetTime,
        amount: roundedRanking,
        changePct: finiteNumber(row?.changePct) ?? exactPoint?.changePct ?? null,
        syncedAt: String(syncedAt || ""),
        source: CORRECTION_SOURCE,
      };
      const byMinute = new Map(points.map((point) => [point.minute, point]));
      byMinute.set(targetMinute, replacement);
      entry.points = [...byMinute.values()].sort((left, right) => left.minute - right.minute);
      stats.corrected += 1;
      stats.correctedRows.push({
        code,
        name: String(row?.name || entry.name || code),
        previousAmount,
        rankingAmount: roundedRanking,
        difference,
        reason: correctionReason,
      });
    }

    if (matchedBefore) entry.points = points;
    entry.name = String(row?.name || entry.name || code);
    entry.tdxName = String(row?.tdxName || entry.tdxName || "");
    entry.tdxCode = String(row?.tdxCode || entry.tdxCode || "");
    entry.rankingAmount = roundedRanking;
    entry.reconciliation = {
      version: 1,
      checkedAt: String(syncedAt || ""),
      minute: targetMinute,
      time: targetTime,
      previousAmount,
      rankingAmount: roundedRanking,
      difference,
      corrected: !matchedBefore,
      reason: matchedBefore ? "already-matched" : correctionReason,
      source: "eastmoney-board-ranking",
      correctionSource: matchedBefore ? "" : CORRECTION_SOURCE,
      policy: CORRECTION_POLICY,
    };
    group[code] = entry;
    stats.matchedAfter += 1;
  }

  return stats;
}

function reconcileBoardFlowGroups(cache, groups, sampleMinute, syncedAt) {
  const target = cache && typeof cache === "object" ? cache : {};
  target.version = Math.max(3, Number(target.version) || 0);
  target.groups = target.groups || {};
  target.groups.industry = target.groups.industry || {};
  target.groups.concept = target.groups.concept || {};
  const result = {
    version: 1,
    checkedAt: String(syncedAt || ""),
    sampleMinute: clampMinute(sampleMinute),
    policy: CORRECTION_POLICY,
    industry: reconcileBoardFlowGroup(
      target.groups.industry,
      groups?.industry?.rows,
      sampleMinute,
      syncedAt,
    ),
    concept: reconcileBoardFlowGroup(
      target.groups.concept,
      groups?.concept?.rows,
      sampleMinute,
      syncedAt,
    ),
  };
  target.reconciliationStats = result;
  return result;
}

module.exports = {
  CORRECTION_POLICY,
  CORRECTION_SOURCE,
  reconcileBoardFlowGroup,
  reconcileBoardFlowGroups,
};
