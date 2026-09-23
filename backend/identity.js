const crypto = require("crypto");

function isValidOrderStatus(status) {
  return ["pending", "paid", "shipped", "cancelled"].includes(status);
}

function sanitizeIdSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^\w-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildStableOrderId(order) {
  if (!order || typeof order !== "object") return "";
  const provider = String(order.provider || "").trim().toLowerCase();
  const shopOrderNo = String(order.shopOrderNo || order.externalOrderId || order.orderNo || "").trim();
  if (!shopOrderNo) return "";
  if (provider === "yandex_market") {
    const shopId = sanitizeIdSegment(order.shopId || order.account || "unknown");
    const orderNo = sanitizeIdSegment(shopOrderNo);
    if (orderNo) return `ORD-YM-${shopId}-${orderNo}`;
  }
  return "";
}

function getOrderUniqueKey(order) {
  if (!order || typeof order !== "object") return "";
  const stableId = buildStableOrderId(order);
  if (stableId) return stableId;

  const provider = sanitizeIdSegment(order.provider || order.platform || "unknown");
  const shopId = sanitizeIdSegment(order.shopId || order.account || "unknown");
  const shopOrderNo = sanitizeIdSegment(order.shopOrderNo || order.externalOrderId || order.orderNo || order.id || "");
  if (!shopOrderNo) return "";
  return `${provider}-${shopId}-${shopOrderNo}`;
}

function makeId(prefix) {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

function isDedicatedAdminUser(user) {
  return String(user?.username || "").trim().toLowerCase() === "admin";
}

function normalizeCompanyName(value) {
  return String(value || "").trim();
}

function normalizeCompanyId(value) {
  return String(value || "").trim();
}

function sameCompanyEntity(left, right) {
  const leftCompanyId = normalizeCompanyId(left?.companyId || "");
  const rightCompanyId = normalizeCompanyId(right?.companyId || "");
  if (leftCompanyId && rightCompanyId) {
    return leftCompanyId === rightCompanyId;
  }
  return normalizeCompanyName(left?.companyName || "") === normalizeCompanyName(right?.companyName || "");
}

function parseBooleanPermission(value) {
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return null;
}

module.exports = {
  buildStableOrderId,
  getOrderUniqueKey,
  isDedicatedAdminUser,
  isValidOrderStatus,
  makeId,
  normalizeCompanyId,
  normalizeCompanyName,
  parseBooleanPermission,
  sameCompanyEntity,
  sanitizeIdSegment
};
