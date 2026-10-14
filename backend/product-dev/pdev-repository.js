"use strict";

// 产品开发库（product-dev）MySQL 读写层。
//
// 调用面按契约 §10.2（v1.2 冻结）：
//   findProductByPublicId(companyKey, publicId) / listProducts({companyKey,devStatus,q,limit,offset}) /
//   countProducts({companyKey,devStatus,q}) / countsByProductIds(companyKey, productIds) /
//   createProduct(record) / updateProduct(id, patch) / deleteProduct(id) /
//   listSources(productId) / findSourceByBusinessKey(companyKey, platform, sourceProductId) /
//   findSourceById(id) / createSource(record) / updateSource(id, patch) / deleteSource(id) /
//   listAssets(productId) / findAssetById(id) / createAsset(record) / deleteAsset(id) /
//   listVariants(productId) / findVariantByKey(productId, variantKey) / createVariant(record) /
//   runInTransaction(work)
// 之上允许增加额外方法（ensureTables / countProducts / countMainAssets / countVariants /
// getRequirementStats / getSummaryCounts / findProductById 等）。
//
// 约定：
// - 子表方法按冻结签名只收 id/productId，租户一致性由 service 通过"先校验父产品归属本公司"保证（§9.5）；
// - 为兼容带 companyKey 的调用，所有子表方法额外容忍一个前置 companyKey 参数；
// - 返回给上层的行对象**不含 company_key**，键集与契约 §5.1 完全一致；
// - 时间统一 UTC 字符串 "YYYY-MM-DD HH:mm:ss.SSS"（连接池未开 dateStrings，读到的是 Date，需格式化）。

const { toMysqlDatetime } = require("../../backend-v2/core/dateTime");
const { ensurePdevTables } = require("./pdev-schema");
// §11.5：missing 判定唯一真源在 service（与 §4 硬校验同一个函数），仓储只借用它给列表项补 missing。
const { deriveMissingTokens } = require("./pdev-service");

const PRODUCT_BASE_COLUMNS = [
  "p.id",
  "p.public_id",
  "p.title",
  "p.remark",
  "p.category_hint",
  "p.target_platform",
  "p.purchase_price",
  "p.purchase_url",
  "p.reference_url",
  "p.is_bundle",
  "p.system_category",
  "p.pack_form",
  "p.pack_outer",
  "p.pack_cushion",
  "p.pack_reinforce",
  "p.sample_pack_size",
  "p.sample_pack_weight",
  "p.base_pack_size_cm",
  "p.base_pack_weight_kg",
  "p.base_pack_size_inch",
  "p.base_pack_weight_lb",
  "p.base_pack_volume_m3",
  "p.item_size_cm",
  "p.item_net_weight_kg",
  "p.carton_size_cm",
  "p.carton_weight_kg",
  "p.carton_volume_m3",
  "p.carton_pcs",
  "p.base_unit",
  "p.carton_layers",
  "p.carton_inner_gsm",
  "p.carton_outer_gsm",
  "p.labor_cost",
  "p.carton_price",
  "p.goods_status",
  "p.sales_status",
  "p.source_status",
  "p.dev_status",
  "p.owner_user_id",
  "p.created_by",
  "p.created_at",
  "p.updated_at",
  "p.row_version"
].join(", ");

// 每个子查询都按 pdev_product_id 聚合，最多一行，不会放大主表行数。
const PRODUCT_SUMMARY_JOINS = `
  LEFT JOIN (
    SELECT pdev_product_id,
           COUNT(*) AS source_count,
           SUM(CASE WHEN supply_status = 'active' AND supply_price IS NOT NULL THEN 1 ELSE 0 END) AS active_source_count
      FROM pdev_sources
     GROUP BY pdev_product_id
  ) src_agg ON src_agg.pdev_product_id = p.id
  LEFT JOIN (
    SELECT pdev_product_id,
           COUNT(*) AS asset_count,
           SUM(CASE WHEN asset_type = 'main' THEN 1 ELSE 0 END) AS main_asset_count
      FROM pdev_assets
     GROUP BY pdev_product_id
  ) ast_agg ON ast_agg.pdev_product_id = p.id
  LEFT JOIN (
    SELECT pdev_product_id, COUNT(*) AS variant_count
      FROM pdev_variants
     GROUP BY pdev_product_id
  ) var_agg ON var_agg.pdev_product_id = p.id`;

const PRODUCT_SUMMARY_COLUMNS = `${PRODUCT_BASE_COLUMNS},
  COALESCE(src_agg.source_count, 0) AS source_count,
  COALESCE(src_agg.active_source_count, 0) AS active_source_count,
  COALESCE(ast_agg.asset_count, 0) AS asset_count,
  COALESCE(var_agg.variant_count, 0) AS variant_count,
  COALESCE(ast_agg.main_asset_count, 0) AS main_asset_count,
  (SELECT u.username FROM users u WHERE u.id COLLATE utf8mb4_unicode_ci = p.created_by) AS created_by_name,
  (SELECT a.actorUsername FROM audit_logs a WHERE a.resourceType = 'product_dev' AND a.actionType <> 'read' AND a.resourceId COLLATE utf8mb4_unicode_ci = p.public_id ORDER BY a.tsDt DESC, a.id DESC LIMIT 1) AS updated_by_name,
  (SELECT a.source_url FROM pdev_assets a WHERE a.pdev_product_id = p.id AND a.asset_type IN ('m','main') ORDER BY a.sort_no ASC, a.id ASC LIMIT 1) AS main_asset_url`;

