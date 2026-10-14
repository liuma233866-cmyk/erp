"use strict";

// 产品开发库（product-dev）服务层：契约 §4 状态机 + §6 硬校验 + §2/§9.1 公司隔离。
//
// 调用面按契约 §10.1（v1.2 冻结）：
// - createPdevService({ repository, resolveCompanyKey? })
// - 方法：listProducts / createProduct / getProduct / updateProduct / deleteProduct /
//   addSource / updateSource / deleteSource / addAsset / deleteAsset / addVariant /
//   changeStatus / getSummary
// - 入参统一对象、首键 user、业务字段平铺（不套 body）
// - 返回 §5.1 的包装形状（{product} / {source} / ... / {removed:true} / {items,total,page,pageSize} / {byStatus,missing}）
// - 错误一律 throw PdevError(code, message, { statusCode, missing, details })

const crypto = require("crypto");

// ---------- §4 状态机 ----------

const DEV_STATUS = Object.freeze({
  NEW: "new",
  DEVELOPING: "developing",
  INFO_READY: "info_ready",
  FINALIZED: "finalized",
  ARCHIVED: "archived"
});

const PDEV_DEV_STATUSES = ["new", "developing", "info_ready", "finalized", "archived"];
// 同时支持 PDEV_DEV_STATUSES.includes("new") 与 PDEV_DEV_STATUSES.NEW（非枚举，不污染数组断言）。
for (const key of Object.keys(DEV_STATUS)) {
  Object.defineProperty(PDEV_DEV_STATUSES, key, { value: DEV_STATUS[key], enumerable: false });
}
Object.freeze(PDEV_DEV_STATUSES);

// 当前状态 → 允许流转到的目标状态（§4）
const PDEV_ALLOWED_TRANSITIONS = Object.freeze({
  [DEV_STATUS.NEW]: Object.freeze([DEV_STATUS.DEVELOPING, DEV_STATUS.INFO_READY, DEV_STATUS.ARCHIVED]),
  [DEV_STATUS.DEVELOPING]: Object.freeze([DEV_STATUS.INFO_READY, DEV_STATUS.ARCHIVED]),
  [DEV_STATUS.INFO_READY]: Object.freeze([DEV_STATUS.FINALIZED, DEV_STATUS.ARCHIVED]),
  [DEV_STATUS.FINALIZED]: Object.freeze([DEV_STATUS.ARCHIVED]),
  [DEV_STATUS.ARCHIVED]: Object.freeze([])
});

// 目标状态 → 允许的来源状态（§4，用于 400 消息）
const ALLOWED_SOURCE_STATUSES = Object.freeze({
  [DEV_STATUS.NEW]: Object.freeze([]),
  [DEV_STATUS.DEVELOPING]: Object.freeze([DEV_STATUS.NEW]),
  [DEV_STATUS.INFO_READY]: Object.freeze([DEV_STATUS.NEW, DEV_STATUS.DEVELOPING]),
  [DEV_STATUS.FINALIZED]: Object.freeze([DEV_STATUS.INFO_READY]),
  [DEV_STATUS.ARCHIVED]: Object.freeze([DEV_STATUS.NEW, DEV_STATUS.DEVELOPING, DEV_STATUS.INFO_READY, DEV_STATUS.FINALIZED])
});

const MISSING_TOKENS = Object.freeze({
  NO_SOURCE: "noSource",
  NO_ACTIVE_PRICE: "noActivePrice",
  NO_MAIN_ASSET: "noMainAsset",
  NO_VARIANT: "noVariant"
});

// §11.1 / §10.3-3：missing token 顺序固定为这四个。
const MISSING_TOKEN_ORDER = Object.freeze([
  MISSING_TOKENS.NO_SOURCE,
  MISSING_TOKENS.NO_ACTIVE_PRICE,
  MISSING_TOKENS.NO_MAIN_ASSET,
  MISSING_TOKENS.NO_VARIANT
]);

const SOURCE_PLATFORMS = Object.freeze(["1688", "taobao", "ozon", "other"]);
const SUPPLY_STATUSES = Object.freeze(["active", "out_of_stock", "discontinued", "unknown"]);
const ASSET_TYPES = Object.freeze(["main", "gallery", "detail", "ai"]);

const MAX_TEXT_LENGTH = 65000;

function canTransition(from, to) {
  const list = PDEV_ALLOWED_TRANSITIONS[String(from ?? "")];
  return Array.isArray(list) && list.includes(to);
}

function allowedSourceStatuses(to) {
  const list = ALLOWED_SOURCE_STATUSES[String(to ?? "")];
  return Array.isArray(list) ? list.slice() : [];
}

