import {finiteNumber} from "./analysis.js";
import {buildIndexTurningPoints, marketMinuteToTime} from "./charts.js";

const CONCEPT_SAMPLE_MAX_AGE_MINUTES = 3.5;
const CONCEPT_LOOKBACK_MINUTES = 6;
const MIN_FLOW_MOMENTUM_YI = 0.05;
const MIN_CUMULATIVE_FLOW_YI = 0.35;
const MIN_PRICE_MOMENTUM_PCT = 0.015;
const MAX_SIGNIFICANT_TURNS = 10;
const SIGNIFICANT_TURN_GAP_MINUTES = 14;
const SIGNIFICANT_TURN_RELAXED_GAP_MINUTES = 8;
const GENERIC_CONCEPT_PATTERN = /融资融券|MSCI|富时罗素|沪股通|深股通|QFII|基金重仓|机构重仓|证金持股|社保重仓|大盘股|中盘股|小盘股|行业龙头|[\u4e00-\u9fa5]+风格|高贝塔|HS300|(?:中证|上证|深成|创业板|科创)\d+|20\d{2}(?:一季报|中报|三季报|年报)|百日新高|百元股|破净股|昨日涨停|昨日连板|AB股|AH股|转债标的/i;

function pointMinute(point, fallback = 0) {
  return finiteNumber(point?.minute) ?? fallback;
}

function sortedRealFlowPoints(points, tradeDate = "") {
  const byMinute = new Map();
  for (const [index, point] of (points || []).entries()) {
    if (tradeDate && point?.tradeDate && point.tradeDate !== tradeDate) continue;
    const minute = pointMinute(point, index);
    const amount = finiteNumber(point?.amount);
    if (minute < 0 || minute > 240 || amount === null) continue;
    byMinute.set(minute, {
      ...point,
      minute,
      amount,
      changePct: finiteNumber(point?.changePct),
    });
  }
  return [...byMinute.values()].sort((left, right) => left.minute - right.minute);
}

