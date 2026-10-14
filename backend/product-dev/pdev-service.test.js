"use strict";
// 产品开发库 · 服务层单测（契约 §2 / §3 / §4 / §6 / §8 增量决议 / §10 调用面 v1.2 / §11 v1.3）
//
// 只使用**内存假 repository**，绝不创建 MySQL 连接、绝不触碰业务库。
// 调用面按契约 §10 硬断言（对不上即实现 bug）：
//   pdev-service.js -> { createPdevService, PdevError, normalizeVariantKey, PDEV_DEV_STATUSES,
//                        PDEV_ALLOWED_TRANSITIONS, resolveCompanyKey }
//   createPdevService({ repository, resolveCompanyKey? })：resolveCompanyKey 缺省即 §2 内置实现
//   方法：listProducts/createProduct/getProduct/updateProduct/deleteProduct
//         addSource/updateSource/deleteSource/addAsset/deleteAsset/addVariant/changeStatus/getSummary
//   §10.1 修正点 1：service 直接返回 §5.1 包装形状，本文件按包装形状严格断言。
//   错误：throw PdevError(code, message, { statusCode, missing, details })。
//
// 假 repository 严格模仿真 repository 的对外行为（§10.2 + §10.1「行映射」+ §12 返回形状）：
// 内部按 DB 行存储，读出去时映射成 §5.1 camelCase 对象、**不含 company_key**；
// 列表项按 §11.1 额外带 missing（顺序固定）。这样服务层拿到的就是真实现拿到的形状。
//
// §12.6 验证边界：假 repository 只能验证**服务/路由的编排与契约形状**，不能验证
// SQL 谓词、DDL、唯一索引、事务级联、DATETIME 映射——那些由 pdev.integration.test.js
// 在真实 MySQL 上兜底，两层不可互相替代。

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createPdevService,
  PdevError,
  normalizeVariantKey,
  PDEV_DEV_STATUSES,
  PDEV_ALLOWED_TRANSITIONS,
  resolveCompanyKey
} = require("./pdev-service");

// ─────────────────────────────────────────────────────────────────────────────
// 冻结常量
// ─────────────────────────────────────────────────────────────────────────────

const CODE = {
  validation: "VALIDATION_FAILED",
  companyRequired: "COMPANY_REQUIRED",
  notFound: "NOT_FOUND",
  version: "VERSION_CONFLICT",
  sourceTaken: "SOURCE_TAKEN",
  variantTaken: "VARIANT_TAKEN"
};

const USER_A = { id: "USR-A", companyName: "系统", companyId: "system" };
const USER_A2 = { id: "USR-A2", companyName: "系统", companyId: "CMP-MMYJG76G-B30D" };
const USER_B = { id: "USR-B", companyName: "另一家公司", companyId: "CMP-B" };
const COMPANY_A = "系统";
const COMPANY_B = "另一家公司";

const MISSING_VOCAB = ["noSource", "noActivePrice", "noMainAsset", "noVariant"];
const MISSING_ORDER = ["noSource", "noActivePrice", "noMainAsset", "noVariant"];

const PRODUCT_KEYS = [
  "id", "publicId", "title", "remark", "categoryHint", "targetPlatform", "devStatus",
  "ownerUserId", "createdBy", "createdAt", "updatedAt", "rowVersion",
  "sourceCount", "activeSourceCount", "assetCount", "variantCount"
];
const SOURCE_KEYS = [
  "id", "pdevProductId", "platform", "sourceProductId", "sourceUrl", "supplyPrice",
  "supplyCurrency", "moq", "supplierName", "supplyStatus", "note", "createdAt", "updatedAt"
];
const ASSET_KEYS = [
  "id", "pdevProductId", "assetType", "sourceUrl", "storageUrl", "sortNo", "checksum", "status", "createdAt"
];
const VARIANT_KEYS = [
  "id", "pdevProductId", "variantKey", "spec", "supplyPrice", "weightKg",
  "packageLengthCm", "packageWidthCm", "packageHeightCm", "status", "createdAt"
];

// ─────────────────────────────────────────────────────────────────────────────
// 假 repository（内部 DB 行 → §5.1 映射，模仿真 repository 的对外行为）
// ─────────────────────────────────────────────────────────────────────────────

let idSeq = 0;
const nextId = () => (idSeq += 1);
const TS = "2026-09-28 10:00:00.000";

const isNum = (value) => Number.isFinite(Number(value));
const num = (value, fallback = 0) => (isNum(value) ? Number(value) : fallback);
const nullableNum = (value) => (value === null || value === undefined || value === "" ? null : (isNum(value) ? Number(value) : null));
const text = (value) => (value === null || value === undefined ? "" : String(value));

function splitIdArgs(first, second) {
  if (second === undefined) return { companyKey: null, id: num(first) };
  return { companyKey: first === undefined ? null : first, id: num(second) };
}

