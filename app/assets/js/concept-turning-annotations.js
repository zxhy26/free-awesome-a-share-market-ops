import {finiteNumber} from "./analysis.js";
import {buildIndexTurningPoints, marketMinuteToTime} from "./charts.js";

const CONCEPT_SAMPLE_MAX_AGE_MINUTES = 2.5;
const CONCEPT_LOOKBACK_MINUTES = 4;
const EVIDENCE_AFTER_PIVOT_MINUTES = 12;
const CORRELATION_LOOKBACK_MINUTES = 20;
const MIN_FLOW_MOMENTUM_YI = 0.3;
const MIN_PRICE_MOMENTUM_PCT = 0.025;
const MIN_LOCAL_ALIGNMENT_SHARE = 0.58;
const MIN_PRICE_CORRELATION = 0.02;
const MIN_CAUSE_CONFIDENCE = 72;
const CLS_EVENT_LEAD_MINUTES = 4;
const MAX_SIGNIFICANT_TURNS = 10;
const SIGNIFICANT_TURN_GAP_MINUTES = 14;
const SIGNIFICANT_TURN_RELAXED_GAP_MINUTES = 8;
const GENERIC_CONCEPT_PATTERN = /融资融券|MSCI|富时罗素|标准普尔|沪股通|深股通|QFII|基金重仓|机构重仓|证金持股|社保重仓|大盘股|中盘股|小盘股|大盘成长|大盘价值|中盘成长|中盘价值|小盘成长|小盘价值|行业龙头|[\u4e00-\u9fa5]+风格|高贝塔|高市净率|高市盈率|低市净率|低市盈率|趋势股|周期股|HS300|深成500|(?:中证|上证|深成|创业板|科创)\d+|20\d{2}(?:一季报|中报|三季报|年报|预增|预减)|百日新高|百元股|破净股|昨日|今日|高换手|高振幅|低换手|低振幅|AB股|AH股|转债标的/i;

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

function normalizedThemeName(value) {
  return String(value || "")
    .trim()
    .replace(/[\s·/_-]+/gu, "")
    .replace(/(?:概念|题材|板块|产业链)$/u, "")
    .toLowerCase();
}

function themeFamily(value) {
  const name = normalizedThemeName(value);
  const families = [
    [/(?:cpo|光模块|光通信)/iu, "光通信"],
    [/(?:算力|ai服务器|数据中心|东数西算|液冷)/iu, "算力"],
    [/(?:ai应用|ai语料|人工智能|数字经济)/iu, "AI应用"],
    [/(?:创新药|cro|cmo|医药|医疗)/iu, "医药"],
    [/(?:绿色电力|智能电网|电网|电力)/iu, "电力"],
    [/(?:pcb|印制电路)/iu, "PCB"],
    [/(?:机器人|人形机器)/iu, "机器人"],
    [/(?:半导体|芯片|集成电路)/iu, "半导体"],
    [/(?:黄金|贵金属)/iu, "黄金"],
    [/(?:小金属|稀缺资源)/iu, "小金属"],
  ];
  return families.find(([pattern]) => pattern.test(name))?.[1] || name;
}

function sourceDirectionNumber(value) {
  return value === "up" || Number(value) > 0 ? 1 : value === "down" || Number(value) < 0 ? -1 : 0;
}

