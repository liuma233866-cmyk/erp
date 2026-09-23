// 从 server.js 拆出的路由注册表（yandex-category-parameters 域）。

function createYandexCategoryParamsRoutes(deps) {
  const { authService, respondApi, getDb, canUserAccessShop, fetchYandexCategoryParameters, normalizeCategoryParametersPure, getPublishProductCategoryId, validateProductAgainstParametersPure, getPublishProductAttributeTerms, summarizeCategoryValidationPure } = deps;
  return [
    {
      matches: (pathname, method) => pathname === "/api/yandex/category-parameters" && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const auditContext = { ...auditBase, actionType: "read", resourceType: "yandex_category_parameters" };
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
            if (String(shop.provider || "").toLowerCase() !== "yandex_market") {
              respondApi(req, res, auth.user, auditContext, 400, { message: "该接口仅支持 Yandex 店铺" });
              return;
            }
            if (!canUserAccessShop(auth.user, shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, auditContext, 403, { message: "无权访问该店铺" });
              return;
            }
        
            const categoryId = Number(query?.categoryId);
            if (!Number.isFinite(categoryId) || categoryId <= 0) {
              respondApi(req, res, auth.user, auditContext, 400, { message: "categoryId 必须是正整数" });
              return;
            }
            if (!String(shop.businessId || "").trim()) {
              respondApi(req, res, auth.user, auditContext, 400, { message: "该店铺缺少 businessId" });
              return;
            }
        
            const result = await fetchYandexCategoryParameters(categoryId, shop.businessId, shop.apiKey);
            if (!result.ok) {
              respondApi(req, res, auth.user, auditContext, 502, { message: result.message || "类目特征拉取失败" });
              return;
            }
        
            const parameters = normalizeCategoryParametersPure(result.parameters || []);
            const requiredParameters = parameters.filter((parameter) => parameter.required);
            const recommendedParameters = parameters.filter(
              (parameter) => !parameter.required && parameter.recommendationTypes.length
            );
        
            // Optional cross-check: which of this shop's publish products already satisfy the
            // category's required parameters, and whether they were ever refreshed.
            const offerIds = String(query?.offerIds || "")
              .split(",")
              .map((value) => String(value || "").trim())
              .filter(Boolean);
            const allPublishProducts = Array.isArray(getDb().publishProducts) ? getDb().publishProducts : [];
            const scoped = allPublishProducts.filter((item) => {
              if (String(item?.shopId || "") !== shopId) return false;
              if (!offerIds.length) return true;
              const candidates = [
                item?.platformSku,
                item?.offerId,
                item?.sku,
                item?.systemSku
              ].map((value) => String(value || "").trim());
              return candidates.some((candidate) => candidate && offerIds.includes(candidate));
            });
            const scopedForCategory = scoped.filter((item) => {
              const itemCategory = getPublishProductCategoryId(item);
              // Products without a category cannot be judged against this category's rules.
              return itemCategory === null || itemCategory === categoryId;
            });
        
            const entries = scopedForCategory.slice(0, 200).map((item) => ({
              id: String(item?.id || ""),
              sku: String(item?.sku || item?.platformSku || ""),
              title: String(item?.title || ""),
              categoryId: getPublishProductCategoryId(item),
              ...validateProductAgainstParametersPure(parameters, getPublishProductAttributeTerms(item))
            }));
        
            respondApi(req, res, auth.user, auditContext, 200, {
              shopId,
              businessId: String(shop.businessId || ""),
              categoryId,
              cached: Boolean(result.cached),
              parameterCount: parameters.length,
              requiredCount: requiredParameters.length,
              recommendedCount: recommendedParameters.length,
              parameters,
              requiredParameters,
              recommendedParameters,
              validation: summarizeCategoryValidationPure(entries),
              products: entries,
              unmatchedProducts: scoped.length - scopedForCategory.length
            });
            return;
      }
    },
  ];
}

module.exports = { createYandexCategoryParamsRoutes };
