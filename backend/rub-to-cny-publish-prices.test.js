const test = require("node:test");
const assert = require("node:assert/strict");
const { convertPublishPricesToCurrency, convertRubPublishPricesToCny } = require("./rub-to-cny-publish-prices");

test("does not convert prices when source and target currencies match", () => {
  const items = [{ id: "same", source: "yandex_online_product", shopId: "CNY-SHOP", sourceCurrencyId: "CNY", salePrice: 80 }];
  const result = convertPublishPricesToCurrency(items, { shopId: "CNY-SHOP", targetCurrencyId: "CNY", cnyRateRub: 12.5 });
  assert.equal(result.converted, 0);
  assert.equal(items[0].salePrice, 80);
  assert.equal(items[0].currencyId, "CNY");
});

test("converts CNY source prices to RUR target prices", () => {
  const items = [{ id: "reverse", source: "yandex_online_product", shopId: "RUR-SHOP", sourceCurrencyId: "CNY", salePrice: 80, originalPrice: 96 }];
  const result = convertPublishPricesToCurrency(items, { shopId: "RUR-SHOP", targetCurrencyId: "RUR", cnyRateRub: 12.5, rateDate: "2026-08-20", now: "now" });
  assert.equal(result.converted, 1);
  assert.equal(items[0].salePrice, 1000);
  assert.equal(items[0].originalPrice, 1200);
  assert.equal(items[0].currencyId, "RUR");
  assert.equal(items[0].priceConversion.type, "CNY_TO_RUB");
});

test("converts copied RUB prices to CNY for one target shop", () => {
  const items = [
    { id: "1", source: "yandex_online_product", shopId: "CNY-SHOP", sku: "A", salePrice: 1000, originalPrice: 1200 },
    { id: "2", source: "yandex_online_product", shopId: "OTHER", sku: "B", salePrice: 1000 }
  ];
  const result = convertRubPublishPricesToCny(items, { shopId: "CNY-SHOP", cnyRateRub: 12.5, rateDate: "2026-08-20", now: "now" });
  assert.equal(result.converted, 1);
  assert.equal(items[0].salePrice, 80);
  assert.equal(items[0].originalPrice, 96);
  assert.equal(items[0].currencyId, "CNY");
  assert.equal(items[0].priceConversion.salePriceRub, 1000);
  assert.equal(items[1].salePrice, 1000);
});

test("does not convert the same copied draft twice", () => {
  const items = [{ source: "yandex_online_product", shopId: "CNY-SHOP", salePrice: 80, priceConversion: { type: "RUB_TO_CNY" } }];
  const result = convertRubPublishPricesToCny(items, { shopId: "CNY-SHOP", cnyRateRub: 12.5 });
  assert.equal(result.converted, 0);
  assert.equal(result.skipped, 1);
  assert.equal(items[0].salePrice, 80);
});

test("writes converted values to sale and discount price aliases", () => {
  const items = [{
    id: "3", source: "yandex_online_product", shopId: "CNY-SHOP", sku: "C",
    price: 2500, discountPrice: 3750
  }];
  const result = convertRubPublishPricesToCny(items, { shopId: "CNY-SHOP", cnyRateRub: 12.5, now: "now" });
  assert.equal(result.converted, 1);
  assert.equal(items[0].salePrice, 200);
  assert.equal(items[0].price, 200);
  assert.equal(items[0].originalPrice, 300);
  assert.equal(items[0].discountPrice, 300);
  assert.equal(items[0].discountBase, 300);
});
