"use strict";
// 产品开发库 · 路由契约测试（契约 §5 的 13 个接口 / §5.1 对象形状 / §6 错误码 / §10 v1.2 / §11 v1.3）
//
// 进程内跑：真 pdev-routes + 真 pdev-service + 内存假 repository（模仿真 repository 的对外行为），
// 绝不连数据库。断言的是 HTTP 契约：状态码、响应体形状（§5.1 严格键集）、错误分支、
// missing 字段与过滤、跨公司越权 404，以及不得泄露 company_key。
// 调用面按 §10 硬断言：
//   createPdevRoutes({ pdevService, authService, respondApi, parseJsonBody, maskSensitive })

const test = require("node:test");
const assert = require("node:assert/strict");

const { createPdevRoutes } = require("./pdev-routes");
const { createPdevService } = require("./pdev-service");

// ─────────────────────────────────────────────────────────────────────────────
// §5.1 / §11.1 对象形状（严格键集：多一个键都算不合格，顺带卡住 company_key 泄漏）
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCT_KEYS = [
  "id", "publicId", "title", "remark", "categoryHint", "targetPlatform", "devStatus",
  "ownerUserId", "createdBy", "createdAt", "updatedAt", "rowVersion",
  "sourceCount", "activeSourceCount", "assetCount", "variantCount"
];
const PRODUCT_SUMMARY_KEYS = [...PRODUCT_KEYS, "missing"]; // §11.1
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

const MISSING_ORDER = ["noSource", "noActivePrice", "noMainAsset", "noVariant"];

function assertExactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}: 应为对象，实际 ${JSON.stringify(value)}`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label}: 键集必须与契约完全一致`);
}

function assertProductShape(product, label = "Product") {
  assertExactKeys(product, PRODUCT_KEYS, label);
  assert.match(String(product.publicId), /^PD_/, `${label}.publicId 应为 PD_ 前缀`);
  assert.ok(Number.isFinite(Number(product.rowVersion)), `${label}.rowVersion 应为数字`);
}

function assertProductSummaryShape(item, label = "ProductSummary") {
  assertExactKeys(item, PRODUCT_SUMMARY_KEYS, label);
  assert.ok(Array.isArray(item.missing), `${label}.missing 必须是数组（§11.1）`);
  for (const token of item.missing) {
    assert.ok(MISSING_ORDER.includes(token), `${label}.missing 含未知 token ${token}`);
  }
  const order = item.missing.map((token) => MISSING_ORDER.indexOf(token));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), `${label}.missing 顺序必须固定为 ${MISSING_ORDER.join(",")}`);
}

