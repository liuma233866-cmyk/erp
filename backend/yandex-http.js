const { withFetchTimeout } = require("./http-timeout");

function extractYandexCampaigns(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.campaigns)) return payload.campaigns;
  if (Array.isArray(payload.result?.campaigns)) return payload.result.campaigns;
  if (Array.isArray(payload.result)) return payload.result;
  return [];
}

function formatYandexApiError(status, payload) {
  const error = Array.isArray(payload?.errors) && payload.errors.length ? payload.errors[0] : null;
  if (error) {
    const code = error.code ? String(error.code) : "UNKNOWN";
    const message = error.message ? String(error.message) : "";
    return `Yandex API HTTP ${status}: ${code}${message ? ` - ${message}` : ""}`;
  }
  if (payload && typeof payload.message === "string" && payload.message.trim()) {
    return `Yandex API HTTP ${status}: ${payload.message.trim()}`;
  }
  return `Yandex API HTTP ${status}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 可重试的 Yandex 状态码：全项目**唯一**定义，由 yandex-http / yandex-publish-service /
// orders/order-sync 三处共用。历史上三处各写一份且互相矛盾（yandex-http 有 409 无 420、
// yandex-publish-service 两者皆无、order-sync 有 420），结果是列表分页与刊登批次一遇限流
// 就当成永久失败秒退。
//   - 420 = METHOD_FAILURE「Hit rate limit of 6 parallel requests」，是 Yandex 实际的限流码
//     （order-sync 当初正因此单独加过它），必须重试；
//   - 409 = 冲突，不是瞬时故障：重试不会成功，对刊登这类非幂等写还可能重复提交。
//     此前只有 yandex-http 一份把它当可重试，现统一为不重试。
const RETRYABLE_YANDEX_STATUS = new Set([408, 420, 425, 429, 500, 502, 503, 504]);

function isRetryableYandexStatus(status) {
  return RETRYABLE_YANDEX_STATUS.has(Number(status || 0));
}

function formatYandexFetchError(error) {
  const name = String(error?.name || "Error");
  const message = String(error?.message || error || "").trim();
  const code = String(error?.code || error?.cause?.code || "").trim();
  const causeName = String(error?.cause?.name || "").trim();
  const causeMessage = String(error?.cause?.message || "").trim();
  const parts = [`${name}${message ? `: ${message}` : ""}`];
  if (code) parts.push(`code=${code}`);
  if (causeName || causeMessage) {
    parts.push(`cause=${causeName || "Error"}${causeMessage ? `: ${causeMessage}` : ""}`);
  }
  return parts.join(" | ");
}

function summarizeYandexResponse(payload) {
  if (!payload || typeof payload !== "object") return "";
  const summary = {};
  for (const key of ["code", "message", "error", "errors", "result", "status", "statusCode"]) {
    if (payload[key] !== undefined) summary[key] = payload[key];
  }
  if (!Object.keys(summary).length) return "";
  try {
    return JSON.stringify(summary);
  } catch {
    return "";
  }
}

async function fetchYandexJson(endpoint, options = {}, retryCount = 2) {
  let lastError = null;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      // 每次尝试都新建超时 signal：重试时若复用已 abort 的 signal，第二次会立刻失败。
      const response = await fetch(endpoint, withFetchTimeout(options));
      const data = await response.json().catch(() => ({}));
      const responseSummary = summarizeYandexResponse(data);
      if (!response.ok && isRetryableYandexStatus(response.status) && attempt < retryCount) {
        await sleep(250 * (attempt + 1));
        continue;
      }
      if (!response.ok && responseSummary) {
        return {
          ok: false,
          status: response.status,
          data,
          response,
          errorMessage: `Yandex API HTTP ${response.status}: ${responseSummary}`
        };
      }
      return { ok: response.ok, status: response.status, data, response };
    } catch (error) {
      lastError = error;
      if (attempt < retryCount) {
        await sleep(250 * (attempt + 1));
        continue;
      }
    }
  }
  return {
    ok: false,
    status: 0,
    data: {},
    errorMessage: `Yandex request failed: ${formatYandexFetchError(lastError)}`
  };
}

function shouldRetryWithNextAuth(status, payload) {
  if (status !== 401 && status !== 403) return false;
  const text = JSON.stringify(payload || {}).toLowerCase();
  return (
    text.includes("prefix") ||
    text.includes("api-key token prefix invalid") ||
    text.includes("invalid authorization")
  );
}

function normalizePartnerTokenInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let token = raw;
  token = token.replace(/^\s*api[- ]?key\s*[:=]?\s*/i, "");
  token = token.replace(/^\s*authorization\s*[:=]?\s*/i, "");
  token = token.replace(/^\s*(oauth|bearer)\s+/i, "");
  token = token.trim();
  return token;
}

module.exports = {
  RETRYABLE_YANDEX_STATUS,
  extractYandexCampaigns,
  fetchYandexJson,
  formatYandexApiError,
  formatYandexFetchError,
  isRetryableYandexStatus,
  normalizePartnerTokenInput,
  shouldRetryWithNextAuth,
  sleep,
  summarizeYandexResponse
};
