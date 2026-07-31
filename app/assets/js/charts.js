import {finiteNumber, signed, valueClass} from "./analysis.js";
import {marketMinuteToTime, SESSION_MINUTES} from "./market-session.js";

export {marketMinuteToTime} from "./market-session.js";

function pointMinute(point, index) {
  const minute = finiteNumber(point?.minute);
  return minute === null ? index : minute;
}

function interpolateNumber(start, end, ratio) {
  const startValue = finiteNumber(start);
  const endValue = finiteNumber(end);
  if (startValue === null) return endValue;
  if (endValue === null) return startValue;
  return startValue + (endValue - startValue) * ratio;
}

export function visiblePoints(points, minute) {
  const source = (points || []).filter((point) => finiteNumber(point.price) !== null);
  if (!source.length) return [];
  const visible = [];
  let previous = null;
  let next = null;
  for (let index = 0; index < source.length; index += 1) {
    const point = source[index];
    if (pointMinute(point, index) <= minute) {
      visible.push(point);
      previous = point;
    } else {
      next = point;
      break;
    }
  }
  if (!previous) return [];
  if (!next) return visible;
  const previousMinute = pointMinute(previous, Math.max(0, visible.length - 1));
  const nextMinute = pointMinute(next, visible.length);
  if (minute <= previousMinute || nextMinute <= previousMinute) return visible;
  const ratio = Math.max(0, Math.min(1, (minute - previousMinute) / (nextMinute - previousMinute)));
  visible.push({
    ...previous,
    minute,
    time: marketMinuteToTime(minute, true),
    price: interpolateNumber(previous.price, next.price, ratio),
    amount: interpolateNumber(previous.amount, next.amount, ratio),
    volume: interpolateNumber(previous.volume, next.volume, ratio),
  });
  return visible;
}

const CHART_WIDTH = 260;
const CHART_HEIGHT = 116;
const CHART_PADDING_Y = 9;

function pathFor(points, preClose, domainPoints = points, width = CHART_WIDTH, height = CHART_HEIGHT) {
  if (!points.length) {
    return {
      path: "",
      x: 0,
      y: height / 2,
      baselineY: height / 2,
      xForMinute: () => 0,
      yForPrice: () => height / 2,
    };
  }
  const prices = (domainPoints || points).map((point) => finiteNumber(point.price)).filter((price) => price !== null);
  const min = Math.min(...prices, finiteNumber(preClose) ?? prices[0]);
  const max = Math.max(...prices, finiteNumber(preClose) ?? prices[0]);
  const spread = Math.max(max - min, Math.abs(max) * .001, 0.01);
  const xFor = (point, index) => (Math.max(0, Math.min(SESSION_MINUTES, pointMinute(point, index))) / SESSION_MINUTES) * width;
  const plotHeight = height - CHART_PADDING_Y * 2;
  const yFor = (price) => height - CHART_PADDING_Y - ((price - min) / spread) * plotHeight;
  const path = points.map((point, index) => `${index ? "L" : "M"}${xFor(point, index).toFixed(2)},${yFor(Number(point.price)).toFixed(2)}`).join(" ");
  const last = points.at(-1);
  return {
    path,
    x: xFor(last, points.length - 1),
    y: yFor(Number(last.price)),
    baselineY: yFor(finiteNumber(preClose) ?? prices[0]),
    xForMinute: (minute) => (Math.max(0, Math.min(SESSION_MINUTES, finiteNumber(minute) ?? 0)) / SESSION_MINUTES) * width,
    yForPrice: yFor,
  };
}

