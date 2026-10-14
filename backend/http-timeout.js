"use strict";
// 出站 HTTP 统一超时。
//
// 为什么必须有：没有超时的话，一次 connect/DNS 停滞、或对端慢速吐响应体，就会把调用方
// 永远挂住。订单同步尤其致命 —— orders/order-sync.js 用 state.running 防止并发同步，
// 一次永久挂住就等于把每日同步永久锁死：之后每天只会得到 { skipped: true }。
//
// Undici（Node 内置 fetch）默认没有任何应用层响应期限，所以这个期限必须由我们给。

const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const MIN_HTTP_TIMEOUT_MS = 1000;
const MAX_HTTP_TIMEOUT_MS = 300000;

function resolveHttpTimeoutMs(raw, fallbackMs = DEFAULT_HTTP_TIMEOUT_MS) {
  const fallback = Number(fallbackMs);
  const base = Number.isFinite(fallback) && fallback > 0 ? fallback : DEFAULT_HTTP_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return base;
  return Math.min(MAX_HTTP_TIMEOUT_MS, Math.max(MIN_HTTP_TIMEOUT_MS, Math.floor(value)));
}

// 项目级默认期限，可用 HTTP_TIMEOUT_MS 覆盖（毫秒，夹在 1s..300s）。
function defaultHttpTimeoutMs() {
  return resolveHttpTimeoutMs(process.env.HTTP_TIMEOUT_MS);
}

// 给 fetch 的 options 注入超时，但**不覆盖**调用方自己传入的 signal
// （例如 yandex-publish-service 自建的 AbortController + YANDEX_REQUEST_TIMEOUT_MS）。
function withFetchTimeout(options = {}, timeoutMs = defaultHttpTimeoutMs()) {
  const next = { ...(options || {}) };
  if (next.signal) return next;

  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    next.signal = AbortSignal.timeout(timeoutMs);
    return next;
  }

  // 兜底：老运行时没有 AbortSignal.timeout 时手写一个，且不拖住事件循环。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  next.signal = controller.signal;
  return next;
}

module.exports = {
  DEFAULT_HTTP_TIMEOUT_MS,
  MAX_HTTP_TIMEOUT_MS,
  MIN_HTTP_TIMEOUT_MS,
  defaultHttpTimeoutMs,
  resolveHttpTimeoutMs,
  withFetchTimeout
};