function pointAtOrBefore(points, minute) {
  let low = 0;
  let high = points.length - 1;
  let selected = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].minute <= minute) {
      selected = points[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return selected;
}

function targetChangeAt(board, minute) {
  const points = (board?.points || [])
    .map((point, index) => ({...point, minute: pointMinute(point, index)}))
    .filter((point) => point.minute <= minute)
    .sort((left, right) => left.minute - right.minute);
  const point = points.at(-1);
  const direct = finiteNumber(point?.changePct);
  if (direct !== null) return direct;
  const price = finiteNumber(point?.price);
  const preClose = finiteNumber(board?.preClose);
  return price !== null && preClose !== null && preClose > 0
    ? ((price - preClose) / preClose) * 100
    : null;
}

function conceptEvidence(row, turn, board) {
  const name = String(row?.name || row?.tdxName || "").trim();
  const code = String(row?.code || row?.tdxCode || "").trim().toUpperCase();
  if (!name || GENERIC_CONCEPT_PATTERN.test(name) || code === String(board?.code || "").toUpperCase()) return null;
  const points = sortedRealFlowPoints(row?.points, board?.tradeDate || "");
  if (!points.length) return null;
  const end = pointAtOrBefore(points, turn.revealMinute);
  if (!end || turn.revealMinute - end.minute > CONCEPT_SAMPLE_MAX_AGE_MINUTES) return null;
  const startMinute = Math.max(points[0].minute, turn.minute - CONCEPT_LOOKBACK_MINUTES);
  const start = pointAtOrBefore(points, startMinute);
  const hasFreshStart = Boolean(
    start
    && startMinute - start.minute <= CONCEPT_SAMPLE_MAX_AGE_MINUTES
    && end.minute > start.minute,
  );
  const flowDelta = hasFreshStart ? end.amount - start.amount : null;
  const endChangePct = finiteNumber(end.changePct);
  const startChangePct = hasFreshStart ? finiteNumber(start.changePct) : null;
  const changeDelta = startChangePct !== null && endChangePct !== null
    ? endChangePct - startChangePct
    : null;
  const direction = turn.direction;
  const directionalFlow = flowDelta === null ? null : direction * flowDelta;
  const directionalPrice = changeDelta === null ? null : direction * changeDelta;
  const directionalCumulative = direction * end.amount;
  const flowAligned = directionalFlow !== null && directionalFlow >= MIN_FLOW_MOMENTUM_YI;
  const priceAligned = directionalPrice !== null && directionalPrice >= MIN_PRICE_MOMENTUM_PCT;
  const cumulativeFallback = !hasFreshStart && directionalCumulative >= MIN_CUMULATIVE_FLOW_YI;
  if (!flowAligned && !priceAligned && !cumulativeFallback) return null;
  const score = Math.log1p(Math.max(0, directionalFlow || 0) * 4) * 4
    + Math.max(0, directionalPrice || 0) * 10
    + Math.log1p(Math.max(0, directionalCumulative)) * .8
    + (flowAligned && priceAligned ? 2.4 : 0)
    + (hasFreshStart ? 1.2 : 0)
    - Math.max(0, turn.revealMinute - end.minute) * .25;
  return {
    conceptCode: code,
    conceptName: name,
    flowAmount: end.amount,
    flowDelta,
    conceptChangePct: endChangePct,
    conceptChangeDelta: changeDelta,
    sampleMinute: end.minute,
    sampleTime: String(end.time || marketMinuteToTime(end.minute, true)),
    source: String(end.source || row?.source || "真实概念板块资金样本"),
    hasFreshStart,
    flowAligned,
    priceAligned,
    score,
  };
}

function confidenceFor(evidence) {
  const raw = 48
    + (evidence.flowAligned ? 18 : 0)
    + (evidence.priceAligned ? 14 : 0)
    + (evidence.hasFreshStart ? 8 : 0)
    + Math.min(10, Math.max(0, evidence.score));
  return Math.max(45, Math.min(96, Math.round(raw)));
}

export function buildConceptTurningAnnotations(board, conceptRows, options = {}) {
  const tradeDate = String(board?.tradeDate || "");
  const targetPoints = (board?.points || [])
    .filter((point) => finiteNumber(point?.price) !== null)
    .sort((left, right) => pointMinute(left) - pointMinute(right));
  const preClose = finiteNumber(board?.preClose);
  if (targetPoints.length < 3 || preClose === null || preClose <= 0) return [];
  const candidates = (conceptRows || []).filter((row) => {
    const group = String(row?.group || row?.sectorKind || "concept");
    return group === "concept" && sortedRealFlowPoints(row?.points, tradeDate).length;
  });
  if (!candidates.length) return [];
  const firstConceptMinute = Math.min(...candidates.flatMap((row) => (
    sortedRealFlowPoints(row?.points, tradeDate).slice(0, 1).map((point) => point.minute)
  )));
  const visibleMinute = Math.max(0, Math.min(240, finiteNumber(options.visibleMinute) ?? 240));
  const turns = buildIndexTurningPoints({
    ...board,
    session: "cn",
    points: targetPoints,
    preClose,
  }, firstConceptMinute).filter((turn) => turn.revealMinute <= visibleMinute);

  return turns.map((turn) => {
    const ranked = candidates
      .map((row) => conceptEvidence(row, turn, board))
      .filter(Boolean)
      .sort((left, right) => right.score - left.score || left.conceptName.localeCompare(right.conceptName, "zh-CN"));
    const lead = ranked[0];
    if (!lead) return null;
    const confidence = confidenceFor(lead);
    return {
      ...turn,
      ...lead,
      label: lead.conceptName,
      targetChangePct: targetChangeAt(board, turn.minute),
      directionName: turn.direction > 0 ? "向上拐点" : "向下拐点",
      confidence,
      confidenceLabel: confidence >= 80 ? "高" : confidence >= 65 ? "中" : "观察",
      methodology: "真实板块指数拐点与同时间窗概念板块资金增量、概念涨跌方向匹配；不使用个股、行业名称或未来样本。",
    };
  }).filter(Boolean).sort((left, right) => left.minute - right.minute);
}

export function selectVisibleConceptAnnotations(events, minute) {
  const visibleMinute = Math.max(0, Math.min(240, finiteNumber(minute) ?? 0));
  return (events || []).filter((event) => event.revealMinute <= visibleMinute);
}

export function selectSignificantConceptAnnotations(events, options = {}) {
  const maximum = Math.max(1, Math.min(12, Math.floor(finiteNumber(options.maximum) ?? MAX_SIGNIFICANT_TURNS)));
  const targetMinimum = Math.min(maximum, Math.max(1, Math.floor(finiteNumber(options.minimum) ?? 6)));
  const selectWithGap = (minimumGap) => {
    const selected = [];
    const ranked = [...(events || [])].sort((left, right) => {
      const leftImportance = (finiteNumber(left.turnStrength) ?? 0) * 5 + (finiteNumber(left.score) ?? 0);
      const rightImportance = (finiteNumber(right.turnStrength) ?? 0) * 5 + (finiteNumber(right.score) ?? 0);
      return rightImportance - leftImportance || left.minute - right.minute;
    });
    for (const event of ranked) {
      if (selected.some((current) => Math.abs(current.minute - event.minute) < minimumGap)) continue;
      selected.push(event);
      if (selected.length >= maximum) break;
    }
    return selected.sort((left, right) => left.minute - right.minute);
  };
  let selected = selectWithGap(SIGNIFICANT_TURN_GAP_MINUTES);
  if (selected.length < targetMinimum) selected = selectWithGap(SIGNIFICANT_TURN_RELAXED_GAP_MINUTES);
  return selected;
}

export {
  CONCEPT_LOOKBACK_MINUTES,
  CONCEPT_SAMPLE_MAX_AGE_MINUTES,
  GENERIC_CONCEPT_PATTERN,
  MAX_SIGNIFICANT_TURNS,
};
