export const SESSION_MINUTES = 240;

export function clampMarketMinute(value) {
  const number = Number(value);
  return Math.max(0, Math.min(SESSION_MINUTES, Number.isFinite(number) ? number : 0));
}

export function marketMinuteToTime(minute, includeSeconds = false) {
  const value = clampMarketMinute(minute);
  const minutesOfDay = value <= 120 ? 570 + value : 780 + value - 120;
  const totalSeconds = Math.round(minutesOfDay * 60);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const base = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  return includeSeconds ? `${base}:${String(seconds).padStart(2, "0")}` : base;
}

export function inTradingWindow(now = new Date()) {
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  return (minute >= 570 && minute <= 690) || (minute >= 780 && minute <= 900);
}

export function marketPhase(tradeDate, minute, now = new Date()) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (tradeDate && tradeDate !== today) return "已收盘";
  const dayMinute = now.getHours() * 60 + now.getMinutes();
  if (dayMinute < 570) return "盘前";
  if (dayMinute <= 690) return "交易中";
  if (dayMinute < 780) return "午间休市";
  if (dayMinute <= 900) return "交易中";
  return clampMarketMinute(minute) >= SESSION_MINUTES ? "已收盘" : "收盘补采";
}

export function latestTradingMinute(points) {
  const minutes = (points || []).map((point) => Number(point?.minute)).filter(Number.isFinite);
  return minutes.length ? clampMarketMinute(Math.max(...minutes)) : 0;
}

export function interpolateRealSamples(points, minute, valueKey) {
  const target = clampMarketMinute(minute);
  const sorted = (points || [])
    .map((point) => ({...point, minute: Number(point?.minute), value: Number(point?.[valueKey])}))
    .filter((point) => Number.isFinite(point.minute) && Number.isFinite(point.value))
    .sort((left, right) => left.minute - right.minute);
  let previous = null;
  let next = null;
  for (const point of sorted) {
    if (point.minute <= target) previous = point;
    else {
      next = point;
      break;
    }
  }
  if (!previous) return null;
  if (!next || target <= previous.minute || next.minute <= previous.minute) return previous.value;
  const ratio = (target - previous.minute) / (next.minute - previous.minute);
  return previous.value + (next.value - previous.value) * ratio;
}
