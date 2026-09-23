const reviewRulesMessage = document.getElementById("reviewRulesMessage");
const openReviewRuleModalBtn = document.getElementById("openReviewRuleModalBtn");
const reviewRuleModalMask = document.getElementById("reviewRuleModalMask");
const closeReviewRuleModalBtn = document.getElementById("closeReviewRuleModalBtn");
const reviewRuleModalTitle = document.getElementById("reviewRuleModalTitle");
const reviewRuleForm = document.getElementById("reviewRuleForm");
const reviewRuleSubmitBtn = document.getElementById("reviewRuleSubmitBtn");
const reviewRuleShopId = document.getElementById("reviewRuleShopId");
const reviewRuleApplyToOrders = document.getElementById("reviewRuleApplyToOrders");
const reviewRuleApplyToOnlineProducts = document.getElementById("reviewRuleApplyToOnlineProducts");
const reviewRulesTableBody = document.getElementById("reviewRulesTableBody");
const reviewRuleLogisticsPerKgRmb = document.getElementById("reviewRuleLogisticsPerKgRmb");
const reviewRuleLogisticsPerKgRub = document.getElementById("reviewRuleLogisticsPerKgRub");
const reviewRuleRegistrationFeeRmb = document.getElementById("reviewRuleRegistrationFeeRmb");
const reviewRuleRegistrationFeeRub = document.getElementById("reviewRuleRegistrationFeeRub");
const reviewRuleOtherFeeRmb = document.getElementById("reviewRuleOtherFeeRmb");
const reviewRuleOtherFeeRub = document.getElementById("reviewRuleOtherFeeRub");
const reviewRuleWithdrawPercent = document.getElementById("reviewRuleWithdrawPercent");
const reviewRuleTransferPercent = document.getElementById("reviewRuleTransferPercent");
const reviewRulePackingFeeRmb = document.getElementById("reviewRulePackingFeeRmb");
const reviewRulePackingFeeRub = document.getElementById("reviewRulePackingFeeRub");

let activeReviewRuleId = "";

function bindRubAutoFill(rubInput, rmbInput) {
  if (!rubInput || !rmbInput) return;
  const sync = async () => {
    const raw = String(rubInput.value || "").replace(",", ".").trim();
    if (!raw) {
      rmbInput.value = "";
      return;
    }
    const rub = Number(raw);
    if (!Number.isFinite(rub)) return;
    const rate = await getRubPurchaseCostRate({ silent: true });
    if (!rate) return;
    rmbInput.value = (rub * rate).toFixed(2);
  };
  rubInput.addEventListener("input", sync);
  rubInput.addEventListener("change", sync);
}

function bindReviewRulesEvents() {
  if (openReviewRuleModalBtn) openReviewRuleModalBtn.addEventListener("click", openReviewRuleModal);
  if (closeReviewRuleModalBtn) closeReviewRuleModalBtn.addEventListener("click", closeReviewRuleModal);
  if (reviewRuleModalMask) reviewRuleModalMask.addEventListener("click", onReviewRuleModalMaskClick);
  if (reviewRuleForm) reviewRuleForm.addEventListener("submit", onReviewRuleSubmit);
  if (reviewRulesTableBody) reviewRulesTableBody.addEventListener("click", onReviewRulesTableClick);
  if (reviewRulesTableBody) reviewRulesTableBody.addEventListener("change", onReviewRulesTableChange);
  bindRubAutoFill(reviewRuleLogisticsPerKgRub, reviewRuleLogisticsPerKgRmb);
  bindRubAutoFill(reviewRuleRegistrationFeeRub, reviewRuleRegistrationFeeRmb);
  bindRubAutoFill(reviewRuleOtherFeeRub, reviewRuleOtherFeeRmb);
  bindRubAutoFill(reviewRulePackingFeeRub, reviewRulePackingFeeRmb);
}

