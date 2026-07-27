export const SESSION_MINUTES = 240;

const SHANGHAI_CLOCK = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function shanghaiClockParts(now = new Date()) {
  const values = {};
  for (const part of SHANGHAI_CLOCK.formatToParts(now)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    ...values,
    weekDay: new Date(Date.UTC(values.year, values.month - 1, values.day)).getUTCDay(),
  };
}

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
  const parts = shanghaiClockParts(now);
  if (parts.weekDay === 0 || parts.weekDay === 6) return false;
  const second = parts.hour * 3600 + parts.minute * 60 + parts.second;
  return (second >= 570 * 60 && second <= 690 * 60)
    || (second >= 780 * 60 && second <= 900 * 60);
}

export function marketPhase(tradeDate, minute, now = new Date()) {
  const parts = shanghaiClockParts(now);
  const today = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  if (tradeDate && tradeDate !== today) return "已收盘";
  if (parts.weekDay === 0 || parts.weekDay === 6) return "已收盘";
  const daySecond = parts.hour * 3600 + parts.minute * 60 + parts.second;
  if (daySecond < 570 * 60) return "盘前";
  if (daySecond <= 690 * 60) return "交易中";
  if (daySecond < 780 * 60) return "午间休市";
  if (daySecond <= 900 * 60) return "交易中";
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
