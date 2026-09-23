// 从 server.js 拆出的路由注册表（shops 域）。

function createShopsRoutes(deps) {
  const { authService, respondApi, getDb, parseJsonBody, maskSensitive, saveDatabase, makeId, ROLE_ADMIN, normalizeCompanyName, normalizeCompanyId, sameCompanyEntity, normalizePartnerTokenInput, fetchYandexCampaign, encryptSecret, normalizeShopCurrency, sqlWriters, normalizeOrderWorkspace, getShopOrderWorkspace, crypto, paginateItems } = deps;
  return [
    {
      matches: (pathname, method) => pathname === "/api/shops" && method === "GET",
      handler: async (req, res, query, auditBase, pathname) => {
            const auth = authService.requireAuth(req, res, { ...auditBase, resourceType: "shop", actionType: "read" });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "shop.read")) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "read" }, 403, { message: "Forbidden" });
              return;
            }
        
            const companyName = normalizeCompanyName(auth.user.companyName || "");
            const rawItems = auth.user.role === ROLE_ADMIN
              ? getDb().shops || []
              : (getDb().shops || []).filter((shop) => sameCompanyEntity(shop, auth.user));
            // Group shared Yandex credentials only within the caller's visible set, so
            // credential group counts never leak other tenants' shops.
            const yandexGroups = new Map();
            for (const shop of rawItems) {
              if (String(shop?.provider || "").toLowerCase() !== "yandex_market") continue;
              const businessId = String(shop?.businessId || "").trim();
              const apiKey = String(shop?.apiKey || "").trim();
              if (!businessId || !apiKey) continue;
              const credentialKey = `${businessId}::${crypto.createHash("sha256").update(apiKey).digest("hex")}`;
              if (!yandexGroups.has(credentialKey)) yandexGroups.set(credentialKey, []);
              yandexGroups.get(credentialKey).push(shop);
            }
            const safeItems = rawItems.map((shop) => {
              const { apiKey, apiKeyEncrypted, ...rest } = shop || {};
              const businessId = String(shop?.businessId || "").trim();
              const plainApiKey = String(shop?.apiKey || "").trim();
              const credentialKey = businessId && plainApiKey
                ? `${businessId}::${crypto.createHash("sha256").update(plainApiKey).digest("hex")}`
                : "";
              const group = yandexGroups.get(credentialKey) || [];
              const orderedGroup = [...group].sort((a, b) => String(a.createdAt || a.id || "").localeCompare(String(b.createdAt || b.id || "")));
              const owner = orderedGroup[0] || null;
              return {
                ...rest,
                orderWorkspace: getShopOrderWorkspace(shop, getDb().shopOrderWorkspaceOverrides),
                credentialGroupId: group.length > 1 ? `yandex-business-${String(shop.businessId || "")}` : "",
                credentialOwnerShopId: group.length > 1 ? String(owner?.id || "") : "",
                credentialOwnerName: group.length > 1 ? String(owner?.name || "") : "",
                sharedCredentialCount: group.length,
                usesSharedCredential: group.length > 1
              };
            });
            const paged = paginateItems(safeItems, query, 50);
            respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "read" }, 200, { items: paged.items, pagination: paged.pagination });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname === "/api/shops" && method === "POST",
      handler: async (req, res, query, auditBase, pathname) => {
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, resourceType: "shop", actionType: "create", requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "shop.create")) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "create", requestBodyMasked: maskSensitive(body) }, 403, { message: "Forbidden" });
              return;
            }
        
            const companyName = normalizeCompanyName(body.companyName || auth.user.companyName || "");
            const companyId = auth.user.role === ROLE_ADMIN
              ? normalizeCompanyId(body.companyId || "system") || "system"
              : normalizeCompanyId(auth.user.companyId || "");
            if (!companyName) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "create", requestBodyMasked: maskSensitive(body) }, 400, { message: "companyName is required" });
              return;
            }
            if (!companyId) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "create", requestBodyMasked: maskSensitive(body) }, 400, { message: "company is not initialized" });
              return;
            }
        
            const campaignId = String(body.campaignId || "").trim();
            const apiKey = normalizePartnerTokenInput(body.apiKey);
            const name = String(body.name || "").trim();
            const code = String(body.code || "").trim();
            let shop;
        
            if (campaignId || apiKey) {
              if (!campaignId || !/^\d+$/.test(campaignId)) {
                respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "create", requestBodyMasked: maskSensitive(body) }, 400, { message: "campaignId must be numeric" });
                return;
              }
              if (!apiKey) {
                respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "create", requestBodyMasked: maskSensitive(body) }, 400, { message: "apiKey is required" });
                return;
              }
        
              const campaignExists = (getDb().shops || []).some((s) => String(s.campaignId || "") === campaignId);
              if (campaignExists) {
                respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "create", requestBodyMasked: maskSensitive(body) }, 409, { message: "Campaign already added" });
                return;
              }
        
              const campaign = await fetchYandexCampaign(campaignId, apiKey);
              if (!campaign.ok) {
                respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "create", requestBodyMasked: maskSensitive(body) }, 502, { message: campaign.message || "Failed to fetch Yandex campaign" });
                return;
              }
        
              const campaignName = String(campaign.item.name || campaign.item.domain || `Campaign-${campaignId}`).trim();
              const businessId = campaign.item.businessId || campaign.item.business?.id || "";
              shop = {
                id: makeId("SHP"),
                name: campaignName,
                code: `ym-${campaignId}`,
                enabled: true,
                provider: "yandex_market",
                campaignId,
                apiKey,
                apiKeyEncrypted: encryptSecret(apiKey),
                businessId: businessId ? String(businessId) : "",
                shopCurrency: normalizeShopCurrency(body.shopCurrency),
                companyName,
                companyId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
              };
            } else {
              if (!name) {
                respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "create", requestBodyMasked: maskSensitive(body) }, 400, { message: "name is required" });
                return;
              }
        
              const nameExists = (getDb().shops || []).some((s) => String(s.name || "").toLowerCase() === name.toLowerCase() && normalizeCompanyName(s.companyName || "") === companyName);
              if (nameExists) {
                respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "create", requestBodyMasked: maskSensitive(body) }, 409, { message: "Shop name already exists" });
                return;
              }
        
                shop = {
                  id: makeId("SHP"),
                  name,
                  code: code || "",
                  enabled: true,
                  provider: "local",
                  shopCurrency: normalizeShopCurrency(body.shopCurrency),
                  companyName,
                  companyId,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString()
                };
            }
        
            if (!Array.isArray(getDb().shops)) getDb().shops = [];
            // Persist to SQL first: on failure the memory stays untouched and the
            // client gets a clean 500 instead of a phantom shop.
            try {
              await sqlWriters.saveShopToSql(shop);
            } catch (error) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "create", requestBodyMasked: maskSensitive(body) }, 500, { message: "Failed to save shop to database" });
              return;
            }
            getDb().shops.unshift(shop);
            getDb().shopOrderWorkspaceOverrides[shop.id] = normalizeOrderWorkspace(body.orderWorkspace);
            saveDatabase();
            const { apiKey: _apiKey, apiKeyEncrypted: _apiKeyEncrypted, ...safeShop } = shop;
            respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "create", resourceId: shop.id, requestBodyMasked: maskSensitive(body) }, 201, { item: safeShop });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.match(/^\/api\/shops\/([^/]+)$/) && method === "PUT",
      handler: async (req, res, query, auditBase, pathname) => {
        const editShopMatch = pathname.match(/^\/api\/shops\/([^/]+)$/);
            const shopId = decodeURIComponent(editShopMatch[1] || "");
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId, requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "shop.toggle")) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 403, { message: "Forbidden" });
              return;
            }
            const shop = (getDb().shops || []).find((item) => String(item.id || "") === shopId);
            if (!shop) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 404, { message: "Shop not found" });
              return;
            }
            if (auth.user.role !== ROLE_ADMIN && !sameCompanyEntity(shop, auth.user)) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 403, { message: "Cannot manage shops from another company" });
              return;
            }
        
            const provider = String(body.provider || shop.provider || "local").trim().toLowerCase();
            const name = String(body.name || shop.name || "").trim();
            const code = String(body.code ?? shop.code ?? "").trim();
            const campaignId = String(body.campaignId ?? shop.campaignId ?? "").trim();
            const providedApiKey = normalizePartnerTokenInput(body.apiKey);
            const effectiveApiKey = providedApiKey || String(shop.apiKey || "").trim();
            if (!name) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 400, { message: "name is required" });
              return;
            }
            if (provider === "yandex_market") {
              if (!campaignId || !/^\d+$/.test(campaignId)) {
                respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 400, { message: "campaignId must be numeric" });
                return;
              }
              if (!effectiveApiKey) {
                respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 400, { message: "apiKey is required" });
                return;
              }
              const duplicate = (getDb().shops || []).some((item) => item.id !== shopId && String(item.campaignId || "") === campaignId);
              if (duplicate) {
                respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 409, { message: "Campaign already added" });
                return;
              }
              if (campaignId !== String(shop.campaignId || "") || providedApiKey) {
                const campaign = await fetchYandexCampaign(campaignId, effectiveApiKey);
                if (!campaign.ok) {
                  respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 502, { message: campaign.message || "Failed to fetch Yandex campaign" });
                  return;
                }
                const businessId = campaign.item.businessId || campaign.item.business?.id || "";
                shop.businessId = businessId ? String(businessId) : String(shop.businessId || "");
              }
            }
        
            shop.name = name;
            shop.code = code;
            shop.provider = provider;
            shop.shopCurrency = normalizeShopCurrency(body.shopCurrency ?? shop.shopCurrency);
            shop.campaignId = provider === "local" ? "" : campaignId;
            if (providedApiKey) shop.apiKey = providedApiKey;
            shop.apiKeyEncrypted = shop.apiKey ? encryptSecret(shop.apiKey) : String(shop.apiKeyEncrypted || "");
            if (auth.user.role === ROLE_ADMIN && String(body.companyName || "").trim()) {
              shop.companyName = normalizeCompanyName(body.companyName);
            }
            const previousShop = { ...shop };
            const previousWorkspace = getDb().shopOrderWorkspaceOverrides[shopId];
            getDb().shopOrderWorkspaceOverrides[shopId] = normalizeOrderWorkspace(body.orderWorkspace || getDb().shopOrderWorkspaceOverrides[shopId]);
            shop.updatedAt = new Date().toISOString();
            try {
              await sqlWriters.saveShopToSql(shop);
            } catch (error) {
              // Roll back the in-memory mutation so a failed SQL write does not leave
              // a ghost change behind.
              Object.assign(shop, previousShop);
              if (previousWorkspace === undefined) delete getDb().shopOrderWorkspaceOverrides[shopId];
              else getDb().shopOrderWorkspaceOverrides[shopId] = previousWorkspace;
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 500, { message: "Failed to save shop to database" });
              return;
            }
            saveDatabase();
            const { apiKey: _apiKey, apiKeyEncrypted: _apiKeyEncrypted, ...safeShop } = shop;
            respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 200, {
              item: { ...safeShop, orderWorkspace: getShopOrderWorkspace(shop, getDb().shopOrderWorkspaceOverrides) }
            });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/shops/") && method === "DELETE" && !pathname.endsWith("/toggle"),
      handler: async (req, res, query, auditBase, pathname) => {
            const shopId = decodeURIComponent(pathname.split("/")[3] || "");
            const auth = authService.requireAuth(req, res, { ...auditBase, resourceType: "shop", actionType: "delete", resourceId: shopId });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "shop.delete")) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "delete", resourceId: shopId }, 403, { message: "Forbidden" });
              return;
            }
        
            const index = (getDb().shops || []).findIndex((s) => s.id === shopId);
            if (index < 0) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "delete", resourceId: shopId }, 404, { message: "Shop not found" });
              return;
            }
            if (auth.user.role !== ROLE_ADMIN && !sameCompanyEntity(getDb().shops[index], auth.user)) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "delete", resourceId: shopId }, 403, { message: "Cannot manage shops from another company" });
              return;
            }
        
            // Delete from SQL first; only touch memory after the deletion succeeded.
            try {
              await sqlWriters.deleteShopFromSql(shopId);
            } catch (error) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "delete", resourceId: shopId }, 500, { message: "Failed to delete shop from database" });
              return;
            }
            const removed = getDb().shops.splice(index, 1)[0];
            delete getDb().shopOrderWorkspaceOverrides[shopId];
            saveDatabase();
            const { apiKey: _apiKey, apiKeyEncrypted: _apiKeyEncrypted, ...safeShop } = removed || {};
            respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "delete", resourceId: shopId }, 200, { item: safeShop });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/shops/") && pathname.endsWith("/toggle") && method === "PUT",
      handler: async (req, res, query, auditBase, pathname) => {
            const shopId = decodeURIComponent(pathname.split("/")[3] || "");
            const auth = authService.requireAuth(req, res, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "shop.toggle")) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 403, { message: "Forbidden" });
              return;
            }
        
            const index = (getDb().shops || []).findIndex((s) => s.id === shopId);
            if (index < 0) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 404, { message: "Shop not found" });
              return;
            }
            if (auth.user.role !== ROLE_ADMIN && !sameCompanyEntity(getDb().shops[index], auth.user)) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 403, { message: "Cannot manage shops from another company" });
              return;
            }
        
            getDb().shops[index].enabled = !Boolean(getDb().shops[index].enabled);
            getDb().shops[index].updatedAt = new Date().toISOString();
            try {
              await sqlWriters.saveShopToSql(getDb().shops[index]);
            } catch (error) {
              getDb().shops[index].enabled = !Boolean(getDb().shops[index].enabled);
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 500, { message: "Failed to save shop to database" });
              return;
            }
            saveDatabase();
            const { apiKey: _apiKey, apiKeyEncrypted: _apiKeyEncrypted, ...safeShop } = getDb().shops[index];
            respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 200, { item: safeShop });
            return;
      }
    },
    {
      matches: (pathname, method) => pathname.startsWith("/api/shops/") && pathname.endsWith("/order-workspace") && method === "PUT",
      handler: async (req, res, query, auditBase, pathname) => {
            const shopId = decodeURIComponent(pathname.split("/")[3] || "");
            const body = await parseJsonBody(req);
            const auth = authService.requireAuth(req, res, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId, requestBodyMasked: maskSensitive(body) });
            if (!auth.ok) return;
            if (!authService.checkPermission(auth.user, "shop.toggle")) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 403, { message: "Forbidden" });
              return;
            }
            const shop = (getDb().shops || []).find((item) => String(item.id || "") === shopId);
            if (!shop) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 404, { message: "Shop not found" });
              return;
            }
            if (auth.user.role !== ROLE_ADMIN && !sameCompanyEntity(shop, auth.user)) {
              respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 403, { message: "Cannot manage shops from another company" });
              return;
            }
            const orderWorkspace = normalizeOrderWorkspace(body.orderWorkspace);
            getDb().shopOrderWorkspaceOverrides[shopId] = orderWorkspace;
            shop.updatedAt = new Date().toISOString();
            saveDatabase();
            respondApi(req, res, auth.user, { ...auditBase, resourceType: "shop", actionType: "update", resourceId: shopId }, 200, {
              item: { id: shopId, orderWorkspace }
            });
            return;
      }
    },
  ];
}

module.exports = { createShopsRoutes };