async function buildReviewRuleCurrencyPayload(form) {
  const rubRate = await getRubPurchaseCostRate({ silent: true });
  const computeRmb = (rubName, rmbName) => {
    const rubRaw = String(form.get(rubName) || "").trim();
    const rub = toNullableMoneyNumber(rubRaw);
    const rmb = rub !== null && rubRate ? Number((rub * rubRate).toFixed(2)) : null;
    return {
      rub: rubRaw,
      rmb: rmb !== null ? String(rmb) : String(form.get(rmbName) || "").trim()
    };
  };
  const logisticsPerKg = computeRmb("logisticsPerKgRub", "logisticsPerKgRmb");
  const registrationFee = computeRmb("registrationFeeRub", "registrationFeeRmb");
  const otherFee = computeRmb("otherFeeRub", "otherFeeRmb");
  const packingFee = computeRmb("packingFeeRub", "packingFeeRmb");
  return {
    logisticsPerKgRmb: logisticsPerKg.rmb,
    logisticsPerKgRub: logisticsPerKg.rub,
    registrationFeeRmb: registrationFee.rmb,
    registrationFeeRub: registrationFee.rub,
    otherFeeRmb: otherFee.rmb,
    otherFeeRub: otherFee.rub,
    packingFeeRmb: packingFee.rmb,
    packingFeeRub: packingFee.rub,
    withdrawPercent: String(form.get("withdrawPercent") || "").trim(),
    transferPercent: String(form.get("transferPercent") || "").trim()
  };
}

async function loadReviewRules() {
  const result = await apiRequest("/api/review-rules", { method: "GET" });
  if (!result.ok) {
    state.reviewRules = [];
    renderReviewRulesTable();
    if (reviewRulesMessage) {
      reviewRulesMessage.style.color = "#c02030";
      reviewRulesMessage.textContent = result.error || "审单规则加载失败";
    }
    return false;
  }
  state.reviewRules = Array.isArray(result.data?.items) ? result.data.items : [];
  renderReviewRulesTable();
  if (reviewRulesMessage) {
    reviewRulesMessage.style.color = "#2f3d63";
    reviewRulesMessage.textContent = state.reviewRules.length ? `已加载 ${state.reviewRules.length} 条审单规则` : "还没有审单规则，可以先添加";
  }
  refreshOrderProfitData();
  applyFiltersAndRender();
  buildFinanceProfitView();
  return true;
}

async function refreshDataAfterReviewRuleChange() {
  const tasks = [];
  if (typeof loadOnlineProducts === "function") tasks.push(loadOnlineProducts());
  if (typeof loadOrders === "function") tasks.push(loadOrders());
  await Promise.allSettled(tasks);
  if (typeof loadProfitIssues === "function") {
    await loadProfitIssues();
  }
}

function renderReviewRuleShopOptions() {
  if (!reviewRuleShopId) return;
  const scopeShops = Array.isArray(state.shops) ? state.shops : [];
  reviewRuleShopId.innerHTML = [
    "<option value=''>全部店铺（当前账号可见）</option>",
    ...scopeShops.map((shop) => `<option value="${escapeHtml(String(shop.id || ""))}">${escapeHtml(String(shop.name || shop.code || shop.id || ""))}</option>`)
  ].join("");
}

function getReviewRuleShopLabel(shopId) {
  const normalizedShopId = String(shopId || "").trim();
  if (!normalizedShopId) return "全部店铺";
  const shop = (state.shops || []).find((item) => String(item.id || "").trim() === normalizedShopId);
  return String(shop?.name || shop?.code || normalizedShopId).trim() || normalizedShopId;
}

function getReviewRuleTargetLabel(rule) {
  const parts = [];
  if (rule?.applyToOrders !== false) parts.push("订单");
  if (rule?.applyToOnlineProducts !== false) parts.push("在线产品");
  return parts.length ? parts.join(" + ") : "未设置";
}

function openReviewRuleModal(rule = null) {
  if (!reviewRuleModalMask) return;
  renderReviewRuleShopOptions();
  activeReviewRuleId = String(rule?.id || "").trim();
  if (reviewRuleForm) reviewRuleForm.reset();
  if (reviewRuleShopId) reviewRuleShopId.value = "";
  if (reviewRuleApplyToOrders) reviewRuleApplyToOrders.checked = true;
  if (reviewRuleApplyToOnlineProducts) reviewRuleApplyToOnlineProducts.checked = true;
  if (reviewRuleModalTitle) {
    reviewRuleModalTitle.textContent = activeReviewRuleId ? "修改审单规则" : "添加审单规则";
  }
  if (reviewRuleSubmitBtn) {
    reviewRuleSubmitBtn.textContent = activeReviewRuleId ? "保存修改" : "确认添加";
  }
  if (rule && reviewRuleForm) {
    const setValue = (name, value) => {
      const field = reviewRuleForm.elements.namedItem(name);
      if (field) field.value = value ?? "";
    };
    setValue("name", rule.name || "");
    setValue("priority", rule.priority || 100);
    setValue("shopId", rule.shopId || "");
    setValue("platform", rule.platform || "yandex_market");
    if (reviewRuleApplyToOrders) reviewRuleApplyToOrders.checked = rule.applyToOrders !== false;
    if (reviewRuleApplyToOnlineProducts) reviewRuleApplyToOnlineProducts.checked = rule.applyToOnlineProducts !== false;
    setValue("logisticsPerKgRmb", rule.logisticsPerKgRmb ?? "");
    setValue("logisticsPerKgRub", rule.logisticsPerKgRub ?? "");
    setValue("registrationFeeRmb", rule.registrationFeeRmb ?? "");
    setValue("registrationFeeRub", rule.registrationFeeRub ?? "");
    setValue("otherFeeRmb", rule.otherFeeRmb ?? "");
    setValue("otherFeeRub", rule.otherFeeRub ?? "");
    setValue("withdrawPercent", rule.withdrawPercent ?? "");
    setValue("transferPercent", rule.transferPercent ?? "");
    setValue("packingFeeRmb", rule.packingFeeRmb ?? "");
    setValue("packingFeeRub", rule.packingFeeRub ?? "");
    setValue("notes", rule.notes || "");
  }
  reviewRuleModalMask.classList.remove("hidden");
}

