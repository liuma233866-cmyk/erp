const { buildYandexAuthProfiles } = require("./yandex-fetch");
const { formatYandexApiError, shouldRetryWithNextAuth } = require("./yandex-http");
const { withFetchTimeout } = require("./http-timeout");

const YANDEX_MARKET_BASE_URL = process.env.YANDEX_MARKET_BASE_URL || "https://api.partner.market.yandex.ru";
const yandexCategoryParameterCache = new Map();
const YANDEX_CATEGORY_PARAMETER_CACHE_TTL_MS = 30 * 60 * 1000;

// 从 server.js 拆出的 Yandex 类目参数解析与拉取（无 db 依赖）。

function normalizeYandexParameterText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[ё]/g, "е")
    .replace(/[^\p{L}\p{N}\s./%+-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitYandexParameterValues(value) {
  return Array.from(new Set(
    String(value || "")
      .split(/\s*[,/;|]\s*|\s+\+\s+/)
      .map((part) => String(part || "").trim())
      .filter(Boolean)
  ));
}

function parseYandexNumericValue(value) {
  const normalized = String(value || "")
    .replace(",", ".")
    .match(/-?\d+(?:\.\d+)?/);
  if (!normalized) return null;
  const parsed = Number(normalized[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseYandexBooleanValue(value) {
  const normalized = normalizeYandexParameterText(value);
  if (!normalized) return null;
  if (/^(true|yes|1|есть|да|имеется|поддерживается|included)$/i.test(normalized)) return true;
  if (/^(false|no|0|нет|отсутствует|не поддерживается|not included)$/i.test(normalized)) return false;
  return null;
}

function buildCategoryParameterLookup(parameters) {
  const byName = new Map();
  for (const parameter of Array.isArray(parameters) ? parameters : []) {
    const rawName = String(parameter?.name || "").trim();
    if (!rawName) continue;
    const normalizedName = normalizeYandexParameterText(rawName);
    if (!normalizedName) continue;
    const existing = byName.get(normalizedName);
    if (!existing || (parameter?.distinctive && !existing?.distinctive)) {
      byName.set(normalizedName, parameter);
    }
  }
  return byName;
}

function findBestCategoryParameterMatch(rawKey, parameterLookup) {
  const normalizedKey = normalizeYandexParameterText(rawKey);
  if (!normalizedKey || !parameterLookup?.size) return null;
  if (parameterLookup.has(normalizedKey)) return parameterLookup.get(normalizedKey);

  let best = null;
  let bestScore = 0;
  for (const [candidateKey, parameter] of parameterLookup.entries()) {
    let score = 0;
    if (candidateKey.includes(normalizedKey) || normalizedKey.includes(candidateKey)) {
      score += 2;
    }
    const keyTokens = new Set(normalizedKey.split(" ").filter(Boolean));
    const candidateTokens = candidateKey.split(" ").filter(Boolean);
    const overlap = candidateTokens.filter((token) => keyTokens.has(token)).length;
    score += overlap;
    if (score > bestScore) {
      best = parameter;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : null;
}

function mapAttributeValueToCategoryParameterEntries(parameter, rawValue) {
  if (!parameter || rawValue === undefined || rawValue === null) return [];
  const parameterId = Number(parameter.id || 0);
  if (!(parameterId > 0)) return [];

  const type = String(parameter.type || "TEXT").toUpperCase();
  const allowCustomValues = parameter.allowCustomValues !== false;
  const unitId = Number(parameter?.unit?.defaultUnitId || 0) || undefined;
  const values = Array.isArray(parameter.values) ? parameter.values : [];
  const constraints = parameter.constraints || {};
  const segments = parameter.multivalue ? splitYandexParameterValues(rawValue) : [String(rawValue || "").trim()];
  const mapped = [];

  for (const segment of segments) {
    const trimmed = String(segment || "").trim();
    if (!trimmed) continue;

    if (type === "BOOLEAN") {
      const parsed = parseYandexBooleanValue(trimmed);
      if (parsed === null) continue;
      mapped.push({ parameterId, value: parsed ? "true" : "false" });
      continue;
    }

    if (type === "NUMERIC") {
      const parsed = parseYandexNumericValue(trimmed);
      if (parsed === null) continue;
      const minValue = Number(constraints.minValue);
      const maxValue = Number(constraints.maxValue);
      if (Number.isFinite(minValue) && parsed < minValue) continue;
      if (Number.isFinite(maxValue) && parsed > maxValue) continue;
      mapped.push({
        parameterId,
        value: String(parsed),
        ...(unitId ? { unitId } : {})
      });
      continue;
    }

    if (type === "ENUM") {
      const normalizedSegment = normalizeYandexParameterText(trimmed);
      const option = values.find((entry) => normalizeYandexParameterText(entry?.value) === normalizedSegment)
        || values.find((entry) => normalizeYandexParameterText(entry?.value).includes(normalizedSegment) || normalizedSegment.includes(normalizeYandexParameterText(entry?.value)));
      if (option?.id) {
        mapped.push({
          parameterId,
          valueId: Number(option.id),
          value: String(option.value || trimmed).trim(),
          ...(unitId ? { unitId } : {})
        });
        continue;
      }
      if (!allowCustomValues) continue;
    }

    const maxLength = Number(constraints.maxLength || 0) || 0;
    const finalValue = maxLength > 0 ? trimmed.slice(0, maxLength) : trimmed;
    if (!finalValue) continue;
    mapped.push({
      parameterId,
      value: finalValue,
      ...(unitId ? { unitId } : {})
    });
  }

  return mapped;
}

async function fetchYandexCategoryParameters(categoryId, businessId, apiKey) {
  const normalizedCategoryId = Number(categoryId || 0) || 0;
  const normalizedBusinessId = Number(businessId || 0) || 0;
  if (!(normalizedCategoryId > 0) || !(normalizedBusinessId > 0) || !apiKey) {
    return { ok: false, parameters: [], message: "categoryId/businessId/apiKey required" };
  }

  const cacheKey = `${normalizedBusinessId}:${normalizedCategoryId}`;
  const cached = yandexCategoryParameterCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < YANDEX_CATEGORY_PARAMETER_CACHE_TTL_MS) {
    return { ok: true, parameters: cached.parameters, cached: true };
  }

  const authProfiles = buildYandexAuthProfiles(apiKey);
  const endpoint = `${YANDEX_MARKET_BASE_URL}/v2/category/${encodeURIComponent(normalizedCategoryId)}/parameters?businessId=${encodeURIComponent(normalizedBusinessId)}`;
  let firstErrorMessage = "";
  let lastErrorMessage = "";

  for (const profile of authProfiles) {
    const response = await fetch(endpoint, withFetchTimeout({
      method: "POST",
      headers: { ...profile.headers, "Content-Type": "application/json" }
    }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      lastErrorMessage = formatYandexApiError(response.status, data);
      if (!firstErrorMessage) firstErrorMessage = lastErrorMessage;
      if (!shouldRetryWithNextAuth(response.status, data)) break;
      continue;
    }

    const parameters = Array.isArray(data?.result?.parameters)
      ? data.result.parameters
      : Array.isArray(data?.parameters)
        ? data.parameters
        : [];
    yandexCategoryParameterCache.set(cacheKey, { ts: Date.now(), parameters });
    return { ok: true, parameters, cached: false };
  }

  return { ok: false, parameters: [], message: firstErrorMessage || lastErrorMessage || "Yandex category parameters unavailable" };
}

async function enrichYandexItemsWithParameterValues(items, businessId, apiKey) {
  const sourceItems = Array.isArray(items) ? items : [];
  if (!sourceItems.length) return sourceItems;

  const grouped = new Map();
  for (const item of sourceItems) {
    const categoryId = Number(item?.categoryId || 0) || 0;
    if (!(categoryId > 0)) continue;
    if (!grouped.has(categoryId)) grouped.set(categoryId, []);
    grouped.get(categoryId).push(item);
  }

  const enriched = sourceItems.map((item) => ({ ...item, parameterValues: [] }));
  const byOfferId = new Map(enriched.map((item) => [String(item.offerId || "").trim(), item]));

  for (const [categoryId, categoryItems] of grouped.entries()) {
    const categoryResult = await fetchYandexCategoryParameters(categoryId, businessId, apiKey);
    if (!categoryResult.ok || !Array.isArray(categoryResult.parameters) || !categoryResult.parameters.length) continue;

    const lookup = buildCategoryParameterLookup(categoryResult.parameters);
    for (const item of categoryItems) {
      const target = byOfferId.get(String(item.offerId || "").trim());
      if (!target) continue;
      const attributeTerms = item.attributeTerms && typeof item.attributeTerms === "object" ? item.attributeTerms : {};
      const mappedEntries = [];
      for (const [key, value] of Object.entries(attributeTerms)) {
        const parameter = findBestCategoryParameterMatch(key, lookup);
        if (!parameter) continue;
        mappedEntries.push(...mapAttributeValueToCategoryParameterEntries(parameter, value));
      }
      target.parameterValues = mappedEntries.slice(0, 50);
    }
  }

  return enriched;
}

module.exports = {
  buildCategoryParameterLookup,
  enrichYandexItemsWithParameterValues,
  fetchYandexCategoryParameters,
  findBestCategoryParameterMatch,
  mapAttributeValueToCategoryParameterEntries,
  normalizeYandexParameterText,
  parseYandexBooleanValue,
  parseYandexNumericValue,
  splitYandexParameterValues,
};
