"use strict";

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stockCode(row) {
  return String(row?.code ?? row?.c ?? row?.f12 ?? "").trim();
}

function stockName(row) {
  return String(row?.name ?? row?.n ?? row?.f14 ?? "").trim();
}

function standardLimitRate(row) {
  const code = stockCode(row);
  const name = stockName(row);
  if (/(?:^|\*)ST/i.test(name)) return 5;
  if (/^(?:688|689|300|301|302)/u.test(code)) return 20;
  if (/^(?:8|4|9)/u.test(code)) return 30;
  return 10;
}

function roundedLimitPrice(preClose, direction, rate) {
  const base = finite(preClose);
  if (base === null || base <= 0) return null;
  const ratio = 1 + (direction === "up" ? 1 : -1) * Number(rate) / 100;
  return Math.round((base * ratio + Number.EPSILON) * 100) / 100;
}

function priceAtLimit(row, direction, rates) {
  const price = finite(row?.price ?? row?.f2 ?? row?.p);
  const preClose = finite(row?.preClose ?? row?.f18);
  const high = finite(row?.high ?? row?.f15);
  const low = finite(row?.low ?? row?.f16);
  if (price !== null && preClose !== null && preClose > 0) {
    for (const rate of rates) {
      const target = roundedLimitPrice(preClose, direction, rate);
      if (target === null || Math.abs(price - target) > 0.011) continue;
      if (direction === "down" && low !== null && low > target + 0.011) continue;
      if (direction === "up" && high !== null && high < target - 0.011) continue;
      return true;
    }
    return false;
  }

  const changePct = finite(row?.changePct ?? row?.f3 ?? row?.zdp);
  if (changePct === null) return false;
  return rates.some((rate) => Math.abs(changePct - (direction === "up" ? rate : -rate)) <= 0.35);
}

function isClosedLimitDown(row) {
  return priceAtLimit(row, "down", [standardLimitRate(row)]);
}

function isClosedLimitUp(row) {
  return priceAtLimit(row, "up", [standardLimitRate(row)]);
}

function isHistoricalClosedLimit(row, direction) {
  const listingIndex = Number(row?.listingIndex);
  if (Number.isFinite(listingIndex) && listingIndex < 5) return false;
  const standardRate = standardLimitRate(row);
  const name = stockName(row);
  const rates = standardRate === 10 && !name ? [10, 5] : [standardRate];
  return priceAtLimit(row, direction, rates);
}

function normalizeValidatedRow(row, tradeDate) {
  const code = stockCode(row);
  const name = stockName(row);
  const concepts = Array.isArray(row?.concepts)
    ? row.concepts.filter(Boolean).join(",")
    : String(row?.concepts ?? row?.f103 ?? "").trim();
  return {
    ...row,
    c: code,
    n: name,
    m: finite(row?.market ?? row?.m ?? row?.f13) ?? (/^[69]/u.test(code) ? 1 : 0),
    f2: finite(row?.price ?? row?.f2),
    f3: finite(row?.changePct ?? row?.f3),
    f5: finite(row?.volume ?? row?.f5),
    f6: finite(row?.amount ?? row?.f6),
    f15: finite(row?.high ?? row?.f15),
    f16: finite(row?.low ?? row?.f16),
    f17: finite(row?.open ?? row?.f17),
    f18: finite(row?.preClose ?? row?.f18),
    f100: String(row?.sector ?? row?.industry ?? row?.f100 ?? "").trim(),
    f103: concepts,
    quoteDate: String(row?.quoteDate || tradeDate || ""),
  };
}

function collectClosedLimitDownRows(rows, tradeDate) {
  const byCode = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const code = stockCode(row);
    const quoteDate = String(row?.quoteDate || "").slice(0, 10);
    if (!/^\d{6}$/u.test(code) || (quoteDate && tradeDate && quoteDate !== tradeDate)) continue;
    if (!isClosedLimitDown(row)) continue;
    byCode.set(code, normalizeValidatedRow(row, tradeDate));
  }
  return [...byCode.values()].sort((left, right) => stockCode(left).localeCompare(stockCode(right)));
}

function reconcileLimitDownPool(topicPool, validatedRows, tradeDate) {
  const topicRows = Array.isArray(topicPool?.rows) ? topicPool.rows : [];
  const hasCompleteValidation = Array.isArray(validatedRows);
  const completeRows = hasCompleteValidation ? collectClosedLimitDownRows(validatedRows, tradeDate) : [];
  const byCode = new Map();
  if (hasCompleteValidation) {
    completeRows.forEach((row) => byCode.set(stockCode(row), row));
    topicRows.forEach((row) => {
      const code = stockCode(row);
      if (!byCode.has(code)) return;
      byCode.set(code, {...byCode.get(code), ...row});
    });
  } else {
    topicRows.forEach((row) => {
      const code = stockCode(row);
      if (/^\d{6}$/u.test(code)) byCode.set(code, row);
    });
  }
  const reported = Math.max(0, finite(topicPool?.total) ?? 0, topicRows.length);
  const total = hasCompleteValidation ? byCode.size : Math.max(reported, byCode.size);
  return {
    ...(topicPool || {}),
    rows: [...byCode.values()],
    total,
    qdate: topicPool?.qdate || tradeDate,
    source: hasCompleteValidation
      ? "全A实时行情最终校验，专题接口补充明细字段"
      : "东方财富跌停专题兜底",
    crossCheck: {
      topicReported: reported,
      topicRows: topicRows.length,
      allAValidated: completeRows.length,
      reconciled: total,
      authoritative: hasCompleteValidation ? "all-a-latest-quote" : "topic-fallback",
    },
  };
}

module.exports = {
  collectClosedLimitDownRows,
  isClosedLimitDown,
  isClosedLimitUp,
  isHistoricalClosedLimit,
  reconcileLimitDownPool,
  roundedLimitPrice,
  standardLimitRate,
};