function createFakeRepository() {
  const products = [];
  const sources = [];
  const assets = [];
  const variants = [];

  function countsOf(productId) {
    const productSources = sources.filter((row) => Number(row.pdev_product_id) === Number(productId));
    return {
      sourceCount: productSources.length,
      activeSourceCount: productSources.filter((row) => row.supply_status === "active"
        && row.supply_price !== null && row.supply_price !== undefined && row.supply_price !== "").length,
      assetCount: assets.filter((row) => Number(row.pdev_product_id) === Number(productId)).length,
      mainAssetCount: assets.filter((row) => Number(row.pdev_product_id) === Number(productId) && row.asset_type === "main").length,
      variantCount: variants.filter((row) => Number(row.pdev_product_id) === Number(productId)).length
    };
  }

  // §11.5：与 §4 硬校验同源的精确判定；§11.1：顺序固定
  function missingTokensOf(counts) {
    const tokens = [];
    if (counts.sourceCount === 0) tokens.push("noSource");
    else if (counts.activeSourceCount === 0) tokens.push("noActivePrice");
    if (counts.mainAssetCount === 0) tokens.push("noMainAsset");
    if (counts.variantCount === 0) tokens.push("noVariant");
    return MISSING_ORDER.filter((token) => tokens.includes(token));
  }

  function mapProduct(row) {
    const counts = countsOf(row.id);
    return {
      id: num(row.id),
      publicId: text(row.public_id),
      title: text(row.title),
      remark: text(row.remark),
      categoryHint: text(row.category_hint),
      targetPlatform: text(row.target_platform),
      devStatus: text(row.dev_status),
      ownerUserId: text(row.owner_user_id),
      createdBy: text(row.created_by),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
      rowVersion: num(row.row_version),
      sourceCount: counts.sourceCount,
      activeSourceCount: counts.activeSourceCount,
      assetCount: counts.assetCount,
      variantCount: counts.variantCount
    };
  }

  function mapProductSummary(row) {
    return { ...mapProduct(row), missing: missingTokensOf(countsOf(row.id)) };
  }

  function mapSource(row) {
    return {
      id: num(row.id),
      pdevProductId: num(row.pdev_product_id),
      platform: text(row.platform),
      sourceProductId: text(row.source_product_id),
      sourceUrl: text(row.source_url),
      supplyPrice: nullableNum(row.supply_price),
      supplyCurrency: text(row.supply_currency),
      moq: row.moq === null || row.moq === undefined ? null : num(row.moq),
      supplierName: text(row.supplier_name),
      supplyStatus: text(row.supply_status),
      note: text(row.note),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at)
    };
  }

  function mapAsset(row) {
    return {
      id: num(row.id),
      pdevProductId: num(row.pdev_product_id),
      assetType: text(row.asset_type),
      sourceUrl: text(row.source_url),
      storageUrl: text(row.storage_url),
      sortNo: num(row.sort_no),
      checksum: row.checksum === null || row.checksum === undefined ? null : String(row.checksum),
      status: text(row.status),
      createdAt: text(row.created_at)
    };
  }

  function mapVariant(row) {
    return {
      id: num(row.id),
      pdevProductId: num(row.pdev_product_id),
      variantKey: text(row.variant_key),
      spec: row.spec_json && typeof row.spec_json === "object" ? { ...row.spec_json } : {},
      supplyPrice: nullableNum(row.supply_price),
      weightKg: nullableNum(row.weight_kg),
      packageLengthCm: nullableNum(row.package_length_cm),
      packageWidthCm: nullableNum(row.package_width_cm),
      packageHeightCm: nullableNum(row.package_height_cm),
      status: text(row.status),
      createdAt: text(row.created_at)
    };
  }

  function findProductRowById(id) {
    return products.find((row) => Number(row.id) === Number(id)) || null;
  }

  function applyPatch(row, patch, columns) {
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      const value = patch[key];
      if (column === "row_version") continue;
      row[column] = value;
    }
    row.updated_at = TS;
    return row;
  }

  const PRODUCT_PATCH_COLUMNS = {
    title: "title", remark: "remark", categoryHint: "category_hint", targetPlatform: "target_platform",
    devStatus: "dev_status", ownerUserId: "owner_user_id", createdBy: "created_by"
  };
  const SOURCE_PATCH_COLUMNS = {
    sourceUrl: "source_url", supplyPrice: "supply_price", supplyCurrency: "supply_currency",
    moq: "moq", supplierName: "supplier_name", supplyStatus: "supply_status", note: "note"
  };

  const repository = {
    __all: { products, sources, assets, variants },

    async ensureTables() {},

    // ---------- 产品 ----------
    async findProductByPublicId(companyKey, publicId) {
      const row = products.find((item) => item.company_key === companyKey && item.public_id === String(publicId ?? "")) || null;
      return row ? mapProduct(row) : null;
    },
    async findProductById(companyKey, id) {
      const row = findProductRowById(id);
      if (!row) return null;
      if (companyKey !== null && companyKey !== undefined && row.company_key !== companyKey) return null;
      return mapProduct(row);
    },
    async createProduct(record = {}) {
      const publicId = record.publicId || record.public_id;
      if (!publicId) throw new Error("FAKE REPO createProduct: record 缺少 publicId（§3.1 要求服务端生成 PD_ 编号）");
      const row = {
        id: nextId(),
        public_id: publicId,
        company_key: record.companyKey !== undefined ? record.companyKey : record.company_key,
        title: text(record.title),
        remark: text(record.remark),
        category_hint: text(record.categoryHint),
        target_platform: text(record.targetPlatform),
        dev_status: text(record.devStatus || "new"),
        owner_user_id: text(record.ownerUserId),
        created_by: text(record.createdBy),
        created_at: TS,
        updated_at: TS,
        row_version: num(record.rowVersion, 0)
      };
      products.push(row);
      return mapProduct(row);
    },
    // 真 repository：updateProduct(id, patch) → { ok, product } / { ok:false, reason }
    async updateProduct(companyKeyOrId, idOrPatch, maybePatch) {
      let id = companyKeyOrId;
      let patch = idOrPatch || {};
      if (maybePatch !== undefined) {
        id = idOrPatch;
        patch = maybePatch;
      } else if (companyKeyOrId && typeof companyKeyOrId === "object") {
        id = companyKeyOrId.id;
        patch = { ...(companyKeyOrId.patch || {}) };
        if (companyKeyOrId.expectedRowVersion !== undefined) patch.expectedRowVersion = companyKeyOrId.expectedRowVersion;
      }
      const row = findProductRowById(id);
      if (!row) return { ok: false, reason: "not_found" };
      const expected = patch.expectedRowVersion;
      if (expected !== undefined && expected !== null && Number(expected) !== Number(row.row_version)) {
        return { ok: false, reason: "version_conflict", product: mapProduct(row) };
      }
      applyPatch(row, patch, PRODUCT_PATCH_COLUMNS);
      row.row_version = Number(row.row_version) + 1;
      return { ok: true, product: mapProduct(row) };
    },
    async deleteProduct(companyKeyOrId, maybeId) {
      const id = maybeId !== undefined ? maybeId : companyKeyOrId;
      const index = products.findIndex((row) => Number(row.id) === Number(id));
      if (index < 0) return { removed: false };
      const [row] = products.splice(index, 1);
      for (const collection of [sources, assets, variants]) {
        for (let i = collection.length - 1; i >= 0; i -= 1) {
          if (Number(collection[i].pdev_product_id) === Number(row.id)) collection.splice(i, 1);
        }
      }
      return { removed: true };
    },
    async listProducts(filters = {}) {
      const { companyKey, devStatus, q, limit, offset } = filters;
      let rows = products.filter((row) => row.company_key === companyKey);
      if (devStatus) rows = rows.filter((row) => row.dev_status === devStatus);
      if (q) rows = rows.filter((row) => String(row.title || "").includes(String(q)));
      let items = rows.map(mapProductSummary);
      const wanted = Array.isArray(filters.missing)
        ? filters.missing
        : String(filters.missing || "").split(",").map((token) => token.trim()).filter(Boolean);
      if (wanted.length) items = items.filter((item) => wanted.every((token) => item.missing.includes(token)));
      const total = items.length;
      const start = Number(offset || 0);
      const take = Number(limit || items.length);
      return { items: items.slice(start, start + take), total };
    },
    async countProducts(filtersOrCompanyKey = {}, maybeFilters) {
      const filters = typeof filtersOrCompanyKey === "string"
        ? { ...(maybeFilters || {}), companyKey: filtersOrCompanyKey }
        : (filtersOrCompanyKey || {});
      const result = await this.listProducts(filters);
      return result.total;
    },
    async countsByProductIds(companyKey, productIds) {
      const result = {};
      for (const id of productIds || []) {
        const row = findProductRowById(id);
        if (!row || row.company_key !== companyKey) {
          result[String(id)] = { sourceCount: 0, activeSourceCount: 0, assetCount: 0, variantCount: 0 };
          continue;
        }
        const counts = countsOf(row.id);
        result[String(id)] = {
          sourceCount: counts.sourceCount,
          activeSourceCount: counts.activeSourceCount,
          assetCount: counts.assetCount,
          variantCount: counts.variantCount
        };
      }
      return result;
    },
    async getRequirementStats(companyKey, pdevProductId) {
      const row = findProductRowById(pdevProductId);
      if (!row || row.company_key !== companyKey) {
        return { sourceCount: 0, activePricedSourceCount: 0, mainAssetCount: 0, variantCount: 0 };
      }
      const counts = countsOf(row.id);
      return {
        sourceCount: counts.sourceCount,
        activePricedSourceCount: counts.activeSourceCount,
        mainAssetCount: counts.mainAssetCount,
        variantCount: counts.variantCount
      };
    },
    async getSummaryCounts(companyKey) {
      const byStatus = { new: 0, developing: 0, info_ready: 0, finalized: 0, archived: 0 };
      const missing = { noSource: 0, noActivePrice: 0, noMainAsset: 0, noVariant: 0 };
      for (const row of products) {
        if (row.company_key !== companyKey) continue;
        if (Object.prototype.hasOwnProperty.call(byStatus, row.dev_status)) byStatus[row.dev_status] += 1;
        const counts = countsOf(row.id);
        // §11.5 v1.4：noSource 遮蔽 noActivePrice（互斥）
        if (counts.sourceCount === 0) missing.noSource += 1;
        else if (counts.activeSourceCount === 0) missing.noActivePrice += 1;
        if (counts.mainAssetCount === 0) missing.noMainAsset += 1;
        if (counts.variantCount === 0) missing.noVariant += 1;
      }
      return { byStatus, missing };
    },

    // ---------- 货源 ----------
    async listSources(productIdOrCompanyKey, maybeProductId) {
      const { id } = splitIdArgs(productIdOrCompanyKey, maybeProductId);
      return sources.filter((row) => Number(row.pdev_product_id) === id).map(mapSource);
    },
    async findSourceById(idOrCompanyKey, maybeId) {
      const { id } = splitIdArgs(idOrCompanyKey, maybeId);
      const row = sources.find((item) => Number(item.id) === id) || null;
      return row ? mapSource(row) : null;
    },
    async findSourceByBusinessKey(companyKey, platform, sourceProductId) {
      const row = sources.find((item) => item.company_key === companyKey
        && item.platform === platform && item.source_product_id === sourceProductId) || null;
      return row ? mapSource(row) : null;
    },
    async createSource(record = {}) {
      const row = {
        id: nextId(),
        company_key: record.companyKey !== undefined ? record.companyKey : record.company_key,
        pdev_product_id: num(record.pdevProductId !== undefined ? record.pdevProductId : record.pdev_product_id),
        platform: text(record.platform),
        source_product_id: text(record.sourceProductId),
        source_url: text(record.sourceUrl),
        supply_price: record.supplyPrice === undefined ? null : record.supplyPrice,
        supply_currency: text(record.supplyCurrency || "CNY"),
        moq: record.moq === undefined ? null : record.moq,
        supplier_name: text(record.supplierName),
        supply_status: text(record.supplyStatus || "unknown"),
        note: text(record.note),
        created_at: TS,
        updated_at: TS
      };
      sources.push(row);
      return mapSource(row);
    },
    async updateSource(idOrCompanyKey, patchOrId, maybePatch) {
      let id = idOrCompanyKey;
      let patch = patchOrId || {};
      if (maybePatch !== undefined) {
        id = patchOrId;
        patch = maybePatch;
      }
      const row = sources.find((item) => Number(item.id) === Number(id)) || null;
      if (!row) return null;
      applyPatch(row, patch, SOURCE_PATCH_COLUMNS);
      return mapSource(row);
    },
    async deleteSource(idOrCompanyKey, maybeId) {
      const { id } = splitIdArgs(idOrCompanyKey, maybeId);
      const index = sources.findIndex((row) => Number(row.id) === id);
      if (index < 0) return { removed: false };
      sources.splice(index, 1);
      return { removed: true };
    },
    async countSources(productIdOrCompanyKey, maybeProductId) {
      const { id } = splitIdArgs(productIdOrCompanyKey, maybeProductId);
      return sources.filter((row) => Number(row.pdev_product_id) === id).length;
    },
    async countActivePricedSources(productIdOrCompanyKey, maybeProductId) {
      const { id } = splitIdArgs(productIdOrCompanyKey, maybeProductId);
      return sources.filter((row) => Number(row.pdev_product_id) === id
        && row.supply_status === "active" && row.supply_price !== null && row.supply_price !== "").length;
    },

    // ---------- 素材 ----------
    async listAssets(productIdOrCompanyKey, maybeProductId) {
      const { id } = splitIdArgs(productIdOrCompanyKey, maybeProductId);
      return assets.filter((row) => Number(row.pdev_product_id) === id).map(mapAsset);
    },
    async findAssetById(idOrCompanyKey, maybeId) {
      const { id } = splitIdArgs(idOrCompanyKey, maybeId);
      const row = assets.find((item) => Number(item.id) === id) || null;
      return row ? mapAsset(row) : null;
    },
    async createAsset(record = {}) {
      const row = {
        id: nextId(),
        company_key: record.companyKey !== undefined ? record.companyKey : record.company_key,
        pdev_product_id: num(record.pdevProductId !== undefined ? record.pdevProductId : record.pdev_product_id),
        asset_type: text(record.assetType),
        source_url: text(record.sourceUrl),
        storage_url: text(record.storageUrl),
        sort_no: num(record.sortNo, 0),
        checksum: record.checksum === undefined ? null : record.checksum,
        status: text(record.status || "ready"),
        created_at: TS,
        updated_at: TS
      };
      assets.push(row);
      return mapAsset(row);
    },
    async deleteAsset(idOrCompanyKey, maybeId) {
      const { id } = splitIdArgs(idOrCompanyKey, maybeId);
      const index = assets.findIndex((row) => Number(row.id) === id);
      if (index < 0) return { removed: false };
      assets.splice(index, 1);
      return { removed: true };
    },
    async countMainAssets(productIdOrCompanyKey, maybeProductId) {
      const { id } = splitIdArgs(productIdOrCompanyKey, maybeProductId);
      return assets.filter((row) => Number(row.pdev_product_id) === id && row.asset_type === "main").length;
    },

    // ---------- 变体 ----------
    async listVariants(productIdOrCompanyKey, maybeProductId) {
      const { id } = splitIdArgs(productIdOrCompanyKey, maybeProductId);
      return variants.filter((row) => Number(row.pdev_product_id) === id).map(mapVariant);
    },
    async findVariantByKey(productIdOrCompanyKey, variantKeyOrProductId, maybeVariantKey) {
      let productId = productIdOrCompanyKey;
      let variantKey = variantKeyOrProductId;
      if (maybeVariantKey !== undefined) {
        productId = variantKeyOrProductId;
        variantKey = maybeVariantKey;
      }
      const row = variants.find((item) => Number(item.pdev_product_id) === Number(productId)
        && item.variant_key === variantKey) || null;
      return row ? mapVariant(row) : null;
    },
    async createVariant(record = {}) {
      const row = {
        id: nextId(),
        company_key: record.companyKey !== undefined ? record.companyKey : record.company_key,
        pdev_product_id: num(record.pdevProductId !== undefined ? record.pdevProductId : record.pdev_product_id),
        variant_key: text(record.variantKey),
        spec_json: record.spec && typeof record.spec === "object" ? { ...record.spec } : {},
        supply_price: record.supplyPrice === undefined ? null : record.supplyPrice,
        weight_kg: record.weightKg === undefined ? null : record.weightKg,
        package_length_cm: record.packageLengthCm === undefined ? null : record.packageLengthCm,
        package_width_cm: record.packageWidthCm === undefined ? null : record.packageWidthCm,
        package_height_cm: record.packageHeightCm === undefined ? null : record.packageHeightCm,
        status: text(record.status || "active"),
        created_at: TS,
        updated_at: TS
      };
      variants.push(row);
      return mapVariant(row);
    },
    async countVariants(productIdOrCompanyKey, maybeProductId) {
      const { id } = splitIdArgs(productIdOrCompanyKey, maybeProductId);
      return variants.filter((row) => Number(row.pdev_product_id) === id).length;
    },

    async runInTransaction(work) {
      return work(repository);
    }
  };

  // §12：updateProduct 返回 { ok, product }（真把 row_version +1 并回传更新后的行），
  // updateSource 返回更新后的行对象（不包装），createXxx 返回新行，findXxx 返回行或 null，
  // listProducts 返回 { items, total }，deleteXxx 返回 { removed }。
  return repository;
}

