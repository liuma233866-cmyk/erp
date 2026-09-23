function prepareCopyProductsWithCurrency(products, shops, normalizeCurrency) {
  const currencyFor = typeof normalizeCurrency === "function" ? normalizeCurrency : (value) => String(value || "").trim().toUpperCase();
  const shopCurrencyById = new Map((Array.isArray(shops) ? shops : []).map((shop) => [
    String(shop?.id || "").trim(),
    currencyFor(shop?.shopCurrency)
  ]));
  return (Array.isArray(products) ? products : []).map((product) => ({
    ...product,
    sourceCurrencyId: shopCurrencyById.get(String(product?.shopId || "").trim()) || currencyFor(product?.currencyId)
  }));
}

module.exports = { prepareCopyProductsWithCurrency };