const TURNING_NOISE_LOOKBACK_MINUTES = 60;
const TURNING_SMOOTH_RADIUS = 1;
const TURNING_NOISE_MULTIPLIER = 2;
const TURNING_BASE_REVERSAL_PCT = 0.25;
const TURNING_MIN_REVERSAL_PCT = 0.14;
const TURNING_TARGET_MIN = 10;
const ATTRIBUTION_FLOW_LOOKBACK_MINUTES = 6;
const ATTRIBUTION_SAMPLE_MAX_AGE = 3;
const ATTRIBUTION_MIN_CUMULATIVE_FLOW_YI = 0.5;
const ATTRIBUTION_CANDIDATES_PER_KIND = 2;
const ATTRIBUTION_MAX_PER_SECTOR = 2;
const ATTRIBUTION_MIN_EVENT_GAP = 10;
const ATTRIBUTION_RELAXED_EVENT_GAP = 7;
const ATTRIBUTION_MIN_EVENTS = 5;
const ATTRIBUTION_MAX_EVENTS = 6;
const SVG_NS = "http://www.w3.org/2000/svg";
const GENERIC_CONCEPT_PATTERN = /融资融券|MSCI|富时罗素|沪股通|深股通|QFII|基金重仓|机构重仓|证金持股|社保重仓|大盘股|中盘股|小盘股|科技风格|价值风格|高贝塔|HS300|(?:中证|上证|深成|创业板|科创)\d+|20\d{2}(?:一季报|中报|三季报|年报)|百日新高|百元股|破净股|昨日涨停|AB股|AH股|转债标的/i;

function isAshareIndex(index) {
  return index?.session !== "us" && index?.code !== "IXIC" && index?.name !== "纳斯达克";
}

function percentile(values, ratio) {
  const sorted = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function smoothedIndexPoints(index) {
  const source = (index?.points || [])
    .map((point, pointIndex) => ({minute: pointMinute(point, pointIndex), price: finiteNumber(point?.price)}))
    .filter((point) => point.price !== null)
    .sort((a, b) => a.minute - b.minute);
  return source.map((point, pointIndex) => {
    const nearby = source.slice(
      Math.max(0, pointIndex - TURNING_SMOOTH_RADIUS),
      Math.min(source.length, pointIndex + TURNING_SMOOTH_RADIUS + 1),
    );
    return {...point, smoothPrice: nearby.reduce((sum, item) => sum + item.price, 0) / nearby.length};
  });
}

function turningReversalThreshold(points, preClose) {
  const noiseSource = points.filter((point) => point.minute <= TURNING_NOISE_LOOKBACK_MINUTES);
  const sampled = noiseSource.length >= 12 ? noiseSource : points;
  const minuteMoves = sampled.slice(1).map((point, pointIndex) => (
    Math.abs(point.price - sampled[pointIndex].price) / preClose
  ) * 100);
  return Math.max(TURNING_BASE_REVERSAL_PCT, percentile(minuteMoves, .75) * TURNING_NOISE_MULTIPLIER);
}

function detectTurningPoints(points, preClose, reversalPct) {
  if (points.length < 3 || !Number.isFinite(preClose) || preClose <= 0) return [];
  const reversalAmount = preClose * reversalPct / 100;
  const pivots = [];
  let trend = 0;
  let extreme = points[0];
  let initialHigh = points[0];
  let initialLow = points[0];

  const pushPivot = (type, pivot, reveal, reversal) => {
    const nearby = points.filter((point) => Math.abs(point.minute - pivot.minute) <= TURNING_SMOOTH_RADIUS + 1 && point.minute <= reveal.minute);
    const snappedPivot = nearby.reduce((selected, point) => {
      if (!selected) return point;
      return type === "low"
        ? (point.price < selected.price ? point : selected)
        : (point.price > selected.price ? point : selected);
    }, null) || pivot;
    const previous = pivots.at(-1);
    const swingPct = previous ? (Math.abs(snappedPivot.price - previous.price) / preClose) * 100 : reversal;
    pivots.push({
      pivotType: type,
      direction: type === "low" ? 1 : -1,
      minute: snappedPivot.minute,
      revealMinute: reveal.minute,
      price: snappedPivot.price,
      reversalPct: reversal,
      swingPct,
      turnStrength: reversal + Math.min(2.5, swingPct) * .45,
      reversalThresholdPct: reversalPct,
    });
  };

  for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
    const point = points[pointIndex];
    if (trend === 0) {
      if (point.smoothPrice >= initialHigh.smoothPrice) initialHigh = point;
      if (point.smoothPrice <= initialLow.smoothPrice) initialLow = point;
      if (point.smoothPrice - initialLow.smoothPrice >= reversalAmount) {
        pushPivot("low", initialLow, point, ((point.smoothPrice - initialLow.smoothPrice) / preClose) * 100);
        trend = 1;
        extreme = point;
      } else if (initialHigh.smoothPrice - point.smoothPrice >= reversalAmount) {
        pushPivot("high", initialHigh, point, ((initialHigh.smoothPrice - point.smoothPrice) / preClose) * 100);
        trend = -1;
        extreme = point;
      }
      continue;
    }
    if (trend > 0) {
      if (point.smoothPrice >= extreme.smoothPrice) extreme = point;
      const reversal = extreme.smoothPrice - point.smoothPrice;
      if (reversal >= reversalAmount) {
        pushPivot("high", extreme, point, (reversal / preClose) * 100);
        trend = -1;
        extreme = point;
      }
      continue;
    }
    if (point.smoothPrice <= extreme.smoothPrice) extreme = point;
    const reversal = point.smoothPrice - extreme.smoothPrice;
    if (reversal >= reversalAmount) {
      pushPivot("low", extreme, point, (reversal / preClose) * 100);
      trend = 1;
      extreme = point;
    }
  }
  return pivots;
}

