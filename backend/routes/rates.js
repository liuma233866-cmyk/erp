function createRatesRoutes(deps) {
  const { authService, respondApi, fetchCbrRate, fetchRubPurchaseCostRate } = deps;

  const audit = (auditBase) => ({ ...auditBase, actionType: "read", resourceType: "rate" });

  return [
    {
      matches: (pathname, method) => pathname === "/api/rates/cbr" && method === "GET",
      handler: async (req, res, query, auditBase, pathname) => {
        const auth = authService.requireAuth(req, res, audit(auditBase));
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "product.read")) {
          respondApi(req, res, auth.user, audit(auditBase), 403, { message: "Forbidden" });
          return;
        }
        const currency = String(query.currency || "CNY").trim().toUpperCase();
        const result = await fetchCbrRate(currency);
        if (!result.ok) {
          respondApi(req, res, auth.user, audit(auditBase), result.status || 502, {
            message: result.message || "Rate unavailable"
          });
          return;
        }
        respondApi(req, res, auth.user, audit(auditBase), 200, result.data);
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/rates/rub-purchase-cost" && method === "GET",
      handler: async (req, res, query, auditBase, pathname) => {
        const auth = authService.requireAuth(req, res, audit(auditBase));
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "product.read")) {
          respondApi(req, res, auth.user, audit(auditBase), 403, { message: "Forbidden" });
          return;
        }
        const result = await fetchRubPurchaseCostRate();
        if (!result.ok) {
          respondApi(req, res, auth.user, audit(auditBase), result.status || 502, {
            message: result.message || "RUB purchase cost rate unavailable"
          });
          return;
        }
        respondApi(req, res, auth.user, audit(auditBase), 200, result.data);
      }
    }
  ];
}

module.exports = { createRatesRoutes };
