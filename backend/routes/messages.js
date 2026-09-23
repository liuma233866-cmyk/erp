function createMessagesRoutes(deps) {
  const {
    authService,
    respondApi,
    getDb,
    paginateItems,
    parseJsonBody,
    maskSensitive,
    validateNonEmptyString,
    makeId,
    saveDatabase
  } = deps;

  const readAudit = (auditBase) => ({ ...auditBase, resourceType: "message", actionType: "read" });
  const createAudit = (auditBase, body) => ({ ...auditBase, resourceType: "message", actionType: "create", requestBodyMasked: maskSensitive(body) });

  return [
    {
      matches: (pathname, method) => pathname === "/api/messages" && method === "GET",
      handler: async (req, res, query, auditBase, pathname) => {
        const auth = authService.requireAuth(req, res, readAudit(auditBase));
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "message.read")) {
          respondApi(req, res, auth.user, readAudit(auditBase), 403, { message: "Forbidden" });
          return;
        }
        const items = Array.isArray(getDb().messages) ? getDb().messages : [];
        const paged = paginateItems(items, query, 50);
        respondApi(req, res, auth.user, readAudit(auditBase), 200, { items: paged.items, pagination: paged.pagination });
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/messages" && method === "POST",
      handler: async (req, res, query, auditBase, pathname) => {
        const body = await parseJsonBody(req);
        const auth = authService.requireAuth(req, res, createAudit(auditBase, body));
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "message.create")) {
          respondApi(req, res, auth.user, createAudit(auditBase, body), 403, { message: "Forbidden" });
          return;
        }

        // Validate and store with the same limits so accepted input is never
        // silently truncated.
        const titleValidation = validateNonEmptyString(body.title, "title", 100);
        const contentValidation = validateNonEmptyString(body.content, "content", 1000);
        const title = titleValidation.ok ? titleValidation.value : "";
        const content = contentValidation.ok ? contentValidation.value : "";
        if (!titleValidation.ok) {
          respondApi(req, res, auth.user, createAudit(auditBase, body), 400, { message: titleValidation.message });
          return;
        }
        if (!contentValidation.ok) {
          respondApi(req, res, auth.user, createAudit(auditBase, body), 400, { message: contentValidation.message });
          return;
        }

        const item = {
          id: makeId("MSG"),
          title,
          content,
          createdAt: new Date().toISOString(),
          createdBy: {
            userId: auth.user.id,
            username: auth.user.username,
            role: auth.user.role
          }
        };

        const db = getDb();
        if (!Array.isArray(db.messages)) db.messages = [];
        db.messages.unshift(item);
        saveDatabase();
        respondApi(req, res, auth.user, { ...createAudit(auditBase, body), resourceId: item.id }, 201, { item });
      }
    }
  ];
}

module.exports = { createMessagesRoutes };