export function buildIndexTurningPoints(index, firstUsableMinute = 0) {
  if (!isAshareIndex(index)) return [];
  const points = smoothedIndexPoints(index);
  const preClose = finiteNumber(index?.preClose);
  if (points.length < 3 || preClose === null || preClose <= 0) return [];
  const latestMinute = points.at(-1).minute;
  let threshold = turningReversalThreshold(points, preClose);
  let pivots = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    pivots = detectTurningPoints(points, preClose, threshold)
      .filter((pivot) => pivot.minute >= firstUsableMinute && pivot.revealMinute <= latestMinute);
    if (pivots.length >= TURNING_TARGET_MIN || threshold <= TURNING_MIN_REVERSAL_PCT) break;
    threshold = Math.max(TURNING_MIN_REVERSAL_PCT, threshold * .82);
  }
  return pivots;
}

function sectorPointAtOrBefore(points, minute) {
  let selected = null;
  for (let index = 0; index < (points || []).length; index += 1) {
    const point = points[index];
    const sampleMinute = pointMinute(point, index);
    if (sampleMinute > minute) break;
    if (finiteNumber(point?.amount) === null) continue;
    const carriedFrom = finiteNumber(point?.carriedFrom);
    if (carriedFrom !== null && carriedFrom > sampleMinute && carriedFrom > minute) continue;
    selected = point;
  }
  return selected;
}

function sectorContribution(row, startMinute, endMinute, direction) {
  if (row?.sectorKind === "concept" && GENERIC_CONCEPT_PATTERN.test(String(row?.name || row?.tdxName || ""))) return null;
  const start = sectorPointAtOrBefore(row?.points, startMinute);
  const end = sectorPointAtOrBefore(row?.points, endMinute);
  if (!end) return null;
  const endSampleMinute = pointMinute(end, 0);
  if (endMinute - endSampleMinute > ATTRIBUTION_SAMPLE_MAX_AGE) return null;
  const flowAmount = Number(end.amount);
  const flowDirection = Math.sign(flowAmount);
  if (!Number.isFinite(flowAmount) || flowDirection !== direction || Math.abs(flowAmount) < ATTRIBUTION_MIN_CUMULATIVE_FLOW_YI) return null;
  const startSampleMinute = start ? pointMinute(start, 0) : null;
  const hasFreshStart = start && startMinute - startSampleMinute <= ATTRIBUTION_SAMPLE_MAX_AGE && endSampleMinute > startSampleMinute;
  const flowDelta = hasFreshStart ? flowAmount - Number(start.amount) : 0;
  const startChangePct = hasFreshStart ? finiteNumber(start.changePct) : null;
  const endChangePct = finiteNumber(end.changePct);
  const rawSectorChangePct = startChangePct !== null && endChangePct !== null ? endChangePct - startChangePct : null;
  const sectorChangePct = rawSectorChangePct !== null && Math.abs(rawSectorChangePct) > 0.0001 ? rawSectorChangePct : null;
  const directionalDelta = direction * flowDelta;
  const flowMomentum = Math.max(0, directionalDelta);
  const flowScore = Math.log1p(Math.abs(flowAmount)) + Math.log1p(flowMomentum * 2) * .9;
  const alignmentBoost = sectorChangePct === null
    ? 1
    : Math.sign(sectorChangePct) === direction
      ? 1 + Math.min(1.5, Math.abs(sectorChangePct) * 1.25)
      : .72;
  return {
    sectorName: String(row?.name || row?.tdxName || "行业板块"),
    sectorKind: row?.sectorKind === "concept" ? "concept" : "industry",
    sectorKindLabel: row?.sectorKind === "concept" ? "题材" : "行业",
    flowAmount,
    flowDelta,
    flowDirection,
    directionalDelta,
    sectorChangePct,
    sampleAge: Math.max(0, endMinute - endSampleMinute),
    hasFreshStart: Boolean(hasFreshStart),
    score: flowScore * alignmentBoost,
  };
}