// §11.2：missing 过滤必须在 SQL 完成（AND 语义）。谓词与 deriveMissingTokens 一一对应：
// noActivePrice 只在"有货源但没有 active+价格的货源"时成立，与 §10.3-3 noSource 优先的口径一致。
const MISSING_SQL_PREDICATES = Object.freeze({
  noSource: "COALESCE(src_agg.source_count, 0) = 0",
  noActivePrice: "(COALESCE(src_agg.source_count, 0) > 0 AND COALESCE(src_agg.active_source_count, 0) = 0)",
  noMainAsset: "COALESCE(ast_agg.main_asset_count, 0) = 0",
  noVariant: "COALESCE(var_agg.variant_count, 0) = 0"
});

const PRODUCT_PATCH_COLUMNS = Object.freeze({
  title: "title",
  remark: "remark",
  categoryHint: "category_hint",
  targetPlatform: "target_platform",
  goodsStatus: "goods_status",
  salesStatus: "sales_status",
  sourceStatus: "source_status",
  purchasePrice: "purchase_price",
  purchaseUrl: "purchase_url",
  referenceUrl: "reference_url",
  isBundle: "is_bundle",
    packForm: "pack_form",
    packOuter: "pack_outer",
    packCushion: "pack_cushion",
    packReinforce: "pack_reinforce",
    samplePackSize: "sample_pack_size",
    samplePackWeight: "sample_pack_weight",
    basePackSizeCm: "base_pack_size_cm",
    basePackWeightKg: "base_pack_weight_kg",
    basePackSizeInch: "base_pack_size_inch",
    basePackWeightLb: "base_pack_weight_lb",
    basePackVolumeM3: "base_pack_volume_m3",
    itemSizeCm: "item_size_cm",
    itemNetWeightKg: "item_net_weight_kg",
    cartonSizeCm: "carton_size_cm",
    cartonWeightKg: "carton_weight_kg",
    cartonVolumeM3: "carton_volume_m3",
    cartonPcs: "carton_pcs",
    baseUnit: "base_unit",
    cartonLayers: "carton_layers",
    cartonInnerGsm: "carton_inner_gsm",
    cartonOuterGsm: "carton_outer_gsm",
    laborCost: "labor_cost",
    cartonPrice: "carton_price",
  systemCategory: "system_category",
  devStatus: "dev_status",
  ownerUserId: "owner_user_id",
  createdBy: "created_by"
});

const SOURCE_PATCH_COLUMNS = Object.freeze({
  sourceUrl: "source_url",
  supplyPrice: "supply_price",
  supplyCurrency: "supply_currency",
  moq: "moq",
  supplierName: "supplier_name",
  supplyStatus: "supply_status",
  note: "note"
});

const DEV_STATUS_KEYS = Object.freeze(["new", "developing", "info_ready", "finalized", "archived"]);
const CHILD_TABLES = Object.freeze(["pdev_sources", "pdev_assets", "pdev_variants"]);

