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

module.exports = { checkRateLimit };