// ─────────────────────────────────────────────────────────────────────────────
// 装配 + 断言助手
// ─────────────────────────────────────────────────────────────────────────────

// 不注入 resolveCompanyKey：走 §10.1 的内置 §2 实现（这本身就是要测的行为）。
function createHarness() {
  const repository = createFakeRepository();
  const service = createPdevService({ repository });
  return { repository, service };
}

function call(service, op, fields) {
  assert.equal(typeof service[op], "function", `§10.1 冻结方法名缺失：PdevService.${op}()`);
  return service[op]({ ...fields });
}

async function expectPdevError(promise, expected, label) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `${label}: 期望抛错，但调用成功了`);
  assert.ok(error instanceof PdevError, `${label}: 应抛 PdevError，实际 ${error && error.constructor && error.constructor.name}`);
  if (expected.code !== undefined) assert.equal(error.code, expected.code, `${label}: PdevError.code 不符`);
  if (expected.statusCode !== undefined) assert.equal(Number(error.statusCode), expected.statusCode, `${label}: statusCode 不符`);
  if (expected.messagePattern) assert.match(String(error.message), expected.messagePattern, `${label}: message 不符`);
  return error;
}

function missingOf(error) {
  assert.ok(Array.isArray(error.missing), `硬校验失败必须带 missing: string[]，实际：${JSON.stringify(error.missing)}`);
  assert.ok(error.missing.length > 0, "missing 不应为空数组");
  for (const token of error.missing) {
    assert.ok(MISSING_VOCAB.includes(token), `missing token "${token}" 不在 §5.1 词表内`);
  }
  return [...error.missing].sort();
}

async function createProduct(service, user, title, extra = {}) {
  const result = await call(service, "createProduct", { user, title, ...extra });
  assert.ok(result && result.product, "§10.1：createProduct 必须返回 { product }");
  return result.product;
}

