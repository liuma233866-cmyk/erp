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

function isRetryableYandexStatus(status) {
  const code = Number(status || 0);
  return code === 408 || code === 409 || code === 425 || code === 429 || code === 500 || code === 502 || code === 503 || code === 504;
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
      const response = await fetch(endpoint, options);
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
