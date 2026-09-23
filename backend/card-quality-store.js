// Persistence for Yandex product-card quality.
//
// Two tables cooperate:
//   * yandex_card_quality_latest  — one row per shop+offer with the current state, so
//     the panel can render instantly without touching Yandex;
//   * yandex_card_quality_history — at most one snapshot per shop+offer+day, so fill
//     rate can be compared over time to prove the cards actually improved.
//
// Callers inject the MySQL pool; nothing here opens a connection or calls Yandex.

const MAX_HISTORY_ROWS_PER_SHOP = 5000;

function text(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function toDecimalOrNull(value) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toMysqlTime(value) {
  const date = value ? new Date(value) : new Date();
  const normalized = Number.isNaN(date.getTime()) ? new Date() : date;
  return normalized.toISOString().slice(0, 23).replace("T", " ");
}

function snapshotDateOf(value) {
  return toMysqlTime(value).slice(0, 10);
}

// Normalizes whatever the offer-cards parser produced into the stored column set.
function normalizeStoredCard(shopId, offer, extras = {}) {
  const source = offer && typeof offer === "object" ? offer : {};
  return {
    shopId: text(shopId),
    offerId: text(source.offerId),
    cardStatus: text(source.cardStatus),
    fillRate: toDecimalOrNull(source.rating),
    categoryAverageRating: toDecimalOrNull(extras.categoryAverageRating),
    payload: source,
    fetchedAt: extras.fetchedAt || new Date().toISOString()
  };
}

async function upsertCardQualityLatest(pool, card) {
  if (!pool || !card?.shopId || !card?.offerId) return false;
  const fetchedAt = toMysqlTime(card.fetchedAt);
  await pool.execute(
    `INSERT INTO yandex_card_quality_latest
       (shopId, offerId, cardStatus, fillRate, categoryAverageRating, payloadJson, fetchedAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       cardStatus=VALUES(cardStatus), fillRate=VALUES(fillRate),
       categoryAverageRating=VALUES(categoryAverageRating), payloadJson=VALUES(payloadJson),
       fetchedAt=VALUES(fetchedAt), updatedAt=VALUES(updatedAt)`,
    [
      card.shopId,
      card.offerId,
      card.cardStatus,
      card.fillRate,
      card.categoryAverageRating,
      JSON.stringify(card.payload || {}),
      fetchedAt,
      fetchedAt,
      fetchedAt
    ]
  );
  return true;
}

async function upsertCardQualityHistory(pool, card) {
  if (!pool || !card?.shopId || !card?.offerId) return false;
  const snapshotDate = snapshotDateOf(card.fetchedAt);
  const fetchedAt = toMysqlTime(card.fetchedAt);
  const [existing] = await pool.execute(
    "SELECT id FROM yandex_card_quality_history WHERE shopId = ? AND offerId = ? AND snapshotDate = ? LIMIT 1",
    [card.shopId, card.offerId, snapshotDate]
  );
  if (Array.isArray(existing) && existing.length) {
    await pool.execute(
      `UPDATE yandex_card_quality_history
         SET cardStatus = ?, fillRate = ?, categoryAverageRating = ?, payloadJson = ?, fetchedAt = ?, updatedAt = ?
       WHERE id = ?`,
      [
        card.cardStatus,
        card.fillRate,
        card.categoryAverageRating,
        JSON.stringify(card.payload || {}),
        fetchedAt,
        fetchedAt,
        existing[0].id
      ]
    );
    return true;
  }
  await pool.execute(
    `INSERT INTO yandex_card_quality_history
       (shopId, offerId, snapshotDate, cardStatus, fillRate, categoryAverageRating, payloadJson, fetchedAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      card.shopId,
      card.offerId,
      snapshotDate,
      card.cardStatus,
      card.fillRate,
      card.categoryAverageRating,
      JSON.stringify(card.payload || {}),
      fetchedAt,
      fetchedAt,
      fetchedAt
    ]
  );
  return true;
}

// Persists a whole lookup. Returns how many cards were written.
async function saveCardQualitySnapshot(pool, { shopId, cards, categoryAverageRating }) {
  const list = Array.isArray(cards) ? cards.filter((card) => text(card?.offerId)) : [];
  if (!pool || !text(shopId) || !list.length) return { saved: 0 };
  let saved = 0;
  for (const offer of list) {
    const card = normalizeStoredCard(shopId, offer, { categoryAverageRating });
    await upsertCardQualityLatest(pool, card);
    await upsertCardQualityHistory(pool, card);
    saved += 1;
  }
  return { saved };
}

// Keeps history bounded per shop by dropping the oldest snapshots first.
async function trimCardQualityHistory(pool, shopId, maxRows = MAX_HISTORY_ROWS_PER_SHOP) {
  if (!pool || !text(shopId)) return 0;
  const [rows] = await pool.query(
    "SELECT id FROM yandex_card_quality_history WHERE shopId = ? ORDER BY snapshotDate DESC, id DESC LIMIT 1 OFFSET ?",
    [text(shopId), Math.max(0, Number(maxRows) - 1)]
  );
  if (!Array.isArray(rows) || !rows.length) return 0;
  const cutoff = rows[0].id;
  const [result] = await pool.query("DELETE FROM yandex_card_quality_history WHERE shopId = ? AND id < ?", [
    text(shopId),
    cutoff
  ]);
  return Number(result?.affectedRows || 0);
}

function parsePayload(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function mapStoredCardRow(row) {
  const payload = parsePayload(row?.payloadJson);
  return {
    offerId: text(row?.offerId),
    cardStatus: text(row?.cardStatus),
    rating: toDecimalOrNull(row?.fillRate),
    recommendations: Array.isArray(payload.recommendations) ? payload.recommendations : [],
    errors: Array.isArray(payload.errors) ? payload.errors : [],
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    fetchedAt: row?.fetchedAt ? new Date(row.fetchedAt).toISOString() : ""
  };
}

// Reads stored card-quality rows for a batch of offerIds within one shop.
// Never calls Yandex; returns [] when nothing is stored.
async function readCardQualityByOffers(pool, shopId, offerIds) {
  const id = text(shopId);
  const ids = (Array.isArray(offerIds) ? offerIds : [])
    .map((value) => text(value))
    .filter(Boolean);
  if (!pool || !id || !ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const [rows] = await pool.execute(
    `SELECT offerId, cardStatus, fillRate, fetchedAt
       FROM yandex_card_quality_latest
      WHERE shopId = ? AND offerId IN (${placeholders})`,
    [id, ...ids]
  );
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    offerId: text(row?.offerId),
    cardStatus: text(row?.cardStatus),
    rating: toDecimalOrNull(row?.fillRate),
    fetchedAt: row?.fetchedAt ? new Date(row.fetchedAt).toISOString() : ""
  }));
}

// Reads the stored snapshot for a shop. Never calls Yandex.
async function readStoredCardQuality(pool, shopId, options = {}) {
  const id = text(shopId);
  if (!pool || !id) return null;

  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total,
            AVG(fillRate) AS averageRating,
            MAX(categoryAverageRating) AS categoryAverageRating,
            MAX(fetchedAt) AS fetchedAt
       FROM yandex_card_quality_latest WHERE shopId = ?`,
    [id]
  );
  const summary = Array.isArray(countRows) && countRows.length ? countRows[0] : {};
  const total = Number(summary.total || 0);
  if (!total) return null;

  const pageSize = Math.min(500, Math.max(1, Number(options.pageSize) || 500));
  const page = Math.max(1, Number(options.page) || 1);

  const [belowRows] = await pool.execute(
    `SELECT COUNT(*) AS below
       FROM yandex_card_quality_latest
      WHERE shopId = ? AND fillRate IS NOT NULL AND categoryAverageRating IS NOT NULL
        AND fillRate < categoryAverageRating`,
    [id]
  );

  const [rows] = await pool.execute(
    `SELECT offerId, cardStatus, fillRate, payloadJson, fetchedAt
       FROM yandex_card_quality_latest WHERE shopId = ?
      ORDER BY (fillRate IS NULL), fillRate ASC, offerId ASC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    [id]
  );

  const cards = (Array.isArray(rows) ? rows : []).map(mapStoredCardRow);
  const rated = cards.filter((card) => card.rating !== null);
  const averageRating = toDecimalOrNull(summary.averageRating);

  return {
    shopId: id,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    belowBenchmark: Number(belowRows?.[0]?.below || 0),
    averageRating: averageRating === null ? null : Number(averageRating.toFixed(1)),
    categoryAverageRating: toDecimalOrNull(summary.categoryAverageRating),
    fetchedAt: summary.fetchedAt ? new Date(summary.fetchedAt).toISOString() : "",
    offers: cards,
    ratingsOnPage: rated.length
  };
}

// Fill-rate trend for one shop: average per snapshot day.
async function readCardQualityTrend(pool, shopId, limitDays = 30) {
  const id = text(shopId);
  if (!pool || !id) return [];
  const days = Math.min(365, Math.max(1, Number(limitDays) || 30));
  const [rows] = await pool.query(
    `SELECT snapshotDate,
            COUNT(*) AS cards,
            AVG(fillRate) AS averageRating,
            MAX(categoryAverageRating) AS categoryAverageRating
       FROM yandex_card_quality_history
      WHERE shopId = ?
      GROUP BY snapshotDate
      ORDER BY snapshotDate DESC
      LIMIT ${days}`,
    [id]
  );
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      snapshotDate: text(row.snapshotDate),
      cards: Number(row.cards || 0),
      averageRating: toDecimalOrNull(row.averageRating),
      categoryAverageRating: toDecimalOrNull(row.categoryAverageRating)
    }))
    .reverse();
}

module.exports = {
  normalizeStoredCard,
  readCardQualityByOffers,
  readCardQualityTrend,
  readStoredCardQuality,
  saveCardQualitySnapshot,
  trimCardQualityHistory,
  upsertCardQualityHistory,
  upsertCardQualityLatest
};
