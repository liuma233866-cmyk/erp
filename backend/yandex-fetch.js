const crypto = require("crypto");
const { extractYandexCampaigns, fetchYandexJson, formatYandexApiError, shouldRetryWithNextAuth } = require("./yandex-http");
const { addDaysToYandexDate, buildYandexOrderDateRanges, buildYandexOrderDateRangesFromWindow, normalizeYandexBusinessDateInput } = require("./datetime");
const { extractYandexDeliveryServices, extractYandexOrderId, extractYandexOrders } = require("./yandex-orders-map");
const { buildYandexCategoryIndexFromList, buildYandexCategoryIndexFromTree, getYandexCategoryListItems, getYandexCategoryTreeRoot } = require("./yandex-category-text");
const { buildOfferCardsPayload: buildOfferCardsPayloadPure, fetchAllOfferCards: fetchAllOfferCardsPure, parseOfferCardsResponse } = require("./yandex-card-quality");
const { withFetchTimeout } = require("./http-timeout");

const YANDEX_MARKET_BASE_URL = process.env.YANDEX_MARKET_BASE_URL || "https://api.partner.market.yandex.ru";
const YANDEX_ORDER_SYNC_LOOKBACK_DAYS = Math.max(29, Number(process.env.YANDEX_ORDER_SYNC_LOOKBACK_DAYS || 180) || 180);
const YANDEX_CATEGORY_CACHE_TTL_MS = Math.max(5 * 60 * 1000, Number(process.env.YANDEX_CATEGORY_CACHE_TTL_MS || 6 * 60 * 60 * 1000) || 6 * 60 * 60 * 1000);
const yandexCategoryCache = new Map();

// 从 server.js 拆出的 Yandex API 拉取（异步函数，无 db 依赖）。

function extractYandexOfferMappingEntries(payload) {
  if (Array.isArray(payload.offerMappingEntries)) return payload.offerMappingEntries;
  if (Array.isArray(payload.result?.offerMappingEntries)) return payload.result.offerMappingEntries;
  return [];
}

function extractYandexOfferMappingNextPageToken(payload) {
  return (
    payload.result?.paging?.nextPageToken ||
    payload.paging?.nextPageToken ||
    payload.result?.paging?.next_page_token ||
    payload.paging?.next_page_token ||
    ""
  );
}

function extractOfferMappings(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.offerMappings)) return payload.offerMappings;
  if (Array.isArray(payload.result?.offerMappings)) return payload.result.offerMappings;
  return [];
}

function buildOfferMap(entries) {
  const map = {};
  for (const entry of entries || []) {
    const offer = entry.offer || entry.mapping?.offer || entry.offerMapping?.offer || {};
    const offerId = String(offer.offerId || offer.id || entry.offerId || "").trim();
    if (!offerId) continue;
    const pictures = Array.isArray(offer.pictures) ? offer.pictures : Array.isArray(offer.images) ? offer.images : [];
    const image = pictures.length ? String(pictures[0] || "").trim() : "";
    const name = String(offer.name || offer.offerName || "").trim();
    map[offerId] = { name, image };
  }
  return map;
}