function assertNoCompanyKeyLeak(payload) {
  const text = JSON.stringify(payload === undefined ? null : payload);
  assert.ok(!/company_key|companyKey/.test(text), `响应体不得泄露租户键 company_key：${text.slice(0, 400)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 假 repository：内部 DB 行 → §5.1 映射（与 pdev-service.test.js 同源）
//
// §12.6 验证边界：本文件只能验证路由/服务的编排、状态码与 §5.1 形状；
// SQL 谓词、唯一索引、事务级联、DATETIME 映射由 pdev.integration.test.js 在真实 MySQL 上兜底。
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

  const findProductRowById = (id) => products.find((row) => Number(row.id) === Number(id)) || null;

  const PRODUCT_PATCH_COLUMNS = {
    title: "title", remark: "remark", categoryHint: "category_hint", targetPlatform: "target_platform",
    devStatus: "dev_status", ownerUserId: "owner_user_id", createdBy: "created_by"
  };
  const SOURCE_PATCH_COLUMNS = {
    sourceUrl: "source_url", supplyPrice: "supply_price", supplyCurrency: "supply_currency",
    moq: "moq", supplierName: "supplier_name", supplyStatus: "supply_status", note: "note"
  };

  function applyPatch(row, patch, columns) {
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      row[column] = patch[key];
    }
    row.updated_at = TS;
    return row;
  }

  const repository = {
    __all: { products, sources, assets, variants },

    async ensureTables() {},

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

  return repository;
}

// ─────────────────────────────────────────────────────────────────────────────
// 路由装配（进程内）+ 调用助手
// ─────────────────────────────────────────────────────────────────────────────

const USER_A = { id: "USR-A", companyName: "系统", companyId: "system" };
const USER_B = { id: "USR-B", companyName: "另一家公司", companyId: "CMP-B" };

function createApiHarness() {
  const repository = createFakeRepository();
  // §10.1：不注入 resolveCompanyKey，走内置 §2 实现；routes 只做编排，只吃 pdevService。
  const pdevService = createPdevService({ repository });
  const state = { body: undefined, query: {}, user: USER_A, authenticated: true, respondApiCalls: [] };

  // 真 authService.requireAuth 会自己写 401 响应；这里同样写进 res。
  const authService = {
    requireAuth(req, res) {
      if (!state.authenticated) {
        res.statusCode = 401;
        res.payload = { message: "Unauthorized" };
        return { ok: false, user: null };
      }
      return { ok: true, user: state.user };
    },
    checkPermission() {
      return true;
    }
  };

  const respondApi = (...args) => {
    const res = args[1];
    const statusCode = args.find((arg) => typeof arg === "number") || 200;
    const payload = args[args.length - 1];
    res.statusCode = statusCode;
    res.payload = payload;
    state.respondApiCalls.push({ statusCode, payload });
  };

  const parseJsonBody = async (req) => {
    const body = state.body === undefined ? {} : state.body;
    if (req) req.body = body;
    return body;
  };

  const routes = createPdevRoutes({
    pdevService,
    authService,
    respondApi,
    parseJsonBody,
    maskSensitive: (value) => value
  });

  return { repository, pdevService, routes, state };
}

const THIRTEEN = [
  ["GET", "/api/product-dev/products"],
  ["POST", "/api/product-dev/products"],
  ["GET", "/api/product-dev/products/PD_X"],
  ["PATCH", "/api/product-dev/products/PD_X"],
  ["DELETE", "/api/product-dev/products/PD_X"],
  ["POST", "/api/product-dev/products/PD_X/sources"],
  ["PATCH", "/api/product-dev/sources/1"],
  ["DELETE", "/api/product-dev/sources/1"],
  ["POST", "/api/product-dev/products/PD_X/assets"],
  ["DELETE", "/api/product-dev/assets/1"],
  ["POST", "/api/product-dev/products/PD_X/variants"],
  ["POST", "/api/product-dev/products/PD_X/status"],
  ["GET", "/api/product-dev/summary"]
];

// 忠实复刻 server.js 的调用方式与全局兜底：handler 未捕获的异常 → statusCode / 500。
async function callApi(harness, method, pathname, options = {}) {
  harness.state.body = options.body;
  harness.state.query = options.query || {};
  harness.state.user = options.user || USER_A;
  harness.state.authenticated = options.authenticated !== false;

  const route = harness.routes.find((entry) => entry.matches(pathname, method));
  if (!route) throw new Error(`路由缺失：${method} ${pathname}（契约 §5 必须提供 13 个接口）`);

  const req = { method, url: pathname, headers: {} };
  const res = { statusCode: 200, headers: {}, payload: undefined };
  try {
    await route.handler(req, res, harness.state.query, {}, pathname);
  } catch (error) {
    const thrown = Number(error && error.statusCode) || 500;
    res.unhandledError = error;
    if (thrown >= 500) {
      res.statusCode = 500;
      res.payload = { message: "Internal server error" };
    } else {
      res.statusCode = thrown;
      res.payload = { message: String((error && error.message) || "Bad request") };
    }
  }
  return res;
}

// ── 数据准备（全部走契约接口） ──

async function createProduct(harness, fields = {}, user = USER_A) {
  const res = await callApi(harness, "POST", "/api/product-dev/products", { body: { title: "测试产品", ...fields }, user });
  assert.equal(res.statusCode, 201, `建品应 201，实际 ${res.statusCode} ${JSON.stringify(res.payload)}`);
  return res.payload.product;
}

async function addSource(harness, publicId, fields = {}, user = USER_A) {
  const res = await callApi(harness, "POST", `/api/product-dev/products/${publicId}/sources`, {
    body: { platform: "1688", sourceProductId: `S-${nextId()}`, ...fields }, user
  });
  assert.equal(res.statusCode, 201, `挂货源应 201，实际 ${res.statusCode} ${JSON.stringify(res.payload)}`);
  return res.payload.source;
}

async function addAsset(harness, publicId, fields = {}, user = USER_A) {
  const res = await callApi(harness, "POST", `/api/product-dev/products/${publicId}/assets`, {
    body: { assetType: "main", sourceUrl: "https://img.example.com/a.jpg", ...fields }, user
  });
  assert.equal(res.statusCode, 201, `挂图片应 201，实际 ${res.statusCode} ${JSON.stringify(res.payload)}`);
  return res.payload.asset;
}

async function addVariant(harness, publicId, fields = {}, user = USER_A) {
  const res = await callApi(harness, "POST", `/api/product-dev/products/${publicId}/variants`, {
    body: { spec: { size: "l" }, ...fields }, user
  });
  assert.equal(res.statusCode, 201, `建变体应 201，实际 ${res.statusCode} ${JSON.stringify(res.payload)}`);
  return res.payload.variant;
}

// 让商品满足 info_ready 硬校验：active 且有价货源 + main 图
async function makeInfoReadyInputs(harness, publicId, user = USER_A) {
  await addSource(harness, publicId, { supplyPrice: 12.5, supplyStatus: "active" }, user);
  await addAsset(harness, publicId, { assetType: "main" }, user);
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. 冻结调用面
// ─────────────────────────────────────────────────────────────────────────────

test("冻结调用面：createPdevRoutes 注册契约 §5 的 13 个接口 + 1 个编辑日志接口（共 14）", () => {
  const harness = createApiHarness();
  assert.ok(Array.isArray(harness.routes), "createPdevRoutes(deps) 必须返回路由数组");
  // 13 = 契约 §5 冻结的接口；+1 = GET /products/:publicId/logs（编辑日志，需求新增，仅需登录即可读，
  // 因此不占用 pdev.write 权限）。契约 §5 的 13 个接口本身没有增删改。
  assert.equal(harness.routes.length, 14, "§5 共 13 个接口 + 1 个日志接口");
  for (const route of harness.routes) {
    assert.equal(typeof route.matches, "function", "每个路由必须有 matches(pathname, method)");
    assert.equal(typeof route.handler, "function", "每个路由必须有 handler(req,res,query,auditBase,pathname)");
  }
  for (const [method, path] of THIRTEEN) {
    const matched = harness.routes.filter((route) => route.matches(path, method));
    assert.equal(matched.length, 1, `${method} ${path} 应恰好匹配 1 条路由，实际 ${matched.length}`);
  }
});

test("§5 未登录：13 个接口全部 401 + { message }", async () => {
  const harness = createApiHarness();
  for (const [method, path] of THIRTEEN) {
    const res = await callApi(harness, method, path, { authenticated: false, body: {} });
    assert.equal(res.statusCode, 401, `${method} ${path} 未登录应 401，实际 ${res.statusCode} ${JSON.stringify(res.payload)}`);
    assert.ok(res.payload && typeof res.payload.message === "string" && res.payload.message.length > 0, "401 体应含 message");
    assertNoCompanyKeyLeak(res.payload);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /api/product-dev/products
// ─────────────────────────────────────────────────────────────────────────────

test("§5 #1 列表：200 { items, total, page, pageSize }，items 为 §5.1 ProductSummary（含 §11.1 missing）", async () => {
  const harness = createApiHarness();
  await createProduct(harness, { title: "露营帐篷" });
  await createProduct(harness, { title: "办公椅" });

  const res = await callApi(harness, "GET", "/api/product-dev/products");
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.deepEqual(Object.keys(res.payload).sort(), ["items", "page", "pageSize", "total"]);
  assert.equal(Number(res.payload.total), 2);
  assert.equal(Number(res.payload.page), 1);
  assert.equal(Number(res.payload.pageSize), 20, "pageSize 默认 20");
  assert.equal(res.payload.items.length, 2);
  for (const item of res.payload.items) assertProductSummaryShape(item);
  assert.deepEqual(res.payload.items[0].missing, ["noSource", "noMainAsset", "noVariant"]);
  assertNoCompanyKeyLeak(res.payload);
});

test("§5 #1 列表：devStatus / q 过滤生效；§10.3 #4 分页非法值 clamp（page 默认 1、pageSize 默认 20 上限 100）", async () => {
  const harness = createApiHarness();
  const tent = await createProduct(harness, { title: "露营帐篷" });
  await createProduct(harness, { title: "办公椅" });
  await callApi(harness, "POST", `/api/product-dev/products/${tent.publicId}/status`, { body: { to: "developing" } });

  const byKeyword = await callApi(harness, "GET", "/api/product-dev/products", { query: { q: "露营" } });
  assert.equal(Number(byKeyword.payload.total), 1);
  assert.equal(byKeyword.payload.items[0].publicId, tent.publicId);

  const byStatus = await callApi(harness, "GET", "/api/product-dev/products", { query: { devStatus: "developing" } });
  assert.equal(Number(byStatus.payload.total), 1);
  assert.equal(byStatus.payload.items[0].devStatus, "developing");

  const huge = await callApi(harness, "GET", "/api/product-dev/products", { query: { pageSize: "1000" } });
  assert.equal(huge.statusCode, 200, "分页非法值不返回 400");
  assert.equal(Number(huge.payload.pageSize), 100, "pageSize 上限 100");

  // §9.3/§10.3 #4 + §13.1（lead 裁定）：不可解析 → 默认 20；可解析但越界 → 夹到边界（下限 1、上限 100）
  const unparsable = await callApi(harness, "GET", "/api/product-dev/products", { query: { pageSize: "abc" } });
  assert.equal(unparsable.statusCode, 200);
  assert.equal(Number(unparsable.payload.pageSize), 20, "不可解析的 pageSize 回落默认 20");

  for (const pageSize of ["0", "-5"]) {
    const res = await callApi(harness, "GET", "/api/product-dev/products", { query: { pageSize } });
    assert.equal(res.statusCode, 200, `pageSize=${pageSize} 不返回 400`);
    assert.equal(Number(res.payload.pageSize), 1, `pageSize=${pageSize} 夹到下限 1`);
  }

  for (const page of ["abc", "0", "-5"]) {
    const res = await callApi(harness, "GET", "/api/product-dev/products", { query: { page } });
    assert.equal(res.statusCode, 200, `page=${page} 不返回 400`);
    assert.equal(Number(res.payload.page), 1, `page=${page} 应 clamp 到 1`);
  }
});


test("§11.6 判定同源：列表项 missing 与 §4 硬校验 missing 完全一致", async () => {
  const harness = createApiHarness();
  const bare = await createProduct(harness, { title: "缺一切" });
  const readyNew = await createProduct(harness, { title: "齐全无变体" });
  await makeInfoReadyInputs(harness, readyNew.publicId);
  const galleryOnly = await createProduct(harness, { title: "缺主图有变体" });
  await addSource(harness, galleryOnly.publicId, { supplyPrice: 5, supplyStatus: "active" });
  await addVariant(harness, galleryOnly.publicId, { spec: { size: "l" } });
  const readyInfo = await createProduct(harness, { title: "已就绪无变体" });
  await makeInfoReadyInputs(harness, readyInfo.publicId);
  const fullInfo = await createProduct(harness, { title: "已就绪有变体" });
  await makeInfoReadyInputs(harness, fullInfo.publicId);
  await addVariant(harness, fullInfo.publicId, { spec: { size: "l" } });

  // missing 与状态无关，先取列表快照
  const list = await callApi(harness, "GET", "/api/product-dev/products");
  const itemMissing = (publicId) => [...list.payload.items.find((item) => item.publicId === publicId).missing];

  // 只在「来源状态合法」时比较硬校验结果，避免把流转不合法 400 误当成硬校验 400
  const hardCheckMissing = async (publicId, to, expectedRowVersion) => {
    const res = await callApi(harness, "POST", `/api/product-dev/products/${publicId}/status`, {
      body: { to, expectedRowVersion }
    });
    if (res.statusCode === 200) return [];
    assert.equal(res.statusCode, 400, JSON.stringify(res.payload));
    assert.ok(Array.isArray(res.payload.missing), "硬校验 400 必须带 missing");
    return [...res.payload.missing].sort();
  };

  // ① info_ready 硬校验：对仍在 new 的商品比较（§4 允许 new → info_ready）
  for (const product of [bare, readyNew, galleryOnly]) {
    const infoTokens = itemMissing(product.publicId).filter((token) => token !== "noVariant").sort();
    assert.deepEqual(await hardCheckMissing(product.publicId, "info_ready", 0), infoTokens,
      `${product.title}: info_ready 硬校验必须与列表 missing 同源`);
  }

  // ② finalized 硬校验：§4 只允许 info_ready → finalized，先把商品显式推到 info_ready
  for (const product of [readyInfo, fullInfo]) {
    const moved = await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/status`, {
      body: { to: "info_ready", expectedRowVersion: 0 }
    });
    assert.equal(moved.statusCode, 200, JSON.stringify(moved.payload));
  }
  for (const product of [readyInfo, fullInfo]) {
    const finalTokens = itemMissing(product.publicId).filter((token) => token === "noVariant");
    assert.deepEqual(await hardCheckMissing(product.publicId, "finalized", 1), finalTokens,
      `${product.title}: finalized 硬校验必须与列表 missing 同源`);
  }
});