export function buildSectorAttributionCandidates(index, industryRows) {
  if (!isAshareIndex(index)) return [];
  const firstSectorMinute = Math.min(...industryRows.flatMap((row) => (row?.points || []).map((point, pointIndex) => pointMinute(point, pointIndex))));
  if (!Number.isFinite(firstSectorMinute)) return [];
  const turningPoints = buildIndexTurningPoints(index, firstSectorMinute);
  const candidates = [];
  for (const turn of turningPoints) {
    const startMinute = Math.max(firstSectorMinute, turn.minute - ATTRIBUTION_FLOW_LOOKBACK_MINUTES);
    const endMinute = turn.revealMinute;
    const contributions = industryRows
      .map((row) => sectorContribution(row, startMinute, endMinute, turn.direction))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    const leading = ["industry", "concept"].flatMap((sectorKind) => (
      contributions.filter((item) => item.sectorKind === sectorKind).slice(0, ATTRIBUTION_CANDIDATES_PER_KIND)
    ));
    const comparisonScore = leading.reduce((sum, item) => sum + item.score, 0);
    leading.forEach((contribution, rank) => {
      const dominance = comparisonScore > 0 ? contribution.score / comparisonScore : 1;
      const alignmentScore = contribution.sectorChangePct === null || Math.sign(contribution.sectorChangePct) === turn.direction ? 12 : 2;
      const confidence = Math.max(35, Math.min(96, Math.round(
        42 + dominance * 34 + alignmentScore + (contribution.hasFreshStart ? 7 : 0) - contribution.sampleAge * 1.5 - rank * 4,
      )));
      candidates.push({
        ...contribution,
        ...turn,
        dominance,
        confidence,
        confidenceLabel: confidence >= 80 ? "高" : confidence >= 62 ? "中" : "观察",
        strength: turn.turnStrength * contribution.score * (0.9 + dominance) * (1 - rank * .08),
      });
    });
  }
  return candidates;
}

