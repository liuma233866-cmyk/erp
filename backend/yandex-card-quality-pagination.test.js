// Unit tests for the Yandex offer-cards pagination helper.
//
// The whole-shop pull walks `nextPageToken`, so the walk must terminate on a broken
// or repeating token, dedupe offers, and still hand back what it collected when a
// later page fails.
const test = require("node:test");
const assert = require("node:assert/strict");

const { fetchAllOfferCards } = require("./yandex-card-quality");

function page(offers, nextPageToken = "", extra = {}) {
  return {
    ok: true,
    offers,
    categoryAverageRating: extra.categoryAverageRating ?? null,
    averageRating: extra.averageRating ?? null,
    nextPageToken,
    hasNextPage: Boolean(nextPageToken)
  };
}

test("walks every page until the token runs out", async () => {
  const seenTokens = [];
  const result = await fetchAllOfferCards(async (pageToken) => {
    seenTokens.push(pageToken);
    if (!pageToken) return page([{ offerId: "A", rating: 10 }], "t1");
    if (pageToken === "t1") return page([{ offerId: "B", rating: 20 }], "t2");
    return page([{ offerId: "C", rating: 30 }]);
  });

  assert.equal(result.ok, true);
  assert.deepEqual(seenTokens, ["", "t1", "t2"]);
  assert.deepEqual(result.offers.map((offer) => offer.offerId), ["A", "B", "C"]);
  assert.equal(result.pages, 3);
  assert.equal(result.truncated, false);
});

test("keeps the first reported category benchmark and average", async () => {
  const result = await fetchAllOfferCards(async (pageToken) =>
    pageToken
      ? page([{ offerId: "B" }], "", { categoryAverageRating: 99, averageRating: 99 })
      : page([{ offerId: "A" }], "t1", { categoryAverageRating: 82.5, averageRating: 60 })
  );
  assert.equal(result.categoryAverageRating, 82.5);
  assert.equal(result.averageRating, 60);
});

test("stops when a page repeats the same token instead of looping forever", async () => {
  let calls = 0;
  const result = await fetchAllOfferCards(async () => {
    calls += 1;
    // Always claims there is another page, with the same token every time.
    return page([{ offerId: `SKU-${calls}` }], "stuck");
  });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.ok(calls <= 3, `expected the walk to bail out, made ${calls} calls`);
});

test("ignores an unknown pageToken shape but still honours hasNextPage", async () => {
  const result = await fetchAllOfferCards(async (pageToken) =>
    pageToken ? page([{ offerId: "B" }], "") : page([{ offerId: "A" }], "next")
  );
  assert.equal(result.offers.length, 2);
  assert.equal(result.truncated, false);
});

test("dedupes an offer that appears on more than one page", async () => {
  const result = await fetchAllOfferCards(async (pageToken) =>
    pageToken ? page([{ offerId: "A", rating: 20 }, { offerId: "B" }]) : page([{ offerId: "A", rating: 10 }], "t1")
  );
  assert.deepEqual(result.offers.map((offer) => offer.offerId), ["A", "B"]);
});

test("respects maxPages and marks the result truncated", async () => {
  let calls = 0;
  const result = await fetchAllOfferCards(
    async () => {
      calls += 1;
      return page([{ offerId: `SKU-${calls}` }], `t${calls}`);
    },
    { maxPages: 2 }
  );
  assert.equal(calls, 2);
  assert.equal(result.pages, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.offers.length, 2);
});

test("a first-page failure is reported as a failure", async () => {
  const result = await fetchAllOfferCards(async () => ({ ok: false, message: "HTTP 403" }));
  assert.equal(result.ok, false);
  assert.equal(result.message, "HTTP 403");
});

test("a later-page failure keeps the pages already collected", async () => {
  const result = await fetchAllOfferCards(async (pageToken) =>
    pageToken ? { ok: false, message: "HTTP 500" } : page([{ offerId: "A" }], "t1")
  );
  assert.equal(result.ok, true);
  assert.equal(result.partialError, "HTTP 500");
  assert.equal(result.truncated, true);
  assert.deepEqual(result.offers.map((offer) => offer.offerId), ["A"]);
});

test("a single page with no token finishes cleanly", async () => {
  const result = await fetchAllOfferCards(async () => page([{ offerId: "A" }]));
  assert.equal(result.ok, true);
  assert.equal(result.pages, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.partialError, "");
});
