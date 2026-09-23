// Unit tests for the Yandex offer-cards content-status helpers.
//
// The response shape of POST /v2/businesses/{businessId}/offer-cards has several
// spellings across catalog versions, and the recommendations it returns are the
// whole point of the feature, so both the payload rules and the tolerant readers
// are pinned here.
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildOfferCardsPayload, normalizeRecommendations, parseOfferCardsResponse } = require("./yandex-card-quality");

test("buildOfferCardsPayload requests recommendations by default", () => {
  assert.deepEqual(buildOfferCardsPayload({ offerIds: ["SKU-1"] }), {
    withRecommendations: true,
    offerIds: ["SKU-1"]
  });
});

test("buildOfferCardsPayload trims, drops empties, and caps offerIds at 200", () => {
  const payload = buildOfferCardsPayload({ offerIds: ["  A  ", "", "   ", "B", null], withRecommendations: false });
  assert.deepEqual(payload.offerIds, ["A", "B"]);
  assert.equal(payload.withRecommendations, false);

  const many = buildOfferCardsPayload({ offerIds: Array.from({ length: 250 }, (_, i) => `SKU-${i}`) });
  assert.equal(many.offerIds.length, 200);
});

test("buildOfferCardsPayload never mixes offerIds with the other filters", () => {
  // The API rejects this combination, so offerIds must win.
  const payload = buildOfferCardsPayload({
    offerIds: ["A"],
    cardStatuses: ["HAS_CARD_CAN_NOT_UPDATE"],
    categoryIds: [10]
  });
  assert.deepEqual(payload, { withRecommendations: true, offerIds: ["A"] });
  assert.equal("cardStatuses" in payload, false);
  assert.equal("categoryIds" in payload, false);
});

test("buildOfferCardsPayload passes filters when no offerIds are given", () => {
  const payload = buildOfferCardsPayload({
    cardStatuses: ["HAS_CARD_CAN_NOT_UPDATE", ""],
    categoryIds: [10, "20", 0, "x", -5]
  });
  assert.deepEqual(payload, {
    withRecommendations: true,
    cardStatuses: ["HAS_CARD_CAN_NOT_UPDATE"],
    categoryIds: [10, 20]
  });
});

test("buildOfferCardsPayload returns only the flag when nothing is supplied", () => {
  assert.deepEqual(buildOfferCardsPayload({}), { withRecommendations: true });
  assert.deepEqual(buildOfferCardsPayload(), { withRecommendations: true });
});

test("parseOfferCardsResponse reads rating, status and the category benchmark", () => {
  const parsed = parseOfferCardsResponse({
    status: "OK",
    result: {
      categoryAverageRating: 85.5,
      offers: [
        {
          offerId: "SKU-1",
          cardStatus: "HAS_CARD_CAN_NOT_UPDATE",
          rating: 60,
          recommendations: [],
          errors: [],
          warnings: []
        },
        { offerId: "SKU-2", rating: 90 }
      ]
    }
  });

  assert.equal(parsed.categoryAverageRating, 85.5);
  assert.equal(parsed.offers.length, 2);
  assert.equal(parsed.offers[0].offerId, "SKU-1");
  assert.equal(parsed.offers[0].cardStatus, "HAS_CARD_CAN_NOT_UPDATE");
  assert.equal(parsed.offers[0].rating, 60);
  // Average is computed from the offers that actually reported a rating.
  assert.equal(parsed.averageRating, 75);
});

test("parseOfferCardsResponse surfaces recommendations with their field names", () => {
  const parsed = parseOfferCardsResponse({
    result: {
      offers: [
        {
          offerId: "SKU-1",
          rating: 40,
          recommendations: [
            { type: "HAS_VIDEO", description: "Добавьте видео", fieldNames: ["видео"] },
            "Заполните описание",
            { description: "Добавьте видео", type: "HAS_VIDEO", fieldNames: ["видео"] },
            null
          ]
        }
      ]
    }
  });

  const recommendations = parsed.offers[0].recommendations;
  assert.equal(recommendations.length, 2, "duplicates and nulls are dropped");
  assert.deepEqual(recommendations[0], {
    type: "HAS_VIDEO",
    description: "Добавьте видео",
    fieldNames: ["видео"]
  });
  assert.deepEqual(recommendations[1], { type: "", description: "Заполните описание", fieldNames: [] });
});