function hasOwn(target, key) {
  return Boolean(target) && Object.prototype.hasOwnProperty.call(target, key);
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullableString(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

function toPublicString(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

// DATETIME(3) → "YYYY-MM-DD HH:mm:ss.SSS"（UTC）
function toUtcMysqlText(value) {
  if (value === null || value === undefined || value === "") return "";
  try {
    return toMysqlDatetime(value);
  } catch {
    return String(value);
  }
}

function parseSpecColumn(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

function clampInteger(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// 兼容 mysql2 连接池与事务连接；测试 stub 只有 query() 也能用。
function runQuery(executor, sql, params) {
  if (typeof executor.execute === "function") return executor.execute(sql, params);
  return executor.query(sql, params);
}

function mapProductRow(row) {
  return {
    id: toNumber(row?.id),
    publicId: toPublicString(row?.public_id),
    title: toPublicString(row?.title),
    remark: toPublicString(row?.remark),
    categoryHint: toPublicString(row?.category_hint),
    targetPlatform: toPublicString(row?.target_platform),
  goodsStatus: toPublicString(row?.goods_status),
  salesStatus: toPublicString(row?.sales_status),
  sourceStatus: toPublicString(row?.source_status),
    purchasePrice: row?.purchase_price === null || row?.purchase_price === undefined ? null : toNumber(row.purchase_price),
    purchaseUrl: toPublicString(row?.purchase_url),
    referenceUrl: toPublicString(row?.reference_url),
    isBundle: toPublicString(row?.is_bundle),
    systemCategory: toPublicString(row?.system_category),
    devStatus: toPublicString(row?.dev_status),
    ownerUserId: toPublicString(row?.owner_user_id),
    createdBy: toPublicString(row?.created_by),
    createdByName: toPublicString(row?.created_by_name),
    updatedByName: toPublicString(row?.updated_by_name),
    mainAssetUrl: toPublicString(row?.main_asset_url),
    createdAt: toUtcMysqlText(row?.created_at),
    updatedAt: toUtcMysqlText(row?.updated_at),
    rowVersion: toNumber(row?.row_version),
    sourceCount: toNumber(row?.source_count),
    activeSourceCount: toNumber(row?.active_source_count),
    assetCount: toNumber(row?.asset_count),
    packForm: toPublicString(row?.pack_form),
    packOuter: toPublicString(row?.pack_outer),
    packCushion: toPublicString(row?.pack_cushion),
    packReinforce: toPublicString(row?.pack_reinforce),
    samplePackSize: toPublicString(row?.sample_pack_size),
    samplePackWeight: toNullableNumber(row?.sample_pack_weight),
    basePackSizeCm: toPublicString(row?.base_pack_size_cm),
    basePackWeightKg: toNullableNumber(row?.base_pack_weight_kg),
    basePackSizeInch: toPublicString(row?.base_pack_size_inch),
    basePackWeightLb: toNullableNumber(row?.base_pack_weight_lb),
    basePackVolumeM3: toNullableNumber(row?.base_pack_volume_m3),
    itemSizeCm: toPublicString(row?.item_size_cm),
    itemNetWeightKg: toNullableNumber(row?.item_net_weight_kg),
    cartonSizeCm: toPublicString(row?.carton_size_cm),
    cartonWeightKg: toNullableNumber(row?.carton_weight_kg),
    cartonVolumeM3: toNullableNumber(row?.carton_volume_m3),
    cartonPcs: toNullableNumber(row?.carton_pcs),
    baseUnit: toPublicString(row?.base_unit),
    cartonLayers: toNullableNumber(row?.carton_layers),
    cartonInnerGsm: toNullableNumber(row?.carton_inner_gsm),
    cartonOuterGsm: toNullableNumber(row?.carton_outer_gsm),
    laborCost: toNullableNumber(row?.labor_cost),
    cartonPrice: toNullableNumber(row?.carton_price),
    variantCount: toNumber(row?.variant_count)
  };
}

function mapSourceRow(row) {
  return {
    id: toNumber(row?.id),
    pdevProductId: toNumber(row?.pdev_product_id),
    platform: toPublicString(row?.platform),
    sourceProductId: toPublicString(row?.source_product_id),
    sourceUrl: toPublicString(row?.source_url),
    supplyPrice: toNullableNumber(row?.supply_price),
    supplyCurrency: toPublicString(row?.supply_currency),
    moq: row?.moq === null || row?.moq === undefined ? null : toNumber(row.moq),
    supplierName: toPublicString(row?.supplier_name),
    supplyStatus: toPublicString(row?.supply_status),
    note: toPublicString(row?.note),
    createdAt: toUtcMysqlText(row?.created_at),
    updatedAt: toUtcMysqlText(row?.updated_at)
  };
}

function mapAssetRow(row) {
  return {
    id: toNumber(row?.id),
    pdevProductId: toNumber(row?.pdev_product_id),
    assetType: toPublicString(row?.asset_type),
    sourceUrl: toPublicString(row?.source_url),
    storageUrl: toPublicString(row?.storage_url),
    sortNo: toNumber(row?.sort_no),
    checksum: row?.checksum === null || row?.checksum === undefined ? null : String(row.checksum),
    status: toPublicString(row?.status),
    createdAt: toUtcMysqlText(row?.created_at),
    updatedAt: toUtcMysqlText(row?.updated_at)
  };
}

function mapVariantRow(row) {
  return {
    id: toNumber(row?.id),
    pdevProductId: toNumber(row?.pdev_product_id),
    variantKey: toPublicString(row?.variant_key),
    spec: parseSpecColumn(row?.spec_json),
    supplyPrice: toNullableNumber(row?.supply_price),
    weightKg: toNullableNumber(row?.weight_kg),
    packageLengthCm: toNullableNumber(row?.package_length_cm),
    packageWidthCm: toNullableNumber(row?.package_width_cm),
    packageHeightCm: toNullableNumber(row?.package_height_cm),
    status: toPublicString(row?.status),
    createdAt: toUtcMysqlText(row?.created_at),
    updatedAt: toUtcMysqlText(row?.updated_at)
  };
}

function buildProductFilter(filters = {}) {
  const where = [];
  const params = [];
  if (filters.companyKey !== undefined && filters.companyKey !== null) {
    where.push("p.company_key = ?");
    params.push(String(filters.companyKey));
  }
  if (filters.devStatus) {
    where.push("p.dev_status = ?");
    params.push(String(filters.devStatus));
  }
  if (filters.q) {
    where.push("p.title LIKE ?");
    params.push(`%${escapeLike(filters.q)}%`);
  }
  // §11.2：missing 过滤（逗号分隔多值 → AND）。谓词引用聚合别名，需要带上 JOIN。
  let needsJoins = false;
  const missingTokens = []; // 缺口筛选已下线（保留此变量：needsJoins 逻辑一行未动）
  for (const token of missingTokens) {
    const predicate = MISSING_SQL_PREDICATES[token];
    if (!predicate) continue;
    where.push(predicate);
    needsJoins = true;
  }
  return { whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "", params, needsJoins };
}

// 子表方法：冻结签名是 (id) / (productId)，同时容忍前置 companyKey。
function splitIdArgs(first, second) {
  if (second === undefined) return { companyKey: null, id: toNumber(first) };
  return { companyKey: first === undefined ? null : first, id: toNumber(second) };
}

class MysqlPdevRepository {
  // createPdevRepository({ getPool }) —— getPool() 惰性返回现有 sqlPool。
  // 也兼容 { pool }（server.js 之外的单测直接给池）。
  constructor(deps = {}) {
    const directPool = deps.pool || deps.sqlPool || null;
    const getPool = typeof deps.getPool === "function" ? deps.getPool : null;
    this.getPool = getPool || (() => directPool);
    this.ensurePromise = null;
  }

  async resolvePool() {
    const pool = this.getPool();
    if (!pool || typeof pool.query !== "function") {
      const error = new Error("MySQL is not ready");
      error.statusCode = 503;
      error.code = "DB_NOT_READY";
      throw error;
    }
    return pool;
  }

  // 幂等建表，每个实例只跑一次；service 每次操作前会 await 它（stub 无此方法时跳过）。
  async ensureTables() {
    if (!this.ensurePromise) {
      this.ensurePromise = (async () => {
        const pool = await this.resolvePool();
        await ensurePdevTables(pool);
      })().catch((error) => {
        this.ensurePromise = null;
        throw error;
      });
    }
    return this.ensurePromise;
  }

  async runInTransaction(work) {
    const pool = await this.resolvePool();
    if (typeof pool.getConnection !== "function") {
      return work(pool);
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        /* ignore rollback failure */
      }
      throw error;
    } finally {
      try {
        connection.release();
      } catch {
        /* ignore release failure */
      }
    }
  }

  // ---------- pdev_products ----------

  async listProducts(filters = {}) {
    const pool = await this.resolvePool();
    const { whereSql, params, needsJoins } = buildProductFilter(filters || {});
    const limit = clampInteger(filters?.limit, 20, 1, 500);
    const offset = Math.max(0, Math.trunc(toNumber(filters?.offset, 0)));
    const [rows] = await runQuery(
      pool,
      `SELECT ${PRODUCT_SUMMARY_COLUMNS}
         FROM pdev_products p
         ${PRODUCT_SUMMARY_JOINS}
         ${whereSql}
        ORDER BY p.updated_at DESC, p.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const [countRows] = await runQuery(
      pool,
      `SELECT COUNT(*) AS total FROM pdev_products p ${needsJoins ? PRODUCT_SUMMARY_JOINS : ""} ${whereSql}`,
      params
    );
    return {
      // §11.1：ProductSummary = §5.1 键集 + missing（顺序由 deriveMissingTokens 固定）
      items: (Array.isArray(rows) ? rows : []).map((row) => {
        const item = mapProductRow(row);
      return item;
      }),
      total: toNumber(countRows?.[0]?.total)
    };
  }

  async countProducts(filtersOrCompanyKey = {}, maybeFilters) {
    const filters = typeof filtersOrCompanyKey === "string"
      ? { ...(maybeFilters || {}), companyKey: filtersOrCompanyKey }
      : (filtersOrCompanyKey || {});
    const pool = await this.resolvePool();
    const { whereSql, params, needsJoins } = buildProductFilter(filters);
    const [rows] = await runQuery(
      pool,
      `SELECT COUNT(*) AS total FROM pdev_products p ${needsJoins ? PRODUCT_SUMMARY_JOINS : ""} ${whereSql}`,
      params
    );
    return toNumber(rows?.[0]?.total);
  }

  // 返回 { [productId]: { sourceCount, activeSourceCount, assetCount, variantCount } }
  async countsByProductIds(companyKey, productIds) {
    const ids = (Array.isArray(productIds) ? productIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    const result = {};
    for (const id of ids) {
      result[String(id)] = { sourceCount: 0, activeSourceCount: 0, assetCount: 0, variantCount: 0 };
    }
    if (!ids.length) return result;
    const pool = await this.resolvePool();
    const placeholders = ids.map(() => "?").join(", ");
    const [rows] = await runQuery(
      pool,
      `SELECT p.id AS product_id,
              COALESCE(src_agg.source_count, 0) AS source_count,
              COALESCE(src_agg.active_source_count, 0) AS active_source_count,
              COALESCE(ast_agg.asset_count, 0) AS asset_count,
              COALESCE(var_agg.variant_count, 0) AS variant_count
         FROM pdev_products p
         ${PRODUCT_SUMMARY_JOINS}
        WHERE p.company_key = ? AND p.id IN (${placeholders})`,
      [String(companyKey), ...ids]
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      result[String(toNumber(row.product_id))] = {
        sourceCount: toNumber(row.source_count),
        activeSourceCount: toNumber(row.active_source_count),
        assetCount: toNumber(row.asset_count),
        variantCount: toNumber(row.variant_count)
      };
    }
    return result;
  }

  async findProductByPublicId(companyKey, publicId) {
    const pool = await this.resolvePool();
    const [rows] = await runQuery(
      pool,
      `SELECT ${PRODUCT_SUMMARY_COLUMNS}
         FROM pdev_products p
         ${PRODUCT_SUMMARY_JOINS}
        WHERE p.company_key = ? AND p.public_id = ?
        LIMIT 1`,
      [String(companyKey), String(publicId ?? "")]
    );
    return Array.isArray(rows) && rows.length ? mapProductRow(rows[0]) : null;
  }

  // 额外方法（不在冻结名单内，service 校验租户归属用）。
  // findProductById(id) 也兼容（单参时不加 company_key 过滤）。
  async findProductById(idOrCompanyKey, maybeId) {
    const hasCompanyKey = maybeId !== undefined;
    const companyKey = hasCompanyKey ? idOrCompanyKey : null;
    const productId = Number(hasCompanyKey ? maybeId : idOrCompanyKey);
    if (!Number.isFinite(productId) || productId <= 0) return null;
    const pool = await this.resolvePool();
    const params = [productId];
    let sql = `SELECT ${PRODUCT_SUMMARY_COLUMNS}
                 FROM pdev_products p
                 ${PRODUCT_SUMMARY_JOINS}
                WHERE p.id = ?`;
    if (companyKey !== undefined && companyKey !== null) {
      sql += " AND p.company_key = ?";
      params.push(String(companyKey));
    }
    sql += " LIMIT 1";
    const [rows] = await runQuery(pool, sql, params);
    return Array.isArray(rows) && rows.length ? mapProductRow(rows[0]) : null;
  }

  // createProduct(record)：record 含 companyKey / publicId / title / ...（也容忍旧的 (companyKey, record) 形式）
  async createProduct(record = {}, maybeRecord) {
    const data = typeof record === "string" ? { ...(maybeRecord || {}), companyKey: record } : (record || {});
    const pool = await this.resolvePool();
    const now = toMysqlDatetime(new Date());
    const [insertResult] = await runQuery(
      pool,
      `INSERT INTO pdev_products
         (public_id, company_key, title, remark, category_hint, target_platform, goods_status, sales_status, source_status, purchase_price, purchase_url, reference_url, is_bundle, system_category, dev_status, owner_user_id, created_by, created_at, updated_at, row_version)
       VALUES (?, ?, ?, ?, ?, ?,?,?,?,?,?,?,?,?, ?, ?, ?, ?, ?, 0)`,
      [
        String(data.publicId ?? ""),
        String(data.companyKey ?? ""),
        String(data.title ?? ""),
        toNullableString(data.remark),
        toNullableString(data.categoryHint),
        toNullableString(data.targetPlatform),
        toNullableString(data.goodsStatus),
        toNullableString(data.salesStatus),
        toNullableString(data.sourceStatus),
    data.purchasePrice === undefined || data.purchasePrice === null || data.purchasePrice === "" ? null : Number(data.purchasePrice),
    toNullableString(data.purchaseUrl),
    toNullableString(data.referenceUrl),
    toNullableString(data.isBundle),
    toNullableString(data.systemCategory),
        String(data.devStatus || "new"),
        toNullableString(data.ownerUserId),
        toNullableString(data.createdBy),
        now,
        now
      ]
    );
    return this.findProductById(null, toNumber(insertResult?.insertId));
  }

  // updateProduct(id, patch)：row_version + 1，WHERE 里校验旧版本；patch.expectedRowVersion 为版本前置条件。
  // 返回 { ok:true, product } | { ok:false, reason:"not_found" } | { ok:false, reason:"version_conflict", product }。
  async updateProduct(companyKeyOrId, idOrPatch, maybePatch, maybeOptions) {
    let companyKey = null;
    let id = companyKeyOrId;
    let patch = idOrPatch;
    let expectedRowVersion = maybeOptions && typeof maybeOptions === "object" ? maybeOptions.expectedRowVersion : undefined;

    if (companyKeyOrId && typeof companyKeyOrId === "object") {
      const options = companyKeyOrId;
      companyKey = options.companyKey === undefined ? null : options.companyKey;
      id = options.id;
      patch = options.patch;
      if (options.expectedRowVersion !== undefined) expectedRowVersion = options.expectedRowVersion;
    } else if (maybePatch !== undefined) {
      companyKey = companyKeyOrId;
      id = idOrPatch;
      patch = maybePatch;
    }

    if (hasOwn(patch, "expectedRowVersion")) {
      if (expectedRowVersion === undefined) expectedRowVersion = patch.expectedRowVersion;
      const cleaned = { ...patch };
      delete cleaned.expectedRowVersion;
      patch = cleaned;
    }

    const productId = Number(id);
    if (!Number.isFinite(productId) || productId <= 0) return { ok: false, reason: "not_found" };

    const current = await this.findProductById(companyKey, productId);
    if (!current) return { ok: false, reason: "not_found" };

    const version = expectedRowVersion === undefined || expectedRowVersion === null ? null : Number(expectedRowVersion);
    if (version !== null && Number(current.rowVersion) !== version) {
      return { ok: false, reason: "version_conflict", product: current };
    }

    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(PRODUCT_PATCH_COLUMNS)) {
      if (!hasOwn(patch, key)) continue;
      sets.push(`${column} = ?`);
      params.push(patch[key] === undefined ? null : patch[key]);
    }
    if (!sets.length) return { ok: true, product: current };

    sets.push("row_version = row_version + 1");
    sets.push("updated_at = ?");
    params.push(toMysqlDatetime(new Date()));

    const where = [];
    const whereParams = [];
    if (companyKey !== undefined && companyKey !== null) {
      where.push("company_key = ?");
      whereParams.push(String(companyKey));
    }
    where.push("id = ?");
    whereParams.push(productId);
    where.push("row_version = ?");
    whereParams.push(Number(current.rowVersion));

    const pool = await this.resolvePool();
    const [result] = await runQuery(
      pool,
      `UPDATE pdev_products SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`,
      [...params, ...whereParams]
    );
    if (!result || toNumber(result.affectedRows) === 0) {
      const latest = await this.findProductById(companyKey, productId);
      return { ok: false, reason: latest ? "version_conflict" : "not_found", product: latest || null };
    }
    return { ok: true, product: await this.findProductById(companyKey, productId) };
  }

  // deleteProduct(id)：事务级联删子表 + 主表（DB 层另有 FK ON DELETE CASCADE 兜底）。
  async deleteProduct(companyKeyOrId, maybeId) {
    const hasCompanyKey = maybeId !== undefined;
    const companyKey = hasCompanyKey ? companyKeyOrId : null;
    const productId = Number(hasCompanyKey ? maybeId : companyKeyOrId);
    if (!Number.isFinite(productId) || productId <= 0) return { removed: false };

    return this.runInTransaction(async (executor) => {
      const ownerWhere = ["id = ?"];
      const ownerParams = [productId];
      if (companyKey !== undefined && companyKey !== null) {
        ownerWhere.push("company_key = ?");
        ownerParams.push(String(companyKey));
      }
      const [ownerRows] = await runQuery(
        executor,
        `SELECT id FROM pdev_products WHERE ${ownerWhere.join(" AND ")} LIMIT 1`,
        ownerParams
      );
      if (!Array.isArray(ownerRows) || !ownerRows.length) return { removed: false };

      for (const table of CHILD_TABLES) {
        await runQuery(executor, `DELETE FROM ${table} WHERE pdev_product_id = ?`, [productId]);
      }
      await runQuery(executor, `DELETE FROM pdev_products WHERE ${ownerWhere.join(" AND ")}`, ownerParams);
      return { removed: true };
    });
  }

  // 额外方法：按 publicId 删（service 也可自行两步走）。
  async deleteProductByPublicId(companyKey, publicId) {
    const product = await this.findProductByPublicId(companyKey, publicId);
    if (!product) return { removed: false };
    return this.deleteProduct(companyKey, product.id);
  }

  // ---------- pdev_sources ----------

  async listSources(productIdOrCompanyKey, maybeProductId) {
    const { companyKey, id } = splitIdArgs(productIdOrCompanyKey, maybeProductId);
    const pool = await this.resolvePool();
    const where = ["pdev_product_id = ?"];
    const params = [id];
    if (companyKey !== null) {
      where.push("company_key = ?");
      params.push(String(companyKey));
    }
    const [rows] = await runQuery(
      pool,
      `SELECT * FROM pdev_sources WHERE ${where.join(" AND ")} ORDER BY id ASC`,
      params
    );
    return (Array.isArray(rows) ? rows : []).map(mapSourceRow);
  }

  async findSourceById(idOrCompanyKey, maybeId) {
    const { companyKey, id } = splitIdArgs(idOrCompanyKey, maybeId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const pool = await this.resolvePool();
    const where = ["id = ?"];
    const params = [id];
    if (companyKey !== null) {
      where.push("company_key = ?");
      params.push(String(companyKey));
    }
    const [rows] = await runQuery(pool, `SELECT * FROM pdev_sources WHERE ${where.join(" AND ")} LIMIT 1`, params);
    return Array.isArray(rows) && rows.length ? mapSourceRow(rows[0]) : null;
  }

  async findSourceByBusinessKey(companyKey, platform, sourceProductId) {
    const pool = await this.resolvePool();
    const [rows] = await runQuery(
      pool,
      `SELECT * FROM pdev_sources
        WHERE company_key = ? AND platform = ? AND source_product_id = ?
        LIMIT 1`,
      [String(companyKey), String(platform ?? ""), String(sourceProductId ?? "")]
    );
    return Array.isArray(rows) && rows.length ? mapSourceRow(rows[0]) : null;
  }

  async createSource(record = {}, maybeRecord) {
    const data = typeof record === "string" ? { ...(maybeRecord || {}), companyKey: record } : (record || {});
    const pool = await this.resolvePool();
    const now = toMysqlDatetime(new Date());
    const [insertResult] = await runQuery(
      pool,
      `INSERT INTO pdev_sources
         (company_key, pdev_product_id, platform, source_product_id, source_url, supply_price, supply_currency, moq, supplier_name, supply_status, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.companyKey === undefined || data.companyKey === null ? null : String(data.companyKey),
        toNumber(data.pdevProductId),
        String(data.platform ?? ""),
        String(data.sourceProductId ?? ""),
        toNullableString(data.sourceUrl),
        data.supplyPrice === undefined ? null : toNullableNumber(data.supplyPrice),
        String(data.supplyCurrency || "CNY"),
        data.moq === undefined || data.moq === null ? null : toNumber(data.moq),
        toNullableString(data.supplierName),
        String(data.supplyStatus || "unknown"),
        toNullableString(data.note),
        now,
        now
      ]
    );
    return this.findSourceById(toNumber(insertResult?.insertId));
  }

  async updateSource(idOrCompanyKey, patchOrId, maybePatch) {
    let companyKey = null;
    let id = idOrCompanyKey;
    let patch = patchOrId;
    if (maybePatch !== undefined) {
      companyKey = idOrCompanyKey;
      id = patchOrId;
      patch = maybePatch;
    }
    const sourceId = Number(id);
    if (!Number.isFinite(sourceId) || sourceId <= 0) return null;
    const existing = await this.findSourceById(companyKey, sourceId);
    if (!existing) return null;

    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(SOURCE_PATCH_COLUMNS)) {
      if (!hasOwn(patch, key)) continue;
      sets.push(`${column} = ?`);
      params.push(patch[key] === undefined ? null : patch[key]);
    }
    if (!sets.length) return existing;

    sets.push("updated_at = ?");
    params.push(toMysqlDatetime(new Date()));
    params.push(sourceId);
    if (companyKey !== null) params.push(String(companyKey));

    const pool = await this.resolvePool();
    await runQuery(
      pool,
      `UPDATE pdev_sources SET ${sets.join(", ")} WHERE id = ?${companyKey !== null ? " AND company_key = ?" : ""}`,
      params
    );
    return this.findSourceById(companyKey, sourceId);
  }

  async deleteSource(idOrCompanyKey, maybeId) {
    const { companyKey, id } = splitIdArgs(idOrCompanyKey, maybeId);
    if (!Number.isFinite(id) || id <= 0) return { removed: false };
    const pool = await this.resolvePool();
    const params = [id];
    let sql = "DELETE FROM pdev_sources WHERE id = ?";
    if (companyKey !== null) {
      sql += " AND company_key = ?";
      params.push(String(companyKey));
    }
    const [result] = await runQuery(pool, sql, params);
    return { removed: toNumber(result?.affectedRows) > 0 };
  }

  async countSources(productIdOrCompanyKey, maybeProductId) {
    return this.countChildRows("pdev_sources", productIdOrCompanyKey, maybeProductId);
  }

  async countActivePricedSources(productIdOrCompanyKey, maybeProductId) {
    const { companyKey, id } = splitIdArgs(productIdOrCompanyKey, maybeProductId);
    const pool = await this.resolvePool();
    const where = ["pdev_product_id = ?", "supply_status = 'active'", "supply_price IS NOT NULL"];
    const params = [id];
    if (companyKey !== null) {
      where.push("company_key = ?");
      params.push(String(companyKey));
    }
    const [rows] = await runQuery(pool, `SELECT COUNT(*) AS total FROM pdev_sources WHERE ${where.join(" AND ")}`, params);
    return toNumber(rows?.[0]?.total);
  }

  // ---------- pdev_assets ----------

  async listAssets(productIdOrCompanyKey, maybeProductId) {
    const { companyKey, id } = splitIdArgs(productIdOrCompanyKey, maybeProductId);
    const pool = await this.resolvePool();
    const where = ["pdev_product_id = ?"];
    const params = [id];
    if (companyKey !== null) {
      where.push("company_key = ?");
      params.push(String(companyKey));
    }
    const [rows] = await runQuery(
      pool,
      `SELECT * FROM pdev_assets WHERE ${where.join(" AND ")} ORDER BY sort_no ASC, id ASC`,
      params
    );
    return (Array.isArray(rows) ? rows : []).map(mapAssetRow);
  }

  async findAssetById(idOrCompanyKey, maybeId) {
    const { companyKey, id } = splitIdArgs(idOrCompanyKey, maybeId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const pool = await this.resolvePool();
    const where = ["id = ?"];
    const params = [id];
    if (companyKey !== null) {
      where.push("company_key = ?");
      params.push(String(companyKey));
    }
    const [rows] = await runQuery(pool, `SELECT * FROM pdev_assets WHERE ${where.join(" AND ")} LIMIT 1`, params);
    return Array.isArray(rows) && rows.length ? mapAssetRow(rows[0]) : null;
  }

  async createAsset(record = {}, maybeRecord) {
    const data = typeof record === "string" ? { ...(maybeRecord || {}), companyKey: record } : (record || {});
    const pool = await this.resolvePool();
    const now = toMysqlDatetime(new Date());
    const [insertResult] = await runQuery(
      pool,
      `INSERT INTO pdev_assets
         (company_key, pdev_product_id, asset_type, source_url, storage_url, sort_no, checksum, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.companyKey === undefined || data.companyKey === null ? null : String(data.companyKey),
        toNumber(data.pdevProductId),
        String(data.assetType ?? ""),
        toNullableString(data.sourceUrl),
        toNullableString(data.storageUrl),
        data.sortNo === undefined || data.sortNo === null ? 0 : toNumber(data.sortNo),
        toNullableString(data.checksum),
        String(data.status || "ready"),
        now,
        now
      ]
    );
    return this.findAssetById(toNumber(insertResult?.insertId));
  }

  async deleteAsset(idOrCompanyKey, maybeId) {
    const { companyKey, id } = splitIdArgs(idOrCompanyKey, maybeId);
    if (!Number.isFinite(id) || id <= 0) return { removed: false };
    const pool = await this.resolvePool();
    const params = [id];
    let sql = "DELETE FROM pdev_assets WHERE id = ?";
    if (companyKey !== null) {
      sql += " AND company_key = ?";
      params.push(String(companyKey));
    }
    const [result] = await runQuery(pool, sql, params);
    return { removed: toNumber(result?.affectedRows) > 0 };
  }

  async countMainAssets(productIdOrCompanyKey, maybeProductId) {
    const { companyKey, id } = splitIdArgs(productIdOrCompanyKey, maybeProductId);
    const pool = await this.resolvePool();
    const where = ["pdev_product_id = ?", "asset_type = 'main'"];
    const params = [id];
    if (companyKey !== null) {
      where.push("company_key = ?");
      params.push(String(companyKey));
    }
    const [rows] = await runQuery(pool, `SELECT COUNT(*) AS total FROM pdev_assets WHERE ${where.join(" AND ")}`, params);
    return toNumber(rows?.[0]?.total);
  }

  // ---------- pdev_variants ----------

  async listVariants(productIdOrCompanyKey, maybeProductId) {
    const { companyKey, id } = splitIdArgs(productIdOrCompanyKey, maybeProductId);
    const pool = await this.resolvePool();
    const where = ["pdev_product_id = ?"];
    const params = [id];
    if (companyKey !== null) {
      where.push("company_key = ?");
      params.push(String(companyKey));
    }
    const [rows] = await runQuery(
      pool,
      `SELECT * FROM pdev_variants WHERE ${where.join(" AND ")} ORDER BY id ASC`,
      params
    );
    return (Array.isArray(rows) ? rows : []).map(mapVariantRow);
  }

  async findVariantByKey(productIdOrCompanyKey, variantKeyOrProductId, maybeVariantKey) {
    let companyKey = null;
    let productId = productIdOrCompanyKey;
    let variantKey = variantKeyOrProductId;
    if (maybeVariantKey !== undefined) {
      companyKey = productIdOrCompanyKey;
      productId = variantKeyOrProductId;
      variantKey = maybeVariantKey;
    }
    const pool = await this.resolvePool();
    const where = ["pdev_product_id = ?", "variant_key = ?"];
    const params = [toNumber(productId), String(variantKey ?? "")];
    if (companyKey !== null) {
      where.push("company_key = ?");
      params.push(String(companyKey));
    }
    const [rows] = await runQuery(pool, `SELECT * FROM pdev_variants WHERE ${where.join(" AND ")} LIMIT 1`, params);
    return Array.isArray(rows) && rows.length ? mapVariantRow(rows[0]) : null;
  }

  async createVariant(record = {}, maybeRecord) {
    const data = typeof record === "string" ? { ...(maybeRecord || {}), companyKey: record } : (record || {});
    const pool = await this.resolvePool();
    const now = toMysqlDatetime(new Date());
    const [insertResult] = await runQuery(
      pool,
      `INSERT INTO pdev_variants
         (company_key, pdev_product_id, variant_key, spec_json, supply_price, weight_kg, package_length_cm, package_width_cm, package_height_cm, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.companyKey === undefined || data.companyKey === null ? null : String(data.companyKey),
        toNumber(data.pdevProductId),
        String(data.variantKey ?? ""),
        JSON.stringify(data.spec && typeof data.spec === "object" ? data.spec : {}),
        data.supplyPrice === undefined ? null : toNullableNumber(data.supplyPrice),
        data.weightKg === undefined ? null : toNullableNumber(data.weightKg),
        data.packageLengthCm === undefined ? null : toNullableNumber(data.packageLengthCm),
        data.packageWidthCm === undefined ? null : toNullableNumber(data.packageWidthCm),
        data.packageHeightCm === undefined ? null : toNullableNumber(data.packageHeightCm),
        String(data.status || "active"),
        now,
        now
      ]
    );
    const variantId = toNumber(insertResult?.insertId);
    const [rows] = await runQuery(pool, "SELECT * FROM pdev_variants WHERE id = ? LIMIT 1", [variantId]);
    return Array.isArray(rows) && rows.length ? mapVariantRow(rows[0]) : null;
  }

  async countVariants(productIdOrCompanyKey, maybeProductId) {
    return this.countChildRows("pdev_variants", productIdOrCompanyKey, maybeProductId);
  }

  // ---------- 汇总 / 统计（额外方法） ----------

  async countChildRows(table, productIdOrCompanyKey, maybeProductId) {
    if (!CHILD_TABLES.includes(table)) throw new Error(`Unsupported table: ${table}`);
    const { companyKey, id } = splitIdArgs(productIdOrCompanyKey, maybeProductId);
    const pool = await this.resolvePool();
    const where = ["pdev_product_id = ?"];
    const params = [id];
    if (companyKey !== null) {
      where.push("company_key = ?");
      params.push(String(companyKey));
    }
    const [rows] = await runQuery(pool, `SELECT COUNT(*) AS total FROM ${table} WHERE ${where.join(" AND ")}`, params);
    return toNumber(rows?.[0]?.total);
  }

  async getRequirementStats(companyKey, pdevProductId) {
    const pool = await this.resolvePool();
    const key = String(companyKey);
    const productId = toNumber(pdevProductId);
    const [rows] = await runQuery(
      pool,
      `SELECT
         (SELECT COUNT(*) FROM pdev_sources WHERE company_key = ? AND pdev_product_id = ?) AS source_count,
         (SELECT COUNT(*) FROM pdev_sources WHERE company_key = ? AND pdev_product_id = ? AND supply_status = 'active' AND supply_price IS NOT NULL) AS active_priced_source_count,
         (SELECT COUNT(*) FROM pdev_assets WHERE company_key = ? AND pdev_product_id = ? AND asset_type = 'main') AS main_asset_count,
         (SELECT COUNT(*) FROM pdev_variants WHERE company_key = ? AND pdev_product_id = ?) AS variant_count`,
      [key, productId, key, productId, key, productId, key, productId]
    );
    const row = Array.isArray(rows) && rows.length ? rows[0] : {};
    return {
      sourceCount: toNumber(row.source_count),
      activePricedSourceCount: toNumber(row.active_priced_source_count),
      mainAssetCount: toNumber(row.main_asset_count),
      variantCount: toNumber(row.variant_count)
    };
  }

  // §5 接口 13 的形状：{ byStatus: {...5 键}, missing: {...4 键} }
  // §11.8：四个桶的优先级必须与 deriveMissingTokens/列表筛选完全一致——noSource 遮蔽 noActivePrice，
  // 所以 noActivePrice 桶带 source_count > 0 条件，否则 chip 之和会大于筛选 total（无货源商品被双计）。
  async getSummaryCounts(companyKey) {
    const pool = await this.resolvePool();
    const [rows] = await runQuery(
      pool,
      `SELECT p.dev_status AS dev_status,
              COUNT(*) AS total,
              SUM(CASE WHEN COALESCE(src_agg.source_count, 0) = 0 THEN 1 ELSE 0 END) AS no_source,
              SUM(CASE WHEN COALESCE(src_agg.source_count, 0) > 0 AND COALESCE(src_agg.active_source_count, 0) = 0 THEN 1 ELSE 0 END) AS no_active_price,
              SUM(CASE WHEN COALESCE(ast_agg.main_asset_count, 0) = 0 THEN 1 ELSE 0 END) AS no_main_asset,
              SUM(CASE WHEN COALESCE(var_agg.variant_count, 0) = 0 THEN 1 ELSE 0 END) AS no_variant
         FROM pdev_products p
         ${PRODUCT_SUMMARY_JOINS}
        WHERE p.company_key = ?
        GROUP BY p.dev_status`,
      [String(companyKey)]
    );
    const byStatus = {};
    for (const status of DEV_STATUS_KEYS) byStatus[status] = 0;
    const missing = { noSource: 0, noActivePrice: 0, noMainAsset: 0, noVariant: 0 };
    for (const row of Array.isArray(rows) ? rows : []) {
      const status = String(row.dev_status || "");
      if (Object.prototype.hasOwnProperty.call(byStatus, status)) byStatus[status] = toNumber(row.total);
      missing.noSource += toNumber(row.no_source);
      missing.noActivePrice += toNumber(row.no_active_price);
      missing.noMainAsset += toNumber(row.no_main_asset);
      missing.noVariant += toNumber(row.no_variant);
    }
    return { byStatus, missing };
  }
}

function createPdevRepository(deps = {}) {
  return new MysqlPdevRepository(deps);
}

module.exports = {
  createPdevRepository,
  MysqlPdevRepository,
  mapProductRow,
  mapSourceRow,
  mapAssetRow,
  mapVariantRow
};
