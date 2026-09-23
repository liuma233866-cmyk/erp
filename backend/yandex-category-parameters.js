// Yandex category content parameters
// (POST /v2/category/{categoryId}/parameters?businessId=...).
//
// This is the method that tells a seller what a card must contain: which parameters
// are required, which values are allowed, and which improvements Yandex recommends
// (`recommendationTypes`, e.g. HAS_VIDEO). The project already fetched it internally
// for attribute mapping but dropped `required`, `recommendationTypes` and
// `valueRestrictions` on the floor, so nothing could be shown or validated.

const MAX_OPTION_VALUES = 60;
const MAX_TEXT = 400;

function text(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function clampText(value, max = MAX_TEXT) {
  const normalized = text(value);
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function listOfStrings(value, limit = 50) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const normalized = text(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeOption(option) {
  if (!option) return null;
  if (typeof option === "string") {
    const value = clampText(option, 200);
    return value ? { id: null, value, description: "" } : null;
  }
  if (typeof option !== "object") return null;
  const value = clampText(option.value || option.name || option.title, 200);
  const description = clampText(option.description, 200);
  if (!value && !description) return null;
  return {
    id: Number.isFinite(Number(option.id)) ? Number(option.id) : null,
    value: value || description,
    description
  };
}

function normalizeNormalizedOptions(value) {
  const raw = Array.isArray(value) ? value : Array.isArray(value?.values) ? value.values : [];
  const seen = new Set();
  const result = [];
  for (const entry of raw) {
    const option = normalizeOption(entry);
    if (!option) continue;
    const key = `${option.id}|${option.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(option);
    if (result.length >= MAX_OPTION_VALUES) break;
  }
  return result;
}

function normalizeValueRestriction(entry) {
  if (!entry || typeof entry !== "object") return null;
  const limitingParameterId = Number(entry.limitingParameterId);
  if (!Number.isFinite(limitingParameterId) || limitingParameterId <= 0) return null;
  const limitedValues = Array.isArray(entry.limitedValues)
    ? entry.limitedValues.map((value) => text(value)).filter(Boolean).slice(0, MAX_OPTION_VALUES)
    : [];
  return { limitingParameterId, limitedValues };
}

// Keeps only the fields the UI needs; the raw payload is large and partly unusable.
function normalizeCategoryParameter(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const id = Number(source.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  const name = clampText(source.name, 200);
  if (!name) return null;

  const constraints = source.constraints && typeof source.constraints === "object" ? source.constraints : {};
  const unit = source.unit && typeof source.unit === "object" ? source.unit : {};
  const defaultUnitId = Number(unit.defaultUnitId);

  return {
    id,
    name,
    description: clampText(source.description),
    type: text(source.type).toUpperCase() || "TEXT",
    required: source.required === true,
    distinctive: source.distinctive === true,
    multivalue: source.multivalue === true,
    // Defaults to true on the platform; only an explicit false forbids custom text.
    allowCustomValues: source.allowCustomValues !== false,
    recommendationTypes: listOfStrings(source.recommendationTypes),
    unitId: Number.isFinite(defaultUnitId) && defaultUnitId > 0 ? defaultUnitId : null,
    values: normalizeNormalizedOptions(source.values),
    valueRestrictions: (Array.isArray(source.valueRestrictions) ? source.valueRestrictions : [])
      .map(normalizeValueRestriction)
      .filter(Boolean)
      .slice(0, MAX_OPTION_VALUES),
    constraints: {
      minValue: Number.isFinite(Number(constraints.minValue)) ? Number(constraints.minValue) : null,
      maxValue: Number.isFinite(Number(constraints.maxValue)) ? Number(constraints.maxValue) : null,
      maxLength: Number.isFinite(Number(constraints.maxLength)) && Number(constraints.maxLength) > 0
        ? Number(constraints.maxLength)
        : null
    }
  };
}

function normalizeCategoryParameters(rawParameters) {
  const seen = new Set();
  const result = [];
  for (const raw of Array.isArray(rawParameters) ? rawParameters : []) {
    const parameter = normalizeCategoryParameter(raw);
    if (!parameter || seen.has(parameter.id)) continue;
    seen.add(parameter.id);
    result.push(parameter);
  }
  return result;
}

// Attribute keys may be Russian, Latin or a human label; compare on a normalized form
// that also tolerates punctuation differences.
function normalizeParameterKey(value) {
  return text(value)
    .toLowerCase()
    .replace(/[ё]/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildParameterLookup(parameters) {
  const byKey = new Map();
  for (const parameter of Array.isArray(parameters) ? parameters : []) {
    for (const key of [parameter?.name, String(parameter?.id || "")]) {
      const normalized = normalizeParameterKey(key);
      if (normalized && !byKey.has(normalized)) byKey.set(normalized, parameter);
    }
  }
  return byKey;
}

// Resolves one attribute key to a category parameter: exact match first, then a
// contains/token-overlap fallback. Returns null rather than guessing.
function findParameterForKey(rawKey, lookup) {
  const normalizedKey = normalizeParameterKey(rawKey);
  if (!normalizedKey || !lookup?.size) return null;
  if (lookup.has(normalizedKey)) return lookup.get(normalizedKey);

  let best = null;
  let bestScore = 0;
  const keyTokens = new Set(normalizedKey.split(" ").filter(Boolean));
  for (const [candidateKey, parameter] of lookup.entries()) {
    let score = 0;
    if (candidateKey.includes(normalizedKey) || normalizedKey.includes(candidateKey)) score += 2;
    const candidateTokens = candidateKey.split(" ").filter(Boolean);
    // Only count tokens long enough to be meaningful, so "и" never matches anything.
    score += candidateTokens.filter((token) => token.length >= 3 && keyTokens.has(token)).length;
    if (score > bestScore) {
      best = parameter;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : null;
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((entry) => hasValue(entry));
  return text(value).length > 0;
}

// Compares what a product supplies against a category's parameters.
//
// `attributeTerms` is the product's raw attribute bag; keys may not match Yandex
// parameter names exactly, so unmatched keys are reported separately instead of being
// silently treated as missing.
function validateProductAgainstParameters(parameters, attributeTerms) {
  const list = Array.isArray(parameters) ? parameters : [];
  const terms = attributeTerms && typeof attributeTerms === "object" && !Array.isArray(attributeTerms)
    ? attributeTerms
    : {};
  const lookup = buildParameterLookup(list);

  const matchedParameterIds = new Set();
  const unmatchedAttributeKeys = [];
  for (const [key, value] of Object.entries(terms)) {
    if (!hasValue(value)) continue;
    const parameter = findParameterForKey(key, lookup);
    if (parameter) matchedParameterIds.add(parameter.id);
    else unmatchedAttributeKeys.push(text(key));
  }

  const missingRequired = [];
  const missingRecommended = [];
  const filledRequired = [];
  for (const parameter of list) {
    const filled = matchedParameterIds.has(parameter.id);
    if (parameter.required) {
      if (filled) filledRequired.push(parameter);
      else missingRequired.push(parameter);
    } else if (!filled && parameter.recommendationTypes.length) {
      missingRecommended.push(parameter);
    }
  }

  const requiredTotal = filledRequired.length + missingRequired.length;
  return {
    requiredTotal,
    filledRequired: filledRequired.length,
    missingRequired,
    missingRecommended,
    unmatchedAttributeKeys: unmatchedAttributeKeys.slice(0, 50),
    // What fraction of the required parameters this product already satisfies.
    readiness: requiredTotal ? Math.round((filledRequired.length / requiredTotal) * 100) : 100
  };
}

// Rolls per-product validations up into the numbers the panel shows.
function summarizeValidation(entries) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const ready = list.filter((entry) => entry.missingRequired.length === 0);
  const blocked = list.filter((entry) => entry.missingRequired.length > 0);
  const missingCounter = new Map();
  for (const entry of blocked) {
    for (const parameter of entry.missingRequired) {
      const key = String(parameter.id);
      const current = missingCounter.get(key) || { id: parameter.id, name: parameter.name, count: 0 };
      current.count += 1;
      missingCounter.set(key, current);
    }
  }
  return {
    productCount: list.length,
    readyCount: ready.length,
    blockedCount: blocked.length,
    averageReadiness: list.length ? Math.round(list.reduce((sum, entry) => sum + entry.readiness, 0) / list.length) : 0,
    topMissingRequired: Array.from(missingCounter.values()).sort((a, b) => b.count - a.count).slice(0, 20)
  };
}

module.exports = {
  buildParameterLookup,
  findParameterForKey,
  normalizeCategoryParameter,
  normalizeCategoryParameters,
  normalizeParameterKey,
  summarizeValidation,
  validateProductAgainstParameters
};