export function buildPersistentSectorAttributions(candidates) {
  const turnGroups = new Map();
  for (const candidate of candidates || []) {
    const key = `${candidate.minute}:${candidate.pivotType}`;
    if (!turnGroups.has(key)) turnGroups.set(key, []);
    turnGroups.get(key).push(candidate);
  }
  const turns = [...turnGroups.values()].map((turnCandidates) => {
    const ranked = turnCandidates.sort((a, b) => b.strength - a.strength);
    const lead = ranked[0];
    const flowConfirmationBoost = 1 + Math.min(.25, Math.log1p(Math.abs(lead.flowAmount)) * .035);
    return {
      minute: lead.minute,
      pivotType: lead.pivotType,
      importance: lead.turnStrength * flowConfirmationBoost,
      candidates: ranked,
    };
  });

  const chooseSpacedTurns = (minimumGap) => {
    const selectedTurns = [];
    for (const turn of [...turns].sort((a, b) => b.importance - a.importance)) {
      if (selectedTurns.some((selected) => Math.abs(selected.minute - turn.minute) < minimumGap)) continue;
      selectedTurns.push(turn);
      if (selectedTurns.length >= ATTRIBUTION_MAX_EVENTS) break;
    }
    return selectedTurns;
  };

  let selectedTurns = chooseSpacedTurns(ATTRIBUTION_MIN_EVENT_GAP);
  if (selectedTurns.length < ATTRIBUTION_MIN_EVENTS) selectedTurns = chooseSpacedTurns(ATTRIBUTION_RELAXED_EVENT_GAP);
  const selected = [];
  const sectorCounts = new Map();
  const categoryCounts = new Map([["industry", 0], ["concept", 0]]);
  for (const turn of selectedTurns.sort((a, b) => a.minute - b.minute)) {
    const desiredKinds = categoryCounts.get("industry") <= categoryCounts.get("concept")
      ? ["industry", "concept"]
      : ["concept", "industry"];
    let candidate = null;
    for (const sectorKind of desiredKinds) {
      candidate = turn.candidates.find((item) => (
        item.sectorKind === sectorKind
        && (sectorCounts.get(item.sectorName) || 0) < ATTRIBUTION_MAX_PER_SECTOR
      ));
      if (candidate) break;
    }
    if (!candidate) continue;
    const sectorCount = sectorCounts.get(candidate.sectorName) || 0;
    selected.push({...candidate, revealMinute: candidate.revealMinute ?? candidate.minute});
    sectorCounts.set(candidate.sectorName, sectorCount + 1);
    categoryCounts.set(candidate.sectorKind, (categoryCounts.get(candidate.sectorKind) || 0) + 1);
  }
  return selected.sort((a, b) => a.minute - b.minute);
}

export function selectSectorAttributions(events, minute) {
  const visibleMinute = Math.floor(Number(minute) || 0);
  return (events || []).filter((item) => (item.revealMinute ?? item.minute) <= visibleMinute);
}

function indexPointAtOrBefore(index, minute) {
  let selected = null;
  for (let pointIndex = 0; pointIndex < (index?.points || []).length; pointIndex += 1) {
    const point = index.points[pointIndex];
    const sampleMinute = pointMinute(point, pointIndex);
    if (sampleMinute > minute) break;
    if (finiteNumber(point?.price) !== null) selected = {...point, minute: sampleMinute};
  }
  return selected;
}

export function buildClsIndexAnnotationEvents(index, annotationFeed) {
  if (!isAshareIndex(index) || !Array.isArray(annotationFeed?.items)) return [];
  if (annotationFeed.tradeDate && index?.tradeDate && annotationFeed.tradeDate !== index.tradeDate) return [];
  return annotationFeed.items.map((item) => {
    const sourceSchema = String(item?.sourceSchema || "").toLowerCase();
    const symbolCode = String(item?.symbolCode || "").toLowerCase();
    const isPlate = item?.sourceType === "plate"
      || sourceSchema.includes("plate_detail")
      || /^cls\d+$/.test(symbolCode);
    const isStock = sourceSchema.includes("stock_detail") || /^(?:sh|sz|bj)\d{6}$/.test(symbolCode);
    if (!isPlate || isStock) return null;
    const minute = finiteNumber(item?.minute);
    const label = String(item?.label || "").trim();
    if (minute === null || !label) return null;
    const point = indexPointAtOrBefore(index, minute);
    const price = finiteNumber(point?.price);
    if (price === null || minute - Number(point.minute) > 3) return null;
    const sourceDirection = item?.sourceDirection === "up" ? "up" : item?.sourceDirection === "down" ? "down" : "neutral";
    return {
      ...item,
      minute,
      revealMinute: minute,
      price,
      label,
      sourceDirection,
      flowDirection: sourceDirection === "up" ? 1 : sourceDirection === "down" ? -1 : 0,
    };
  }).filter(Boolean).sort((left, right) => left.minute - right.minute);
}

export function selectClsIndexAnnotations(events, minute) {
  const visibleMinute = Number(minute) || 0;
  return (events || []).filter((item) => item.minute <= visibleMinute);
}

