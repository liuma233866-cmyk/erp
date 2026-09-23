async function loadShops() {
  if (shopsMessage) shopsMessage.textContent = "";
  if (!canShopRead()) {
    if (shopsTableBody) shopsTableBody.innerHTML = "<tr><td colspan='10'>无权限查看</td></tr>";
    state.shops = [];
    return false;
  }

  if (shopsTableBody) shopsTableBody.innerHTML = "<tr><td colspan='10'>加载中...</td></tr>";
  const result = await apiRequest("/api/shops", { method: "GET" });
  if (!result.ok) {
    if (shopsMessage) shopsMessage.textContent = result.error || "店铺加载失败";
    if (shopsTableBody) shopsTableBody.innerHTML = "<tr><td colspan='10'>加载失败</td></tr>";
    return false;
  }

  state.shops = result.data.items || [];
  renderShopsTable();
  renderShopFilterOptions();
  return true;
}

function renderShopsTable() {
  if (!shopsTableBody) return;
  if (!state.shops.length) {
    shopsTableBody.innerHTML = "<tr><td colspan='10'>暂无店铺</td></tr>";
    return;
  }

  const canToggle = can("shopToggle");
  const canDelete = can("shopDelete");
  shopsTableBody.innerHTML = state.shops
    .map((shop) => {
      const statusText = shop.enabled ? "启用" : "停用";
      const toggleBtn = canToggle
        ? `<button class="small-btn" data-action="toggle-shop" data-id="${escapeHtml(shop.id)}">切换</button>`
        : "-";
      const deleteBtn = canDelete
        ? `<button class="small-btn danger-btn" data-action="delete-shop" data-id="${escapeHtml(shop.id)}">删除</button>`
        : "-";
      const editBtn = canToggle
        ? `<button class="small-btn" data-action="edit-shop" data-id="${escapeHtml(shop.id)}">编辑</button>`
        : "";
      const credentialRelation = shop.usesSharedCredential
        ? `<strong>共享 Key</strong><small>${escapeHtml(shop.credentialOwnerName || shop.credentialOwnerShopId || "母账号")} · ${Number(shop.sharedCredentialCount || 0)} 个店铺</small>`
        : "独立凭证";
      const workspaceControl = `<span class="shop-workspace-label ${shop.orderWorkspace === "v2" ? "is-v2" : ""}">${shop.orderWorkspace === "v2" ? "订单管理 V2" : "订单管理第一版"}</span>`;
      return `<tr data-shop-id="${escapeHtml(shop.id)}">
        <td>${escapeHtml(shop.id)}</td>
        <td>${escapeHtml(shop.name || "-")}</td>
        <td>${escapeHtml(shop.code || "-")}</td>
        <td>${escapeHtml(getShopProviderLabel(shop.provider))}<small>店铺币种：${escapeHtml(String(shop.shopCurrency || "RUR"))}</small></td>
        <td class="shop-credential-relation">${credentialRelation}</td>
        <td>${workspaceControl}</td>
        <td>${escapeHtml(shop.companyName || "-")}</td>
        <td>${statusText}</td>
        <td>${shop.createdAt ? new Date(shop.createdAt).toLocaleString("zh-CN") : "-"}</td>
        <td style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">${editBtn}${toggleBtn}${deleteBtn}</td>
      </tr>`;
    })
    .join("");
}

function renderShopFilterOptions() {
  if (orderShopFilter) {
    const current = String(state.filters.shopName || "");
    const options = (state.shops || [])
      .map((shop) => {
        const name = String(shop.name || "").trim();
        if (!name) return "";
        const selected = name === current ? "selected" : "";
        return `<option value="${escapeHtml(name)}" ${selected}>${escapeHtml(name)}</option>`;
      })
      .join("");
    orderShopFilter.innerHTML = `<option value="">店铺名称(全部)</option>${options}`;
  }

  renderOrderSyncShopOptions();
  renderOnlineShopFilterOptions();
  renderPublishShopOptions();
}

