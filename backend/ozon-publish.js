const OZON_API_BASE = "https://api-seller.ozon.ru";
const { withFetchTimeout } = require("./http-timeout");

function numberValue(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeOzonAttributes(item) {
  const raw = item?.ozonAttributes || item?.attributes || [];
  if (Array.isArray(raw)) return raw.filter((entry) => entry && typeof entry === "object");
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw)
    .map(([id, value]) => ({
      complex_id: 0,
      id: Number(id) || 0,
      values: [{ value: String(value || "").trim() }]
    }))
    .filter((entry) => entry.id > 0 && entry.values[0].value);
}

function normalizeOzonProduct(item) {
  const source = item && typeof item === "object" ? item : {};
  const images = [...new Set([
    ...(Array.isArray(source.images) ? source.images : []),
    ...(Array.isArray(source.pictures) ? source.pictures : []),
    source.imageUrl,
    source.mainImage
  ].map((value) => String(value || "").trim()).filter((value) => /^https?:\/\//i.test(value)))].slice(0, 15);
  const length = numberValue(source.packageLengthCm ?? source.lengthCm ?? source.length, 1);
  const width = numberValue(source.packageWidthCm ?? source.widthCm ?? source.width, 1);
  const height = numberValue(source.packageHeightCm ?? source.heightCm ?? source.height, 1);
  const weightKg = numberValue(source.weightKg ?? source.weight, 0.01);
  const categoryId = numberValue(source.ozonCategoryId ?? source.categoryId ?? source.typeId, 0);
  const barcode = String(source.barcode || source.barcodes?.[0] || source.sku || source.vendorCode || "").trim();
  return {
    attributes: normalizeOzonAttributes(source),
    barcode,
    description_category_id: categoryId,
    new_description_category_id: categoryId,
    currency_code: String(source.currencyCode || source.currency || "RUB").trim().toUpperCase() || "RUB",
    depth: Math.max(1, Math.round(length * 10)),
    width: Math.max(1, Math.round(width * 10)),
    height: Math.max(1, Math.round(height * 10)),
    dimension_unit: "mm",
    weight: Math.max(1, Math.round(weightKg * 1000)),
    weight_unit: "g",
    images,
    primary_image: images[0] || "",
    name: String(source.title || source.name || source.productTitle || "").trim(),
    offer_id: String(source.sku || source.offerId || source.vendorCode || source.platformSku || "").trim(),
    old_price: String(numberValue(source.originalPrice ?? source.oldPrice, 0) || ""),
    price: String(numberValue(source.salePrice ?? source.price ?? source.sellingPrice, 0) || ""),
    vat: String(source.vat ?? source.vatRate ?? "").trim() || "0.20",
    _sourceId: String(source.id || "").trim()
  };
}

function validateOzonProduct(item) {
  const missing = [];
  if (!item.offer_id) missing.push("sku/offer_id");
  if (!item.name) missing.push("title/name");
  if (!(Number(item.description_category_id) > 0)) missing.push("ozonCategoryId/categoryId");
  if (!(Number(item.price) > 0)) missing.push("salePrice");
  if (!item.images.length) missing.push("images");
  if (!item.attributes.length) missing.push("ozonAttributes");
  return { ok: missing.length === 0, missing };
}

async function ozonRequest(pathname, clientId, apiKey, body) {
  let response;
  try {
    response = await fetch(`${OZON_API_BASE}${pathname}`, withFetchTimeout({
      method: "POST",
      headers: { "Client-Id": String(clientId), "Api-Key": String(apiKey), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body)
    }));
  } catch (error) {
    return { ok: false, status: 502, message: `Ozon request failed: ${String(error?.message || error)}` };
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.message || data?.error || data?.errors?.[0]?.message || `Ozon API HTTP ${response.status}`;
    return { ok: false, status: response.status, message, data };
  }
  return { ok: true, status: response.status, data };
}

function flattenImportItems(data) {
  const items = data?.result?.items || data?.items || data?.result || [];
  return Array.isArray(items) ? items : [];
}

function importItemStatus(item) {
  return String(item?.status || item?.state || "").trim().toLowerCase();
}

async function waitImportInfo(clientId, apiKey, taskId, timeoutMs = 12000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    const result = await ozonRequest("/v1/product/import/info", clientId, apiKey, { task_id: Number(taskId) || taskId });
    if (!result.ok) return result;
    last = result.data;
    const items = flattenImportItems(result.data);
    if (items.length && items.every((item) => ["imported", "failed", "error", "cancelled"].includes(importItemStatus(item)))) {
      return { ok: true, data: result.data, completed: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ok: true, data: last || {}, completed: false, timeout: true };
}

async function publishOzonProducts(shop, sourceItems) {
  const clientId = String(shop?.clientId || shop?.campaignId || "").trim();
  const apiKey = String(shop?.apiKey || "").trim();
  if (!clientId || !apiKey) return { ok: false, status: 400, message: "Ozon Client-Id 或 Api-Key 未配置" };
  const normalized = sourceItems.map(normalizeOzonProduct);
  const invalid = normalized.map((item, index) => ({ index, offerId: item.offer_id, ...validateOzonProduct(item) })).filter((entry) => !entry.ok);
  if (invalid.length) return { ok: false, status: 400, message: "Ozon 商品缺少必要字段", invalid };
  const payloadItems = normalized.map(({ _sourceId, ...item }) => item);
  const imported = await ozonRequest("/v3/product/import", clientId, apiKey, { items: payloadItems });
  if (!imported.ok) return imported;
  const taskId = imported.data?.result?.task_id || imported.data?.task_id || "";
  if (!taskId) return { ok: false, status: 502, message: "Ozon 未返回 task_id", data: imported.data };
  const status = await waitImportInfo(clientId, apiKey, taskId);
  const items = flattenImportItems(status.data || {});
  return { ok: true, taskId: String(taskId), completed: status.completed !== false, timedOut: Boolean(status.timeout), items, response: status.data || imported.data };
}

module.exports = { normalizeOzonProduct, validateOzonProduct, publishOzonProducts };