async function fetchYandexCategoryIndex(apiKey, language = "RU") {
  if (!apiKey) return { ok: false, status: 400, message: "apiKey is required" };
  const key = crypto.createHash("sha1").update(`${apiKey}|${language}`).digest("hex");
  const cached = yandexCategoryCache.get(key);
  if (cached && Date.now() - cached.ts < YANDEX_CATEGORY_CACHE_TTL_MS && cached.index) {
    return { ok: true, index: cached.index, cached: true };
  }

  const listEndpoint = `${YANDEX_MARKET_BASE_URL}/v2/categories`;
  const treeEndpoint = `${YANDEX_MARKET_BASE_URL}/v2/categories/tree`;
  const authProfiles = buildYandexAuthProfiles(apiKey);
  const treeAttempts = [
    { method: "POST", body: JSON.stringify({ language }), headers: { "Content-Type": "application/json" } },
    { method: "POST", body: JSON.stringify({}), headers: { "Content-Type": "application/json" } },
    { method: "GET", body: undefined, headers: {} }
  ];
  const listAttempts = [
    { method: "GET", endpoint: `${listEndpoint}?language=${encodeURIComponent(String(language || "RU"))}`, body: undefined, headers: {} },
    { method: "GET", endpoint: listEndpoint, body: undefined, headers: {} }
  ];
  let firstErrorMessage = "";
  let lastErrorMessage = "";

  for (const profile of authProfiles) {
    let nextAuth = false;
    for (const attempt of listAttempts) {
      const response = await fetch(attempt.endpoint, withFetchTimeout({
        method: attempt.method,
        headers: { ...profile.headers, ...attempt.headers },
        body: attempt.body
      }));
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastErrorMessage = formatYandexApiError(response.status, data);
        if (!firstErrorMessage) firstErrorMessage = lastErrorMessage;
        if (shouldRetryWithNextAuth(response.status, data)) {
          nextAuth = true;
          break;
        }
        continue;
      }
      const listItems = getYandexCategoryListItems(data);
      const index = buildYandexCategoryIndexFromList(listItems);
      if (!index.leaves.length) continue;
      yandexCategoryCache.set(key, { ts: Date.now(), index });
      return { ok: true, index, cached: false };
    }
    if (nextAuth) continue;

    for (const attempt of treeAttempts) {
      const response = await fetch(treeEndpoint, withFetchTimeout({
        method: attempt.method,
        headers: { ...profile.headers, ...attempt.headers },
        body: attempt.body
      }));
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastErrorMessage = formatYandexApiError(response.status, data);
        if (!firstErrorMessage) firstErrorMessage = lastErrorMessage;
        if (shouldRetryWithNextAuth(response.status, data)) {
          nextAuth = true;
          break;
        }
        continue;
      }
      const root = getYandexCategoryTreeRoot(data);
      if (!root) continue;
      const index = buildYandexCategoryIndexFromTree(root);
      if (!index.leaves.length) continue;
      yandexCategoryCache.set(key, { ts: Date.now(), index });
      return { ok: true, index, cached: false };
    }
    if (nextAuth) continue;
  }

  return { ok: false, status: 502, message: firstErrorMessage || lastErrorMessage || "Yandex category tree unavailable" };
}

function extractYandexSuggestionEntries(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.offerMappings)) return payload.offerMappings;
  if (Array.isArray(payload.offers)) return payload.offers;
  if (Array.isArray(payload.result?.offerMappings)) return payload.result.offerMappings;
  if (Array.isArray(payload.result?.offers)) return payload.result.offers;
  if (Array.isArray(payload.result)) return payload.result;
  return [];
}

function parseSuggestionCategory(entry) {
  const mapping = entry?.mapping || entry?.offerMapping || {};
  const offer = entry?.offer || {};
  const categoryId = Number(
    mapping.marketCategoryId ||
      mapping.categoryId ||
      offer.marketCategoryId ||
      offer.categoryId ||
      entry.marketCategoryId ||
      entry.categoryId ||
      0
  ) || 0;
  const categoryName =
    String(mapping.marketCategoryName || mapping.categoryName || offer.marketCategoryName || offer.categoryName || entry.marketCategoryName || entry.categoryName || "").trim();
  return { categoryId, categoryName };
}

async function fetchYandexCategorySuggestions(businessId, apiKey, products) {
  if (!businessId || !apiKey) return { ok: false, message: "businessId/apiKey required" };
  const source = Array.isArray(products) ? products : [];
  if (!source.length) return { ok: true, map: new Map() };

  const endpoint = `${YANDEX_MARKET_BASE_URL}/v2/businesses/${encodeURIComponent(businessId)}/offer-mappings/suggestions`;
  const authProfiles = buildYandexAuthProfiles(apiKey);
  const payloads = [
    {
      offerMappings: source.map((item) => ({
        offer: {
          offerId: String(item.__suggestOfferId || ""),
          name: String(item.title || "").slice(0, 300),
          description: String(item.description || "").slice(0, 1500),
          pictures: Array.isArray(item.images) ? item.images.slice(0, 10).map((x) => String(x || "").trim()).filter(Boolean) : []
        }
      }))
    },
    {
      offers: source.map((item) => ({
        offerId: String(item.__suggestOfferId || ""),
        name: String(item.title || "").slice(0, 300),
        description: String(item.description || "").slice(0, 1500),
        pictures: Array.isArray(item.images) ? item.images.slice(0, 10).map((x) => String(x || "").trim()).filter(Boolean) : []
      }))
    }
  ];

  let firstErrorMessage = "";
  let lastErrorMessage = "";
  for (const profile of authProfiles) {
    let moveToNextAuth = false;
    for (const payload of payloads) {
      const response = await fetch(endpoint, withFetchTimeout({
        method: "POST",
        headers: { ...profile.headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }));
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastErrorMessage = formatYandexApiError(response.status, data);
        if (!firstErrorMessage) firstErrorMessage = lastErrorMessage;
        if (shouldRetryWithNextAuth(response.status, data)) {
          moveToNextAuth = true;
          break;
        }
        continue;
      }
      const entries = extractYandexSuggestionEntries(data);
      const map = new Map();
      for (const entry of entries) {
        const offer = entry?.offer || {};
        const offerId = String(offer.offerId || entry.offerId || entry.id || "").trim();
        if (!offerId) continue;
        const parsed = parseSuggestionCategory(entry);
        if (parsed.categoryId > 0) {
          map.set(offerId, { ...parsed, confidence: 0.98 });
        }
      }
      return { ok: true, map };
    }
    if (moveToNextAuth) continue;
  }

  return { ok: false, message: firstErrorMessage || lastErrorMessage || "Yandex category suggestion unavailable" };
}

