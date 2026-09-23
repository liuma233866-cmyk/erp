// Unit tests for the Yandex card-quality persistence helpers.
//
// A recording fake pool stands in for MySQL so the SQL contract (which columns, which
// rows) is pinned without touching a database.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeStoredCard,
  readCardQualityTrend,
  readStoredCardQuality,
  saveCardQualitySnapshot,
  trimCardQualityHistory,
  upsertCardQualityHistory,
  upsertCardQualityLatest
} = require("./card-quality-store");

function createFakePool(handlers = {}) {
  const calls = [];
  return {
    calls,
    async execute(sql, params) {
      calls.push({ kind: "execute", sql, params });
      if (handlers.execute) return handlers.execute(sql, params, calls);
      return [[]];
    },
    async query(sql, params) {
      calls.push({ kind: "query", sql, params });
      if (handlers.query) return handlers.query(sql, params, calls);
      return [[]];
    }
  };
}

test("normalizeStoredCard maps a parsed offer onto the stored columns", () => {
  const card = normalizeStoredCard("SHP-1", { offerId: "SKU-1", cardStatus: "NO_CARD", rating: 42.5 }, {
    categoryAverageRating: 80,
    fetchedAt: "2026-09-16T10:00:00.000Z"
  });
  assert.equal(card.shopId, "SHP-1");
  assert.equal(card.offerId, "SKU-1");
  assert.equal(card.cardStatus, "NO_CARD");
  assert.equal(card.fillRate, 42.5);
  assert.equal(card.categoryAverageRating, 80);
  assert.deepEqual(card.payload, { offerId: "SKU-1", cardStatus: "NO_CARD", rating: 42.5 });
});

test("normalizeStoredCard keeps a 0 fill rate but reports a blank one as null", () => {
  assert.equal(normalizeStoredCard("S", { offerId: "A", rating: 0 }).fillRate, 0);
  assert.equal(normalizeStoredCard("S", { offerId: "A", rating: "" }).fillRate, null);
  assert.equal(normalizeStoredCard("S", { offerId: "A" }).fillRate, null);
});

test("upsertCardQualityLatest writes the snapshot and ignores a card without an offerId", async () => {
  const pool = createFakePool();
  const ok = await upsertCardQualityLatest(pool, normalizeStoredCard("S", { offerId: "SKU-1", rating: 10 }));
  assert.equal(ok, true);
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /INSERT INTO yandex_card_quality_latest/);
  assert.match(pool.calls[0].sql, /ON DUPLICATE KEY UPDATE/);
  assert.equal(pool.calls[0].params[0], "S");
  assert.equal(pool.calls[0].params[1], "SKU-1");

  const emptyPool = createFakePool();
  assert.equal(await upsertCardQualityLatest(emptyPool, normalizeStoredCard("S", {})), false);
  assert.equal(emptyPool.calls.length, 0);
});

test("upsertCardQualityHistory inserts once per day and updates on a repeat", async () => {
  const inserted = [];
  const insertPool = createFakePool({
    execute: async (sql, params) => {
      if (/SELECT id FROM yandex_card_quality_history/i.test(sql)) return [[]];
      inserted.push({ sql, params });
      return [{ affectedRows: 1 }];
    }
  });
  await upsertCardQualityHistory(
    insertPool,
    normalizeStoredCard("S", { offerId: "SKU-1", rating: 10 }, { fetchedAt: "2026-09-16T10:00:00.000Z" })
  );
  assert.equal(inserted.length, 1);
  assert.match(inserted[0].sql, /INSERT INTO yandex_card_quality_history/);
  assert.equal(inserted[0].params[2], "2026-09-16", "snapshotDate is the UTC day");

  const updated = [];
  const updatePool = createFakePool({
    execute: async (sql, params) => {
      if (/SELECT id FROM yandex_card_quality_history/i.test(sql)) return [[{ id: 7 }]];
      updated.push({ sql, params });
      return [{ affectedRows: 1 }];
    }
  });
  await upsertCardQualityHistory(
    updatePool,
    normalizeStoredCard("S", { offerId: "SKU-1", rating: 55 }, { fetchedAt: "2026-09-16T18:00:00.000Z" })
  );
  assert.equal(updated.length, 1);
  assert.match(updated[0].sql, /UPDATE yandex_card_quality_history/);
  assert.equal(updated[0].params[0], ""); // cardStatus
  assert.equal(updated[0].params[6], 7);  // WHERE id = ?
});

