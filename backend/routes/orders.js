// 从 server.js 拆出的路由注册表（orders 域）。

function createOrdersRoutes(deps) {
  const { authService, respondApi, getDb, parseJsonBody, parseRawBody, XLSX, maskSensitive, saveDatabase, writeAudit, getUserAssignedShopIds, filterOrdersByAssignments, orderBelongsToWorkspace, filterOrders, paginateItems, hasFilterQuery, normalizeOrderSyncOptions, buildRequestedOrderSyncPlan, syncOrdersForShops, orderSyncState, validateNonEmptyString, isValidOrderStatus, makeId, getShopOrderWorkspace, isOrderV2Eligible, normalizeOrderV2, buildOrderV2Summary, buildOrderSummary, findOrderIndexByRef, findOrderByRef, canUserAccessShop, findShopForOrder, ROLE_ADMIN, ROLE_OPERATIONS, ROLE_SUPERVISOR, ROLE_FINANCE, ROLE_SUPPORT, buildOrderPurchasePayload, upsertOrderPurchaseOverride, sqlWriters, fetchYandexOrderLabels, fetchYandexOrderDetail, fetchYandexDeliveryServices, buildDeliveryServiceMap, extractYandexTracking, PDFLib, findMatchingReviewRule, normalizeNullableNumber, readPositiveIntParam } = deps;

  // 采购导入/导出共用同一组列：模板、导出文件、导入解析都以此为准。
  const PURCHASE_IMPORT_COLUMNS = [
    { header: "订单号", field: "orderRef", aliases: ["订单编号", "shopOrderNo", "orderNo", "orderId"] },
    { header: "采购平台", field: "purchasePlatform", aliases: ["purchasePlatform", "平台"] },
    { header: "采购单号", field: "purchaseOrderNo", aliases: ["purchaseOrderNo"] },
    { header: "采购链接", field: "purchaseLink", aliases: ["purchaseLink", "链接"] },
    { header: "国内快递单号", field: "purchaseExpressNo", aliases: ["purchaseExpressNo"] },
    { header: "国际快递单号", field: "purchaseIntlNo", aliases: ["purchaseIntlNo"] },
    { header: "采购人民币", field: "purchasePriceRmb", aliases: ["purchasePriceRmb", "采购价RMB"] },
    { header: "采购卢布", field: "purchasePriceRub", aliases: ["purchasePriceRub", "采购价RUB"] }
  ];
  const PURCHASE_IMPORT_HEADER_MAP = (() => {
    const map = new Map();
    for (const column of PURCHASE_IMPORT_COLUMNS) {
      map.set(column.header, column.field);
      for (const alias of column.aliases || []) map.set(alias, column.field);
    }
    return map;
  })();
  const PURCHASE_VALUE_FIELDS = PURCHASE_IMPORT_COLUMNS
    .map((column) => column.field)
    .filter((field) => field !== "orderRef");

  function hasOrderPurchaseInfo(order) {
    return Boolean(
      order?.purchaseOrderNo ||
      order?.purchasePlatform ||
      order?.purchasePriceRmb ||
      order?.purchasePriceRub ||
      order?.purchaseLink ||
      order?.purchaseExpressNo ||
      order?.purchaseIntlNo
    );
  }

  return [
    {
      matches: (pathname, method) => pathname === "/api/orders" && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const auth = authService.requireAuth(req, res, auditBase);
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.read")) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "order" }, 403, { message: "Forbidden" });
              return;
            }
        
            const assignedShopIds = getUserAssignedShopIds(auth.user, getDb().shops || []);
            const source = assignedShopIds === null ? getDb().orders : assignedShopIds.length ? filterOrdersByAssignments(getDb().orders, assignedShopIds, getDb().shops || []) : [];
            const workspaceSource = source.filter((order) => orderBelongsToWorkspace(order, getDb().shops || [], getDb().shopOrderWorkspaceOverrides, "v1"));
            const filtered = filterOrders(workspaceSource, query);
            const paged = paginateItems(filtered, query, 50);
            const actionType = hasFilterQuery(query) ? "filter_query" : "read";
            respondApi(req, res, auth.user, { ...auditBase, actionType, resourceType: "order" }, 200, { items: paged.items, pagination: paged.pagination });
            return;
      }
    },
    {
      // 首页仪表盘的聚合结果：一次返回 KPI + 各平台（页签）的图表序列/状态计数/Top10 店铺。
      // 目的是让前端不再下载整张 orders 表（此前每次进面板都会拉全量，见 order-summary.js 顶部说明）。
      // 取数范围与上面的 /api/orders 完全一致（店铺授权 + 工作区），保证两处看到同一批订单。
      matches: (pathname, method) => pathname === "/api/orders/summary" && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "read", resourceType: "order" });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.read")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order" }, 403, { message: "Forbidden" });
              return;
            }
            const allOrders = getDb().orders || [];
            const assignedShopIds = getUserAssignedShopIds(auth.user, getDb().shops || []);
            const source = assignedShopIds === null ? allOrders : assignedShopIds.length ? filterOrdersByAssignments(allOrders, assignedShopIds, getDb().shops || []) : [];
            const workspaceSource = source.filter((order) => orderBelongsToWorkspace(order, getDb().shops || [], getDb().shopOrderWorkspaceOverrides, "v1"));
            respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order" }, 200, buildOrderSummary(workspaceSource));
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/orders/sync" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "sync", resourceType: "order", requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.create")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "sync", resourceType: "order", requestBodyMasked: maskSensitive(body) }, 403, { message: "Forbidden" });
              return;
            }
            const syncOptions = normalizeOrderSyncOptions(body);
            if ((body.fromDate || body.toDate) && (!syncOptions.fromDate || !syncOptions.toDate)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "sync", resourceType: "order", requestBodyMasked: maskSensitive(body) }, 400, {
                message: "时间格式无效"
              });
              return;
            }
        
            if (orderSyncState.running) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "sync", resourceType: "order", requestBodyMasked: maskSensitive(body) }, 409, {
                message: "Order sync already running"
              });
              return;
            }
            orderSyncState.running = true;
            try {
              const enabledShops = Array.isArray(getDb().shops) ? getDb().shops.filter((s) => Boolean(s.enabled)) : [];
              const assignedShopIds = getUserAssignedShopIds(auth.user, getDb().shops || []);
              const scopeShops = assignedShopIds === null
                ? enabledShops
                : enabledShops.filter((s) => assignedShopIds.includes(String(s.id || "")));
              const shops = syncOptions.shopIds.length
                ? scopeShops.filter((s) => syncOptions.shopIds.includes(String(s.id || "")))
                : scopeShops;
              let syncResult;
              if (syncOptions.orderNos.length && !syncOptions.shopIds.length) {
                const routing = buildRequestedOrderSyncPlan(shops, syncOptions.orderNos, getDb().orders || []);
                const combined = { added: 0, updated: 0, skipped: 0, errors: [] };
                for (const plan of routing.plans) {
                  const result = await syncOrdersForShops([plan.shop], { ...syncOptions, orderNos: plan.orderNos });
                  combined.added += result.added;
                  combined.updated += result.updated;
                  combined.skipped += result.skipped;
                  combined.errors.push(...result.errors);
                }
                if (routing.unresolved.length) {
                  combined.skipped += routing.unresolved.length;
                  combined.errors.push({
                    shopId: "",
                    message: `订单 ${routing.unresolved.join(", ")} 尚未建立店铺归属，请先选择具体店铺再同步`
                  });
                }
                syncResult = combined;
              } else {
                syncResult = await syncOrdersForShops(shops, syncOptions);
              }
              const { added, updated, skipped, errors } = syncResult;
              respondApi(req, res, auth.user, { ...auditBase, actionType: "sync", resourceType: "order", requestBodyMasked: maskSensitive(body) }, 200, {
                added,
                updated,
                skipped,
                totalShops: shops.length,
                errors,
                cleared: false
              });
            } finally {
              orderSyncState.running = false;
            }
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/orders" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "create", resourceType: "order", requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.create")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "order", requestBodyMasked: maskSensitive(body) }, 403, { message: "Forbidden" });
              return;
            }
        
            const customerNameValidation = validateNonEmptyString(body.customerName, "customerName", 120);
            const customerName = customerNameValidation.ok ? customerNameValidation.value : "";
            const amount = Number(body.amount);
            const status = String(body.status || "pending");
        
            if (!customerNameValidation.ok) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "order", requestBodyMasked: maskSensitive(body) }, 400, { message: customerNameValidation.message });
              return;
            }
            if (!Number.isFinite(amount) || amount < 0) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "order", requestBodyMasked: maskSensitive(body) }, 400, { message: "amount must be a non-negative number" });
              return;
            }
            if (!isValidOrderStatus(status)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "order", requestBodyMasked: maskSensitive(body) }, 400, { message: "status must be pending/paid/shipped/cancelled" });
              return;
            }
        
            const order = {
              id: makeId("ORD"),
              customerName,
              amount,
              status,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };
        
            getDb().orders.unshift(order);
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "order", resourceId: order.id, requestBodyMasked: maskSensitive(body) }, 201, { item: order });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/orders-v2" && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const auth = authService.requireAuth(req, res, auditBase);
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.read")) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "order_v2" }, 403, { message: "Forbidden" });
              return;
            }
        
            const shops = Array.isArray(getDb().shops) ? getDb().shops : [];
            const shopsById = new Map(shops.map((shop) => [String(shop.id || ""), shop]));
            const assignedShopIds = getUserAssignedShopIds(auth.user, shops);
            const source = assignedShopIds === null
              ? getDb().orders
              : assignedShopIds.length
                ? filterOrdersByAssignments(getDb().orders, assignedShopIds, shops)
                : [];
            const eligible = (Array.isArray(source) ? source : [])
              .map((order) => ({ order, shop: shopsById.get(String(order.shopId || "")) }))
              .filter(({ shop }) => getShopOrderWorkspace(shop, getDb().shopOrderWorkspaceOverrides) === "v2")
              .filter(({ order, shop }) => isOrderV2Eligible(order, shop))
              .map(({ order, shop }) => normalizeOrderV2(order, shop));
            const filtered = filterOrders(eligible, query);
            const paged = paginateItems(filtered, query, 50);
            const actionType = hasFilterQuery(query) ? "filter_query" : "read";
            respondApi(req, res, auth.user, { ...auditBase, actionType, resourceType: "order_v2" }, 200, {
              items: paged.items,
              pagination: paged.pagination,
              summary: buildOrderV2Summary(eligible),
              currency: "CNY"
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.match(/^\/api\/orders\/([^/]+)\/match-product$/) && method === "PUT",
      handler: async (req, res, query, auditBase, pathname, url) => {
        const orderMatchProductMatch = pathname.match(/^\/api\/orders\/([^/]+)\/match-product$/);
            const orderId = decodeURIComponent(orderMatchProductMatch[1]);
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "update", resourceType: "order_product_match", resourceId: orderId, requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.update")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_product_match", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
            const orderIndex = findOrderIndexByRef(getDb().orders, orderId);
            if (orderIndex < 0) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_product_match", resourceId: orderId }, 404, { message: "Order not found" });
              return;
            }
            const order = getDb().orders[orderIndex];
            if (!canUserAccessShop(auth.user, order.shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_product_match", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
            const productId = String(body?.productId || "").trim();
            if (!productId) {
              delete order.matchedOnlineProductId;
              delete order.matchedOnlineProductName;
              delete order.matchedOnlineProductSku;
              delete order.matchedOnlineProductWeightKg;
              delete order.matchedOnlineProductCommissionPercent;
            } else {
              const product = (getDb().onlineProducts || []).find((item) => String(item.id || "") === productId);
              if (!product) {
                respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_product_match", resourceId: orderId }, 404, { message: "Online product not found" });
                return;
              }
              if (!canUserAccessShop(auth.user, product.shopId, getDb().shops || [])) {
                respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_product_match", resourceId: orderId }, 403, { message: "Forbidden" });
                return;
              }
              if (order.shopId && product.shopId && String(order.shopId) !== String(product.shopId)) {
                respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_product_match", resourceId: orderId }, 400, { message: "订单与在线产品不属于同一店铺" });
                return;
              }
              order.matchedOnlineProductId = product.id;
              order.matchedOnlineProductName = product.name || "";
              order.matchedOnlineProductSku = product.shopSku || product.offerId || product.vendorCode || "";
              order.matchedOnlineProductWeightKg = product.weightKg ?? null;
              order.matchedOnlineProductCommissionPercent = product.commissionPercent ?? product.commission ?? product.feeRate ?? null;
            }
            order.updatedAt = new Date().toISOString();
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_product_match", resourceId: orderId }, 200, { item: order });
            return;
      }
    },
    {
      matches: (pathname, method) => /^\/api\/orders\/[^/]+$/.test(pathname) && method === "PUT",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const orderId = decodeURIComponent(pathname.split("/").pop() || "");
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "update", resourceType: "order", resourceId: orderId, requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
        
            const index = findOrderIndexByRef(getDb().orders, orderId);
            if (index < 0) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order", resourceId: orderId, requestBodyMasked: maskSensitive(body) }, 404, { message: "Order not found" });
              return;
            }
            if (!canUserAccessShop(auth.user, getDb().orders[index].shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
        
            const role = auth.user.role;
            const keys = Object.keys(body || {});
            const statusOnly = keys.length > 0 && keys.every((k) => k === "status");
        
            if (role === ROLE_FINANCE) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order", resourceId: orderId, requestBodyMasked: maskSensitive(body) }, 403, { message: "Forbidden" });
              return;
            }
        
            if (role === ROLE_SUPPORT && !statusOnly) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order", resourceId: orderId, requestBodyMasked: maskSensitive(body) }, 403, { message: "Support can only update status" });
              return;
            }
            if (role === ROLE_SUPPORT && body.status !== undefined) {
              const requestedStatus = String(body.status);
              const currentStatus = String(getDb().orders[index].status);
              if (requestedStatus === "cancelled" || currentStatus === "cancelled") {
                respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order", resourceId: orderId, requestBodyMasked: maskSensitive(body) }, 403, { message: "Support cannot void or reactivate orders" });
                return;
              }
            }
        
            if (role === ROLE_SUPPORT && !authService.checkPermission(auth.user, "order.update_status")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order", resourceId: orderId, requestBodyMasked: maskSensitive(body) }, 403, { message: "Forbidden" });
              return;
            }
        
            if ((role === ROLE_ADMIN || role === ROLE_OPERATIONS || role === ROLE_SUPERVISOR) && !authService.checkPermission(auth.user, "order.update")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order", resourceId: orderId, requestBodyMasked: maskSensitive(body) }, 403, { message: "Forbidden" });
              return;
            }
        
            const nextCustomerName = body.customerName !== undefined ? String(body.customerName).trim() : getDb().orders[index].customerName;
            const nextAmount = body.amount !== undefined ? Number(body.amount) : getDb().orders[index].amount;
            const nextStatus = body.status !== undefined ? String(body.status) : getDb().orders[index].status;
        
            // Status-only updates must not re-validate untouched fields: support users
            // would otherwise be blocked on orders whose customerName is empty or
            // whose amount could not be mapped.
            if (!statusOnly) {
              if (!nextCustomerName) {
                respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order", resourceId: orderId, requestBodyMasked: maskSensitive(body) }, 400, { message: "customerName is required" });
                return;
              }
              if (!Number.isFinite(nextAmount) || nextAmount < 0) {
                respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order", resourceId: orderId, requestBodyMasked: maskSensitive(body) }, 400, { message: "amount must be a non-negative number" });
                return;
              }
            }
            if (!isValidOrderStatus(nextStatus)) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order", resourceId: orderId, requestBodyMasked: maskSensitive(body) }, 400, { message: "status must be pending/paid/shipped/cancelled" });
              return;
            }
        
            getDb().orders[index] = {
              ...getDb().orders[index],
              customerName: nextCustomerName,
              amount: nextAmount,
              status: nextStatus,
              updatedAt: new Date().toISOString()
            };
        
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order", resourceId: orderId, requestBodyMasked: maskSensitive(body) }, 200, { item: getDb().orders[index] });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/orders/") && pathname.endsWith("/remark") && method === "PUT",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const parts = pathname.split("/");
            const orderId = decodeURIComponent(parts[3] || "");
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "update", resourceType: "order_remark", resourceId: orderId, requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.update") && !authService.checkPermission(auth.user, "order.update_status")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_remark", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
        
            const index = findOrderIndexByRef(getDb().orders, orderId);
            if (index < 0) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_remark", resourceId: orderId }, 404, { message: "Order not found" });
              return;
            }
            if (!canUserAccessShop(auth.user, getDb().orders[index].shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "order_remark", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
        
            const remark = String(body.remark || "").trim();
            getDb().orders[index].remark = remark;
            getDb().orders[index].updatedAt = new Date().toISOString();
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_remark", resourceId: orderId }, 200, {
              item: getDb().orders[index]
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/orders/") && pathname.endsWith("/purchase") && method === "PUT",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const parts = pathname.split("/");
            const orderId = decodeURIComponent(parts[3] || "");
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "update", resourceType: "order_purchase", resourceId: orderId, requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.update") && !authService.checkPermission(auth.user, "order.update_status")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_purchase", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
        
            const index = findOrderIndexByRef(getDb().orders, orderId);
            if (index >= 0 && !canUserAccessShop(auth.user, getDb().orders[index].shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_purchase", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
            if (index < 0 && getUserAssignedShopIds(auth.user, getDb().shops || []) !== null) {
              // Deferred orderRef is not attributable to a shop; only unrestricted (admin) users may write it.
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_purchase", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
            const payload = buildOrderPurchasePayload(body);
            const override = upsertOrderPurchaseOverride(orderId, payload);
            if (index < 0) {
              try {
                await sqlWriters.saveSingleOrderPurchaseToSql({ id: orderId, shopOrderNo: orderId, ...override });
              } catch (error) {
                respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_purchase", resourceId: orderId }, 500, { message: "Failed to save purchase information" });
                return;
              }
              saveDatabase();
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_purchase", resourceId: orderId }, 200, {
                item: {
                  id: orderId,
                  shopOrderNo: orderId,
                  ...override
                },
                deferred: true
              });
              return;
            }
        
            getDb().orders[index] = {
              ...getDb().orders[index],
              ...payload,
              updatedAt: new Date().toISOString()
            };
        
            try {
              await sqlWriters.saveSingleOrderPurchaseToSql(getDb().orders[index]);
            } catch (error) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_purchase", resourceId: orderId }, 500, { message: "Failed to save purchase information" });
              return;
            }
        
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_purchase", resourceId: orderId }, 200, {
              item: getDb().orders[index]
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/orders/purchase-template" && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
        const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "read", resourceType: "order_purchase" });
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "order.update") && !authService.checkPermission(auth.user, "order.update_status")) {
          respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_purchase" }, 403, { message: "Forbidden" });
          return;
        }
        if (!XLSX) {
          respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_purchase" }, 500, { message: "Excel library is not installed" });
          return;
        }
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(
          workbook,
          XLSX.utils.aoa_to_sheet([PURCHASE_IMPORT_COLUMNS.map((column) => column.header)]),
          "采购导入"
        );
        const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
        res.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": "attachment; filename=purchase-import-template.xlsx"
        });
        res.end(buffer);
        writeAudit(req, auth.user, { ...auditBase, actionType: "read", resourceType: "order_purchase" }, 200, { template: true });
        return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/orders/purchase-export" && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
        const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "read", resourceType: "order_purchase" });
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "order.read")) {
          respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_purchase" }, 403, { message: "Forbidden" });
          return;
        }
        if (!XLSX) {
          respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_purchase" }, 500, { message: "Excel library is not installed" });
          return;
        }
        const assignedShopIds = getUserAssignedShopIds(auth.user, getDb().shops || []);
        // 三态必须写全：null = 不受限制（仅 admin）；[] = 无可见店铺，而不是「全部店铺」。
        const scopedOrders = assignedShopIds === null
          ? (getDb().orders || [])
          : assignedShopIds.length
            ? filterOrdersByAssignments(getDb().orders || [], assignedShopIds, getDb().shops || [])
            : [];
        const unpurchased = scopedOrders.filter((order) => !hasOrderPurchaseInfo(order));
        const rows = [[
          "订单号", "店铺", "SKU", "商品信息", "数量", "订单金额(RUB)",
          ...PURCHASE_IMPORT_COLUMNS.filter((column) => column.field !== "orderRef").map((column) => column.header)
        ]];
        for (const order of unpurchased) {
          rows.push([
            String(order.shopOrderNo || order.id || ""),
            String(order.shopName || order.shopId || ""),
            String(order.shopSku || ""),
            String(order.productName || order.title || ""),
            Number(order.itemCount || 1) || 1,
            Number(order.amount) || 0,
            String(order.purchasePlatform || ""),
            String(order.purchaseOrderNo || ""),
            String(order.purchaseLink || ""),
            String(order.purchaseExpressNo || ""),
            String(order.purchaseIntlNo || ""),
            String(order.purchasePriceRmb || ""),
            String(order.purchasePriceRub || "")
          ]);
        }
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "未采购订单");
        const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
        res.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": "attachment; filename=unpurchased-orders.xlsx"
        });
        res.end(buffer);
        writeAudit(req, auth.user, { ...auditBase, actionType: "read", resourceType: "order_purchase" }, 200, { exported: unpurchased.length });
        return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/orders/purchase-import" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
        const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "update", resourceType: "order_purchase" });
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "order.update") && !authService.checkPermission(auth.user, "order.update_status")) {
          respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_purchase" }, 403, { message: "Forbidden" });
          return;
        }
        if (!XLSX) {
          respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_purchase" }, 500, { message: "Excel library is not installed" });
          return;
        }
        const raw = await parseRawBody(req);
        const contentType = String(req.headers["content-type"] || "").toLowerCase();
        if (raw.length > 12 * 1024 * 1024 || (contentType && !contentType.includes("multipart") && !contentType.includes("spreadsheet") && !contentType.includes("octet-stream"))) {
          respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_purchase" }, 400, { message: "仅支持 12MB 以内的 Excel 文件" });
          return;
        }
        let rows;
        try {
          const workbook = XLSX.read(raw, { type: "buffer", cellDates: false });
          if (!Array.isArray(workbook.SheetNames) || workbook.SheetNames.length !== 1) throw new Error("文件必须只包含一个工作表");
          rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
        } catch (error) {
          respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_purchase" }, 400, { message: `导入文件无法读取: ${String(error.message || error)}` });
          return;
        }
        if (!Array.isArray(rows) || !rows.length) {
          respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_purchase" }, 400, { message: "导入文件没有数据行" });
          return;
        }
        let updated = 0;
        let skipped = 0;
        const errors = [];
        for (let index = 0; index < rows.length; index += 1) {
          const rawItem = rows[index] || {};
          const normalized = {};
          for (const [key, value] of Object.entries(rawItem)) {
            const field = PURCHASE_IMPORT_HEADER_MAP.get(String(key || "").trim());
            if (field) normalized[field] = value;
          }
          const rowNumber = index + 2;
          const orderRef = String(normalized.orderRef || "").trim();
          if (!orderRef) {
            errors.push({ row: rowNumber, message: "缺少订单号" });
            continue;
          }
          const orderIndex = findOrderIndexByRef(getDb().orders, orderRef);
          if (orderIndex < 0) {
            errors.push({ row: rowNumber, message: `未找到订单 ${orderRef}` });
            continue;
          }
          const order = getDb().orders[orderIndex];
          if (!canUserAccessShop(auth.user, order.shopId, getDb().shops || [])) {
            errors.push({ row: rowNumber, message: `无权修改订单 ${orderRef}` });
            continue;
          }
          // 只写入表里填了值的字段：留空表示保持原值，避免整行覆盖造成数据丢失。
          const payload = {};
          for (const field of PURCHASE_VALUE_FIELDS) {
            const value = String(normalized[field] ?? "").trim();
            if (value !== "") payload[field] = value;
          }
          if (!Object.keys(payload).length) {
            skipped += 1;
            continue;
          }
          const changed = Object.keys(payload).some((field) => String(order[field] ?? "") !== String(payload[field]));
          if (!changed) {
            skipped += 1;
            continue;
          }
          payload.purchaseUpdatedAt = new Date().toISOString();
          getDb().orders[orderIndex] = {
            ...order,
            ...payload,
            updatedAt: new Date().toISOString()
          };
          upsertOrderPurchaseOverride(String(order.id || orderRef), payload);
          try {
            await sqlWriters.saveSingleOrderPurchaseToSql(getDb().orders[orderIndex]);
          } catch (error) {
            errors.push({ row: rowNumber, message: `订单 ${orderRef} 写入数据库失败` });
            continue;
          }
          updated += 1;
        }
        saveDatabase();
        respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_purchase" }, 200, { updated, skipped, errors });
        return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/orders/") && pathname.endsWith("/void") && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const parts = pathname.split("/");
            const orderId = decodeURIComponent(parts[3] || "");
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "void", resourceType: "order", resourceId: orderId });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.void")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "void", resourceType: "order", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
        
            const index = findOrderIndexByRef(getDb().orders, orderId);
            if (index < 0) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "void", resourceType: "order", resourceId: orderId }, 404, { message: "Order not found" });
              return;
            }
        
            if (!canUserAccessShop(auth.user, getDb().orders[index].shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "void", resourceType: "order", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
        
            if (getDb().orders[index].status === "cancelled") {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "void", resourceType: "order", resourceId: orderId }, 400, { message: "Order already voided" });
              return;
            }
        
            getDb().orders[index] = {
              ...getDb().orders[index],
              reactivationStatus: getDb().orders[index].status,
              status: "cancelled",
              updatedAt: new Date().toISOString()
            };
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "void", resourceType: "order", resourceId: orderId }, 200, { item: getDb().orders[index] });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/orders/") && pathname.endsWith("/reactivate") && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const parts = pathname.split("/");
            const orderId = decodeURIComponent(parts[3] || "");
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "reactivate", resourceType: "order", resourceId: orderId });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.reactivate")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "reactivate", resourceType: "order", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
        
            const index = findOrderIndexByRef(getDb().orders, orderId);
            if (index < 0) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "reactivate", resourceType: "order", resourceId: orderId }, 404, { message: "Order not found" });
              return;
            }
        
            if (!canUserAccessShop(auth.user, getDb().orders[index].shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "reactivate", resourceType: "order", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
        
            if (getDb().orders[index].status !== "cancelled") {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "reactivate", resourceType: "order", resourceId: orderId }, 400, { message: "Only voided orders can be reactivated" });
              return;
            }
        
            const nextStatus = getDb().orders[index].reactivationStatus || "pending";
            getDb().orders[index] = {
              ...getDb().orders[index],
              status: nextStatus,
              reactivationStatus: undefined,
              updatedAt: new Date().toISOString()
            };
            delete getDb().orders[index].reactivationStatus;
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "reactivate", resourceType: "order", resourceId: orderId }, 200, { item: getDb().orders[index] });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/orders/") && pathname.endsWith("/labels") && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const parts = pathname.split("/");
            const orderId = decodeURIComponent(parts[3] || "");
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "read", resourceType: "order_label", resourceId: orderId });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.read")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_label", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
        
            const order = findOrderByRef(getDb().orders, orderId);
            if (!order) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_label", resourceId: orderId }, 404, { message: "Order not found" });
              return;
            }
            if (!canUserAccessShop(auth.user, order.shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "order_label", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
            if (String(order.provider || "").toLowerCase() !== "yandex_market") {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_label", resourceId: orderId }, 400, { message: "Only Yandex orders support labels" });
              return;
            }
        
            const campaignId = String(order.account || order.shopAccount || "").trim();
            let shop = null;
            if (campaignId) {
              shop = (getDb().shops || []).find((s) => String(s.campaignId || "") === campaignId);
            }
            if (!shop) {
              const shopName = String(order.shopName || "").trim();
              shop = (getDb().shops || []).find((s) => String(s.name || "").trim() === shopName);
            }
            if (!shop || !shop.apiKey || !shop.campaignId) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_label", resourceId: orderId }, 400, { message: "Shop API key or campaignId missing" });
              return;
            }
        
            const externalOrderId = String(order.shopOrderNo || order.shopOrderId || order.externalOrderId || "").trim();
            if (!externalOrderId) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_label", resourceId: orderId }, 400, { message: "Order external ID missing" });
              return;
            }
        
            const format = String(query.format || "A4").trim();
            const label = await fetchYandexOrderLabels(String(shop.campaignId), shop.apiKey, externalOrderId, format);
            if (!label.ok) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_label", resourceId: orderId }, label.status || 502, {
                message: label.message || "Label fetch failed"
              });
              return;
            }
        
            res.writeHead(200, {
              "Content-Type": label.contentType || "application/pdf",
              "Content-Disposition": `attachment; filename="label-${externalOrderId}.pdf"`
            });
            res.end(label.data);
            writeAudit(req, auth.user, { ...auditBase, actionType: "read", resourceType: "order_label", resourceId: orderId }, 200, { message: "ok" });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/orders/") && pathname.endsWith("/labels/save") && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const parts = pathname.split("/");
            const orderId = decodeURIComponent(parts[3] || "");
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "update", resourceType: "order_label", resourceId: orderId });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.update") && !authService.checkPermission(auth.user, "order.update_status")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_label", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
        
            const order = findOrderByRef(getDb().orders, orderId);
            if (!order) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_label", resourceId: orderId }, 404, { message: "Order not found" });
              return;
            }
            if (!canUserAccessShop(auth.user, order.shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_label", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
            if (String(order.provider || "").toLowerCase() !== "yandex_market") {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_label", resourceId: orderId }, 400, { message: "Only Yandex orders support labels" });
              return;
            }
            if (order.labelData) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_label", resourceId: orderId }, 409, {
                message: "Label already synced once; repeat sync is blocked",
                item: {
                  id: order.id,
                  labelUpdatedAt: order.labelUpdatedAt || ""
                }
              });
              return;
            }
        
            const campaignId = String(order.account || order.shopAccount || "").trim();
            let shop = null;
            if (campaignId) {
              shop = (getDb().shops || []).find((s) => String(s.campaignId || "") === campaignId);
            }
            if (!shop) {
              const shopName = String(order.shopName || "").trim();
              shop = (getDb().shops || []).find((s) => String(s.name || "").trim() === shopName);
            }
            if (!shop || !shop.apiKey || !shop.campaignId) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_label", resourceId: orderId }, 400, { message: "Shop API key or campaignId missing" });
              return;
            }
        
            const externalOrderId = String(order.shopOrderNo || order.shopOrderId || order.externalOrderId || "").trim();
            if (!externalOrderId) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_label", resourceId: orderId }, 400, { message: "Order external ID missing" });
              return;
            }
        
            const format = String(query.format || "A4").trim();
            const label = await fetchYandexOrderLabels(String(shop.campaignId), shop.apiKey, externalOrderId, format);
            if (!label.ok) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_label", resourceId: orderId }, label.status || 502, {
                message: label.message || "Label fetch failed"
              });
              return;
            }
        
            order.labelData = label.data.toString("base64");
            order.labelContentType = label.contentType || "application/pdf";
            order.labelFormat = format;
            order.labelUpdatedAt = new Date().toISOString();
            saveDatabase();
        
            respondApi(req, res, auth.user, { ...auditBase, actionType: "update", resourceType: "order_label", resourceId: orderId }, 200, {
              message: "Label saved",
              item: {
                id: order.id,
                labelUpdatedAt: order.labelUpdatedAt
              }
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/orders/") && pathname.endsWith("/labels/print") && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const parts = pathname.split("/");
            const orderId = decodeURIComponent(parts[3] || "");
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "read", resourceType: "order_label", resourceId: orderId });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.read")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_label", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
        
            const order = findOrderByRef(getDb().orders, orderId);
            if (!order || !order.labelData) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_label", resourceId: orderId }, 404, { message: "Label not saved" });
              return;
            }
            if (!canUserAccessShop(auth.user, order.shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_label", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
            const buffer = Buffer.from(String(order.labelData), "base64");
            const contentType = order.labelContentType || "application/pdf";
            res.writeHead(200, { "Content-Type": contentType });
            res.end(buffer);
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/orders/") && pathname.endsWith("/tracking") && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const parts = pathname.split("/");
            const orderId = decodeURIComponent(parts[3] || "");
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "read", resourceType: "order_tracking", resourceId: orderId });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.read")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_tracking", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
        
            const order = getDb().orders.find((o) => o.id === orderId);
            if (!order) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_tracking", resourceId: orderId }, 404, { message: "Order not found" });
              return;
            }
            if (!canUserAccessShop(auth.user, order.shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_tracking", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
            if (String(order.provider || "").toLowerCase() !== "yandex_market") {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_tracking", resourceId: orderId }, 400, { message: "Only Yandex orders support tracking" });
              return;
            }
        
            const shop = findShopForOrder(order);
            if (!shop || !shop.apiKey || !shop.campaignId) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_tracking", resourceId: orderId }, 400, { message: "Shop API key or campaignId missing" });
              return;
            }
        
            const externalOrderId = String(order.shopOrderNo || order.shopOrderId || order.externalOrderId || "").trim();
            if (!externalOrderId) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_tracking", resourceId: orderId }, 400, {
                message: "Order external ID missing"
              });
              return;
            }
        
            const detail = await fetchYandexOrderDetail(String(shop.campaignId), shop.apiKey, externalOrderId);
            if (!detail.ok || !detail.item) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_tracking", resourceId: orderId }, detail.status || 502, {
                message: detail.message || "Order detail fetch failed"
              });
              return;
            }
        
            const services = await fetchYandexDeliveryServices(String(shop.campaignId), shop.apiKey);
            const serviceMap = services.ok ? buildDeliveryServiceMap(services.items || []) : new Map();
            const tracking = extractYandexTracking(detail.item, serviceMap);
        
            respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_tracking", resourceId: orderId }, 200, {
              ...tracking,
              fulfillmentType: String(detail.item?.delivery?.type || detail.item?.deliveryType || detail.item?.fulfillmentType || "").toUpperCase()
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/orders/labels/merge" && method === "POST",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "read", resourceType: "order_label" });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.read")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_label" }, 403, { message: "Forbidden" });
              return;
            }
            if (!PDFLib) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_label" }, 500, { message: "PDF library not installed" });
              return;
            }
            const orderIds = Array.isArray(body.orderIds) ? body.orderIds.map(String) : [];
            if (!orderIds.length) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_label" }, 400, { message: "orderIds is required" });
              return;
            }
        
            const { PDFDocument } = PDFLib;
            const merged = await PDFDocument.create();
            let mergedCount = 0;
        
            for (const orderId of orderIds) {
              const order = findOrderByRef(getDb().orders, orderId);
              if (!order || !order.labelData || !canUserAccessShop(auth.user, order.shopId, getDb().shops || [])) continue;
              const bytes = Buffer.from(String(order.labelData), "base64");
              const doc = await PDFDocument.load(bytes);
              const pages = await merged.copyPages(doc, doc.getPageIndices());
              pages.forEach((p) => merged.addPage(p));
              mergedCount += pages.length;
            }
        
            if (!mergedCount) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_label" }, 404, { message: "No saved labels" });
              return;
            }
        
            const pdfBytes = await merged.save();
            res.writeHead(200, {
              "Content-Type": "application/pdf",
              "Content-Disposition": "attachment; filename=\"labels-merged.pdf\""
            });
            res.end(Buffer.from(pdfBytes));
            writeAudit(req, auth.user, { ...auditBase, actionType: "export", resourceType: "order_label" }, 200, { message: "ok", mergedCount });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/orders/") && method === "DELETE",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const orderId = decodeURIComponent(pathname.split("/").pop() || "");
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "delete", resourceType: "order", resourceId: orderId });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.delete")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "order", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
        
            const before = getDb().orders.length;
            const targetOrder = findOrderByRef(getDb().orders, orderId);
            if (targetOrder && !canUserAccessShop(auth.user, targetOrder.shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "order", resourceId: orderId }, 403, { message: "Forbidden" });
              return;
            }
            getDb().orders = getDb().orders.filter((o) => String(o.id || "") !== orderId && String(o.shopOrderNo || "") !== orderId);
            if (getDb().orders.length === before) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "order", resourceId: orderId }, 404, { message: "Order not found" });
              return;
            }
        
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "order", resourceId: orderId }, 200, { message: "Order deleted" });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/orders/profit-issues" && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "read", resourceType: "order_profit" });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.read")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_profit" }, 403, { message: "Forbidden" });
              return;
            }
            const assignedShopIds = getUserAssignedShopIds(auth.user, getDb().shops || []);
            const orders = assignedShopIds === null
              ? (getDb().orders || [])
              : (assignedShopIds.length ? filterOrdersByAssignments(getDb().orders || [], assignedShopIds, getDb().shops || []) : []);
            const issues = [];
            for (const order of orders) {
              const amount = normalizeNullableNumber(order.amount);
              let reason = "";
              if (amount === null) reason = "missing_order_amount";
              else if (!findMatchingReviewRule(order, getDb().reviewRules || [])) reason = "missing_review_rule";
              else if (order.profitRmb === undefined && order.profitRub === undefined && !order.profitUpdatedAt) reason = "missing_profit_snapshot";
              if (reason) {
                const product = (getDb().onlineProducts || []).find((item) => String(item.id || "") === String(order.matchedOnlineProductId || ""));
                issues.push({
                  orderId: order.id,
                  shopOrderNo: order.shopOrderNo,
                  shopName: order.shopName,
                  reason,
                  matchedOnlineProductId: order.matchedOnlineProductId || "",
                  matchedOnlineProductName: order.matchedOnlineProductName || product?.name || "",
                  matchedRuleName: findMatchingReviewRule(order, getDb().reviewRules || [])?.name || "",
                  profitUpdatedAt: order.profitUpdatedAt || "",
                  updatedAt: order.updatedAt || ""
                });
              }
            }
            const byReason = issues.reduce((result, item) => {
              result[item.reason] = (result[item.reason] || 0) + 1;
              return result;
            }, {});
            const page = readPositiveIntParam(query.page, 1, 1, 100000);
            const pageSize = readPositiveIntParam(query.pageSize, 20, 1, 200);
            const start = (page - 1) * pageSize;
            respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_profit" }, 200, {
              items: issues.slice(start, start + pageSize),
              pagination: { page, pageSize, total: issues.length, totalPages: Math.max(1, Math.ceil(issues.length / pageSize)) },
              summary: { total: issues.length, byReason }
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/orders/") && pathname.endsWith("/profit-detail") && method === "GET",
      handler: async (req, res, query, auditBase, pathname, url) => {
            const parts = pathname.split("/");
            const orderRef = decodeURIComponent(parts[3] || "");
            const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "read", resourceType: "order_profit", resourceId: orderRef });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "order.read")) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_profit", resourceId: orderRef }, 403, { message: "Forbidden" });
              return;
            }
            const order = findOrderByRef(getDb().orders || [], orderRef);
            if (!order) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_profit", resourceId: orderRef }, 404, { message: "Order not found" });
              return;
            }
            if (!canUserAccessShop(auth.user, order.shopId, getDb().shops || [])) {
              respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_profit", resourceId: orderRef }, 403, { message: "Forbidden" });
              return;
            }
            respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "order_profit", resourceId: orderRef }, 200, {
              item: order
            });
            return;
      }
    },
  ];
}

module.exports = { createOrdersRoutes };
