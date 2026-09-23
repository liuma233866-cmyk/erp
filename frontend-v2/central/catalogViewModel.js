"use strict";

const STATUS_LABELS = Object.freeze({
  collected: "已采集",
  normalized: "已标准化",
  ready: "可发布",
  archived: "已归档"
});

function productRow(product) {
  return {
    publicId: product.publicId,
    title: product.title || "未命名商品",
    sku: product.canonicalSku || "—",
    status: STATUS_LABELS[product.status] || product.status || "未知",
    stockCount: Number(product.stockCount || 0),
    version: Number(product.currentVersion || 1),
    updatedAt: product.updatedAt || "—"
  };
}

function productDetail(product) {
  return {
    ...productRow(product),
    description: product.description || "",
    variants: (product.variants || []).map((variant) => ({
      systemSku: variant.systemSku,
      variantKey: variant.variantKey,
      attributes: variant.attributes || {},
      stockCount: Number(variant.stockCount || 0)
    })),
    versions: (product.versions || []).map((version) => ({
      versionNo: version.version_no ?? version.versionNo,
      reason: version.change_reason ?? version.changeReason,
      createdAt: version.created_at ?? version.createdAt
    })),
    assets: product.assets || []
  };
}

module.exports = { STATUS_LABELS, productRow, productDetail };

