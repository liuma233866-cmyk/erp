const MISSING_SOURCE_IMAGE = "missing_source_image";

function taskSkuEntries(item) {
  if (Array.isArray(item?.variants) && item.variants.length) {
    return item.variants.map((variant) => ({
      sku: String(variant?.sku || "").trim(),
      variantSku: String(variant?.sku || "").trim(),
      imageUrl: String(variant?.imageUrl || variant?.images?.[0] || item?.imageUrl || "").trim()
    }));
  }
  return [{
    sku: String(item?.platformSku || item?.sku || "").trim(),
    variantSku: "",
    imageUrl: String(item?.imageUrl || "").trim()
  }];
}

async function createCopyAiImageTasks({ items, companyId, defaultPrompt, buildTaskCode, createSystemTask, concurrency = 4, aiMode = "all" }) {
  const aiTasks = [];
  const jobs = [];
  const failures = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const entries = taskSkuEntries(item).filter((entry) => entry.sku);
    if (aiMode === "none") {
      item.aiImageStatus = "skipped";
      continue;
    }
    const selectedEntries = aiMode === "main" ? entries.slice(0, 1) : entries;
    if (!item.aiTaskIdsBySku || typeof item.aiTaskIdsBySku !== "object") item.aiTaskIdsBySku = {};
    if (entries.length === 1 && item.aiTaskId && !item.aiTaskIdsBySku[entries[0].sku]) item.aiTaskIdsBySku[entries[0].sku] = item.aiTaskId;
    for (const entry of selectedEntries) {
      const recorded = item.aiTaskIdsBySku[entry.sku];
      if (recorded && recorded !== MISSING_SOURCE_IMAGE) continue;
      if (!entry.imageUrl) {
        item.aiTaskIdsBySku[entry.sku] = MISSING_SOURCE_IMAGE;
        item.aiImageStatus = MISSING_SOURCE_IMAGE;
        continue;
      }
      jobs.push({ item, entry });
    }
  }

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < jobs.length) {
      const { item, entry } = jobs[nextIndex++];
      const taskCode = buildTaskCode({ ...item, sku: entry.sku, sourceProductId: `${item.sourceOnlineProductId || item.id}:${entry.sku}` });
      try {
        const taskResult = await createSystemTask({
          companyId,
          taskCode,
          sourceType: "product",
          sourceId: item.id,
          productId: item.id,
          sourceImageUrl: entry.imageUrl,
          prompt: defaultPrompt,
          metadataJson: JSON.stringify({
            sourcePlatform: String(item.publishPlatform || "yandex").trim().toLowerCase() || "yandex",
            shopId: item.shopId,
            sourceProductId: item.sourceOnlineProductId,
            sourceSku: item.sourceSku,
            systemSku: item.systemSku || item.sku,
            platformSku: entry.sku,
            variantSku: entry.variantSku,
            taskCode
          })
        });
        if (!taskResult?.ok) throw new Error(String(taskResult?.message || "AI 图片任务创建失败"));
        item.aiTaskIdsBySku[entry.sku] = taskResult.item.id;
        if (!item.aiTaskId) item.aiTaskId = taskResult.item.id;
        if (!item.aiTaskCode) item.aiTaskCode = taskCode;
        item.aiImageStatus = "queued";
        aiTasks.push(taskResult.item.id);
      } catch (error) {
        failures.set(item, String(error?.message || error || "AI 图片任务创建失败"));
      }
    }
  }

  const workerCount = Math.min(jobs.length, Math.max(1, Number(concurrency) || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  for (const item of Array.isArray(items) ? items : []) {
    item.aiTaskIds = Object.values(item.aiTaskIdsBySku || {}).filter((id) => id && id !== MISSING_SOURCE_IMAGE);
    if (failures.has(item)) {
      item.aiImageStatus = "failed";
      item.aiImageError = failures.get(item);
    } else if (item.aiImageStatus === "queued") {
      item.aiImageError = "";
    }
  }
  return { aiTasks };
}

module.exports = { MISSING_SOURCE_IMAGE, createCopyAiImageTasks };