function buildYandexAuthProfiles(apiKey) {
  const token = String(apiKey || "").trim();
  if (!token) return [];
  return [
    { mode: "api_key", headers: { Accept: "application/json", "Api-Key": token } }
  ];
}

async function fetchYandexCampaign(campaignId, apiKey) {
  const listEndpoint = `${YANDEX_MARKET_BASE_URL}/v2/campaigns`;
  const detailEndpoint = `${YANDEX_MARKET_BASE_URL}/v2/campaigns/${encodeURIComponent(campaignId)}`;
  const authProfiles = buildYandexAuthProfiles(apiKey);

  let firstErrorMessage = "";
  let lastErrorMessage = "";

  for (const profile of authProfiles) {
    const listResult = await fetchYandexJson(listEndpoint, { headers: profile.headers });
    const listData = listResult.data || {};
    if (!listResult.ok) {
      lastErrorMessage = listResult.errorMessage || formatYandexApiError(listResult.status, listData);
      if (!firstErrorMessage) firstErrorMessage = lastErrorMessage;
      if (!shouldRetryWithNextAuth(listResult.status, listData)) {
        return { ok: false, message: lastErrorMessage };
      }
      continue;
    }

    const campaigns = extractYandexCampaigns(listData);
    const campaignFromList = campaigns.find((c) => String(c.id || "") === String(campaignId));
    if (!campaignFromList) {
      return {
        ok: false,
        message: `campaignId ${campaignId} 不在该 token 可访问店铺列表中`
      };
    }

    const detailResult = await fetchYandexJson(detailEndpoint, { headers: profile.headers });
    const detailData = detailResult.data || {};
    if (!detailResult.ok) {
      lastErrorMessage = detailResult.errorMessage || formatYandexApiError(detailResult.status, detailData);
      if (!firstErrorMessage) firstErrorMessage = lastErrorMessage;
      if (!shouldRetryWithNextAuth(detailResult.status, detailData)) {
        return { ok: false, message: lastErrorMessage };
      }
      continue;
    }

    const item = detailData.campaign || detailData.result?.campaign || detailData.result || campaignFromList;
    if (!item || (item.id === undefined && item.campaignId === undefined)) {
      return { ok: false, message: "Yandex campaign payload is invalid" };
    }
    return { ok: true, item };
  }

  return { ok: false, message: firstErrorMessage || lastErrorMessage || "Yandex API auth failed" };
}

