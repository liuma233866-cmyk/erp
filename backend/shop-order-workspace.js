const ORDER_WORKSPACE_V1 = "v1";
const ORDER_WORKSPACE_V2 = "v2";

function normalizeOrderWorkspace(value) {
  return String(value || "").trim().toLowerCase() === ORDER_WORKSPACE_V2 ? ORDER_WORKSPACE_V2 : ORDER_WORKSPACE_V1;
}

function getShopOrderWorkspace(shop, overrides) {
  const shopId = String(shop?.id || "").trim();
  const configured = shopId && overrides && typeof overrides === "object" ? overrides[shopId] : "";
  return normalizeOrderWorkspace(configured || shop?.orderWorkspace);
}

function orderBelongsToWorkspace(order, shops, overrides, workspace) {
  const shopId = String(order?.shopId || "").trim();
  const shop = (Array.isArray(shops) ? shops : []).find((item) => String(item?.id || "").trim() === shopId);
  return getShopOrderWorkspace(shop, overrides) === normalizeOrderWorkspace(workspace);
}

module.exports = {
  ORDER_WORKSPACE_V1,
  ORDER_WORKSPACE_V2,
  getShopOrderWorkspace,
  normalizeOrderWorkspace,
  orderBelongsToWorkspace
};