function formatFlowDelta(value) {
  const amount = Number(value) || 0;
  const absolute = Math.abs(amount);
  const digits = absolute >= 100 ? 0 : 1;
  return `${amount > 0 ? "+" : ""}${amount.toFixed(digits)}亿`;
}

function measureAttributionLabel(layer, labelText) {
  const probe = document.createElementNS(SVG_NS, "text");
  probe.classList.add("index-attribution-label");
  probe.setAttribute("x", "0");
  probe.setAttribute("y", "0");
  probe.setAttribute("opacity", "0");
  probe.setAttribute("pointer-events", "none");
  probe.textContent = labelText;
  layer.append(probe);
  let box = {width: labelText.length * 8, height: 11};
  try {
    const measured = probe.getBBox();
    if (measured.width > 0 && measured.height > 0) box = measured;
  } finally {
    probe.remove();
  }
  return {
    width: Math.min(178, Math.max(52, box.width + 4)),
    height: Math.max(11, box.height + 2),
  };
}

function renderClsIndexAnnotations(chart, minute, geometry) {
  const selected = selectClsIndexAnnotations(chart.attributionEvents, minute)
    .sort((left, right) => left.minute - right.minute);
  const nodes = [];
  const labels = [];
  for (const item of selected) {
    const group = document.createElementNS(SVG_NS, "g");
    const toneClass = item.sourceDirection === "up" ? "gain-mark" : item.sourceDirection === "down" ? "loss-mark" : "neutral-mark";
    group.classList.add("index-attribution", "cls-index-annotation", toneClass);
    group.dataset.source = "财联社盘面直播";
    group.dataset.sourceTime = String(item.sourceTime || "");
    group.dataset.articleId = String(item.articleId || "");
    const title = document.createElementNS(SVG_NS, "title");
    const directionText = item.sourceDirection === "up" ? "上涨" : item.sourceDirection === "down" ? "下跌" : "未标方向";
    title.textContent = `来源：财联社盘面直播｜${item.sourceTime || marketMinuteToTime(item.minute, true)}｜${item.label}｜${directionText}`;
    const x = geometry.xForMinute(item.minute);
    const y = geometry.yForPrice(item.price);
    const labelText = item.label;
    const labelMetrics = measureAttributionLabel(chart.attributionLayer, labelText);
    const estimatedWidth = labelMetrics.width;
    const labelHalfHeight = labelMetrics.height / 2;
    const preferAnchorEnd = x + estimatedWidth > CHART_WIDTH - 3;
    const anchorCandidates = preferAnchorEnd ? [true, false] : [false, true];
    const ascendingLanes = [];
    const laneStep = labelMetrics.height + 1;
    for (let lane = labelHalfHeight + 2; lane <= CHART_HEIGHT - labelHalfHeight - 2; lane += laneStep) ascendingLanes.push(lane);
    const laneCandidates = item.sourceDirection === "down" ? [...ascendingLanes].reverse() : ascendingLanes;
    let placement = null;
    for (const lane of laneCandidates) {
      for (const anchorEnd of anchorCandidates) {
        const labelX = x + (anchorEnd ? -3 : 3);
        const left = anchorEnd ? labelX - estimatedWidth : labelX;
        const candidateBox = {left, right: left + estimatedWidth, top: lane - labelHalfHeight, bottom: lane + labelHalfHeight};
        if (candidateBox.left < 3 || candidateBox.right > CHART_WIDTH - 3) continue;
        const overlaps = labels.some((box) => !(candidateBox.right + 2 <= box.left || box.right + 2 <= candidateBox.left || candidateBox.bottom <= box.top || box.bottom <= candidateBox.top));
        if (!overlaps) {
          placement = {anchorEnd, labelX, labelY: lane, labelBox: candidateBox};
          break;
        }
      }
      if (placement) break;
    }
    if (!placement) continue;
    const {anchorEnd, labelX, labelY, labelBox} = placement;
    const stem = document.createElementNS(SVG_NS, "line");
    stem.classList.add("index-attribution-stem");
    stem.setAttribute("x1", x.toFixed(2));
    stem.setAttribute("x2", x.toFixed(2));
    stem.setAttribute("y1", y.toFixed(2));
    stem.setAttribute("y2", labelY.toFixed(2));
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.classList.add("index-attribution-dot");
    dot.setAttribute("cx", x.toFixed(2));
    dot.setAttribute("cy", y.toFixed(2));
    dot.setAttribute("r", "1.8");
    const text = document.createElementNS(SVG_NS, "text");
    text.classList.add("index-attribution-label");
    text.setAttribute("x", labelX.toFixed(2));
    text.setAttribute("y", labelY.toFixed(2));
    text.setAttribute("text-anchor", anchorEnd ? "end" : "start");
    text.setAttribute("dominant-baseline", "middle");
    text.textContent = labelText;
    group.append(title, stem, dot, text);
    nodes.push(group);
    labels.push(labelBox);
  }
  chart.attributionLayer.replaceChildren(...nodes);
}

