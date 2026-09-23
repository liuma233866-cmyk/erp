"use strict";

const crypto = require("node:crypto");
const { ERROR_CODES, V2Error } = require("../core/errorCodes");
const { toMysqlDatetime } = require("../core/dateTime");

function requireCompanyId(companyId) {
  const value = String(companyId || "").trim();
  if (!value) throw new V2Error(ERROR_CODES.TENANT_REQUIRED, "A company tenant is required");
  return value;
}

function normalizeText(value, field, maxLength) {
  const result = String(value ?? "").trim();
  if (!result) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, `${field} is required`);
  if (result.length > maxLength) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, `${field} is too long`);
  return result;
}

function normalizeCanonicalSku(value) {
  const result = String(value || "").trim().toUpperCase();
  if (result.length > 128) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "canonicalSku is too long");
  return result || null;
}

const PRODUCT_STATUSES = new Set(["collected", "normalized", "draft", "ready", "published", "archived", "blocked"]);
function normalizeProductStatus(value) {
  const status = String(value || "collected").trim().toLowerCase();
  if (!PRODUCT_STATUSES.has(status)) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "status is invalid");
  return status;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [String(key).trim().toLowerCase(), stableValue(value[key])]));
  }
  if (typeof value === "string") return value.trim().toLowerCase();
  return value;
}

function normalizeVariantAttributes(attributes = {}) {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "variant attributes must be an object");
  }
  const normalized = stableValue(attributes);
  const entries = Object.entries(normalized).filter(([key, value]) => key && value !== null && value !== undefined && value !== "");
  if (!entries.length) return { attributes: {}, variantKey: "default" };
  const variantKey = entries.map(([key, value]) => {
    const rendered = typeof value === "object" ? JSON.stringify(value) : String(value);
    return `${encodeURIComponent(key)}=${encodeURIComponent(rendered)}`;
  }).join(";");
  if (variantKey.length > 128) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "variantKey is too long");
  return { attributes: Object.fromEntries(entries), variantKey };
}

function createPublicId(prefix = "CP") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function productSnapshot(product) {
  return {
    publicId: product.publicId,
    companyId: product.companyId,
    canonicalSku: product.canonicalSku,
    title: product.title,
    description: product.description || "",
    brand: product.brand || "",
    categoryId: product.categoryId || "",
    purchasePrice: product.purchasePrice ?? null,
    currency: product.currency || "CNY",
    packageLengthCm: product.packageLengthCm ?? null,
    packageWidthCm: product.packageWidthCm ?? null,
    packageHeightCm: product.packageHeightCm ?? null,
    weightKg: product.weightKg ?? null,
    stockCount: product.stockCount ?? 0,
    status: product.status || "collected",
    currentVersion: product.currentVersion || 1
  };
}

class CentralCatalogService {
  constructor({ repository, clock = () => new Date(), publicIdFactory = createPublicId } = {}) {
    if (!repository) throw new TypeError("A central catalog repository is required");
    this.repository = repository;
    this.clock = clock;
    this.publicIdFactory = publicIdFactory;
  }

  async transaction(work) {
    return typeof this.repository.transaction === "function"
      ? this.repository.transaction(work)
      : work(this.repository);
  }

