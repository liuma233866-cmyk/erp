function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeCurrency(value) {
  const currency = String(value || "").trim().toUpperCase();
  return currency === "CNY" ? "CNY" : "RUR";
}

function convertPublishPricesToCurrency(items, { shopId, targetCurrencyId, cnyRateRub, rateDate = "", now = new Date().toISOString() }) {
  const rate = positiveNumber(cnyRateRub);
  if (!rate) throw new Error("cnyRateRub must be greater than 0");
  const targetShopId = String(shopId || "").trim();
  if (!targetShopId) throw new Error("shopId is required");
  const targetCurrency = normalizeCurrency(targetCurrencyId);
  let converted = 0;
  let skipped = 0;
  const convertedItems = [];

  for (const item of Array.isArray(items) ? items : []) {
    if (String(item?.shopId || "").trim() !== targetShopId || String(item?.source || "").trim() !== "yandex_online_product") continue;
    const sourceCurrency = normalizeCurrency(item.sourceCurrencyId || item.sourceProductSnapshot?.currencyId || "RUR");
    item.sourceCurrencyId = sourceCurrency;
    item.currencyId = targetCurrency;
    if (sourceCurrency === targetCurrency) {
      skipped += 1;
      continue;
    }
    const conversionType = sourceCurrency === "RUR" ? "RUB_TO_CNY" : "CNY_TO_RUB";
    if (item.priceConversion?.type === conversionType && normalizeCurrency(item.currencyId) === targetCurrency) {
      skipped += 1;
      continue;
    }
    const sourceSalePrice = positiveNumber(item.salePrice ?? item.price);
    if (!sourceSalePrice) {
      skipped += 1;
      continue;
    }
    const sourceOriginalPrice = positiveNumber(item.originalPrice ?? item.discountPrice ?? item.discountBase);
    const convert = sourceCurrency === "RUR" ? (value) => roundMoney(value / rate) : (value) => roundMoney(value * rate);
    const targetSalePrice = convert(sourceSalePrice);
    item.salePrice = targetSalePrice;
    item.price = targetSalePrice;
    if (sourceOriginalPrice) {
      const targetOriginalPrice = convert(sourceOriginalPrice);
      item.originalPrice = targetOriginalPrice;
      item.discountPrice = targetOriginalPrice;
      item.discountBase = targetOriginalPrice;
    }
    item.updatedAt = now;
    item.priceConversion = {
      type: conversionType,
      cnyRateRub: rate,
      rateDate: String(rateDate || ""),
      sourceCurrencyId: sourceCurrency,
      targetCurrencyId: targetCurrency,
      sourceSalePrice,
      sourceOriginalPrice,
      convertedAt: now
    };
    converted += 1;
    convertedItems.push({
      id: item.id,
      sku: item.sku,
      sourceCurrencyId: sourceCurrency,
      targetCurrencyId: targetCurrency,
      sourceSalePrice,
      targetSalePrice,
      sourceOriginalPrice,
      targetOriginalPrice: item.originalPrice || null
    });
  }
  return { items, converted, skipped, convertedItems };
}

function convertRubPublishPricesToCny(items, { shopId, cnyRateRub, rateDate = "", now = new Date().toISOString() }) {
  const result = convertPublishPricesToCurrency(items, { shopId, targetCurrencyId: "CNY", cnyRateRub, rateDate, now });
  for (const item of result.items) {
    if (item.priceConversion?.type !== "RUB_TO_CNY") continue;
    item.priceConversion.salePriceRub = item.priceConversion.sourceSalePrice;
    item.priceConversion.originalPriceRub = item.priceConversion.sourceOriginalPrice;
  }
  return result;
}

module.exports = { convertPublishPricesToCurrency, convertRubPublishPricesToCny, roundMoney };
