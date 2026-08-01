"use strict";

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function jsonSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value || {}), "utf8");
  } catch (_) {
    return 0;
  }
}

function validationRank(value) {
  const status = String(value?.validation?.status || value?.overall?.status || "").toLowerCase();
  if (status === "ok") return 3;
  if (status === "warning") return 2;
  if (status === "pending") return 1;
  return 0;
}

function compareQuality(left, right) {
  const maximum = Math.max(left.length, right.length);
  for (let index = 0; index < maximum; index += 1) {
    const difference = finite(left[index]) - finite(right[index]);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function indexMetrics(value) {
  const items = rows(value?.items || value?.indices || (value?.index ? [value.index] : []));
  const pointCounts = items.map((item) => rows(item?.points).length);
  return {
    itemCount: items.length,
    coveredItems: pointCounts.filter((count) => count > 0).length,
    minimumPoints: pointCounts.length ? Math.min(...pointCounts) : 0,
    totalPoints: pointCounts.reduce((sum, count) => sum + count, 0),
  };
}

function sectorMetrics(value) {
  const industry = value?.industry || {};
  const concept = value?.concept || {};
  const industryPointCounts = rows(industry.rows).map((item) => rows(item?.points).length);
  const conceptPointCounts = rows(concept.rows).map((item) => rows(item?.points).length);
  const derivedTimelineCount = [...industryPointCounts, ...conceptPointCounts].filter((count) => count > 1).length;
  const derivedSampleCount = [...industryPointCounts, ...conceptPointCounts].reduce((sum, count) => sum + count, 0);
  return {
    rowCount: rows(industry.rows).length + rows(concept.rows).length,
    timelineCount: Math.max(
      finite(industry.flowTimelineCount) + finite(concept.flowTimelineCount),
      derivedTimelineCount,
    ),
    sampleCount: Math.max(
      finite(industry.flowSampleCount) + finite(concept.flowSampleCount),
      derivedSampleCount,
    ),
    attributionCount: rows(industry.attributionRows).length + rows(concept.attributionRows).length,
  };
}

function legacyStockMetrics(value) {
  const market = value?.market || {};
  const groups = [
    market.limitUpStocks,
    market.limitDownStocks,
    market.brokenStocks,
    market.yesterdayLimitRows,
    market.yesterdayBrokenRows,
  ];
  return {
    populatedGroups: groups.filter((group) => rows(group).length > 0).length,
    totalRows: groups.reduce((sum, group) => sum + rows(group).length, 0),
    brokenRows: rows(market.brokenStocks).length,
  };
}

function structuredStockMetrics(value) {
  const groups = value?.groups && typeof value.groups === "object"
    ? Object.values(value.groups)
    : [];
  const rowCounts = groups.map((group) => rows(group?.rows || group).length);
  const broken = value?.groups?.broken;
  return {
    groupCount: groups.length,
    populatedGroups: rowCounts.filter((count) => count > 0).length,
    totalRows: rowCounts.reduce((sum, count) => sum + count, 0),
    brokenRows: rows(broken?.rows || broken).length,
  };
}

function isPlateAnnotation(item) {
  const schema = String(item?.sourceSchema || item?.schema || "").toLowerCase();
  const sourceType = String(item?.sourceType || "").toLowerCase();
  const code = String(item?.sourceCode || item?.code || "").toLowerCase();
  if (schema === "stock_detail" || /^(?:sh|sz|bj)\d{6}$/u.test(code)) return false;
  return sourceType === "plate" || schema === "plate_detail" || /^cls\d+$/u.test(code);
}

function sanitizeAnnotations(value) {
  if (!value || typeof value !== "object") return null;
  const sourceItems = rows(value.items);
  const items = sourceItems.filter(isPlateAnnotation);
  return {
    ...value,
    itemCount: items.length,
    excludedStockCount: finite(value.excludedStockCount) + sourceItems.filter((item) => !isPlateAnnotation(item)).length,
    items,
  };
}

function annotationQuality(value) {
  const annotations = sanitizeAnnotations(value);
  if (!annotations) return [0, 0, 0];
  const status = String(annotations.status || "").toLowerCase();
  return [
    rows(annotations.items).length,
    status === "ok" ? 2 : status === "retained" ? 1 : 0,
    jsonSize(annotations),
  ];
}

function mergeRicherAnnotations(selected, first, second) {
  if (!selected || typeof selected !== "object") return selected;
  const candidates = [first?.annotations, second?.annotations]
    .map(sanitizeAnnotations)
    .filter(Boolean);
  if (!candidates.length) return selected;
  const annotations = candidates.reduce((best, candidate) => (
    !best || compareQuality(annotationQuality(candidate), annotationQuality(best)) > 0 ? candidate : best
  ), null);
  return {...selected, annotations};
}

function datasetQuality(key, value) {
  if (!value || typeof value !== "object") return [0];
  if (key === "indices") {
    const metrics = indexMetrics(value);
    return [
      Boolean(value.tradeDate),
      metrics.itemCount,
      metrics.coveredItems,
      metrics.minimumPoints,
      metrics.totalPoints,
      ...annotationQuality(value.annotations),
      jsonSize(value),
    ];
  }
  if (key === "sectors") {
    const metrics = sectorMetrics(value);
    return [
      Boolean(value.tradeDate),
      metrics.rowCount,
      metrics.timelineCount,
      metrics.sampleCount,
      metrics.attributionCount,
      jsonSize(value),
    ];
  }
  if (key === "stocks") {
    const metrics = structuredStockMetrics(value);
    return [
      Boolean(value.tradeDate),
      metrics.groupCount,
      metrics.populatedGroups,
      metrics.totalRows,
      metrics.brokenRows,
      jsonSize(value),
    ];
  }
  if (key === "market") {
    const metrics = legacyStockMetrics(value);
    return [
      Boolean(value.tradeDate || value.market?.tradeDate),
      validationRank(value),
      rows(value.marketHistory).length,
      metrics.populatedGroups,
      metrics.totalRows,
      jsonSize(value),
    ];
  }
  if (key === "analysis") {
    return [
      Boolean(value.tradeDate),
      validationRank(value),
      Object.keys(value.structure || {}).length,
      Object.keys(value.diagnosis || {}).length,
      jsonSize(value),
    ];
  }
  if (key === "policyNews") {
    return [
      rows(value.items).length,
      rows(value.eventChains).length,
      jsonSize(value),
    ];
  }
  if (key === "health") {
    return [
      validationRank(value),
      finite(value.overall?.score),
      rows(value.modules).length,
      rows(value.crossChecks).length,
      jsonSize(value),
    ];
  }
  return [jsonSize(value)];
}

function selectBetterDataset(key, incoming, existing) {
  if (!existing || typeof existing !== "object") {
    const value = key === "indices" ? mergeRicherAnnotations(incoming, incoming, existing) : incoming;
    return {value, source: "incoming", quality: datasetQuality(key, value)};
  }
  if (!incoming || typeof incoming !== "object") {
    const value = key === "indices" ? mergeRicherAnnotations(existing, incoming, existing) : existing;
    return {value, source: "existing", quality: datasetQuality(key, value)};
  }
  const incomingQuality = datasetQuality(key, incoming);
  const existingQuality = datasetQuality(key, existing);
  const source = compareQuality(incomingQuality, existingQuality) >= 0 ? "incoming" : "existing";
  let value = source === "incoming" ? incoming : existing;
  if (key === "indices") value = mergeRicherAnnotations(value, incoming, existing);
  return {value, source, quality: datasetQuality(key, value)};
}

function legacyArchiveQuality(value, expectedDate = "") {
  if (!value || typeof value !== "object") return [0];
  const marketDate = String(value.market?.tradeDate || "");
  const indexDate = String(value.index?.tradeDate || "");
  const tradeDate = marketDate || indexDate;
  const indices = indexMetrics(value);
  const sectors = sectorMetrics(value);
  const stocks = legacyStockMetrics(value);
  return [
    validationRank(value),
    Boolean(tradeDate),
    !expectedDate || tradeDate === expectedDate,
    !marketDate || !indexDate || marketDate === indexDate,
    indices.itemCount,
    indices.coveredItems,
    indices.minimumPoints,
    indices.totalPoints,
    sectors.rowCount,
    sectors.timelineCount,
    sectors.sampleCount,
    sectors.attributionCount,
    stocks.populatedGroups,
    stocks.totalRows,
    stocks.brokenRows,
    jsonSize(value),
  ];
}

function compareLegacyArchives(left, right, expectedDate = "") {
  return compareQuality(
    legacyArchiveQuality(left, expectedDate),
    legacyArchiveQuality(right, expectedDate),
  );
}

module.exports = {
  annotationQuality,
  compareLegacyArchives,
  compareQuality,
  datasetQuality,
  legacyArchiveQuality,
  mergeRicherAnnotations,
  sanitizeAnnotations,
  selectBetterDataset,
};
