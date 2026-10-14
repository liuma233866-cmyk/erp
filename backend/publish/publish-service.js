"use strict";
// 多平台刊登编排域。
//
// 从 server.js 拆出：Yandex 刊登（校验 → 质量门禁 → 建档/价格/库存三步）、
// Ozon 刊登（v3/product/import + 轮询）、卡片质量门禁评估。
// 依赖全部通过 createPublishService(deps) 注入，模块本身不直接访问 MySQL 或网络。
//
// 行为与原实现保持一致，唯一差别是注入点：
//   db            → getDb()
//   saveDatabase  → saveDatabase()
//   isSqlReady/getSqlPool → 同名注入函数
//   YANDEX_MARKET_BASE_URL → yandexMarketBaseUrl
//   console.error → logError

// 刊登前的卡片质量门槛：Yandex 官方建议把卡片质量保持在 80 分以上。
const PUBLISH_QUALITY_MIN_SCORE = 80;

// 老产品不能动：只有已经成功/部分刊登过的才算老产品，不再参与质量拦截。
// 其余全部按新刊登处理（包括从产品库复制过来的），刊登前先评估卡片质量分。
function isExistingPublishProduct(item) {
  const status = String(item?.lastPublishStatus || item?.publishStatus || "").trim().toLowerCase();
  return status === "success" || status === "partial";
}

