const { normalizeRole, ROLE_ADMIN, ROLE_SUPERVISOR } = require("./permissions");
const { sameCompanyEntity } = require("./identity");

// 从 server.js 拆出的店铺分配与访问控制（纯函数，无共享状态）。

function normalizeShopAssignments(raw, shops, companyScope = null) {
  const ids = Array.isArray(raw) ? raw.map((id) => String(id || "").trim()).filter(Boolean) : [];
  if (!Array.isArray(shops) || !shops.length) return Array.from(new Set(ids));
  const valid = new Set(
    shops
      .filter((shop) => !companyScope || sameCompanyEntity(shop, companyScope))
      .map((s) => String(s.id || "").trim())
      .filter(Boolean)
  );
  return Array.from(new Set(ids.filter((id) => valid.has(id))));
}

function getUserAssignedShopIds(user, shops) {
  if (!user) return [];
  const role = normalizeRole(user.role, user.username);
  if (role === ROLE_ADMIN) return null;
  if (role === ROLE_SUPERVISOR) {
    return Array.isArray(shops)
      ? shops
          .filter((shop) => sameCompanyEntity(shop, user))
          .map((shop) => String(shop?.id || "").trim())
          .filter(Boolean)
      : [];
  }
  return normalizeShopAssignments(user.shopAssignments, shops, user);
}

function canUserAccessShop(user, shopId, shops) {
  const normalizedShopId = String(shopId || "").trim();
  const scope = getUserAssignedShopIds(user, shops);
  if (scope === null) return true;
  if (!normalizedShopId) return false;
  return scope.includes(normalizedShopId);
}

function resolveExplicitShopId(shopId, shops) {
  const normalizedShopId = String(shopId || "").trim();
  if (!normalizedShopId) {
    return { ok: false, statusCode: 400, message: "shopId is required" };
  }
  const exists = Array.isArray(shops) && shops.some((shop) => String(shop?.id || "").trim() === normalizedShopId);
  if (!exists) {
    return { ok: false, statusCode: 400, message: "Invalid shopId" };
  }
  return { ok: true, shopId: normalizedShopId };
}

function resolveScopedDraftShopId(user, shopId, shops) {
  const normalizedShopId = String(shopId || "").trim();
  const scope = getUserAssignedShopIds(user, shops);
  if (scope === null) {
    if (!normalizedShopId) return { ok: true, shopId: "" };
    return resolveExplicitShopId(normalizedShopId, shops);
  }
  if (!scope.length) {
    return { ok: false, statusCode: 403, message: "No assigned shops available" };
  }
  if (!normalizedShopId) {
    if (scope.length === 1) {
      return { ok: true, shopId: scope[0], autoAssigned: true };
    }
    return { ok: false, statusCode: 400, message: "shopId is required" };
  }
  if (!scope.includes(normalizedShopId)) {
    return { ok: false, statusCode: 403, message: `Forbidden shopId: ${normalizedShopId}` };
  }
  return { ok: true, shopId: normalizedShopId };
}

function resolvePublishTargetShopId(user, item, fallbackShopId, shops) {
  const normalizedShopId = String(item?.shopId || fallbackShopId || "").trim();
  if (!normalizedShopId) {
    return { ok: false, statusCode: 400, message: "shopId is required" };
  }
  const explicit = resolveExplicitShopId(normalizedShopId, shops);
  if (!explicit.ok) return explicit;
  if (!user) {
    return { ok: true, shopId: normalizedShopId };
  }
  if (!canUserAccessShop(user, normalizedShopId, shops)) {
    return { ok: false, statusCode: 403, message: `Forbidden shopId: ${normalizedShopId}` };
  }
  return { ok: true, shopId: normalizedShopId };
}

function resolvePublishPlatformFromShopId(shopId, shops) {
  const normalizedShopId = String(shopId || "").trim();
  if (!normalizedShopId || !Array.isArray(shops)) return "";
  const shop = shops.find((entry) => String(entry?.id || "").trim() === normalizedShopId);
  const provider = String(shop?.provider || "").trim().toLowerCase();
  if (provider === "ozon") return "ozon";
  if (provider === "yandex_market" || provider === "yandex") return "yandex";
  return "";
}



// 从 server.js 拆出的订单/产品店铺归属附加与过滤。

