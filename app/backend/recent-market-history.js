"use strict";

const fs = require("fs");
const path = require("path");

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return null;
  }
}

function firstFinite(...values) {
  for (const value of values) {
    const number = finite(value);
    if (number !== null) return number;
  }
  return null;
}

function maxFinite(...values) {
  const valid = values.map(finite).filter((value) => value !== null);
  return valid.length ? Math.max(...valid) : null;
}

function stockRows(stocks, key) {
  return rows(stocks?.groups?.[key]?.rows || stocks?.groups?.[key]);
}

function snapshotFromStructuredArchive(directory, date) {
  const parsed = readJson(path.join(directory, "market.json"));
  if (!parsed) return null;
  const stocks = readJson(path.join(directory, "stocks.json")) || {};
  const storedDays = rows(parsed?.marketHistory?.days || parsed?.marketHistory);
  const stored = storedDays.find((day) => day?.date === date) || {};
  const market = parsed.market || {};
  const recent = rows(market.recentDays).find((day) => day?.date === date) || {};
  const currentDate = String(parsed.tradeDate || market.tradeDate || "");
  const current = currentDate === date ? market : {};
  const limitUpStocks = rows(stored?.market?.limitUpStocks).length
    ? rows(stored.market.limitUpStocks)
    : stockRows(stocks, "limitUp");
  const limitDownStocks = rows(stored?.market?.limitDownStocks).length
    ? rows(stored.market.limitDownStocks)
    : stockRows(stocks, "limitDown");
  const storedMarket = stored.market || {};
  const ownMarket = {
    ...storedMarket,
    stockCount: firstFinite(storedMarket.stockCount, current.stockCount),
    limitUpCount: maxFinite(storedMarket.limitUpCount, recent.limitUpCount, current.limitUpCount, limitUpStocks.length || null),
    limitDownCount: maxFinite(storedMarket.limitDownCount, recent.limitDownCount, current.limitDownCount, limitDownStocks.length || null),
    brokenCount: firstFinite(storedMarket.brokenCount, current.brokenCount),
    touchedLimitCount: firstFinite(storedMarket.touchedLimitCount, current.touchedLimitCount),
    brokenRate: firstFinite(storedMarket.brokenRate, current.brokenRate),
    upCount: firstFinite(storedMarket.upCount, current.upCount),
    downCount: firstFinite(storedMarket.downCount, current.downCount),
    flatCount: firstFinite(storedMarket.flatCount, current.flatCount),
    totalAmountYi: firstFinite(storedMarket.totalAmountYi, recent.totalAmountYi, current.totalAmountYi),
    totalVolumeYiHands: firstFinite(storedMarket.totalVolumeYiHands, recent.totalVolumeYiHands, current.totalVolumeYiHands),
    limitUpStocks,
    limitDownStocks,
  };
  let indices = rows(stored.indices);
  if (!indices.length && finite(recent.indexChangePct) !== null) {
    indices = [{name: "上证指数", changePct: finite(recent.indexChangePct)}];
  }
  return {
    ...stored,
    date,
    fetchedAt: stored.fetchedAt || parsed.generatedAt || parsed.syncedAt || "",
    source: stored.source || "结构化复盘历史自动重建",
    market: ownMarket,
    indices,
    flows: stored.flows || {industry: [], concept: []},
    structure: stored.structure || parsed.marketStructure || null,
    diagnosis: stored.diagnosis || null,
  };
}

function mergeArray(left, right) {
  return rows(left).length >= rows(right).length ? rows(left) : rows(right);
}

function mergeSnapshots(existing, archived) {
  if (!existing) return archived;
  const currentMarket = existing.market || {};
  const archivedMarket = archived.market || {};
  const market = {...archivedMarket, ...currentMarket};
  for (const key of ["stockCount", "brokenCount", "touchedLimitCount", "brokenRate", "upCount", "downCount", "flatCount", "totalAmountYi", "totalVolumeYiHands"]) {
    market[key] = firstFinite(currentMarket[key], archivedMarket[key]);
  }
  market.limitUpCount = maxFinite(currentMarket.limitUpCount, archivedMarket.limitUpCount);
  market.limitDownCount = maxFinite(currentMarket.limitDownCount, archivedMarket.limitDownCount);
  market.limitUpStocks = mergeArray(currentMarket.limitUpStocks, archivedMarket.limitUpStocks);
  market.limitDownStocks = mergeArray(currentMarket.limitDownStocks, archivedMarket.limitDownStocks);
  return {
    ...archived,
    ...existing,
    date: existing.date || archived.date,
    market,
    indices: mergeArray(existing.indices, archived.indices),
    flows: existing.flows || archived.flows || {industry: [], concept: []},
    structure: existing.structure || archived.structure || null,
    diagnosis: existing.diagnosis || archived.diagnosis || null,
  };
}

function hydrateHistoryCacheFromStructuredArchive(cache, archiveRoot, maxDays = 60) {
  const target = cache && typeof cache === "object" ? cache : {version: 1, updatedAt: "", days: []};
  const byDate = new Map(rows(target.days).filter((day) => day?.date).map((day) => [day.date, day]));
  if (!archiveRoot || !fs.existsSync(archiveRoot)) return {cache: target, recoveredDates: []};
  const dates = fs.readdirSync(archiveRoot, {withFileTypes: true})
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))
    .slice(0, Math.max(1, Number(maxDays) || 60));
  const recoveredDates = [];
  for (const date of dates) {
    const snapshot = snapshotFromStructuredArchive(path.join(archiveRoot, date), date);
    if (!snapshot) continue;
    byDate.set(date, mergeSnapshots(byDate.get(date), snapshot));
    recoveredDates.push(date);
  }
  target.days = [...byDate.values()]
    .sort((left, right) => String(right.date).localeCompare(String(left.date)))
    .slice(0, Math.max(1, Number(maxDays) || 60));
  return {cache: target, recoveredDates};
}

module.exports = {
  hydrateHistoryCacheFromStructuredArchive,
  mergeSnapshots,
  snapshotFromStructuredArchive,
};
