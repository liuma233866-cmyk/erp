// 从 app.js 拆出的发布工作台模块（Yandex 发布 + Ozon 发布，classic script，全局作用域）。



function renderPublishShopOptions() {
  if (!publishShopSelect) return;
  const provider = getPublishWorkspaceShopProvider();
  const shops = (state.shops || [])
    .filter((shop) => {
      const shopProvider = String(shop?.provider || "").toLowerCase();
      if (provider === "ozon") return shopProvider === "ozon" && Boolean(shop?.enabled);
      return (shopProvider === "yandex_market" || shopProvider === "yandex") && Boolean(shop?.enabled);
    })
    .filter((shop) => String(shop?.id || "").trim());
  const currentValue = String(publishShopSelect.value || "").trim();
  const current = currentValue && shops.some((shop) => String(shop.id || "").trim() === currentValue)
    ? currentValue
    : shops.length === 1
      ? String(shops[0].id || "").trim()
      : "";
  const options = shops
    .map((shop) => {
      const id = String(shop.id || "").trim();
      const name = String(shop.name || id).trim();
      const selected = id === current ? "selected" : "";
      return `<option value="${escapeHtml(id)}" ${selected}>${escapeHtml(name)}</option>`;
    })
    .filter(Boolean)
    .join("");
  publishShopSelect.innerHTML = `<option value="">发布店铺(按店铺名称)</option>${options}`;
  publishShopSelect.value = current;
  renderPublishImportShopOptions(shops, current);
}

function renderPublishImportShopOptions(sourceShops = null, selectedValue = "") {
  if (!publishImportShopSelect) return;
  const shops = Array.isArray(sourceShops)
    ? sourceShops
    : (state.shops || [])
        .filter((shop) => {
          const provider = getPublishWorkspaceShopProvider();
          const shopProvider = String(shop?.provider || "").toLowerCase();
          if (provider === "ozon") return shopProvider === "ozon" && Boolean(shop?.enabled);
          return (shopProvider === "yandex_market" || shopProvider === "yandex") && Boolean(shop?.enabled);
        })
        .filter((shop) => String(shop?.id || "").trim());
  const currentValue = String(selectedValue || publishImportShopSelect.value || publishShopSelect?.value || "").trim();
  const options = shops
    .map((shop) => {
      const id = String(shop.id || "").trim();
      const name = String(shop.name || id).trim();
      const selected = id === currentValue ? "selected" : "";
      return `<option value="${escapeHtml(id)}" ${selected}>${escapeHtml(name)}</option>`;
    })
    .join("");
  publishImportShopSelect.innerHTML = `<option value="">优先使用文件内店铺ID</option>${options}`;
  publishImportShopSelect.value = currentValue;
}

function resolvePublishShopName(item) {
  const itemShopName = String(item?.shopName || "").trim();
  if (itemShopName) return itemShopName;
  const itemShopId = String(item?.shopId || "").trim();
  if (!itemShopId) return "";
  const matchedShop = (state.shops || []).find((shop) => String(shop?.id || "").trim() === itemShopId);
  return String(matchedShop?.name || "未知店铺").trim();
}

function getPublishWorkspaceShopProvider() {
  const tab = normalizePublishWorkspaceTab(state.publishWorkspaceTab);
  if (tab === "ozon") return "ozon";
  return "yandex";
}

async function loadPublishProducts() {
  if (!publishTableBody) return;
  if (publishMessage) {
    publishMessage.style.color = "#2f3d63";
    publishMessage.textContent = "正在加载上架产品...";
  }
  const result = await apiRequest("/api/product-publish", { method: "GET" });
  if (!result.ok) {
    if (publishMessage) {
      publishMessage.style.color = "#c02030";
      publishMessage.textContent = result.error || "加载失败";
    }
    publishTableBody.innerHTML = "<tr><td colspan='10'>加载失败</td></tr>";
    return false;
  }
  state.publishProducts = Array.isArray(result.data.items) ? result.data.items : [];
  if (publishPageSize) {
    state.publishPageSize = Number(publishPageSize.value || DEFAULT_PUBLISH_PAGE_SIZE) || DEFAULT_PUBLISH_PAGE_SIZE;
  }
  state.publishCurrentPage = 1;
  // 收敛到当前页签可见的行，而不是只判断「整表里是否还存在」。
  prunePublishSelectionToWorkspace();
  renderPublishTable();
  renderPublishPagination();
  syncPublishIslandScrollbarMetrics();
  if (publishMessage) publishMessage.textContent = "";
  return true;
}

function normalizePublishWorkspaceTab(tab) {
  const value = String(tab || "").trim().toLowerCase();
  if (value === "ozon" || value === "yandex" || value === "center") return value;
  return "center";
}

function getPublishWorkspaceTabMeta(tab = state.publishWorkspaceTab) {
  const normalized = normalizePublishWorkspaceTab(tab);
  const metaMap = {
    center: {
      title: "发布中心",
      description: "展示全部产品，统一整理首图、SKU、价格、尺寸、重量、描述、采集时间、店铺名称与采购链接。",
      actionLabel: "发布到Yandex",
      actionDisabled: false,
      actionTip: "当前按钮会把已选产品发布到 Yandex。"
    },
    ozon: {
      title: "Ozon 刊登",
      description: "只展示归属 Ozon 店铺的产品，支持通过 Ozon Seller API 刊登并回写任务与商品状态。",
      actionLabel: "发布到Ozon",
      actionDisabled: false,
      actionTip: "把已选产品提交到 Ozon Seller API。"
    },
    yandex: {
      title: "Yandex 刊登",
      description: "",
      actionLabel: "发布到Yandex",
      actionDisabled: false,
      actionTip: "当前按钮会把已选产品发布到 Yandex。"
    }
  };
  return metaMap[normalized] || metaMap.center;
}

function getPublishShopProvider(item) {
  const shopId = String(item?.shopId || "").trim();
  if (!shopId) return "";
  const shop = (state.shops || []).find((entry) => String(entry?.id || "").trim() === shopId);
  return String(shop?.provider || "").trim().toLowerCase();
}

function getPublishPlatformLabel(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (provider === "ozon") return "Ozon";
  if (provider === "yandex_market" || provider === "yandex") return "Yandex";
  if (provider) return provider;
  return "未指定";
}

function getPublishWorkspaceItems() {
  const items = Array.isArray(state.publishProducts) ? state.publishProducts : [];
  const tab = normalizePublishWorkspaceTab(state.publishWorkspaceTab);
  if (tab === "ozon") {
    return items.filter((item) => {
      const provider = getPublishShopProvider(item);
      return provider === "ozon" || String(item?.publishPlatform || item?.platform || "").trim().toLowerCase() === "ozon";
    });
  }
  if (tab === "yandex") {
    const yandexItems = items.filter((item) => {
      const provider = getPublishShopProvider(item);
      return provider === "yandex_market" || provider === "yandex" || String(item?.publishPlatform || item?.platform || "").trim().toLowerCase() === "yandex";
    });
    const filter = String(state.yandexPublishStatusFilter || "unpublished");
    return yandexItems.filter((item) => getYandexPublishStatusGroup(item) === filter);
  }
  return items;
}

// 选择集收敛到「当前页签可见」的行。批量删除/改库存此前直接发送 state.publishSelectedIds，
// 于是切换页签后仍会作用在另一个页签里已经看不见的行上（状态筛选那条路径本来就是清空选择集的，
// 只有页签切换漏了）。按页签收敛而非按当前页，所以跨页选择仍然保留。
function prunePublishSelectionToWorkspace() {
  const visible = new Set(
    getPublishWorkspaceItems()
      .map((item) => String(item?.id || "").trim())
      .filter(Boolean)
  );
  state.publishSelectedIds = (state.publishSelectedIds || []).filter((id) => visible.has(String(id || "").trim()));
}

function getYandexPublishStatusGroup(item) {
  const status = String(item?.publishStatus || item?.lastPublishStatus || "draft").trim().toLowerCase();
  if (status === "success") return "published";
  if (["failed", "blocked", "partial"].includes(status)) return "error";
  return "unpublished";
}

function getAllYandexPublishItems() {
  return (state.publishProducts || []).filter((item) => {
    const provider = getPublishShopProvider(item);
    return provider === "yandex_market" || provider === "yandex" || String(item?.publishPlatform || item?.platform || "").trim().toLowerCase() === "yandex";
  });
}