test("§2 列表按公司隔离：A 看不到 B 的产品", async () => {
  const harness = createApiHarness();
  const productA = await createProduct(harness, { title: "A 的产品" }, USER_A);
  await createProduct(harness, { title: "B 的产品" }, USER_B);

  const listA = await callApi(harness, "GET", "/api/product-dev/products", { user: USER_A });
  assert.deepEqual(listA.payload.items.map((item) => item.publicId), [productA.publicId]);
  assert.equal(Number(listA.payload.total), 1);
  assertNoCompanyKeyLeak(listA.payload);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. POST /api/product-dev/products
// ─────────────────────────────────────────────────────────────────────────────

test("§5 #2 建品：201 { product }，形状严格、初始 new/版本 0、createdBy 取登录用户", async () => {
  const harness = createApiHarness();
  const res = await callApi(harness, "POST", "/api/product-dev/products", {
    body: { title: "露营灯", remark: "好卖", categoryHint: "户外", targetPlatform: "ozon", ownerUserId: "USR-9", createdBy: "伪造创建人" }
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  assert.deepEqual(Object.keys(res.payload), ["product"], "成功体就是 { product }，不包 data");
  assertProductShape(res.payload.product);
  assert.equal(res.payload.product.devStatus, "new");
  assert.equal(Number(res.payload.product.rowVersion), 0);
  assert.equal(res.payload.product.ownerUserId, "USR-9");
  assert.equal(res.payload.product.createdBy, USER_A.id, "创建人必须取登录用户，客户端传的必须忽略");
  assertNoCompanyKeyLeak(res.payload);
});

test("§6 建品缺 title / title 纯空白：400 + { message }（可带 missing）", async () => {
  const harness = createApiHarness();
  for (const body of [{}, { title: "" }, { title: "   " }, { title: null }]) {
    const res = await callApi(harness, "POST", "/api/product-dev/products", { body });
    assert.equal(res.statusCode, 400, `body=${JSON.stringify(body)} 应 400，实际 ${res.statusCode}`);
    assert.equal(typeof res.payload.message, "string");
    const identified = /title|标题/i.test(res.payload.message)
      || (Array.isArray(res.payload.missing) && res.payload.missing.some((token) => /title|标题/i.test(String(token))));
    assert.ok(identified, `400 必须指出缺 title：${JSON.stringify(res.payload)}`);
    assertNoCompanyKeyLeak(res.payload);
  }
});

test("§8 9.2 targetPlatform 只 trim + 长度≤32，不做枚举", async () => {
  const harness = createApiHarness();
  const custom = await callApi(harness, "POST", "/api/product-dev/products", {
    body: { title: "自定义平台", targetPlatform: "  my-shop  " }
  });
  assert.equal(custom.statusCode, 201, JSON.stringify(custom.payload));
  assert.equal(custom.payload.product.targetPlatform, "my-shop", "不做枚举，只 trim");

  const tooLong = await callApi(harness, "POST", "/api/product-dev/products", {
    body: { title: "超长平台", targetPlatform: "x".repeat(33) }
  });
  assert.equal(tooLong.statusCode, 400, "长度 > 32 应 400");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /api/product-dev/products/:publicId
// ─────────────────────────────────────────────────────────────────────────────

test("§5 #3 详情：200 { product, sources, assets, variants }，四个形状都按 §5.1", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "详情" });
  await addSource(harness, product.publicId, { sourceProductId: "SRC-1", supplyPrice: 12.5, supplyStatus: "active" });
  await addAsset(harness, product.publicId, { assetType: "main" });
  await addVariant(harness, product.publicId, { spec: { 颜色: "黑", 尺寸: "L" } });

  const res = await callApi(harness, "GET", `/api/product-dev/products/${product.publicId}`);
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.deepEqual(Object.keys(res.payload).sort(), ["assets", "product", "sources", "variants"]);
  assertProductShape(res.payload.product);
  assert.equal(res.payload.product.sourceCount, 1);
  assert.equal(res.payload.product.activeSourceCount, 1);
  assert.equal(res.payload.product.assetCount, 1);
  assert.equal(res.payload.product.variantCount, 1);
  assert.equal(res.payload.sources.length, 1);
  assert.equal(res.payload.assets.length, 1);
  assert.equal(res.payload.variants.length, 1);
  assertExactKeys(res.payload.sources[0], SOURCE_KEYS, "Source");
  assert.equal(res.payload.sources[0].supplyPrice, 12.5);
  assert.equal(res.payload.sources[0].pdevProductId, res.payload.product.id);
  assertExactKeys(res.payload.assets[0], ASSET_KEYS, "Asset");
  assert.equal(res.payload.assets[0].checksum, null);
  assertExactKeys(res.payload.variants[0], VARIANT_KEYS, "Variant");
  assert.equal(res.payload.variants[0].variantKey, "尺寸=l;颜色=黑");
  assert.deepEqual(res.payload.variants[0].spec, { 颜色: "黑", 尺寸: "L" });
  assertNoCompanyKeyLeak(res.payload);
});

test("§6 详情：不存在 → 404；他公司的 publicId → 404（不泄露存在性）", async () => {
  const harness = createApiHarness();
  const missing = await callApi(harness, "GET", "/api/product-dev/products/PD_NOPE");
  assert.equal(missing.statusCode, 404);
  assert.equal(typeof missing.payload.message, "string");

  const productB = await createProduct(harness, { title: "B 的产品" }, USER_B);
  const crossCompany = await callApi(harness, "GET", `/api/product-dev/products/${productB.publicId}`, { user: USER_A });
  assert.equal(crossCompany.statusCode, 404, "B 公司的 publicId 对 A 必须是 404");
  assert.equal(crossCompany.payload.message, missing.payload.message, "不得用不同消息泄露存在性");
  assertNoCompanyKeyLeak(crossCompany.payload);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PATCH /api/product-dev/products/:publicId
// ─────────────────────────────────────────────────────────────────────────────

test("§5 #4 改产品：200 { product }，rowVersion +1", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "改前" });
  const res = await callApi(harness, "PATCH", `/api/product-dev/products/${product.publicId}`, {
    body: { expectedRowVersion: 0, patch: { title: "改后", remark: "备注" } }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.deepEqual(Object.keys(res.payload), ["product"]);
  assertProductShape(res.payload.product);
  assert.equal(res.payload.product.title, "改后");
  assert.equal(res.payload.product.remark, "备注");
  assert.equal(Number(res.payload.product.rowVersion), 1);
  assertNoCompanyKeyLeak(res.payload);
});

test("§6 改产品：expectedRowVersion 不符 → 409；未知 publicId → 404", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "并发" });
  await callApi(harness, "PATCH", `/api/product-dev/products/${product.publicId}`, {
    body: { expectedRowVersion: 0, patch: { title: "第一次" } }
  });

  const conflict = await callApi(harness, "PATCH", `/api/product-dev/products/${product.publicId}`, {
    body: { expectedRowVersion: 0, patch: { title: "并发覆盖" } }
  });
  assert.equal(conflict.statusCode, 409, JSON.stringify(conflict.payload));
  assert.equal(typeof conflict.payload.message, "string");

  const notFound = await callApi(harness, "PATCH", "/api/product-dev/products/PD_NOPE", {
    body: { expectedRowVersion: 0, patch: { title: "x" } }
  });
  assert.equal(notFound.statusCode, 404);
  assertNoCompanyKeyLeak(conflict.payload);
});

test("§10.3 #1 PATCH product expectedRowVersion 必填：缺失/非整数 → 400（不是 409）", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "版本必填" });
  for (const body of [
    { patch: { title: "x" } },
    { expectedRowVersion: null, patch: { title: "x" } },
    { expectedRowVersion: "abc", patch: { title: "x" } },
    { expectedRowVersion: 1.5, patch: { title: "x" } },
    { expectedRowVersion: -1, patch: { title: "x" } }
  ]) {
    const res = await callApi(harness, "PATCH", `/api/product-dev/products/${product.publicId}`, { body });
    assert.equal(res.statusCode, 400, `body=${JSON.stringify(body)} 应 400，实际 ${res.statusCode} ${JSON.stringify(res.payload)}`);
    assert.equal(typeof res.payload.message, "string");
  }
  const version = (await callApi(harness, "GET", `/api/product-dev/products/${product.publicId}`)).payload.product.rowVersion;
  assert.equal(Number(version), 0, "非法输入不得写入");
});

