// 从 server.js 拆出的路由注册表（review-rules 域）。

function createReviewRulesRoutes(deps) {
  const { authService, respondApi, getDb, parseJsonBody, maskSensitive, saveDatabase, getUserAssignedShopIds, normalizeRole, ROLE_ADMIN, sameCompanyEntity, normalizeReviewRule, resolveScopedDraftShopId, makeId, normalizeCompanyId, normalizeCompanyName, sqlWriters } = deps;
  return [
    {
      matches: (pathname, method) => pathname === "/api/review-rules" && (method === "GET" || method === "POST"),
      handler: async (req, res, query, auditBase, pathname) => {
            const body = req.method === "POST" ? await parseJsonBody(req) : null;
            const auth = authService.requireAuth(req, res, {
              ...auditBase,
              actionType: req.method === "POST" ? "create" : "read",
              resourceType: "review_rule",
              requestBodyMasked: body ? maskSensitive(body) : null
            });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: req.method === "POST" ? "create" : "read", resourceType: "review_rule" }, 403, { message: "Forbidden" });
              return;
            }
        
            if (req.method === "GET") {
              const assignedShopIds = getUserAssignedShopIds(auth.user, getDb().shops || []);
              const isAdmin = normalizeRole(auth.user.role, auth.user.username) === ROLE_ADMIN;
              const items = (getDb().reviewRules || []).filter((rule) => {
                if (!isAdmin && rule.companyId && !sameCompanyEntity(rule, auth.user)) return false;
                if (assignedShopIds === null) return true;
                if (!rule.shopId) {
                  // Global (no-shop) rules: only same-company ones are visible to
                  // scoped users; company-less global rules stay admin-only.
                  return Boolean(rule.companyId) && sameCompanyEntity(rule, auth.user);
                }
                return assignedShopIds.includes(String(rule.shopId));
              });
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "review_rule" }, 200, { items });
              return;
            }
        
            const item = normalizeReviewRule(body?.item || body || {});
            const shopAccess = resolveScopedDraftShopId(auth.user, item.shopId, getDb().shops || []);
            if (!shopAccess.ok) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "review_rule" }, shopAccess.statusCode, { message: shopAccess.message });
              return;
            }
            const now = new Date().toISOString();
            const rule = normalizeReviewRule({
              ...item,
              id: makeId("RRL"),
              companyId: normalizeCompanyId(auth.user.companyId || ""),
              companyName: normalizeCompanyName(auth.user.companyName || ""),
              shopId: shopAccess.shopId,
              createdAt: now,
              updatedAt: now
            });
            if (!Array.isArray(getDb().reviewRules)) getDb().reviewRules = [];
            getDb().reviewRules.unshift(rule);
            saveDatabase();
            try {
              await sqlWriters.saveReviewRuleToSql(rule);
            } catch (error) {
              getDb().reviewRules = getDb().reviewRules.filter((current) => current.id !== rule.id);
              saveDatabase();
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "review_rule" }, 500, { message: "审单规则保存失败" });
              return;
            }
            respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "review_rule", resourceId: rule.id }, 201, { item: rule });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.match(/^\/api\/review-rules\/([^/]+)$/) && (method === "PUT" || method === "DELETE"),
      handler: async (req, res, query, auditBase, pathname) => {
        const reviewRuleMatch = pathname.match(/^\/api\/review-rules\/([^/]+)$/);
            const ruleId = decodeURIComponent(reviewRuleMatch[1]);
            const body = req.method === "PUT" ? await parseJsonBody(req) : null;
            const auth = authService.requireAuth(req, res, {
              ...auditBase,
              actionType: req.method === "PUT" ? "update" : "delete",
              resourceType: "review_rule",
              resourceId: ruleId,
              requestBodyMasked: body ? maskSensitive(body) : null
            });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: req.method === "PUT" ? "update" : "delete", resourceType: "review_rule", resourceId: ruleId }, 403, { message: "Forbidden" });
              return;
            }
            const index = (getDb().reviewRules || []).findIndex((rule) => String(rule.id || "") === ruleId);
            if (index < 0) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: req.method === "PUT" ? "update" : "delete", resourceType: "review_rule", resourceId: ruleId }, 404, { message: "Review rule not found" });
              return;
            }
            const current = normalizeReviewRule(getDb().reviewRules[index]);
            const isAdmin = normalizeRole(auth.user.role, auth.user.username) === ROLE_ADMIN;
            if (!isAdmin && current.companyId && !sameCompanyEntity(current, auth.user)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: req.method === "PUT" ? "update" : "delete", resourceType: "review_rule", resourceId: ruleId }, 403, { message: "Forbidden" });
              return;
            }
            const assignedShopIds = getUserAssignedShopIds(auth.user, getDb().shops || []);
            if (assignedShopIds !== null && current.shopId && !assignedShopIds.includes(String(current.shopId))) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: req.method === "PUT" ? "update" : "delete", resourceType: "review_rule", resourceId: ruleId }, 403, { message: "Forbidden" });
              return;
            }
            if (req.method === "DELETE") {
              getDb().reviewRules.splice(index, 1);
              saveDatabase();
              try {
                await sqlWriters.deleteReviewRuleFromSql(ruleId);
              } catch (error) {
                getDb().reviewRules.splice(index, 0, current);
                saveDatabase();
                respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "review_rule", resourceId: ruleId }, 500, { message: "审单规则删除失败" });
                return;
              }
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "review_rule", resourceId: ruleId }, 200, { message: "Review rule deleted" });
              return;
            }
        
            const nextInput = normalizeReviewRule({ ...current, ...(body?.item || body || {}), id: current.id, companyId: current.companyId, companyName: current.companyName, createdAt: current.createdAt, updatedAt: new Date().toISOString() });
            const shopAccess = resolveScopedDraftShopId(auth.user, nextInput.shopId, getDb().shops || []);
            if (!shopAccess.ok) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "review_rule", resourceId: ruleId }, shopAccess.statusCode, { message: shopAccess.message });
              return;
            }
            const nextRule = normalizeReviewRule({ ...nextInput, shopId: shopAccess.shopId });
            getDb().reviewRules[index] = nextRule;
            saveDatabase();
            try {
              await sqlWriters.saveReviewRuleToSql(nextRule);
            } catch (error) {
              getDb().reviewRules[index] = current;
              saveDatabase();
                respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "review_rule" }, 500, { message: "审单规则保存失败" });
              return;
            }
            respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "review_rule", resourceId: ruleId }, 200, { item: nextRule });
            return;
      }
    },
  ];
}

module.exports = { createReviewRulesRoutes };