function updatePublishWorkspaceUi() {
  const meta = getPublishWorkspaceTabMeta();
  if (publishWorkspaceTitle) publishWorkspaceTitle.textContent = meta.title;
  if (publishWorkspaceDescription) publishWorkspaceDescription.textContent = meta.description;
  if (publishToYandexBtn) {
    publishToYandexBtn.textContent = meta.actionLabel;
    publishToYandexBtn.disabled = meta.actionDisabled;
    publishToYandexBtn.title = meta.actionTip;
  }
  if (publishWorkspaceTabs) {
    publishWorkspaceTabs.querySelectorAll("button[data-publish-tab]").forEach((btn) => {
      btn.classList.toggle("active", normalizePublishWorkspaceTab(btn.dataset.publishTab) === normalizePublishWorkspaceTab(state.publishWorkspaceTab));
    });
  }
  if (yandexPublishStatusFilters) {
    const isYandex = normalizePublishWorkspaceTab(state.publishWorkspaceTab) === "yandex";
    yandexPublishStatusFilters.classList.toggle("hidden", !isYandex);
    const counts = { unpublished: 0, error: 0, published: 0 };
    getAllYandexPublishItems().forEach((item) => { counts[getYandexPublishStatusGroup(item)] += 1; });
    yandexPublishStatusFilters.querySelectorAll("button[data-yandex-publish-status]").forEach((btn) => {
      const key = String(btn.dataset.yandexPublishStatus || "unpublished");
      btn.classList.toggle("active", key === state.yandexPublishStatusFilter);
      const count = btn.querySelector("[data-status-count]");
      if (count) count.textContent = String(counts[key] || 0);
    });
  }
}

async function loadPublishSettings() {
  const result = await apiRequest("/api/product-publish/settings", { method: "GET" });
  if (!result.ok) return false;
  const settings = result.data?.settings || {};
  state.publishSettings = {
    erpAutoPublishToYandex: settings.erpAutoPublishToYandex !== false,
    erpAutoPublishToOzon: Boolean(settings.erpAutoPublishToOzon),
    simulateBackendPublishToYandex: Boolean(settings.simulateBackendPublishToYandex)
    ,skuPrefix: String(settings.skuPrefix || "PUB")
    ,skuPrefixByShopId: settings.skuPrefixByShopId && typeof settings.skuPrefixByShopId === "object" ? settings.skuPrefixByShopId : {}
    ,skuSeparator: String(settings.skuSeparator || "-")
    ,skuIncludeSourceSku: settings.skuIncludeSourceSku !== false
    ,publishIntervalSeconds: Number(settings.publishIntervalSeconds || 0)
    ,dailyPublishLimit: Number(settings.dailyPublishLimit || 0)
    ,qualityGateEnabled: settings.qualityGateEnabled !== false
    ,qualityMinScore: Number(settings.qualityMinScore ?? 80)
  };
  return true;
}

function fillPublishSettingsForm() {
  if (publishAutoToYandexToggle) {
    publishAutoToYandexToggle.checked = state.publishSettings.erpAutoPublishToYandex !== false;
  }
  if (publishAutoToOzonToggle) {
    publishAutoToOzonToggle.checked = Boolean(state.publishSettings.erpAutoPublishToOzon);
  }
  if (publishSimulateToggle) {
    publishSimulateToggle.checked = Boolean(state.publishSettings.simulateBackendPublishToYandex);
  }
  if (publishSkuPrefix) publishSkuPrefix.value = state.publishSettings.skuPrefix || "PUB";
  if (publishShopPrefixList) {
    const prefixes = state.publishSettings.skuPrefixByShopId || {};
    const shops = (state.shops || []).filter((shop) => Boolean(shop?.enabled) && String(shop?.id || "").trim());
    publishShopPrefixList.innerHTML = shops.length
      ? shops.map((shop) => `<label><span><strong>${escapeHtml(shop.name || shop.id)}</strong><small>${escapeHtml(getPublishPlatformLabel(shop.provider || ""))}</small></span><input type="text" maxlength="16" data-publish-shop-prefix="${escapeHtml(shop.id)}" value="${escapeHtml(prefixes[shop.id] || "")}" placeholder="${escapeHtml(state.publishSettings.skuPrefix || "PUB")}" /></label>`).join("")
      : `<div class="product-sub">暂无启用店铺</div>`;
  }
  if (publishSkuSeparator) publishSkuSeparator.value = state.publishSettings.skuSeparator || "-";
  if (publishSkuIncludeSourceToggle) publishSkuIncludeSourceToggle.checked = state.publishSettings.skuIncludeSourceSku !== false;
  if (publishIntervalSeconds) publishIntervalSeconds.value = String(state.publishSettings.publishIntervalSeconds || 0);
  if (dailyPublishLimit) dailyPublishLimit.value = String(state.publishSettings.dailyPublishLimit || 0);
  if (publishQualityGateToggle) publishQualityGateToggle.checked = state.publishSettings.qualityGateEnabled !== false;
  if (publishQualityMinScore) publishQualityMinScore.value = String(state.publishSettings.qualityMinScore ?? 80);
  if (publishSettingsModalMessage) {
    publishSettingsModalMessage.style.color = "#5f7390";
    publishSettingsModalMessage.textContent = "";
  }
}

// 加载设置失败时把表单锁死。此时 state.publishSettings 要么是硬编码默认值（首次加载，
// 见 shared/core/state.js）、要么是上一次的旧值 —— 两者都不能当成「当前设置」呈现，更不能
// 让一次点击把它们写回服务端覆盖真实配置（例如默认值里的「自动发布到 Yandex = 开启」）。
// 注意只锁输入控件与「保存」；「取消」是 type=button，保留可用以便退出（头部「关闭」本来
// 也在表单之外）。
function setPublishSettingsFormDisabled(disabled) {
  const locked = Boolean(disabled);
  if (publishSettingsForm) {
    publishSettingsForm.querySelectorAll("input, select, textarea").forEach((field) => {
      field.disabled = locked;
    });
  }
  if (savePublishSettingsBtn) savePublishSettingsBtn.disabled = locked;
}

async function openPublishSettingsModal() {
  if (!publishSettingsModalMask) return;
  if (publishSettingsModalMessage) {
    publishSettingsModalMessage.style.color = "#2f3d63";
    publishSettingsModalMessage.textContent = "正在加载设置...";
  }
  const ok = await loadPublishSettings();
  // 只有加载成功才把服务端值填进表单；失败时既不填（避免把默认值/旧值当成当前设置呈现），
  // 也不允许保存（避免把未经验证的值写回服务端）。
  setPublishSettingsFormDisabled(!ok);
  if (ok) fillPublishSettingsForm();
  if (publishSettingsModalMessage) {
    publishSettingsModalMessage.style.color = ok ? "#5f7390" : "#c02030";
    publishSettingsModalMessage.textContent = ok ? "" : "加载设置失败，表单已锁定以免覆盖服务端配置；请关闭后重试";
  }
  publishSettingsModalMask.classList.remove("hidden");
}

function closePublishSettingsModal() {
  if (!publishSettingsModalMask) return;
  publishSettingsModalMask.classList.add("hidden");
}

function onPublishSettingsMaskClick(event) {
  if (event.target === publishSettingsModalMask) closePublishSettingsModal();
}

async function savePublishSettingsFromForm() {
  const skuPrefixByShopId = {};
  publishShopPrefixList?.querySelectorAll?.("[data-publish-shop-prefix]").forEach((input) => {
    const shopId = String(input.dataset.publishShopPrefix || "").trim();
    const prefix = String(input.value || "").trim();
    if (shopId && prefix) skuPrefixByShopId[shopId] = prefix;
  });
  const settings = {
    erpAutoPublishToYandex: Boolean(publishAutoToYandexToggle?.checked),
    erpAutoPublishToOzon: Boolean(publishAutoToOzonToggle?.checked),
    simulateBackendPublishToYandex: Boolean(publishSimulateToggle?.checked),
    skuPrefix: String(publishSkuPrefix?.value || "PUB").trim(),
    skuPrefixByShopId,
    skuSeparator: String(publishSkuSeparator?.value || "-"),
    skuIncludeSourceSku: Boolean(publishSkuIncludeSourceToggle?.checked),
    publishIntervalSeconds: Number(publishIntervalSeconds?.value || 0),
    dailyPublishLimit: Number(dailyPublishLimit?.value || 0),
    qualityGateEnabled: Boolean(publishQualityGateToggle?.checked),
    qualityMinScore: Number(publishQualityMinScore?.value || 0)
  };
  if (publishSettingsModalMessage) {
    publishSettingsModalMessage.style.color = "#2f3d63";
    publishSettingsModalMessage.textContent = "正在保存设置...";
  }
  const result = await apiRequest("/api/product-publish/settings", {
    method: "PUT",
    body: JSON.stringify({ settings })
  });
  if (!result.ok) {
    if (publishSettingsModalMessage) {
      publishSettingsModalMessage.style.color = "#c02030";
      publishSettingsModalMessage.textContent = result.error || "保存失败";
    }
    return;
  }
  state.publishSettings = {
    erpAutoPublishToYandex: result.data?.settings?.erpAutoPublishToYandex !== false,
    erpAutoPublishToOzon: Boolean(result.data?.settings?.erpAutoPublishToOzon),
    simulateBackendPublishToYandex: Boolean(result.data?.settings?.simulateBackendPublishToYandex),
    skuPrefix: String(result.data?.settings?.skuPrefix || "PUB"),
    skuPrefixByShopId: result.data?.settings?.skuPrefixByShopId || {},
    skuSeparator: String(result.data?.settings?.skuSeparator || "-"),
    skuIncludeSourceSku: result.data?.settings?.skuIncludeSourceSku !== false,
    publishIntervalSeconds: Number(result.data?.settings?.publishIntervalSeconds || 0),
    dailyPublishLimit: Number(result.data?.settings?.dailyPublishLimit || 0),
    // 这两个字段此前漏写：提交时有、回写时没有，于是保存成功后 state.publishSettings
    // 缺失质量门禁配置（要靠下次打开弹窗重新 GET 才补回来）。
    // 语义与 loadPublishSettings() 保持一致。
    qualityGateEnabled: result.data?.settings?.qualityGateEnabled !== false,
    qualityMinScore: Number(result.data?.settings?.qualityMinScore ?? 80)
  };
  if (publishSettingsModalMessage) {
    publishSettingsModalMessage.style.color = "#1d6f3a";
    publishSettingsModalMessage.textContent = "已保存";
  }
  closePublishSettingsModal();
  if (publishMessage) {
    publishMessage.style.color = "#1d6f3a";
    publishMessage.textContent = "产品上架设置已更新";
  }
}

