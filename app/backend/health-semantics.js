function localDateText(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function derivativesPublicationState(
  status = {},
  now = new Date(),
  releaseMinute = 17 * 60 + 30,
  expectedTradeDate = "",
) {
  if (status.parseError) return {status: "error", pending: false, detail: status.parseError};
  if (!status.exists) return {status: "warning", pending: false, detail: "尚未取得中金所成交持仓排名"};
  const targetDate = String(expectedTradeDate || status.targetTradeDate || "");
  const reportedDate = String(status.tradeDate || "");
  const stale = Boolean(status.stale) || Boolean(targetDate && reportedDate && targetDate !== reportedDate);
  if (!stale) return {status: "ok", pending: false, detail: ""};
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  const weekday = now.getDay();
  const pending = targetDate === localDateText(now) && weekday >= 1 && weekday <= 5 && currentMinute < releaseMinute;
  return pending
    ? {status: "pending", pending: true, detail: "当日榜单尚未到官方常规发布时间，当前展示上一交易日数据"}
    : {status: "warning", pending: false, detail: "当前沿用最近有效交易日榜单"};
}

function mergeHealthModule(health = {}, module) {
  const modules = Array.isArray(health.modules)
    ? health.modules.filter((item) => item.key !== module.key)
    : [];
  modules.push(module);
  const crossChecks = Array.isArray(health.crossChecks) ? health.crossChecks : [];
  const errorCount = modules.filter((item) => item.status === "error").length
    + crossChecks.filter((item) => item.status === "error").length;
  const warningCount = modules.filter((item) => item.status === "warning").length
    + crossChecks.filter((item) => item.status === "warning").length;
  const pendingCount = modules.filter((item) => item.status === "pending").length
    + crossChecks.filter((item) => item.status === "pending").length;
  const baseScore = modules.length
    ? modules.reduce((sum, item) => sum + (Number(item.completeness) || 0), 0) / modules.length
    : 0;
  const score = Math.max(0, Math.min(100, Math.round((baseScore - warningCount * 2 - errorCount * 8) * 10) / 10));
  const status = errorCount ? "error" : warningCount ? "warning" : pendingCount ? "pending" : "ok";
  return {
    ...health,
    modules,
    overall: {...(health.overall || {}), status, score, errorCount, warningCount, pendingCount},
  };
}

module.exports = {derivativesPublicationState, localDateText, mergeHealthModule};