  normalizeProductInput(input, { partial = false } = {}) {
    const product = input || {};
    const result = {
      companyId: requireCompanyId(product.companyId),
      publicId: product.publicId ? normalizeText(product.publicId, "publicId", 40) : undefined,
      canonicalSku: normalizeCanonicalSku(product.canonicalSku),
      title: partial && product.title === undefined ? undefined : normalizeText(product.title, "title", 500),
      description: product.description == null ? "" : String(product.description),
      brand: product.brand == null ? "" : String(product.brand),
      categoryId: product.categoryId == null ? "" : String(product.categoryId),
      purchasePrice: product.purchasePrice ?? null,
      currency: String(product.currency || "CNY").trim().toUpperCase(),
      packageLengthCm: product.packageLengthCm ?? null,
      packageWidthCm: product.packageWidthCm ?? null,
      packageHeightCm: product.packageHeightCm ?? null,
      weightKg: product.weightKg ?? null,
      stockCount: Number(product.stockCount ?? 0),
      status: normalizeProductStatus(product.status),
      createdBy: product.createdBy ?? null,
      updatedBy: product.updatedBy ?? product.createdBy ?? null,
      variants: product.variants || []
    };
    if (!/^[A-Z]{3}$/.test(result.currency)) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "currency must be a 3-letter code");
    if (!Number.isInteger(result.stockCount) || result.stockCount < 0) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "stockCount must be a non-negative integer");
    if (!Array.isArray(result.variants)) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "variants must be an array");
    return result;
  }

  async createProduct(input) {
    const normalized = this.normalizeProductInput(input);
    const existing = normalized.canonicalSku
      ? await this.repository.findProductByCanonicalSku(normalized.companyId, normalized.canonicalSku)
      : null;
    if (existing) return { product: existing, deduplicated: true };
    return this.transaction(async (repository) => {
      const concurrent = normalized.canonicalSku
        ? await repository.findProductByCanonicalSku(normalized.companyId, normalized.canonicalSku)
        : null;
      if (concurrent) return { product: concurrent, deduplicated: true };
      const now = toMysqlDatetime(this.clock());
      const product = await repository.createProduct({
        ...normalized,
        publicId: normalized.publicId || this.publicIdFactory("CP"),
        currentVersion: 1,
        createdAt: now,
        updatedAt: now,
        rowVersion: 0
      });
      await repository.createVersion({
        centralProductId: product.id,
        versionNo: 1,
        payload: productSnapshot(product),
        changeReason: "create",
        createdBy: normalized.createdBy,
        createdAt: now
      });
      const variants = normalized.variants.length ? normalized.variants : [{ systemSku: normalized.canonicalSku || product.publicId, attributes: {} }];
      for (const variant of variants) {
        const attributes = normalizeVariantAttributes(variant.attributes);
        await repository.createVariant({
          companyId: normalized.companyId,
          centralProductId: product.id,
          variantKey: attributes.variantKey,
          systemSku: normalizeText(variant.systemSku || `${product.publicId}-${attributes.variantKey}`, "systemSku", 128),
          attributes: attributes.attributes,
          titleSuffix: variant.titleSuffix || null,
          purchasePrice: variant.purchasePrice ?? normalized.purchasePrice,
          stockCount: Number(variant.stockCount ?? normalized.stockCount ?? 0),
          status: variant.status || "active",
          createdAt: now,
          updatedAt: now
        });
      }
      return { product, deduplicated: false };
    });
  }

  async ingestCollectedItem(input) {
    const item = input || {};
    const companyId = requireCompanyId(item.companyId);
    const sourcePlatform = normalizeText(item.sourcePlatform, "sourcePlatform", 32).toLowerCase();
    const sourceProductId = normalizeText(item.sourceProductId, "sourceProductId", 255);
    const existingSource = await this.repository.findSource(companyId, sourcePlatform, sourceProductId);
    if (existingSource) return { kind: "duplicate", source: existingSource, centralProductId: existingSource.centralProductId };
    const productInput = { ...item, companyId, canonicalSku: item.canonicalSku || item.rawPayload?.sku || "" };
    return this.transaction(async (repository) => {
      const concurrentSource = await repository.findSource(companyId, sourcePlatform, sourceProductId);
      if (concurrentSource) return { kind: "duplicate", source: concurrentSource, centralProductId: concurrentSource.centralProductId };
      const created = await this.createProductWithRepository(repository, productInput);
      const source = await repository.createSource({
        companyId,
        centralProductId: created.product.id,
        sourcePlatform,
        sourceProductId,
        sourceUrl: item.sourceUrl || null,
        rawPayload: item.rawPayload || {},
        collectedAt: toMysqlDatetime(this.clock()),
        collectionBatchId: item.collectionBatchId || null
      });
      return { kind: created.deduplicated ? "matched" : "created", source, centralProductId: created.product.id, product: created.product };
    });
  }

  async createProductWithRepository(repository, input) {
    const normalized = this.normalizeProductInput(input);
    const existing = normalized.canonicalSku
      ? await repository.findProductByCanonicalSku(normalized.companyId, normalized.canonicalSku)
      : null;
    if (existing) return { product: existing, deduplicated: true };
    const now = toMysqlDatetime(this.clock());
    const product = await repository.createProduct({
      ...normalized,
      publicId: normalized.publicId || this.publicIdFactory("CP"),
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      rowVersion: 0
    });
    await repository.createVersion({ centralProductId: product.id, versionNo: 1, payload: productSnapshot(product), changeReason: "collect", createdBy: normalized.createdBy, createdAt: now });
    const variants = normalized.variants.length ? normalized.variants : [{ systemSku: normalized.canonicalSku || product.publicId, attributes: {} }];
    for (const variant of variants) {
      const attributes = normalizeVariantAttributes(variant.attributes);
      await repository.createVariant({ companyId: normalized.companyId, centralProductId: product.id, variantKey: attributes.variantKey, systemSku: normalizeText(variant.systemSku || `${product.publicId}-${attributes.variantKey}`, "systemSku", 128), attributes: attributes.attributes, titleSuffix: variant.titleSuffix || null, purchasePrice: variant.purchasePrice ?? normalized.purchasePrice, stockCount: Number(variant.stockCount ?? normalized.stockCount ?? 0), status: variant.status || "active", createdAt: now, updatedAt: now });
    }
    return { product, deduplicated: false };
  }

  async updateProduct({ companyId, publicId, expectedRowVersion, patch, actorId, changeReason = "manual" }) {
    const tenant = requireCompanyId(companyId);
    const current = await this.repository.findProductByPublicId(tenant, normalizeText(publicId, "publicId", 40));
    if (!current) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Central product not found", { publicId });
    if (Number(current.rowVersion) !== Number(expectedRowVersion)) throw new V2Error(ERROR_CODES.ROW_VERSION_CONFLICT, "Central product was changed by another request");
    const normalized = this.normalizeProductInput({ ...current, ...patch, companyId: tenant, publicId: current.publicId, updatedBy: actorId }, { partial: false });
    return this.transaction(async (repository) => {
      const now = toMysqlDatetime(this.clock());
      const nextVersion = Number(current.currentVersion || 1) + 1;
      const updated = await repository.updateProduct({ ...normalized, currentVersion: nextVersion, updatedAt: now, updatedBy: actorId, publicId: current.publicId, expectedRowVersion });
      if (!updated) throw new V2Error(ERROR_CODES.ROW_VERSION_CONFLICT, "Central product was changed by another request");
      await repository.createVersion({ centralProductId: current.id, versionNo: nextVersion, payload: productSnapshot({ ...current, ...normalized, currentVersion: nextVersion }), changeReason, createdBy: actorId, createdAt: now });
      return updated;
    });
  }

  async addVariant(input) {
    const companyId = requireCompanyId(input?.companyId);
    const attributes = normalizeVariantAttributes(input?.attributes);
    return this.repository.createVariant({ ...input, companyId, variantKey: attributes.variantKey, attributes: attributes.attributes, systemSku: normalizeText(input?.systemSku, "systemSku", 128), createdAt: toMysqlDatetime(this.clock()), updatedAt: toMysqlDatetime(this.clock()) });
  }

  async addAsset(input) {
    const companyId = requireCompanyId(input?.companyId);
    const checksum = normalizeText(input?.checksum, "checksum", 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(checksum)) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "checksum must be a SHA-256 hex digest");
    return this.repository.createAsset({
      ...input,
      companyId,
      checksum,
      sourceUrl: input.sourceUrl || null,
      storageUrl: input.storageUrl || null,
      sortNo: Number(input.sortNo || 0),
      status: input.status || "pending",
      metadata: input.metadata || {},
      createdAt: toMysqlDatetime(this.clock()),
      updatedAt: toMysqlDatetime(this.clock())
    });
  }

  listProducts(companyId, filters = {}) {
    return this.repository.listProducts(requireCompanyId(companyId), filters);
  }

  getProduct(companyId, publicId) {
    return this.repository.getProductDetail(requireCompanyId(companyId), normalizeText(publicId, "publicId", 40));
  }
}

module.exports = {
  CentralCatalogService,
  createPublicId,
  normalizeCanonicalSku,
  normalizeVariantAttributes,
  productSnapshot
};