test("normalizeRecommendations maps alt spellings and drops empty entries", () => {
  const normalized = normalizeRecommendations([
    { recommendationType: "HAS_DESCRIPTION", message: "Add a description", parameterNames: ["Описание"] },
    { code: "HAS_PHOTO", title: "Add photos" },
    {},
    "plain text"
  ]);
  assert.equal(normalized.length, 3);
  assert.equal(normalized[0].type, "HAS_DESCRIPTION");
  assert.equal(normalized[0].description, "Add a description");
  assert.deepEqual(normalized[0].fieldNames, ["Описание"]);
  assert.equal(normalized[1].type, "HAS_PHOTO");
  assert.equal(normalized[2].description, "plain text");
});

test("parseOfferCardsResponse collects errors and warnings in both shapes", () => {
  const parsed = parseOfferCardsResponse({
    result: {
      offers: [
        {
          offerId: "SKU-1",
          rating: 10,
          errors: [{ code: "BAD_VALUE", message: "Некорректное значение" }, "plain error", {}],
          warnings: [{ message: "Рекомендуем заполнить" }]
        }
      ]
    }
  });

  const offer = parsed.offers[0];
  assert.deepEqual(offer.errors, [
    { code: "BAD_VALUE", message: "Некорректное значение" },
    "plain error"
  ]);
  assert.deepEqual(offer.warnings, [{ code: "", message: "Рекомендуем заполнить" }]);
});

test("parseOfferCardsResponse tolerates a missing or unexpected payload", () => {
  for (const payload of [undefined, null, {}, { result: {} }, { result: { offers: null } }, "boom", 42]) {
    const parsed = parseOfferCardsResponse(payload);
    assert.deepEqual(parsed.offers, [], `offers must be empty for ${JSON.stringify(payload)}`);
    assert.equal(parsed.categoryAverageRating, null);
    assert.equal(parsed.averageRating, null);
    assert.equal(parsed.hasNextPage, false);
  }
});

test("parseOfferCardsResponse keeps a rating of 0 instead of treating it as missing", () => {
  const parsed = parseOfferCardsResponse({ result: { offers: [{ offerId: "SKU-1", rating: 0 }] } });
  assert.equal(parsed.offers[0].rating, 0);
  assert.equal(parsed.averageRating, 0);
});

test("parseOfferCardsResponse reports an empty rating as null, not zero", () => {
  const parsed = parseOfferCardsResponse({ result: { offers: [{ offerId: "SKU-1", rating: "" }, { offerId: "SKU-2" }] } });
  assert.equal(parsed.offers[0].rating, null);
  assert.equal(parsed.offers[1].rating, null);
  assert.equal(parsed.averageRating, null);
});

test("parseOfferCardsResponse exposes the pagination token", () => {
  const parsed = parseOfferCardsResponse({ result: { offers: [], nextPageToken: "tok-1" } });
  assert.equal(parsed.nextPageToken, "tok-1");
  assert.equal(parsed.hasNextPage, true);
  const nested = parseOfferCardsResponse({ result: { offers: [], paging: { nextPageToken: "tok-2" } } });
  assert.equal(nested.nextPageToken, "tok-2");
  assert.equal(nested.hasNextPage, true);
});

test("parseOfferCardsResponse also accepts offerCards and cards containers", () => {
  for (const key of ["offerCards", "cards"]) {
    const parsed = parseOfferCardsResponse({ result: { [key]: [{ offerId: "SKU-1", rating: 55 }] } });
    assert.equal(parsed.offers.length, 1, `${key} must be recognised`);
    assert.equal(parsed.offers[0].rating, 55);
  }
});