async function onAddShopSubmit(event) {
  event.preventDefault();
  shopsMessage.style.color = "#c02030";
  shopsMessage.textContent = "";
  if (editingShopId ? !can("shopToggle") : !can("shopCreate")) {
    shopsMessage.textContent = "无权限操作";
    return;
  }

  const form = new FormData(addShopForm);
  const companyName = String(form.get("companyName") || state.user?.companyName || "").trim();
  const payload = {
    companyName,
    provider: String(form.get("provider") || "yandex_market").trim(),
    shopCurrency: String(form.get("shopCurrency") || "RUR").trim(),
    campaignId: String(form.get("campaignId") || "").trim(),
    apiKey: String(form.get("apiKey") || ""),
    orderWorkspace: String(form.get("orderWorkspace") || "v1"),
    name: String(form.get("name") || "").trim(),
    code: String(form.get("code") || "").trim()
  };

  const endpoint = editingShopId ? `/api/shops/${encodeURIComponent(editingShopId)}` : "/api/shops";
  const result = await apiRequest(endpoint, { method: editingShopId ? "PUT" : "POST", body: JSON.stringify(payload) });
  if (!result.ok) {
    shopsMessage.textContent = result.error || "创建失败";
    return;
  }

  const wasEditing = Boolean(editingShopId);
  editingShopId = "";
  addShopForm.reset();
  if (shopCompanyName) {
    shopCompanyName.value = String(state.user?.companyName || "系统");
  }
  closeShopModal();
  shopsMessage.style.color = "#1d6f3a";
  const createdId = String(result.data?.item?.id || "").trim();
  const successMessage = String(result.data?.message || "").trim();
  await loadShops();
  const verified = createdId && Array.isArray(state.shops) && state.shops.some((shop) => String(shop.id || "").trim() === createdId);
  shopsMessage.textContent = successMessage || (wasEditing ? "店铺修改已保存" : (verified ? "店铺已添加并验证成功" : "店铺已添加，正在等待列表刷新确认"));
}

async function onShopsTableClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const shopId = button.dataset.id;
  if (button.dataset.action === "edit-shop") {
    const shop = (state.shops || []).find((item) => String(item.id || "") === String(shopId || ""));
    if (!shop) return;
    openShopModal(shop);
    return;
  }
  if (button.dataset.action === "toggle-shop") {
    if (!can("shopToggle")) {
      shopsMessage.textContent = "无权限操作";
      return;
    }
    const result = await apiRequest(`/api/shops/${encodeURIComponent(shopId)}/toggle`, { method: "PUT" });
    if (!result.ok) {
      shopsMessage.textContent = result.error || "切换失败";
      return;
    }
    await loadShops();
    return;
  }

  if (button.dataset.action === "delete-shop") {
    if (!can("shopDelete")) {
      shopsMessage.textContent = "无权限操作";
      return;
    }
    const ok = confirm("确认删除这个店铺？");
    if (!ok) return;
    const result = await apiRequest(`/api/shops/${encodeURIComponent(shopId)}`, { method: "DELETE" });
    if (!result.ok) {
      shopsMessage.textContent = result.error || "删除失败";
      return;
    }
    await loadShops();
  }
}

function openShopModal(shop = null) {
  editingShopId = String(shop?.id || "");
  // Creating a shop needs shopCreate; editing needs shopToggle (matches the
  // backend PUT permission check on /api/shops/:id).
  if (editingShopId ? !can("shopToggle") : !can("shopCreate")) return;
  if (addShopForm) addShopForm.reset();
  if (shopModalTitle) shopModalTitle.textContent = editingShopId ? "编辑店铺" : "添加店铺";
  if (submitShopBtn) submitShopBtn.textContent = editingShopId ? "保存修改" : "确认添加";
  if (shopProvider) shopProvider.value = String(shop?.provider || "yandex_market");
  if (shopCurrency) shopCurrency.value = String(shop?.shopCurrency || "RUR").toUpperCase() === "CNY" ? "CNY" : "RUR";
  if (shopCampaignId) shopCampaignId.value = String(shop?.campaignId || "");
  if (shopApiKey) {
    shopApiKey.value = "";
    shopApiKey.placeholder = editingShopId ? "留空表示保持原 Key" : "可粘贴 Api-Key/OAuth/Bearer";
  }
  if (shopNameInput) shopNameInput.value = String(shop?.name || "");
  if (shopCodeInput) shopCodeInput.value = String(shop?.code || "");
  if (shopOrderWorkspace) shopOrderWorkspace.value = String(shop?.orderWorkspace || "v1");
  if (shopCompanyName) {
    shopCompanyName.value = String(state.user?.companyName || "系统");
    shopCompanyName.readOnly = state.user?.role !== "admin";
  }
  syncShopProviderFields();
  shopModalMask.classList.remove("hidden");
}

