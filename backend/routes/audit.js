function createAuditRoutes(deps) {
  const {
    authService,
    respondApi,
    getDb,
    filterAuditLogs,
    sanitizeAuditLogForClient,
    paginateItems,
    buildLogCheckerReport,
    getRecentAuditIssues
  } = deps;

  return [
    {
      matches: (pathname, method) => pathname === "/api/audit-logs" && method === "GET",
      handler: async (req, res, query, auditBase, pathname) => {
        const auth = authService.requireAuth(req, res, { ...auditBase, resourceType: "audit_log" });
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "audit.read")) {
          respondApi(req, res, auth.user, { ...auditBase, resourceType: "audit_log" }, 403, { message: "Forbidden" });
          return;
        }

        const logs = filterAuditLogs(getDb().auditLogs || [], query).map(sanitizeAuditLogForClient);
        const paged = paginateItems(logs, query, 50);
        respondApi(req, res, auth.user, { ...auditBase, resourceType: "audit_log", actionType: "read" }, 200, {
          items: paged.items,
          pagination: paged.pagination
        });
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/log-checker" && method === "GET",
      handler: async (req, res, query, auditBase, pathname) => {
        const auth = authService.requireAuth(req, res, { ...auditBase, resourceType: "audit_log", actionType: "diagnose" });
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "audit.read")) {
          respondApi(req, res, auth.user, { ...auditBase, resourceType: "audit_log", actionType: "diagnose" }, 403, { message: "Forbidden" });
          return;
        }
        const hours = Math.max(1, Math.min(168, Number(query.hours || 24) || 24));
        respondApi(req, res, auth.user, { ...auditBase, resourceType: "audit_log", actionType: "diagnose" }, 200, buildLogCheckerReport(getRecentAuditIssues(hours), hours));
      }
    }
  ];
}

module.exports = { createAuditRoutes };