function createPublishService(deps = {}) {
  const {
    getDb,
    saveDatabase = () => {},
    isSqlReady = () => false,
    getSqlPool = () => null,
    logError = (message) => console.error(message),
    normalizePublishSettings,
    validatePublishProductForYandex,
    expandPublishProductToYandexPayloads,
    resolvePublishTargetShopId,
    publishYandexProducts,
    publishOzonProducts,
    enrichYandexItemsWithParameterValues,
    fetchYandexOfferCards,
    readCardQualityByOffers,
    yandexMarketBaseUrl
  } = deps;

  if (typeof getDb !== "function") throw new TypeError("createPublishService requires getDb");

  // 刊登前评估本次要刊登的 SKU 的卡片质量分。优先实时拉取 Yandex，拉不到时回退到
  // 已存储的快照；既拉不到又没有快照的新品视为“无卡片可评估”，不拦截。
  async function evaluatePublishQualityGate(shop, offerIds, minScore = PUBLISH_QUALITY_MIN_SCORE) {
    const ids = Array.from(new Set((Array.isArray(offerIds) ? offerIds : []).map((value) => String(value || "").trim()).filter(Boolean)));
    if (!ids.length) {
      return { offerRatings: new Map(), blockedOfferIds: new Set(), evaluated: false, fetchFailed: false };
    }

    const offerRatings = new Map();
    let fetchFailed = false;
    try {
      for (let offset = 0; offset < ids.length; offset += 200) {
        const chunk = ids.slice(offset, offset + 200);
        const result = await fetchYandexOfferCards(String(shop?.businessId || ""), shop?.apiKey, { offerIds: chunk });
        if (!result.ok) throw new Error(result.message || "offer cards failed");
        for (const offer of Array.isArray(result.offers) ? result.offers : []) {
          const offerId = String(offer?.offerId || "").trim();
          const rating = Number(offer?.rating);
          if (offerId && Number.isFinite(rating)) offerRatings.set(offerId, rating);
        }
      }
    } catch (error) {
      fetchFailed = true;
    }

    if (fetchFailed && isSqlReady() && getSqlPool() && String(shop?.id || "").trim()) {
      try {
        const stored = await readCardQualityByOffers(getSqlPool(), String(shop.id || ""), ids);
        for (const row of Array.isArray(stored) ? stored : []) {
          const offerId = String(row?.offerId || "").trim();
          const rating = Number(row?.rating);
          if (offerId && Number.isFinite(rating)) offerRatings.set(offerId, rating);
        }
      } catch (storedError) {
        logError(`[quality-gate] stored card quality fallback failed: ${String(storedError)}`);
      }
    }

    const blockedOfferIds = new Set();
    for (const [offerId, rating] of offerRatings.entries()) {
      if (rating < minScore) blockedOfferIds.add(offerId);
    }
    return { offerRatings, blockedOfferIds, evaluated: true, fetchFailed };
  }

  async function executeProductPublish(actorUser, items, fallbackShopId, shops, options = {}) {
    const db = getDb();
    let sourceItems = Array.isArray(items) ? items.filter(Boolean) : [];
    for (const item of sourceItems) {
      if (String(item?.source || "") === "yandex_online_product" && !String(item?.description || "").trim()) {
        item.description = String(item?.title || item?.name || "").trim();
        item.updatedAt = new Date().toISOString();
      }
    }
    const enforceScope = options.enforceScope !== false;
    const publishSettings = normalizePublishSettings(db.publishSettings || {});
    const qualityMinScore = Number.isFinite(Number(publishSettings.qualityMinScore)) ? Number(publishSettings.qualityMinScore) : PUBLISH_QUALITY_MIN_SCORE;
    if (publishSettings.dailyPublishLimit > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const publishedToday = (db.publishProducts || []).filter((item) =>
        String(item?.lastPublishStatus || item?.publishStatus || "") === "success" &&
        String(item?.lastPublishAt || item?.publishAt || "").slice(0, 10) === today
      ).length;
      const remaining = Math.max(0, publishSettings.dailyPublishLimit - publishedToday);
      if (sourceItems.length > remaining) {
        return { statusCode: 429, payload: { message: `已达到每日刊登上限或本次数量超限：上限 ${publishSettings.dailyPublishLimit}，今日已刊登 ${publishedToday}，剩余 ${remaining}` } };
      }
    }
    const grouped = new Map();
    const shopResolveErrors = [];
    for (const item of sourceItems) {
      const resolvedShop = enforceScope
        ? resolvePublishTargetShopId(actorUser, item, fallbackShopId, shops)
        : resolvePublishTargetShopId(null, item, fallbackShopId, shops);
      if (!resolvedShop.ok) {
        shopResolveErrors.push({
          id: String(item?.id || "").trim(),
          sku: String(item?.sku || item?.vendorCode || "").trim(),
          title: String(item?.title || "").trim(),
          message: resolvedShop.message
        });
        continue;
      }
      item.shopId = resolvedShop.shopId;
      if (!grouped.has(resolvedShop.shopId)) grouped.set(resolvedShop.shopId, []);
      grouped.get(resolvedShop.shopId).push(item);
    }
    if (shopResolveErrors.length) {
      const statusCode = shopResolveErrors.some((entry) => entry.message.startsWith("Forbidden")) ? 403 : 400;
      const summary = shopResolveErrors
        .slice(0, 3)
        .map((entry) => `${entry.sku || entry.id || "Unnamed item"}: ${entry.message}`)
        .join(" | ");
      return {
        statusCode,
        payload: {
          message: `Publish failed: ${summary || "请选择店铺（shopId）"}`,
          errors: shopResolveErrors
        }
      };
    }

    const publishValidationErrors = sourceItems
      .map((item) => ({
        id: String(item?.id || "").trim(),
        sku: String(item?.sku || item?.vendorCode || "").trim(),
        title: String(item?.title || "").trim(),
        validation: validatePublishProductForYandex(item, { requirePositiveStock: false })
      }))
      .filter((entry) => !entry.validation.ok)
      .map((entry) => ({
        id: entry.id,
        sku: entry.sku,
        title: entry.title,
        missingFields: entry.validation.missingFields,
        invalidFields: entry.validation.invalidFields,
        variantErrors: entry.validation.errors || [],
        message: entry.validation.message
      }));
    if (publishValidationErrors.length) {
      const summary = publishValidationErrors
        .slice(0, 3)
        .map((entry) => `${entry.sku || entry.id || "Unnamed item"}: ${entry.message}`)
        .join(" | ");
      return {
        statusCode: 400,
        payload: {
          message: `Publish failed: ${summary}`,
          errors: publishValidationErrors
        }
      };
    }

    const rows = [];
    const errors = [];
    let success = 0;
    let failed = 0;
    for (const [shopId, groupedItems] of grouped.entries()) {
      const shop = (shops || []).find((x) => String(x.id || "") === shopId);
      if (!shop || shop.provider !== "yandex_market") {
        failed += groupedItems.length;
        const message = "店铺不存在或不是Yandex店铺";
        rows.push({ shopId, success: 0, failed: groupedItems.length, message });
        errors.push({ shopId, message });
        continue;
      }
      if (!shop.businessId || !shop.apiKey) {
        failed += groupedItems.length;
        const message = "缺少businessId或apiKey";
        rows.push({ shopId, success: 0, failed: groupedItems.length, message });
        errors.push({ shopId, message });
        continue;
      }
      const mapped = groupedItems.flatMap((item) => expandPublishProductToYandexPayloads(item));
      if (!mapped.length) {
        failed += groupedItems.length;
        const message = "缺少有效的SKU或标题";
        rows.push({ shopId, success: 0, failed: groupedItems.length, message });
        errors.push({ shopId, message });
        continue;
      }
      const newItems = groupedItems.filter((item) => !isExistingPublishProduct(item));
      const newMapped = newItems.flatMap((item) => expandPublishProductToYandexPayloads(item));
      const publishOfferIds = newMapped.map((entry) => String(entry.offerId || "").trim()).filter(Boolean);
      const qualityGate = publishSettings.qualityGateEnabled && newMapped.length
        ? await evaluatePublishQualityGate(shop, publishOfferIds, qualityMinScore)
        : { offerRatings: new Map(), blockedOfferIds: new Set(), evaluated: false, fetchFailed: false };
      const allowedMapped = groupedItems.flatMap((item) => {
        const itemMapped = expandPublishProductToYandexPayloads(item);
        return isExistingPublishProduct(item)
          ? itemMapped
          : itemMapped.filter((entry) => !qualityGate.blockedOfferIds.has(String(entry.offerId || "").trim()));
      });
      if (qualityGate.blockedOfferIds.size) {
        errors.push({
          shopId,
          message: `卡片质量分低于 ${qualityMinScore}，已拦截刊登`,
          stage: "quality",
          details: Array.from(qualityGate.blockedOfferIds).map((offerId) => ({
            offerId,
            rating: qualityGate.offerRatings.get(offerId)
          }))
        });
      } else if (qualityGate.fetchFailed && qualityGate.offerRatings.size === 0) {
        errors.push({
          shopId,
          message: "无法评估卡片质量（Yandex 拉取失败且无历史快照），本次未做质量拦截",
          stage: "quality"
        });
      }
      if (!allowedMapped.length) {
        failed += groupedItems.length;
        const nowIso = new Date().toISOString();
        for (const item of groupedItems) {
          item.lastPublishAt = nowIso;
          item.lastPublishStatus = "failed";
          item.publishAt = nowIso;
          item.publishStatus = "failed";
          item.publishResultMessage = `卡片质量分低于 ${qualityMinScore}，未刊登`;
          item.updatedAt = nowIso;
        }
        rows.push({ shopId, success: 0, failed: groupedItems.length, message: `卡片质量分低于 ${qualityMinScore}，全部拦截` });
        continue;
      }
      if (publishSettings.simulateBackendPublishToYandex) {
        const sequentialErrors = [];
        let sequentialSuccess = 0;
        let sequentialFailed = 0;
        for (const item of groupedItems) {
          if (sequentialSuccess + sequentialFailed > 0 && publishSettings.publishIntervalSeconds > 0) {
            await new Promise((resolve) => setTimeout(resolve, publishSettings.publishIntervalSeconds * 1000));
          }
          const itemMappedAll = expandPublishProductToYandexPayloads(item);
          const itemMapped = isExistingPublishProduct(item)
            ? itemMappedAll
            : itemMappedAll.filter((entry) => !qualityGate.blockedOfferIds.has(String(entry.offerId || "").trim()));
          if (itemMappedAll.length && !itemMapped.length) {
            sequentialFailed += 1;
            const nowIso = new Date().toISOString();
            item.lastPublishAt = nowIso;
            item.lastPublishStatus = "failed";
            item.publishAt = nowIso;
            item.publishStatus = "failed";
            item.publishResultMessage = `卡片质量分低于 ${qualityMinScore}，未刊登`;
            item.updatedAt = nowIso;
            sequentialErrors.push({
              shopId,
              message: `${String(item.sku || item.id || "Unnamed item")}: 卡片质量分低于 ${qualityMinScore}，未刊登`,
              stage: "quality"
            });
            continue;
          }
          if (!itemMapped.length) {
            sequentialFailed += 1;
            item.lastPublishAt = new Date().toISOString();
            item.lastPublishStatus = "failed";
            item.publishAt = item.lastPublishAt;
            item.publishStatus = "failed";
            item.publishResultMessage = "缺少有效的SKU或标题";
            item.updatedAt = item.lastPublishAt;
            sequentialErrors.push({
              shopId,
              message: `${String(item.sku || item.id || "Unnamed item")}: 缺少有效的SKU或标题`
            });
            continue;
          }
          const yandexPublishResult = await publishYandexProducts({
            shop,
            products: itemMapped,
            apiBase: yandexMarketBaseUrl,
            enrichProducts: enrichYandexItemsWithParameterValues
          });
          const mappingResult = yandexPublishResult.mapping;
          if (!mappingResult.ok) {
            sequentialFailed += itemMapped.length;
            item.lastPublishAt = new Date().toISOString();
            item.lastPublishStatus = "failed";
            item.publishAt = item.lastPublishAt;
            item.publishStatus = "failed";
            item.publishResultMessage = mappingResult.message || "发布失败";
            item.updatedAt = item.lastPublishAt;
            sequentialErrors.push({
              shopId,
              message: `${String(item.sku || item.id || "Unnamed item")}: ${mappingResult.message || "发布失败"}`,
              stage: "mapping",
              details: mappingResult.failed || []
            });
            continue;
          }
          const priceResult = yandexPublishResult.price;
          const stockResult = yandexPublishResult.stock;
          const failedOfferIds = new Set([
            ...(Array.isArray(mappingResult.failed) ? mappingResult.failed.map((x) => String(x.offerId || "").trim()) : []),
            ...(Array.isArray(priceResult.failed) ? priceResult.failed.map((x) => String(x.offerId || "").trim()) : []),
            ...(Array.isArray(stockResult.failed) ? stockResult.failed.map((x) => String(x.offerId || "").trim()) : [])
          ].filter(Boolean));
          const itemFailed = failedOfferIds.size;
          const itemSuccess = Math.max(0, itemMapped.length - itemFailed);
          const nowIso = new Date().toISOString();
          item.lastPublishAt = nowIso;
          item.updatedAt = nowIso;
          item.lastPublishStatus = itemFailed === 0 ? "success" : itemSuccess > 0 ? "partial" : "failed";
          item.publishAt = nowIso;
          item.publishStatus = item.lastPublishStatus;
          item.publishResultMessage = itemFailed === 0 ? "发布成功" : itemSuccess > 0 ? "部分成功" : "发布失败";
          sequentialSuccess += itemSuccess;
          sequentialFailed += itemFailed;
          if (!priceResult.ok || !stockResult.ok || itemFailed > 0) {
            const stageMessages = [];
            if (!priceResult.ok) stageMessages.push(`price: ${priceResult.message || "price update failed"}`);
            if (!stockResult.ok) stageMessages.push(`stock: ${stockResult.message || "stock update failed"}`);
            sequentialErrors.push({
              shopId,
              message: `${String(item.sku || item.id || "Unnamed item")}: ${stageMessages.join(" | ") || "部分发布失败"}`,
              details: { failedOffers: Array.from(failedOfferIds) }
            });
          }
        }
        success += sequentialSuccess;
        failed += sequentialFailed;
        rows.push({
          shopId,
          success: sequentialSuccess,
          failed: sequentialFailed,
          message: sequentialErrors.length ? "已按手动上架风格逐条调用 Yandex API，存在部分失败" : "已按手动上架风格逐条调用 Yandex API",
          details: {
            simulation: true,
            mode: "sequential_api",
            itemCount: groupedItems.length,
            offerCount: allowedMapped.length
          }
        });
        if (sequentialErrors.length) {
          errors.push(...sequentialErrors);
        }
        continue;
      }
      const yandexPublishResult = await publishYandexProducts({
        shop,
        products: allowedMapped,
        apiBase: yandexMarketBaseUrl,
        enrichProducts: enrichYandexItemsWithParameterValues
      });
      const mappingResult = yandexPublishResult.mapping;
      if (!mappingResult.ok) {
        failed += allowedMapped.length;
        const message = mappingResult.message || "发布失败";
        rows.push({ shopId, success: 0, failed: allowedMapped.length, message });
        errors.push({ shopId, message, stage: "mapping", details: mappingResult.failed || [] });
        continue;
      }
      const priceResult = yandexPublishResult.price;
      const stockResult = yandexPublishResult.stock;
      const failedOfferIds = new Set([
        ...(Array.isArray(mappingResult.failed) ? mappingResult.failed.map((x) => String(x.offerId || "").trim()) : []),
        ...(Array.isArray(priceResult.failed) ? priceResult.failed.map((x) => String(x.offerId || "").trim()) : []),
        ...(Array.isArray(stockResult.failed) ? stockResult.failed.map((x) => String(x.offerId || "").trim()) : [])
      ].filter(Boolean));
      const shopFailed = failedOfferIds.size;
      const shopSuccess = Math.max(0, allowedMapped.length - shopFailed);
      const stageMessages = [];
      if (!priceResult.ok) stageMessages.push(`price: ${priceResult.message || "price update failed"}`);
      if (!stockResult.ok) stageMessages.push(`stock: ${stockResult.message || "stock update failed"}`);
      const nowIso = new Date().toISOString();
      const message = stageMessages.length ? `部分失败: ${stageMessages.join(" | ")}` : "发布成功";
      for (const item of groupedItems) {
        const itemOfferIds = expandPublishProductToYandexPayloads(item).map((entry) => String(entry.offerId || "").trim()).filter(Boolean);
        const itemFailed = itemOfferIds.some((offerId) => failedOfferIds.has(offerId));
        const itemSuccess = itemOfferIds.length > 0 && itemOfferIds.every((offerId) => !failedOfferIds.has(offerId));
        const qualityBlockedCount = isExistingPublishProduct(item)
          ? 0
          : itemOfferIds.filter((offerId) => qualityGate.blockedOfferIds.has(offerId)).length;
        item.lastPublishAt = nowIso;
        item.lastPublishStatus = itemSuccess ? "success" : itemFailed ? "partial" : "failed";
        item.publishAt = nowIso;
        item.publishStatus = item.lastPublishStatus;
        item.publishResultMessage = itemSuccess ? "发布成功" : itemFailed ? message : "发布失败";
        if (qualityBlockedCount > 0) {
          const qualityMessage = `卡片质量分低于 ${qualityMinScore}，未刊登（拦截 ${qualityBlockedCount} 个SKU）`;
          item.publishResultMessage = itemSuccess ? qualityMessage : `${item.publishResultMessage}；${qualityMessage}`;
          if (qualityBlockedCount === itemOfferIds.length) {
            item.lastPublishStatus = "failed";
            item.publishStatus = "failed";
            item.publishResultMessage = qualityMessage;
          } else if (!itemFailed) {
            item.lastPublishStatus = "partial";
            item.publishStatus = "partial";
          }
        }
        item.updatedAt = nowIso;
      }
      success += shopSuccess;
      failed += shopFailed;
      rows.push({
        shopId,
        success: shopSuccess,
        failed: shopFailed,
        message,
        details: {
          mapping: { ok: mappingResult.ok, success: mappingResult.success || 0, failed: mappingResult.failed || [] },
          price: { ok: priceResult.ok, success: priceResult.success || 0, failed: priceResult.failed || [], message: priceResult.message || "" },
          stock: { ok: stockResult.ok, success: stockResult.success || 0, failed: stockResult.failed || [], message: stockResult.message || "" }
        }
      });
      if (stageMessages.length || shopFailed > 0) {
        errors.push({ shopId, message, details: { failedOffers: Array.from(failedOfferIds) } });
      }
    }
    saveDatabase();
    return {
      statusCode: 200,
      payload: {
        success,
        failed,
        results: rows,
        errors
      }
    };
  }

  async function executeOzonProductPublish(actorUser, items, fallbackShopId, shops) {
    const grouped = new Map();
    const errors = [];
    for (const item of Array.isArray(items) ? items : []) {
      const resolved = resolvePublishTargetShopId(actorUser, item, fallbackShopId, shops);
      const shop = resolved.ok ? (shops || []).find((entry) => String(entry?.id || "") === resolved.shopId) : null;
      if (!resolved.ok || !shop || String(shop.provider || "").toLowerCase() !== "ozon") {
        errors.push({ id: item.id, sku: item.sku || "", message: resolved.message || "缺少有效的 Ozon 店铺" });
        continue;
      }
      item.shopId = resolved.shopId;
      if (!grouped.has(resolved.shopId)) grouped.set(resolved.shopId, []);
      grouped.get(resolved.shopId).push(item);
    }
    let success = 0;
    let processing = 0;
    let failed = errors.length;
    const results = [];
    for (const [shopId, groupedItems] of grouped.entries()) {
      const shop = (shops || []).find((entry) => String(entry?.id || "") === shopId);
      const result = await publishOzonProducts(shop, groupedItems);
      const now = new Date().toISOString();
      if (!result.ok) {
        failed += groupedItems.length;
        groupedItems.forEach((item) => {
          item.ozonPublishStatus = "failed";
          item.ozonErrorMessage = result.message || "Ozon 发布失败";
          item.publishStatus = "failed";
          item.lastPublishStatus = "failed";
          item.lastPublishAt = now;
          item.publishAt = now;
          item.publishResultMessage = item.ozonErrorMessage;
          item.updatedAt = now;
        });
        results.push({ shopId, success: 0, processing: 0, failed: groupedItems.length, message: result.message, details: result.invalid || [] });
        continue;
      }
      const byOfferId = new Map((result.items || []).map((entry) => [String(entry.offer_id || entry.offerId || "").trim(), entry]));
      let shopSuccess = 0;
      let shopProcessing = 0;
      groupedItems.forEach((item) => {
        const detail = byOfferId.get(String(item.sku || item.offerId || item.vendorCode || "").trim());
        const detailStatus = String(detail?.status || detail?.state || "").toLowerCase();
        const itemFailed = ["failed", "error", "cancelled"].includes(detailStatus) || Boolean(detail?.errors?.length);
        const itemDone = ["imported", "success", "completed"].includes(detailStatus);
        const itemStatus = itemFailed ? "failed" : itemDone ? "success" : "processing";
        item.ozonPublishStatus = itemStatus;
        item.ozonTaskId = result.taskId;
        item.ozonProductId = detail?.product_id || detail?.productId || item.ozonProductId || "";
        item.ozonPlatformSku = detail?.offer_id || detail?.offerId || item.ozonPlatformSku || "";
        item.ozonErrorMessage = itemFailed ? (detail?.errors?.[0]?.message || detail?.error || "Ozon 发布失败") : "";
        item.publishStatus = itemStatus;
        item.lastPublishStatus = itemStatus;
        item.lastPublishAt = now;
        item.publishAt = now;
        item.publishResultMessage = itemFailed ? item.ozonErrorMessage : itemDone ? "Ozon 发布成功" : "Ozon 任务处理中";
        item.updatedAt = now;
        if (itemFailed) failed += 1;
        else if (itemDone) { success += 1; shopSuccess += 1; }
        else { processing += 1; shopProcessing += 1; }
      });
      results.push({ shopId, taskId: result.taskId, success: shopSuccess, processing: shopProcessing, failed: groupedItems.length - shopSuccess - shopProcessing, timedOut: result.timedOut });
    }
    results.push(...errors.map((entry) => ({ ...entry, failed: 1 })));
    saveDatabase();
    return { statusCode: 200, payload: { success, processing, failed, results } };
  }

  return {
    executeProductPublish,
    executeOzonProductPublish,
    evaluatePublishQualityGate,
    isExistingPublishProduct,
    PUBLISH_QUALITY_MIN_SCORE
  };
}

module.exports = {
  PUBLISH_QUALITY_MIN_SCORE,
  createPublishService,
  isExistingPublishProduct
};
