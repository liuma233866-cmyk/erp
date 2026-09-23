function getCategoryMappingPlatform() {
  const normalized = String(categoryMappingPlatformFilter?.value || state.categoryMappingPlatform || "ozon").trim().toLowerCase() || "ozon";
  state.categoryMappingPlatform = normalized;
  if (categoryMappingPlatformFilter && categoryMappingPlatformFilter.value !== normalized) {
    categoryMappingPlatformFilter.value = normalized;
  }
  return normalized;
}

function getCategoryMappingPlatformLabel(value) {
  const platform = String(value || "").trim().toLowerCase();
  if (platform === "ozon") return "Ozon";
  if (platform === "1688") return "1688";
  if (platform === "yandex_market") return "Yandex";
  return platform || "未知平台";
}

function getCategoryMappingShopName(shopId) {
  const id = String(shopId || "").trim();
  if (!id) return "全部店铺";
  const shop = (state.shops || []).find((item) => String(item.id || "") === id);
  return shop?.name || shop?.code || id;
}

function getCategoryMappingRuleName(rule) {
  const name = String(rule?.name || "").trim();
  if (name) return name;
  const source = String(rule?.sourceCategoryPath || "").trim();
  const keyword = Array.isArray(rule?.keywords) && rule.keywords.length ? String(rule.keywords[0] || "").trim() : String(rule?.keyword || "").trim();
  const target = String(rule?.categoryName || rule?.categoryPath || rule?.categoryId || "").trim();
  return [source, keyword, target].filter(Boolean).join(" / ") || "未命名规则";
}

function renderCategoryMappingSummary() {
  const ruleCount = Array.isArray(state.categoryMappingRules) ? state.categoryMappingRules.length : 0;
  const sampleCount = Array.isArray(state.categoryMappingSamples) ? state.categoryMappingSamples.length : 0;
  if (categoryMappingRuleCount) categoryMappingRuleCount.textContent = String(ruleCount);
  if (categoryMappingSampleCount) categoryMappingSampleCount.textContent = String(sampleCount);
  if (categoryMappingFetchedAt) {
    categoryMappingFetchedAt.textContent = state.categoryMappingFetchedAt ? formatDateTime(state.categoryMappingFetchedAt) : "-";
  }
}
async function loadCategoryMappingKnowledge(options = {}) {
  if (!can("productSync")) return false;
  const platform = String(options.platform || getCategoryMappingPlatform() || "ozon").trim().toLowerCase() || "ozon";
  state.categoryMappingPlatform = platform;
  if (categoryMappingPlatformFilter) categoryMappingPlatformFilter.value = platform;
  if (categoryMappingMessage && !options.silent) {
    categoryMappingMessage.style.color = "#2f3d63";
    categoryMappingMessage.textContent = "正在加载类目映射规则和学习样本...";
  }
  const result = await apiRequest(`/api/category-mapping/rules?platform=${encodeURIComponent(platform)}`, { method: "GET" });
  if (!result.ok) {
    state.categoryMappingRules = [];
    state.categoryMappingSamples = [];
    state.categoryMappingFetchedAt = "";
    renderCategoryMappingSummary();
    renderCategoryMappingRulesTable();
    renderCategoryMappingSamplesTable();
    if (categoryMappingMessage) {
      categoryMappingMessage.style.color = "#c02030";
      categoryMappingMessage.textContent = result.error || "类目映射数据加载失败";
    }
    return false;
  }
  state.categoryMappingRules = Array.isArray(result.data?.rules) ? result.data.rules : [];
  state.categoryMappingSamples = Array.isArray(result.data?.samples) ? result.data.samples : [];
  state.categoryMappingFetchedAt = String(result.data?.fetchedAt || "").trim();
  renderCategoryMappingSummary();
  renderCategoryMappingRulesTable();
  renderCategoryMappingSamplesTable();
  if (categoryMappingMessage) {
    categoryMappingMessage.style.color = "#2f3d63";
    categoryMappingMessage.textContent = `已加载 ${state.categoryMappingRules.length} 条共享规则，${state.categoryMappingSamples.length} 条学习样本`;
  }
  return true;
}

function renderCategoryMappingRuleShopOptions() {
  if (!categoryMappingRuleShopId) return;
  const scopeShops = Array.isArray(state.shops) ? state.shops : [];
  categoryMappingRuleShopId.innerHTML = [
    "<option value=''>全部店铺</option>",
    ...scopeShops.map((shop) => `<option value="${escapeHtml(String(shop.id || ""))}">${escapeHtml(String(shop.name || shop.code || shop.id || ""))}</option>`)
  ].join("");
}