async function fetchYandexOrders(campaignId, apiKey, options = {}) {
  const limit = 50;
  const authProfiles = buildYandexAuthProfiles(apiKey);
  const businessId = String(options.businessId || "").trim();
  let firstErrorMessage = "";
  let lastErrorMessage = "";
  const ranges = options.fromDate && options.toDate
    ? buildYandexOrderDateRangesFromWindow(options.fromDate, options.toDate, 29)
    : buildYandexOrderDateRanges(YANDEX_ORDER_SYNC_LOOKBACK_DAYS, 29);

  for (const profile of authProfiles) {
    const allItems = [];
    const seenOrderIds = new Set();
    // 区间循环是否因「请求失败」提前中断。必须与 business→legacy 的正常策略回退区分开：
    // 后者不是数据缺口，前者是。
    let truncatedByFailure = false;

    const strategies = businessId
      ? ["business", "legacy"]
      : ["legacy"];

    for (const strategy of strategies) {
      let strategyFailed = false;

      for (const range of ranges) {
        let page = 1;
        let nextPageToken = "";
        let exhausted = false;

        while (page <= 100 && !exhausted) {
          let request;
          if (strategy === "business") {
            const endpoint = `${YANDEX_MARKET_BASE_URL}/v1/businesses/${encodeURIComponent(businessId)}/orders?limit=${limit}${
              nextPageToken ? `&pageToken=${encodeURIComponent(nextPageToken)}` : ""
            }`;
            const body = {
              dates: {
                creationDateFrom: normalizeYandexBusinessDateInput(range.fromDate),
                creationDateTo: normalizeYandexBusinessDateInput(addDaysToYandexDate(range.toDate, 1))
              }
            };
            request = {
              endpoint,
              options: {
                method: "POST",
                headers: { ...profile.headers, "Content-Type": "application/json" },
                body: JSON.stringify(body)
              }
            };
          } else {
            const baseEndpoint = `${YANDEX_MARKET_BASE_URL}/v2/campaigns/${encodeURIComponent(campaignId)}/orders?fromDate=${encodeURIComponent(
              range.fromDate
            )}&toDate=${encodeURIComponent(range.toDate)}&limit=${limit}`;
            const endpoint = nextPageToken
              ? `${baseEndpoint}&page_token=${encodeURIComponent(nextPageToken)}`
              : page > 1
                ? `${baseEndpoint}&page=${page}`
                : baseEndpoint;
            request = {
              endpoint,
              options: { headers: profile.headers }
            };
          }

          const result = await fetchYandexJson(request.endpoint, request.options);
          const data = result.data || {};
          if (!result.ok) {
            const errorText = result.errorMessage || formatYandexApiError(result.status, data);
            lastErrorMessage = `${strategy === "business" ? "business" : "legacy"}: ${errorText}`;
            if (!firstErrorMessage) firstErrorMessage = lastErrorMessage;
            if (
              strategy === "business" &&
              (result.status === 404 || result.status === 405 || result.status === 400 ||
                JSON.stringify(data || {}).toLowerCase().includes("deprecated") ||
                JSON.stringify(data || {}).toLowerCase().includes("unsupported") ||
                JSON.stringify(data || {}).toLowerCase().includes("not found") ||
                JSON.stringify(data || {}).toLowerCase().includes("method not allowed"))
            ) {
              // Abandon the business strategy for ALL date ranges, not just the
              // current page loop, so the legacy endpoint takes over right away.
              strategyFailed = true;
              break;
            }
            if (!shouldRetryWithNextAuth(result.status, data)) {
              strategyFailed = true;
              // 真正的失败：剩余时间区间不会再拉取，已收集到的订单属于部分结果。
              truncatedByFailure = true;
            }
            break;
          }

          const items = extractYandexOrders(data);
          for (const item of items) {
            const orderId = extractYandexOrderId(item);
            if (!orderId) continue;
            if (seenOrderIds.has(orderId)) continue;
            if (strategy === "business") {
              const itemCampaignId = String(item.campaignId || item.campaign?.id || item.order?.campaignId || "").trim();
              if (itemCampaignId && String(campaignId) && itemCampaignId !== String(campaignId)) continue;
            }
            seenOrderIds.add(orderId);
            allItems.push(item);
          }

          const token =
            data.paging?.nextPageToken ||
            data.paging?.next_page_token ||
            data.result?.paging?.nextPageToken ||
            data.result?.paging?.next_page_token ||
            data.pager?.nextPageToken ||
            data.pager?.next_page_token ||
            data.result?.pager?.nextPageToken ||
            data.result?.pager?.next_page_token ||
            "";

          if (token) {
            nextPageToken = String(token);
            // Token-based paging owns the cursor: do not increment `page` here,
            // or the numeric page cursor diverges when the token stream ends.
            continue;
          }

          if (items.length < limit) {
            exhausted = true;
          } else {
            page += 1;
          }
        }

        if (strategyFailed) break;
      }

      if (allItems.length > 0) {
        // 区间循环中途失败时不能当成「完整拉取成功」返回：180 天回溯被切成多个 29 天窗口，
        // 第 5 个窗口被限流就会只返回前 4 个窗口的订单，而调用方只判 !ok 的话会把这次同步
        // 记成成功，丢掉的订单无人知晓。用 partial 标出来，由调用方计入错误摘要。
        return truncatedByFailure
          ? {
              ok: true,
              items: allItems,
              partial: true,
              message: firstErrorMessage || lastErrorMessage || "订单列表未拉全"
            }
          : { ok: true, items: allItems };
      }
    }
  }

  return { ok: false, message: firstErrorMessage || lastErrorMessage || "Yandex API auth failed" };
}