function normalizeVariantKey(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return "";
  return Object.keys(spec)
    .map((key) => [String(key).trim().toLowerCase(), spec[key] === null || spec[key] === undefined ? "" : String(spec[key]).trim().toLowerCase()])
    .filter(([key]) => key !== "")
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(";");
}

// §2：company_key = trim(user.companyName) || trim(user.companyId)
function resolveCompanyKey(user) {
  const companyName = String(user?.companyName ?? "").trim();
  if (companyName) return companyName;
  return String(user?.companyId ?? "").trim();
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

// §11.5 缺什么判定口径（唯一真源）：
//   noSource      = 货源总数为 0
//   noActivePrice = 没有「supply_status='active' 且 supply_price 非空」的货源（noSource 优先）
//   noMainAsset   = 没有 asset_type='main' 的图片
//   noVariant     = 变体总数为 0
// 返回顺序固定 = MISSING_TOKEN_ORDER，无缺失为 []。
// 列表项 ProductSummary.missing 与 §4 硬校验都调用这一个函数，避免两处漂移。
function deriveMissingTokens(stats = {}) {
  const source = stats || {};
  const sourceCount = toCount(source.sourceCount);
  const activePricedSourceCount = toCount(
    source.activePricedSourceCount !== undefined ? source.activePricedSourceCount : source.activeSourceCount
  );
  const mainAssetCount = toCount(source.mainAssetCount !== undefined ? source.mainAssetCount : source.assetCount);
  const variantCount = toCount(source.variantCount);

  const missing = [];
  if (sourceCount === 0) missing.push(MISSING_TOKENS.NO_SOURCE);
  else if (activePricedSourceCount === 0) missing.push(MISSING_TOKENS.NO_ACTIVE_PRICE);
  if (mainAssetCount === 0) missing.push(MISSING_TOKENS.NO_MAIN_ASSET);
  if (variantCount === 0) missing.push(MISSING_TOKENS.NO_VARIANT);
  return missing;
}

// 进入目标状态前的硬校验（§4 / §10.3-3）；info_ready 看前三个 token，finalized 只看 noVariant。
function evaluateStatusRequirements(to, stats) {
  const all = deriveMissingTokens(stats);
  let missing;
  if (to === DEV_STATUS.INFO_READY) {
    missing = all.filter((token) => token !== MISSING_TOKENS.NO_VARIANT);
  } else if (to === DEV_STATUS.FINALIZED) {
    missing = all.filter((token) => token === MISSING_TOKENS.NO_VARIANT);
  } else {
    missing = [];
  }
  return { ok: missing.length === 0, missing };
}

// §11.2：`?missing=noSource,noActivePrice`（逗号分隔多值，AND 语义）。
function normalizeMissingFilter(value) {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const tokens = [];
  for (const item of raw) {
    const token = String(item ?? "").trim();
    if (!token) continue;
    if (!MISSING_TOKEN_ORDER.includes(token)) {
      throw validationError(`missing must be one of: ${MISSING_TOKEN_ORDER.join(", ")}`);
    }
    if (!tokens.includes(token)) tokens.push(token);
  }
  return MISSING_TOKEN_ORDER.filter((token) => tokens.includes(token));
}

// 列表项 missing 归一化：仓储已算好就按固定顺序收敛，否则用同一函数就地推导。
function normalizeItemMissing(item) {
  if (!item || typeof item !== "object") return item;
  const provided = Array.isArray(item.missing) ? item.missing : null;
  const missing = provided
    ? MISSING_TOKEN_ORDER.filter((token) => provided.includes(token))
    : deriveMissingTokens(item);
  return { ...item, missing };
}

// ---------- 错误（§10.1 冻结） ----------

const PDEV_ERROR_STATUS = Object.freeze({
  VALIDATION_FAILED: 400,
  COMPANY_REQUIRED: 400,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  SOURCE_TAKEN: 409,
  VARIANT_TAKEN: 409
});

class PdevError extends Error {
  constructor(code, message, options = {}) {
    super(message || code);
    this.name = "PdevError";
    this.code = code;
    this.statusCode = Number(options.statusCode) || PDEV_ERROR_STATUS[code] || 400;
    this.missing = Array.isArray(options.missing) ? options.missing.slice() : undefined;
    this.details = options.details || undefined;
    // 便于 routes 直接拼 409 响应体（§6：同一货源被占用要附 publicId）。
    this.publicId = options.details && options.details.publicId ? String(options.details.publicId) : undefined;
  }
}

function validationError(message, extra) {
  return new PdevError("VALIDATION_FAILED", message, extra);
}

function notFoundError(message) {
  return new PdevError("NOT_FOUND", message || "Not found");
}

function versionConflictError(message) {
  return new PdevError("VERSION_CONFLICT", message);
}

// ---------- 入参校验 ----------

function hasOwn(target, key) {
  return Boolean(target) && Object.prototype.hasOwnProperty.call(target, key);
}

function isDuplicateKeyError(error) {
  const code = String(error?.code || "");
  const errno = Number(error?.errno || 0);
  return code === "ER_DUP_ENTRY" || errno === 1062;
}

function readString(value, field, options = {}) {
  const { required = false, maxLength = 0 } = options;
  if (value === undefined || value === null) {
    if (required) throw validationError(`${field} is required`);
    return null;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw validationError(`${field} must be a string`);
  }
  const text = String(value).trim();
  if (!text) {
    if (required) throw validationError(`${field} is required`);
    return "";
  }
  if (maxLength > 0 && text.length > maxLength) {
    throw validationError(`${field} must be at most ${maxLength} characters`);
  }
  return text;
}

function readNumber(value, field, options = {}) {
  const { min = null, max = null, decimals = null } = options;
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && !value.trim()) return null;
  if (typeof value === "boolean") throw validationError(`${field} must be a number`);
  const n = Number(value);
  if (!Number.isFinite(n)) throw validationError(`${field} must be a number`);
  if (min !== null && n < min) throw validationError(`${field} must be >= ${min}`);
  if (max !== null && n > max) throw validationError(`${field} must be <= ${max}`);
  return decimals === null ? n : Number(n.toFixed(decimals));
}

