(function attachYandexPublishPanel(global) {
  let publishing = false;

  function isYandexProduct(item, getProvider) {
    const provider = String(getProvider(item) || "").toLowerCase();
    const platform = String(item?.publishPlatform || "").toLowerCase();
    return provider === "yandex_market" || provider === "yandex" || platform === "yandex";
  }

  const MAX_REPORTED_ERRORS = 5;

  // Turns the per-item failure detail into something readable. Without this the user
  // only learns "发布失败" and never which offer or field Yandex objected to.
  function describeFailures(payload) {
    const data = payload && typeof payload === "object" ? payload : {};
    const lines = [];

    for (const entry of Array.isArray(data.errors) ? data.errors : []) {
      if (!entry) continue;
      const stage = String(entry.stage || "").trim();
      const message = String(entry.message || "").trim();
      if (message) lines.push(stage ? `[${stage}] ${message}` : message);

      const details = entry.details;
      if (Array.isArray(details)) {
        for (const detail of details) {
          const offerId = String(detail?.offerId || detail?.id || "").trim();
          const detailMessage = String(detail?.message || "").trim();
          if (detailMessage) lines.push(offerId ? `· ${offerId}: ${detailMessage}` : `· ${detailMessage}`);
        }
      } else if (Array.isArray(details?.failedOffers)) {
        const offers = details.failedOffers.map((value) => String(value || "").trim()).filter(Boolean);
        if (offers.length) lines.push(`· 失败 SKU：${offers.slice(0, 10).join(", ")}`);
      }
    }

    return lines;
  }

  function notifyFailures(context, payload, fallbackMessage) {
    const lines = describeFailures(payload);
    if (!lines.length) {
      context.notify("error", fallbackMessage);
      return;
    }
    const shown = lines.slice(0, MAX_REPORTED_ERRORS);
    const rest = lines.length - shown.length;
    context.notify(
      "error",
      `${fallbackMessage}：${shown.join(" ｜ ")}${rest > 0 ? ` ｜ 另有 ${rest} 条` : ""}`
    );
  }

  async function publish(context) {
    if (publishing) {
      context.notify("error", "已有 Yandex 产品正在发布，请勿重复提交");
      return;
    }
    const selectedIds = Array.isArray(context?.selectedIds) ? context.selectedIds.map(String) : [];
    if (!selectedIds.length) {
      context.notify("error", "请先选择要发布的 Yandex 产品");
      return;
    }
    const publishableIds = new Set(
      (context.getItems?.() || [])
        .filter((item) => isYandexProduct(item, context.getProvider))
        .map((item) => String(item?.id || "").trim())
        .filter(Boolean)
    );
    const ids = selectedIds.filter((id) => publishableIds.has(id));
    if (!ids.length) {
      context.notify("error", "当前页签没有可发布的 Yandex 产品");
      return;
    }

    const selectedItems = (context.getItems?.() || []).filter((item) => ids.includes(String(item?.id || "")));
    const duplicate = selectedItems.find((item) => {
      const status = String(item?.publishStatus || item?.lastPublishStatus || "").toLowerCase();
      return status === "pending" || status === "success";
    });
    if (duplicate) {
      const status = String(duplicate.publishStatus || duplicate.lastPublishStatus || "").toLowerCase();
      context.notify("error", `${duplicate.platformSku || duplicate.sku || duplicate.id} ${status === "success" ? "已经发布成功，禁止重复发布" : "正在发布中，请勿重复提交"}`);
      return;
    }

    publishing = true;
    context.markPublishing?.(ids);
    const result = await context.apiRequest("/api/yandex/publish", {
      method: "POST",
      body: JSON.stringify({ ids, shopId: String(context.shopId || "").trim() })
    });
    publishing = false;
    if (!result.ok) {
      notifyFailures(context, result.data, result.error || "Yandex 发布失败");
      await context.reload();
      return;
    }
    const summary = result.data || {};
    const failed = Number(summary.failed || 0);
    if (failed > 0) {
      // Still a 200, but some offers failed: surface why instead of only the counts.
      const detailLines = describeFailures(summary);
      const shown = detailLines.slice(0, MAX_REPORTED_ERRORS);
      const rest = detailLines.length - shown.length;
      context.notify(
        "warning",
        `Yandex 发布完成：成功 ${Number(summary.success || 0)} 条，处理中 ${Number(summary.processing || 0)} 条，失败 ${failed} 条` +
          (shown.length ? ` ｜ ${shown.join(" ｜ ")}${rest > 0 ? ` ｜ 另有 ${rest} 条` : ""}` : "")
      );
      await context.reload();
      return;
    }
    context.notify(
      "success",
      `Yandex 发布完成：成功 ${Number(summary.success || 0)} 条，处理中 ${Number(summary.processing || 0)} 条，失败 0 条`
    );
    await context.reload();
  }

  global.YandexPublishPanel = { publish, describeFailures };
})(window);
