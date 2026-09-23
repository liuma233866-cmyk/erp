const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareCopyProductsWithCurrency } = require("./publish-copy-currency");

test("resolves source currency from the product's source shop", () => {
  const [product] = prepareCopyProductsWithCurrency(
    [{ id: "P-1", shopId: "SOURCE", currencyId: "RUR" }],
    [{ id: "SOURCE", shopCurrency: "CNY" }],
    (value) => String(value || "RUR").toUpperCase()
  );
  assert.equal(product.sourceCurrencyId, "CNY");
});
