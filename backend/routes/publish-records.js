// 从 server.js 拆出的路由注册表（publish-records 域：上架记录）。
//
// 上架记录只读自己的数据（db.publishRecords，见 page-stores.js）：
// 上架动作发生时写一条快照（当时的时间、操作人、SKU、标题、店铺、结果），
// 不读审计日志，也不依赖刊登池里的商品是否还在。

function createPublishRecordsRoutes(deps) {
  const { authService, respondApi, getDb, getUserAssignedShopIds, canUserAccessShop, paginateItems, readPositiveIntParam, listPublishRecords } = deps;

  function toRecordItem(record) {
    return {
      id: String(record?.id || ""),
      ts: String(record?.ts || ""),
      actorUsername: String(record?.actorUsername || ""),
      result: String(record?.result || "success"),
      success: String(record?.result || "success") === "success",
      statusCode: Number(record?.statusCode || 0) || 0,
      message: String(record?.message || ""),
      productId: String(record?.productId || ""),
      sku: String(record?.sku || ""),
      title: String(record?.title || ""),
      shopId: String(record?.shopId || ""),
      shopName: String(record?.shopName || ""),
      platform: String(record?.platform || "-"),
      publishStatus: String(record?.publishStatus || "")
    };
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
        const records = listPublishRecords(getDb())
          .filter((record) => {
            if (assignedShopIds === null) return true;
            if (!record.shopId) return false;
            return canUserAccessShop(auth.user, record.shopId, shops);
          })
          .map(toRecordItem)
          .sort((a, b) => new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime());

        const summary = { total: records.length, success: 0, failed: 0, blocked: 0, pending: 0 };
        for (const record of records) {
          if (Object.prototype.hasOwnProperty.call(summary, record.result)) summary[record.result] += 1;
        }

        const keyword = String(query?.keyword || "").trim().toLowerCase();
        const status = String(query?.status || "").trim().toLowerCase();
        const filtered = records.filter((record) => {
          if (["success", "failed", "blocked", "pending"].includes(status) && record.result !== status) return false;
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
