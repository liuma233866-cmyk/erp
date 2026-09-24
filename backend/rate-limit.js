// Pure sliding-window rate limiter. The bucket map is passed in by the caller
// so the function stays testable and the caller owns retention policy.
function checkRateLimit(bucketMap, key, windowMs, maxCount) {
  const now = Date.now();
  const k = String(key || "");
  if (!k) return { ok: true };
  const current = bucketMap.get(k);
  if (!current || now - current.windowStart >= windowMs) {
    bucketMap.set(k, { windowStart: now, count: 1 });
    return { ok: true };
  }
  current.count += 1;
  bucketMap.set(k, current);
  if (current.count <= maxCount) return { ok: true };
  return { ok: false, retryAfterMs: Math.max(1, windowMs - (now - current.windowStart)) };
}

// 定期清理过期 bucket，避免长期运行时按 IP/账号累积导致内存增长。
// 保留 2 倍窗口，保证刚过期的计数不会在边界上被立刻丢弃。
function pruneRateLimitBuckets(bucketMap, windowMs, now = Date.now()) {
  if (!(bucketMap instanceof Map)) return 0;
  const window = Number(windowMs);
  if (!Number.isFinite(window) || window <= 0) return 0;
  const threshold = Number(now) - window * 2;
  let removed = 0;
  for (const [key, bucket] of bucketMap) {
    const windowStart = Number(bucket?.windowStart || 0);
    if (!windowStart || windowStart < threshold) {
      bucketMap.delete(key);
      removed += 1;
    }
  }
  return removed;
}

module.exports = { checkRateLimit, pruneRateLimitBuckets };
