const { classifyReceiptGroup, matchesCustomerReceiptFilter } = require("./order-receipt-status");
const { isValidOrderStatus } = require("./identity");

// 从 server.js 拆出的订单/审计日志筛选（纯函数）。

function filterOrders(items, query) {
  let result = [...items];
  const orderId = String(query.orderId || "").trim().toLowerCase();
  const customerName = String(query.customerName || "").trim().toLowerCase();
  const status = String(query.status || "").trim();
  const shopName = String(query.shopName || "").trim();
  const shopSku = String(query.shopSku || "").trim().toLowerCase();
  const itemCount = query.itemCount !== undefined && query.itemCount !== "" ? Number(query.itemCount) : null;
  const shopOrderNo = String(query.shopOrderNo || "").trim().toLowerCase();
  const shopStatus = String(query.shopStatus || "").trim().toLowerCase();
  const trackingNo = String(query.trackingNo || "").trim().toLowerCase();
  const domesticTrackingNo = String(query.domesticTrackingNo || "").trim().toLowerCase();
  const purchaseOrderNo = String(query.purchaseOrderNo || "").trim().toLowerCase();
  const purchasePlatform = String(query.purchasePlatform || "").trim().toLowerCase();
  const purchaseStatus = String(query.purchaseStatus || "").trim().toLowerCase();
  const customerReceiptCode = String(query.customerReceiptCode || "").trim().toLowerCase();
  const sellerOrderDate = String(query.sellerOrderDate || "").trim();

  if (orderId) {
    result = result.filter((o) => {
      const platformOrderId = String(o.id || "").toLowerCase();
      const shopOrderNo = String(o.shopOrderNo || o.externalOrderId || "").toLowerCase();
      return platformOrderId.includes(orderId) || shopOrderNo.includes(orderId);
    });
  }
  if (customerName) {
    result = result.filter((o) => String(o.customerName || "").toLowerCase().includes(customerName));
  }
  if (["receipt_signed", "receipt_unsigned", "receipt_exception"].includes(status)) {
    const targetGroup = status.replace(/^receipt_/, "");
    result = result.filter((o) => classifyReceiptGroup(o.customerReceiptCode, o.status) === targetGroup);
  } else if (status && isValidOrderStatus(status)) {
    result = result.filter((o) => o.status === status);
  }
  if (shopName) {
    result = result.filter((o) => String(o.shopName || o.storeName || o.campaignName || "").trim() === shopName);
  }
  if (shopSku) {
    result = result.filter((o) => String(o.shopSku || o.items?.[0]?.shopSku || o.items?.[0]?.offerId || o.items?.[0]?.sku || "").toLowerCase().includes(shopSku));
  }
  if (itemCount !== null && Number.isFinite(itemCount)) {
    result = result.filter((o) => {
      const direct = Number(o.itemCount ?? o.itemsCount ?? o.totalItems);
      if (Number.isFinite(direct)) return direct === itemCount;
      if (!Array.isArray(o.items)) return false;
      const total = o.items.reduce((sum, item) => sum + (Number(item?.count ?? item?.quantity ?? item?.itemCount ?? 1) || 1), 0);
      return total === itemCount;
    });
  }
  if (shopOrderNo) {
    result = result.filter((o) => String(o.shopOrderNo || o.externalOrderId || "").toLowerCase().includes(shopOrderNo));
  }
  if (shopStatus) {
    result = result.filter((o) => String(o.shopStatus || "").toLowerCase().includes(shopStatus));
  }
  if (trackingNo) {
    result = result.filter((o) => String(o.trackingNo || o.trackingId || "").toLowerCase().includes(trackingNo));
  }
  if (domesticTrackingNo) {
    result = result.filter((o) => String(o.domesticTrackingNo || o.purchaseExpressNo || "").toLowerCase().includes(domesticTrackingNo));
  }
  if (purchaseOrderNo) {
    result = result.filter((o) => String(o.purchaseOrderNo || "").toLowerCase().includes(purchaseOrderNo));
  }
  if (purchasePlatform) {
    result = result.filter((o) => String(o.purchasePlatform || "").toLowerCase().includes(purchasePlatform));
  }
  if (purchaseStatus === "purchased" || purchaseStatus === "unpurchased") {
    result = result.filter((o) => {
      const hasPurchase = ["purchaseOrderNo", "purchasePlatform", "purchasePriceRmb", "purchasePriceRub", "purchaseLink", "purchaseExpressNo", "purchaseIntlNo"]
        .some((field) => String(o[field] || "").trim() !== "");
      return purchaseStatus === "purchased" ? hasPurchase : !hasPurchase;
    });
  }
  if (customerReceiptCode) {
    result = result.filter((o) => matchesCustomerReceiptFilter(o.customerReceiptCode, customerReceiptCode));
  }
  if (sellerOrderDate) {
    result = result.filter((o) => {
      const date = new Date(o.sellerOrderAt || o.createdAt || "");
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === sellerOrderDate;
    });
  }

  const amountMin = query.amountMin !== undefined && query.amountMin !== "" ? Number(query.amountMin) : null;
  const amountMax = query.amountMax !== undefined && query.amountMax !== "" ? Number(query.amountMax) : null;
  if (amountMin !== null && Number.isFinite(amountMin)) {
    result = result.filter((o) => Number(o.amount) >= amountMin);
  }
  if (amountMax !== null && Number.isFinite(amountMax)) {
    result = result.filter((o) => Number(o.amount) <= amountMax);
  }

  const dateFrom = query.dateFrom ? new Date(query.dateFrom) : null;
  const dateTo = query.dateTo ? new Date(query.dateTo) : null;
  if (dateFrom && !Number.isNaN(dateFrom.getTime())) {
    const t = dateFrom.getTime();
    result = result.filter((o) => new Date(o.createdAt).getTime() >= t);
  }
  if (dateTo && !Number.isNaN(dateTo.getTime())) {
    const t = dateTo.getTime() + 24 * 60 * 60 * 1000 - 1;
    result = result.filter((o) => new Date(o.createdAt).getTime() <= t);
  }

  result.sort((a, b) => getOrderLatestTimestamp(b) - getOrderLatestTimestamp(a));
  return result;
}