test("§8 9.4 PATCH product 空补丁（patch 为空对象/缺失）→ 400，消息说明至少要有一个可更新字段", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "空补丁" });
  for (const body of [{ expectedRowVersion: 0, patch: {} }, { expectedRowVersion: 0 }]) {
    const res = await callApi(harness, "PATCH", `/api/product-dev/products/${product.publicId}`, { body });
    assert.equal(res.statusCode, 400, `body=${JSON.stringify(body)} 应 400，实际 ${res.statusCode}`);
    assert.match(String(res.payload.message), /字段|field/i, "消息应说明至少要有一个可更新字段");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DELETE /api/product-dev/products/:publicId
// ─────────────────────────────────────────────────────────────────────────────

test("§5 #5 删产品：200 { removed: true }，并连带删除 sources/assets/variants", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "待删" });
  await addSource(harness, product.publicId, { supplyStatus: "active", supplyPrice: 1 });
  await addAsset(harness, product.publicId, { assetType: "main" });
  await addVariant(harness, product.publicId, { spec: { size: "l" } });

  const res = await callApi(harness, "DELETE", `/api/product-dev/products/${product.publicId}`);
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.deepEqual(res.payload, { removed: true });

  const after = await callApi(harness, "GET", `/api/product-dev/products/${product.publicId}`);
  assert.equal(after.statusCode, 404, "删除后详情应 404");
  assert.equal(harness.repository.__all.sources.length, 0, "货源应连带删除");
  assert.equal(harness.repository.__all.assets.length, 0, "图片应连带删除");
  assert.equal(harness.repository.__all.variants.length, 0, "变体应连带删除");
});

