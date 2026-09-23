// Pure helpers for the Yandex "offer cards" content-status method
// (POST /v2/businesses/{businessId}/offer-cards).
//
// The endpoint reports how completely a product card is filled in, plus the
// recommendations, errors and warnings that explain what is still missing. The
// response shape differs slightly between catalog versions, so every reader here
// accepts several spellings and degrades to an empty value instead of throwing.

const MAX_TEXT_LENGTH = 600;

function text(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function clampText(value, max = MAX_TEXT_LENGTH) {
  const normalized = text(value);
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function asRating(value) {
  // Number("") is 0, which would report an unfilled card as a real score of zero.
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function collectStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map(text).filter(Boolean);
}

// `recommendations` is the most valuable field of the response: it is Yandex
// telling the seller exactly what to add to the card.
function normalizeRecommendation(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    const description = clampText(raw);
    return description ? { type: "", description, fieldNames: [] } : null;
  }
  if (typeof raw !== "object") return null;

  const type = text(raw.type || raw.recommendationType || raw.code);
  const description = clampText(raw.description || raw.message || raw.title || raw.text);
  const fieldNames = collectStrings(raw.fieldNames || raw.fields || raw.parameterNames || raw.names);
  const recommendation = text(raw.recommendation || raw.advice || raw.value);

  if (!type && !description && !fieldNames.length && !recommendation) return null;
  return {
    type,
    description: description || recommendation,
    fieldNames: fieldNames.map((name) => clampText(name, 200))
  };
}

function normalizeCardIssue(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return clampText(raw) || null;
  if (typeof raw !== "object") return null;
  const code = text(raw.code || raw.errorCode);
  const message = clampText(raw.message || raw.description || raw.error || raw.text);
  if (!code && !message) return null;
  return { code, message };
}

function normalizeRecommendations(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizeRecommendation(value);
    if (!normalized) continue;
    const key = `${normalized.type}|${normalized.description}|${normalized.fieldNames.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeIssues(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizeCardIssue(value);
    if (!normalized) continue;
    const key = typeof normalized === "string" ? normalized : `${normalized.code}|${normalized.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeOfferView(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const ratingValue = source.rating !== undefined ? source.rating : source.contentRating;
  return {
    offerId: text(source.offerId || source.shopSku || source.offer_id),
    cardStatus: text(source.cardStatus || source.status),
    rating: asRating(ratingValue),
    recommendations: normalizeRecommendations(source.recommendations),
    errors: normalizeIssues(source.errors),
    warnings: normalizeIssues(source.warnings)
  };
}

function extractOffers(data) {
  const result = data && typeof data === "object" ? (data.result || data) : {};
  const candidates = [result.offers, result.offerCards, result.cards];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter((item) => item && typeof item === "object");
  }
  return [];
}

function parseOfferCardsResponse(data) {
  const result = data && typeof data === "object" ? (data.result || {}) : {};
  const averageCandidates = [
    result.categoryAverageRating,
    result.averageRating,
    result.categoryAverageContentRating,
    result.averageContentRating
  ];
  let categoryAverageRating = null;
  for (const candidate of averageCandidates) {
    const parsed = asRating(candidate);
    if (parsed !== null) {
      categoryAverageRating = parsed;
      break;
    }
  }

  const offers = extractOffers(data).map(normalizeOfferView);
  const rated = offers.filter((offer) => offer.rating !== null);
  const nextPageToken = text(
    result.paging?.nextPageToken ||
    result.nextPageToken ||
    result.nextPage ||
    result.pageToken
  );

  return {
    offers,
    categoryAverageRating,
    averageRating: rated.length ? rated.reduce((sum, offer) => sum + offer.rating, 0) / rated.length : null,
    nextPageToken,
    hasNextPage: Boolean(nextPageToken)
  };
}

// Builds the request body exactly as the method expects. `offerIds` must not be
// combined with the other filters, which the caller is responsible for.
function buildOfferCardsPayload(options = {}) {
  const payload = {
    withRecommendations: options.withRecommendations !== false
  };
  const offerIds = Array.isArray(options.offerIds)
    ? options.offerIds.map(text).filter(Boolean).slice(0, 200)
    : [];
  if (offerIds.length) {
    payload.offerIds = offerIds;
    return payload;
  }
  const cardStatuses = collectStrings(options.cardStatuses).slice(0, 50);
  if (cardStatuses.length) payload.cardStatuses = cardStatuses;
  const categoryIds = Array.isArray(options.categoryIds)
    ? options.categoryIds.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0).slice(0, 200)
    : [];
  if (categoryIds.length) payload.categoryIds = categoryIds;
  return payload;
}

// Pulls every card of a shop by walking `nextPageToken`, so the caller does not have
// to issue repeated lookups. `requestPage(pageToken)` performs one HTTP call and must
// resolve to `{ ok, offers, categoryAverageRating, nextPageToken, hasNextPage }`.
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_PAGE_LIMIT = 200;

async function fetchAllOfferCards(requestPage, options = {}) {
  const maxPages = Math.max(1, Number(options.maxPages) || DEFAULT_MAX_PAGES);
  const offers = [];
  const seenOfferIds = new Set();
  let categoryAverageRating = null;
  let averageRating = null;
  let pageToken = "";
  let pages = 0;
  let truncated = false;

  while (pages < maxPages) {
    const page = await requestPage(pageToken);
    if (!page || !page.ok) {
      // A mid-walk failure still returns what was collected; the caller decides
      // whether a partial snapshot is worth storing.
      if (!pages) return { ok: false, message: page?.message || "Yandex offer cards failed" };
      return { ok: true, offers, categoryAverageRating, averageRating, pages, truncated: true, partialError: page?.message || "" };
    }

    pages += 1;
    if (categoryAverageRating === null && page.categoryAverageRating !== null && page.categoryAverageRating !== undefined) {
      categoryAverageRating = page.categoryAverageRating;
    }
    if (averageRating === null && page.averageRating !== null && page.averageRating !== undefined) {
      averageRating = page.averageRating;
    }

    for (const offer of Array.isArray(page.offers) ? page.offers : []) {
      const offerId = String(offer?.offerId || "").trim();
      // The API should not repeat an offer across pages, but dedupe defensively so a
      // looping token cannot write the same card twice.
      if (offerId && seenOfferIds.has(offerId)) continue;
      if (offerId) seenOfferIds.add(offerId);
      offers.push(offer);
    }

    const nextToken = String(page.nextPageToken || "").trim();
    if (!page.hasNextPage || !nextToken) {
      pageToken = "";
      break;
    }
    if (nextToken === pageToken) {
      // Defensive: a token that never advances would loop forever.
      truncated = true;
      break;
    }
    pageToken = nextToken;
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
  }

  return {
    ok: true,
    offers,
    categoryAverageRating,
    averageRating,
    pages,
    truncated,
    partialError: ""
  };
}

module.exports = {
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_LIMIT,
  buildOfferCardsPayload,
  fetchAllOfferCards,
  normalizeRecommendations,
  parseOfferCardsResponse
};