export function createIndexCharts(container, indices, annotationFeed = {}, options = {}) {
  const charts = [];
  const fragment = document.createDocumentFragment();
  for (const index of indices || []) {
    const article = document.createElement("article");
    article.className = "index-card";
    article.dataset.indexKey = index.key || index.code || "";
    article.dataset.timelineState = index.error ? "error" : index.loading ? "loading" : index.points?.length ? "ready" : "pending";
    article.innerHTML = `
      <div class="index-card-header"><strong></strong><span></span><button class="index-card-remove" type="button" title="移除指数" aria-label="移除指数">×</button></div>
      <div class="index-values"><strong></strong><span class="points"></span><span class="pct"></span></div>
      <svg class="index-chart" viewBox="0 0 260 116" preserveAspectRatio="none" role="img">
        <title></title><line class="grid" x1="0" x2="260" y1="29" y2="29"></line><line class="baseline" x1="0" x2="260" y1="58" y2="58"></line><line class="grid" x1="0" x2="260" y1="87" y2="87"></line><path class="line"></path><g class="index-attributions"></g><circle class="cursor" r="2.8"></circle>
      </svg>
      <div class="index-card-footer"><span class="amount"></span><span class="sample"></span></div>`;
    article.querySelector(".index-card-header strong").textContent = index.name || "--";
    article.querySelector(".index-card-header span").textContent = index.tradeDate || "--";
    const removeButton = article.querySelector(".index-card-remove");
    removeButton.title = `移除${index.name || "指数"}`;
    removeButton.setAttribute("aria-label", `移除${index.name || "指数"}`);
    removeButton.addEventListener("click", () => options.onRemove?.(index.key || index.code));
    article.querySelector("title").textContent = `${index.name || "指数"}分时图`;
    fragment.append(article);
    charts.push({
      data: index,
      article,
      price: article.querySelector(".index-values strong"),
      points: article.querySelector(".points"),
      pct: article.querySelector(".pct"),
      amount: article.querySelector(".amount"),
      sample: article.querySelector(".sample"),
      path: article.querySelector(".line"),
      baseline: article.querySelector(".baseline"),
      cursor: article.querySelector(".cursor"),
      attributionLayer: article.querySelector(".index-attributions"),
      attributionEvents: buildClsIndexAnnotationEvents(index, annotationFeed),
      annotationSource: annotationFeed?.source || "财联社盘面直播",
      annotationStatus: annotationFeed?.status || "unavailable",
    });
  }
  container.replaceChildren(fragment);
  return charts;
}