test("§6 删产品：未知 publicId → 404；他公司的 publicId → 404 且数据不动", async () => {
  const harness = createApiHarness();
  const notFound = await callApi(harness, "DELETE", "/api/product-dev/products/PD_NOPE");
  assert.equal(notFound.statusCode, 404);

  const productB = await createProduct(harness, { title: "B 的产品" }, USER_B);
  const cross = await callApi(harness, "DELETE", `/api/product-dev/products/${productB.publicId}`, { user: USER_A });
  assert.equal(cross.statusCode, 404);
  assert.equal(harness.repository.__all.products.length, 1, "B 的产品不得被 A 删除");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. POST /api/product-dev/products/:publicId/sources
// ─────────────────────────────────────────────────────────────────────────────

test("§5 #6 挂货源：201 { source }，形状按 §5.1", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "挂货源" });
  const res = await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/sources`, {
    body: {
      platform: "1688", sourceProductId: "4430417783", sourceUrl: "https://detail.1688.com/offer/1.html",
      supplyPrice: 12.5, supplyCurrency: "CNY", moq: 2, supplierName: "某供应商", supplyStatus: "active", note: "比价"
    }
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  assert.deepEqual(Object.keys(res.payload), ["source"]);
  assertExactKeys(res.payload.source, SOURCE_KEYS, "Source");
  assert.equal(res.payload.source.platform, "1688");
  assert.equal(res.payload.source.sourceProductId, "4430417783");
  assert.equal(res.payload.source.supplyPrice, 12.5);
  assert.equal(res.payload.source.supplyCurrency, "CNY");
  assert.equal(res.payload.source.moq, 2);
  assert.equal(res.payload.source.supplyStatus, "active");
  assert.equal(res.payload.source.pdevProductId, product.id);
  assertNoCompanyKeyLeak(res.payload);
});

test("§6 挂货源：platform 枚举/sourceProductId 必填 → 400；未知产品 → 404", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "校验" });
  for (const body of [
    { platform: "jd", sourceProductId: "S" },
    { platform: "1688.com", sourceProductId: "S" },
    { sourceProductId: "S" },
    { platform: "1688" },
    { platform: "1688", sourceProductId: "   " }
  ]) {
    const res = await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/sources`, { body });
    assert.equal(res.statusCode, 400, `body=${JSON.stringify(body)} 应 400，实际 ${res.statusCode}`);
    assert.equal(typeof res.payload.message, "string");
  }
  const notFound = await callApi(harness, "POST", "/api/product-dev/products/PD_NOPE/sources", {
    body: { platform: "1688", sourceProductId: "S" }
  });
  assert.equal(notFound.statusCode, 404);
});

test("§6 同一货源被别的产品占用 → 409 且带占用 publicId", async () => {
  const harness = createApiHarness();
  const first = await createProduct(harness, { title: "第一个" });
  const second = await createProduct(harness, { title: "第二个" });
  await addSource(harness, first.publicId, { platform: "1688", sourceProductId: "SKU-SHARED" });

  const res = await callApi(harness, "POST", `/api/product-dev/products/${second.publicId}/sources`, {
    body: { platform: "1688", sourceProductId: "SKU-SHARED" }
  });
  assert.equal(res.statusCode, 409, JSON.stringify(res.payload));
  assert.equal(res.payload.publicId, first.publicId, "409 必须附占用的 publicId（§6）");
  assertNoCompanyKeyLeak(res.payload);
});