function readInteger(value, field, options = {}) {
  const n = readNumber(value, field, options);
  if (n === null) return null;
  if (!Number.isInteger(n)) throw validationError(`${field} must be an integer`);
  return n;
}

function readEnum(value, field, allowed, options = {}) {
  const { required = false, defaultValue = null } = options;
  if (value === undefined || value === null || String(value).trim() === "") {
    if (required) throw validationError(`${field} is required`);
    return defaultValue;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw validationError(`${field} must be a string`);
  }
  const text = String(value).trim().toLowerCase();
  if (!allowed.includes(text)) {
    throw validationError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return text;
}

function readCurrency(value) {
  if (value === undefined || value === null || String(value).trim() === "") return "CNY";
  const text = String(value).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(text)) throw validationError("supplyCurrency must be a 3-letter currency code");
  return text;
}

// spec 必须是「非空普通对象，值为 string/number/boolean」；返回 trim 后的副本。
function normalizeSpec(value) {
  if (value === undefined || value === null) throw validationError("spec is required");
  if (typeof value !== "object" || Array.isArray(value)) throw validationError("spec must be an object");
  const keys = Object.keys(value);
  if (!keys.length) throw validationError("spec must contain at least one key");
  const spec = {};
  for (const key of keys) {
    const name = String(key).trim();
    if (!name) throw validationError("spec keys must not be empty");
    if (name.length > 64) throw validationError("spec keys must be at most 64 characters");
    const raw = value[key];
    if (raw === null || raw === undefined || typeof raw === "object" || typeof raw === "function") {
      throw validationError(`spec value for "${name}" must be a string, number or boolean`);
    }
    spec[name] = typeof raw === "string" ? raw.trim() : String(raw);
  }
  return spec;
}