function openCategoryMappingRuleModal(rule = null, sample = null) {
  if (!categoryMappingRuleModalMask) return;
  renderCategoryMappingRuleShopOptions();
  activeCategoryMappingRuleId = String(rule?.id || "").trim();
  if (categoryMappingRuleForm) categoryMappingRuleForm.reset();
  if (categoryMappingRuleShopId) categoryMappingRuleShopId.value = "";
  const platform = String(rule?.platform || sample?.platform || getCategoryMappingPlatform() || "ozon").trim().toLowerCase() || "ozon";
  if (categoryMappingRuleModalTitle) {
    categoryMappingRuleModalTitle.textContent = activeCategoryMappingRuleId ? "修改类目映射规则" : (sample ? "从学习样本生成规则" : "添加类目映射规则");
  }
  if (categoryMappingRuleSubmitBtn) {
    categoryMappingRuleSubmitBtn.textContent = activeCategoryMappingRuleId ? "保存修改" : "确认添加";
  }
  if (categoryMappingRuleForm) {
    const setValue = (name, value) => {
      const field = categoryMappingRuleForm.elements.namedItem(name);
      if (field) field.value = value ?? "";
    };
    const keywords = Array.isArray(rule?.keywords) && rule.keywords.length
      ? rule.keywords
      : (Array.isArray(sample?.keywords) ? sample.keywords : []);
    const excludedKeywords = Array.isArray(rule?.excludedKeywords) ? rule.excludedKeywords : [];
    const derivedName = rule
      ? getCategoryMappingRuleName(rule)
      : `${getCategoryMappingPlatformLabel(platform)} ${String(sample?.categoryName || sample?.categoryPath || "类目映射").trim()}`.trim();
    setValue("name", rule?.name || derivedName);
    setValue("priority", rule?.priority || 50);
    setValue("platform", platform);
    setValue("shopId", rule?.shopId || sample?.shopId || "");
    setValue("sourceCategoryPath", rule?.sourceCategoryPath || sample?.sourceCategoryPath || "");
    setValue("keywords", keywords.join("\n"));
    setValue("excludedKeywords", excludedKeywords.join("\n"));
    setValue("categoryId", rule?.categoryId || sample?.categoryId || "");
    setValue("categoryName", rule?.categoryName || sample?.categoryName || "");
    setValue("categoryPath", rule?.categoryPath || sample?.categoryPath || "");
    setValue("notes", rule?.notes || "");
  }
  categoryMappingRuleModalMask.classList.remove("hidden");
}

function closeCategoryMappingRuleModal() {
  activeCategoryMappingRuleId = "";
  if (categoryMappingRuleModalTitle) categoryMappingRuleModalTitle.textContent = "添加类目映射规则";
  if (categoryMappingRuleSubmitBtn) categoryMappingRuleSubmitBtn.textContent = "确认添加";
  if (categoryMappingRuleModalMask) categoryMappingRuleModalMask.classList.add("hidden");
}

function onCategoryMappingRuleModalMaskClick(event) {
  if (event.target === categoryMappingRuleModalMask) closeCategoryMappingRuleModal();
}