function attachShopIdsToOrders(orders, shops) {
  if (!Array.isArray(orders) || !Array.isArray(shops)) return;
  const byCampaign = new Map();
  const byName = new Map();
  const byId = new Set();
  for (const shop of shops) {
    const id = String(shop.id || "").trim();
    if (id) byId.add(id);
    const campaignId = String(shop.campaignId || "").trim();
    if (campaignId) byCampaign.set(campaignId, shop);
    const name = String(shop.name || "").trim();
    if (name) byName.set(name, shop);
  }

  for (const order of orders) {
    const existing = String(order.shopId || "").trim();
    if (existing && byId.has(existing)) continue;
    const campaignId = String(order.account || order.shopAccount || "").trim();
    if (campaignId && byCampaign.has(campaignId)) {
      order.shopId = byCampaign.get(campaignId).id;
      continue;
    }
    const name = String(order.shopName || "").trim();
    if (name && byName.has(name)) {
      order.shopId = byName.get(name).id;
    }
  }
}

function attachShopIdsToOnlineProducts(items, shops) {
  if (!Array.isArray(items) || !Array.isArray(shops)) return;
  const byCampaign = new Map();
  const byName = new Map();
  const byId = new Set();
  for (const shop of shops) {
    const id = String(shop.id || "").trim();
    if (id) byId.add(id);
    const campaignId = String(shop.campaignId || "").trim();
    if (campaignId) byCampaign.set(campaignId, shop);
    const name = String(shop.name || "").trim();
    if (name) byName.set(name, shop);
  }
  for (const product of items) {
    const existing = String(product.shopId || "").trim();
    if (existing && byId.has(existing)) {
      const shop = shops.find((item) => String(item.id || "") === existing);
      if (shop) {
        if (!product.shopName) product.shopName = String(shop.name || "");
        if (!product.companyId) product.companyId = String(shop.companyId || "");
      }
      continue;
    }
    const campaignId = String(product.campaignId || product.account || "").trim();
    if (campaignId && byCampaign.has(campaignId)) {
      const shop = byCampaign.get(campaignId);
      product.shopId = shop.id;
      if (!product.shopName) product.shopName = String(shop.name || "");
      if (!product.companyId) product.companyId = String(shop.companyId || "");
      continue;
    }
    const name = String(product.shopName || "").trim();
    if (name && byName.has(name)) {
      const shop = byName.get(name);
      product.shopId = shop.id;
      if (!product.companyId) product.companyId = String(shop.companyId || "");
    }
  }
}

function filterOrdersByAssignments(orders, assignedShopIds, shops) {
  if (!Array.isArray(assignedShopIds) || !assignedShopIds.length) return orders;
  const assigned = new Set(assignedShopIds.map(String));
  const byCampaign = new Map();
  const byName = new Map();
  for (const shop of shops || []) {
    const id = String(shop.id || "").trim();
    if (!id || !assigned.has(id)) continue;
    const campaignId = String(shop.campaignId || "").trim();
    if (campaignId) byCampaign.set(campaignId, true);
    const name = String(shop.name || "").trim();
    if (name) byName.set(name, true);
  }
  return (orders || []).filter((order) => {
    const orderShopId = String(order.shopId || "").trim();
    if (orderShopId && assigned.has(orderShopId)) return true;
    const campaignId = String(order.account || order.shopAccount || "").trim();
    if (campaignId && byCampaign.has(campaignId)) return true;
    const name = String(order.shopName || "").trim();
    if (name && byName.has(name)) return true;
    return false;
  });
}

function filterOnlineProductsByAssignments(items, assignedShopIds, shops) {
  if (!Array.isArray(assignedShopIds) || !assignedShopIds.length) return items;
  const assigned = new Set(assignedShopIds.map(String));
  const byCampaign = new Map();
  const byName = new Map();
  for (const shop of shops || []) {
    const id = String(shop.id || "").trim();
    if (!id || !assigned.has(id)) continue;
    const campaignId = String(shop.campaignId || "").trim();
    if (campaignId) byCampaign.set(campaignId, true);
    const name = String(shop.name || "").trim();
    if (name) byName.set(name, true);
  }
  return (items || []).filter((product) => {
    const shopId = String(product.shopId || "").trim();
    if (shopId && assigned.has(shopId)) return true;
    const campaignId = String(product.campaignId || "").trim();
    if (campaignId && byCampaign.has(campaignId)) return true;
    const name = String(product.shopName || "").trim();
    if (name && byName.has(name)) return true;
    return false;
  });
}

module.exports = {
  attachShopIdsToOnlineProducts,
  attachShopIdsToOrders,
  filterOnlineProductsByAssignments,
  filterOrdersByAssignments,

  canUserAccessShop,
  getUserAssignedShopIds,
  normalizeShopAssignments,
  resolveExplicitShopId,
  resolvePublishPlatformFromShopId,
  resolvePublishTargetShopId,
  resolveScopedDraftShopId,
};
