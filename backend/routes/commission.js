// 从 server.js 拆出的路由注册表（yandex-commission 域）。

function createCommissionRoutes(deps) {
  const { authService, respondApi, getDb, normalizeYandexCommissionCatalog, readPositiveIntParam, syncYandexCommissionCatalogFromOnlineProducts } = deps;
  return [
    {
      matches: (pathname, method) => pathname === "/api/yandex/commission-catalog" && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const auth = authService.requireAuth(req, res, auditBase);
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "yandex_commission" }, 403, { message: "Forbidden" });
              return;
            }
            const catalog = normalizeYandexCommissionCatalog(getDb().yandexCommissionCatalog || {});
            const page = readPositiveIntParam(url.searchParams.get("page"), 1, 1, 100000);
            const pageSize = readPositiveIntParam(url.searchParams.get("pageSize"), 20, 10, 200);
            const total = Number(catalog.itemCount || (Array.isArray(catalog.items) ? catalog.items.length : 0)) || 0;
            const totalPages = Math.max(1, Math.ceil(total / pageSize));
            const safePage = Math.min(totalPages, page);
            const start = (safePage - 1) * pageSize;
            const end = start + pageSize;
            const pageItems = Array.isArray(catalog.items) ? catalog.items.slice(start, end) : [];
            respondApi(req, res, auth.user, { ...auditBase, resourceType: "yandex_commission" }, 200, {
              source: catalog.source,
              warning: catalog.warning || "",
              links: catalog.links,
              fetchedAt: catalog.fetchedAt,
              itemCount: catalog.itemCount,
              page: safePage,
              pageSize,
              totalPages,
              items: pageItems
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/yandex/commission-catalog/sync" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "update", resourceType: "yandex_commission" });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "yandex_commission" }, 403, { message: "Forbidden" });
              return;
            }
            const result = await syncYandexCommissionCatalogFromOnlineProducts();
            if (!result.ok) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "yandex_commission" }, result.status || 502, {
                message: result.message || "Sync failed"
              });
              return;
            }
            const catalog = normalizeYandexCommissionCatalog(result.data || {});
            respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "yandex_commission" }, 200, {
              source: catalog.source,
              warning: catalog.warning || "",
              links: catalog.links,
              fetchedAt: catalog.fetchedAt,
              itemCount: catalog.itemCount
            });
            return;
      }
    },
  ];
}

module.exports = { createCommissionRoutes };
