// 从 server.js 拆出的路由注册表（publish 域）。

function createPublishRoutes(deps) {
  const { authService, respondApi, getDb, parseJsonBody, parseRawBody, maskSensitive, saveDatabase, writeAudit, XLSX, normalizeRole, ROLE_ADMIN, buildPublishProductKey, resolveScopedDraftShopId, normalizePublishProductRecord, resolvePublishPlatformFromShopId, isLockedPublishProduct, makeId, normalizePublishSettings, normalizeCopyOptions, prepareCopyProductsWithCurrency, fetchStoredCbrRate, copyOnlineProductsToPublishDrafts, convertPublishPricesToCurrency, aiImagePromptsModule, aiImageTasksModule, createCopyAiImageTasks, buildAiImageTaskCode, canUserAccessShop, getUserAssignedShopIds, normalizeShopCurrency, sanitizeAuditLogForClient, executeProductPublish, executeOzonProductPublish, publishOzonProducts } = deps;
  // 上架结果写进「上架记录」自己的表（见 page-stores.js）。
  const recordPublishOutcome = typeof deps.recordPublishOutcome === "function" ? deps.recordPublishOutcome : () => ({});
  return [
    {
      matches: (pathname, method) => pathname === "/api/product-publish/import-template" && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "read", resourceType: "product_publish" });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "product_publish" }, 403, { message: "Forbidden" });
              return;
            }
            if (!XLSX) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "product_publish" }, 500, { message: "Excel library is not installed" });
              return;
            }
            const headers = [["shopId", "name", "sku", "vendor", "description", "imageUrl", "salePrice", "originalPrice", "purchasePriceRmb", "purchasePriceRub", "packageLengthCm", "packageWidthCm", "packageHeightCm", "weightKg", "stockCount", "categoryId", "categoryName", "purchaseUrl", "purchaseUrl2", "notes"]];
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(headers), "多平台刊登导入");
            const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
            res.writeHead(200, {
              "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              "Content-Disposition": "attachment; filename=publish-import-template.xlsx"
            });
            res.end(buffer);
            writeAudit(req, auth.user, { ...auditBase, actionType: "read", resourceType: "product_publish" }, 200, { template: true });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/product-publish/import-file" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "create", resourceType: "product_publish" });
            if (!auth.ok) return;
            if (normalizeRole(auth.user.role, auth.user.username) !== ROLE_ADMIN) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish" }, 403, { message: "Excel 导入仅限管理员" });
              return;
            }
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish" }, 403, { message: "Forbidden" });
              return;
            }
            if (!XLSX) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish" }, 500, { message: "Excel library is not installed" });
              return;
            }
            const raw = await parseRawBody(req);
            const contentType = String(req.headers["content-type"] || "").toLowerCase();
            if (raw.length > 12 * 1024 * 1024 || (contentType && !contentType.includes("multipart") && !contentType.includes("spreadsheet") && !contentType.includes("octet-stream"))) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish" }, 400, { message: "仅支持 12MB 以内的 Excel 文件" });
              return;
            }
            let rows;
            try {
              const workbook = XLSX.read(raw, { type: "buffer", cellDates: false });
              if (!Array.isArray(workbook.SheetNames) || workbook.SheetNames.length !== 1) throw new Error("文件必须只包含一个工作表");
              const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
              rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
            } catch (error) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish" }, 400, { message: `导入文件无法读取: ${String(error.message || error)}` });
              return;
            }
            if (!Array.isArray(rows) || !rows.length) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish" }, 400, { message: "导入文件没有数据行" });
              return;
            }
            const queryShopId = String(query.shopId || "").trim();
            const headerMap = {
              商品名称: "name", 名称: "name", 商品标题: "name", SKU: "sku", sku: "sku", 品牌: "vendor", 描述: "description", 图片: "imageUrl", 图片链接: "imageUrl",
              售价: "salePrice", 原价: "originalPrice", 采购价: "purchasePriceRmb", 采购价RMB: "purchasePriceRmb", 采购价RMB: "purchasePriceRmb", 采购价RUB: "purchasePriceRub",
              长: "packageLengthCm", 宽: "packageWidthCm", 高: "packageHeightCm", 重量: "weightKg", 库存: "stockCount", 类目ID: "categoryId", 类目名称: "categoryName",
              货源链接: "purchaseUrl", 货源链接2: "purchaseUrl2", 备注: "notes", 店铺ID: "shopId"
            };
            const normalizedRows = rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [headerMap[key] || key, value])));
            const byKey = new Map((getDb().publishProducts || []).map((item) => [buildPublishProductKey(item), item]));
            let created = 0;
            let updated = 0;
            let unchanged = 0;
            let skippedLocked = 0;
            const errors = [];
            for (const rawItem of normalizedRows) {
              const requestedShopId = String(rawItem.shopId || queryShopId || "").trim();
              const shopAccess = resolveScopedDraftShopId(auth.user, requestedShopId, getDb().shops || []);
              if (!shopAccess.ok) {
                errors.push({ message: shopAccess.message });
                continue;
              }
              const item = normalizePublishProductRecord({ ...rawItem, shopId: shopAccess.shopId });
              if (!item.publishPlatform) item.publishPlatform = resolvePublishPlatformFromShopId(item.shopId, getDb().shops || []);
              const key = buildPublishProductKey(item);
              if (!key) {
                errors.push({ message: "缺少 shopId 和 sku" });
                continue;
              }
              const existing = byKey.get(key);
              if (existing && isLockedPublishProduct(existing)) {
                skippedLocked += 1;
                continue;
              }
              if (existing) {
                const before = JSON.stringify(existing);
                Object.assign(existing, item, { id: existing.id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() });
                if (JSON.stringify(existing) === before) unchanged += 1;
                else updated += 1;
              } else {
                item.id = makeId("PUB");
                item.createdAt = new Date().toISOString();
                item.updatedAt = item.createdAt;
                getDb().publishProducts.unshift(item);
                byKey.set(key, item);
                created += 1;
              }
            }
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish" }, 200, { created, updated, unchanged, skippedLocked, errors });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/product-publish" && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const auth = authService.requireAuth(req, res, auditBase);
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.read")) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "product_publish" }, 403, { message: "Forbidden" });
              return;
            }
            const assignedShopIds = getUserAssignedShopIds(auth.user, getDb().shops || []);
            const source = Array.isArray(getDb().publishProducts) ? getDb().publishProducts : [];
            const scopedItems = assignedShopIds === null
              ? source
              : source.filter((item) => assignedShopIds.includes(String(item?.shopId || "").trim()));
            const shopNameById = new Map((getDb().shops || []).map((shop) => [String(shop?.id || "").trim(), String(shop?.name || "").trim()]));
            const items = scopedItems.map((item) => ({
              ...item,
              shopName: shopNameById.get(String(item?.shopId || "").trim()) || String(item?.shopName || "").trim() || "未知店铺"
            }));
            respondApi(req, res, auth.user, { ...auditBase, resourceType: "product_publish" }, 200, { items });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/product-publish/settings" && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "read", resourceType: "product_publish_settings" });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "product_publish_settings" }, 403, { message: "Forbidden" });
              return;
            }
            respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "product_publish_settings" }, 200, {
              settings: normalizePublishSettings(getDb().publishSettings || {})
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/product-publish/copy-online" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "create", resourceType: "product_publish", requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish" }, 403, { message: "Forbidden" });
              return;
            }
            const ids = Array.isArray(body?.ids) ? body.ids.map((id) => String(id || "").trim()).filter(Boolean) : [];
            const copyOptions = normalizeCopyOptions(body);
            if (!ids.length) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish" }, 400, { message: "请先选择要复制的在线产品" });
              return;
            }
            const idSet = new Set(ids);
            const targetPlatform = String(body?.platform || "").trim().toLowerCase();
            const targetShopId = String(body?.shopId || "").trim();
            if (!new Set(["yandex", "ozon"]).has(targetPlatform) || !targetShopId) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish" }, 400, { message: "请选择目标平台和店铺" });
              return;
            }
            const assignedShopIds = getUserAssignedShopIds(auth.user, getDb().shops || []);
            const targetShop = (getDb().shops || []).find((shop) => String(shop?.id || "") === targetShopId);
            const targetProvider = String(targetShop?.provider || "").trim().toLowerCase();
            const expectedProvider = targetPlatform === "yandex" ? "yandex_market" : "ozon";
            if (!targetShop || !targetShop.enabled || targetProvider !== expectedProvider || !canUserAccessShop(auth.user, targetShopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish" }, 403, { message: "目标店铺不可用或与所选平台不匹配" });
              return;
            }
            const selectedProducts = (getDb().onlineProducts || []).filter((product) => idSet.has(String(product?.id || "")));
            if (selectedProducts.length !== idSet.size) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish" }, 404, { message: "部分在线产品不存在" });
              return;
            }
            const inaccessibleProduct = selectedProducts.find((product) => assignedShopIds !== null && !assignedShopIds.includes(String(product?.shopId || "")));
            if (inaccessibleProduct) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish" }, 403, { message: "选中的产品不属于可访问的 Yandex 店铺" });
              return;
            }
            if (selectedProducts.some((product) => String(product?.shopId || "").trim() === targetShopId)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish" }, 409, { message: "目标店铺不能与源店铺相同" });
              return;
            }
            const targetCurrency = normalizeShopCurrency(targetShop.shopCurrency);
            const selectedProductsWithCurrency = prepareCopyProductsWithCurrency(selectedProducts, getDb().shops || [], normalizeShopCurrency);
            const requiresCurrencyConversion = selectedProductsWithCurrency.some((product) => product.sourceCurrencyId !== targetCurrency);
            let copyExchangeRate = null;
            if (requiresCurrencyConversion && copyOptions.priceStrategy === "convert") {
              const storedRate = await fetchStoredCbrRate("CNY");
              if (!storedRate.ok || !(Number(storedRate.data?.rate) > 0)) {
                respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish" }, 409, {
                  message: "人民币店铺缺少可用的人民币兑卢布汇率，请先更新汇率后再复制"
                });
                return;
              }
              copyExchangeRate = storedRate.data;
            }
            const publishProductsForCopy = copyOptions.dryRun
              ? JSON.parse(JSON.stringify(getDb().publishProducts || []))
              : (getDb().publishProducts || []);
            const result = copyOnlineProductsToPublishDrafts({
              onlineProducts: selectedProductsWithCurrency,
              publishProducts: publishProductsForCopy,
              normalize: normalizePublishProductRecord,
              makeId,
              target: {
                platform: targetPlatform,
                shopId: targetShopId,
                currencyId: targetCurrency,
                preserveSourceCurrency: copyOptions.priceStrategy === "keep",
                overwriteTitleDescription: copyOptions.overwriteTitleDescription,
                skuSettings: normalizePublishSettings(getDb().publishSettings || {})
              }
            });
            let priceConversion = null;
            if (requiresCurrencyConversion && copyExchangeRate && copyOptions.priceStrategy === "convert") {
              priceConversion = convertPublishPricesToCurrency(result.changedItems, {
                shopId: targetShopId,
                targetCurrencyId: targetCurrency,
                cnyRateRub: Number(copyExchangeRate.rate),
                rateDate: String(copyExchangeRate.date || "")
              });
            }
            if (copyOptions.dryRun) {
              const estimatedAiTasks = copyOptions.aiMode === "none" ? 0 : result.changedItems.reduce((count, item) => {
                const variants = Array.isArray(item.variants) && item.variants.length ? item.variants : [{ sku: item.sku, imageUrl: item.imageUrl }];
                const selected = copyOptions.aiMode === "main" ? variants.slice(0, 1) : variants;
                return count + selected.filter((variant) => {
                  const sku = String(variant?.sku || item.sku || "").trim();
                  const image = String(variant?.imageUrl || variant?.images?.[0] || item.imageUrl || "").trim();
                  const recorded = item.aiTaskIdsBySku && item.aiTaskIdsBySku[sku];
                  return Boolean(image) && (!recorded || recorded === "missing_source_image");
                }).length;
              }, 0);
              respondApi(req, res, auth.user, { ...auditBase, actionType: "preview", resourceType: "product_publish" }, 200, {
                preview: true,
                created: result.created,
                updated: result.updated,
                skipped: result.skipped,
                copied: result.created + result.updated,
                total: result.total,
                sourceTotal: selectedProducts.length,
                aiMode: copyOptions.aiMode,
                aiTaskCount: estimatedAiTasks,
                priceStrategy: copyOptions.priceStrategy,
                priceConverted: Number(priceConversion?.converted || 0),
                exchangeRate: copyExchangeRate ? { cnyRateRub: copyExchangeRate.rate, date: copyExchangeRate.date || "", stale: copyExchangeRate.stale === true, warning: copyExchangeRate.warning || "" } : null,
                sample: result.changedItems.slice(0, 5).map((item) => ({ id: item.id, sku: item.sku, salePrice: item.salePrice, currencyId: item.currencyId }))
              });
              return;
            }
            getDb().publishProducts = result.items;
            const companyId = String(auth.user?.companyId || (auth.user?.role === ROLE_ADMIN ? "system" : "")).trim() || "system";
            let aiTasks = [];
            try {
              const defaultPrompt = await aiImagePromptsModule.getDefaultPrompt(companyId);
              const aiResult = await createCopyAiImageTasks({
                items: result.changedItems,
                companyId,
                defaultPrompt,
                aiMode: copyOptions.aiMode,
                buildTaskCode: buildAiImageTaskCode,
                createSystemTask: (input) => aiImageTasksModule.createSystemTask(input),
                concurrency: 4
              });
              aiTasks = aiResult.aiTasks;
            } finally {
              saveDatabase();
            }
            for (const item of result.changedItems) {
              writeAudit(req, auth.user, {
                ...auditBase,
                actionType: "copy",
                resourceType: "product_publish",
                resourceId: item.id,
                requestBodyMasked: { sourceOnlineProductId: item.sourceOnlineProductId, targetShopId, targetPlatform },
                responseBodyMasked: { sku: item.sku, aiTaskId: item.aiTaskId || "" }
              }, 200, { message: "在线产品已复制到刊登", itemId: item.id });
            }
            respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish", requestBodyMasked: maskSensitive(body) }, 200, {
              created: result.created,
              updated: result.updated,
              skipped: result.skipped,
              copied: result.created + result.updated,
              total: result.total,
              sourceTotal: selectedProducts.length,
              aiTasks,
              aiTaskCount: aiTasks.length,
              priceConverted: Number(priceConversion?.converted || 0),
              exchangeRate: copyExchangeRate ? { cnyRateRub: copyExchangeRate.rate, date: copyExchangeRate.date || "" } : null,
              nextView: "multiPlatformPublishPanel",
              nextPublishTab: targetPlatform,
              warning: targetPlatform === "ozon" ? "Ozon 不会自动映射 Yandex 类目和属性，请在刊登工作台复核。" : "",
              published: false
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/product-publish/settings" && method === "PUT",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "update", resourceType: "product_publish_settings", requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "product_publish_settings" }, 403, { message: "Forbidden" });
              return;
            }
            getDb().publishSettings = normalizePublishSettings(body?.settings || body || {});
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "product_publish_settings", requestBodyMasked: maskSensitive(body) }, 200, {
              settings: getDb().publishSettings
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/product-publish" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "create", resourceType: "product_publish", requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish" }, 403, { message: "Forbidden" });
              return;
            }
            const item = normalizePublishProductRecord(body?.item || {});
            const shopAccess = resolveScopedDraftShopId(auth.user, item.shopId, getDb().shops || []);
            if (!shopAccess.ok) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish", requestBodyMasked: maskSensitive(body) }, shopAccess.statusCode, { message: shopAccess.message });
              return;
            }
            item.shopId = shopAccess.shopId;
            if (!item.publishPlatform) item.publishPlatform = resolvePublishPlatformFromShopId(item.shopId, getDb().shops || []);
            item.id = makeId("PUB");
            item.createdAt = new Date().toISOString();
            item.updatedAt = item.createdAt;
            if (!Array.isArray(getDb().publishProducts)) getDb().publishProducts = [];
            getDb().publishProducts.unshift(item);
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "product_publish", requestBodyMasked: maskSensitive(body) }, 201, { item });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/product-publish" && method === "DELETE",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "delete", resourceType: "product_publish", requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "product_publish" }, 403, { message: "Forbidden" });
              return;
            }
            const ids = Array.isArray(body?.ids) ? body.ids.map((x) => String(x || "").trim()).filter(Boolean) : [];
            if (!ids.length) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "product_publish" }, 400, { message: "ids is required" });
              return;
            }
            if (!Array.isArray(getDb().publishProducts)) getDb().publishProducts = [];
            const idSet = new Set(ids);
            const foundItems = getDb().publishProducts.filter((item) => idSet.has(String(item.id || "")));
            const forbiddenItem = foundItems.find((item) => !canUserAccessShop(auth.user, item?.shopId, getDb().shops || []));
            if (forbiddenItem) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "product_publish", requestBodyMasked: maskSensitive(body) }, 403, {
                message: `Forbidden shopId: ${String(forbiddenItem.shopId || "").trim() || "(empty)"}`
              });
              return;
            }
            const before = getDb().publishProducts.length;
            getDb().publishProducts = getDb().publishProducts.filter((item) => !idSet.has(String(item.id || "")));
            const removed = before - getDb().publishProducts.length;
            saveDatabase();
            for (const item of foundItems) {
              writeAudit(req, auth.user, {
                ...auditBase,
                actionType: "delete",
                resourceType: "product_publish",
                resourceId: String(item.id || ""),
                requestBodyMasked: { id: item.id, sku: item.sku },
                responseBodyMasked: { deleted: true, title: item.title }
              }, 200, { message: "刊登产品已删除" });
            }
            respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "product_publish" }, 200, { removed, total: getDb().publishProducts.length });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/product-publish/bulk-stock" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "update", resourceType: "product_publish_stock" });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "product_publish_stock" }, 403, { message: "Forbidden" });
              return;
            }
            const ids = Array.isArray(body?.ids) ? body.ids.map((id) => String(id || "").trim()).filter(Boolean) : [];
            const stockCount = Number(body?.stockCount);
            if (!ids.length || !Number.isInteger(stockCount) || stockCount < 0) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "product_publish_stock" }, 400, { message: "ids 和非负整数库存为必填项" });
              return;
            }
            const idSet = new Set(ids);
            const items = (getDb().publishProducts || []).filter((item) => idSet.has(String(item?.id || "")));
            const forbidden = items.find((item) => !canUserAccessShop(auth.user, item.shopId, getDb().shops || []));
            if (forbidden) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "product_publish_stock" }, 403, { message: "包含无权操作的店铺产品" });
              return;
            }
            const now = new Date().toISOString();
            for (const item of items) {
              item.stockCount = stockCount;
              item.updatedAt = now;
              writeAudit(req, auth.user, { ...auditBase, actionType: "update_stock", resourceType: "product_publish", resourceId: item.id }, 200, { message: `库存已设置为 ${stockCount}` });
            }
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "product_publish_stock" }, 200, { updated: items.length, stockCount });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.match(/^\/api\/product-publish\/([^/]+)\/logs$/) && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
        const publishLogsMatch = pathname.match(/^\/api\/product-publish\/([^/]+)\/logs$/);
            const itemId = decodeURIComponent(publishLogsMatch[1] || "");
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "read", resourceType: "product_publish_log", resourceId: itemId });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.read")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "product_publish_log", resourceId: itemId }, 403, { message: "Forbidden" });
              return;
            }
            const item = (getDb().publishProducts || []).find((entry) => String(entry?.id || "") === itemId);
            if (!item) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "product_publish_log", resourceId: itemId }, 404, { message: "Item not found" });
              return;
            }
            if (!canUserAccessShop(auth.user, item.shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "product_publish_log", resourceId: itemId }, 403, { message: "Forbidden" });
              return;
            }
            const labels = { create: "创建", copy: "复制在线产品", update: "修改", update_stock: "修改库存", publish: "发布", delete: "删除", ai_image: "AI 图片" };
            const items = (getDb().auditLogs || [])
              .filter((log) => String(log.resourceType || "") === "product_publish" && String(log.resourceId || "") === itemId)
              .slice(-200)
              .reverse()
              .map(sanitizeAuditLogForClient)
              .map((log) => ({ ...log, actionLabel: labels[log.actionType] || log.actionType }));
            respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "product_publish_log", resourceId: itemId }, 200, { items });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/product-publish/") && method === "PUT",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const itemId = decodeURIComponent(pathname.split("/").pop() || "");
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "update", resourceType: "product_publish", resourceId: itemId, requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "product_publish", resourceId: itemId }, 403, { message: "Forbidden" });
              return;
            }
            if (!Array.isArray(getDb().publishProducts)) getDb().publishProducts = [];
            const idx = getDb().publishProducts.findIndex((item) => String(item?.id || "") === itemId);
            if (idx < 0) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "product_publish", resourceId: itemId }, 404, { message: "Item not found" });
              return;
            }
            if (!canUserAccessShop(auth.user, getDb().publishProducts[idx].shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "product_publish", resourceId: itemId }, 403, { message: "Forbidden" });
              return;
            }
            const incoming = body?.item && typeof body.item === "object" ? body.item : {};
            const merged = normalizePublishProductRecord({ ...getDb().publishProducts[idx], ...incoming });
            if (Object.prototype.hasOwnProperty.call(incoming, "systemSku")) {
              merged.systemSkuPending = !String(incoming.systemSku || "").trim();
              merged.systemSku = String(incoming.systemSku || "").trim();
            }
            merged.id = getDb().publishProducts[idx].id;
            merged.createdAt = getDb().publishProducts[idx].createdAt || merged.createdAt;
            merged.source = getDb().publishProducts[idx].source ?? merged.source;
            if (incoming.shopId) {
              const shopAccess = resolveScopedDraftShopId(auth.user, merged.shopId, getDb().shops || []);
              if (!shopAccess.ok) {
                respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "product_publish", resourceId: itemId, requestBodyMasked: maskSensitive(body) }, shopAccess.statusCode, { message: shopAccess.message });
                return;
              }
              merged.shopId = shopAccess.shopId;
            } else {
              merged.shopId = String(getDb().publishProducts[idx].shopId || "");
            }
            if (!merged.publishPlatform) merged.publishPlatform = resolvePublishPlatformFromShopId(merged.shopId, getDb().shops || []);
            merged.updatedAt = new Date().toISOString();
            getDb().publishProducts[idx] = merged;
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "product_publish", resourceId: itemId, requestBodyMasked: maskSensitive(body) }, 200, { item: merged });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.match(/^\/api\/product-publish\/([^/]+)$/) && method === "PUT",
      handler: async (req, res, query, auditBase, pathname, url) => {
        const publishUpdateMatch = pathname.match(/^\/api\/product-publish\/([^/]+)$/);
            const body = await parseJsonBody(req);
            const id = decodeURIComponent(publishUpdateMatch[1]);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "update", resourceType: "product_publish", resourceId: id, requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "product_publish", resourceId: id }, 403, { message: "Forbidden" });
              return;
            }
            if (!Array.isArray(getDb().publishProducts)) getDb().publishProducts = [];
            const index = getDb().publishProducts.findIndex((item) => String(item.id || "") === id);
            if (index === -1) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "product_publish", resourceId: id }, 404, { message: "Item not found" });
              return;
            }
            const current = getDb().publishProducts[index];
            if (!canUserAccessShop(auth.user, current?.shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "product_publish", resourceId: id }, 403, { message: "Forbidden" });
              return;
            }
            if (isLockedPublishProduct(current)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "product_publish", resourceId: id }, 403, {
                message: "Collected item is locked"
              });
              return;
            }
            const normalized = normalizePublishProductRecord({ ...current, ...(body?.item || {}) });
            const shopAccess = resolveScopedDraftShopId(auth.user, normalized.shopId, getDb().shops || []);
            if (!shopAccess.ok) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "product_publish", resourceId: id, requestBodyMasked: maskSensitive(body) }, shopAccess.statusCode, { message: shopAccess.message });
              return;
            }
            normalized.shopId = shopAccess.shopId;
            if (!normalized.publishPlatform) normalized.publishPlatform = resolvePublishPlatformFromShopId(normalized.shopId, getDb().shops || []);
            getDb().publishProducts[index] = {
              ...current,
              ...normalized,
              id: current.id,
              createdAt: current.createdAt,
              updatedAt: new Date().toISOString(),
              lastPublishStatus: normalized.lastPublishStatus || current.lastPublishStatus || "",
              lastPublishAt: normalized.lastPublishAt || current.lastPublishAt || ""
            };
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "product_publish", resourceId: id, requestBodyMasked: maskSensitive(body) }, 200, { item: getDb().publishProducts[index] });
            return;
      }
    },
    {
      matches: (pathname, method) => (pathname === "/api/yandex/publish" || pathname === "/api/product-publish/publish-yandex") && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "publish", resourceType: "product_publish", requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "publish", resourceType: "product_publish" }, 403, { message: "Forbidden" });
              return;
            }
            const ids = Array.isArray(body?.ids) ? body.ids.map((x) => String(x || "").trim()).filter(Boolean) : [];
            if (!ids.length) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "publish", resourceType: "product_publish" }, 400, { message: "ids is required" });
              return;
            }
            if (!Array.isArray(getDb().publishProducts)) getDb().publishProducts = [];
            const byId = new Map(getDb().publishProducts.map((item) => [String(item.id || ""), item]));
            const picked = ids.map((id) => byId.get(id)).filter(Boolean);
            if (!picked.length) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "publish", resourceType: "product_publish" }, 404, { message: "No items found" });
              return;
            }
        
            const duplicatePublishItem = picked.find((item) => {
              const status = String(item?.publishStatus || item?.lastPublishStatus || "").trim().toLowerCase();
              return status === "pending" || status === "success";
            });
            if (duplicatePublishItem) {
              const status = String(duplicatePublishItem.publishStatus || duplicatePublishItem.lastPublishStatus || "").toLowerCase();
              respondApi(req, res, auth.user, { ...auditBase, actionType: "publish", resourceType: "product_publish", resourceId: duplicatePublishItem.id }, 409, {
                message: `${String(duplicatePublishItem.platformSku || duplicatePublishItem.sku || duplicatePublishItem.id)} ${status === "success" ? "已经发布成功，禁止重复发布" : "正在发布中，请勿重复提交"}`
              });
              return;
            }
            const previousPublishStates = picked.map((item) => ({ item, publishStatus: item.publishStatus, lastPublishStatus: item.lastPublishStatus }));
            const pendingAt = new Date().toISOString();
            for (const item of picked) {
              item.publishStatus = "pending";
              item.lastPublishStatus = "pending";
              item.updatedAt = pendingAt;
            }
            saveDatabase();
        
            const publishResult = await executeProductPublish(auth.user, picked, String(body?.shopId || "").trim(), getDb().shops || [], { enforceScope: true });
            if (publishResult.statusCode >= 400) {
              for (const previous of previousPublishStates) {
                previous.item.publishStatus = previous.publishStatus || "draft";
                previous.item.lastPublishStatus = previous.lastPublishStatus || "";
              }
              saveDatabase();
              for (const item of picked) writeAudit(req, auth.user, { ...auditBase, actionType: "publish", resourceType: "product_publish", resourceId: item.id, requestBodyMasked: { id: item.id, sku: item.sku } }, publishResult.statusCode, publishResult.payload);
              recordPublishOutcome(auth.user, picked, { statusCode: publishResult.statusCode, payload: publishResult.payload });
              respondApi(req, res, auth.user, { ...auditBase, actionType: "publish", resourceType: "product_publish" }, publishResult.statusCode, publishResult.payload);
              return;
            }
            const responsePayload = publishResult.payload;
            for (const item of picked) writeAudit(req, auth.user, { ...auditBase, actionType: "publish", resourceType: "product_publish", resourceId: item.id, requestBodyMasked: { id: item.id, sku: item.sku, title: item.title }, responseBodyMasked: { publishStatus: item.publishStatus, publishResultMessage: item.publishResultMessage } }, 200, responsePayload);
            recordPublishOutcome(auth.user, picked, { statusCode: 200, payload: responsePayload });
            respondApi(
              req,
              res,
              auth.user,
              {
                ...auditBase,
                actionType: "publish",
                resourceType: "product_publish",
                requestBodyMasked: maskSensitive(body),
                responseBodyMasked: maskSensitive(responsePayload)
              },
              200,
              responsePayload
            );
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/product-publish/publish-ozon" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "publish", resourceType: "product_publish", requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "publish", resourceType: "product_publish" }, 403, { message: "Forbidden" });
              return;
            }
            const ids = Array.isArray(body?.ids) ? body.ids.map((x) => String(x || "").trim()).filter(Boolean) : [];
            if (!ids.length) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "publish", resourceType: "product_publish" }, 400, { message: "ids is required" });
              return;
            }
            if (!Array.isArray(getDb().publishProducts)) getDb().publishProducts = [];
            const byId = new Map(getDb().publishProducts.map((item) => [String(item.id || ""), item]));
            const picked = ids.map((id) => byId.get(id)).filter(Boolean);
            if (!picked.length) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "publish", resourceType: "product_publish" }, 404, { message: "No items found" });
              return;
            }
        
            const requestedShopId = String(body?.shopId || "").trim();
            const grouped = new Map();
            const errors = [];
            for (const item of picked) {
              const shopId = String(item.shopId || requestedShopId || "").trim();
              const shop = (getDb().shops || []).find((entry) => String(entry?.id || "") === shopId);
              if (!shop || String(shop.provider || "").toLowerCase() !== "ozon") {
                errors.push({ id: item.id, sku: item.sku || "", message: "缺少有效的 Ozon 店铺" });
                continue;
              }
              if (!canUserAccessShop(auth.user, shopId, getDb().shops || [])) {
                errors.push({ id: item.id, sku: item.sku || "", message: "无权访问该店铺" });
                continue;
              }
              if (!grouped.has(shopId)) grouped.set(shopId, []);
              grouped.get(shopId).push(item);
            }
        
            const results = [];
            let success = 0;
            let processing = 0;
            let failed = errors.length;
            for (const [shopId, items] of grouped.entries()) {
              const shop = (getDb().shops || []).find((entry) => String(entry?.id || "") === shopId);
              const result = await publishOzonProducts(shop, items);
              const now = new Date().toISOString();
              const statusByOffer = new Map((result.items || []).map((entry) => [String(entry.offer_id || entry.offerId || "").trim(), entry]));
              if (!result.ok) {
                failed += items.length;
                for (const item of items) {
                  item.ozonPublishStatus = "failed";
                  item.ozonErrorMessage = result.message || "Ozon 发布失败";
                  item.ozonUpdatedAt = now;
                  item.publishStatus = "failed";
                  item.lastPublishStatus = "failed";
                  item.lastPublishAt = now;
                  item.publishResultMessage = item.ozonErrorMessage;
                  item.updatedAt = now;
                }
                results.push({ shopId, success: 0, processing: 0, failed: items.length, message: result.message, details: result.invalid || [] });
                continue;
              }
              let shopSuccess = 0;
              let shopProcessing = 0;
              for (const item of items) {
                const detail = statusByOffer.get(String(item.sku || item.offerId || item.vendorCode || "").trim());
                const detailStatus = String(detail?.status || detail?.state || "").toLowerCase();
                const itemFailed = ["failed", "error", "cancelled"].includes(detailStatus) || Boolean(detail?.errors?.length);
                const itemDone = ["imported", "success", "completed"].includes(detailStatus);
                const itemStatus = itemFailed ? "failed" : itemDone ? "success" : "processing";
                item.ozonPublishStatus = itemStatus;
                item.ozonTaskId = result.taskId;
                item.ozonProductId = detail?.product_id || detail?.productId || item.ozonProductId || "";
                item.ozonPlatformSku = detail?.offer_id || detail?.offerId || item.ozonPlatformSku || "";
                item.ozonErrorMessage = itemFailed ? (detail?.errors?.[0]?.message || detail?.error || "Ozon 发布失败") : "";
                item.ozonUpdatedAt = now;
                item.publishStatus = itemStatus;
                item.lastPublishStatus = itemStatus;
                item.lastPublishAt = now;
                item.publishAt = now;
                item.publishResultMessage = itemFailed ? item.ozonErrorMessage : itemDone ? "Ozon 发布成功" : "Ozon 任务处理中";
                item.updatedAt = now;
                if (itemFailed) failed += 1;
                else if (itemDone) { success += 1; shopSuccess += 1; }
                else { processing += 1; shopProcessing += 1; }
              }
              results.push({ shopId, taskId: result.taskId, success: shopSuccess, processing: shopProcessing, failed: items.length - shopSuccess - shopProcessing, timedOut: result.timedOut, details: result.items || [] });
            }
            results.push(...errors.map((entry) => ({ ...entry, failed: 1 })));
            saveDatabase();
            const responsePayload = { success, processing, failed, results };
            recordPublishOutcome(auth.user, picked, { statusCode: 200, payload: responsePayload, perItemStatuses: true });
            respondApi(req, res, auth.user, { ...auditBase, actionType: "publish", resourceType: "product_publish", requestBodyMasked: maskSensitive(body), responseBodyMasked: maskSensitive(responsePayload) }, 200, responsePayload);
            return;
      }
    },
  ];
}

module.exports = { createPublishRoutes };