// 在途守卫：双击「保存」或慢请求会先后发出两个 PUT。设置是全量覆盖，重复提交会把两次表单快照
// 依次写回服务端，后一次可能覆盖掉前一次之后别人做的改动。第二次直接报错返回，不再发请求。
async function onPublishSettingsSubmit(event) {
  event.preventDefault();
  if (isSavingPublishSettings) {
    if (publishSettingsModalMessage) {
      publishSettingsModalMessage.style.color = "#c02030";
      publishSettingsModalMessage.textContent = "正在保存设置，请勿重复提交";
    }
    return;
  }
  isSavingPublishSettings = true;
  try {
    await savePublishSettingsFromForm();
  } finally {
    isSavingPublishSettings = false;
  }
}

function setPublishImportMessage(message, success = false) {
  if (!publishImportMessage) return;
  publishImportMessage.style.color = success ? "#1d6f3a" : "#c02030";
  publishImportMessage.textContent = message || "";
}

function openPublishImportModal() {
  if (!publishImportModalMask) return;
  if (publishImportForm) publishImportForm.reset();
  renderPublishImportShopOptions();
  if (publishImportFileName) publishImportFileName.textContent = "未选择文件";
  if (publishImportMessage) {
    publishImportMessage.style.color = "#5f7390";
    publishImportMessage.textContent = "";
  }
  publishImportModalMask.classList.remove("hidden");
}

function closePublishImportModal() {
  if (!publishImportModalMask) return;
  publishImportModalMask.classList.add("hidden");
}

function onPublishImportMaskClick(event) {
  if (event.target === publishImportModalMask) closePublishImportModal();
}

function onPublishImportFileChange(event) {
  const file = event.target?.files?.[0] || null;
  if (publishImportFileName) {
    publishImportFileName.textContent = file ? `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)` : "未选择文件";
  }
}

async function onDownloadPublishImportTemplate() {
  const result = await fetchBinary("/api/product-publish/import-template");
  if (!result.ok) {
    setPublishImportMessage(result.error || "模板下载失败", false);
    return;
  }
  downloadBlob(result.blob, result.filename || "publish-import-template.xlsx");
  if (publishImportMessage) {
    publishImportMessage.style.color = "#1d6f3a";
    publishImportMessage.textContent = "模板已下载";
  }
}

async function onPublishImportSubmit(event) {
  event.preventDefault();
  const file = publishImportFileInput?.files?.[0] || null;
  if (!file) {
    setPublishImportMessage("请先选择导入文件", false);
    return;
  }
  if (submitPublishImportBtn) submitPublishImportBtn.disabled = true;
  if (publishImportMessage) {
    publishImportMessage.style.color = "#2f3d63";
    publishImportMessage.textContent = "正在导入产品...";
  }
  const shopId = String(publishImportShopSelect?.value || "").trim();
  const result = await uploadPublishImportFile(file, shopId);
  if (submitPublishImportBtn) submitPublishImportBtn.disabled = false;
  if (!result.ok) {
    setPublishImportMessage(result.error || "导入失败", false);
    return;
  }
  const data = result.data || {};
  const summary = `导入完成：新增 ${Number(data.created || 0)} 条，更新 ${Number(data.updated || 0)} 条，跳过 ${Number(data.unchanged || 0)} 条${Number(data.skippedLocked || 0) ? `，锁定跳过 ${Number(data.skippedLocked || 0)} 条` : ""}`;
  if (publishMessage) {
    publishMessage.style.color = "#1d6f3a";
    publishMessage.textContent = summary;
  }
  if (publishImportMessage) {
    publishImportMessage.style.color = "#1d6f3a";
    publishImportMessage.textContent = summary;
  }
  await loadPublishProducts();
  closePublishImportModal();
}

function getPublishProductsPage() {
  const pageSize = state.publishPageSize || DEFAULT_PUBLISH_PAGE_SIZE;
  const start = (state.publishCurrentPage - 1) * pageSize;
  return getPublishWorkspaceItems().slice(start, start + pageSize);
}