function getOrderLatestTimestamp(order) {
  const candidates = [order?.sellerOrderAt, order?.createdAt, order?.updatedAt];
  for (const value of candidates) {
    const time = new Date(value || 0).getTime();
    if (Number.isFinite(time) && time > 0) return time;
  }
  return 0;
}

function hasFilterQuery(query) {
  return [
    "orderId", "customerName", "status", "amountMin", "amountMax", "dateFrom", "dateTo", "shopName", "shopSku",
    "itemCount", "shopOrderNo", "shopStatus", "trackingNo", "domesticTrackingNo", "purchaseOrderNo", "purchasePlatform",
    "purchaseStatus", "customerReceiptCode", "sellerOrderDate"
  ].some(
    (k) => query[k] !== undefined && String(query[k]).trim() !== ""
  );
}

function filterAuditLogs(items, query) {
  let result = [...items];

  const username = String(query.username || "").trim().toLowerCase();
  const actionType = String(query.actionType || "").trim().toLowerCase();
  const pathText = String(query.path || "").trim().toLowerCase();
  const statusCode = query.statusCode !== undefined && query.statusCode !== "" ? Number(query.statusCode) : null;

  if (username) {
    result = result.filter((l) => String(l.actorUsername || "").toLowerCase().includes(username));
  }
  if (actionType) {
    result = result.filter((l) => String(l.actionType || "").toLowerCase() === actionType);
  }
  if (pathText) {
    result = result.filter((l) => String(l.path || "").toLowerCase().includes(pathText));
  }
  if (statusCode !== null && Number.isFinite(statusCode)) {
    result = result.filter((l) => Number(l.statusCode) === statusCode);
  }

  const dateFrom = query.dateFrom ? new Date(query.dateFrom) : null;
  const dateTo = query.dateTo ? new Date(query.dateTo) : null;
  if (dateFrom && !Number.isNaN(dateFrom.getTime())) {
    const t = dateFrom.getTime();
    result = result.filter((l) => new Date(l.ts).getTime() >= t);
  }
  if (dateTo && !Number.isNaN(dateTo.getTime())) {
    const t = dateTo.getTime() + 24 * 60 * 60 * 1000 - 1;
    result = result.filter((l) => new Date(l.ts).getTime() <= t);
  }

  return result;
}

module.exports = {
  filterAuditLogs,
  filterOrders,
  getOrderLatestTimestamp,
  hasFilterQuery,
};
