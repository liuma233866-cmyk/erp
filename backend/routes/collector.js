// 从 server.js 拆出的路由注册表（collector 域）。

function createCollectorRoutes(deps) {
  const { authService, respondApi, getDb, parseJsonBody, maskSensitive, normalizePublishProductRecord, makeId, buildAiImageTaskCode, aiImageTasksModule, aiImagePromptsModule, ingestCollectorProductIntoCentral, normalizePublishSettings, executeOzonProductPublish, CENTRAL_CATALOG_ENABLED, ROLE_ADMIN, saveDatabase } = deps;
  return [
    {
      matches: (pathname, method) => pathname === "/api/collector/products" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url, clientIp) => {
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "create", resourceType: "product_collect", requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_collect" }, 403, { message: "Forbidden" });
              return;
            }
            const actor = auth.user;
            const items = Array.isArray(body?.items) ? body.items : [];
            if (!items.length) {
              respondApi(req, res, actor, { ...auditBase, actionType: "create", resourceType: "product_collect" }, 400, { message: "items is required" });
              return;
            }
            if (!Array.isArray(getDb().publishProducts)) getDb().publishProducts = [];
            const errors = [];
            const validItems = [];
            for (const [index, rawItem] of items.entries()) {
              const item = normalizePublishProductRecord(rawItem);
              const sourcePlatform = String(rawItem?.sourcePlatform || rawItem?.platform || "").trim().toLowerCase();
              const sourceProductId = String(rawItem?.sourceProductId || rawItem?.sourceId || item.sku || "").trim();
              const missingFields = [];
              if (sourcePlatform !== "ozon" && sourcePlatform !== "yandex") missingFields.push("sourcePlatform(ozon|yandex)");
              if (!sourceProductId) missingFields.push("sourceProductId");
              if (!item.sku) missingFields.push("sku");
              if (!item.title) missingFields.push("title");
              if (!item.imageUrl) missingFields.push("imageUrl");
              if (missingFields.length) {
                errors.push({ index, sourceProductId, missingFields, message: `required: ${missingFields.join(", ")}` });
                continue;
              }
              item.source = String(rawItem?.source || "erp-chrome-collector-v1").trim();
              item.sourcePlatform = sourcePlatform;
              item.sourceProductId = sourceProductId;
              item.sourceUrl = String(rawItem?.sourceUrl || rawItem?.collectUrl || "").trim();
              item.collectUrl = item.sourceUrl || item.collectUrl;
              item.collectBatchId = String(body?.collectBatchId || body?.requestId || "").trim();
              item.publishStatus = "draft";
              item.aiImageStatus = "queued";
              item.platformPublishStatus = { ozon: "pending", yandex: "pending" };
              validItems.push(item);
            }
            const keyOf = (item) => `${String(item.sourcePlatform || "").trim()}::${String(item.sourceProductId || item.sku || "").trim()}`;
            const existingByKey = new Map(getDb().publishProducts.map((item) => [keyOf(item), item]));
            let created = 0;
            let updated = 0;
            const changedIds = [];
            const aiTasks = [];
            const centralResults = [];
            const centralCompanyId = String(actor?.companyId || "system").trim() || "system";
            for (const item of validItems) {
              const central = await ingestCollectorProductIntoCentral(item, centralCompanyId);
              centralResults.push({ sourceProductId: item.sourceProductId, ...central });
              if (central.centralProductId) item.centralProductId = central.centralProductId;
              item.centralCatalogStatus = central.status;
              const existing = existingByKey.get(keyOf(item));
              if (existing) {
                const createdAt = existing.createdAt || new Date().toISOString();
                Object.assign(existing, item, { id: existing.id, createdAt, updatedAt: new Date().toISOString() });
                item.id = existing.id;
                item.aiTaskId = String(existing.aiTaskId || "").trim();
                changedIds.push(existing.id);
                updated += 1;
              } else {
                item.id = makeId("COL");
                item.createdAt = new Date().toISOString();
                item.updatedAt = item.createdAt;
                getDb().publishProducts.unshift(item);
                existingByKey.set(keyOf(item), item);
                changedIds.push(item.id);
                created += 1;
              }
              if (!item.aiTaskId) {
                const taskCode = buildAiImageTaskCode(item);
                const taskResult = await aiImageTasksModule.createSystemTask({
                  companyId: String(actor?.companyId || (actor?.role === ROLE_ADMIN ? "system" : "")).trim() || "system",
                  taskCode,
                  sourceType: "product",
                  sourceId: item.id,
                  productId: item.id,
                  sourceImageUrl: item.imageUrl,
                  prompt: await aiImagePromptsModule.getDefaultPrompt(String(actor?.companyId || (actor?.role === ROLE_ADMIN ? "system" : "")).trim() || "system"),
                  metadataJson: JSON.stringify({
                    sourcePlatform: item.sourcePlatform,
                    shopId: item.shopId,
                    sourceProductId: item.sourceProductId,
                    systemSku: item.systemSku || item.sku,
                    taskCode
                  })
                });
                if (taskResult.ok) {
                  item.aiTaskId = taskResult.item.id;
                  item.aiTaskCode = taskResult.item.id;
                  const saved = getDb().publishProducts.find((candidate) => String(candidate.id || "") === String(item.id || ""));
                  if (saved) {
                    saved.aiTaskId = taskResult.item.id;
                    saved.aiTaskCode = taskResult.item.id;
                  }
                  aiTasks.push(taskResult.item.id);
                }
              }
            }
            saveDatabase();
            const publishSettings = normalizePublishSettings(getDb().publishSettings || {});
            const ozonItems = validItems.filter((item) => {
              const shopId = String(item.shopId || body?.shopId || "").trim();
              const shop = (getDb().shops || []).find((entry) => String(entry?.id || "") === shopId);
              return String(shop?.provider || "").toLowerCase() === "ozon";
            });
            let ozonPublish = null;
            if (publishSettings.erpAutoPublishToOzon && body?.autoPublish !== false && ozonItems.length) {
              ozonPublish = await executeOzonProductPublish(actor, ozonItems, String(body?.shopId || "").trim(), getDb().shops || []);
            }
            const payload = { requestId: String(body?.requestId || "").trim(), created, updated, failed: errors.length, total: items.length, changedIds, aiTasks, errors, central: { enabled: CENTRAL_CATALOG_ENABLED, items: centralResults, fallbackCount: centralResults.filter((entry) => entry.skipped).length }, autoPublish: Boolean(ozonPublish), ozonPublish };
            respondApi(req, res, actor, { ...auditBase, actionType: "create", resourceType: "product_collect", requestBodyMasked: maskSensitive(body), responseBodyMasked: maskSensitive(payload) }, errors.length ? 207 : 200, payload);
            return;
      }
    },
  ];
}

module.exports = { createCollectorRoutes };
