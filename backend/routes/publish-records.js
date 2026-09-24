// 从 server.js 拆出的路由注册表（publish-records 域：上架记录）。
//
// 只返回「上架动作」的记录（审计日志里 product_publish + publish），
// 不含修改、删除、复制等其他审计事件。
//
// 一次上架请求会写两类审计：商品级（带 resourceId）与请求级汇总（无 resourceId）。
// 上架记录页只取商品级，避免同一次上架出现两行重复记录。

function createPublishRecordsRoutes(deps) {
  const { authService, respondApi, getDb, getUserAssignedShopIds, canUserAccessShop, paginateItems, readPositiveIntParam } = deps;

  const BLOCKED_PATTERN = /拦截|已拦|被拦|低于\s*\d+/;

  function getResultGroup(log) {
    if (!log?.success) return "failed";
    if (BLOCKED_PATTERN.test(String(log?.warningMessage || ""))) return "blocked";
    return "success";
  }

  function getPlatformLabel(item, shop) {
    const provider = String(shop?.provider || item?.publishPlatform || item?.platform || "").trim().toLowerCase();
    if (provider === "yandex_market" || provider === "yandex") return "Yandex";
    if (provider === "ozon") return "Ozon";
    return provider || "-";
  }

  return [
    {
      matches: (pathname, method) => pathname === "/api/publish-records" && method === "GET",
      handler: async (req, res, query, auditBase) => {
        const auth = authService.requireAuth(req, res, { ...auditBase, resourceType: "publish_record" });
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "product.read")) {
          respondApi(req, res, auth.user, { ...auditBase, resourceType: "publish_record" }, 403, { message: "Forbidden" });
          return;
        }
        const shops = getDb().shops || [];
        const assignedShopIds = getUserAssignedShopIds(auth.user, shops);
        const productsById = new Map(
          (getDb().publishProducts || []).map((item) => [String(item?.id || ""), item])
        );

        const records = (getDb().auditLogs || [])
          .filter((log) => String(log?.resourceType || "") === "product_publish" && String(log?.actionType || "") === "publish")
          .filter((log) => String(log?.resourceId || "").trim())
          .map((log) => {
            const product = productsById.get(String(log?.resourceId || ""));
            const shop = product ? shops.find((entry) => String(entry?.id || "") === String(product.shopId || "")) : null;
            const result = getResultGroup(log);
            return {
              id: String(log.id || ""),
              ts: String(log.ts || ""),
              actorUsername: String(log.actorUsername || ""),
              success: result === "success",
              result,
              statusCode: Number(log.statusCode || 0),
              message: String(log.errorMessage || log.warningMessage || ""),
              productId: String(log.resourceId || ""),
              sku: String(product?.sku || product?.shopSku || log.requestBodyMasked?.sku || ""),
              title: String(product?.title || log.requestBodyMasked?.title || ""),
              shopId: String(product?.shopId || ""),
              shopName: String(product?.shopName || shop?.name || ""),
              platform: getPlatformLabel(product, shop),
              publishStatus: String(product?.publishStatus || product?.lastPublishStatus || "")
            };
          })
          .filter((record) => {
            if (assignedShopIds === null) return true;
            if (!record.shopId) return false;
            return canUserAccessShop(auth.user, record.shopId, shops);
          })
          .sort((a, b) => new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime());

        const summary = { total: records.length, success: 0, failed: 0, blocked: 0 };
        for (const record of records) summary[record.result] += 1;

        const keyword = String(query?.keyword || "").trim().toLowerCase();
        const status = String(query?.status || "").trim().toLowerCase();
        const filtered = records.filter((record) => {
          if (["success", "failed", "blocked"].includes(status) && record.result !== status) return false;
          if (keyword) {
            const haystack = [record.sku, record.title, record.actorUsername, record.shopName]
              .map((value) => String(value || "").toLowerCase()).join(" ");
            if (!haystack.includes(keyword)) return false;
          }
          return true;
        });

        const paged = paginateItems(filtered, { ...query, pageSize: readPositiveIntParam(query?.pageSize, 20, 1, 200) }, 20);
        respondApi(req, res, auth.user, { ...auditBase, resourceType: "publish_record" }, 200, {
          items: paged.items,
          pagination: paged.pagination,
          summary
        });
        return;
      }
    }
  ];
}

module.exports = { createPublishRecordsRoutes };