function closeReviewRuleModal() {
  activeReviewRuleId = "";
  if (reviewRuleModalTitle) reviewRuleModalTitle.textContent = "添加审单规则";
  if (reviewRuleSubmitBtn) reviewRuleSubmitBtn.textContent = "确认添加";
  if (reviewRuleModalMask) reviewRuleModalMask.classList.add("hidden");
}

function onReviewRuleModalMaskClick(event) {
  if (event.target === reviewRuleModalMask) closeReviewRuleModal();
}

function renderReviewRulesTable() {
  if (!reviewRulesTableBody) return;
  const rules = Array.isArray(state.reviewRules) ? state.reviewRules : [];
  if (!rules.length) {
    reviewRulesTableBody.innerHTML = "<tr><td colspan='9'>暂无规则</td></tr>";
    return;
  }
  reviewRulesTableBody.innerHTML = rules
    .sort((a, b) => (Number(a.priority || 100) || 100) - (Number(b.priority || 100) || 100))
    .map((rule) => {
      const shopLabel = getReviewRuleShopLabel(rule.shopId);
      return `
        <tr data-review-rule-id="${escapeHtml(String(rule.id || ""))}">
          <td>
            <div class="review-rule-enabled-cell">
              <label class="pill-switch review-rule-switch" aria-label="切换审单规则启用状态">
                <input type="checkbox" data-review-rule-enable="${escapeHtml(String(rule.id || ""))}" ${rule.enabled !== false ? "checked" : ""} />
                <span class="pill-slider"></span>
              </label>
              <span class="review-rule-enabled-text ${rule.enabled !== false ? "is-enabled" : "is-disabled"}">${rule.enabled !== false ? "已启用" : "已关闭"}</span>
            </div>
          </td>
          <td>${escapeHtml(rule.name || "-")}</td>
          <td>${escapeHtml(String(rule.priority || 100))}</td>
          <td>${escapeHtml(shopLabel)}${rule.shopId ? "<div class='review-rule-shop-note'>仅此店铺</div>" : "<div class='review-rule-shop-note'>未指定时用于全部店铺</div>"}</td>
          <td>${escapeHtml(getReviewRuleTargetLabel(rule))}</td>
          <td>${escapeHtml(formatNullableFinanceMoney(rule.logisticsPerKgRub))}</td>
          <td>${escapeHtml(formatNullableFinanceMoney(rule.registrationFeeRub))}</td>
          <td>${escapeHtml(`${formatNullableFinanceMoney((Number(rule.otherFeeRub || 0) || 0) + (Number(rule.packingFeeRub || 0) || 0))} + 提现${formatNullableFinanceMoney(rule.withdrawPercent)}% + 转账${formatNullableFinanceMoney(rule.transferPercent)}%`)}</td>
          <td>
            <div class="review-rule-actions">
              <button type="button" class="secondary-btn" data-review-rule-edit="${escapeHtml(String(rule.id || ""))}">修改</button>
              <button type="button" class="secondary-btn" data-review-rule-delete="${escapeHtml(String(rule.id || ""))}">删除</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

async function onReviewRuleSubmit(event) {
  event.preventDefault();
  if (!reviewRuleForm) return;
  if (reviewRulesMessage) {
    reviewRulesMessage.style.color = "#2f3d63";
    reviewRulesMessage.textContent = "正在保存审单规则...";
  }
  const form = new FormData(reviewRuleForm);
  const applyToOrders = Boolean(reviewRuleApplyToOrders?.checked);
  const applyToOnlineProducts = Boolean(reviewRuleApplyToOnlineProducts?.checked);
  if (!applyToOrders && !applyToOnlineProducts) {
    if (reviewRulesMessage) {
      reviewRulesMessage.style.color = "#c02030";
      reviewRulesMessage.textContent = "请至少选择一个适用对象：订单或在线产品";
    }
    return;
  }
  const currencyPayload = await buildReviewRuleCurrencyPayload(form);
  const payload = {
    name: String(form.get("name") || "").trim(),
    priority: String(form.get("priority") || "").trim(),
    shopId: String(form.get("shopId") || "").trim(),
    platform: String(form.get("platform") || "").trim(),
    applyToOrders,
    applyToOnlineProducts,
    ...currencyPayload,
    withdrawPercent: String(form.get("withdrawPercent") || "").trim(),
    transferPercent: String(form.get("transferPercent") || "").trim(),
    notes: String(form.get("notes") || "").trim()
  };
  const isEditing = Boolean(activeReviewRuleId);
  const result = await apiRequest(isEditing ? `/api/review-rules/${encodeURIComponent(activeReviewRuleId)}` : "/api/review-rules", {
    method: isEditing ? "PUT" : "POST",
    body: JSON.stringify({ item: payload })
  });
  if (!result.ok) {
    if (reviewRulesMessage) {
      reviewRulesMessage.style.color = "#c02030";
      reviewRulesMessage.textContent = result.error || "规则保存失败";
    }
    return;
  }
  reviewRuleForm.reset();
  renderReviewRuleShopOptions();
  closeReviewRuleModal();
  await loadReviewRules();
  await refreshDataAfterReviewRuleChange();
  const scopeText = getReviewRuleShopLabel(payload.shopId);
  const targetText = getReviewRuleTargetLabel(payload);
  if (reviewRulesMessage) {
    reviewRulesMessage.style.color = "#1d6f3a";
    reviewRulesMessage.textContent = isEditing
      ? `审单规则已更新，适用店铺：${scopeText}，适用对象：${targetText}`
      : `审单规则已添加，适用店铺：${scopeText}，适用对象：${targetText}`;
  }
}

async function onReviewRulesTableChange(event) {
  const checkbox = event.target.closest("[data-review-rule-enable]");
  if (!checkbox) return;
  const ruleId = String(checkbox.getAttribute("data-review-rule-enable") || "").trim();
  const current = (state.reviewRules || []).find((item) => String(item.id || "") === ruleId);
  if (!current) return;
  const result = await apiRequest(`/api/review-rules/${encodeURIComponent(ruleId)}`, {
    method: "PUT",
    body: JSON.stringify({ item: { enabled: checkbox.checked } })
  });
  if (!result.ok) {
    checkbox.checked = current.enabled !== false;
    if (reviewRulesMessage) {
      reviewRulesMessage.style.color = "#c02030";
      reviewRulesMessage.textContent = result.error || "规则更新失败";
    }
    return;
  }
  await loadReviewRules();
  await refreshDataAfterReviewRuleChange();
}

async function onReviewRulesTableClick(event) {
  const editBtn = event.target.closest("[data-review-rule-edit]");
  if (editBtn) {
    const ruleId = String(editBtn.getAttribute("data-review-rule-edit") || "").trim();
    const rule = (state.reviewRules || []).find((item) => String(item.id || "") === ruleId);
    if (rule) openReviewRuleModal(rule);
    return;
  }
  const deleteBtn = event.target.closest("[data-review-rule-delete]");
  if (!deleteBtn) return;
  const ruleId = String(deleteBtn.getAttribute("data-review-rule-delete") || "").trim();
  if (!ruleId) return;
  const result = await apiRequest(`/api/review-rules/${encodeURIComponent(ruleId)}`, { method: "DELETE" });
  if (!result.ok) {
    if (reviewRulesMessage) {
      reviewRulesMessage.style.color = "#c02030";
      reviewRulesMessage.textContent = result.error || "规则删除失败";
    }
    return;
  }
  await loadReviewRules();
  await refreshDataAfterReviewRuleChange();
  if (reviewRulesMessage) {
    reviewRulesMessage.style.color = "#1d6f3a";
    reviewRulesMessage.textContent = "审单规则已删除";
  }
}
