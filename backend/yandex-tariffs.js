const { buildYandexAuthProfiles } = require("./yandex-fetch");
const { formatYandexApiError, shouldRetryWithNextAuth } = require("./yandex-http");

const YANDEX_MARKET_BASE_URL = process.env.YANDEX_MARKET_BASE_URL || "https://api.partner.market.yandex.ru";

// 从 server.js 拆出的 Yandex FBS 佣金/平台费率计算（无 db 依赖）。

function buildOnlineProductKey(product) {
  const shopId = String(product.shopId || "").trim();
  const sku = String(product.shopSku || product.offerId || "").trim();
  return `${shopId}::${sku}`;
}

function numberOrFallback(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseTariffMetricNumber(entry, keywordList = []) {
  const hasKeyword = (name) => !keywordList.length || keywordList.some((kw) => String(name || "").toLowerCase().includes(kw));
  const directCandidates = [];
  if (hasKeyword("percent") || hasKeyword("rate") || hasKeyword("fee")) {
    directCandidates.push(entry?.percent, entry?.rate);
  }
  if (hasKeyword("amount") || hasKeyword("cost") || hasKeyword("value") || hasKeyword("tariff")) {
    directCandidates.push(entry?.amount, entry?.value, entry?.cost, entry?.total);
  }
  if (!directCandidates.length) {
    directCandidates.push(entry?.percent, entry?.rate, entry?.amount, entry?.value, entry?.cost, entry?.total);
  }
  for (const raw of directCandidates) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  const params = Array.isArray(entry?.parameters) ? entry.parameters : [];
  for (const p of params) {
    const name = String(p?.name || p?.key || "").toLowerCase();
    if (!name) continue;
    if (!keywordList.length || keywordList.some((kw) => name.includes(kw))) {
      const n = Number(p?.value);
      if (Number.isFinite(n)) return n;
    }
  }
  return NaN;
}

function extractFbsCommissionFromTariffOffer(offerRow, fallbackPrice) {
  const tariffs = Array.isArray(offerRow?.tariffs)
    ? offerRow.tariffs
    : Array.isArray(offerRow?.services)
      ? offerRow.services
      : [];
  const target =
    tariffs.find((x) => /fee|commission|agency/i.test(String(x?.type || x?.tariffType || x?.name || "").toLowerCase())) || offerRow;
  if (!target || typeof target !== "object") return null;

  let percent = parseTariffMetricNumber(target, ["percent", "rate", "fee"]);
  let amount = parseTariffMetricNumber(target, ["amount", "cost", "value", "tariff"]);
  if (!Number.isFinite(percent)) percent = NaN;
  if (!Number.isFinite(amount)) amount = NaN;

  const price = Number(fallbackPrice) || 0;
  if (!Number.isFinite(percent) && Number.isFinite(amount) && amount > 0 && price > 0) {
    percent = (amount / price) * 100;
  }
  if (!Number.isFinite(percent) && !Number.isFinite(amount)) return null;

  const percentText = Number.isFinite(percent) ? `${percent.toFixed(2)}%` : "";
  const amountText = Number.isFinite(amount) ? `${amount.toFixed(2)} RUB` : "";
  const text = percentText && amountText ? `${percentText} (~${amountText})` : percentText || amountText || "";
  return {
    percent: Number.isFinite(percent) ? Number(percent.toFixed(4)) : 0,
    amount: Number.isFinite(amount) ? Number(amount.toFixed(4)) : 0,
    text
  };
}

function extractYandexTariffOffers(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.offers)) return payload.offers;
  if (Array.isArray(payload.result?.offers)) return payload.result.offers;
  if (Array.isArray(payload.result)) return payload.result;
  return [];
}

async function calculateYandexFbsCommission(shop, items) {
  const source = Array.isArray(items) ? items : [];
  const prepared = source
    .filter((item) => Number(item?.categoryId || 0) > 0)
    .map((item, idx) => {
      const price = numberOrFallback(item?.purchase_price_rub, 0) > 0 ? numberOrFallback(item?.purchase_price_rub, 0) : numberOrFallback(item?.price, 0);
      return {
        key: String(item.__matchKey || `row-${idx}`),
        categoryId: Number(item.categoryId || 0) || 0,
        price: Math.max(1, Number(price) || 1),
        dimensions: {
          length: Math.max(1, numberOrFallback(item.package_length_cm, 10)),
          width: Math.max(1, numberOrFallback(item.package_width_cm, 10)),
          height: Math.max(1, numberOrFallback(item.package_height_cm, 10))
        },
        weightKg: Math.max(0.01, numberOrFallback(item.weight_kg, 0.2))
      };
    });
  if (!prepared.length) return { ok: true, byKey: new Map() };

  const authProfiles = buildYandexAuthProfiles(shop.apiKey);
  const endpoint = `${YANDEX_MARKET_BASE_URL}/v2/tariffs/calculate`;
  const baseParameters = { sellingProgram: "FBS", currency: "RUR", frequency: "DAILY" };
  const payloadVariants = [
    {
      parameters: baseParameters,
      offers: prepared.map((row, idx) => ({
        offerId: `PM-${idx + 1}`,
        categoryId: row.categoryId,
        price: row.price,
        length: row.dimensions.length,
        width: row.dimensions.width,
        height: row.dimensions.height,
        weight: row.weightKg,
        quantity: 1
      }))
    }
  ];

  let firstErrorMessage = "";
  let lastErrorMessage = "";
  for (const profile of authProfiles) {
    let moveToNextAuth = false;
    for (const payload of payloadVariants) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { ...profile.headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
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

      const offers = extractYandexTariffOffers(data);
      const byKey = new Map();
      for (let i = 0; i < prepared.length; i += 1) {
        const raw = offers[i] || {};
        const parsed = extractFbsCommissionFromTariffOffer(raw, prepared[i].price);
        if (parsed) byKey.set(prepared[i].key, parsed);
      }
      return { ok: true, byKey };
    }
    if (moveToNextAuth) continue;
  }

  return { ok: false, message: firstErrorMessage || lastErrorMessage || "Yandex FBS tariff unavailable" };
}

