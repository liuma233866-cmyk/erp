function buildRequestedOrderSyncPlan(shops, orderNos, existingOrders) {
  const scopedShops = Array.isArray(shops) ? shops : [];
  const shopById = new Map(scopedShops.map((shop) => [String(shop?.id || "").trim(), shop]));
  const orderByReference = new Map();
  for (const order of Array.isArray(existingOrders) ? existingOrders : []) {
    const references = [order?.id, order?.shopOrderNo, order?.externalOrderId]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    for (const reference of references) {
      if (!orderByReference.has(reference)) orderByReference.set(reference, order);
    }
  }

  const grouped = new Map();
  const unresolved = [];
  for (const orderNoValue of Array.isArray(orderNos) ? orderNos : []) {
    const orderNo = String(orderNoValue || "").trim();
    if (!orderNo) continue;
    const existing = orderByReference.get(orderNo);
    const shopId = String(existing?.shopId || "").trim();
    const shop = shopById.get(shopId);
    if (!shop) {
      unresolved.push(orderNo);
      continue;
    }
    if (!grouped.has(shopId)) grouped.set(shopId, { shop, orderNos: [] });
    grouped.get(shopId).orderNos.push(orderNo);
  }
  return { plans: Array.from(grouped.values()), unresolved };
}

const { normalizeYandexDateInput } = require("./datetime");



// 从 server.js 拆出的订单同步请求参数归一化。

function normalizeOrderSyncOptions(raw) {
  const body = raw && typeof raw === "object" ? raw : {};
  const shopIds = Array.isArray(body.shopIds)
    ? body.shopIds.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const orderNosRaw = Array.isArray(body.orderNos)
    ? body.orderNos
    : String(body.orderNos || "")
        .split(/[\s,，;；]+/);
  const orderNos = Array.from(new Set(orderNosRaw.map((item) => String(item || "").trim()).filter(Boolean)));
  const fromDate = normalizeYandexDateInput(body.fromDate);
  const toDate = normalizeYandexDateInput(body.toDate);
  return { shopIds, orderNos, fromDate, toDate };
}

module.exports = { buildRequestedOrderSyncPlan, normalizeOrderSyncOptions };
