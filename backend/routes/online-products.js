// 从 server.js 拆出的路由注册表（online-products 域）。

function createOnlineProductsRoutes(deps) {
  const { authService, respondApi, getDb, parseJsonBody, maskSensitive, saveDatabase, getUserAssignedShopIds, filterOnlineProductsByAssignments, canUserAccessShop, fetchYandexOfferMappings, fetchYandexOfferMappingsPaged, mapYandexOfferEntryToProduct, buildOnlineProductKey, normalizeOnlineProductRecord, attachShopIdsToOnlineProducts, validateOptionalExternalHttpUrl, publishYandexProducts, mapOnlineProductToYandexPayload, enrichYandexItemsWithParameterValues, XLSX, writeAudit, YANDEX_MARKET_BASE_URL } = deps;
  return [
    {
      matches: (pathname, method) => pathname === "/api/online-products" && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const auth = authService.requireAuth(req, res, auditBase);
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.read")) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "online_product" }, 403, { message: "Forbidden" });
              return;
            }
            const assignedShopIds = getUserAssignedShopIds(auth.user, getDb().shops || []);
            const source = assignedShopIds === null
              ? getDb().onlineProducts || []
              : assignedShopIds.length
                ? filterOnlineProductsByAssignments(getDb().onlineProducts || [], assignedShopIds, getDb().shops || [])
                : [];
            respondApi(req, res, auth.user, { ...auditBase, resourceType: "online_product" }, 200, { items: source });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/online-products/commission-unmatched" && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const auth = authService.requireAuth(req, res, { ...auditBase, resourceType: "online_product" });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.read")) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "online_product" }, 403, { message: "Forbidden" });
              return;
            }
            const assignedShopIds = getUserAssignedShopIds(auth.user, getDb().shops || []);
            const source = assignedShopIds === null
              ? (getDb().onlineProducts || [])
              : assignedShopIds.length
                ? filterOnlineProductsByAssignments(getDb().onlineProducts || [], assignedShopIds, getDb().shops || [])
                : [];
            const items = source
              .filter((product) => {
                const values = [product.commissionPercent, product.commission, product.feeRate, product.serviceFeeRate];
                return !values.some((value) => value !== null && value !== undefined && String(value).trim() !== "" && Number.isFinite(Number(value)));
              })
              .map((product) => ({
                id: String(product.id || ""),
                shopId: String(product.shopId || ""),
                shopName: String(product.shopName || ""),
                shopSku: String(product.shopSku || product.offerId || ""),
                offerId: String(product.offerId || ""),
                name: String(product.name || ""),
                categoryId: String(product.categoryId || ""),
                categoryName: String(product.categoryName || ""),
                reason: "未匹配平台类目佣金"
              }));
            respondApi(req, res, auth.user, { ...auditBase, resourceType: "online_product" }, 200, { items, total: items.length });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/online-products/sync" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "sync", resourceType: "online_product" });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "sync", resourceType: "online_product" }, 403, { message: "Forbidden" });
              return;
            }
        
            const enabledShops = Array.isArray(getDb().shops) ? getDb().shops.filter((s) => Boolean(s.enabled)) : [];
            const assignedShopIds = getUserAssignedShopIds(auth.user, getDb().shops || []);
            const shops = assignedShopIds === null
              ? enabledShops
              : enabledShops.filter((s) => assignedShopIds.includes(String(s.id || "")));
        
            if (!Array.isArray(getDb().onlineProducts)) getDb().onlineProducts = [];
            const existingByKey = new Map(
              getDb().onlineProducts.map((p) => [buildOnlineProductKey(p), p])
            );
        
            let added = 0;
            let updated = 0;
            let skipped = 0;
            const errors = [];
        
            for (const shop of shops) {
              if (shop.provider !== "yandex_market") {
                skipped += 1;
                continue;
              }
              if (!shop.apiKey || !shop.campaignId) {
                skipped += 1;
                const missingLabel = !shop.campaignId ? "campaignId" : "Api-Key";
                errors.push({ shopId: shop.id, message: `缺少${missingLabel}，请到店铺管理补填后重试` });
                continue;
              }
              if (!shop.businessId) {
                skipped += 1;
                errors.push({ shopId: shop.id, message: "缺少businessId" });
                continue;
              }
        
              const result = await fetchYandexOfferMappingsPaged(shop.businessId, shop.apiKey);
              if (!result.ok) {
                skipped += 1;
                errors.push({ shopId: shop.id, message: result.message || "拉取商品失败" });
                continue;
              }
              if (!result.items || result.items.length === 0) {
                errors.push({ shopId: shop.id, message: "返回0条商品" });
              }
        
              for (const entry of result.items || []) {
                const product = mapYandexOfferEntryToProduct(entry, shop);
                if (!product.shopSku) {
                  skipped += 1;
                  continue;
                }
                const key = buildOnlineProductKey(product);
                const existing = existingByKey.get(key);
                if (existing) {
                  const preserved = {
                    id: existing.id,
                    createdAt: existing.createdAt || product.createdAt
                  };
                  Object.assign(existing, product, preserved, { updatedAt: new Date().toISOString() });
                  updated += 1;
                } else {
                  getDb().onlineProducts.push(product);
                  existingByKey.set(key, product);
                  added += 1;
                }
              }
            }
        
            for (const product of getDb().onlineProducts || []) {
              normalizeOnlineProductRecord(product);
            }
            attachShopIdsToOnlineProducts(getDb().onlineProducts, getDb().shops || []);
            saveDatabase();
        
            respondApi(req, res, auth.user, { ...auditBase, actionType: "sync", resourceType: "online_product" }, 200, {
              added,
              updated,
              skipped,
              totalShops: shops.length,
              errors
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/online-products/sync-sku" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
        const body = await parseJsonBody(req);
        const auditContext = { ...auditBase, actionType: "sync", resourceType: "online_product", requestBodyMasked: maskSensitive(body) };
        const auth = authService.requireAuth(req, res, auditContext);
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "product.sync")) {
          respondApi(req, res, auth.user, auditContext, 403, { message: "Forbidden" });
          return;
        }
        const sku = String(body?.sku || body?.offerId || body?.marketSku || query?.sku || "").trim();
        if (!sku) {
          respondApi(req, res, auth.user, auditContext, 400, { message: "sku is required" });
          return;
        }

        const assignedShopIds = getUserAssignedShopIds(auth.user, getDb().shops || []);
        const enabledShops = (getDb().shops || []).filter(
          (shop) => Boolean(shop.enabled) && String(shop.provider || "").toLowerCase() === "yandex_market"
        );
        const shops = assignedShopIds === null
          ? enabledShops
          : enabledShops.filter((shop) => assignedShopIds.includes(String(shop.id || "")));
        const failures = [];

        for (const shop of shops) {
          if (!shop.apiKey || !shop.businessId) {
            failures.push({ shopId: shop.id, message: "店铺缺少 Api-Key 或 businessId" });
            continue;
          }
          const result = await fetchYandexOfferMappings(String(shop.businessId), shop.apiKey, [sku]);
          if (!result.ok) {
            failures.push({ shopId: shop.id, message: result.message || "拉取商品映射失败" });
            continue;
          }
          const entry = (result.entries || []).find((item) => {
            const offer = item?.offer || item?.mapping?.offer || item?.offerMapping?.offer || {};
            return String(offer?.offerId || offer?.id || item?.offerId || "").trim() === sku;
          });
          if (!entry) continue;

          const product = mapYandexOfferEntryToProduct(entry, shop);
          if (!product.shopSku) {
            failures.push({ shopId: shop.id, message: "映射结果缺少 shopSku" });
            continue;
          }
          if (!Array.isArray(getDb().onlineProducts)) getDb().onlineProducts = [];
          normalizeOnlineProductRecord(product);
          const key = buildOnlineProductKey(product);
          const existing = getDb().onlineProducts.find((item) => buildOnlineProductKey(item) === key);
          if (existing) {
            const preserved = { id: existing.id, createdAt: existing.createdAt || product.createdAt };
            Object.assign(existing, product, preserved, { updatedAt: new Date().toISOString() });
          } else {
            getDb().onlineProducts.push(product);
          }
          attachShopIdsToOnlineProducts(getDb().onlineProducts, getDb().shops || []);
          saveDatabase();
          respondApi(req, res, auth.user, { ...auditContext, resourceId: product.id }, 200, {
            found: true,
            shopId: shop.id,
            shopName: shop.name || "",
            item: product
          });
          return;
        }

        if (shops.length && failures.length === shops.length) {
          respondApi(req, res, auth.user, auditContext, 502, {
            found: false,
            message: failures[0].message,
            errors: failures
          });
          return;
        }
        respondApi(req, res, auth.user, auditContext, 404, { found: false, message: `未找到平台SKU ${sku}` });
        return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/ozon-products/sync" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "sync", resourceType: "online_product" });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "sync", resourceType: "online_product" }, 403, { message: "Forbidden" });
              return;
            }
            const ozonShops = (getDb().shops || []).filter((shop) => String(shop.provider || "").toLowerCase() === "ozon" && Boolean(shop.enabled));
            respondApi(req, res, auth.user, { ...auditBase, actionType: "sync", resourceType: "online_product" }, 200, {
              added: 0,
              updated: 0,
              skipped: 0,
              totalShops: ozonShops.length,
              errors: ozonShops.length
                ? ozonShops.map((shop) => ({ shopId: shop.id, shopName: shop.name, message: "Ozon 产品接口尚未配置" }))
                : [],
              message: ozonShops.length ? "Ozon 店铺已识别，但产品接口尚未配置" : "暂无启用的 Ozon 店铺"
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.match(/^\/api\/online-products\/([^/]+)\/source$/) && method === "PUT",
      handler: async (req, res, query, auditBase, pathname, url) => {
        const onlineSourceMatch = pathname.match(/^\/api\/online-products\/([^/]+)\/source$/);
            const productId = decodeURIComponent(onlineSourceMatch[1]);
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "update", resourceType: "online_product", resourceId: productId, requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "online_product", resourceId: productId }, 403, { message: "Forbidden" });
              return;
            }
            const product = (getDb().onlineProducts || []).find((item) => String(item.id || "") === productId);
            if (!product) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "online_product", resourceId: productId }, 404, { message: "Online product not found" });
              return;
            }
            if (!canUserAccessShop(auth.user, product.shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "online_product", resourceId: productId }, 403, { message: "Forbidden" });
              return;
            }
            for (const field of ["purchaseUrl", "purchaseUrl2"]) {
              if (!Object.prototype.hasOwnProperty.call(body || {}, field)) continue;
              const validation = validateOptionalExternalHttpUrl(body[field], field);
              if (!validation.ok) {
                respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "online_product", resourceId: productId }, 400, { message: validation.message });
                return;
              }
            }
            const textFields = ["sourceType", "sourceNote", "purchaseUrl", "purchaseUrl2"];
            const numberFields = ["purchasePriceRmb", "purchasePriceRub", "salePrice", "originalPrice", "stockCount", "packageLengthCm", "packageWidthCm", "packageHeightCm", "weightKg"];
            for (const field of textFields) {
              if (Object.prototype.hasOwnProperty.call(body || {}, field)) product[field] = String(body[field] ?? "").trim();
            }
            for (const field of numberFields) {
              if (!Object.prototype.hasOwnProperty.call(body || {}, field)) continue;
              const raw = body[field];
              const num = Number(String(raw ?? "").replace(",", ".").trim());
              product[field] = Number.isFinite(num) ? num : null;
            }
            // inventory is the canonical stock field; keep the stockCount alias in sync.
            if (Object.prototype.hasOwnProperty.call(body || {}, "stockCount") && Number.isFinite(Number(product.stockCount))) {
              product.inventory = Number(product.stockCount);
            }
            product.updatedAt = new Date().toISOString();
            normalizeOnlineProductRecord(product);
            saveDatabase();
            const shop = (getDb().shops || []).find((item) => String(item?.id || "") === String(product.shopId || ""));
            let yandexSync = null;
            if (String(shop?.provider || "").trim().toLowerCase() === "yandex_market") {
              const syncResult = await publishYandexProducts({
                shop,
                products: [mapOnlineProductToYandexPayload(product)],
                apiBase: YANDEX_MARKET_BASE_URL,
                enrichProducts: enrichYandexItemsWithParameterValues
              });
              yandexSync = syncResult.mapping
                ? syncResult
                : {
                  ok: false,
                  mapping: { ok: false, message: syncResult.message || "Yandex 商品同步失败", success: 0, failed: syncResult.failed || [] },
                  price: { ok: false, message: "未执行", success: 0, failed: [] },
                  stock: { ok: false, message: "未执行", success: 0, failed: [] }
                };
            }
            respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "online_product", resourceId: productId }, 200, { item: product, yandexSync });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/online-products/export" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "read", resourceType: "online_product", requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.read")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "online_product" }, 403, { message: "Forbidden" });
              return;
            }
            if (!XLSX) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "online_product" }, 500, { message: "Excel library is not installed" });
              return;
            }
            const ids = Array.isArray(body?.ids) ? body.ids.map((id) => String(id || "").trim()).filter(Boolean) : [];
            const columns = Array.isArray(body?.columns) ? body.columns.map((column) => String(column || "").trim()).filter(Boolean) : [];
            if (!ids.length || !columns.length) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "online_product" }, 400, { message: "ids and columns are required" });
              return;
            }
            const assignedShopIds = getUserAssignedShopIds(auth.user, getDb().shops || []);
            const source = assignedShopIds === null
              ? (getDb().onlineProducts || [])
              : (assignedShopIds.length ? filterOnlineProductsByAssignments(getDb().onlineProducts || [], assignedShopIds, getDb().shops || []) : []);
            const idSet = new Set(ids);
            const products = source.filter((product) => idSet.has(String(product.id || "")));
            const labels = {
              shopName: "店铺", name: "商品名称", shopSku: "店铺SKU", offerId: "Offer ID", marketSku: "平台SKU", vendor: "品牌",
              vendorCode: "货号", categoryId: "类目ID", categoryName: "类目名称", status: "状态", salePrice: "售价", originalPrice: "原价",
              inventory: "库存", purchasePriceRmb: "采购价(RMB)", purchasePriceRub: "采购价(RUB)", sourceType: "货源类型", purchaseUrl: "货源链接",
              purchaseUrl2: "货源链接2", collectUrl: "采集链接", packageLengthCm: "长(cm)", packageWidthCm: "宽(cm)", packageHeightCm: "高(cm)", weightKg: "重量(kg)"
            };
            const rows = products.map((product) => Object.fromEntries(columns.map((column) => {
              const value = product[column];
              return [labels[column] || column, Array.isArray(value) ? value.join(" | ") : (value ?? "")];
            })));
            const workbook = XLSX.utils.book_new();
            const sheet = XLSX.utils.json_to_sheet(rows);
            XLSX.utils.book_append_sheet(workbook, sheet, "在线产品");
            const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
            res.writeHead(200, {
              "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              "Content-Disposition": "attachment; filename=online-products-export.xlsx"
            });
            res.end(buffer);
            writeAudit(req, auth.user, { ...auditBase, actionType: "read", resourceType: "online_product" }, 200, { exported: products.length });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/online-products/batch-inventory" && method === "PUT",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "update", resourceType: "online_product", requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "online_product" }, 403, { message: "Forbidden" });
              return;
            }
        
            const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id || "").trim()).filter(Boolean) : [];
            const delta = Number(body.delta);
            if (!ids.length || !Number.isFinite(delta) || delta <= 0) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "online_product" }, 400, {
                message: "ids and delta are required"
              });
              return;
            }
            const idSet = new Set(ids);
            const forbiddenProduct = (getDb().onlineProducts || []).find((product) => idSet.has(String(product.id || "")) && !canUserAccessShop(auth.user, product.shopId, getDb().shops || []));
            if (forbiddenProduct) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "online_product" }, 403, { message: "Forbidden" });
              return;
            }
            let updatedCount = 0;
            for (const product of getDb().onlineProducts || []) {
              if (!idSet.has(String(product.id || ""))) continue;
              const current = Number(product.inventory);
              const next = (Number.isFinite(current) ? current : 0) + delta;
              product.inventory = next;
              // Keep the stockCount alias in sync so list display and exports agree.
              product.stockCount = next;
              product.updatedAt = new Date().toISOString();
              updatedCount += 1;
            }
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "online_product" }, 200, {
              updated: updatedCount
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/online-products" && method === "DELETE",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "delete", resourceType: "online_product", requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "product.sync")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "online_product" }, 403, { message: "Forbidden" });
              return;
            }
            const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id || "").trim()).filter(Boolean) : [];
            if (!ids.length) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "online_product" }, 400, { message: "ids is required" });
              return;
            }
            const idSet = new Set(ids);
            const before = getDb().onlineProducts || [];
            const forbiddenProduct = before.find((product) => idSet.has(String(product.id || "")) && !canUserAccessShop(auth.user, product.shopId, getDb().shops || []));
            if (forbiddenProduct) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "online_product" }, 403, { message: "Forbidden" });
              return;
            }
            getDb().onlineProducts = before.filter((product) => !idSet.has(String(product.id || "")));
            const removed = before.length - getDb().onlineProducts.length;
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "online_product" }, 200, {
              removed
            });
            return;
      }
    },
  ];
}

module.exports = { createOnlineProductsRoutes };
