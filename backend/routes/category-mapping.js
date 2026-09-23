// 从 server.js 拆出的路由注册表（category-mapping 域）。

function createCategoryMappingRoutes(deps) {
  const { authService, respondApi, getDb, parseJsonBody, maskSensitive, saveDatabase, normalizeProductCategoryKnowledge, getUserAssignedShopIds, resolveScopedDraftShopId, makeId } = deps;
  return [
    {
      matches: (pathname, method) => pathname === "/api/category-mapping/rules" && (method === "GET" || method === "POST"),
      handler: async (req, res, query, auditBase, pathname) => {
            const body = req.method === "POST" ? await parseJsonBody(req) : null;
            const auth = authService.requireAuth(req, res, {
              ...auditBase,
              actionType: req.method === "POST" ? "create" : "read",
              resourceType: "category_mapping",
              requestBodyMasked: body ? maskSensitive(body) : null
            });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: req.method === "POST" ? "create" : "read", resourceType: "category_mapping" }, 403, { message: "Forbidden" });
              return;
            }
        
            const knowledge = normalizeProductCategoryKnowledge(getDb().productCategoryKnowledge || {});
            if (req.method === "GET") {
              const platform = String(query.platform || "").trim().toLowerCase();
              const assignedShopIds = getUserAssignedShopIds(auth.user, getDb().shops || []);
              const visible = (item) => {
                if (platform && item.platform && item.platform !== platform) return false;
                if (assignedShopIds === null) return true;
                // Scoped users only see items bound to one of their shops; global
                // (shop-less) knowledge stays admin-only to avoid cross-tenant leaks.
                if (!item.shopId) return false;
                return assignedShopIds.includes(String(item.shopId));
              };
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "category_mapping" }, 200, {
                rules: knowledge.rules.filter(visible),
                samples: knowledge.samples.filter(visible),
                fetchedAt: knowledge.fetchedAt
              });
              return;
            }
        
            const requested = body?.item || body || {};
            const categoryId = Number(requested.categoryId || 0) || 0;
            if (categoryId <= 0) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "category_mapping" }, 400, { message: "categoryId is required" });
              return;
            }
            const shopAccess = resolveScopedDraftShopId(auth.user, requested.shopId, getDb().shops || []);
            if (!shopAccess.ok) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "category_mapping" }, shopAccess.statusCode, { message: shopAccess.message });
              return;
            }
            const now = new Date().toISOString();
            const candidate = {
              ...requested,
              id: makeId("CMR"),
              shopId: shopAccess.shopId,
              createdAt: now,
              updatedAt: now,
              platform: String(requested.platform || query.platform || "ozon").trim().toLowerCase()
            };
            const normalized = normalizeProductCategoryKnowledge({ rules: [candidate] }).rules[0];
            if (!normalized) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "category_mapping" }, 400, { message: "类目映射规则格式无效" });
              return;
            }
            getDb().productCategoryKnowledge = normalizeProductCategoryKnowledge({ ...knowledge, rules: [normalized, ...knowledge.rules], fetchedAt: now });
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "category_mapping", resourceId: normalized.id }, 201, { item: normalized });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.match(/^\/api\/category-mapping\/rules\/([^/]+)$/) && (method === "PUT" || method === "DELETE"),
      handler: async (req, res, query, auditBase, pathname) => {
        const categoryMappingRuleMatch = pathname.match(/^\/api\/category-mapping\/rules\/([^/]+)$/);
            const ruleId = decodeURIComponent(categoryMappingRuleMatch[1]);
            const body = req.method === "PUT" ? await parseJsonBody(req) : null;
            const auth = authService.requireAuth(req, res, {
              ...auditBase,
              actionType: req.method === "PUT" ? "update" : "delete",
              resourceType: "category_mapping",
              resourceId: ruleId,
              requestBodyMasked: body ? maskSensitive(body) : null
            });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: req.method === "PUT" ? "update" : "delete", resourceType: "category_mapping", resourceId: ruleId }, 403, { message: "Forbidden" });
              return;
            }
            const knowledge = normalizeProductCategoryKnowledge(getDb().productCategoryKnowledge || {});
            const index = knowledge.rules.findIndex((rule) => String(rule.id || "") === ruleId);
            if (index < 0) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: req.method === "PUT" ? "update" : "delete", resourceType: "category_mapping", resourceId: ruleId }, 404, { message: "Category mapping rule not found" });
              return;
            }
            const current = knowledge.rules[index];
            const assignedShopIds = getUserAssignedShopIds(auth.user, getDb().shops || []);
            if (assignedShopIds !== null && current.shopId && !assignedShopIds.includes(String(current.shopId))) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: req.method === "PUT" ? "update" : "delete", resourceType: "category_mapping", resourceId: ruleId }, 403, { message: "Forbidden" });
              return;
            }
            if (req.method === "DELETE") {
              knowledge.rules.splice(index, 1);
              getDb().productCategoryKnowledge = normalizeProductCategoryKnowledge({ ...knowledge, fetchedAt: new Date().toISOString() });
              saveDatabase();
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "category_mapping", resourceId: ruleId }, 200, { message: "Category mapping rule deleted" });
              return;
            }
            const requested = body?.item || body || {};
            const shopAccess = resolveScopedDraftShopId(auth.user, requested.shopId !== undefined ? requested.shopId : current.shopId, getDb().shops || []);
            if (!shopAccess.ok) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "category_mapping", resourceId: ruleId }, shopAccess.statusCode, { message: shopAccess.message });
              return;
            }
            const nextCandidate = { ...current, ...requested, id: current.id, shopId: shopAccess.shopId, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
            const nextRule = normalizeProductCategoryKnowledge({ rules: [nextCandidate] }).rules[0];
            if (!nextRule) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "category_mapping", resourceId: ruleId }, 400, { message: "类目映射规则格式无效" });
              return;
            }
            knowledge.rules[index] = nextRule;
            getDb().productCategoryKnowledge = normalizeProductCategoryKnowledge({ ...knowledge, fetchedAt: new Date().toISOString() });
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "category_mapping", resourceId: ruleId }, 200, { item: nextRule });
            return;
      }
    },
  ];
}

module.exports = { createCategoryMappingRoutes };