function getShopProviderLabel(provider) {
  const value = String(provider || "local").trim().toLowerCase();
  if (value === "yandex_market") return "Yandex";
  if (value === "ozon") return "Ozon";
  return "本地";
}

function syncShopProviderFields() {
  const provider = String(shopProvider?.value || "yandex_market").trim();
  const isLocal = provider === "local";
  const isOzon = provider === "ozon";
  if (shopCurrency) shopCurrency.disabled = isLocal;
  if (shopCampaignIdLabel) shopCampaignIdLabel.textContent = isOzon ? "Ozon Client-Id" : "活动ID";
  if (shopApiKeyLabel) shopApiKeyLabel.textContent = isOzon ? "Ozon Api-Key" : "Yandex API Key";
  if (shopCampaignId) {
    shopCampaignId.disabled = isLocal;
    shopCampaignId.required = !isLocal;
    shopCampaignId.placeholder = isOzon ? "例如 123456" : "例如 12345678";
  }
  if (shopApiKey) {
    shopApiKey.disabled = isLocal;
    shopApiKey.required = !isLocal && !editingShopId;
    shopApiKey.placeholder = editingShopId
      ? "留空表示保持原 Key"
      : (isOzon ? "填写 Ozon Seller API Key" : "可粘贴 Api-Key/OAuth/Bearer");
  }
}

function closeShopModal() {
  editingShopId = "";
  shopModalMask.classList.add("hidden");
}

function onShopModalMaskClick(event) {
  if (event.target === shopModalMask) closeShopModal();
}

function onShopModalEscClose(event) {
  if (event.key === "Escape" && shopModalMask && !shopModalMask.classList.contains("hidden")) {
    closeShopModal();
  }
}

// 从 app.js 下沉的 DOM 常量与事件绑定。

const syncApiBtn = document.getElementById("syncApiBtn");
const addShopForm = document.getElementById("addShopForm");
const shopsMessage = document.getElementById("shopsMessage");
const shopsTableBody = document.getElementById("shopsTableBody");
const openAddShopModalBtn = document.getElementById("openAddShopModalBtn");
const closeShopModalBtn = document.getElementById("closeShopModalBtn");
const shopModalMask = document.getElementById("shopModalMask");
const shopCompanyName = document.getElementById("shopCompanyName");
const shopProvider = document.getElementById("shopProvider");
const shopCurrency = document.getElementById("shopCurrency");
const shopCampaignId = document.getElementById("shopCampaignId");
const shopCampaignIdLabel = document.getElementById("shopCampaignIdLabel");
const shopApiKey = document.getElementById("shopApiKey");
const shopApiKeyLabel = document.getElementById("shopApiKeyLabel");
const shopModalTitle = document.getElementById("shopModalTitle");
const shopNameInput = document.getElementById("shopName");
const shopCodeInput = document.getElementById("shopCode");
const shopOrderWorkspace = document.getElementById("shopOrderWorkspace");
const submitShopBtn = document.getElementById("submitShopBtn");
let editingShopId = "";

function bindShopsEvents() {
  if (syncApiBtn) syncApiBtn.addEventListener("click", loadShops);
  if (addShopForm) addShopForm.addEventListener("submit", onAddShopSubmit);
  if (shopProvider) shopProvider.addEventListener("change", syncShopProviderFields);
  if (shopsTableBody) shopsTableBody.addEventListener("click", onShopsTableClick);
  if (openAddShopModalBtn) openAddShopModalBtn.addEventListener("click", openShopModal);
  if (closeShopModalBtn) closeShopModalBtn.addEventListener("click", closeShopModal);
  if (shopModalMask) shopModalMask.addEventListener("click", onShopModalMaskClick);
  document.addEventListener("keydown", onShopModalEscClose);
}