async function fetchYandexOrderDetail(campaignId, apiKey, orderId) {
  const endpoint = `${YANDEX_MARKET_BASE_URL}/v2/campaigns/${encodeURIComponent(campaignId)}/orders/${encodeURIComponent(orderId)}`;
  const authProfiles = buildYandexAuthProfiles(apiKey);
  let firstErrorMessage = "";
  let lastErrorMessage = "";

  for (const profile of authProfiles) {
    const result = await fetchYandexJson(endpoint, { headers: profile.headers });
    const data = result.data || {};
    if (!result.ok) {
      lastErrorMessage = result.errorMessage || formatYandexApiError(result.status, data);
      if (!firstErrorMessage) firstErrorMessage = lastErrorMessage;
      if (!shouldRetryWithNextAuth(result.status, data)) {
        break;
      }
      continue;
    }
    const item = data.order || data.result?.order || data.result || data;
    return { ok: true, item };
  }

  return { ok: false, message: firstErrorMessage || lastErrorMessage || "Yandex order detail failed" };
}

async function fetchYandexDeliveryServices(campaignId, apiKey) {
  const endpoint = `${YANDEX_MARKET_BASE_URL}/v2/delivery/services`;
  const authProfiles = buildYandexAuthProfiles(apiKey);
  let firstErrorMessage = "";
  let lastErrorMessage = "";

  for (const profile of authProfiles) {
    const result = await fetchYandexJson(endpoint, { headers: profile.headers });
    const data = result.data || {};
    if (!result.ok) {
      lastErrorMessage = result.errorMessage || formatYandexApiError(result.status, data);
      if (!firstErrorMessage) firstErrorMessage = lastErrorMessage;
      if (!shouldRetryWithNextAuth(result.status, data)) {
        break;
      }
      continue;
    }
    const items = extractYandexDeliveryServices(data);
    return { ok: true, items };
  }

  return { ok: false, message: firstErrorMessage || lastErrorMessage || "Yandex delivery services failed" };
}

async function fetchYandexOfferMappings(businessId, apiKey, offerIds) {
  if (!businessId || !offerIds.length) return { ok: true, map: {} };
  const authProfiles = buildYandexAuthProfiles(apiKey);
  const endpoint = `${YANDEX_MARKET_BASE_URL}/v2/businesses/${encodeURIComponent(businessId)}/offer-mappings`;
  const body = JSON.stringify({ offerIds });
  let firstErrorMessage = "";
  let lastErrorMessage = "";

  for (const profile of authProfiles) {
    const result = await fetchYandexJson(endpoint, {
      method: "POST",
      headers: { ...profile.headers, "Content-Type": "application/json" },
      body
    });
    const data = result.data || {};
    if (!result.ok) {
      lastErrorMessage = result.errorMessage || formatYandexApiError(result.status, data);
      if (!firstErrorMessage) firstErrorMessage = lastErrorMessage;
      if (!shouldRetryWithNextAuth(result.status, data)) {
        break;
      }
      continue;
    }
    const entries = extractOfferMappings(data);
    return { ok: true, map: buildOfferMap(entries), entries };
  }

  return { ok: false, message: firstErrorMessage || lastErrorMessage || "Yandex offer mappings failed" };
}

async function fetchYandexOfferMappingsPaged(businessId, apiKey) {
  if (!businessId) return { ok: false, message: "businessId is required" };
  const authProfiles = buildYandexAuthProfiles(apiKey);
  const endpoint = `${YANDEX_MARKET_BASE_URL}/v2/businesses/${encodeURIComponent(businessId)}/offer-mappings`;

  try {
    let firstErrorMessage = "";
    let lastErrorMessage = "";

    for (const profile of authProfiles) {
      let nextPageToken = "";
      const collected = [];
      let gotResponse = false;
      do {
        const params = new URLSearchParams();
        params.set("limit", "200");
        if (nextPageToken) params.set("pageToken", nextPageToken);
        const result = await fetchYandexJson(`${endpoint}?${params.toString()}`, { method: "POST", headers: profile.headers });
        const data = result.data || {};
        if (!result.ok) {
          lastErrorMessage = result.errorMessage || formatYandexApiError(result.status, data);
          if (!firstErrorMessage) firstErrorMessage = lastErrorMessage;
          if (!shouldRetryWithNextAuth(result.status, data)) {
            return { ok: false, message: lastErrorMessage };
          }
          break;
        }
        gotResponse = true;
        collected.push(...extractOfferMappings(data));
        nextPageToken = extractYandexOfferMappingNextPageToken(data);
      } while (nextPageToken);

      if (gotResponse) {
        return { ok: true, items: collected };
      }
    }

    return { ok: false, message: firstErrorMessage || lastErrorMessage || "Yandex offer mappings failed" };
  } catch (error) {
    return { ok: false, message: `Yandex offer mappings unavailable: ${String(error)}` };
  }
}