test("§3.2 不同公司可挂同一货源业务键（唯一索引按公司）", async () => {
  const harness = createApiHarness();
  const productA = await createProduct(harness, { title: "A" }, USER_A);
  const productB = await createProduct(harness, { title: "B" }, USER_B);
  const sourceA = await addSource(harness, productA.publicId, { platform: "1688", sourceProductId: "SKU-SHARED" }, USER_A);
  const sourceB = await addSource(harness, productB.publicId, { platform: "1688", sourceProductId: "SKU-SHARED" }, USER_B);
  assert.notEqual(sourceA.id, sourceB.id);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 / 8. PATCH & DELETE /api/product-dev/sources/:id
// ─────────────────────────────────────────────────────────────────────────────

test("§5 #7 改货源：200 { source }，可更新比价与状态字段", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "改货源" });
  const source = await addSource(harness, product.publicId, { supplyPrice: 10, supplyStatus: "unknown" });

  const res = await callApi(harness, "PATCH", `/api/product-dev/sources/${source.id}`, {
    body: {
      sourceUrl: "https://detail.1688.com/offer/2.html", supplyPrice: 8.88, supplyCurrency: "CNY",
      moq: 5, supplierName: "新供应商", supplyStatus: "active", note: "降价了"
    }
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.deepEqual(Object.keys(res.payload), ["source"]);
  assertExactKeys(res.payload.source, SOURCE_KEYS, "Source");
  assert.equal(res.payload.source.supplyPrice, 8.88);
  assert.equal(res.payload.source.supplyStatus, "active");
  assert.equal(res.payload.source.moq, 5);
  assert.equal(res.payload.source.supplierName, "新供应商");
  assertNoCompanyKeyLeak(res.payload);
});

test("§10.3 #2 PATCH source 无任何可更新字段 → 400", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "空补丁货源" });
  const source = await addSource(harness, product.publicId, { supplyPrice: 10 });
  for (const body of [{}, { unknownField: "x" }]) {
    const res = await callApi(harness, "PATCH", `/api/product-dev/sources/${source.id}`, { body });
    assert.equal(res.statusCode, 400, `body=${JSON.stringify(body)} 应 400，实际 ${res.statusCode} ${JSON.stringify(res.payload)}`);
    assert.match(String(res.payload.message), /字段|field/i);
  }
  const still = (await callApi(harness, "GET", `/api/product-dev/products/${product.publicId}`)).payload.sources[0];
  assert.equal(Number(still.supplyPrice), 10, "非法补丁不得写入");
});

test("§6 改货源：未知 id → 404；他公司的 id → 404（跨公司越权 §9.5）", async () => {
  const harness = createApiHarness();
  const notFound = await callApi(harness, "PATCH", "/api/product-dev/sources/987654", { body: { supplyPrice: 1 } });
  assert.equal(notFound.statusCode, 404);

  const productB = await createProduct(harness, { title: "B" }, USER_B);
  const sourceB = await addSource(harness, productB.publicId, { supplyPrice: 3 }, USER_B);
  const cross = await callApi(harness, "PATCH", `/api/product-dev/sources/${sourceB.id}`, {
    body: { supplyPrice: 0.01 }, user: USER_A
  });
  assert.equal(cross.statusCode, 404, "A 不能改 B 的货源，必须 404（不是 403/200）");
  assert.equal(harness.repository.__all.sources.find((row) => row.id === sourceB.id).supply_price, 3, "B 的货源不得被改");
  assertNoCompanyKeyLeak(cross.payload);
});

test("§5 #8 删货源：200 { removed: true }，详情里随即消失；未知/他公司 id → 404", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "删货源" });
  const source = await addSource(harness, product.publicId, {});
  const res = await callApi(harness, "DELETE", `/api/product-dev/sources/${source.id}`);
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.deepEqual(res.payload, { removed: true });

  const detail = await callApi(harness, "GET", `/api/product-dev/products/${product.publicId}`);
  assert.equal(detail.payload.sources.length, 0, "已删货源不应出现在详情里");

  const again = await callApi(harness, "DELETE", `/api/product-dev/sources/${source.id}`);
  assert.equal(again.statusCode, 404);

  const productB = await createProduct(harness, { title: "B" }, USER_B);
  const sourceB = await addSource(harness, productB.publicId, {}, USER_B);
  const cross = await callApi(harness, "DELETE", `/api/product-dev/sources/${sourceB.id}`, { user: USER_A });
  assert.equal(cross.statusCode, 404, "A 不能删 B 的货源，必须 404");
  assert.ok(harness.repository.__all.sources.some((row) => row.id === sourceB.id), "B 的货源不得被删");
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 / 10. POST assets / DELETE assets
// ─────────────────────────────────────────────────────────────────────────────

test("§5 #9 传图：201 { asset }，形状按 §5.1，默认 status=ready、checksum=null", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "传图" });
  const res = await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/assets`, {
    body: { assetType: "main", sourceUrl: "https://img.example.com/1.jpg", storageUrl: "", sortNo: 0 }
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  assert.deepEqual(Object.keys(res.payload), ["asset"]);
  assertExactKeys(res.payload.asset, ASSET_KEYS, "Asset");
  assert.equal(res.payload.asset.assetType, "main");
  assert.equal(res.payload.asset.status, "ready");
  assert.equal(res.payload.asset.checksum, null);
  assert.equal(res.payload.asset.pdevProductId, product.id);
  assertNoCompanyKeyLeak(res.payload);
});

test("§6 传图：assetType 非法/缺失 → 400；未知产品 → 404", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "图片校验" });
  for (const assetType of ["cover", "image", "", null]) {
    const res = await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/assets`, {
      body: { assetType, sourceUrl: "https://img.example.com/x.jpg" }
    });
    assert.equal(res.statusCode, 400, `assetType=${JSON.stringify(assetType)} 应 400，实际 ${res.statusCode}`);
  }
  const notFound = await callApi(harness, "POST", "/api/product-dev/products/PD_NOPE/assets", { body: { assetType: "main" } });
  assert.equal(notFound.statusCode, 404);
});

test("§5 #10 删图：200 { removed: true }；未知/他公司 id → 404", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "删图" });
  const asset = await addAsset(harness, product.publicId, { assetType: "main" });

  const res = await callApi(harness, "DELETE", `/api/product-dev/assets/${asset.id}`);
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.deepEqual(res.payload, { removed: true });

  const again = await callApi(harness, "DELETE", `/api/product-dev/assets/${asset.id}`);
  assert.equal(again.statusCode, 404);

  const productB = await createProduct(harness, { title: "B" }, USER_B);
  const assetB = await addAsset(harness, productB.publicId, {}, USER_B);
  const cross = await callApi(harness, "DELETE", `/api/product-dev/assets/${assetB.id}`, { user: USER_A });
  assert.equal(cross.statusCode, 404, "A 不能删 B 的图片，必须 404");
  assert.ok(harness.repository.__all.assets.some((row) => row.id === assetB.id), "B 的图片不得被删");
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. POST variants
// ─────────────────────────────────────────────────────────────────────────────