function renderPublishTable() {
  if (!publishTableBody) return;
  const workspaceItems = getPublishWorkspaceItems();
  updatePublishWorkspaceUi();
  if (!Array.isArray(workspaceItems) || !workspaceItems.length) {
    publishTableBody.innerHTML = "<tr><td colspan='14'>暂无数据</td></tr>";
    syncPublishSelectionUi();
    renderPublishPagination();
    syncPublishIslandScrollbarMetrics();
    return;
  }
  const items = getPublishProductsPage();
  publishTableBody.innerHTML = items
    .map((item) => {
      const id = escapeHtml(String(item.id || ""));
      const galleryImages = getPublishGalleryImages(item);
      const imageUrl = galleryImages[0] || "";
      const isLocked = isPublishRowLocked(item);
      const readonlyAttr = isLocked ? "readonly" : "";
      const checked = (state.publishSelectedIds || []).includes(String(item.id || "")) ? "checked" : "";
      const renderLockedValue = (value, placeholder = "-") => {
        const text = String(value ?? "").trim();
        return `<div class="publish-readonly-value">${escapeHtml(text || placeholder)}</div>`;
      };
      const renderLockedMultiline = (value, placeholder = "-") => {
        const text = String(value ?? "").trim();
        return `<div class="publish-readonly-value multiline">${escapeHtml(text || placeholder)}</div>`;
      };
      const publishStatus = String(item.publishStatus || item.lastPublishStatus || "").trim().toLowerCase();
      const publishAt = String(item.publishAt || item.lastPublishAt || "").trim();
      const publishShopName = resolvePublishShopName(item);
      const platformLabel = getPublishPlatformLabel(getPublishShopProvider(item) || String(item.publishPlatform || ""));
      const systemSku = item.systemSkuPending === true ? "" : String(item.systemSku || "").trim();
      const platformSku = item.platformSkuPending === true
        ? ""
        : String(item.platformSku || item.ozonPlatformSku || item.marketSku || item.offerId || item.ozonProductId || item.sku || "").trim();
      const publishStatusMap = {
        success: { label: "已发布", cls: "success" },
        failed: { label: "发布失败", cls: "failed" },
        partial: { label: "部分成功", cls: "pending" },
        pending: { label: "发布中", cls: "pending" }
      };
      const publishMeta = publishStatusMap[publishStatus] || { label: "未发布", cls: "idle" };
      return `
        <tr data-publish-row="${id}" data-publish-locked="${isLocked ? "1" : "0"}">
          <td><input type="checkbox" data-publish-select value="${id}" ${checked} /></td>
          <td>
            <div class="publish-product-cell">
              <div class="product-thumb small">
                ${
                  imageUrl
                    ? `<button type="button" class="publish-thumb-button" data-publish-preview="${escapeHtml(String(item.id || ""))}" aria-label="查看产品大图">
                        <img src="${escapeHtml(safeImageUrl(imageUrl))}" alt="img" loading="lazy" referrerpolicy="no-referrer" />
                        ${galleryImages.length > 1 ? `<span class="publish-thumb-count">${galleryImages.length}</span>` : ""}
                      </button>`
                    : `<span class="thumb-placeholder">无图</span>`
                }
              </div>
              <div class="publish-product-main">
                <div class="publish-product-text">
                  <div class="publish-product-line sku-line">
                    <span class="publish-product-label">系统SKU:</span>
                    ${isLocked ? `<div class="publish-readonly-value strong inline-value">${escapeHtml(systemSku || "-")}</div>` : `<input type="text" class="publish-inline-input sku-input" data-field="systemSku" value="${escapeHtml(systemSku)}" placeholder="绑定产品后填写" ${readonlyAttr} />`}
                  </div>
                  <div class="publish-product-line sku-line">
                    <span class="publish-product-label">平台SKU:</span>
                    ${renderLockedValue(platformSku, "-")}
                  </div>
                  <div class="publish-product-line title-line">
                    <span class="publish-product-label">标题:</span>
                    ${isLocked ? `<div class="publish-readonly-value title inline-value">${escapeHtml(item.title || "-")}</div>` : `<textarea class="publish-inline-input title-input" data-field="title" rows="3" placeholder="请输入标题" ${readonlyAttr}>${escapeHtml(item.title || "")}</textarea>`}
                  </div>
                </div>
              </div>
            </div>
          </td>
          <td>${isLocked ? renderLockedValue(item.salePrice) : `<input type="number" step="0.01" data-field="salePrice" value="${escapeHtml(item.salePrice ?? "")}" ${readonlyAttr} />`}</td>
          <td>${isLocked ? renderLockedValue(item.originalPrice) : `<input type="number" step="0.01" data-field="originalPrice" value="${escapeHtml(item.originalPrice ?? "")}" ${readonlyAttr} />`}</td>
          <td>${isLocked ? renderLockedValue(item.purchasePriceRmb) : `<input type="number" step="0.01" data-field="purchasePriceRmb" value="${escapeHtml(item.purchasePriceRmb ?? "")}" ${readonlyAttr} />`}</td>
          <td>${isLocked ? renderLockedValue(item.purchasePriceRub) : `<input type="number" step="0.01" data-field="purchasePriceRub" value="${escapeHtml(item.purchasePriceRub ?? "")}" ${readonlyAttr} />`}</td>
          <td>
            ${
              isLocked
                ? `
                  <div class="publish-readonly-dimensions">
                    ${renderLockedValue(item.packageLengthCm)}
                    ${renderLockedValue(item.packageWidthCm)}
                    ${renderLockedValue(item.packageHeightCm)}
                  </div>
                `
                : `
                  <div class="publish-dimensions">
                    <input type="number" step="0.01" data-field="packageLengthCm" value="${escapeHtml(item.packageLengthCm ?? "")}" placeholder="长" ${readonlyAttr} />
                    <input type="number" step="0.01" data-field="packageWidthCm" value="${escapeHtml(item.packageWidthCm ?? "")}" placeholder="宽" ${readonlyAttr} />
                    <input type="number" step="0.01" data-field="packageHeightCm" value="${escapeHtml(item.packageHeightCm ?? "")}" placeholder="高" ${readonlyAttr} />
                  </div>
                `
            }
          </td>
          <td>${isLocked ? renderLockedValue(item.weightKg) : `<input type="number" step="0.001" data-field="weightKg" value="${escapeHtml(item.weightKg ?? "")}" ${readonlyAttr} />`}</td>
          <td>${isLocked ? renderLockedValue(item.stockCount, "0") : `<input type="number" step="1" min="0" data-field="stockCount" value="${escapeHtml(item.stockCount ?? 0)}" ${readonlyAttr} />`}</td>
          <td>${isLocked ? renderLockedMultiline(item.description) : `<textarea data-field="description" placeholder="描述" ${readonlyAttr}>${escapeHtml(item.description || "")}</textarea>`}</td>
          <td>${isLocked ? renderLockedValue(item.collectedAt) : `<input type="text" data-field="collectedAt" value="${escapeHtml(item.collectedAt || "")}" placeholder="2026-03-02T10:20:30Z" ${readonlyAttr} />`}</td>
          <td>${renderLockedValue(publishShopName, "未设置店铺")}</td>
          <td>
            <div class="publish-status-block">
              <span class="publish-status-chip ${publishMeta.cls}">${publishMeta.label}</span>
              <div class="publish-status-meta">
                <span class="publish-platform-chip">${escapeHtml(platformLabel)}</span>
                ${publishAt ? `<div class="publish-status-time">${escapeHtml(publishAt)}</div>` : ""}
              </div>
              ${String(item.publishResultMessage || "").trim() ? `<div class="publish-status-message">${escapeHtml(String(item.publishResultMessage).trim())}</div>` : ""}
            </div>
          </td>
          <td>
            <div class="publish-row-actions">
              <button type="button" class="secondary-btn" data-publish-detail="${id}">详情</button>
              <button type="button" class="secondary-btn" data-publish-logs="${id}">日志</button>
              <button type="button" class="secondary-btn danger" data-publish-delete="${id}">删除</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
  syncPublishSelectionUi();
  syncPublishIslandScrollbarMetrics();
}

function syncPublishSelectionUi() {
  const total = getPublishWorkspaceItems().length;
  const selectedSet = new Set(state.publishSelectedIds || []);
  const selected = getPublishWorkspaceItems().filter((item) => selectedSet.has(String(item.id || ""))).length;
  const pageItems = getPublishProductsPage();
  const pageIds = pageItems.map((item) => String(item.id || "")).filter(Boolean);
  const selectedOnPage = pageIds.filter((id) => selectedSet.has(id)).length;
  if (publishSelectedCount) publishSelectedCount.textContent = `已选 ${selected} / ${total} 条`;
  if (publishSelectAll) {
    publishSelectAll.checked = pageIds.length > 0 && selectedOnPage === pageIds.length;
    publishSelectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < pageIds.length;
  }
}

function onPublishSelectAllChange(event) {
  const checked = Boolean(event.target?.checked);
  onPublishSelectAllButton(checked);
}

function onPublishSelectAllButton(forceChecked) {
  const pageItems = getPublishProductsPage();
  const pageIds = pageItems.map((item) => String(item.id || "")).filter(Boolean);
  const selected = new Set(state.publishSelectedIds || []);
  if (forceChecked) {
    pageIds.forEach((id) => selected.add(id));
  } else {
    pageIds.forEach((id) => selected.delete(id));
  }
  state.publishSelectedIds = Array.from(selected);
  renderPublishTable();
  renderPublishPagination();
}

function onPublishInvertSelect() {
  const pageItems = getPublishProductsPage();
  const pageIds = pageItems.map((item) => String(item.id || "")).filter(Boolean);
  const selected = new Set(state.publishSelectedIds || []);
  pageIds.forEach((id) => {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  });
  state.publishSelectedIds = Array.from(selected);
  renderPublishTable();
  renderPublishPagination();
}

function onPublishTableClick(event) {
  const detailBtn = event.target?.closest?.("[data-publish-detail]");
  if (detailBtn) return openPublishRecord(String(detailBtn.dataset.publishDetail || ""), "detail");
  const logsBtn = event.target?.closest?.("[data-publish-logs]");
  if (logsBtn) return openPublishRecord(String(logsBtn.dataset.publishLogs || ""), "logs");
  const deleteBtn = event.target?.closest?.("[data-publish-delete]");
  if (deleteBtn) return deleteSinglePublishProduct(String(deleteBtn.dataset.publishDelete || ""));
  const previewBtn = event.target?.closest?.("[data-publish-preview]");
  if (!previewBtn) return;
  const id = String(previewBtn.dataset.publishPreview || "");
  if (!id) return;
  const item = (state.publishProducts || []).find((entry) => String(entry?.id || "") === id);
  if (!item) return;
  openPublishGallery(item);
}

function closePublishRecordModal() {
  if (publishRecordModalMask) publishRecordModalMask.classList.add("hidden");
}

function formatPublishRecordValue(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

async function openPublishRecord(id, mode = "detail") {
  const item = (state.publishProducts || []).find((entry) => String(entry?.id || "") === id);
  if (!item || !publishRecordModalMask || !publishRecordModalContent) return;
  publishRecordModalMask.classList.remove("hidden");
  publishRecordModalTitle.textContent = mode === "logs" ? "刊登操作日志" : "刊登产品详情";
  publishRecordModalSubtitle.textContent = `${item.title || "未命名产品"} · ${item.systemSku || item.sku || id}`;
  publishRecordModalMessage.textContent = "";
  if (mode === "detail") {
    const fields = [
      ["产品ID", item.id], ["目标店铺", resolvePublishShopName(item)], ["系统SKU", item.systemSkuPending === true ? "" : item.systemSku],
      ["平台SKU", item.platformSku], ["来源SKU", item.sourceSku], ["标题", item.title], ["描述", item.description],
      ["售价", item.salePrice], ["划线价", item.originalPrice], ["采购价(RMB)", item.purchasePriceRmb],
      ["采购价(卢布)", item.purchasePriceRub], ["采购链接1", item.purchaseUrl], ["采购链接2", item.purchaseUrl2],
      ["重量(kg)", item.weightKg], ["包装尺寸", `${item.packageLengthCm || "-"} × ${item.packageWidthCm || "-"} × ${item.packageHeightCm || "-"} cm`],
      ["发布状态", item.publishStatus || "draft"], ["AI图片任务", item.aiTaskId || "未创建"], ["完整源数据", item.sourceProductSnapshot]
    ];
    publishRecordModalContent.innerHTML = `<div class="publish-detail-grid">${fields.map(([label, value]) => `<div class="publish-detail-row"><strong>${escapeHtml(label)}</strong><pre>${escapeHtml(formatPublishRecordValue(value))}</pre></div>`).join("")}</div>`;
    return;
  }
  publishRecordModalContent.innerHTML = "<div class='publish-record-loading'>日志加载中...</div>";
  const result = await apiRequest(`/api/product-publish/${encodeURIComponent(id)}/logs`, { method: "GET" });
  if (!result.ok) {
    publishRecordModalContent.innerHTML = "";
    publishRecordModalMessage.textContent = result.error || "日志加载失败";
    return;
  }
  const logs = result.data?.items || [];
  publishRecordModalContent.innerHTML = logs.length ? `<div class="publish-log-list">${logs.map((log) => `
    <article class="publish-log-item ${log.success ? "success" : "failed"}">
      <div class="publish-log-head"><strong>${escapeHtml(log.actionLabel || log.actionType || "操作")}</strong><span>${escapeHtml(new Date(log.ts).toLocaleString("zh-CN"))}</span></div>
      <div>操作人员：${escapeHtml(log.actorUsername || "system")}（${escapeHtml(log.actorRole || "system")}）</div>
      <div>结果：${log.success ? "成功" : `失败 - ${escapeHtml(log.errorMessage || "未知错误")}`}</div>
      ${log.recordText ? `<div>记录：${escapeHtml(log.recordText)}</div>` : ""}
    </article>`).join("")}</div>` : "<div class='publish-record-empty'>暂无操作日志</div>";
}

async function deleteSinglePublishProduct(id) {
  if (!id || !confirm("确认删除这条刊登产品？删除操作会保留在审计日志中。")) return;
  const result = await apiRequest("/api/product-publish", { method: "DELETE", body: JSON.stringify({ ids: [id] }) });
  if (!result.ok) {
    publishMessage.textContent = result.error || "删除失败";
    return;
  }
  state.publishSelectedIds = (state.publishSelectedIds || []).filter((value) => value !== id);
  await loadPublishProducts();
}

function onPublishTableChange(event) {
  const checkbox = event.target?.closest?.("input[data-publish-select]");
  if (!checkbox) return;
  const id = String(checkbox.value || "");
  if (!id) return;
  const set = new Set(state.publishSelectedIds || []);
  if (checkbox.checked) set.add(id);
  else set.delete(id);
  state.publishSelectedIds = Array.from(set);
  syncPublishSelectionUi();
}

function renderPublishPagination() {
  if (!publishPaginationInfo) return;
  const total = getPublishWorkspaceItems().length;
  const pageSize = state.publishPageSize || DEFAULT_PUBLISH_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (state.publishCurrentPage > totalPages) state.publishCurrentPage = totalPages;
  publishPaginationInfo.innerHTML = `${state.publishCurrentPage} <span class="page-sep">/</span> <span class="page-total">${totalPages}</span>`;
  if (publishPrevPageBtn) publishPrevPageBtn.disabled = state.publishCurrentPage <= 1;
  if (publishNextPageBtn) publishNextPageBtn.disabled = state.publishCurrentPage >= totalPages;
  if (publishGotoPage) publishGotoPage.value = String(state.publishCurrentPage);
}

function syncPublishIslandScrollbarMetrics() {
  if (!publishTableWrap || !publishIslandScrollbar || !publishIslandScrollbarInner) return;
  const clientWidth = Math.max(publishTableWrap.clientWidth || 0, 1);
  const scrollWidth = Math.max(publishTableWrap.scrollWidth || 0, clientWidth);
  const maxScrollLeft = Math.max(scrollWidth - clientWidth, 0);
  const shouldShow = scrollWidth > clientWidth + 2;
  if (!shouldShow) {
    publishIslandScrollbar.style.display = "none";
    publishIslandScrollbarInner.style.width = "0px";
    publishIslandScrollbarInner.style.transform = "translateX(0)";
    return;
  }
  const trackWidth = Math.max(publishIslandScrollbar.clientWidth || 0, clientWidth);
  const thumbWidth = Math.max(96, Math.round((clientWidth / scrollWidth) * trackWidth));
  const maxThumbLeft = Math.max(trackWidth - thumbWidth, 0);
  const ratio = maxScrollLeft > 0 ? (publishTableWrap.scrollLeft || 0) / maxScrollLeft : 0;
  const thumbLeft = Math.round(maxThumbLeft * ratio);
  publishIslandScrollbar.style.display = "block";
  publishIslandScrollbarInner.style.width = `${Math.min(thumbWidth, trackWidth)}px`;
  publishIslandScrollbarInner.style.transform = `translateX(${thumbLeft}px)`;
}

function syncPublishIslandScrollbarFromTable() {
  if (!publishTableWrap || !publishIslandScrollbar) return;
  if (isSyncingPublishScroll) return;
  isSyncingPublishScroll = true;
  syncPublishIslandScrollbarMetrics();
  isSyncingPublishScroll = false;
}

function syncPublishTableFromIslandScrollbar() {
  syncPublishIslandScrollbarMetrics();
}

function setPublishTableScrollByRatio(ratio) {
  if (!publishTableWrap) return;
  const scrollWidth = Math.max(publishTableWrap.scrollWidth || 0, publishTableWrap.clientWidth || 0);
  const clientWidth = Math.max(publishTableWrap.clientWidth || 0, 1);
  const maxScrollLeft = Math.max(scrollWidth - clientWidth, 0);
  publishTableWrap.scrollLeft = Math.max(0, Math.min(maxScrollLeft, Math.round(maxScrollLeft * ratio)));
  syncPublishTableFromIslandScrollbar();
}

function getPublishScrollbarMetrics() {
  if (!publishIslandScrollbar || !publishIslandScrollbarInner || !publishTableWrap) return null;
  const trackRect = publishIslandScrollbar.getBoundingClientRect();
  const thumbRect = publishIslandScrollbarInner.getBoundingClientRect();
  const clientWidth = Math.max(publishTableWrap.clientWidth || 0, 1);
  const scrollWidth = Math.max(publishTableWrap.scrollWidth || 0, clientWidth);
  const maxScrollLeft = Math.max(scrollWidth - clientWidth, 0);
  const maxThumbLeft = Math.max(trackRect.width - thumbRect.width, 0);
  return { trackRect, thumbRect, maxScrollLeft, maxThumbLeft };
}

function onPublishIslandScrollbarClick(event) {
  if (!publishIslandScrollbar || !publishIslandScrollbarInner || isDraggingPublishScrollbar) return;
  if (event.target === publishIslandScrollbarInner) return;
  const metrics = getPublishScrollbarMetrics();
  if (!metrics || metrics.maxThumbLeft <= 0) return;
  const clickX = event.clientX - metrics.trackRect.left;
  const nextThumbLeft = Math.max(0, Math.min(metrics.maxThumbLeft, clickX - metrics.thumbRect.width / 2));
  setPublishTableScrollByRatio(nextThumbLeft / metrics.maxThumbLeft);
}

function onPublishIslandScrollbarMouseDown(event) {
  if (!publishIslandScrollbarInner || event.target !== publishIslandScrollbarInner) return;
  const metrics = getPublishScrollbarMetrics();
  if (!metrics) return;
  isDraggingPublishScrollbar = true;
  publishScrollbarDragStartX = event.clientX;
  publishScrollbarDragStartLeft = metrics.thumbRect.left - metrics.trackRect.left;
  document.body.classList.add("publish-scrollbar-dragging");
  event.preventDefault();
}

function onPublishIslandScrollbarMouseMove(event) {
  if (!isDraggingPublishScrollbar) return;
  const metrics = getPublishScrollbarMetrics();
  if (!metrics || metrics.maxThumbLeft <= 0) return;
  const deltaX = event.clientX - publishScrollbarDragStartX;
  const nextThumbLeft = Math.max(0, Math.min(metrics.maxThumbLeft, publishScrollbarDragStartLeft + deltaX));
  setPublishTableScrollByRatio(nextThumbLeft / metrics.maxThumbLeft);
}

function onPublishIslandScrollbarMouseUp() {
  if (!isDraggingPublishScrollbar) return;
  isDraggingPublishScrollbar = false;
  document.body.classList.remove("publish-scrollbar-dragging");
}

function changePublishPage(nextPage) {
  const pageSize = state.publishPageSize || DEFAULT_PUBLISH_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(getPublishWorkspaceItems().length / pageSize));
  if (nextPage < 1 || nextPage > totalPages) return;
  state.publishCurrentPage = nextPage;
  renderPublishTable();
  renderPublishPagination();
}

function onPublishGotoPage() {
  if (!publishGotoPage) return;
  const value = Number(publishGotoPage.value);
  if (!Number.isFinite(value)) {
    renderPublishPagination();
    return;
  }
  changePublishPage(Math.floor(value));
}

function onPublishPageSizeChange() {
  if (!publishPageSize) return;
  const size = Number(publishPageSize.value);
  state.publishPageSize = Number.isFinite(size) ? size : DEFAULT_PUBLISH_PAGE_SIZE;
  state.publishCurrentPage = 1;
  renderPublishTable();
  renderPublishPagination();
}

function onPublishWorkspaceTabClick(event) {
  const btn = event.target?.closest?.("button[data-publish-tab]");
  if (!btn) return;
  state.publishWorkspaceTab = normalizePublishWorkspaceTab(btn.dataset.publishTab);
  state.publishCurrentPage = 1;
  prunePublishSelectionToWorkspace();
  updatePublishWorkspaceUi();
  renderPublishShopOptions();
  renderPublishTable();
  renderPublishPagination();
}

function onYandexPublishStatusFilterClick(event) {
  const button = event.target?.closest?.("button[data-yandex-publish-status]");
  if (!button) return;
  const value = String(button.dataset.yandexPublishStatus || "unpublished");
  if (!["unpublished", "error", "published"].includes(value)) return;
  state.yandexPublishStatusFilter = value;
  state.publishCurrentPage = 1;
  state.publishSelectedIds = [];
  renderPublishTable();
  renderPublishPagination();
}

function getPublishGalleryImages(item) {
  if (!item || typeof item !== "object") return [];
  const raw = []
    .concat(Array.isArray(item.pictures) ? item.pictures : [])
    .concat(Array.isArray(item.images) ? item.images : [])
    .concat([item.imageUrl, item.image, item.mainImage]);
  return normalizePublishImageUrls(raw);
}

function normalizePublishImageUrls(values) {
  const seen = new Set();
  const result = [];
  const source = Array.isArray(values) ? values : [values];
  for (const value of source) {
    const normalized = sanitizePublishImageUrl(value);
    if (!normalized) continue;
    const key = canonicalizePublishImageUrl(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function sanitizePublishImageUrl(value) {
  const raw = String(value || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "";
  if (/[<>{}]/.test(raw) || /(?:\);|url\(|box-shadow:|background-image:)/i.test(raw)) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  const path = `${parsed.pathname}${parsed.search}`.toLowerCase();
  if (/(?:^|[\/_-])(favicon|logo|sprite|icon)(?:[\/_.-]|$)/i.test(path)) return "";
  if (/(?:apple-touch-icon|android-chrome|mstile|sitewebmanifest)/i.test(path)) return "";
  return parsed.href;
}

function canonicalizePublishImageUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    if (/avatars\.mds\.yandex\.net$/i.test(parsed.hostname)) {
      parsed.pathname = parsed.pathname.replace(/\/(?:orig|9hq|hq|hqdefault|preview|small|medium|large)$/i, "");
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function openPublishGallery(item) {
  const images = getPublishGalleryImages(item);
  if (!publishGalleryModalMask || !publishGalleryImage || !images.length) return;
  state.publishGalleryImages = images;
  state.publishGalleryIndex = 0;
  renderPublishGallery();
  publishGalleryModalMask.classList.remove("hidden");
}

function closePublishGallery() {
  if (!publishGalleryModalMask) return;
  publishGalleryModalMask.classList.add("hidden");
  state.publishGalleryImages = [];
  state.publishGalleryIndex = 0;
  if (publishGalleryImage) {
    publishGalleryImage.src = "";
    publishGalleryImage.alt = "产品大图预览";
  }
  if (publishGalleryThumbs) publishGalleryThumbs.innerHTML = "";
}

function onPublishGalleryMaskClick(event) {
  if (event.target === publishGalleryModalMask) closePublishGallery();
}

function movePublishGallery(direction) {
  const images = Array.isArray(state.publishGalleryImages) ? state.publishGalleryImages : [];
  if (!images.length) return;
  const total = images.length;
  state.publishGalleryIndex = (state.publishGalleryIndex + direction + total) % total;
  renderPublishGallery();
}

function onPublishGalleryThumbClick(event) {
  const thumb = event.target?.closest?.("[data-gallery-index]");
  if (!thumb) return;
  const index = Number(thumb.dataset.galleryIndex);
  if (!Number.isInteger(index)) return;
  state.publishGalleryIndex = index;
  renderPublishGallery();
}

function renderPublishGallery() {
  const images = Array.isArray(state.publishGalleryImages) ? state.publishGalleryImages : [];
  if (!publishGalleryImage || !images.length) return;
  const index = Math.min(Math.max(state.publishGalleryIndex, 0), images.length - 1);
  state.publishGalleryIndex = index;
  const current = images[index];
  publishGalleryImage.src = current;
  publishGalleryImage.alt = `产品大图 ${index + 1}`;
  if (publishGalleryCounter) publishGalleryCounter.textContent = `${index + 1} / ${images.length}`;
  if (publishGalleryPrevBtn) publishGalleryPrevBtn.disabled = images.length <= 1;
  if (publishGalleryNextBtn) publishGalleryNextBtn.disabled = images.length <= 1;
  if (publishGalleryThumbs) {
    publishGalleryThumbs.innerHTML = images
      .map(
        (url, thumbIndex) => `
          <button
            type="button"
            class="publish-gallery-thumb${thumbIndex === index ? " active" : ""}"
            data-gallery-index="${thumbIndex}"
            aria-label="查看第 ${thumbIndex + 1} 张图"
          >
            <img src="${escapeHtml(safeImageUrl(url))}" alt="缩略图 ${thumbIndex + 1}" loading="lazy" referrerpolicy="no-referrer" />
          </button>
        `
      )
      .join("");
  }
}

function onPublishGalleryKeydown(event) {
  if (!publishGalleryModalMask || publishGalleryModalMask.classList.contains("hidden")) return;
  if (event.key === "Escape") {
    closePublishGallery();
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    movePublishGallery(-1);
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    movePublishGallery(1);
  }
}

function onPublishFieldBlur(event) {
  const fieldEl = event.target?.closest?.("[data-field]");
  if (!fieldEl) return;
  const row = fieldEl.closest("tr[data-publish-row]");
  if (!row) return;
  if (row.dataset.publishLocked === "1") return;
  const id = String(row.dataset.publishRow || "");
  if (!id) return;
  savePublishRow(id, row);
}

async function savePublishRow(id, rowEl) {
  if (rowEl?.dataset?.publishLocked === "1") return;
  const currentItem = (state.publishProducts || []).find((x) => String(x.id) === String(id)) || {};
  const payload = {
    systemSku: readPublishField(rowEl, "systemSku"),
    platformSku: String(currentItem.platformSku || currentItem.marketSku || currentItem.offerId || currentItem.sku || "").trim(),
    sku: String(currentItem.sku || currentItem.platformSku || "").trim(),
    title: readPublishField(rowEl, "title"),
    salePrice: toNullableNumber(readPublishField(rowEl, "salePrice")),
    originalPrice: toNullableNumber(readPublishField(rowEl, "originalPrice")),
    purchasePriceRmb: toNullableNumber(readPublishField(rowEl, "purchasePriceRmb")),
    purchasePriceRub: toNullableNumber(readPublishField(rowEl, "purchasePriceRub")),
    packageLengthCm: toNullableNumber(readPublishField(rowEl, "packageLengthCm")),
    packageWidthCm: toNullableNumber(readPublishField(rowEl, "packageWidthCm")),
    packageHeightCm: toNullableNumber(readPublishField(rowEl, "packageHeightCm")),
    weightKg: toNullableNumber(readPublishField(rowEl, "weightKg")),
    stockCount: Math.max(0, Math.floor(Number(readPublishField(rowEl, "stockCount") || 0))),
    description: readPublishField(rowEl, "description"),
    collectedAt: readPublishField(rowEl, "collectedAt"),
    shopId: String(currentItem.shopId || "").trim(),
    publishPlatform: normalizePublishWorkspaceTab(state.publishWorkspaceTab),
    publishStatus: String(currentItem.publishStatus || "draft"),
    publishResultMessage: String(currentItem.publishResultMessage || ""),
    publishAt: String(currentItem.publishAt || "")
  };
  const result = await apiRequest(`/api/product-publish/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ item: payload })
  });
  if (!result.ok) {
    if (publishMessage) {
      publishMessage.style.color = "#c02030";
      publishMessage.textContent = result.error || "保存失败";
    }
    return;
  }
  const idx = (state.publishProducts || []).findIndex((x) => String(x.id) === id);
  if (idx >= 0 && result.data?.item) state.publishProducts[idx] = result.data.item;
  if (publishMessage) {
    publishMessage.style.color = "#1d6f3a";
    publishMessage.textContent = "已保存";
  }
}

