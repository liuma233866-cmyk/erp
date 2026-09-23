const OZON_API_BASE = "https://api-seller.ozon.ru";
function parseOzonDate(value, fallback) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (match) {
    const parsed = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
    if (parsed.getUTCFullYear() === Number(match[3]) && parsed.getUTCMonth() === Number(match[2]) - 1 && parsed.getUTCDate() === Number(match[1])) return parsed.toISOString();
  }
  const parsed = raw ? new Date(raw) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function receiptFromStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  if (value.includes("return")) return { code: "returned", zh: "已退货", en: "Returned", received: false };
  if (value.includes("not_received") || value.includes("cancelled_after_ship")) {
    return { code: "not_received", zh: "顾客未收到", en: "Customer not received", received: false };
  }
  if (value.includes("delivered") || value.includes("posting_received")) {
    return { code: "received", zh: "已收货", en: "Received", received: true };
  }
  if (value.includes("pickup")) return { code: "ready_for_pickup", zh: "待顾客取件", en: "Ready for pickup", received: false };
  if (["delivering", "sent_by_seller", "arbitration", "awaiting_deliver"].some((part) => value.includes(part))) {
    return { code: "in_delivery", zh: "配送中", en: "In delivery", received: false };
  }
  return { code: "", zh: "", en: "", received: false };
}

function localStatusFromOzon(status) {
  const value = String(status || "").toLowerCase();
  if (value.includes("cancel")) return "cancelled";
  if (["deliver", "pickup", "sent_by_seller", "arbitration", "return"].some((part) => value.includes(part))) return "shipped";
  return "pending";
}

function mapOzonPostingToLocal(posting, shop) {
  const orderNo = String(posting?.posting_number || posting?.order_number || posting?.order_id || "").trim();
  if (!orderNo) return null;
  const rawProducts = Array.isArray(posting?.products) ? posting.products : [];
  const items = rawProducts.map((product) => {
    const quantity = Math.max(1, asNumber(product?.quantity) || 1);
    const price = asNumber(product?.price);
    return {
      offerId: String(product?.offer_id || product?.sku || "").trim(),
      shopSku: String(product?.offer_id || product?.sku || "").trim(),
      name: String(product?.name || "").trim(),
      count: quantity,
      quantity,
      price,
      buyerPrice: price,
      unitPrice: price,
      imageUrl: String(product?.primary_image || product?.image || "").trim()
    };
  });
  const amount = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const status = String(posting?.status || "").trim();
  const substatus = String(posting?.substatus || posting?.delivery_method?.name || "").trim();
  const receipt = receiptFromStatus(`${status} ${substatus}`);
  const createdAt = String(posting?.in_process_at || posting?.created_at || posting?.shipment_date || "").trim();
  const first = items[0] || {};
  return {
    id: `ORD-OZ-${String(shop?.id || "SHOP")}-${orderNo}`.replace(/[^A-Za-z0-9_-]/g, "-"),
    customerName: "店铺订单",
    amount,
    status: localStatusFromOzon(status),
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sellerOrderAt: createdAt,
    deadlineAt: String(posting?.shipment_date || "").trim(),
    currency: String(rawProducts[0]?.currency_code || "RUB").trim().toUpperCase() || "RUB",
    platform: "Ozon",
    provider: "ozon",
    shopId: String(shop?.id || ""),
    shopName: String(shop?.name || "").trim(),
    shopSku: first.shopSku || "",
    itemCount: quantity,
    shopOrderNo: orderNo,
    shopStatus: status,
    shopSubstatus: substatus,
    customerReceiptCode: receipt.code,
    customerReceiptZh: receipt.zh,
    customerReceiptEn: receipt.en,
    customerReceived: receipt.received,
    customerReceivedAt: receipt.received ? String(posting?.delivering_date || posting?.shipment_date || "").trim() : "",
    trackingNo: String(posting?.tracking_number || posting?.barcodes?.upper_barcode || orderNo).trim(),
    logistics: String(posting?.delivery_method?.name || posting?.tpl_integration_type || "").trim(),
    warehouse: String(posting?.delivery_method?.warehouse || posting?.warehouse_name || "").trim(),
    productName: first.name || "",
    unitPrice: first.unitPrice,
    imageUrl: first.imageUrl || "",
    items,
    account: String(shop?.campaignId || shop?.clientId || "")
  };
}

async function fetchOzonFbsOrders(clientId, apiKey, options = {}) {
  const request = options.request || fetch;
  const limit = Math.min(1000, Math.max(1, Number(options.limit) || 1000));
  const since = parseOzonDate(options.fromDate, new Date(Date.now() - 180 * 86400000).toISOString());
  const to = parseOzonDate(options.toDate, new Date().toISOString());
  const items = [];
  for (let offset = 0, page = 0; page < 100; offset += limit, page += 1) {
    let response;
    try {
      response = await request(`${OZON_API_BASE}/v3/posting/fbs/list`, {
        method: "POST",
        headers: { "Client-Id": String(clientId), "Api-Key": String(apiKey), "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ dir: "ASC", filter: { since, to }, limit, offset, with: { analytics_data: true, barcodes: true, financial_data: true } })
      });
    } catch (error) {
      return { ok: false, status: 502, items: [], message: `Ozon request failed: ${String(error?.message || error)}` };
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, status: response.status, items: [], message: data?.message || `Ozon API HTTP ${response.status}` };
    const postings = Array.isArray(data?.result?.postings) ? data.result.postings : [];
    items.push(...postings);
    if (!data?.result?.has_next || postings.length === 0) break;
  }
  const wanted = new Set((options.orderNos || []).map((value) => String(value).trim()).filter(Boolean));
  return { ok: true, items: wanted.size ? items.filter((item) => wanted.has(String(item?.posting_number || ""))) : items };
}

module.exports = { fetchOzonFbsOrders, mapOzonPostingToLocal, localStatusFromOzon, receiptFromStatus, parseOzonDate };
