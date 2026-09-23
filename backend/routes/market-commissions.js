// 从 server.js 拆出的路由注册表（market-commissions 域）。

function createMarketCommissionRoutes(deps) {
  const { authService, respondApi, getDb, readPositiveIntParam, normalizeYandexCommissionCatalog, parseJsonBody, maskSensitive, syncYandexCommissionCatalogFromOnlineProducts, saveDatabase } = deps;
  return [
    {
      matches: (pathname, method) => pathname === "/api/market-category-commissions" && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url, clientIp) => {
            const auth = authService.requireAuth(req, res, auditBase);
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "market_commission" }, 403, { message: "Forbidden" });
              return;
            }
            const platform = String(query.platform || "yandex").trim().toLowerCase();
            const page = readPositiveIntParam(query.page, 1, 1, 100000);
            const pageSize = readPositiveIntParam(query.pageSize, 20, 10, 200);
            if (platform !== "yandex" && platform !== "ozon") {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "market_commission" }, 400, { message: "Unsupported platform" });
              return;
            }
            const catalog = platform === "yandex" ? normalizeYandexCommissionCatalog(getDb().yandexCommissionCatalog || {}) : { items: [], itemCount: 0, fetchedAt: "", source: "not_configured" };
            const items = Array.isArray(catalog.items) ? catalog.items : [];
            const itemCount = Number(catalog.itemCount || items.length) || 0;
            const totalPages = Math.max(1, Math.ceil(itemCount / pageSize));
            const safePage = Math.min(totalPages, page);
            respondApi(req, res, auth.user, { ...auditBase, resourceType: "market_commission" }, 200, {
              platform,
              source: catalog.source || "",
              warning: catalog.warning || (platform === "ozon" ? "Ozon 类目佣金接口尚未配置" : ""),
              fetchedAt: catalog.fetchedAt || "",
              itemCount,
              page: safePage,
              pageSize,
              totalPages,
              items: items.slice((safePage - 1) * pageSize, safePage * pageSize)
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/market-category-commissions/sync" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url, clientIp) => {
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "update", resourceType: "market_commission", requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "market_commission" }, 403, { message: "Forbidden" });
              return;
            }
            const platform = String(body?.platform || "yandex").trim().toLowerCase();
            if (platform === "ozon") {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "market_commission" }, 200, {
                platform,
                itemCount: 0,
                message: "Ozon 类目佣金接口尚未配置，未执行外部同步"
              });
              return;
            }
            if (platform !== "yandex") {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "market_commission" }, 400, { message: "Unsupported platform" });
              return;
            }
            const result = await syncYandexCommissionCatalogFromOnlineProducts();
            if (!result.ok) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "market_commission" }, result.status || 502, { message: result.message || "Sync failed" });
              return;
            }
            const catalog = normalizeYandexCommissionCatalog(result.data || {});
            getDb().yandexCommissionCatalog = catalog;
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "market_commission" }, 200, {
              platform,
              source: catalog.source,
              fetchedAt: catalog.fetchedAt,
              itemCount: catalog.itemCount,
              message: "Yandex 类目佣金同步完成"
            });
            return;
      }
    },
  ];
}

module.exports = { createMarketCommissionRoutes };
