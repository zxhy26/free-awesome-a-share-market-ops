export function refreshDelay({hidden = false, trading = false, failed = false} = {}) {
  if (hidden) return null;
  if (failed) return 5000;
  return trading ? 15000 : 60000;
}

export function sampleAtOrBefore(points, minute) {
  let selected = null;
  for (const [index, point] of (points || []).entries()) {
    const time = point.minute == null ? index : Number(point.minute);
    if (!Number.isFinite(time) || time > minute) continue;
    if (point.price == null || !Number.isFinite(Number(point.price))) continue;
    if (!selected || time >= selected.minute) selected = {...point, minute: time};
  }
  return selected;
}

export async function pollSyncTask({readStatus, onProgress, timeoutMs, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), failureMessage}) {
  const deadline = now() + timeoutMs;
  let failures = 0;
  while (now() < deadline) {
    let status;
    try {
      status = await readStatus();
      failures = 0;
    } catch (error) {
      if (++failures >= 4) throw error;
      onProgress?.({stage: "reconnecting", message: "同步连接恢复中，后台任务继续运行", percent: 0});
      await sleep(1000 * failures);
      continue;
    }
    onProgress?.(status.progress || {stage: "working", message: "正在同步", percent: 0});
    if (!status.running && status.lastResult) {
      if (status.lastResult.ok) return status.lastResult;
      throw new Error(failureMessage(status.lastResult));
    }
    await sleep(900);
  }
  throw new Error("同步等待超时，后台可能仍在处理，请稍后查看数据状态。");
}