// 建到 info_ready 所需的最小数据：1 条 active 且有价货源 + 1 张 main 图
async function seedInfoReadyInputs(repository, product) {
  await repository.createSource({
    companyKey: product.company_key || COMPANY_A, pdevProductId: product.id, platform: "1688",
    sourceProductId: `SRC-${product.id}`, supplyPrice: 12.5, supplyStatus: "active"
  });
  await repository.createAsset({
    companyKey: product.company_key || COMPANY_A, pdevProductId: product.id, assetType: "main", sourceUrl: "https://img.example.com/main.jpg"
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. 冻结调用面
// ─────────────────────────────────────────────────────────────────────────────

test("§10.1 冻结调用面：导出 createPdevService/PdevError/normalizeVariantKey/状态常量/resolveCompanyKey", () => {
  assert.equal(typeof createPdevService, "function");
  assert.equal(typeof PdevError, "function");
  assert.equal(typeof normalizeVariantKey, "function");
  assert.equal(typeof resolveCompanyKey, "function", "§10.1 要求同时导出 resolveCompanyKey（§2 内置实现）");
  assert.ok(PDEV_DEV_STATUSES, "必须导出 PDEV_DEV_STATUSES");
  assert.ok(PDEV_ALLOWED_TRANSITIONS, "必须导出 PDEV_ALLOWED_TRANSITIONS");

  const statuses = Array.isArray(PDEV_DEV_STATUSES) ? [...PDEV_DEV_STATUSES] : Object.values(PDEV_DEV_STATUSES);
  assert.deepEqual(statuses.sort(), ["archived", "developing", "finalized", "info_ready", "new"], "§4 共 5 个状态");

  const service = createPdevService({ repository: createFakeRepository() });
  for (const method of [
    "listProducts", "createProduct", "getProduct", "updateProduct", "deleteProduct",
    "addSource", "updateSource", "deleteSource", "addAsset", "deleteAsset",
    "addVariant", "changeStatus", "getSummary"
  ]) {
    assert.equal(typeof service[method], "function", `§10.1 冻结方法名缺失：${method}`);
  }
  for (const forbidden of ["removeProduct", "removeSource", "transitionStatus"]) {
    assert.equal(typeof service[forbidden], "undefined", `§10.1 明确要求不要用 ${forbidden}`);
  }

  const error = new PdevError("NOT_FOUND", "nope", { statusCode: 404, missing: ["x"], details: { a: 1 } });
  assert.equal(error.code, "NOT_FOUND");
  assert.equal(error.statusCode, 404);
  assert.deepEqual(error.missing, ["x"]);
  assert.deepEqual(error.details, { a: 1 });
  assert.ok(error instanceof Error);
});

test("§10.1 修正点 1：service 各方法直接返回 §5.1 包装形状", async () => {
  const { repository, service } = createHarness();
  const created = await call(service, "createProduct", { user: USER_A, title: "包装形状" });
  assert.deepEqual(Object.keys(created), ["product"]);

  const list = await call(service, "listProducts", { user: USER_A, page: 1, pageSize: 20 });
  assert.deepEqual(Object.keys(list).sort(), ["items", "page", "pageSize", "total"]);

  const detail = await call(service, "getProduct", { user: USER_A, publicId: created.product.publicId });
  assert.deepEqual(Object.keys(detail).sort(), ["assets", "product", "sources", "variants"]);

  const patched = await call(service, "updateProduct", {
    user: USER_A, publicId: created.product.publicId, expectedRowVersion: 0, patch: { title: "改后" }
  });
  assert.deepEqual(Object.keys(patched), ["product"]);

  const source = await call(service, "addSource", {
    user: USER_A, publicId: created.product.publicId, platform: "1688", sourceProductId: "S-1"
  });
  assert.deepEqual(Object.keys(source), ["source"]);
  const asset = await call(service, "addAsset", {
    user: USER_A, publicId: created.product.publicId, assetType: "main"
  });
  assert.deepEqual(Object.keys(asset), ["asset"]);
  const variant = await call(service, "addVariant", {
    user: USER_A, publicId: created.product.publicId, spec: { size: "l" }
  });
  assert.deepEqual(Object.keys(variant), ["variant"]);

  const status = await call(service, "changeStatus", {
    user: USER_A, publicId: created.product.publicId, to: "developing", expectedRowVersion: 1
  });
  assert.deepEqual(Object.keys(status), ["product"]);
  assert.equal(status.product.devStatus, "developing");

  const summary = await call(service, "getSummary", { user: USER_A });
  assert.deepEqual(Object.keys(summary).sort(), ["byStatus", "missing"]);

  const removedSource = await call(service, "deleteSource", { user: USER_A, id: source.source.id });
  assert.deepEqual(removedSource, { removed: true });
  const removedAsset = await call(service, "deleteAsset", { user: USER_A, id: asset.asset.id });
  assert.deepEqual(removedAsset, { removed: true });
  const removed = await call(service, "deleteProduct", { user: USER_A, publicId: created.product.publicId });
  assert.deepEqual(removed, { removed: true });
  assert.ok(variant && repository.__all.variants.length === 0, "删产品应连带清掉变体");
});

test("§4/§10.1 PDEV_ALLOWED_TRANSITIONS 与状态机图完全一致（archived 为终态）", () => {
  const asSet = (value) => new Set(Array.isArray(value) ? value : Object.keys(value || {}));
  const transitions = PDEV_ALLOWED_TRANSITIONS || {};
  // §4 表格：info_ready 允许来源 new/developing；任意状态 → archived；archived 终态
  assert.deepEqual([...asSet(transitions.new)].sort(), ["archived", "developing", "info_ready"]);
  assert.deepEqual([...asSet(transitions.developing)].sort(), ["archived", "info_ready"]);
  assert.deepEqual([...asSet(transitions.info_ready)].sort(), ["archived", "finalized"]);
  assert.deepEqual([...asSet(transitions.finalized)].sort(), ["archived"]);
  assert.deepEqual([...asSet(transitions.archived)], []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. §4 状态机
// ─────────────────────────────────────────────────────────────────────────────

test("§4 合法链路 new → developing → info_ready → finalized → archived，rowVersion 逐步 +1", async () => {
  const { repository, service } = createHarness();
  const created = await createProduct(service, USER_A, "露营帐篷");
  assert.equal(created.devStatus, "new");
  assert.equal(Number(created.rowVersion), 0);

  const developing = (await call(service, "changeStatus", {
    user: USER_A, publicId: created.publicId, to: "developing", expectedRowVersion: 0
  })).product;
  assert.equal(developing.devStatus, "developing");
  assert.equal(Number(developing.rowVersion), 1, "成功流转 row_version +1");

  await seedInfoReadyInputs(repository, developing);
  const infoReady = (await call(service, "changeStatus", {
    user: USER_A, publicId: created.publicId, to: "info_ready", expectedRowVersion: 1
  })).product;
  assert.equal(infoReady.devStatus, "info_ready");
  assert.equal(Number(infoReady.rowVersion), 2);

  await call(service, "addVariant", { user: USER_A, publicId: created.publicId, spec: { 尺寸: "L" } });
  const finalized = (await call(service, "changeStatus", {
    user: USER_A, publicId: created.publicId, to: "finalized", expectedRowVersion: 2
  })).product;
  assert.equal(finalized.devStatus, "finalized");

  const archived = (await call(service, "changeStatus", {
    user: USER_A, publicId: created.publicId, to: "archived", expectedRowVersion: 3
  })).product;
  assert.equal(archived.devStatus, "archived");
  assert.equal(Number(archived.rowVersion), 4);
});

test("§4 非法流转 new → finalized 被拒（400，消息说明允许来源），且不改数据", async () => {
  const { service } = createHarness();
  const created = await createProduct(service, USER_A, "越级");
  await expectPdevError(
    call(service, "changeStatus", { user: USER_A, publicId: created.publicId, to: "finalized", expectedRowVersion: 0 }),
    { code: CODE.validation, statusCode: 400, messagePattern: /info_ready/ },
    "new → finalized"
  );
  const reloaded = (await call(service, "getProduct", { user: USER_A, publicId: created.publicId })).product;
  assert.equal(reloaded.devStatus, "new", "被拒流转不得改状态");
  assert.equal(Number(reloaded.rowVersion), 0, "被拒流转不得改版本");
});

test("§4 finalized 只允许来自 info_ready：developing → finalized 400", async () => {
  const { repository, service } = createHarness();
  const created = await createProduct(service, USER_A, "developing 越级");
  await seedInfoReadyInputs(repository, created);
  await call(service, "changeStatus", { user: USER_A, publicId: created.publicId, to: "developing", expectedRowVersion: 0 });
  await expectPdevError(
    call(service, "changeStatus", { user: USER_A, publicId: created.publicId, to: "finalized", expectedRowVersion: 1 }),
    { statusCode: 400, messagePattern: /info_ready/ },
    "developing → finalized"
  );
});

test("§4/§10.3 空产品 → info_ready：missing 恰好 [noSource, noMainAsset]（noSource 优先）", async () => {
  const { service } = createHarness();
  const created = await createProduct(service, USER_A, "空壳");
  const error = await expectPdevError(
    call(service, "changeStatus", { user: USER_A, publicId: created.publicId, to: "info_ready", expectedRowVersion: 0 }),
    { statusCode: 400 },
    "空产品 → info_ready"
  );
  assert.deepEqual(missingOf(error), ["noMainAsset", "noSource"], "一个货源都没有时只报 noSource，不报 noActivePrice");
});

test("§4 有主图、资源无价或非 active → info_ready 只报 noActivePrice", async () => {
  const { repository, service } = createHarness();
  const created = await createProduct(service, USER_A, "货源不合格");
  await repository.createAsset({
    companyKey: COMPANY_A, pdevProductId: created.id, assetType: "main", sourceUrl: "https://img.example.com/m.jpg"
  });
  await repository.createSource({
    companyKey: COMPANY_A, pdevProductId: created.id, platform: "1688", sourceProductId: "S-NOPRICE", supplyPrice: null, supplyStatus: "active"
  });
  await repository.createSource({
    companyKey: COMPANY_A, pdevProductId: created.id, platform: "taobao", sourceProductId: "S-OOS", supplyPrice: 9.9, supplyStatus: "out_of_stock"
  });

  const error = await expectPdevError(
    call(service, "changeStatus", { user: USER_A, publicId: created.publicId, to: "info_ready", expectedRowVersion: 0 }),
    { statusCode: 400 },
    "资源无价 → info_ready"
  );
  assert.deepEqual(missingOf(error), ["noActivePrice"], "有货源但都不合格 → 只报 noActivePrice");
});

test("§4 有活跃有价货源但只有 gallery 图 → info_ready 只报 noMainAsset", async () => {
  const { repository, service } = createHarness();
  const created = await createProduct(service, USER_A, "缺主图");
  await repository.createSource({
    companyKey: COMPANY_A, pdevProductId: created.id, platform: "1688", sourceProductId: "S-OK", supplyPrice: 15, supplyStatus: "active"
  });
  await repository.createAsset({
    companyKey: COMPANY_A, pdevProductId: created.id, assetType: "gallery", sourceUrl: "https://img.example.com/g.jpg"
  });

  const error = await expectPdevError(
    call(service, "changeStatus", { user: USER_A, publicId: created.publicId, to: "info_ready", expectedRowVersion: 0 }),
    { statusCode: 400 },
    "缺主图 → info_ready"
  );
  assert.deepEqual(missingOf(error), ["noMainAsset"]);
});

test("§4 无变体 → finalized：missing 恰好 [noVariant]", async () => {
  const { repository, service } = createHarness();
  const created = await createProduct(service, USER_A, "无变体");
  await seedInfoReadyInputs(repository, created);
  await call(service, "changeStatus", { user: USER_A, publicId: created.publicId, to: "developing", expectedRowVersion: 0 });
  await call(service, "changeStatus", { user: USER_A, publicId: created.publicId, to: "info_ready", expectedRowVersion: 1 });

  const error = await expectPdevError(
    call(service, "changeStatus", { user: USER_A, publicId: created.publicId, to: "finalized", expectedRowVersion: 2 }),
    { statusCode: 400 },
    "无变体 → finalized"
  );
  assert.deepEqual(missingOf(error), ["noVariant"]);
});

test("§4 archived 是终态：archived → 任何状态都 400；各状态都能直接归档", async () => {
  const { repository, service } = createHarness();
  const created = await createProduct(service, USER_A, "归档");
  const archived = (await call(service, "changeStatus", {
    user: USER_A, publicId: created.publicId, to: "archived", expectedRowVersion: 0
  })).product;
  assert.equal(archived.devStatus, "archived");
  for (const to of ["new", "developing", "info_ready", "finalized", "archived"]) {
    await expectPdevError(
      call(service, "changeStatus", { user: USER_A, publicId: created.publicId, to, expectedRowVersion: 3 }),
      { statusCode: 400 },
      `archived → ${to}`
    );
  }

  for (const steps of [["developing"], ["developing", "info_ready"], ["developing", "info_ready", "finalized"]]) {
    const product = await createProduct(service, USER_A, `归档-${steps.join("-")}`);
    await seedInfoReadyInputs(repository, product);
    await call(service, "addVariant", { user: USER_A, publicId: product.publicId, spec: { s: steps.length } });
    let version = 0;
    for (const to of steps) {
      await call(service, "changeStatus", { user: USER_A, publicId: product.publicId, to, expectedRowVersion: version });
      version += 1;
    }
    const done = (await call(service, "changeStatus", {
      user: USER_A, publicId: product.publicId, to: "archived", expectedRowVersion: version
    })).product;
    assert.equal(done.devStatus, "archived", `${steps.join("→")} → archived 应允许`);
  }
});

test("§4 new → info_ready 本身合法（§4 表格允许来源 new/developing），仅受硬校验拦截", async () => {
  const { repository, service } = createHarness();
  const created = await createProduct(service, USER_A, "直接到货");
  await seedInfoReadyInputs(repository, created);
  const infoReady = (await call(service, "changeStatus", {
    user: USER_A, publicId: created.publicId, to: "info_ready", expectedRowVersion: 0
  })).product;
  assert.equal(infoReady.devStatus, "info_ready", "资料齐全时 new 可直接进 info_ready");
});

test("§4/§10.3 未知目标状态 400；expectedRowVersion 不符 409 且不改数据", async () => {
  const { service } = createHarness();
  const created = await createProduct(service, USER_A, "非法状态");
  await expectPdevError(
    call(service, "changeStatus", { user: USER_A, publicId: created.publicId, to: "published", expectedRowVersion: 0 }),
    { code: CODE.validation, statusCode: 400 },
    "new → published"
  );
  await call(service, "changeStatus", { user: USER_A, publicId: created.publicId, to: "developing", expectedRowVersion: 0 });
  await expectPdevError(
    call(service, "changeStatus", { user: USER_A, publicId: created.publicId, to: "archived", expectedRowVersion: 0 }),
    { code: CODE.version, statusCode: 409 },
    "过期 rowVersion 流转"
  );
  const reloaded = (await call(service, "getProduct", { user: USER_A, publicId: created.publicId })).product;
  assert.equal(reloaded.devStatus, "developing");
  assert.equal(Number(reloaded.rowVersion), 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. §3.4 / §5.1 variant_key
// ─────────────────────────────────────────────────────────────────────────────

test("§5.1 normalizeVariantKey：契约字面示例 + 值/键 trim 小写 + 键按码点排序 + 键序无关", () => {
  assert.equal(normalizeVariantKey({ 颜色: "黑", 尺寸: "L" }), "尺寸=l;颜色=黑", "§5.1 字面示例");
  assert.equal(normalizeVariantKey({ size: " L ", color: " Black " }), "color=black;size=l");
  assert.equal(normalizeVariantKey({ color: "Black", size: "L" }), normalizeVariantKey({ size: "l", color: "black" }));
  assert.equal(normalizeVariantKey({ a: "1", B: "2" }), "a=1;b=2");
  assert.equal(normalizeVariantKey({}), "");
});

test("§5.1 addVariant 返回归一化 variantKey 与原样 spec", async () => {
  const { service } = createHarness();
  const created = await createProduct(service, USER_A, "归一化");
  const variant = (await call(service, "addVariant", {
    user: USER_A, publicId: created.publicId, spec: { 颜色: "黑", 尺寸: "L" }
  })).variant;
  assert.equal(variant.variantKey, "尺寸=l;颜色=黑");
  assert.deepEqual(variant.spec, { 颜色: "黑", 尺寸: "L" });
  assert.equal(variant.status, "active");
  assert.deepEqual(Object.keys(variant).sort(), [...VARIANT_KEYS].sort(), "Variant 键集严格等于 §5.1");
});

test("§5.1 仅键序/大小写/空白不同的 spec 视为同一 variant_key → VARIANT_TAKEN 409", async () => {
  const { service } = createHarness();
  const created = await createProduct(service, USER_A, "重复变体");
  await call(service, "addVariant", { user: USER_A, publicId: created.publicId, spec: { 颜色: "黑", 尺寸: "L" } });
  await expectPdevError(
    call(service, "addVariant", { user: USER_A, publicId: created.publicId, spec: { 尺寸: "l", 颜色: "黑" } }),
    { code: CODE.variantTaken, statusCode: 409 },
    "重复 variant_key"
  );
});

test("§5.1 不同 spec 值 → 不同 variant_key；不同产品可有相同 variant_key", async () => {
  const { service } = createHarness();
  const one = await createProduct(service, USER_A, "产品一");
  const two = await createProduct(service, USER_A, "产品二");
  const first = (await call(service, "addVariant", { user: USER_A, publicId: one.publicId, spec: { color: "black", size: "l" } })).variant;
  const second = (await call(service, "addVariant", { user: USER_A, publicId: one.publicId, spec: { color: "black", size: "m" } })).variant;
  const third = (await call(service, "addVariant", { user: USER_A, publicId: two.publicId, spec: { color: "black", size: "l" } })).variant;
  assert.equal(first.variantKey, "color=black;size=l");
  assert.equal(second.variantKey, "color=black;size=m");
  assert.equal(third.variantKey, first.variantKey, "唯一约束按 (company, product, key)");
  assert.notEqual(third.id, first.id);
});

test("§6 spec 缺失/非对象/空对象 → VALIDATION_FAILED 400", async () => {
  const { service } = createHarness();
  const created = await createProduct(service, USER_A, "非法 spec");
  for (const spec of [undefined, null, "", 42, [], {}]) {
    await expectPdevError(
      call(service, "addVariant", { user: USER_A, publicId: created.publicId, spec }),
      { code: CODE.validation, statusCode: 400 },
      `spec=${JSON.stringify(spec)}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. §2 公司隔离与租户键
// ─────────────────────────────────────────────────────────────────────────────

test("§2 resolveCompanyKey 内置实现：trim(companyName) || trim(companyId)", () => {
  assert.equal(resolveCompanyKey({ companyName: " 系统 ", companyId: "system" }), "系统");
  assert.equal(resolveCompanyKey({ companyName: "", companyId: " CMP-MMYJG76G-B30D " }), "CMP-MMYJG76G-B30D");
  assert.equal(resolveCompanyKey({ companyName: "系统", companyId: "CMP-MMYJG76G-B30D" }),
    resolveCompanyKey({ companyName: "系统", companyId: "system" }), "同一家公司两种 companyId 写法必须同键");
  assert.equal(resolveCompanyKey({}), "");
  assert.equal(resolveCompanyKey(null), "");
});

test("§2 同一公司（companyName 相同、companyId 不同）共享同一个库", async () => {
  const { service } = createHarness();
  const created = await createProduct(service, USER_A, "A 公司产品");
  const list = await call(service, "listProducts", { user: USER_A2, page: 1, pageSize: 20 });
  assert.deepEqual(list.items.map((item) => item.publicId), [created.publicId], "§2 按 companyName 归一");
});

test("§2 A 公司看不到 B 公司：列表隔离、B 的 publicId 对 A 是 NOT_FOUND", async () => {
  const { service } = createHarness();
  const productA = await createProduct(service, USER_A, "A 的产品");
  const productB = await createProduct(service, USER_B, "B 的产品");

  const listA = await call(service, "listProducts", { user: USER_A, page: 1, pageSize: 20 });
  assert.deepEqual(listA.items.map((item) => item.publicId), [productA.publicId]);
  const listB = await call(service, "listProducts", { user: USER_B, page: 1, pageSize: 20 });
  assert.deepEqual(listB.items.map((item) => item.publicId), [productB.publicId]);

  await expectPdevError(
    call(service, "getProduct", { user: USER_A, publicId: productB.publicId }),
    { code: CODE.notFound, statusCode: 404 },
    "A 查 B 的产品"
  );
});

test("§2 前端传入的 companyKey 必须被忽略，一律以登录用户解析出的租户键为准", async () => {
  const { service } = createHarness();
  const created = await createProduct(service, USER_A, "伪造租户键", { companyKey: COMPANY_B, company_key: COMPANY_B });
  const listA = await call(service, "listProducts", { user: USER_A, page: 1, pageSize: 20 });
  assert.deepEqual(listA.items.map((item) => item.publicId), [created.publicId], "产品必须落在 A 公司");
  const listB = await call(service, "listProducts", { user: USER_B, page: 1, pageSize: 20 });
  assert.deepEqual(listB.items, [], "B 公司不得看到伪造键写入的数据");
});

test("§8 9.1/§10.1 解析不出租户键 → COMPANY_REQUIRED 400", async () => {
  const { service } = createHarness();
  await expectPdevError(
    call(service, "createProduct", { user: { id: "USR-X", companyName: "  ", companyId: "" }, title: "无租户" }),
    { code: CODE.companyRequired, statusCode: 400 },
    "空租户键建品"
  );
  await expectPdevError(
    call(service, "listProducts", { user: { id: "USR-X" }, page: 1, pageSize: 20 }),
    { code: CODE.companyRequired, statusCode: 400 },
    "空租户键列表"
  );
});

test("§2/§8 9.5 A 不能改/删 B 的产品、货源、图片、变体（404），B 数据不变", async () => {
  const { repository, service } = createHarness();
  const productB = await createProduct(service, USER_B, "B 的产品");
  const sourceB = await repository.createSource({
    companyKey: COMPANY_B, pdevProductId: productB.id, platform: "1688", sourceProductId: "S-B", supplyPrice: 5, supplyStatus: "active"
  });
  const assetB = await repository.createAsset({
    companyKey: COMPANY_B, pdevProductId: productB.id, assetType: "main", sourceUrl: "https://img.example.com/b.jpg"
  });
  const variantB = await repository.createVariant({
    companyKey: COMPANY_B, pdevProductId: productB.id, variantKey: "size=l", spec: { size: "L" }
  });

  await expectPdevError(
    call(service, "updateProduct", { user: USER_A, publicId: productB.publicId, expectedRowVersion: 0, patch: { title: "越权" } }),
    { code: CODE.notFound, statusCode: 404 }, "A 改 B 的产品"
  );
  await expectPdevError(
    call(service, "deleteProduct", { user: USER_A, publicId: productB.publicId }),
    { code: CODE.notFound, statusCode: 404 }, "A 删 B 的产品"
  );
  await expectPdevError(
    call(service, "updateSource", { user: USER_A, id: sourceB.id, supplyPrice: 0.01 }),
    { code: CODE.notFound, statusCode: 404 }, "A 改 B 的货源"
  );
  await expectPdevError(
    call(service, "deleteSource", { user: USER_A, id: sourceB.id }),
    { code: CODE.notFound, statusCode: 404 }, "A 删 B 的货源"
  );
  await expectPdevError(
    call(service, "deleteAsset", { user: USER_A, id: assetB.id }),
    { code: CODE.notFound, statusCode: 404 }, "A 删 B 的图片"
  );
  await expectPdevError(
    call(service, "changeStatus", { user: USER_A, publicId: productB.publicId, to: "archived", expectedRowVersion: 0 }),
    { code: CODE.notFound, statusCode: 404 }, "A 流转 B 的状态"
  );

  assert.ok(repository.__all.sources.some((row) => row.id === sourceB.id), "B 的货源不得被删");
  assert.ok(repository.__all.assets.some((row) => row.id === assetB.id), "B 的图片不得被删");
  assert.ok(repository.__all.variants.some((row) => row.id === variantB.id), "B 的变体不得被动");
  const stillB = (await call(service, "getProduct", { user: USER_B, publicId: productB.publicId })).product;
  assert.equal(stillB.title, "B 的产品");
});

test("§2 getSummary 只统计本公司", async () => {
  const { repository, service } = createHarness();
  await createProduct(service, USER_A, "A 产品");
  const productB = await createProduct(service, USER_B, "B 产品");
  await repository.createSource({
    companyKey: COMPANY_B, pdevProductId: productB.id, platform: "1688", sourceProductId: "S-B", supplyPrice: 3, supplyStatus: "active"
  });
  await repository.createAsset({
    companyKey: COMPANY_B, pdevProductId: productB.id, assetType: "main", sourceUrl: "https://img.example.com/b.jpg"
  });
  await repository.createVariant({ companyKey: COMPANY_B, pdevProductId: productB.id, variantKey: "size=l", spec: { size: "L" } });

  const summary = await call(service, "getSummary", { user: USER_A });
  assert.equal(Number(summary.byStatus.new), 1, "A 公司只有 1 个产品");
  assert.equal(Number(summary.byStatus.finalized), 0, "B 的状态不得计入 A");
  assert.equal(Number(summary.missing.noSource), 1);
  assert.equal(Number(summary.missing.noVariant), 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. §3.2 货源业务键
// ─────────────────────────────────────────────────────────────────────────────

test("§3.2 同公司同 platform+sourceProductId 挂第二个产品 → SOURCE_TAKEN 409 并附占用 publicId", async () => {
  const { service } = createHarness();
  const first = await createProduct(service, USER_A, "第一个");
  const second = await createProduct(service, USER_A, "第二个");
  await call(service, "addSource", {
    user: USER_A, publicId: first.publicId, platform: "1688", sourceProductId: "SKU-SHARED"
  });

  const error = await expectPdevError(
    call(service, "addSource", { user: USER_A, publicId: second.publicId, platform: "1688", sourceProductId: "SKU-SHARED" }),
    { code: CODE.sourceTaken, statusCode: 409 },
    "同公司同货源挂第二个产品"
  );
  const occupier = (error.details && error.details.publicId) || error.publicId
    || (String(error.message).match(/PD_[A-Za-z0-9_-]+/) || [])[0];
  assert.equal(occupier, first.publicId, "409 必须附占用者 publicId");
});

test("§3.2 不同公司可有相同业务键货源（唯一索引按公司）", async () => {
  const { service } = createHarness();
  const productA = await createProduct(service, USER_A, "A");
  const productB = await createProduct(service, USER_B, "B");
  const sourceA = (await call(service, "addSource", {
    user: USER_A, publicId: productA.publicId, platform: "1688", sourceProductId: "SKU-SHARED"
  })).source;
  const sourceB = (await call(service, "addSource", {
    user: USER_B, publicId: productB.publicId, platform: "1688", sourceProductId: "SKU-SHARED"
  })).source;
  assert.notEqual(sourceA.id, sourceB.id);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. §6 / §8 校验
// ─────────────────────────────────────────────────────────────────────────────

test("§6 建品 title 必填：缺失/空串/纯空白 → VALIDATION_FAILED 400", async () => {
  const { service } = createHarness();
  for (const title of [undefined, null, "", "   "]) {
    await expectPdevError(
      call(service, "createProduct", { user: USER_A, title }),
      { code: CODE.validation, statusCode: 400 },
      `title=${JSON.stringify(title)}`
    );
  }
});

test("§6 建品成功：PD_ 前缀、new、rowVersion 0、四项计数 0、title trim、createdBy 取登录用户", async () => {
  const { service } = createHarness();
  const product = await createProduct(service, USER_A, " 露营灯 ", {
    remark: "好卖", categoryHint: "户外", targetPlatform: "ozon", ownerUserId: "USR-9", createdBy: "USR-1"
  });
  assert.match(String(product.publicId), /^PD_/);
  assert.equal(product.devStatus, "new");
  assert.equal(Number(product.rowVersion), 0);
  assert.equal(product.title, "露营灯");
  assert.equal(product.ownerUserId, "USR-9");
  // §5 #2 请求体没有 createdBy：创建人必须由服务端取登录用户，客户端传的值必须被忽略
  assert.equal(product.createdBy, USER_A.id);
  assert.equal(Number(product.sourceCount), 0);
  assert.equal(Number(product.activeSourceCount), 0);
  assert.equal(Number(product.assetCount), 0);
  assert.equal(Number(product.variantCount), 0);
});

test("§8 9.2 targetPlatform 只校验 trim+长度≤32，不做枚举", async () => {
  const { service } = createHarness();
  const custom = await createProduct(service, USER_A, "自定义平台", { targetPlatform: "  my-shop  " });
  assert.equal(custom.targetPlatform, "my-shop", "只 trim，不做枚举");
  const yandex = await createProduct(service, USER_A, "yandex", { targetPlatform: "yandex" });
  assert.equal(yandex.targetPlatform, "yandex");
  await expectPdevError(
    call(service, "createProduct", { user: USER_A, title: "超长平台", targetPlatform: "x".repeat(33) }),
    { code: CODE.validation, statusCode: 400 },
    "targetPlatform 超过 32"
  );
});

test("§3.1/§6 货源 platform 枚举与 sourceProductId 必填", async () => {
  const { service } = createHarness();
  const created = await createProduct(service, USER_A, "货源校验");
  for (const platform of [undefined, null, "", "jd", "1688.com"]) {
    await expectPdevError(
      call(service, "addSource", { user: USER_A, publicId: created.publicId, platform, sourceProductId: "S-1" }),
      { code: CODE.validation, statusCode: 400 },
      `platform=${JSON.stringify(platform)}`
    );
  }
  for (const sourceProductId of [undefined, null, "", "   "]) {
    await expectPdevError(
      call(service, "addSource", { user: USER_A, publicId: created.publicId, platform: "1688", sourceProductId }),
      { code: CODE.validation, statusCode: 400 },
      `sourceProductId=${JSON.stringify(sourceProductId)}`
    );
  }
  for (const platform of ["1688", "taobao", "ozon", "other"]) {
    const source = (await call(service, "addSource", {
      user: USER_A, publicId: created.publicId, platform, sourceProductId: `S-${platform}`
    })).source;
    assert.equal(source.platform, platform);
  }
});

test("§3.3/§6 assetType：非法值 400、合法值原样落库、默认 ready、checksum null", async () => {
  const { service } = createHarness();
  const created = await createProduct(service, USER_A, "图片校验");
  for (const assetType of [undefined, null, "", "cover", "image"]) {
    await expectPdevError(
      call(service, "addAsset", { user: USER_A, publicId: created.publicId, assetType }),
      { code: CODE.validation, statusCode: 400 },
      `assetType=${JSON.stringify(assetType)}`
    );
  }
  const asset = (await call(service, "addAsset", { user: USER_A, publicId: created.publicId, assetType: "main" })).asset;
  assert.equal(asset.status, "ready");
  assert.equal(asset.checksum, null);
  for (const assetType of ["gallery", "detail", "ai"]) {
    const extra = (await call(service, "addAsset", {
      user: USER_A, publicId: created.publicId, assetType, sourceUrl: "https://img.example.com/x.jpg"
    })).asset;
    assert.equal(extra.assetType, assetType);
  }
  // §13.2（lead 裁定）：枚举大小写归一化（MAIN→main、ACTIVE→active 等）不返回 400，返回值恒为规范小写
  const upper = (await call(service, "addAsset", { user: USER_A, publicId: created.publicId, assetType: "MAIN" })).asset;
  assert.equal(upper.assetType, "main", "大小写变体必须归一为小写枚举值（§13.2）");
});

test("§13.2 枚举大小写归一化：platform / supplyStatus / devStatus / to / assetType 一律归一为小写", async () => {
  const { service } = createHarness();
  const created = await createProduct(service, USER_A, "归一化枚举");

  const source = (await call(service, "addSource", {
    user: USER_A, publicId: created.publicId, platform: "1688", sourceProductId: "S-CASE-1", supplyStatus: "ACTIVE"
  })).source;
  assert.equal(source.supplyStatus, "active");

  const ozon = (await call(service, "addSource", {
    user: USER_A, publicId: created.publicId, platform: "OZON", sourceProductId: "S-CASE-2"
  })).source;
  assert.equal(ozon.platform, "ozon");

  const listed = await call(service, "listProducts", { user: USER_A, devStatus: "NEW", page: 1, pageSize: 20 });
  assert.deepEqual(listed.items.map((item) => item.publicId), [created.publicId], "devStatus 过滤大小写不敏感");

  // §13.2 例外：supplyCurrency 是 ISO-4217 三位码，按大写归一
  const currency = (await call(service, "addSource", {
    user: USER_A, publicId: created.publicId, platform: "taobao", sourceProductId: "S-CASE-3", supplyCurrency: "cny"
  })).source;
  assert.equal(currency.supplyCurrency, "CNY", "§13.2 例外：ISO-4217 三位码按大写归一");

  const archived = (await call(service, "changeStatus", {
    user: USER_A, publicId: created.publicId, to: "ARCHIVED", expectedRowVersion: 0
  })).product;
  assert.equal(archived.devStatus, "archived", "to 状态大小写不敏感");
});

test("§8 9.4/§10.3 PATCH 空补丁 400：产品与货源都不允许空补丁", async () => {
  const { service } = createHarness();
  const created = await createProduct(service, USER_A, "空补丁");
  await expectPdevError(
    call(service, "updateProduct", { user: USER_A, publicId: created.publicId, expectedRowVersion: 0, patch: {} }),
    { code: CODE.validation, statusCode: 400, messagePattern: /字段|field/i },
    "产品空补丁"
  );
  const source = (await call(service, "addSource", {
    user: USER_A, publicId: created.publicId, platform: "1688", sourceProductId: "S-EMPTY"
  })).source;
  await expectPdevError(
    call(service, "updateSource", { user: USER_A, id: source.id }),
    { code: CODE.validation, statusCode: 400, messagePattern: /字段|field/i },
    "货源空补丁"
  );
});

test("§10.3 #1 PATCH product expectedRowVersion 必填：缺失/非整数 400，值不符 409", async () => {
  const { service } = createHarness();
  const created = await createProduct(service, USER_A, "版本必填");
  for (const expectedRowVersion of [undefined, null, "abc", 1.5, -1]) {
    await expectPdevError(
      call(service, "updateProduct", { user: USER_A, publicId: created.publicId, expectedRowVersion, patch: { title: "x" } }),
      { code: CODE.validation, statusCode: 400 },
      `expectedRowVersion=${JSON.stringify(expectedRowVersion)}`
    );
  }
  const updated = (await call(service, "updateProduct", {
    user: USER_A, publicId: created.publicId, expectedRowVersion: 0, patch: { title: "改后", remark: "备注" }
  })).product;
  assert.equal(updated.title, "改后");
  assert.equal(Number(updated.rowVersion), 1, "更新 row_version +1");

  await expectPdevError(
    call(service, "updateProduct", { user: USER_A, publicId: created.publicId, expectedRowVersion: 0, patch: { title: "并发" } }),
    { code: CODE.version, statusCode: 409 },
    "过期 rowVersion 更新"
  );
  const reloaded = (await call(service, "getProduct", { user: USER_A, publicId: created.publicId })).product;
  assert.equal(reloaded.title, "改后", "409 不得写入");
});

test("§6 不存在的产品/货源/图片 → NOT_FOUND 404", async () => {
  const { service } = createHarness();
  await expectPdevError(call(service, "getProduct", { user: USER_A, publicId: "PD_NOPE" }),
    { code: CODE.notFound, statusCode: 404 }, "未知产品详情");
  await expectPdevError(
    call(service, "addSource", { user: USER_A, publicId: "PD_NOPE", platform: "1688", sourceProductId: "S" }),
    { code: CODE.notFound, statusCode: 404 }, "给未知产品挂货源");
  await expectPdevError(
    call(service, "addAsset", { user: USER_A, publicId: "PD_NOPE", assetType: "main" }),
    { code: CODE.notFound, statusCode: 404 }, "给未知产品挂图片");
  await expectPdevError(
    call(service, "addVariant", { user: USER_A, publicId: "PD_NOPE", spec: { size: "l" } }),
    { code: CODE.notFound, statusCode: 404 }, "给未知产品建变体");
  await expectPdevError(call(service, "updateSource", { user: USER_A, id: 987654, supplyPrice: 1 }),
    { code: CODE.notFound, statusCode: 404 }, "改未知货源");
  await expectPdevError(call(service, "deleteSource", { user: USER_A, id: 987654 }),
    { code: CODE.notFound, statusCode: 404 }, "删未知货源");
  await expectPdevError(call(service, "deleteAsset", { user: USER_A, id: 987654 }),
    { code: CODE.notFound, statusCode: 404 }, "删未知图片");
  await expectPdevError(call(service, "deleteProduct", { user: USER_A, publicId: "PD_NOPE" }),
    { code: CODE.notFound, statusCode: 404 }, "删未知产品");
});

test("§5 #5 deleteProduct 连带删除 sources/assets/variants", async () => {
  const { repository, service } = createHarness();
  const created = await createProduct(service, USER_A, "待删");
  await repository.createSource({ companyKey: COMPANY_A, pdevProductId: created.id, platform: "1688", sourceProductId: "S-D", supplyPrice: 1, supplyStatus: "active" });
  await repository.createAsset({ companyKey: COMPANY_A, pdevProductId: created.id, assetType: "main", sourceUrl: "https://img.example.com/d.jpg" });
  await repository.createVariant({ companyKey: COMPANY_A, pdevProductId: created.id, variantKey: "size=l", spec: { size: "L" } });

  const result = await call(service, "deleteProduct", { user: USER_A, publicId: created.publicId });
  assert.deepEqual(result, { removed: true });
  await expectPdevError(call(service, "getProduct", { user: USER_A, publicId: created.publicId }),
    { code: CODE.notFound, statusCode: 404 }, "删除后再查");
  assert.equal(repository.__all.sources.length, 0);
  assert.equal(repository.__all.assets.length, 0);
  assert.equal(repository.__all.variants.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. §5 #1 / #13 列表与汇总
// ─────────────────────────────────────────────────────────────────────────────

test("§5 #1 listProducts：分页字段、devStatus/q 过滤、计数随子表", async () => {
  const { repository, service } = createHarness();
  await createProduct(service, USER_A, "露营帐篷");
  const lamp = await createProduct(service, USER_A, "露营灯");
  const chair = await createProduct(service, USER_A, "办公椅");
  await call(service, "changeStatus", { user: USER_A, publicId: chair.publicId, to: "developing", expectedRowVersion: 0 });
  await repository.createSource({ companyKey: COMPANY_A, pdevProductId: lamp.id, platform: "1688", sourceProductId: "S-L", supplyPrice: 3, supplyStatus: "active" });

  const all = await call(service, "listProducts", { user: USER_A, page: 1, pageSize: 20 });
  assert.equal(Number(all.total), 3);
  assert.equal(Number(all.page), 1);
  assert.equal(Number(all.pageSize), 20);
  assert.equal(all.items.length, 3);
  const lampItem = all.items.find((item) => item.publicId === lamp.publicId);
  assert.equal(Number(lampItem.sourceCount), 1);
  assert.equal(Number(lampItem.activeSourceCount), 1);
  assert.equal(Number(lampItem.variantCount), 0);

  const keyword = await call(service, "listProducts", { user: USER_A, q: "露营", page: 1, pageSize: 20 });
  assert.equal(Number(keyword.total), 2);

  const filtered = await call(service, "listProducts", { user: USER_A, devStatus: "developing", page: 1, pageSize: 20 });
  assert.deepEqual(filtered.items.map((item) => item.publicId), [chair.publicId]);

  const paged = await call(service, "listProducts", { user: USER_A, page: 2, pageSize: 2 });
  assert.equal(paged.items.length, 1);
  assert.equal(Number(paged.total), 3);
});

test("§11.1 列表项带 missing（顺序固定），§11.5 判定与 counts 精确一致", async () => {
  const { repository, service } = createHarness();
  const empty = await createProduct(service, USER_A, "空产品");
  const ready = await createProduct(service, USER_A, "资料齐全");
  await seedInfoReadyInputs(repository, ready);

  const list = await call(service, "listProducts", { user: USER_A, page: 1, pageSize: 20 });
  for (const item of list.items) {
    assert.ok(Array.isArray(item.missing), "§11.1 列表项必须有 missing: string[]");
    for (const token of item.missing) assert.ok(MISSING_VOCAB.includes(token), `未知 token ${token}`);
    const order = item.missing.map((token) => MISSING_ORDER.indexOf(token));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "§11.1 missing 顺序必须固定");
    assert.deepEqual(Object.keys(item).sort(), [...PRODUCT_KEYS, "missing"].sort(), "ProductSummary 键集 = Product + missing");
  }
  assert.deepEqual(list.items.find((item) => item.publicId === empty.publicId).missing,
    ["noSource", "noMainAsset", "noVariant"], "§11.5：无货源/无主图/无变体");
  assert.deepEqual(list.items.find((item) => item.publicId === ready.publicId).missing,
    ["noVariant"], "§11.5：有 active 且有价货源 + main 图，仍缺变体");
});


test("§11.6 判定同源：列表项 missing 与 §4 硬校验 missing 完全一致", async () => {
  const { repository, service } = createHarness();
  const bare = await createProduct(service, USER_A, "缺一切");
  const readyNew = await createProduct(service, USER_A, "齐全无变体");
  await seedInfoReadyInputs(repository, readyNew);
  const galleryOnly = await createProduct(service, USER_A, "缺主图有变体");
  await repository.createSource({ companyKey: COMPANY_A, pdevProductId: galleryOnly.id, platform: "1688", sourceProductId: "S-G", supplyPrice: 5, supplyStatus: "active" });
  await repository.createVariant({ companyKey: COMPANY_A, pdevProductId: galleryOnly.id, variantKey: "size=l", spec: { size: "L" } });
  const readyInfo = await createProduct(service, USER_A, "已就绪无变体");
  await seedInfoReadyInputs(repository, readyInfo);
  const fullInfo = await createProduct(service, USER_A, "已就绪有变体");
  await seedInfoReadyInputs(repository, fullInfo);
  await repository.createVariant({ companyKey: COMPANY_A, pdevProductId: fullInfo.id, variantKey: "size=l", spec: { size: "L" } });

  // missing 与状态无关，先取列表快照
  const list = await call(service, "listProducts", { user: USER_A, page: 1, pageSize: 100 });
  const itemMissing = (publicId) => [...list.items.find((item) => item.publicId === publicId).missing];

  // 只在「来源状态合法」时比较硬校验结果，避免把流转不合法 400 误当成硬校验 400
  const hardCheckMissing = async (publicId, to, expectedRowVersion) => {
    try {
      await call(service, "changeStatus", { user: USER_A, publicId, to, expectedRowVersion });
      return [];
    } catch (error) {
      assert.ok(error instanceof PdevError, "应抛 PdevError");
      assert.ok(Array.isArray(error.missing), "硬校验 400 必须带 missing");
      return [...error.missing].sort();
    }
  };

  // ① info_ready 硬校验：对仍在 new 的商品比较（§4 允许 new → info_ready）
  for (const product of [bare, readyNew, galleryOnly]) {
    const infoTokens = itemMissing(product.publicId).filter((token) => token !== "noVariant").sort();
    assert.deepEqual(await hardCheckMissing(product.publicId, "info_ready", 0), infoTokens,
      `${product.title}: info_ready 硬校验必须与列表 missing 同源`);
  }

  // ② finalized 硬校验：§4 只允许 info_ready → finalized，先把商品显式推到 info_ready
  for (const product of [readyInfo, fullInfo]) {
    const moved = await call(service, "changeStatus", { user: USER_A, publicId: product.publicId, to: "info_ready", expectedRowVersion: 0 });
    assert.equal(moved.product.devStatus, "info_ready");
  }
  for (const product of [readyInfo, fullInfo]) {
    const finalTokens = itemMissing(product.publicId).filter((token) => token === "noVariant");
    assert.deepEqual(await hardCheckMissing(product.publicId, "finalized", 1), finalTokens,
      `${product.title}: finalized 硬校验必须与列表 missing 同源`);
  }
});


test("§5 #13 getSummary：byStatus 5 键 + missing 4 键恒在，计数正确", async () => {
  const { repository, service } = createHarness();
  await createProduct(service, USER_A, "空产品");
  const ready = await createProduct(service, USER_A, "资料齐全");
  await seedInfoReadyInputs(repository, ready);
  await call(service, "changeStatus", { user: USER_A, publicId: ready.publicId, to: "developing", expectedRowVersion: 0 });
  await call(service, "changeStatus", { user: USER_A, publicId: ready.publicId, to: "info_ready", expectedRowVersion: 1 });

  const summary = await call(service, "getSummary", { user: USER_A });
  assert.deepEqual(Object.keys(summary.byStatus).sort(), ["archived", "developing", "finalized", "info_ready", "new"]);
  assert.deepEqual(Object.keys(summary.missing).sort(), ["noActivePrice", "noMainAsset", "noSource", "noVariant"]);
  assert.equal(Number(summary.byStatus.new), 1);
  assert.equal(Number(summary.byStatus.info_ready), 1);
  assert.equal(Number(summary.missing.noSource), 1);
  assert.equal(Number(summary.missing.noMainAsset), 1);
  assert.equal(Number(summary.missing.noVariant), 2);
});

test("§10.1 行映射：service 产出对象严格等于 §5.1 键集且不含 company_key", async () => {
  const { repository, service } = createHarness();
  const created = await createProduct(service, USER_A, "键集");
  const source = (await call(service, "addSource", {
    user: USER_A, publicId: created.publicId, platform: "1688", sourceProductId: "S-K"
  })).source;
  const asset = (await call(service, "addAsset", {
    user: USER_A, publicId: created.publicId, assetType: "main"
  })).asset;
  const variant = (await call(service, "addVariant", {
    user: USER_A, publicId: created.publicId, spec: { size: "l" }
  })).variant;
  assert.equal(repository.__all.products.length, 1);

  const expected = { product: PRODUCT_KEYS, source: SOURCE_KEYS, asset: ASSET_KEYS, variant: VARIANT_KEYS };
  for (const [label, value] of Object.entries({ product: created, source, asset, variant })) {
    assert.deepEqual(Object.keys(value).sort(), [...expected[label]].sort(), `${label} 键集必须严格等于 §5.1`);
    assert.equal(Object.prototype.hasOwnProperty.call(value, "company_key"), false, `${label} 不得含 company_key`);
    assert.equal(Object.prototype.hasOwnProperty.call(value, "companyKey"), false, `${label} 不得含 companyKey`);
  }
});