test("§5 #11 建变体：201 { variant }，variantKey 归一化 + 形状按 §5.1", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "建变体" });
  const res = await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/variants`, {
    body: {
      spec: { 颜色: "黑", 尺寸: "L" }, supplyPrice: 12.5,
      weightKg: 0.35, packageLengthCm: 30, packageWidthCm: 20, packageHeightCm: 10
    }
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  assert.deepEqual(Object.keys(res.payload), ["variant"]);
  assertExactKeys(res.payload.variant, VARIANT_KEYS, "Variant");
  assert.equal(res.payload.variant.variantKey, "尺寸=l;颜色=黑");
  assert.deepEqual(res.payload.variant.spec, { 颜色: "黑", 尺寸: "L" });
  assert.equal(res.payload.variant.status, "active");
  assert.equal(res.payload.variant.weightKg, 0.35);
  assert.equal(res.payload.variant.packageLengthCm, 30);
  assertNoCompanyKeyLeak(res.payload);
});

test("§6 建变体：spec 缺失/非对象 → 400；未知产品 → 404；重复 variant_key → 409", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "变体校验" });
  for (const spec of [undefined, null, "", 42, [], {}]) {
    const res = await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/variants`, { body: { spec } });
    assert.equal(res.statusCode, 400, `spec=${JSON.stringify(spec)} 应 400，实际 ${res.statusCode}`);
  }
  const notFound = await callApi(harness, "POST", "/api/product-dev/products/PD_NOPE/variants", { body: { spec: { size: "l" } } });
  assert.equal(notFound.statusCode, 404);

  await addVariant(harness, product.publicId, { spec: { 颜色: "黑", 尺寸: "L" } });
  const duplicate = await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/variants`, {
    body: { spec: { 尺寸: "l", 颜色: "黑" } }
  });
  assert.equal(duplicate.statusCode, 409, JSON.stringify(duplicate.payload));
  assert.equal(typeof duplicate.payload.message, "string");
  assertNoCompanyKeyLeak(duplicate.payload);
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. POST status
// ─────────────────────────────────────────────────────────────────────────────

test("§5 #12 状态流转：合法 200 { product }；缺资料 400 + missing（§5.1 词表 + 固定顺序）", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "流转" });

  const developing = await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/status`, {
    body: { to: "developing", expectedRowVersion: 0 }
  });
  assert.equal(developing.statusCode, 200, JSON.stringify(developing.payload));
  assert.deepEqual(Object.keys(developing.payload), ["product"]);
  assert.equal(developing.payload.product.devStatus, "developing");
  assertProductShape(developing.payload.product);

  const blocked = await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/status`, {
    body: { to: "info_ready", expectedRowVersion: 1 }
  });
  assert.equal(blocked.statusCode, 400, JSON.stringify(blocked.payload));
  assert.ok(Array.isArray(blocked.payload.missing), "硬校验失败必须带 missing: string[]");
  assert.deepEqual(blocked.payload.missing, ["noSource", "noMainAsset"],
    "§10.3 #3：一个货源都没有时只报 noSource，不报 noActivePrice；顺序固定");
  assertNoCompanyKeyLeak(blocked.payload);

  await addSource(harness, product.publicId, { supplyPrice: 12.5, supplyStatus: "active" });
  await addAsset(harness, product.publicId, { assetType: "main" });
  const ready = await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/status`, {
    body: { to: "info_ready", expectedRowVersion: 1 }
  });
  assert.equal(ready.statusCode, 200, JSON.stringify(ready.payload));
  assert.equal(ready.payload.product.devStatus, "info_ready");

  const noVariant = await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/status`, {
    body: { to: "finalized", expectedRowVersion: 2 }
  });
  assert.equal(noVariant.statusCode, 400, JSON.stringify(noVariant.payload));
  assert.deepEqual(noVariant.payload.missing, ["noVariant"]);

  await addVariant(harness, product.publicId, { spec: { size: "l" } });
  const finalized = await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/status`, {
    body: { to: "finalized", expectedRowVersion: 2 }
  });
  assert.equal(finalized.statusCode, 200, JSON.stringify(finalized.payload));
  assert.equal(finalized.payload.product.devStatus, "finalized");

  const archived = await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/status`, {
    body: { to: "archived", expectedRowVersion: 3 }
  });
  assert.equal(archived.statusCode, 200, JSON.stringify(archived.payload));
  assert.equal(archived.payload.product.devStatus, "archived");
});

test("§4/§6 状态流转：非法流转 400（消息说明允许来源）；过期版本 409；未知产品 404", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "非法流转" });

  const illegal = await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/status`, {
    body: { to: "finalized", expectedRowVersion: 0 }
  });
  assert.equal(illegal.statusCode, 400, JSON.stringify(illegal.payload));
  assert.match(String(illegal.payload.message), /info_ready/, "消息应说明只允许来自 info_ready");

  await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/status`, { body: { to: "developing", expectedRowVersion: 0 } });
  const conflict = await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/status`, {
    body: { to: "archived", expectedRowVersion: 0 }
  });
  assert.equal(conflict.statusCode, 409, JSON.stringify(conflict.payload));

  const notFound = await callApi(harness, "POST", "/api/product-dev/products/PD_NOPE/status", { body: { to: "developing" } });
  assert.equal(notFound.statusCode, 404);
  assertNoCompanyKeyLeak(conflict.payload);
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. GET summary
// ─────────────────────────────────────────────────────────────────────────────

