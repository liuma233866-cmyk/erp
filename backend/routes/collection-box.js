// 从 server.js 拆出的路由注册表（collection-box 域：采集箱）。
//
// 采集箱只读写自己的数据（db.collectionBox，见 page-stores.js）：
// 不进刊登池、不读产品库，删除也只删采集箱自己这一份。

function createCollectionBoxRoutes(deps) {
  const {
    authService,
    respondApi,
    getDb,
    parseJsonBody,
    maskSensitive,
    saveDatabase,
    writeAudit,
    getUserAssignedShopIds,
    canUserAccessShop,
    paginateItems,
    readPositiveIntParam,
    listCollectionBox
  } = deps;

  function getPublishStatusGroup(item) {
    const status = String(item?.publishStatus || item?.lastPublishStatus || "draft").trim().toLowerCase();
    if (status === "success" || status === "published") return "published";
    if (["failed", "blocked", "partial", "error"].includes(status)) return "failed";
    return "pending";
  }

  function canAccessItem(user, item, shops) {
    return canUserAccessShop(user, String(item?.shopId || ""), shops);
  }

  return [
    {
      matches: (pathname, method) => pathname === "/api/collection-box" && method === "GET",
      handler: async (req, res, query, auditBase) => {
        const auth = authService.requireAuth(req, res, { ...auditBase, resourceType: "collection_box" });
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "product.read")) {
          respondApi(req, res, auth.user, { ...auditBase, resourceType: "collection_box" }, 403, { message: "Forbidden" });
          return;
        }
        const shops = getDb().shops || [];
        const assignedShopIds = getUserAssignedShopIds(auth.user, shops);
        const scoped = listCollectionBox(getDb()).filter((item) => {
          if (assignedShopIds === null) return true;
          // 未分配店铺的采集条目只有不受店铺范围限制的用户可见。
          if (!String(item?.shopId || "").trim()) return false;
          return canAccessItem(auth.user, item, shops);
        });

        const summary = { total: scoped.length, pending: 0, published: 0, failed: 0 };
        for (const item of scoped) summary[getPublishStatusGroup(item)] += 1;

        const keyword = String(query?.keyword || "").trim().toLowerCase();
        const sourcePlatform = String(query?.sourcePlatform || "").trim().toLowerCase();
        const status = String(query?.status || "").trim().toLowerCase();
        const filtered = scoped.filter((item) => {
          if (sourcePlatform && String(item?.sourcePlatform || "").trim().toLowerCase() !== sourcePlatform) return false;
          if (status && getPublishStatusGroup(item) !== status) return false;
          if (keyword) {
            const haystack = [
              item?.title,
              item?.sku,
              item?.shopSku,
              item?.sourceProductId,
              item?.sourceUrl,
              item?.collectUrl
            ].map((value) => String(value || "").toLowerCase()).join(" ");
            if (!haystack.includes(keyword)) return false;
          }
          return true;
        }).sort((a, b) => new Date(b?.collectedAt || b?.createdAt || 0).getTime() - new Date(a?.collectedAt || a?.createdAt || 0).getTime());

        const paged = paginateItems(filtered, { ...query, pageSize: readPositiveIntParam(query?.pageSize, 20, 1, 200) }, 20);
        respondApi(req, res, auth.user, { ...auditBase, resourceType: "collection_box" }, 200, {
          items: paged.items.map((item) => ({
            id: String(item.id || ""),
            source: String(item.source || ""),
            sourcePlatform: String(item.sourcePlatform || ""),
            sourceProductId: String(item.sourceProductId || ""),
            sourceUrl: String(item.sourceUrl || item.collectUrl || ""),
            collectBatchId: String(item.collectBatchId || ""),
            title: String(item.title || ""),
            sku: String(item.sku || ""),
            imageUrl: String(item.imageUrl || ""),
            aiImageStatus: String(item.aiImageStatus || ""),
            publishStatus: String(item.publishStatus || item.lastPublishStatus || "draft"),
            statusGroup: getPublishStatusGroup(item),
            publishMessage: String(item.publishMessage || ""),
            shopId: String(item.shopId || ""),
            createdAt: String(item.createdAt || ""),
            updatedAt: String(item.updatedAt || "")
          })),
          pagination: paged.pagination,
          summary
        });
        return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/collection-box" && method === "DELETE",
      handler: async (req, res, query, auditBase) => {
        const body = await parseJsonBody(req);
        const auditContext = { ...auditBase, actionType: "delete", resourceType: "collection_box", requestBodyMasked: maskSensitive(body) };
        const auth = authService.requireAuth(req, res, auditContext);
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "product.sync")) {
          respondApi(req, res, auth.user, auditContext, 403, { message: "Forbidden" });
          return;
        }
        const ids = Array.isArray(body?.ids) ? body.ids.map((value) => String(value || "").trim()).filter(Boolean) : [];
        if (!ids.length) {
          respondApi(req, res, auth.user, auditContext, 400, { message: "ids is required" });
          return;
        }
        const shops = getDb().shops || [];
        const idSet = new Set(ids);
        const box = listCollectionBox(getDb());
        const found = box.filter((item) => idSet.has(String(item?.id || "")));
        const forbidden = found.find((item) => !canAccessItem(auth.user, item, shops));
        if (forbidden) {
          respondApi(req, res, auth.user, auditContext, 403, {
            message: `Forbidden shopId: ${String(forbidden.shopId || "").trim() || "(empty)"}`
          });
          return;
        }
        const before = box.length;
        getDb().collectionBox = box.filter((item) => !idSet.has(String(item?.id || "")));
        const removed = before - getDb().collectionBox.length;
        saveDatabase();
        for (const item of found) {
          writeAudit(req, auth.user, {
            ...auditContext,
            resourceId: String(item.id || ""),
            responseBodyMasked: { deleted: true, title: item.title }
          }, 200, { message: "采集箱条目已删除（不影响刊登工作台）" });
        }
        respondApi(req, res, auth.user, auditContext, 200, { removed });
        return;
      }
    }
  ];
}

module.exports = { createCollectionBoxRoutes };
