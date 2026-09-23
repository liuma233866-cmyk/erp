// 从 app.js 拆出的共享汇率模块（classic script，全局作用域）。
// getCbrRateCny / getRubPurchaseCostRate 带 30 分钟内存缓存。
let lastRateValue = null;

let lastRateTs = 0;

let lastRubPurchaseCostRate = null;

let lastRubPurchaseCostTs = 0;

async function getCbrRateCny(options = {}) {
  const now = Date.now();
  if (lastRateValue && now - lastRateTs < 30 * 60 * 1000) {
    return lastRateValue;
  }
  const silent = Boolean(options.silent);
  const result = await apiRequest("/api/rates/cbr?currency=CNY", { method: "GET" });
  if (!result.ok) {
    if (!silent && purchaseMessage) {
      purchaseMessage.style.color = "#c02030";
      purchaseMessage.textContent = result.error || "汇率获取失败";
    }
    return null;
  }
  const value = Number(result.data?.rate);
  if (!Number.isFinite(value) || value <= 0) {
    if (!silent && purchaseMessage) {
      purchaseMessage.style.color = "#c02030";
      purchaseMessage.textContent = "汇率数据异常";
    }
    return null;
  }
  lastRateValue = value;
  lastRateTs = now;
  if (!silent && purchaseMessage) {
    purchaseMessage.style.color = "#1d6f3a";
    purchaseMessage.textContent = `汇率 1 CNY = ${value.toFixed(4)} RUB`;
  }
  return value;
}

async function getRubPurchaseCostRate(options = {}) {
  const now = Date.now();
  if (lastRubPurchaseCostRate && now - lastRubPurchaseCostTs < 30 * 60 * 1000) {
    return lastRubPurchaseCostRate;
  }
  const silent = Boolean(options.silent);
  const result = await apiRequest("/api/rates/rub-purchase-cost", { method: "GET" });
  if (!result.ok) {
    if (!silent && reviewRulesMessage) {
      reviewRulesMessage.style.color = "#c02030";
      reviewRulesMessage.textContent = result.error || "卢布汇率获取失败";
    }
    return null;
  }
  const value = Number(result.data?.rate);
  if (!Number.isFinite(value) || value <= 0) {
    if (!silent && reviewRulesMessage) {
      reviewRulesMessage.style.color = "#c02030";
      reviewRulesMessage.textContent = "卢布汇率数据异常";
    }
    return null;
  }
  lastRubPurchaseCostRate = value;
  lastRubPurchaseCostTs = now;
  return value;
}

function bindRmbToRubAutoFill(rmbInput, rubInput) {
  if (!rmbInput || !rubInput) return;
  const sync = async () => {
    const raw = String(rmbInput.value || "").replace(",", ".").trim();
    if (!raw) {
      rubInput.value = "";
      return;
    }
    const rmb = Number(raw);
    if (!Number.isFinite(rmb)) return;
    const rate = await getCbrRateCny({ silent: true });
    if (!rate) return;
    rubInput.value = (rmb * rate).toFixed(2);
  };
  rmbInput.addEventListener("input", sync);
  rmbInput.addEventListener("change", sync);
}

// 从 app.js 迁出的佣金百分比归一化。

function normalizeCommissionPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num > 0 && num < 1) {
    return num * 100;
  }
  return num;
}