function readPublishField(rowEl, field) {
  const el = rowEl.querySelector(`[data-field="${field}"]`);
  return String(el?.value || "").trim();
}

function toNullableNumber(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const num = Number(text.replace(",", "."));
  return Number.isFinite(num) ? num : null;
}

function getEnabledPublishShops() {
  const provider = getPublishWorkspaceShopProvider();
  return (state.shops || [])
    .filter((shop) => {
      const shopProvider = String(shop?.provider || "").toLowerCase();
      if (provider === "ozon") return shopProvider === "ozon" && Boolean(shop?.enabled);
      return (shopProvider === "yandex_market" || shopProvider === "yandex") && Boolean(shop?.enabled);
    })
    .filter((shop) => String(shop?.id || "").trim());
}

async function onPublishAddEmpty() {
  const selectedShopId = String(publishShopSelect?.value || "").trim();
  const enabledShops = getEnabledPublishShops();
  const shopId = selectedShopId || (enabledShops.length === 1 ? String(enabledShops[0].id || "").trim() : "");
  const publishPlatform = normalizePublishWorkspaceTab(state.publishWorkspaceTab);
  if (!shopId && enabledShops.length > 1) {
    if (publishMessage) {
      publishMessage.style.color = "#c02030";
      publishMessage.textContent = "请先选择店铺，再新增空白商品";
    }
    return;
  }
  const result = await apiRequest("/api/product-publish", {
    method: "POST",
    body: JSON.stringify({ item: { collectedAt: new Date().toISOString(), shopId, publishPlatform, publishStatus: "draft" } })
  });
  if (!result.ok) {
    if (publishMessage) {
      publishMessage.style.color = "#c02030";
      publishMessage.textContent = result.error || "新增失败";
    }
    return;
  }
  await loadPublishProducts();
}

