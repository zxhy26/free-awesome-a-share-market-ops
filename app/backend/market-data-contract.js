function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildSnapshotOnlyIndex(options = {}) {
  const price = finite(options.price);
  const preClose = finite(options.preClose);
  const minute = Math.max(0, Math.min(240, Math.floor(finite(options.minute) ?? 0)));
  if (price === null || preClose === null) throw new Error("指数备用快照缺少有效价格");
  const tradeDate = String(options.tradeDate || "");
  const def = options.def || {};
  const data = options.data || {};
  return {
    key: def.key,
    name: data.f58 || def.name,
    code: data.f57 || def.code,
    preClose,
    tradeDate,
    points: [{
      dateTime: `${tradeDate} ${String(options.time || "")}`,
      time: String(options.time || ""),
      price,
      volume: finite(data.f47) || 0,
      amount: finite(data.f48) || 0,
      minute,
      source: "东方财富指数当前快照",
    }],
    snapshotOnly: true,
    continuity: "single-real-snapshot",
    source: "东方财富指数当前快照（无分钟轨迹）",
    fallbackReason: String(options.reason || ""),
  };
}

module.exports = {buildSnapshotOnlyIndex};