function clsConfirmation(name, turn, feed, tradeDate, evidenceEndMinute = turn.revealMinute) {
  if (!Array.isArray(feed?.items)) return null;
  if (tradeDate && feed.tradeDate && String(feed.tradeDate) !== tradeDate) return null;
  const normalized = normalizedThemeName(name);
  const family = themeFamily(name);
  return feed.items
    .map((item) => {
      const minute = finiteNumber(item?.minute);
      const label = String(item?.label || "").trim();
      if (
        minute === null
        || !label
        || minute < turn.minute - CLS_EVENT_LEAD_MINUTES
        || minute > evidenceEndMinute
        || sourceDirectionNumber(item?.sourceDirection) !== turn.direction
      ) return null;
      const eventNormalized = normalizedThemeName(label);
      const exact = normalized === eventNormalized;
      const familyMatch = family && family === themeFamily(label);
      if (!exact && !familyMatch) return null;
      return {
        label,
        minute,
        sourceTime: String(item?.sourceTime || marketMinuteToTime(minute, true)),
        articleUrl: String(item?.articleUrl || ""),
        match: exact ? "exact" : "family",
        score: (exact ? 5 : 3.2) - Math.abs(minute - turn.minute) * .12,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || Math.abs(left.minute - turn.minute) - Math.abs(right.minute - turn.minute))[0] || null;
}

function weightedDirectionalShare(points, startMinute, endMinute, direction) {
  const source = points.filter((point) => point.minute >= startMinute && point.minute <= endMinute);
  let aligned = 0;
  let total = 0;
  for (let index = 1; index < source.length; index += 1) {
    if (source[index].minute - source[index - 1].minute > CONCEPT_SAMPLE_MAX_AGE_MINUTES) continue;
    const delta = source[index].amount - source[index - 1].amount;
    total += Math.abs(delta);
    aligned += Math.max(0, direction * delta);
  }
  return total > 0 ? Math.min(1, aligned / total) : null;
}

function pearsonCorrelation(pairs) {
  if (!Array.isArray(pairs) || pairs.length < 6) return null;
  const xMean = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const yMean = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let numerator = 0;
  let xVariance = 0;
  let yVariance = 0;
  for (const [x, y] of pairs) {
    const xDelta = x - xMean;
    const yDelta = y - yMean;
    numerator += xDelta * yDelta;
    xVariance += xDelta ** 2;
    yVariance += yDelta ** 2;
  }
  if (xVariance <= 0 || yVariance <= 0) return null;
  return Math.max(-1, Math.min(1, numerator / Math.sqrt(xVariance * yVariance)));
}

function trailingIndexFlowCorrelation(points, board, turn) {
  const indexPoints = (board?.points || [])
    .map((point, index) => ({minute: pointMinute(point, index), price: finiteNumber(point?.price)}))
    .filter((point) => point.price !== null)
    .sort((left, right) => left.minute - right.minute);
  if (indexPoints.length < 7) return null;
  const startMinute = Math.max(0, turn.revealMinute - CORRELATION_LOOKBACK_MINUTES);
  const source = points.filter((point) => point.minute >= startMinute && point.minute <= turn.revealMinute);
  const pairs = [];
  for (let index = 1; index < source.length; index += 1) {
    const previous = source[index - 1];
    const current = source[index];
    if (current.minute - previous.minute > CONCEPT_SAMPLE_MAX_AGE_MINUTES) continue;
    const previousIndex = pointAtOrBefore(indexPoints, previous.minute);
    const currentIndex = pointAtOrBefore(indexPoints, current.minute);
    if (!previousIndex || !currentIndex || currentIndex.minute <= previousIndex.minute) continue;
    const indexMove = currentIndex.price - previousIndex.price;
    const flowMove = current.amount - previous.amount;
    if (Math.abs(indexMove) <= Number.EPSILON || Math.abs(flowMove) <= Number.EPSILON) continue;
    pairs.push([indexMove, flowMove]);
  }
  return pearsonCorrelation(pairs);
}

function priceSeriesForRow(row, options = {}) {
  const series = options.priceSeriesByCode;
  if (!series) return null;
  const code = String(row?.code || row?.tdxCode || "").trim().toUpperCase();
  const name = String(row?.name || row?.tdxName || "").trim();
  if (series instanceof Map) return series.get(code) || series.get(name) || null;
  return series[code] || series[name] || null;
}

function sortedPricePoints(timeline, tradeDate = "") {
  const preClose = finiteNumber(timeline?.preClose);
  const byMinute = new Map();
  for (const [index, point] of (timeline?.points || []).entries()) {
    if (tradeDate && point?.tradeDate && point.tradeDate !== tradeDate) continue;
    const minute = pointMinute(point, index);
    const price = finiteNumber(point?.price);
    const directChange = finiteNumber(point?.changePct);
    const changePct = directChange !== null
      ? directChange
      : price !== null && preClose !== null && preClose > 0
        ? ((price - preClose) / preClose) * 100
        : null;
    if (minute < 0 || minute > 240 || changePct === null) continue;
    byMinute.set(minute, {...point, minute, changePct});
  }
  return [...byMinute.values()].sort((left, right) => left.minute - right.minute);
}

function trailingIndexPriceCorrelation(pricePoints, board, endMinute) {
  const indexPoints = (board?.points || [])
    .map((point, index) => ({minute: pointMinute(point, index), price: finiteNumber(point?.price)}))
    .filter((point) => point.price !== null)
    .sort((left, right) => left.minute - right.minute);
  if (indexPoints.length < 7 || pricePoints.length < 7) return null;
  const startMinute = Math.max(0, endMinute - CORRELATION_LOOKBACK_MINUTES);
  const pairs = [];
  let previousIndexPrice = null;
  let previousConceptChange = null;
  for (let minute = Math.ceil(startMinute); minute <= Math.floor(endMinute); minute += 1) {
    const indexPoint = pointAtOrBefore(indexPoints, minute);
    const conceptPoint = pointAtOrBefore(pricePoints, minute);
    if (!indexPoint || !conceptPoint || minute - conceptPoint.minute > 1.2) continue;
    if (previousIndexPrice !== null && previousConceptChange !== null) {
      const indexMove = indexPoint.price - previousIndexPrice;
      const conceptMove = conceptPoint.changePct - previousConceptChange;
      if (Math.abs(indexMove) > Number.EPSILON && Math.abs(conceptMove) > Number.EPSILON) {
        pairs.push([indexMove, conceptMove]);
      }
    }
    previousIndexPrice = indexPoint.price;
    previousConceptChange = conceptPoint.changePct;
  }
  return pearsonCorrelation(pairs);
}

function conciseThemeName(value) {
  const name = String(value || "").trim().replace(/概念$/u, "");
  return name.length > 8 ? `${name.slice(0, 8)}` : name;
}

function conceptEvidence(row, turn, board, options = {}) {
  const name = String(row?.name || row?.tdxName || "").trim();
  const code = String(row?.code || row?.tdxCode || "").trim().toUpperCase();
  if (!name || GENERIC_CONCEPT_PATTERN.test(name) || code === String(board?.code || "").toUpperCase()) return null;
  const points = sortedRealFlowPoints(row?.points, board?.tradeDate || "");
  if (!points.length) return null;
  const evidenceEndMinute = Math.min(turn.revealMinute, turn.minute + EVIDENCE_AFTER_PIVOT_MINUTES);
  const end = pointAtOrBefore(points, evidenceEndMinute);
  if (!end || evidenceEndMinute - end.minute > CONCEPT_SAMPLE_MAX_AGE_MINUTES) return null;
  const startMinute = Math.max(points[0].minute, turn.minute - CONCEPT_LOOKBACK_MINUTES);
  const start = pointAtOrBefore(points, startMinute);
  const hasFreshStart = Boolean(
    start
    && startMinute - start.minute <= CONCEPT_SAMPLE_MAX_AGE_MINUTES
    && end.minute > start.minute,
  );
  const flowDelta = hasFreshStart ? end.amount - start.amount : null;
  const priceTimeline = priceSeriesForRow(row, options);
  const pricePoints = sortedPricePoints(priceTimeline, board?.tradeDate || "");
  const priceEnd = pointAtOrBefore(pricePoints, evidenceEndMinute);
  const priceStart = pointAtOrBefore(pricePoints, startMinute);
  const hasFreshPrice = Boolean(
    priceEnd
    && priceStart
    && evidenceEndMinute - priceEnd.minute <= 1.2
    && startMinute - priceStart.minute <= 1.2
    && priceEnd.minute > priceStart.minute,
  );
  const endChangePct = hasFreshPrice ? finiteNumber(priceEnd.changePct) : finiteNumber(end.changePct);
  const startChangePct = hasFreshPrice ? finiteNumber(priceStart.changePct) : (hasFreshStart ? finiteNumber(start.changePct) : null);
  const changeDelta = startChangePct !== null && endChangePct !== null
    ? endChangePct - startChangePct
    : null;
  const direction = turn.direction;
  const directionalFlow = flowDelta === null ? null : direction * flowDelta;
  const directionalPrice = changeDelta === null ? null : direction * changeDelta;
  const directionalCumulative = direction * end.amount;
  const flowAligned = directionalFlow !== null && directionalFlow >= MIN_FLOW_MOMENTUM_YI;
  const priceAligned = directionalPrice !== null && directionalPrice >= MIN_PRICE_MOMENTUM_PCT;
  const localAlignmentShare = weightedDirectionalShare(points, startMinute, evidenceEndMinute, direction);
  const flowCorrelation = trailingIndexFlowCorrelation(points, board, {...turn, revealMinute: evidenceEndMinute});
  const priceCorrelation = hasFreshPrice ? trailingIndexPriceCorrelation(pricePoints, board, evidenceEndMinute) : null;
  const cls = clsConfirmation(name, turn, options.clsFeed, String(board?.tradeDate || ""), evidenceEndMinute);
  const officialTimeline = row?.flowValidated === true
    || points.some((point) => /eastmoney-board-minute-flow|东方财富.*分钟/iu.test(String(point?.source || "")));
  const requirePriceConfirmation = options.requirePriceConfirmation === true;
  if (!hasFreshStart || !flowAligned || (localAlignmentShare !== null && localAlignmentShare < MIN_LOCAL_ALIGNMENT_SHARE)) return null;
  if (requirePriceConfirmation && (!hasFreshPrice || !priceAligned)) return null;
  if (requirePriceConfirmation && priceCorrelation !== null && priceCorrelation < MIN_PRICE_CORRELATION && !cls) return null;
  const score = Math.log1p(Math.max(0, directionalFlow || 0) * 4) * 4
    + Math.max(0, directionalPrice || 0) * 10
    + Math.log1p(Math.max(0, directionalCumulative)) * .35
    + (flowAligned && priceAligned ? 2.4 : 0)
    + (localAlignmentShare === null ? 0 : Math.max(0, localAlignmentShare - .5) * 5)
    + (flowCorrelation === null ? 0 : Math.max(-1.5, flowCorrelation * 1.5))
    + (priceCorrelation === null ? 0 : Math.max(-3, priceCorrelation * 6))
    + (cls?.score || 0)
    + (officialTimeline ? 1.4 : 0)
    - Math.max(0, turn.revealMinute - end.minute) * .25;
  return {
    conceptCode: code,
    conceptName: name,
    flowAmount: end.amount,
    flowDelta,
    conceptChangePct: endChangePct,
    conceptChangeDelta: changeDelta,
    evidenceStartMinute: startMinute,
    evidenceEndMinute,
    sampleMinute: end.minute,
    sampleTime: String(end.time || marketMinuteToTime(end.minute, true)),
    source: String(end.source || row?.source || "真实概念板块资金样本"),
    hasFreshStart,
    flowAligned,
    priceAligned,
    localAlignmentShare,
    correlation: priceCorrelation,
    flowCorrelation,
    hasFreshPrice,
    priceSource: String(priceTimeline?.source || ""),
    clsConfirmation: cls,
    officialTimeline,
    score,
  };
}

function confidenceFor(evidence, ranked) {
  const comparison = (ranked || []).slice(0, 3);
  const comparisonScore = comparison.reduce((sum, item) => sum + Math.max(0, item.score), 0);
  const dominance = comparisonScore > 0 ? Math.max(0, evidence.score) / comparisonScore : 0;
  const secondScore = Math.max(0, comparison[1]?.score || 0);
  const margin = evidence.score > 0 ? Math.max(0, Math.min(1, (evidence.score - secondScore) / evidence.score)) : 0;
  const raw = 49
    + (evidence.officialTimeline ? 6 : 0)
    + (evidence.hasFreshStart ? 6 : 0)
    + (evidence.priceAligned ? 5 : 0)
    + (evidence.hasFreshPrice ? 7 : 0)
    + (evidence.localAlignmentShare === null ? 0 : Math.max(0, evidence.localAlignmentShare - .5) * 14)
    + (evidence.correlation === null ? 0 : Math.max(-6, evidence.correlation * 12))
    + (evidence.clsConfirmation ? (evidence.clsConfirmation.match === "exact" ? 10 : 7) : 0)
    + dominance * 12
    + margin * 6;
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
      .map((row) => conceptEvidence(row, turn, board, options))
      .filter(Boolean)
      .sort((left, right) => right.score - left.score || left.conceptName.localeCompare(right.conceptName, "zh-CN"));
    const lead = ranked[0];
    if (!lead) {
      if (options.includeUnresolved !== true) return null;
      return {
        ...turn,
        label: "原因待确认",
        displayLabel: `${turn.direction > 0 ? "↑" : "↓"}待确认`,
        targetChangePct: targetChangeAt(board, turn.minute),
        directionName: turn.direction > 0 ? "上涨转折" : "下跌转折",
        sourceDirection: turn.direction > 0 ? "up" : "down",
        confidence: 0,
        confidenceLabel: "待确认",
        resolved: false,
        alternatives: [],
        methodology: "真实指数拐点没有匹配到同时间窗、同方向且足够新鲜的题材分钟资金证据，因此不推测原因。",
      };
    }
    const confidence = confidenceFor(lead, ranked);
    const resolved = confidence >= (finiteNumber(options.minimumConfidence) ?? MIN_CAUSE_CONFIDENCE);
    const alternatives = ranked.slice(1, 3).map((item) => ({
      name: item.conceptName,
      score: item.score,
      flowDelta: item.flowDelta,
    }));
    const candidatePool = ranked.slice(0, 6).map((item) => ({
      code: item.conceptCode,
      name: item.conceptName,
      score: item.score,
    }));
    return {
      ...turn,
      ...lead,
      label: resolved ? lead.conceptName : "原因待确认",
      candidateLabel: lead.conceptName,
      displayLabel: resolved
        ? `${turn.direction > 0 ? "↑" : "↓"}${conciseThemeName(lead.conceptName)}`
        : `${turn.direction > 0 ? "↑" : "↓"}待确认`,
      targetChangePct: targetChangeAt(board, turn.minute),
      directionName: turn.direction > 0 ? "上涨转折" : "下跌转折",
      sourceDirection: turn.direction > 0 ? "up" : "down",
      confidence,
      confidenceLabel: resolved ? (confidence >= 82 ? "高" : confidence >= 70 ? "中高" : "中") : "待确认",
      resolved,
      alternatives,
      candidatePool,
      methodology: resolved
        ? "真实指数拐点与同时间窗东方财富概念板块分钟资金增量、概念分时涨跌、局部资金同步度及指数相关性匹配；财联社同刻板块事件仅作交叉验证，不使用个股、收盘倒推或未来样本。"
        : "候选题材证据未达到可信度门槛，因此保留候选但不声明为转折成因。",
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
  CORRELATION_LOOKBACK_MINUTES,
  EVIDENCE_AFTER_PIVOT_MINUTES,
  GENERIC_CONCEPT_PATTERN,
  MIN_CAUSE_CONFIDENCE,
  MAX_SIGNIFICANT_TURNS,
};