function renderCategoryMappingRulesTable() {
  if (!categoryMappingRulesTableBody) return;
  const rules = Array.isArray(state.categoryMappingRules) ? state.categoryMappingRules : [];
  if (!rules.length) {
    categoryMappingRulesTableBody.innerHTML = "<tr><td colspan='7'>还没有共享规则</td></tr>";
    return;
  }
  categoryMappingRulesTableBody.innerHTML = [...rules]
    .sort((a, b) => {
      const enabledDiff = Number(b.enabled !== false) - Number(a.enabled !== false);
      if (enabledDiff !== 0) return enabledDiff;
      const priorityDiff = (Number(a.priority || 50) || 50) - (Number(b.priority || 50) || 50);
      if (priorityDiff !== 0) return priorityDiff;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    })
    .map((rule) => {
      const keywords = Array.isArray(rule.keywords) ? rule.keywords.filter(Boolean) : [];
      const excludedKeywords = Array.isArray(rule.excludedKeywords) ? rule.excludedKeywords.filter(Boolean) : [];
      const targetPath = String(rule.categoryPath || "").trim();
      const targetLabel = String(rule.categoryName || "").trim() || (targetPath ? targetPath.split(/\s*>\s*/).pop() || "" : "");
      return `
        <tr data-category-mapping-rule-id="${escapeHtml(String(rule.id || ""))}">
          <td>
            <div class="review-rule-enabled-cell">
              <label class="pill-switch review-rule-switch" aria-label="切换类目映射规则启用状态">
                <input type="checkbox" data-category-mapping-rule-enable="${escapeHtml(String(rule.id || ""))}" ${rule.enabled !== false ? "checked" : ""} />
                <span class="pill-slider"></span>
              </label>
              <span class="review-rule-enabled-text ${rule.enabled !== false ? "is-enabled" : "is-disabled"}">${rule.enabled !== false ? "已启用" : "已关闭"}</span>
            </div>
          </td>
          <td>
            <div class="category-mapping-rule-title">${escapeHtml(getCategoryMappingRuleName(rule))}</div>
            <div class="category-mapping-meta">${escapeHtml(getCategoryMappingPlatformLabel(rule.platform))} · 优先级 ${escapeHtml(String(rule.priority || 50))}</div>
            ${rule.notes ? `<div class="category-mapping-meta">${escapeHtml(String(rule.notes || ""))}</div>` : ""}
          </td>
          <td>
            <div class="category-mapping-condition-block">
              <strong>${escapeHtml(String(rule.sourceCategoryPath || "任意来源类目"))}</strong>
              <div class="category-mapping-chip-row">
                ${keywords.length ? keywords.map((item) => `<span class="category-mapping-chip">${escapeHtml(item)}</span>`).join("") : "<span class='category-mapping-chip muted'>无关键词限制</span>"}
              </div>
              ${excludedKeywords.length ? `<div class="category-mapping-meta">排除：${escapeHtml(excludedKeywords.join(" / "))}</div>` : ""}
            </div>
          </td>
          <td>${escapeHtml(getCategoryMappingShopName(rule.shopId))}</td>
          <td>
            <div class="category-mapping-rule-target">${escapeHtml(targetLabel || "-")}</div>
            <div class="category-mapping-meta">${escapeHtml(targetPath || "-")}</div>
            ${rule.categoryId ? `<div class="category-mapping-meta">ID: ${escapeHtml(String(rule.categoryId || ""))}</div>` : ""}
          </td>
          <td>${escapeHtml(formatDateTime(rule.updatedAt || rule.createdAt || ""))}</td>
          <td>
            <div class="review-rule-actions">
              <button type="button" class="secondary-btn" data-category-mapping-rule-edit="${escapeHtml(String(rule.id || ""))}">修改</button>
              <button type="button" class="secondary-btn" data-category-mapping-rule-delete="${escapeHtml(String(rule.id || ""))}">删除</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderCategoryMappingSamplesTable() {
  if (!categoryMappingSamplesTableBody) return;
  const samples = Array.isArray(state.categoryMappingSamples) ? state.categoryMappingSamples : [];
  if (!samples.length) {
    categoryMappingSamplesTableBody.innerHTML = "<tr><td colspan='6'>还没有学习样本</td></tr>";
    return;
  }
  categoryMappingSamplesTableBody.innerHTML = [...samples]
    .sort((a, b) => {
      const countDiff = (Number(b.count || 0) || 0) - (Number(a.count || 0) || 0);
      if (countDiff !== 0) return countDiff;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    })
    .map((sample) => {
      const keywords = Array.isArray(sample.keywords) ? sample.keywords.filter(Boolean).slice(0, 6) : [];
      const targetPath = String(sample.categoryPath || "").trim();
      const targetLabel = String(sample.categoryName || "").trim() || (targetPath ? targetPath.split(/\s*>\s*/).pop() || "" : "");
      return `
        <tr data-category-mapping-sample-id="${escapeHtml(String(sample.id || ""))}">
          <td>
            <div class="category-mapping-rule-title">${escapeHtml(String(sample.sourceCategoryPath || "未记录来源类目"))}</div>
            <div class="category-mapping-meta">${escapeHtml(getCategoryMappingPlatformLabel(sample.platform))} · ${escapeHtml(getCategoryMappingShopName(sample.shopId))}</div>
          </td>
          <td>
            <div class="category-mapping-rule-title">${escapeHtml(String(sample.titleKey || "未记录标题特征"))}</div>
            <div class="category-mapping-meta">${escapeHtml(String(sample.brand || "无品牌"))}</div>
            <div class="category-mapping-chip-row">
              ${keywords.length ? keywords.map((item) => `<span class="category-mapping-chip">${escapeHtml(item)}</span>`).join("") : "<span class='category-mapping-chip muted'>无关键词</span>"}
            </div>
          </td>
          <td>
            <div class="category-mapping-rule-target">${escapeHtml(targetLabel || "-")}</div>
            <div class="category-mapping-meta">${escapeHtml(targetPath || "-")}</div>
            ${sample.categoryId ? `<div class="category-mapping-meta">ID: ${escapeHtml(String(sample.categoryId || ""))}</div>` : ""}
          </td>
          <td>${escapeHtml(String(sample.count || 1))}</td>
          <td>${escapeHtml(formatDateTime(sample.updatedAt || ""))}</td>
          <td>
            <button type="button" class="secondary-btn" data-category-mapping-sample-create="${escapeHtml(String(sample.id || ""))}">生成规则</button>
          </td>
        </tr>
      `;
    })
    .join("");
}

async function onCategoryMappingRuleSubmit(event) {
  event.preventDefault();
  if (!categoryMappingRuleForm) return;
  if (categoryMappingMessage) {
    categoryMappingMessage.style.color = "#2f3d63";
    categoryMappingMessage.textContent = "正在保存类目映射规则...";
  }
  const form = new FormData(categoryMappingRuleForm);
  const item = {
    name: String(form.get("name") || "").trim(),
    priority: String(form.get("priority") || "").trim(),
    platform: String(form.get("platform") || "").trim(),
    shopId: String(form.get("shopId") || "").trim(),
    sourceCategoryPath: String(form.get("sourceCategoryPath") || "").trim(),
    keywords: String(form.get("keywords") || "").trim(),
    excludedKeywords: String(form.get("excludedKeywords") || "").trim(),
    categoryId: String(form.get("categoryId") || "").trim(),
    categoryName: String(form.get("categoryName") || "").trim(),
    categoryPath: String(form.get("categoryPath") || "").trim(),
    notes: String(form.get("notes") || "").trim()
  };
  const isEditing = Boolean(activeCategoryMappingRuleId);
  const result = await apiRequest(isEditing ? `/api/category-mapping/rules/${encodeURIComponent(activeCategoryMappingRuleId)}` : "/api/category-mapping/rules", {
    method: isEditing ? "PUT" : "POST",
    body: JSON.stringify({ item })
  });
  if (!result.ok) {
    if (categoryMappingMessage) {
      categoryMappingMessage.style.color = "#c02030";
      categoryMappingMessage.textContent = result.error || "类目映射规则保存失败";
    }
    return;
  }
  categoryMappingRuleForm.reset();
  closeCategoryMappingRuleModal();
  const ok = await loadCategoryMappingKnowledge({ force: true });
  state.panelLoaded.categoryMapping = Boolean(ok);
  if (categoryMappingMessage) {
    categoryMappingMessage.style.color = "#1d6f3a";
    categoryMappingMessage.textContent = isEditing ? "类目映射规则已更新" : "类目映射规则已添加";
  }
}

async function onCategoryMappingRulesTableChange(event) {
  const checkbox = event.target.closest("[data-category-mapping-rule-enable]");
  if (!checkbox) return;
  const ruleId = String(checkbox.getAttribute("data-category-mapping-rule-enable") || "").trim();
  const current = (state.categoryMappingRules || []).find((item) => String(item.id || "") === ruleId);
  if (!current) return;
  const result = await apiRequest(`/api/category-mapping/rules/${encodeURIComponent(ruleId)}`, {
    method: "PUT",
    body: JSON.stringify({ item: { enabled: checkbox.checked } })
  });
  if (!result.ok) {
    checkbox.checked = current.enabled !== false;
    if (categoryMappingMessage) {
      categoryMappingMessage.style.color = "#c02030";
      categoryMappingMessage.textContent = result.error || "类目映射规则更新失败";
    }
    return;
  }
  const ok = await loadCategoryMappingKnowledge({ force: true, silent: true });
  state.panelLoaded.categoryMapping = Boolean(ok);
  if (categoryMappingMessage) {
    categoryMappingMessage.style.color = "#1d6f3a";
    categoryMappingMessage.textContent = checkbox.checked ? "类目映射规则已启用" : "类目映射规则已关闭";
  }
}

async function onCategoryMappingRulesTableClick(event) {
  const editBtn = event.target.closest("[data-category-mapping-rule-edit]");
  if (editBtn) {
    const ruleId = String(editBtn.getAttribute("data-category-mapping-rule-edit") || "").trim();
    const rule = (state.categoryMappingRules || []).find((item) => String(item.id || "") === ruleId);
    if (rule) openCategoryMappingRuleModal(rule);
    return;
  }
  const deleteBtn = event.target.closest("[data-category-mapping-rule-delete]");
  if (!deleteBtn) return;
  const ruleId = String(deleteBtn.getAttribute("data-category-mapping-rule-delete") || "").trim();
  if (!ruleId) return;
  const result = await apiRequest(`/api/category-mapping/rules/${encodeURIComponent(ruleId)}`, { method: "DELETE" });
  if (!result.ok) {
    if (categoryMappingMessage) {
      categoryMappingMessage.style.color = "#c02030";
      categoryMappingMessage.textContent = result.error || "类目映射规则删除失败";
    }
    return;
  }
  const ok = await loadCategoryMappingKnowledge({ force: true, silent: true });
  state.panelLoaded.categoryMapping = Boolean(ok);
  if (categoryMappingMessage) {
    categoryMappingMessage.style.color = "#1d6f3a";
    categoryMappingMessage.textContent = "类目映射规则已删除";
  }
}

function onCategoryMappingSamplesTableClick(event) {
  const createBtn = event.target.closest("[data-category-mapping-sample-create]");
  if (!createBtn) return;
  const sampleId = String(createBtn.getAttribute("data-category-mapping-sample-create") || "").trim();
  const sample = (state.categoryMappingSamples || []).find((item) => String(item.id || "") === sampleId);
  if (sample) openCategoryMappingRuleModal(null, sample);
}

async function onCategoryMappingPlatformChange() {
  state.categoryMappingPlatform = getCategoryMappingPlatform();
  state.panelLoaded.categoryMapping = false;
  const ok = await loadCategoryMappingKnowledge({ force: true });
  state.panelLoaded.categoryMapping = Boolean(ok);
}

// 从 app.js 下沉的 DOM 常量与事件绑定。

const categoryMappingMessage = document.getElementById("categoryMappingMessage");
const categoryMappingRuleCount = document.getElementById("categoryMappingRuleCount");
const categoryMappingSampleCount = document.getElementById("categoryMappingSampleCount");
const categoryMappingFetchedAt = document.getElementById("categoryMappingFetchedAt");
const categoryMappingPlatformFilter = document.getElementById("categoryMappingPlatformFilter");
const refreshCategoryMappingBtn = document.getElementById("refreshCategoryMappingBtn");
const openCategoryMappingRuleModalBtn = document.getElementById("openCategoryMappingRuleModalBtn");
const categoryMappingRulesTableBody = document.getElementById("categoryMappingRulesTableBody");
const categoryMappingSamplesTableBody = document.getElementById("categoryMappingSamplesTableBody");
const categoryMappingRuleModalMask = document.getElementById("categoryMappingRuleModalMask");
const closeCategoryMappingRuleModalBtn = document.getElementById("closeCategoryMappingRuleModalBtn");
const categoryMappingRuleModalTitle = document.getElementById("categoryMappingRuleModalTitle");
const categoryMappingRuleForm = document.getElementById("categoryMappingRuleForm");
const categoryMappingRuleSubmitBtn = document.getElementById("categoryMappingRuleSubmitBtn");
const categoryMappingRuleShopId = document.getElementById("categoryMappingRuleShopId");
let activeCategoryMappingRuleId = "";

function bindCategoryMappingEvents() {
  if (refreshCategoryMappingBtn) refreshCategoryMappingBtn.addEventListener("click", () => loadCategoryMappingKnowledge({ force: true }));
  if (categoryMappingPlatformFilter) categoryMappingPlatformFilter.addEventListener("change", onCategoryMappingPlatformChange);
  if (openCategoryMappingRuleModalBtn) openCategoryMappingRuleModalBtn.addEventListener("click", () => openCategoryMappingRuleModal());
  if (closeCategoryMappingRuleModalBtn) closeCategoryMappingRuleModalBtn.addEventListener("click", closeCategoryMappingRuleModal);
  if (categoryMappingRuleModalMask) categoryMappingRuleModalMask.addEventListener("click", onCategoryMappingRuleModalMaskClick);
  if (categoryMappingRuleForm) categoryMappingRuleForm.addEventListener("submit", onCategoryMappingRuleSubmit);
  if (categoryMappingRulesTableBody) categoryMappingRulesTableBody.addEventListener("click", onCategoryMappingRulesTableClick);
  if (categoryMappingRulesTableBody) categoryMappingRulesTableBody.addEventListener("change", onCategoryMappingRulesTableChange);
  if (categoryMappingSamplesTableBody) categoryMappingSamplesTableBody.addEventListener("click", onCategoryMappingSamplesTableClick);
}