async function onPublishDelete() {
  if (!Array.isArray(state.publishSelectedIds) || !state.publishSelectedIds.length) {
    if (publishMessage) {
      publishMessage.style.color = "#c02030";
      publishMessage.textContent = "请先选择一条或多条数据";
    }
    return;
  }
  const result = await apiRequest("/api/product-publish", {
    method: "DELETE",
    body: JSON.stringify({ ids: state.publishSelectedIds })
  });
  if (!result.ok) {
    if (publishMessage) {
      publishMessage.style.color = "#c02030";
      publishMessage.textContent = result.error || "删除失败";
    }
    return;
  }
  state.publishSelectedIds = [];
  await loadPublishProducts();
}

async function onPublishBulkStock() {
  const ids = Array.isArray(state.publishSelectedIds) ? state.publishSelectedIds.filter(Boolean) : [];
  if (!ids.length) {
    publishMessage.style.color = "#c02030";
    publishMessage.textContent = "请先勾选要设置库存的产品";
    return;
  }
  const input = prompt(`为已选 ${ids.length} 个产品设置统一库存（请输入 0 或正整数）`, "0");
  if (input === null) return;
  const stockCount = Number(input);
  if (!Number.isInteger(stockCount) || stockCount < 0) {
    publishMessage.style.color = "#c02030";
    publishMessage.textContent = "库存必须是 0 或正整数";
    return;
  }
  const result = await apiRequest("/api/product-publish/bulk-stock", {
    method: "POST",
    body: JSON.stringify({ ids, stockCount })
  });
  if (!result.ok) {
    publishMessage.style.color = "#c02030";
    publishMessage.textContent = result.error || "批量设置库存失败";
    return;
  }
  publishMessage.style.color = "#1d6f3a";
  publishMessage.textContent = `已为 ${Number(result.data?.updated || 0)} 个产品设置库存 ${stockCount}`;
  await loadPublishProducts();
}