export function updateIndexCharts(charts, minute) {
  for (const chart of charts) {
    const points = visiblePoints(chart.data.points, minute);
    const last = points.at(-1) || {};
    const auctionQuote = minute <= 0.01 ? chart.data.liveAuctionQuote : null;
    const displayPoint = auctionQuote || last;
    const price = finiteNumber(displayPoint.price);
    const preClose = finiteNumber(chart.data.preClose);
    const change = price !== null && preClose !== null ? price - preClose : null;
    const pct = change !== null && preClose ? (change / preClose) * 100 : null;
    const className = valueClass(change);
    chart.price.textContent = price === null ? "--" : price.toLocaleString("zh-CN", {minimumFractionDigits: 2, maximumFractionDigits: 2});
    chart.points.textContent = signed(change, 2);
    chart.pct.textContent = signed(pct, 2, "%");
    chart.points.className = `points ${className}`;
    chart.pct.className = `pct ${className}`;
    chart.path.classList.toggle("loss-line", (change || 0) < 0);
    chart.article.classList.toggle("snapshot-only", chart.data.snapshotOnly === true);
    const geometry = pathFor(points, preClose, chart.data.points || points);
    chart.path.setAttribute("d", geometry.path);
    chart.baseline.setAttribute("y1", geometry.baselineY.toFixed(2));
    chart.baseline.setAttribute("y2", geometry.baselineY.toFixed(2));
    chart.cursor.setAttribute("cx", geometry.x.toFixed(2));
    chart.cursor.setAttribute("cy", geometry.y.toFixed(2));
    chart.cursor.style.color = `var(--${className === "loss" ? "loss" : "gain"})`;
    renderClsIndexAnnotations(chart, minute, geometry);
    const amount = finiteNumber(displayPoint.amount);
    chart.amount.textContent = amount === null ? "成交额 --" : `成交额 ${(amount / 100000000).toFixed(1)}亿`;
    chart.sample.textContent = !chart.data.points?.length
      ? (chart.data.error ? "真实分时重连中" : "真实分时加载中")
      : auctionQuote
      ? `${auctionQuote.sourceTime || "--"} 集合竞价`
      : chart.data.snapshotOnly
      ? `${marketMinuteToTime(finiteNumber(last.minute) ?? minute, true)} 仅快照`
      : marketMinuteToTime(finiteNumber(last.minute) ?? minute, true);
  }
}

export function createPlaybackController(options) {
  const {timeline, playButton, speedSelect, onFrame, onTime} = options;
  let playing = false;
  let animationFrame = 0;
  let lastPaint = 0;
  let lastStep = 0;
  let position = Number(timeline.value) || 0;
  const frameInterval = 1000 / 30;

  function paint(timestamp = performance.now(), value = position, force = false) {
    if (!force && timestamp - lastPaint < frameInterval) return;
    lastPaint = timestamp;
    onFrame(value);
    onTime(marketMinuteToTime(value, true));
  }

  function tick(timestamp) {
    if (!playing) return;
    if (!lastStep) {
      lastStep = timestamp;
      animationFrame = requestAnimationFrame(tick);
      return;
    }
    const elapsedSeconds = Math.max(0, Math.min(0.1, (timestamp - lastStep) / 1000));
    lastStep = timestamp;
    const speed = Math.max(1, Number(speedSelect.value) || 1);
    position = Math.min(Number(timeline.max), position + elapsedSeconds * speed);
    timeline.value = position.toFixed(3);
    paint(timestamp, position);
    if (position >= Number(timeline.max)) {
      paint(timestamp, position, true);
      stop();
      return;
    }
    animationFrame = requestAnimationFrame(tick);
  }

  function start() {
    if (playing || document.hidden) return;
    if (Number(timeline.value) >= Number(timeline.max)) timeline.value = timeline.min;
    position = Number(timeline.value) || 0;
    playing = true;
    lastStep = 0;
    playButton.textContent = "Ⅱ";
    playButton.setAttribute("aria-label", "暂停分时");
    animationFrame = requestAnimationFrame(tick);
  }

  function stop() {
    playing = false;
    cancelAnimationFrame(animationFrame);
    lastStep = 0;
    playButton.textContent = "▶";
    playButton.setAttribute("aria-label", "播放分时");
  }

  timeline.step = "0.001";
  playButton.addEventListener("click", () => playing ? stop() : start());
  timeline.addEventListener("input", (event) => {
    position = Number(event.currentTarget.value) || 0;
    paint(event.timeStamp || performance.now(), position, true);
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
  window.addEventListener("pagehide", stop, {once: true});
  paint(performance.now(), position, true);
  return {start, stop, paint, isPlaying: () => playing, getPosition: () => position};
}
