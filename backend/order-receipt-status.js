const RECEIVED_SUBSTATUSES = new Set([
  "USER_RECEIVED",
  "PICKUP_USER_RECEIVED",
  "DELIVERED_USER_RECEIVED"
]);

const NOT_RECEIVED_SUBSTATUSES = new Set([
  "DELIVERY_USER_NOT_RECEIVED",
  "DELIVERED_USER_NOT_RECEIVED"
]);

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function classifyYandexCustomerReceipt(statusValue, substatusValue) {
  const status = normalizeCode(statusValue);
  const substatus = normalizeCode(substatusValue);

  if (RECEIVED_SUBSTATUSES.has(substatus)) {
    return result("received", "已收货", "Received", true);
  }
  if (NOT_RECEIVED_SUBSTATUSES.has(substatus)) {
    return result("not_received", "顾客未收到", "Customer not received", false);
  }
  if (status === "DELIVERED") {
    return result("received", "已收货", "Received", true);
  }
  if (status === "PICKUP" || ["READY_FOR_PICKUP", "PICKUP_SERVICE_RECEIVED"].includes(substatus)) {
    return result("ready_for_pickup", "待顾客取件", "Ready for pickup", false);
  }
  if (status === "DELIVERY") {
    return result("in_delivery", "配送中", "In delivery", false);
  }
  if (status === "RETURNED") {
    return result("returned", "已退货", "Returned", false);
  }
  if (status === "PARTIALLY_RETURNED") {
    return result("partially_returned", "部分退货", "Partially returned", false);
  }
  if (status === "CANCELLED" || status === "CANCELED") {
    return result("cancelled", "已取消", "Cancelled", false);
  }
  if (["PLACING", "RESERVED", "UNPAID", "PROCESSING", "PENDING"].includes(status)) {
    return result("not_dispatched", "尚未配送", "Not dispatched", false);
  }
  return result("unknown", "状态未知", "Unknown", false);
}

function result(code, labelZh, labelEn, received) {
  return { code, labelZh, labelEn, received };
}

function matchesCustomerReceiptFilter(receiptCodeValue, filterValue) {
  const receiptCode = String(receiptCodeValue || "").trim().toLowerCase();
  const filter = String(filterValue || "").trim().toLowerCase();
  if (!filter) return true;
  if (filter === "returned") return receiptCode === "returned" || receiptCode === "partially_returned";
  return receiptCode === filter;
}

function classifyReceiptGroup(receiptCodeValue, lifecycleStatusValue = "") {
  const receiptCode = String(receiptCodeValue || "").trim().toLowerCase();
  const lifecycleStatus = String(lifecycleStatusValue || "").trim().toLowerCase();
  if (receiptCode === "received") return "signed";
  if (["not_received", "returned", "partially_returned"].includes(receiptCode)) return "exception";
  if (["ready_for_pickup", "in_delivery"].includes(receiptCode)) return "unsigned";
  if (!receiptCode && lifecycleStatus === "shipped") return "unsigned";
  return "";
}

module.exports = { classifyReceiptGroup, classifyYandexCustomerReceipt, matchesCustomerReceiptFilter };