async function onPublishToYandex() {
  if (!Array.isArray(state.publishSelectedIds) || !state.publishSelectedIds.length) {
    if (publishMessage) {
      publishMessage.style.color = "#c02030";
      publishMessage.textContent = "请先选择要发布的数据";
    }
    return;
  }
  const currentTab = normalizePublishWorkspaceTab(state.publishWorkspaceTab);
  const isOzon = currentTab === "ozon";
  if (!isOzon && window.YandexPublishPanel?.publish) {
    await window.YandexPublishPanel.publish({
      selectedIds: state.publishSelectedIds,
      shopId: String(publishShopSelect?.value || "").trim(),
      getItems: getPublishWorkspaceItems,
      getProvider: getPublishShopProvider,
      apiRequest,
      reload: loadPublishProducts,
      markPublishing(ids) {
        const idSet = new Set(ids.map(String));
        (state.publishProducts || []).forEach((item) => {
          if (idSet.has(String(item?.id || ""))) item.publishStatus = "pending";
        });
        renderPublishTable();
      },
      notify(level, message) {
        if (!publishMessage) return;
        publishMessage.style.color = level === "error" ? "#c02030" : level === "warning" ? "#b45c00" : "#1d6f3a";
        publishMessage.textContent = message;
      }
    });
    return;
  }
  // Ozon 与「Yandex 面板未加载」都走这条通用分支。它此前没有任何在途守卫：双击或慢请求会提交
  // 两次刊登，在平台侧产生重复 offer（Yandex 面板那条路径另有自己的 publishing 守卫）。
  if (isPublishingProducts) {
    if (publishMessage) {
      publishMessage.style.color = "#c02030";
      publishMessage.textContent = "正在发布，请勿重复提交";
    }
    return;
  }
  const endpoint = isOzon ? "/api/product-publish/publish-ozon" : "/api/product-publish/publish-yandex";
  const platformLabel = isOzon ? "Ozon" : "Yandex";
  const shopId = String(publishShopSelect?.value || "").trim();
  const publishableIds = new Set(
    getPublishWorkspaceItems()
      .filter((item) => {
        const provider = getPublishShopProvider(item);
        const platform = String(item.publishPlatform || "").trim().toLowerCase();
        if (isOzon) return provider === "ozon" || platform === "ozon";
        return provider === "yandex_market" || provider === "yandex" || platform === "yandex";
      })
      .map((item) => String(item.id || "").trim())
      .filter(Boolean)
  );
  const publishIds = state.publishSelectedIds.filter((id) => publishableIds.has(String(id || "").trim()));
  if (!publishIds.length) {
    if (publishMessage) {
      publishMessage.style.color = "#c02030";
      publishMessage.textContent = `当前页签没有可发布的 ${platformLabel} 产品`;
    }
    return;
  }
  isPublishingProducts = true;
  let result;
  try {
    result = await apiRequest(endpoint, {
      method: "POST",
      body: JSON.stringify({ ids: publishIds, shopId })
    });
  } finally {
    isPublishingProducts = false;
  }
  if (!result.ok) {
    if (publishMessage) {
      publishMessage.style.color = "#c02030";
      publishMessage.textContent = result.error || "发布失败";
    }
    return;
  }
  const success = Number(result.data?.success || 0);
  const processing = Number(result.data?.processing || 0);
  const failed = Number(result.data?.failed || 0);
  if (publishMessage) {
    publishMessage.style.color = failed > 0 ? "#b45c00" : "#1d6f3a";
    publishMessage.textContent = `${platformLabel} 发布完成：成功 ${success} 条，处理中 ${processing} 条，失败 ${failed} 条`;
    const qualityErrors = (Array.isArray(result.data?.errors) ? result.data.errors : [])
      .filter((entry) => String(entry?.stage || "") === "quality" && entry?.message)
      .map((entry) => String(entry.message));
    if (qualityErrors.length) {
      publishMessage.textContent += `（卡片质量拦截：${qualityErrors.join("；")}）`;
    }
  }
  await loadPublishProducts();
}

function isCollectorPublishSource(source) {
  const normalized = String(source || "").trim().toLowerCase();
  return normalized === "collector_extension" || normalized === "collector" || normalized === "browser_extension";
}

function isPublishRowLocked(item) {
  if (!item || typeof item !== "object") return false;
  if (isCollectorPublishSource(item.source)) return true;

  const collectUrl = String(item.collectUrl || "").trim().toLowerCase();
  if (collectUrl.includes("ozon.ru/product/") || collectUrl.includes("ozon.kz/product/")) return true;

  return false;
}

// 从 app.js 下沉的 DOM 常量与事件绑定。