test("saveCardQualitySnapshot writes both tables for every offer", async () => {
  const pool = createFakePool({
    execute: async (sql) => (/SELECT id FROM yandex_card_quality_history/i.test(sql) ? [[]] : [{ affectedRows: 1 }])
  });
  const result = await saveCardQualitySnapshot(pool, {
    shopId: "S",
    categoryAverageRating: 77,
    cards: [{ offerId: "A", rating: 10 }, { offerId: "B", rating: 20 }, { offerId: "" }]
  });
  assert.equal(result.saved, 2, "the offer without an offerId is skipped");
  const latest = pool.calls.filter((call) => /INSERT INTO yandex_card_quality_latest/.test(call.sql));
  const history = pool.calls.filter((call) => /INSERT INTO yandex_card_quality_history/.test(call.sql));
  assert.equal(latest.length, 2);
  assert.equal(history.length, 2);
});

test("saveCardQualitySnapshot is a no-op without a pool, shop or cards", async () => {
  assert.deepEqual(await saveCardQualitySnapshot(null, { shopId: "S", cards: [{ offerId: "A" }] }), { saved: 0 });
  assert.deepEqual(await saveCardQualitySnapshot(createFakePool(), { shopId: "", cards: [{ offerId: "A" }] }), { saved: 0 });
  assert.deepEqual(await saveCardQualitySnapshot(createFakePool(), { shopId: "S", cards: [] }), { saved: 0 });
});

test("readStoredCardQuality returns null when the shop has no stored cards", async () => {
  const pool = createFakePool({ execute: async () => [[{ total: 0 }]] });
  assert.equal(await readStoredCardQuality(pool, "S"), null);
  assert.equal(await readStoredCardQuality(pool, ""), null);
});

test("readStoredCardQuality maps stored rows and reports the summary", async () => {
  const pool = createFakePool({
    execute: async (sql) => {
      if (/COUNT\(\*\) AS total/i.test(sql)) {
        return [[{ total: 2, averageRating: "72.5", categoryAverageRating: "80", fetchedAt: "2026-09-16T10:00:00.000Z" }]];
      }
      if (/COUNT\(\*\) AS below/i.test(sql)) return [[{ below: 1 }]];
      return [[
        { offerId: "A", cardStatus: "NO_CARD", fillRate: "45", payloadJson: JSON.stringify({ recommendations: [{ type: "HAS_VIDEO" }] }), fetchedAt: "2026-09-16T10:00:00.000Z" },
        { offerId: "B", cardStatus: "HAS_CARD_CAN_UPDATE", fillRate: null, payloadJson: "{not json", fetchedAt: null }
      ]];
    }
  });

  const stored = await readStoredCardQuality(pool, "S");
  assert.equal(stored.total, 2);
  assert.equal(stored.belowBenchmark, 1);
  assert.equal(stored.averageRating, 72.5);
  assert.equal(stored.categoryAverageRating, 80);
  assert.equal(stored.offers[0].rating, 45);
  assert.equal(stored.offers[0].recommendations[0].type, "HAS_VIDEO");
  assert.equal(stored.offers[1].rating, null, "a null fillRate stays null");
  assert.deepEqual(stored.offers[1].recommendations, [], "malformed payloadJson degrades to empty");
});

test("readStoredCardQuality clamps the page size and computes the page count", async () => {
  const pool = createFakePool({
    execute: async (sql) => {
      if (/COUNT\(\*\) AS total/i.test(sql)) return [[{ total: 1200 }]];
      if (/COUNT\(\*\) AS below/i.test(sql)) return [[{ below: 0 }]];
      return [[]];
    }
  });
  const stored = await readStoredCardQuality(pool, "S", { pageSize: 99999, page: 2 });
  assert.equal(stored.pageSize, 500);
  assert.equal(stored.totalPages, 3);
  assert.equal(stored.page, 2);
});

test("readCardQualityTrend returns the days oldest first", async () => {
  const pool = createFakePool({
    query: async () => [[
      { snapshotDate: "2026-09-16", cards: 10, averageRating: "70", categoryAverageRating: "80" },
      { snapshotDate: "2026-09-15", cards: 10, averageRating: "60", categoryAverageRating: "80" }
    ]]
  });
  const trend = await readCardQualityTrend(pool, "S");
  assert.deepEqual(trend.map((point) => point.snapshotDate), ["2026-09-15", "2026-09-16"]);
  assert.deepEqual(trend.map((point) => point.averageRating), [60, 70]);
});

test("trimCardQualityHistory deletes only rows older than the retained window", async () => {
  const pool = createFakePool({
    query: async (sql) => {
      if (/SELECT id FROM yandex_card_quality_history/i.test(sql)) return [[{ id: 42 }]];
      assert.match(sql, /DELETE FROM yandex_card_quality_history/);
      return [{ affectedRows: 3 }];
    }
  });
  assert.equal(await trimCardQualityHistory(pool, "S", 100), 3);
});

test("trimCardQualityHistory leaves history alone when it is under the limit", async () => {
  const pool = createFakePool({ query: async () => [[]] });
  assert.equal(await trimCardQualityHistory(pool, "S", 100), 0);
});