async function fetchYandexOfferCards(businessId, apiKey, options = {}) {
  if (!businessId) return { ok: false, message: "businessId is required" };
  const authProfiles = buildYandexAuthProfiles(apiKey);
  if (!authProfiles.length) return { ok: false, message: "apiKey is required" };

  const body = buildOfferCardsPayloadPure(options);
  const params = new URLSearchParams();
  const limit = Number(options.limit);
  params.set("limit", String(Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.floor(limit))) : 100));
  const pageToken = String(options.pageToken || "").trim();
  if (pageToken) params.set("pageToken", pageToken);

  const endpoint = `${YANDEX_MARKET_BASE_URL}/v2/businesses/${encodeURIComponent(businessId)}/offer-cards?${params.toString()}`;

  try {
    let firstErrorMessage = "";
    let lastErrorMessage = "";
    for (const profile of authProfiles) {
      const result = await fetchYandexJson(endpoint, {
        method: "POST",
        headers: { ...profile.headers, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = result.data || {};
      if (!result.ok) {
        lastErrorMessage = result.errorMessage || formatYandexApiError(result.status, data);
        if (!firstErrorMessage) firstErrorMessage = lastErrorMessage;
        if (!shouldRetryWithNextAuth(result.status, data)) {
          return { ok: false, status: result.status, message: lastErrorMessage };
        }
        continue;
      }
      const parsed = parseOfferCardsResponse(data);
      return {
        ok: true,
        offers: parsed.offers,
        categoryAverageRating: parsed.categoryAverageRating,
        averageRating: parsed.averageRating,
        nextPageToken: parsed.nextPageToken,
        hasNextPage: parsed.hasNextPage,
        requestBody: body
      };
    }
    return { ok: false, message: firstErrorMessage || lastErrorMessage || "Yandex offer cards failed" };
  } catch (error) {
    return { ok: false, message: `Yandex offer cards unavailable: ${String(error)}` };
  }
}

async function fetchAllYandexOfferCards(businessId, apiKey, options = {}) {
  return fetchAllOfferCardsPure(
    (pageToken) => fetchYandexOfferCards(businessId, apiKey, { ...options, pageToken }),
    { maxPages: options.maxPages }
  );
}

async function fetchYandexOrderLabels(campaignId, apiKey, orderId, format = "A4") {
  const endpoint = `${YANDEX_MARKET_BASE_URL}/v2/campaigns/${encodeURIComponent(campaignId)}/orders/${encodeURIComponent(
    orderId
  )}/delivery/labels?format=${encodeURIComponent(format)}`;
  const authProfiles = buildYandexAuthProfiles(apiKey);
  let firstErrorMessage = "";
  let lastErrorMessage = "";

  for (const profile of authProfiles) {
    const response = await fetch(endpoint, withFetchTimeout({ headers: profile.headers }));
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      lastErrorMessage = formatYandexApiError(response.status, data);
      if (!firstErrorMessage) firstErrorMessage = lastErrorMessage;
      if (!shouldRetryWithNextAuth(response.status, data)) {
        break;
      }
      continue;
    }
    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "application/pdf";
    return { ok: true, data: Buffer.from(arrayBuffer), contentType };
  }

  return { ok: false, message: firstErrorMessage || lastErrorMessage || "Yandex API auth failed", status: 401 };
}

module.exports = {
  buildOfferMap,
  buildYandexAuthProfiles,
  extractOfferMappings,
  extractYandexOfferMappingEntries,
  extractYandexOfferMappingNextPageToken,
  extractYandexSuggestionEntries,
  fetchAllYandexOfferCards,
  fetchYandexCampaign,
  fetchYandexCategoryIndex,
  fetchYandexCategorySuggestions,
  fetchYandexDeliveryServices,
  fetchYandexOfferCards,
  fetchYandexOfferMappings,
  fetchYandexOfferMappingsPaged,
  fetchYandexOrderDetail,
  fetchYandexOrderLabels,
  fetchYandexOrders,
  parseSuggestionCategory,
};