const publishRefreshBtn = document.getElementById("publishRefreshBtn");
const publishAddEmptyBtn = document.getElementById("publishAddEmptyBtn");
const publishBulkStockBtn = document.getElementById("publishBulkStockBtn");
const publishDeleteBtn = document.getElementById("publishDeleteBtn");
const publishToYandexBtn = document.getElementById("publishToYandexBtn");
const publishSettingsBtn = document.getElementById("publishSettingsBtn");
const publishWorkspaceTitle = document.getElementById("publishWorkspaceTitle");
const publishWorkspaceDescription = document.getElementById("publishWorkspaceDescription");
const publishWorkspaceTabs = document.getElementById("publishWorkspaceTabs");
const yandexPublishStatusFilters = document.getElementById("yandexPublishStatusFilters");
const publishImportBtn = document.getElementById("publishImportBtn");
const publishShopSelect = document.getElementById("publishShopSelect");
const publishMessage = document.getElementById("publishMessage");
const publishSelectAll = document.getElementById("publishSelectAll");
const publishTableWrap = document.getElementById("publishTableWrap");
const publishTableBody = document.getElementById("publishTableBody");
const publishSelectedCount = document.getElementById("publishSelectedCount");
const publishSelectAllBtn = document.getElementById("publishSelectAllBtn");
const publishInvertSelectBtn = document.getElementById("publishInvertSelectBtn");
const publishFooterDeleteBtn = document.getElementById("publishFooterDeleteBtn");
const publishPrevPageBtn = document.getElementById("publishPrevPageBtn");
const publishNextPageBtn = document.getElementById("publishNextPageBtn");
const publishPaginationInfo = document.getElementById("publishPaginationInfo");
const publishGotoPage = document.getElementById("publishGotoPage");
const publishPageSize = document.getElementById("publishPageSize");
const publishIslandScrollbar = document.getElementById("publishIslandScrollbar");
const publishIslandScrollbarInner = document.getElementById("publishIslandScrollbarInner");
const publishGalleryModalMask = document.getElementById("publishGalleryModalMask");
const closePublishGalleryBtn = document.getElementById("closePublishGalleryBtn");
const publishGalleryPrevBtn = document.getElementById("publishGalleryPrevBtn");
const publishGalleryNextBtn = document.getElementById("publishGalleryNextBtn");
const publishGalleryImage = document.getElementById("publishGalleryImage");
const publishGalleryCounter = document.getElementById("publishGalleryCounter");
const publishRecordModalMask = document.getElementById("publishRecordModalMask");
const closePublishRecordModalBtn = document.getElementById("closePublishRecordModalBtn");
const publishRecordModalTitle = document.getElementById("publishRecordModalTitle");
const publishRecordModalSubtitle = document.getElementById("publishRecordModalSubtitle");
const publishRecordModalContent = document.getElementById("publishRecordModalContent");
const publishRecordModalMessage = document.getElementById("publishRecordModalMessage");
const publishGalleryThumbs = document.getElementById("publishGalleryThumbs");
const publishSettingsModalMask = document.getElementById("publishSettingsModalMask");
const closePublishSettingsModalBtn = document.getElementById("closePublishSettingsModalBtn");
const cancelPublishSettingsBtn = document.getElementById("cancelPublishSettingsBtn");
const publishSettingsForm = document.getElementById("publishSettingsForm");
const savePublishSettingsBtn = document.getElementById("savePublishSettingsBtn");
const publishAutoToYandexToggle = document.getElementById("publishAutoToYandexToggle");
const publishAutoToOzonToggle = document.getElementById("publishAutoToOzonToggle");
const publishSimulateToggle = document.getElementById("publishSimulateToggle");
const publishSkuPrefix = document.getElementById("publishSkuPrefix");
const publishShopPrefixList = document.getElementById("publishShopPrefixList");
const publishSkuSeparator = document.getElementById("publishSkuSeparator");
const publishSkuIncludeSourceToggle = document.getElementById("publishSkuIncludeSourceToggle");
const publishIntervalSeconds = document.getElementById("publishIntervalSeconds");
const dailyPublishLimit = document.getElementById("dailyPublishLimit");
const publishQualityGateToggle = document.getElementById("publishQualityGateToggle");
const publishQualityMinScore = document.getElementById("publishQualityMinScore");
const publishSettingsModalMessage = document.getElementById("publishSettingsModalMessage");
const publishImportModalMask = document.getElementById("publishImportModalMask");
const closePublishImportModalBtn = document.getElementById("closePublishImportModalBtn");
const cancelPublishImportBtn = document.getElementById("cancelPublishImportBtn");
const publishImportForm = document.getElementById("publishImportForm");
const publishImportShopSelect = document.getElementById("publishImportShopSelect");
const publishImportFileInput = document.getElementById("publishImportFileInput");
const publishImportFileName = document.getElementById("publishImportFileName");
const publishImportMessage = document.getElementById("publishImportMessage");
const downloadPublishImportTemplateBtn = document.getElementById("downloadPublishImportTemplateBtn");
const submitPublishImportBtn = document.getElementById("submitPublishImportBtn");
let isSyncingPublishScroll = false;
let isDraggingPublishScrollbar = false;
let publishScrollbarDragStartX = 0;
let publishScrollbarDragStartLeft = 0;
// 在途守卫（防重复提交）：刊登重复提交会在平台侧产生重复 offer；库存是增量操作，重复提交会加两次。
let isSavingPublishSettings = false;
let isPublishingProducts = false;

function bindPublishProductsEvents() {
  if (publishRefreshBtn) publishRefreshBtn.addEventListener("click", loadPublishProducts);
  if (publishAddEmptyBtn) publishAddEmptyBtn.addEventListener("click", onPublishAddEmpty);
  if (publishBulkStockBtn) publishBulkStockBtn.addEventListener("click", onPublishBulkStock);
  if (publishDeleteBtn) publishDeleteBtn.addEventListener("click", onPublishDelete);
  if (publishToYandexBtn) publishToYandexBtn.addEventListener("click", onPublishToYandex);
  if (publishSettingsBtn) publishSettingsBtn.addEventListener("click", openPublishSettingsModal);
  if (publishImportBtn) publishImportBtn.addEventListener("click", openPublishImportModal);
  if (publishWorkspaceTabs) publishWorkspaceTabs.addEventListener("click", onPublishWorkspaceTabClick);
  if (yandexPublishStatusFilters) yandexPublishStatusFilters.addEventListener("click", onYandexPublishStatusFilterClick);
  if (publishTableBody) publishTableBody.addEventListener("click", onPublishTableClick);
  if (publishTableBody) publishTableBody.addEventListener("change", onPublishTableChange);
  if (publishTableBody) publishTableBody.addEventListener("blur", onPublishFieldBlur, true);
  if (publishSelectAll) publishSelectAll.addEventListener("change", onPublishSelectAllChange);
  if (publishSelectAllBtn) publishSelectAllBtn.addEventListener("click", () => onPublishSelectAllButton(true));
  if (publishInvertSelectBtn) publishInvertSelectBtn.addEventListener("click", onPublishInvertSelect);
  if (publishFooterDeleteBtn) publishFooterDeleteBtn.addEventListener("click", onPublishDelete);
  if (publishPrevPageBtn) publishPrevPageBtn.addEventListener("click", () => changePublishPage(state.publishCurrentPage - 1));
  if (publishNextPageBtn) publishNextPageBtn.addEventListener("click", () => changePublishPage(state.publishCurrentPage + 1));
  if (publishGotoPage) publishGotoPage.addEventListener("change", onPublishGotoPage);
  if (publishPageSize) publishPageSize.addEventListener("change", onPublishPageSizeChange);
  if (publishTableWrap) publishTableWrap.addEventListener("scroll", syncPublishIslandScrollbarFromTable);
  if (publishIslandScrollbar) {
  publishIslandScrollbar.addEventListener("click", onPublishIslandScrollbarClick);
  publishIslandScrollbar.addEventListener("mousedown", onPublishIslandScrollbarMouseDown);
  }
  if (closePublishSettingsModalBtn) closePublishSettingsModalBtn.addEventListener("click", closePublishSettingsModal);
  if (cancelPublishSettingsBtn) cancelPublishSettingsBtn.addEventListener("click", closePublishSettingsModal);
  if (publishSettingsModalMask) publishSettingsModalMask.addEventListener("click", onPublishSettingsMaskClick);
  if (publishSettingsForm) publishSettingsForm.addEventListener("submit", onPublishSettingsSubmit);
  if (closePublishImportModalBtn) closePublishImportModalBtn.addEventListener("click", closePublishImportModal);
  if (cancelPublishImportBtn) cancelPublishImportBtn.addEventListener("click", closePublishImportModal);
  if (publishImportModalMask) publishImportModalMask.addEventListener("click", onPublishImportMaskClick);
  if (publishImportForm) publishImportForm.addEventListener("submit", onPublishImportSubmit);
  if (publishImportFileInput) publishImportFileInput.addEventListener("change", onPublishImportFileChange);
  if (downloadPublishImportTemplateBtn) downloadPublishImportTemplateBtn.addEventListener("click", onDownloadPublishImportTemplate);
  document.addEventListener("mousemove", onPublishIslandScrollbarMouseMove);
  document.addEventListener("mouseup", onPublishIslandScrollbarMouseUp);
  if (closePublishGalleryBtn) closePublishGalleryBtn.addEventListener("click", closePublishGallery);
  if (publishGalleryModalMask) publishGalleryModalMask.addEventListener("click", onPublishGalleryMaskClick);
  if (publishGalleryPrevBtn) publishGalleryPrevBtn.addEventListener("click", () => movePublishGallery(-1));
  if (publishGalleryNextBtn) publishGalleryNextBtn.addEventListener("click", () => movePublishGallery(1));
  if (publishGalleryThumbs) publishGalleryThumbs.addEventListener("click", onPublishGalleryThumbClick);
  if (closePublishRecordModalBtn) closePublishRecordModalBtn.addEventListener("click", closePublishRecordModal);
  if (publishRecordModalMask) publishRecordModalMask.addEventListener("click", (event) => {
  if (event.target === publishRecordModalMask) closePublishRecordModal();
  });
  window.addEventListener("resize", syncPublishIslandScrollbarMetrics);
  document.addEventListener("keydown", onPublishGalleryKeydown);
}