test("§5 #13 汇总：200 { byStatus, missing }，键恒在且按公司统计", async () => {
  const harness = createApiHarness();
  await createProduct(harness, { title: "A 空产品" }, USER_A);
  const ready = await createProduct(harness, { title: "A 齐全" }, USER_A);
  await makeInfoReadyInputs(harness, ready.publicId);
  await callApi(harness, "POST", `/api/product-dev/products/${ready.publicId}/status`, { body: { to: "developing", expectedRowVersion: 0 } });
  await callApi(harness, "POST", `/api/product-dev/products/${ready.publicId}/status`, { body: { to: "info_ready", expectedRowVersion: 1 } });

  const productB = await createProduct(harness, { title: "B 的产品" }, USER_B);
  await makeInfoReadyInputs(harness, productB.publicId, USER_B);
  await addVariant(harness, productB.publicId, { spec: { size: "l" } }, USER_B);

  const res = await callApi(harness, "GET", "/api/product-dev/summary", { user: USER_A });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.deepEqual(Object.keys(res.payload).sort(), ["byStatus", "missing"]);
  assert.deepEqual(Object.keys(res.payload.byStatus).sort(), ["archived", "developing", "finalized", "info_ready", "new"]);
  assert.deepEqual(Object.keys(res.payload.missing).sort(), ["noActivePrice", "noMainAsset", "noSource", "noVariant"]);
  assert.equal(Number(res.payload.byStatus.new), 1, "A 公司只有 1 个 new（空产品）");
  assert.equal(Number(res.payload.byStatus.info_ready), 1);
  assert.equal(Number(res.payload.byStatus.finalized), 0, "B 公司的 finalized 不得计入 A");
  assert.equal(Number(res.payload.missing.noSource), 1);
  assert.equal(Number(res.payload.missing.noMainAsset), 1);
  assert.equal(Number(res.payload.missing.noVariant), 2);
  assertNoCompanyKeyLeak(res.payload);
});

// ─────────────────────────────────────────────────────────────────────────────
// §11.4 错误体形状 / 路由边界
// ─────────────────────────────────────────────────────────────────────────────

test("§11.4 错误体形状：非 2xx 一律 { message }（校验失败可带 missing、占用可带 publicId），不夹带内部字段", async () => {
  const harness = createApiHarness();
  const product = await createProduct(harness, { title: "错误体" });
  await addSource(harness, product.publicId, { platform: "1688", sourceProductId: "SKU-ERR" });
  const other = await createProduct(harness, { title: "另一个" });

  const cases = [];
  cases.push(await callApi(harness, "GET", "/api/product-dev/products/PD_NOPE")); // 404
  cases.push(await callApi(harness, "POST", "/api/product-dev/products", { body: {} })); // 400 校验
  cases.push(await callApi(harness, "POST", `/api/product-dev/products/${product.publicId}/status`, { body: { to: "info_ready" } })); // 400 + missing
  cases.push(await callApi(harness, "POST", `/api/product-dev/products/${other.publicId}/sources`, {
    body: { platform: "1688", sourceProductId: "SKU-ERR" }
  })); // 409 + publicId

  const allowedKeys = ["message", "missing", "publicId"];
  for (const res of cases) {
    assert.ok(res.statusCode >= 400, `期望非 2xx，实际 ${res.statusCode}`);
    assert.ok(res.payload && typeof res.payload === "object" && !Array.isArray(res.payload), "错误体必须是对象");
    for (const key of Object.keys(res.payload)) {
      assert.ok(allowedKeys.includes(key), `错误体不得出现字段 ${key}：${JSON.stringify(res.payload)}`);
    }
    assert.equal(typeof res.payload.message, "string");
    assert.ok(res.payload.message.length > 0, "message 必须非空");
    assert.equal(res.payload.stack, undefined);
    assert.equal(res.payload.details, undefined);
    assertNoCompanyKeyLeak(res.payload);
  }
  assert.ok(Array.isArray(cases[2].payload.missing) && cases[2].payload.missing.length > 0, "硬校验 400 必须带 missing");
  assert.equal(cases[3].payload.publicId, product.publicId, "占用 409 必须带 publicId");
});

test("§6 未知路径不落在 product-dev 路由上（路由边界不吞别的接口）", () => {
  const harness = createApiHarness();
  assert.equal(harness.routes.some((route) => route.matches("/api/product-dev/products/PD_X/unknown", "GET")), false);
  assert.equal(harness.routes.some((route) => route.matches("/api/orders", "GET")), false);
  assert.equal(harness.routes.some((route) => route.matches("/api/product-dev/summary", "POST")), false);
});


// ─────────────────────────────────────────────────────────────────────────────
// 权限守卫（pdev.write）——需求：只有「产品开发」与「管理员」能改商品管理，运营等只读。
// 注意：本文件的 createApiHarness 里 checkPermission() 是写死 true 的桩，
// 所以权限判定必须在"权限表 + 路由源码"这个层面单独钉死，否则被误删也没人发现。
// ─────────────────────────────────────────────────────────────────────────────
test("pdev.write 权限守卫：只有 admin 与 product_dev 拥有编辑权，运营/客服/财务/超级管理员只读", () => {
  const nodeAssert = require("assert");
  const permissions = require("../permissions");
  const { PERMISSIONS, ROLE_ADMIN, ROLE_PRODUCT_DEV } = permissions;

  nodeAssert.ok(PERMISSIONS[ROLE_ADMIN], "admin 必须有权限集");
  nodeAssert.ok(PERMISSIONS[ROLE_ADMIN].has("pdev.write"), "管理员必须能编辑商品管理");
  nodeAssert.ok(PERMISSIONS[ROLE_PRODUCT_DEV], "产品开发角色必须存在");
  nodeAssert.ok(PERMISSIONS[ROLE_PRODUCT_DEV].has("pdev.write"), "产品开发必须能编辑商品管理");

  for (const role of ["operations", "support", "finance", "supervisor"]) {
    const set = PERMISSIONS[role] || new Set();
    nodeAssert.ok(!set.has("pdev.write"), `${role} 不应有 pdev.write（只读）`);
  }
});

test("pdev.write 权限守卫：路由层对非 read 动作强制校验（防止有人删掉这道闸）", () => {
  const nodeAssert = require("assert");
  const nodeFs = require("fs");
  const nodePath = require("path");
  const source = nodeFs.readFileSync(nodePath.join(__dirname, "pdev-routes.js"), "utf8");

  nodeAssert.ok(/actionType !== "read"/.test(source), "路由必须区分读写动作");
  nodeAssert.ok(/actionType !== "read"[\s\S]{0,120}?checkPermission\(auth\.user, "pdev\.write"\)/.test(source),
    "写操作必须校验 pdev.write（只有产品开发/管理员能改）");
  nodeAssert.ok(!/actionType !== "read"[\s\S]{0,200}?return true/.test(source), "权限校验不能被短路成永远通过");
});