function clampInteger(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function generatePublicId() {
  return `PD_${crypto.randomBytes(12).toString("hex")}`;
}

// ---------- 服务 ----------

class PdevService {
  constructor(deps = {}) {
    const { repository } = deps;
    if (!repository) throw new Error("PdevService requires a repository");
    this.repository = repository;
    this.resolveCompanyKeyFn = typeof deps.resolveCompanyKey === "function" ? deps.resolveCompanyKey : resolveCompanyKey;
  }

  async ready() {
    if (this.repository && typeof this.repository.ensureTables === "function") {
      await this.repository.ensureTables();
    }
  }

  // §9.1：company_key 不允许为空，否则无公司用户会共享同一份库。
  requireCompanyKey(user) {
    const companyKey = String(this.resolveCompanyKeyFn(user) ?? "").trim();
    if (!companyKey) {
      throw new PdevError("COMPANY_REQUIRED", "The current user has no company; product-dev data is company scoped");
    }
    return companyKey;
  }

  async requireProduct(companyKey, publicId) {
    const product = await this.repository.findProductByPublicId(companyKey, String(publicId ?? ""));
    if (!product) throw notFoundError("Product not found");
    return product;
  }

  // §9.5：子表资源的归属校验——先看它属于哪个产品，那个产品必须属于本公司，否则 404。
  async requireOwnedProduct(companyKey, pdevProductId) {
    const product = await this.repository.findProductById(companyKey, pdevProductId);
    if (!product) throw notFoundError("Product not found");
    return product;
  }

  // ---------- §5 接口 1 ----------

  async listProducts(input = {}) {
    const { user } = input;
    const companyKey = this.requireCompanyKey(user);
    const status = readEnum(input.devStatus, "devStatus", PDEV_DEV_STATUSES, { defaultValue: null });
    const keyword = readString(input.q, "q", { maxLength: 500 });
    const missingFilter = []; // 缺口筛选已下线（normalizeMissingFilter 定义保留，测试仍引用）
    const safePage = clampInteger(input.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const safePageSize = clampInteger(input.pageSize, 20, 1, 100);
    await this.ready();
    const result = await this.repository.listProducts({
      companyKey,
      devStatus: status,
      q: keyword || "",
      missing: missingFilter,
      limit: safePageSize,
      offset: (safePage - 1) * safePageSize
    });
    return {
      items: Array.isArray(result?.items) ? result.items : [],
      total: Number(result?.total) || 0,
      page: safePage,
      pageSize: safePageSize
    };
  }

  // ---------- §5 接口 2 ----------

  async createProduct(input = {}) {
    const { user } = input;
    const companyKey = this.requireCompanyKey(user);
    const title = readString(input.title, "title", { required: true, maxLength: 500 });
    const remark = readString(input.remark, "remark", { maxLength: MAX_TEXT_LENGTH });
    const categoryHint = readString(input.categoryHint, "categoryHint", { maxLength: 128 });
    const targetPlatform = readString(input.targetPlatform, "targetPlatform", { maxLength: 32 });
    const goodsStatus = readString(input.goodsStatus, "goodsStatus", { maxLength: 32 });
    const salesStatus = readString(input.salesStatus, "salesStatus", { maxLength: 32 });
    const sourceStatus = readString(input.sourceStatus, "sourceStatus", { maxLength: 32 });
    const purchasePrice = readString(input.purchasePrice, "purchasePrice", { maxLength: 16 });
    const purchaseUrl = readString(input.purchaseUrl, "purchaseUrl", { maxLength: 512 });
    const referenceUrl = readString(input.referenceUrl, "referenceUrl", { maxLength: 512 });
    const isBundle = readString(input.isBundle, "isBundle", { maxLength: 8 });
    const systemCategory = readString(input.systemCategory, "systemCategory", { maxLength: 128 });
    const ownerUserId = readString(input.ownerUserId, "ownerUserId", { maxLength: 128 });
    const createdBy = readString(user?.id, "createdBy", { maxLength: 128 });

    await this.ready();
    let product = null;
    let lastError = null;
    // 用户自带的商品SKU：留空则仍由系统生成 PD_xxx。
    // 只允许字母/数字/短横线/下划线 —— 它会成为商品编号（public_id），怪字符会很难查。
    const requestedSkuRaw = readString(input.sku, "sku", { maxLength: 64 });
    const requestedSku = String(requestedSkuRaw || "").trim();
    if (requestedSku && !/^[A-Za-z0-9_-]+$/.test(requestedSku)) {
      throw validationError("商品SKU 只能包含字母、数字、短横线或下划线");
    }
    for (let attempt = 0; attempt < 3 && !product; attempt += 1) {
      try {
        product = await this.repository.createProduct({
          companyKey,
          publicId: requestedSku || generatePublicId(),
          title,
          remark,
          categoryHint,
          targetPlatform,
          goodsStatus,
          salesStatus,
          sourceStatus,
        purchasePrice,
        purchaseUrl,
        referenceUrl,
        isBundle,
        systemCategory,
          ownerUserId,
          devStatus: DEV_STATUS.NEW,
          createdBy
        });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        lastError = error; // public_id 撞车，换一个随机值重试
      }
    }
    if (!product) throw lastError || new Error("Failed to create product");
    return { product };
  }

  // ---------- §5 接口 3 ----------

  async getProduct(input = {}) {
    const { user, publicId } = input;
    const companyKey = this.requireCompanyKey(user);
    await this.ready();
    const product = await this.requireProduct(companyKey, publicId);
    const [sources, assets, variants] = await Promise.all([
      this.repository.listSources(product.id),
      this.repository.listAssets(product.id),
      this.repository.listVariants(product.id)
    ]);
    // 注意：按契约 §11.7，{product} 不含 missing 键（missing 只出现在列表项 ProductSummary）。
    // 之前前端在详情里读 product.missing，于是只能显示「缺口未知」——那是前端的问题，不改契约。
    return {
      product,
      sources: Array.isArray(sources) ? sources : [],
      assets: Array.isArray(assets) ? assets : [],
      variants: Array.isArray(variants) ? variants : []
    };
  }

  // ---------- §5 接口 4 ----------

  async updateProduct(input = {}) {
    const { user, publicId } = input;
    const companyKey = this.requireCompanyKey(user);

    // §10.3-1：expectedRowVersion 必填；缺失或非整数 → 400，值不符 → 409
    const expectedRowVersion = readInteger(input.expectedRowVersion, "expectedRowVersion", { min: 0 });
    if (expectedRowVersion === null) throw validationError("expectedRowVersion is required");

    if (input.patch !== undefined && input.patch !== null && (typeof input.patch !== "object" || Array.isArray(input.patch))) {
      throw validationError("patch must be an object");
    }
    const patchInput = input.patch || {};
    const patch = {};
    if (hasOwn(patchInput, "title")) patch.title = readString(patchInput.title, "title", { required: true, maxLength: 500 });
    if (hasOwn(patchInput, "remark")) patch.remark = readString(patchInput.remark, "remark", { maxLength: MAX_TEXT_LENGTH });
    if (hasOwn(patchInput, "categoryHint")) patch.categoryHint = readString(patchInput.categoryHint, "categoryHint", { maxLength: 128 });
    if (hasOwn(patchInput, "targetPlatform")) patch.targetPlatform = readString(patchInput.targetPlatform, "targetPlatform", { maxLength: 32 });
    if (hasOwn(patchInput, "goodsStatus")) patch.goodsStatus = readString(patchInput.goodsStatus, "goodsStatus", { maxLength: 32 });
    if (hasOwn(patchInput, "salesStatus")) patch.salesStatus = readString(patchInput.salesStatus, "salesStatus", { maxLength: 32 });
    if (hasOwn(patchInput, "sourceStatus")) patch.sourceStatus = readString(patchInput.sourceStatus, "sourceStatus", { maxLength: 32 });
    if (hasOwn(patchInput, "purchasePrice")) patch.purchasePrice = readString(patchInput.purchasePrice, "purchasePrice", { maxLength: 16 });
    if (hasOwn(patchInput, "purchaseUrl")) patch.purchaseUrl = readString(patchInput.purchaseUrl, "purchaseUrl", { maxLength: 512 });
    if (hasOwn(patchInput, "referenceUrl")) patch.referenceUrl = readString(patchInput.referenceUrl, "referenceUrl", { maxLength: 512 });
    if (hasOwn(patchInput, "isBundle")) patch.isBundle = readString(patchInput.isBundle, "isBundle", { maxLength: 8 });
    if (hasOwn(patchInput, "systemCategory")) patch.systemCategory = readString(patchInput.systemCategory, "systemCategory", { maxLength: 128 });
    if (hasOwn(patchInput, "ownerUserId")) patch.ownerUserId = readString(patchInput.ownerUserId, "ownerUserId", { maxLength: 128 });
    if (hasOwn(patchInput, "packForm")) patch.packForm = readString(patchInput.packForm, "packForm", { maxLength: 64 });
    if (hasOwn(patchInput, "packOuter")) patch.packOuter = readString(patchInput.packOuter, "packOuter", { maxLength: 64 });
    if (hasOwn(patchInput, "packCushion")) patch.packCushion = readString(patchInput.packCushion, "packCushion", { maxLength: 64 });
    if (hasOwn(patchInput, "packReinforce")) patch.packReinforce = readString(patchInput.packReinforce, "packReinforce", { maxLength: 64 });
    if (hasOwn(patchInput, "samplePackSize")) patch.samplePackSize = readString(patchInput.samplePackSize, "samplePackSize", { maxLength: 64 });
    if (hasOwn(patchInput, "samplePackWeight")) patch.samplePackWeight = readString(patchInput.samplePackWeight, "samplePackWeight", { maxLength: 64 });
    if (hasOwn(patchInput, "basePackSizeCm")) patch.basePackSizeCm = readString(patchInput.basePackSizeCm, "basePackSizeCm", { maxLength: 64 });
    if (hasOwn(patchInput, "basePackWeightKg")) patch.basePackWeightKg = readString(patchInput.basePackWeightKg, "basePackWeightKg", { maxLength: 64 });
    if (hasOwn(patchInput, "basePackSizeInch")) patch.basePackSizeInch = readString(patchInput.basePackSizeInch, "basePackSizeInch", { maxLength: 64 });
    if (hasOwn(patchInput, "basePackWeightLb")) patch.basePackWeightLb = readString(patchInput.basePackWeightLb, "basePackWeightLb", { maxLength: 64 });
    if (hasOwn(patchInput, "basePackVolumeM3")) patch.basePackVolumeM3 = readString(patchInput.basePackVolumeM3, "basePackVolumeM3", { maxLength: 64 });
    if (hasOwn(patchInput, "itemSizeCm")) patch.itemSizeCm = readString(patchInput.itemSizeCm, "itemSizeCm", { maxLength: 64 });
    if (hasOwn(patchInput, "itemNetWeightKg")) patch.itemNetWeightKg = readString(patchInput.itemNetWeightKg, "itemNetWeightKg", { maxLength: 64 });
    if (hasOwn(patchInput, "cartonSizeCm")) patch.cartonSizeCm = readString(patchInput.cartonSizeCm, "cartonSizeCm", { maxLength: 64 });
    if (hasOwn(patchInput, "cartonWeightKg")) patch.cartonWeightKg = readString(patchInput.cartonWeightKg, "cartonWeightKg", { maxLength: 64 });
    if (hasOwn(patchInput, "cartonVolumeM3")) patch.cartonVolumeM3 = readString(patchInput.cartonVolumeM3, "cartonVolumeM3", { maxLength: 64 });
    if (hasOwn(patchInput, "cartonPcs")) patch.cartonPcs = readString(patchInput.cartonPcs, "cartonPcs", { maxLength: 64 });
    if (hasOwn(patchInput, "baseUnit")) patch.baseUnit = readString(patchInput.baseUnit, "baseUnit", { maxLength: 64 });
    if (hasOwn(patchInput, "cartonLayers")) patch.cartonLayers = readString(patchInput.cartonLayers, "cartonLayers", { maxLength: 64 });
    if (hasOwn(patchInput, "cartonInnerGsm")) patch.cartonInnerGsm = readString(patchInput.cartonInnerGsm, "cartonInnerGsm", { maxLength: 64 });
    if (hasOwn(patchInput, "cartonOuterGsm")) patch.cartonOuterGsm = readString(patchInput.cartonOuterGsm, "cartonOuterGsm", { maxLength: 64 });
    if (hasOwn(patchInput, "laborCost")) patch.laborCost = readString(patchInput.laborCost, "laborCost", { maxLength: 64 });
    if (hasOwn(patchInput, "cartonPrice")) patch.cartonPrice = readString(patchInput.cartonPrice, "cartonPrice", { maxLength: 64 });
    // §9.4：补丁为空 → 400
    if (!Object.keys(patch).length) throw validationError("patch must include at least one updatable field");

    await this.ready();
    const product = await this.requireProduct(companyKey, publicId);
    const result = await this.repository.updateProduct(product.id, { ...patch, expectedRowVersion });
    if (!result || result.ok === false) {
      if (result && result.reason === "version_conflict") {
        throw versionConflictError("The product was modified by another user; please refresh and retry");
      }
      throw notFoundError("Product not found");
    }
    return { product: result.product };
  }

  // ---------- §5 接口 5 ----------

  async deleteProduct(input = {}) {
    const { user, publicId } = input;
    const companyKey = this.requireCompanyKey(user);
    await this.ready();
    const product = await this.requireProduct(companyKey, publicId);
    const result = await this.repository.deleteProduct(product.id);
    if (!result || !result.removed) throw notFoundError("Product not found");
    return { removed: true };
  }

  // ---------- §5 接口 6 ----------

  async addSource(input = {}) {
    const { user, publicId } = input;
    const companyKey = this.requireCompanyKey(user);
    const platform = readEnum(input.platform, "platform", SOURCE_PLATFORMS, { required: true });
    const sourceProductId = readString(input.sourceProductId, "sourceProductId", { required: true, maxLength: 255 });
    const data = {
      platform,
      sourceProductId,
      sourceUrl: readString(input.sourceUrl, "sourceUrl", { maxLength: MAX_TEXT_LENGTH }),
      supplyPrice: readNumber(input.supplyPrice, "supplyPrice", { min: 0, max: 9999999999.99, decimals: 2 }),
      supplyCurrency: readCurrency(input.supplyCurrency),
      moq: readInteger(input.moq, "moq", { min: 0, max: 2147483647 }),
      supplierName: readString(input.supplierName, "supplierName", { maxLength: 255 }),
      supplyStatus: readEnum(input.supplyStatus, "supplyStatus", SUPPLY_STATUSES, { defaultValue: "unknown" }),
      note: readString(input.note, "note", { maxLength: MAX_TEXT_LENGTH })
    };

    await this.ready();
    const product = await this.requireProduct(companyKey, publicId);

    const existing = await this.repository.findSourceByBusinessKey(companyKey, platform, sourceProductId);
    if (existing) throw await this.sourceTakenError(companyKey, existing, product);

    try {
      const source = await this.repository.createSource({ ...data, companyKey, pdevProductId: product.id });
      return { source };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await this.repository.findSourceByBusinessKey(companyKey, platform, sourceProductId);
      throw await this.sourceTakenError(companyKey, raced, product);
    }
  }

  async sourceTakenError(companyKey, existing, product) {
    const ownerId = Number(existing?.pdevProductId) || 0;
    if (!ownerId || ownerId === Number(product?.id)) {
      return new PdevError("SOURCE_TAKEN", "This source is already attached to this product", {
        details: { publicId: product?.publicId || "" }
      });
    }
    let owner = null;
    if (this.repository && typeof this.repository.findProductById === "function") {
      owner = await this.repository.findProductById(companyKey, ownerId);
    }
    const ownerPublicId = owner?.publicId || "";
    return new PdevError(
      "SOURCE_TAKEN",
      ownerPublicId ? `This source already belongs to product ${ownerPublicId}` : "This source already belongs to another product",
      { details: ownerPublicId ? { publicId: ownerPublicId } : {} }
    );
  }

  // ---------- §5 接口 7 ----------

  async updateSource(input = {}) {
    const { user } = input;
    const companyKey = this.requireCompanyKey(user);
    const sourceId = readInteger(input.id, "id", { min: 1 });
    if (sourceId === null) throw notFoundError("Source not found");

    const patch = {};
    if (hasOwn(input, "sourceUrl")) patch.sourceUrl = readString(input.sourceUrl, "sourceUrl", { maxLength: MAX_TEXT_LENGTH });
    if (hasOwn(input, "supplyPrice")) patch.supplyPrice = readNumber(input.supplyPrice, "supplyPrice", { min: 0, max: 9999999999.99, decimals: 2 });
    if (hasOwn(input, "supplyCurrency")) patch.supplyCurrency = readCurrency(input.supplyCurrency);
    if (hasOwn(input, "moq")) patch.moq = readInteger(input.moq, "moq", { min: 0, max: 2147483647 });
    if (hasOwn(input, "supplierName")) patch.supplierName = readString(input.supplierName, "supplierName", { maxLength: 255 });
    if (hasOwn(input, "supplyStatus")) patch.supplyStatus = readEnum(input.supplyStatus, "supplyStatus", SUPPLY_STATUSES, { required: true });
    if (hasOwn(input, "note")) patch.note = readString(input.note, "note", { maxLength: MAX_TEXT_LENGTH });
    // §10.3-2：无任何可更新字段 → 400
    if (!Object.keys(patch).length) throw validationError("No updatable fields provided");

    await this.ready();
    const existing = await this.repository.findSourceById(sourceId);
    if (!existing) throw notFoundError("Source not found");
    await this.requireOwnedProduct(companyKey, existing.pdevProductId);

    const source = await this.repository.updateSource(sourceId, patch);
    if (!source) throw notFoundError("Source not found");
    return { source };
  }

  // ---------- §5 接口 8 ----------

  async deleteSource(input = {}) {
    const { user } = input;
    const companyKey = this.requireCompanyKey(user);
    const sourceId = readInteger(input.id, "id", { min: 1 });
    if (sourceId === null) throw notFoundError("Source not found");
    await this.ready();
    const existing = await this.repository.findSourceById(sourceId);
    if (!existing) throw notFoundError("Source not found");
    await this.requireOwnedProduct(companyKey, existing.pdevProductId);
    const result = await this.repository.deleteSource(sourceId);
    if (!result || !result.removed) throw notFoundError("Source not found");
    return { removed: true };
  }

  // ---------- §5 接口 9 ----------

  async addAsset(input = {}) {
    const { user, publicId } = input;
    const companyKey = this.requireCompanyKey(user);
    const assetType = readEnum(input.assetType, "assetType", ASSET_TYPES, { required: true });
    const sourceUrl = readString(input.sourceUrl, "sourceUrl", { maxLength: MAX_TEXT_LENGTH });
    const storageUrl = readString(input.storageUrl, "storageUrl", { maxLength: MAX_TEXT_LENGTH });
    const sortNo = readInteger(input.sortNo, "sortNo", { min: -2147483648, max: 2147483647 });

    await this.ready();
    const product = await this.requireProduct(companyKey, publicId);
    const asset = await this.repository.createAsset({
      companyKey,
      pdevProductId: product.id,
      assetType,
      sourceUrl,
      storageUrl,
      sortNo: sortNo === null ? 0 : sortNo,
      status: "ready"
    });
    return { asset };
  }

  // ---------- §5 接口 10 ----------

  async deleteAsset(input = {}) {
    const { user } = input;
    const companyKey = this.requireCompanyKey(user);
    const assetId = readInteger(input.id, "id", { min: 1 });
    if (assetId === null) throw notFoundError("Asset not found");
    await this.ready();
    const existing = await this.repository.findAssetById(assetId);
    if (!existing) throw notFoundError("Asset not found");
    await this.requireOwnedProduct(companyKey, existing.pdevProductId);
    const result = await this.repository.deleteAsset(assetId);
    if (!result || !result.removed) throw notFoundError("Asset not found");
    return { removed: true };
  }

  // ---------- §5 接口 11 ----------

  async addVariant(input = {}) {
    const { user, publicId } = input;
    const companyKey = this.requireCompanyKey(user);
    const spec = normalizeSpec(input.spec);
    const variantKey = normalizeVariantKey(spec);
    if (!variantKey) throw validationError("spec must produce a non-empty variant key");
    const data = {
      variantKey,
      spec,
      supplyPrice: readNumber(input.supplyPrice, "supplyPrice", { min: 0, max: 9999999999.99, decimals: 2 }),
      weightKg: readNumber(input.weightKg, "weightKg", { min: 0, max: 9999999.999, decimals: 3 }),
      packageLengthCm: readNumber(input.packageLengthCm, "packageLengthCm", { min: 0, max: 99999999.99, decimals: 2 }),
      packageWidthCm: readNumber(input.packageWidthCm, "packageWidthCm", { min: 0, max: 99999999.99, decimals: 2 }),
      packageHeightCm: readNumber(input.packageHeightCm, "packageHeightCm", { min: 0, max: 99999999.99, decimals: 2 })
    };

    await this.ready();
    const product = await this.requireProduct(companyKey, publicId);

    const existing = await this.repository.findVariantByKey(product.id, variantKey);
    if (existing) throw new PdevError("VARIANT_TAKEN", "A variant with the same specification already exists for this product");

    try {
      const variant = await this.repository.createVariant({ ...data, companyKey, pdevProductId: product.id });
      return { variant };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      throw new PdevError("VARIANT_TAKEN", "A variant with the same specification already exists for this product");
    }
  }

  // ---------- §5 接口 12 ----------

  async changeStatus(input = {}) {
    const { user, publicId } = input;
    const companyKey = this.requireCompanyKey(user);
    const to = readEnum(input.to, "to", PDEV_DEV_STATUSES, { required: true });
    let expectedRowVersion = null;
    if (input.expectedRowVersion !== undefined && input.expectedRowVersion !== null) {
      expectedRowVersion = readInteger(input.expectedRowVersion, "expectedRowVersion", { min: 0 });
    }

    await this.ready();
    const product = await this.requireProduct(companyKey, publicId);

    if (!canTransition(product.devStatus, to)) {
      const allowed = allowedSourceStatuses(to);
      throw validationError(
        `Cannot change dev status from "${product.devStatus}" to "${to}"; allowed source statuses for "${to}": ${allowed.length ? allowed.join(", ") : "(none)"}`
      );
    }

    if (expectedRowVersion !== null && Number(product.rowVersion) !== expectedRowVersion) {
      throw versionConflictError("The product was modified by another user; please refresh and retry");
    }

    if (to === DEV_STATUS.INFO_READY || to === DEV_STATUS.FINALIZED) {
      const stats = await this.repository.getRequirementStats(companyKey, product.id);
      const check = evaluateStatusRequirements(to, stats);
      if (!check.ok) {
        throw validationError(`Product does not meet the requirements for "${to}"`, { missing: check.missing });
      }
    }

    const patch = { devStatus: to };
    if (expectedRowVersion !== null) patch.expectedRowVersion = expectedRowVersion;
    const result = await this.repository.updateProduct(product.id, patch);
    if (!result || result.ok === false) {
      if (result && result.reason === "version_conflict") {
        throw versionConflictError("The product was modified by another user; please refresh and retry");
      }
      throw notFoundError("Product not found");
    }
    return { product: result.product };
  }

  // ---------- §5 接口 13 ----------

  async getSummary(input = {}) {
    const { user } = input;
    const companyKey = this.requireCompanyKey(user);
    await this.ready();
    const counts = await this.repository.getSummaryCounts(companyKey);
    const byStatus = {};
    for (const status of PDEV_DEV_STATUSES) byStatus[status] = Number(counts?.byStatus?.[status]) || 0;
    const missing = {};
    for (const token of Object.values(MISSING_TOKENS)) missing[token] = Number(counts?.missing?.[token]) || 0;
    return { byStatus, missing };
  }
}

function createPdevService(deps = {}) {
  return new PdevService(deps);
}

module.exports = {
  createPdevService,
  PdevService,
  PdevError,
  normalizeVariantKey,
  normalizeSpec,
  resolveCompanyKey,
  PDEV_DEV_STATUSES,
  PDEV_ALLOWED_TRANSITIONS,
  MISSING_TOKEN_ORDER,
  deriveMissingTokens,
  normalizeMissingFilter,
  // 附加导出（测试/调试用，不改变冻结名）
  DEV_STATUS,
  ALLOWED_SOURCE_STATUSES,
  MISSING_TOKENS,
  SOURCE_PLATFORMS,
  SUPPLY_STATUSES,
  ASSET_TYPES,
  canTransition,
  allowedSourceStatuses,
  evaluateStatusRequirements
};
