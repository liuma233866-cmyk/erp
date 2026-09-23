// 从 server.js 拆出的路由注册表（yandex-card-quality 域）。

function createYandexQualityRoutes(deps) {
  const { authService, respondApi, getDb, parseJsonBody, maskSensitive, canUserAccessShop, readPositiveIntParam, readStoredCardQuality, readCardQualityTrend, readCardQualityByOffers, fetchAllYandexOfferCards, saveCardQualitySnapshot, trimCardQualityHistory, getSqlPool, isSqlReady } = deps;
  return [
    {
      matches: (pathname, method) => pathname === "/api/yandex/card-quality/batch" && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
        const auditContext = { ...auditBase, actionType: "read", resourceType: "yandex_card_quality" };
        const auth = authService.requireAuth(req, res, auditContext);
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "product.sync")) {
          respondApi(req, res, auth.user, auditContext, 403, { message: "Forbidden" });
          return;
        }
        const shopId = String(query?.shopId || "").trim();
        const shop = (getDb().shops || []).find((entry) => String(entry?.id || "") === shopId);
        if (!shop) {
          respondApi(req, res, auth.user, auditContext, 404, { message: "Shop not found" });
          return;
        }
        if (!canUserAccessShop(auth.user, shopId, getDb().shops || [])) {
          respondApi(req, res, auth.user, auditContext, 403, { message: "无权访问该店铺" });
          return;
        }
        const offerIds = String(query?.offerIds || "")
          .split(",")
          .map((value) => String(value || "").trim())
          .filter(Boolean)
          .slice(0, 200);
        if (!offerIds.length) {
          respondApi(req, res, auth.user, auditContext, 400, { message: "offerIds is required" });
          return;
        }
        if (!isSqlReady() || !getSqlPool()) {
          respondApi(req, res, auth.user, auditContext, 503, { message: "数据库未就绪，无法读取已存储的卡片质量" });
          return;
        }
        const items = await readCardQualityByOffers(getSqlPool(), shopId, offerIds);
        respondApi(req, res, auth.user, auditContext, 200, { items });
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/yandex/card-quality" && (method === "GET" || method === "POST"),
      handler: async (req, res, query, auditBase, pathname, url) => {
            const body = req.method === "POST" ? await parseJsonBody(req) : {};
            const auditContext = { ...auditBase, actionType: "read", resourceType: "yandex_card_quality", requestBodyMasked: maskSensitive(body) };
            const auth = authService.requireAuth(req, res, auditContext);
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, auditContext, 403, { message: "Forbidden" });
              return;
            }
        
            const shopId = String(body?.shopId || query?.shopId || "").trim();
            const shop = (getDb().shops || []).find((entry) => String(entry?.id || "") === shopId);
            if (!shop) {
              respondApi(req, res, auth.user, auditContext, 404, { message: "Shop not found" });
              return;
            }
            if (String(shop.provider || "").toLowerCase() !== "yandex_market") {
              respondApi(req, res, auth.user, auditContext, 400, { message: "该接口仅支持 Yandex 店铺" });
              return;
            }
            if (!canUserAccessShop(auth.user, shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, auditContext, 403, { message: "无权访问该店铺" });
              return;
            }
        
            // GET reads the stored snapshot only. It must never call Yandex: the whole point
            // of persisting is that the shop is not queried again until the user refreshes.
            if (req.method === "GET") {
              if (!isSqlReady() || !getSqlPool()) {
                respondApi(req, res, auth.user, auditContext, 503, { message: "数据库未就绪，无法读取已存储的卡片质量" });
                return;
              }
              const stored = await readStoredCardQuality(getSqlPool(), shopId, {
                page: readPositiveIntParam(query?.page, 1, 1, 100000),
                pageSize: readPositiveIntParam(query?.pageSize, 500, 1, 500)
              });
              const trend = await readCardQualityTrend(getSqlPool(), shopId, 30);
              if (!stored) {
                respondApi(req, res, auth.user, auditContext, 200, {
                  shopId,
                  stored: false,
                  message: "尚未拉取过该店铺的卡片质量，点击「刷新并拉取」从 Yandex 获取",
                  total: 0,
                  offers: [],
                  trend
                });
                return;
              }
              respondApi(req, res, auth.user, auditContext, 200, {
                shopId,
                stored: true,
                businessId: String(shop.businessId || ""),
                total: stored.total,
                page: stored.page,
                pageSize: stored.pageSize,
                totalPages: stored.totalPages,
                belowBenchmark: stored.belowBenchmark,
                averageRating: stored.averageRating,
                categoryAverageRating: stored.categoryAverageRating,
                fetchedAt: stored.fetchedAt,
                offerCount: stored.offers.length,
                offers: stored.offers,
                trend
              });
              return;
            }
        
            // POST is the explicit refresh: pull every page from Yandex, then persist.
            if (!String(shop.businessId || "").trim()) {
              respondApi(req, res, auth.user, auditContext, 400, { message: "该店铺缺少 businessId，无法查询卡片质量" });
              return;
            }
            if (!isSqlReady() || !getSqlPool()) {
              respondApi(req, res, auth.user, auditContext, 503, { message: "数据库未就绪，无法保存卡片质量" });
              return;
            }
        
            const offerIds = Array.isArray(body?.offerIds)
              ? body.offerIds.map((value) => String(value || "").trim()).filter(Boolean)
              : [];
            const cardStatuses = Array.isArray(body?.cardStatuses)
              ? body.cardStatuses.map((value) => String(value || "").trim()).filter(Boolean)
              : [];
            if (offerIds.length && cardStatuses.length) {
              respondApi(req, res, auth.user, auditContext, 400, {
                message: "offerIds 与 cardStatuses 不能同时使用，请二选一"
              });
              return;
            }
        
            const result = await fetchAllYandexOfferCards(shop.businessId, shop.apiKey, {
              offerIds,
              cardStatuses,
              withRecommendations: body?.withRecommendations !== false,
              maxPages: readPositiveIntParam(body?.maxPages, 10, 1, 50)
            });
            if (!result.ok) {
              respondApi(req, res, auth.user, auditContext, 502, { message: result.message || "卡片质量查询失败" });
              return;
            }
        
            const saved = await saveCardQualitySnapshot(getSqlPool(), {
              shopId,
              cards: result.offers,
              categoryAverageRating: result.categoryAverageRating
            });
            // A filtered lookup stores only what it fetched, so history must not be trimmed.
            if (!offerIds.length && !cardStatuses.length) {
              await trimCardQualityHistory(getSqlPool(), shopId);
            }
        
            const stored = await readStoredCardQuality(getSqlPool(), shopId, { pageSize: 500 });
            const trend = await readCardQualityTrend(getSqlPool(), shopId, 30);
            respondApi(req, res, auth.user, auditContext, 200, {
              shopId,
              stored: true,
              businessId: String(shop.businessId || ""),
              fetchedFromYandex: true,
              pages: result.pages,
              truncated: Boolean(result.truncated),
              partialError: result.partialError || "",
              savedCards: saved.saved,
              total: stored ? stored.total : result.offers.length,
              belowBenchmark: stored ? stored.belowBenchmark : 0,
              averageRating: result.averageRating,
              categoryAverageRating: result.categoryAverageRating,
              fetchedAt: new Date().toISOString(),
              offerCount: result.offers.length,
              offers: result.offers,
              trend
            });
            return;
      }
    },
  ];
}

module.exports = { createYandexQualityRoutes };