function extractYandexPlacementFee(offerRow, price) {
  const tariffs = Array.isArray(offerRow?.tariffs) ? offerRow.tariffs : [];
  const fee = tariffs.find((item) => String(item?.type || "").trim().toUpperCase() === "FEE");
  if (!fee) return null;
  const parameters = Array.isArray(fee.parameters) ? fee.parameters : [];
  const parameter = (name) => parameters.find((item) => String(item?.name || "").trim().toLowerCase() === name)?.value;
  const rawAmount = Number(fee.amount);
  const rawValue = Number(parameter("value"));
  const valueType = String(parameter("valuetype") || "").trim().toLowerCase();
  const amount = Number.isFinite(rawAmount) ? rawAmount : 0;
  let percent = valueType === "relative" && Number.isFinite(rawValue) ? rawValue : NaN;
  if (!Number.isFinite(percent) && amount > 0 && Number(price) > 0) percent = amount / Number(price) * 100;
  if (!Number.isFinite(percent) && !Number.isFinite(amount)) return null;
  return {
    percent: Number.isFinite(percent) ? Number(percent.toFixed(4)) : null,
    amount: Number.isFinite(amount) ? Number(amount.toFixed(4)) : null,
    parameters
  };
}

async function calculateYandexOnlineProductFees(shop, products) {
  const candidates = (Array.isArray(products) ? products : []).map((product) => {
    const categoryId = Number(product?.categoryId || 0);
    const price = Number(product?.salePrice ?? product?.price ?? 0);
    const length = Number(product?.packageLengthCm ?? product?.length ?? 0);
    const width = Number(product?.packageWidthCm ?? product?.width ?? 0);
    const height = Number(product?.packageHeightCm ?? product?.height ?? 0);
    const weight = Number(product?.weightKg ?? product?.weight ?? 0);
    const missing = [];
    if (!(categoryId > 0)) missing.push("类目");
    if (!(price > 0)) missing.push("售价");
    if (!(length > 0 && width > 0 && height > 0)) missing.push("包装尺寸");
    if (!(weight > 0)) missing.push("重量");
    return { product, key: String(product?.id || buildOnlineProductKey(product)), categoryId, price, length, width, height, weight, missing };
  });
  const byKey = new Map();
  const skipped = candidates.filter((entry) => entry.missing.length);
  const ready = candidates.filter((entry) => !entry.missing.length);
  for (const entry of skipped) {
    byKey.set(entry.key, { ok: false, message: `缺少${entry.missing.join("、")}` });
  }
  if (!ready.length) return { ok: true, byKey, calculated: 0, skipped: skipped.length, errors: [] };

  const endpoint = `${YANDEX_MARKET_BASE_URL}/v2/tariffs/calculate`;
  const authProfiles = buildYandexAuthProfiles(shop?.apiKey);
  const errors = [];
  let calculated = 0;
  for (let start = 0; start < ready.length; start += 200) {
    const batch = ready.slice(start, start + 200);
    const payload = {
      parameters: { campaignId: Number(shop?.campaignId), currency: "RUR", frequency: "DAILY" },
      offers: batch.map((entry) => ({
        categoryId: entry.categoryId,
        price: entry.price,
        length: entry.length,
        width: entry.width,
        height: entry.height,
        weight: entry.weight,
        quantity: 1
      }))
    };
    let responseData = null;
    let message = "";
    for (const profile of authProfiles) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { ...profile.headers, "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && String(data?.status || "OK").toUpperCase() !== "ERROR") {
          responseData = data;
          break;
        }
        message = formatYandexApiError(response.status, data);
      } catch (error) {
        message = `Yandex tariff request failed: ${String(error?.message || error)}`;
      }
    }
    if (!responseData) {
      const failureMessage = message || "Yandex tariff calculation failed";
      errors.push({ shopId: shop?.id || "", message: failureMessage });
      for (const entry of batch) byKey.set(entry.key, { ok: false, message: failureMessage });
      continue;
    }
    const offers = extractYandexTariffOffers(responseData);
    for (let index = 0; index < batch.length; index += 1) {
      const entry = batch[index];
      const fee = extractYandexPlacementFee(offers[index], entry.price);
      if (!fee || fee.percent === null) {
        byKey.set(entry.key, { ok: false, message: "Yandex 未返回 FEE 平台佣金" });
        continue;
      }
      byKey.set(entry.key, { ok: true, ...fee });
      calculated += 1;
    }
  }
  return { ok: errors.length === 0, byKey, calculated, skipped: skipped.length, errors };
}

module.exports = {
  buildOnlineProductKey,
  calculateYandexFbsCommission,
  calculateYandexOnlineProductFees,
  extractFbsCommissionFromTariffOffer,
  extractYandexPlacementFee,
  extractYandexTariffOffers,
  numberOrFallback,
  parseTariffMetricNumber,
};
