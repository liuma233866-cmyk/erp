const DEFAULT_DELAYS_MS = [10000, 20000, 40000];

function isProviderThrottlingError(error) {
  const code = String(error?.providerCode || error?.code || "").trim();
  const statusCode = Number(error?.providerStatusCode || error?.statusCode || 0);
  return statusCode === 429 || /^Throttling(?:\.|$)/i.test(code);
}

function isTransientProviderError(error) {
  if (isProviderThrottlingError(error)) return true;
  const code = String(error?.code || error?.cause?.code || "").trim().toUpperCase();
  if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EPIPE"].includes(code)) return true;
  const message = String(error?.message || "");
  return /socket hang up|connection reset|network timeout|read ECONNRESET/i.test(message);
}

function retryDelayMs(error, retryIndex, delays = DEFAULT_DELAYS_MS) {
  const retryAfterMs = Number(error?.providerRetryAfterMs || 0);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(Math.max(retryAfterMs, 1000), 120000);
  const configured = Number(delays[Math.min(retryIndex, delays.length - 1)] || 0);
  return Math.min(Math.max(configured, 1000), 120000);
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => { clearTimeout(timer); reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" })); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function callWithThrottleRetry(operation, options = {}) {
  const delays = Array.isArray(options.delaysMs) && options.delaysMs.length ? options.delaysMs : DEFAULT_DELAYS_MS;
  const wait = typeof options.sleep === "function" ? options.sleep : sleep;
  const onRetry = typeof options.onRetry === "function" ? options.onRetry : null;
  const signal = options.signal;
  let retryIndex = 0;
  while (true) {
    if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
    try {
      return await operation(retryIndex + 1);
    } catch (error) {
      if (!isTransientProviderError(error) || retryIndex >= delays.length) throw error;
      const delayMs = retryDelayMs(error, retryIndex, delays);
      retryIndex += 1;
      if (onRetry) await onRetry({ error, retryIndex, delayMs, nextAttempt: retryIndex + 1 });
      await (wait === sleep ? sleep(delayMs, signal) : wait(delayMs, signal));
    }
  }
}

module.exports = { DEFAULT_DELAYS_MS, isProviderThrottlingError, isTransientProviderError, retryDelayMs, callWithThrottleRetry };
