// AI panel: composer, model config, image prompts, image tasks, image preview helpers.
function onAiModelSelectClick(event) {
  if (!aiModelSelect) return;
  const toggle = event.target.closest("button[data-ai-model-toggle]");
  if (toggle) {
    const menu = aiModelSelect.querySelector(".ai-model-menu");
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    menu?.classList.toggle("hidden", expanded);
    toggle.setAttribute("aria-expanded", String(!expanded));
    return;
  }

  const button = event.target.closest("button[data-model]");
  if (!button) return;
  aiModelSelect.querySelectorAll("button[data-model]").forEach((btn) => {
    btn.classList.toggle("active", btn === button);
  });
  const current = aiModelSelect.querySelector(".ai-model-current");
  if (current) current.textContent = button.dataset.modelLabel || button.textContent.trim();
  const menu = aiModelSelect.querySelector(".ai-model-menu");
  const trigger = aiModelSelect.querySelector("button[data-ai-model-toggle]");
  menu?.classList.add("hidden");
  trigger?.setAttribute("aria-expanded", "false");
}

function closeAiModelMenu(event) {
  if (!aiModelSelect || (event?.target && aiModelSelect.contains(event.target))) return;
  aiModelSelect.querySelector(".ai-model-menu")?.classList.add("hidden");
  aiModelSelect.querySelector("button[data-ai-model-toggle]")?.setAttribute("aria-expanded", "false");
}

function onAiPaste(event) {
  if (!event.clipboardData) return;
  const items = Array.from(event.clipboardData.items || []);
  const imageItem = items.find((item) => item.type && item.type.startsWith("image/"));
  if (!imageItem) return;
  event.preventDefault();
  const file = imageItem.getAsFile();
  if (file) renderAiImagePreview(file);
}

function onAiPasteInput() {
  if (!aiPasteArea) return;
  const value = String(aiPasteArea.textContent || "").trim();
  const hasText = Boolean(value && value !== "粘贴图片或输入文本" && value !== "输入你的内容…");
  aiPasteArea.classList.toggle("has-text", hasText);
}

function onAiImageUpload(event) {
  const file = event.target.files?.[0];
  if (file) renderAiImagePreview(file);
}

async function onAiSend() {
  if (!can("productAi")) {
    setAiMessage(aiHint, "无权限查看", false);
    return;
  }
  const model = getSelectedAiModel();
  if (!model) {
    setAiMessage(aiHint, "请先在系统管理 → AI配置中添加并启用模型", false);
    return;
  }
  const promptText = String(aiPromptInput?.value || "").trim();
  const pastedTextValue = String(aiPasteArea?.textContent || "").trim();
  const pastedText = ["粘贴图片或输入文本", "输入你的内容…"].includes(pastedTextValue) ? "" : pastedTextValue;
  const text = promptText || pastedText;

  if (!text && !lastAiImageDataUrl) {
    setAiMessage(aiHint, "请输入内容或粘贴图片", false);
    return;
  }

  const requestImageDataUrl = lastAiImageDataUrl || "";
  const userText = text || "请处理这张产品图片";
  appendAiChatMessage("user", userText, requestImageDataUrl ? [requestImageDataUrl] : []);
  resetAiComposerInput();
  setAiMessage(aiHint, "", false);
  const assistantMessage = appendAiChatMessage("assistant", "正在处理你的请求…", []);
  const result = await apiRequest("/api/ai/chat", {
    method: "POST",
    body: JSON.stringify({ prompt: text, model, imageDataUrl: requestImageDataUrl })
  });
  if (!result.ok) {
    updateAiChatMessage(assistantMessage, result.error || "AI 请求失败", []);
    setAiMessage(aiHint, result.error || "AI 请求失败", false);
    return;
  }
  const outputText = String(result.data?.outputText || "");
  const images = Array.isArray(result.data?.images) ? result.data.images : [];
  updateAiChatMessage(assistantMessage, outputText || (images.length ? "" : JSON.stringify(result.data || {}, null, 2)), images);
  setAiMessage(aiHint, images.length ? `AI 已生成 ${images.length} 张图片` : "AI 已返回结果", true);
}

function resetAiComposerInput() {
  if (aiPasteArea) {
    aiPasteArea.textContent = "";
    aiPasteArea.classList.remove("has-text");
  }
  if (aiImagePreview) aiImagePreview.innerHTML = "";
  if (aiImageInput) aiImageInput.value = "";
  lastAiImageDataUrl = "";
}

function appendAiChatMessage(role, text, images = []) {
  if (!aiChatMessages) return null;
  const row = document.createElement("div");
  row.className = `ai-chat-row ${role === "user" ? "is-user" : "is-assistant"}`;
  const avatar = document.createElement("div");
  avatar.className = "ai-chat-avatar";
  avatar.textContent = role === "user" ? "我" : "✦";
  const bubble = document.createElement("div");
  bubble.className = "ai-chat-bubble";
  row.append(avatar, bubble);
  aiChatMessages.appendChild(row);
  aiWorkspace?.classList.add("has-chat");
  updateAiChatMessage({ row, bubble }, text, images);
  aiChatMessages.scrollTop = aiChatMessages.scrollHeight;
  return { row, bubble };
}

function updateAiChatMessage(message, text, images = []) {
  if (!message?.bubble) return;
  message.bubble.innerHTML = "";
  const safeText = String(text || "").trim();
  if (safeText) {
    const textNode = document.createElement("div");
    textNode.className = "ai-chat-text";
    textNode.textContent = safeText;
    message.bubble.appendChild(textNode);
  }
  const validImages = (Array.isArray(images) ? images : [])
    .map((src) => String(src || "").trim())
    .filter((src) => /^(https?:\/\/|data:image\/)/i.test(src));
  validImages.forEach((src, index) => {
    const img = document.createElement("img");
    img.className = "ai-chat-image";
    img.src = src;
    img.alt = `AI 图片 ${index + 1}`;
    img.loading = "lazy";
    message.bubble.appendChild(img);
  });
  if (!safeText && !validImages.length) {
    const empty = document.createElement("div");
    empty.className = "ai-chat-text ai-chat-loading";
    empty.textContent = "正在处理你的请求…";
    message.bubble.appendChild(empty);
  }
}

function clearAiComposer() {
  resetAiComposerInput();
  if (aiPromptInput) aiPromptInput.value = "";
  if (aiResponse) aiResponse.textContent = "";
  if (aiResultPreview) aiResultPreview.innerHTML = "";
  if (aiChatMessages) aiChatMessages.innerHTML = "";
  aiWorkspace?.classList.remove("has-chat");
  setAiMessage(aiHint, "", false);
}

async function onAiPing() {
  if (!can("productAi")) {
    setAiMessage(aiHint, "无权限查看", false);
    return;
  }
  setAiMessage(aiHint, "正在测试 OpenAI 连接...", true);
  const result = await apiRequest("/api/ai/ping", { method: "GET" });
  if (!result.ok) {
    setAiMessage(aiHint, result.error || "连通性测试失败", false);
    return;
  }
  const detail = result.data?.detail || "OK";
  setAiMessage(aiHint, `OpenAI 连接正常：${detail}`, true);
}

function setAiConfigPageMessage(message, success = false) {
  if (!aiConfigPageMessage) return;
  aiConfigPageMessage.style.color = success ? "#1d6f3a" : "#c02030";
  aiConfigPageMessage.textContent = message || "";
}

function syncAiProviderDefaults() {
  if (!aiModelProvider || !aiModelBaseUrl || String(aiModelBaseUrl.value || "").trim()) return;
  const defaults = {
    qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    openai: "https://api.openai.com/v1",
    custom: ""
  };
  aiModelBaseUrl.value = defaults[aiModelProvider.value] || "";
}

async function loadAiConfigModels(showMessage = false) {
  if (!can("aiConfig")) return false;
  const result = await apiRequest("/api/ai/models", { method: "GET" });
  if (!result.ok) {
    state.aiModels = [];
    renderAiConfigModels();
    setAiConfigPageMessage(result.error || "AI 配置加载失败");
    return false;
  }
  state.aiModels = Array.isArray(result.data?.items) ? result.data.items : [];
  renderAiModelButtons(state.aiModels);
  renderAiConfigModels();
  renderAiImageTaskModelOptions(String(aiImageTaskModelId?.value || "").trim());
  if (showMessage) setAiConfigPageMessage("AI 配置已刷新", true);
  return true;
}

async function loadAvailableAiModels() {
  if (!can("productAi")) return false;
  const result = await apiRequest("/api/ai/models", { method: "GET" });
  if (!result.ok) {
    state.aiModels = [];
    renderAiModelButtons([]);
    setAiMessage(aiHint, result.error || "AI 模型加载失败", false);
    return false;
  }
  state.aiModels = Array.isArray(result.data?.items) ? result.data.items : [];
  renderAiModelButtons(state.aiModels);
  renderAiImageTaskModelOptions(String(aiImageTaskModelId?.value || "").trim());
  return true;
}

function renderAiModelButtons(models) {
  if (!aiModelSelect) return;
  const available = (Array.isArray(models) ? models : [])
    .filter((item) => item && item.enabled !== false && String(item.model || "").trim());
  if (!available.length) {
    aiModelSelect.innerHTML = "<span class='ai-models-empty'>暂无可用模型</span>";
    return;
  }
  const defaultIndex = available.findIndex((item) => item.isDefault);
  const activeCode = getSelectedAiModel();
  const selectedIndex = available.findIndex((item) => String(item.model || "") === activeCode);
  // Do not clamp -1 to 0: when the previously selected model was removed or
  // disabled, fall back to the default model instead of silently picking the
  // first one in the list.
  const currentIndex = activeCode && selectedIndex >= 0 ? selectedIndex : (defaultIndex >= 0 ? defaultIndex : 0);
  const current = available[currentIndex];
  const currentCode = String(current.model || "").trim();
  const currentLabel = String(current.name || currentCode).trim();
  aiModelSelect.innerHTML = `
    <button type="button" class="ai-model-trigger" data-ai-model-toggle aria-expanded="false" aria-haspopup="listbox">
      <span class="ai-model-icon" aria-hidden="true">✦</span>
      <span class="ai-model-current">${escapeHtml(currentLabel)}</span>
      <span class="ai-model-code">${escapeHtml(currentCode)}</span>
      <span class="ai-model-chevron" aria-hidden="true">⌄</span>
    </button>
    <div class="ai-model-menu hidden" role="listbox" aria-label="选择 AI 模型">
      ${available.map((item, index) => {
    const modelId = String(item.model || "").trim();
    const label = String(item.name || modelId).trim();
        return `<button type='button' class='ai-model-option${index === currentIndex ? " active" : ""}' data-model='${escapeHtml(modelId)}' data-model-label='${escapeHtml(label)}' role='option' aria-selected='${index === currentIndex}'>
          <span class='ai-model-option-main'><span class='ai-model-option-icon'>✦</span><span>${escapeHtml(label)}</span></span>
          <span class='ai-model-option-code'>${escapeHtml(modelId)}</span>
          <span class='ai-model-option-check'>✓</span>
        </button>`;
      }).join("")}
    </div>`;
}

function renderAiConfigModels() {
  const models = Array.isArray(state.aiModels) ? state.aiModels : [];
  if (aiModelsCount) aiModelsCount.textContent = `${models.length} 个模型`;
  if (!aiModelsTableBody) return;
  if (!models.length) {
    aiModelsTableBody.innerHTML = "<tr><td colspan='6' class='empty-cell'>暂无 AI 模型，请在左侧添加。</td></tr>";
    return;
  }
  aiModelsTableBody.innerHTML = models.map((item) => {
    const status = item.enabled ? "已启用" : "已停用";
    const defaultBadge = item.isDefault ? "<span class='ai-model-badge'>默认</span>" : "";
    return `
      <tr>
        <td><div class='ai-model-name-cell'><strong>${escapeHtml(item.name || item.model)}</strong><span>${escapeHtml(item.model || "-")}</span></div></td>
        <td>${escapeHtml(item.provider || "-")}</td>
        <td><span class='ai-model-url' title='${escapeHtml(item.baseUrl || "")}'>${escapeHtml(item.baseUrl || "-")}</span></td>
        <td>${item.apiKeyConfigured ? escapeHtml(item.apiKeyMasked || "已配置") : "未配置"}</td>
        <td><span class='ai-model-status${item.enabled ? " is-enabled" : ""}'>${status}</span>${defaultBadge}</td>
        <td><div class='ai-model-actions'>
          <button type='button' class='secondary-btn' data-ai-model-action='edit' data-id='${escapeHtml(item.id)}'>编辑</button>
          <button type='button' class='secondary-btn' data-ai-model-action='test' data-id='${escapeHtml(item.id)}'>测试</button>
          <button type='button' class='secondary-btn' data-ai-model-action='delete' data-id='${escapeHtml(item.id)}'>删除</button>
        </div></td>
      </tr>
    `;
  }).join("");
}

function fillAiModelForm(model) {
  if (!model) return;
  if (aiModelId) aiModelId.value = model.id || "";
  if (aiModelFormTitle) aiModelFormTitle.textContent = "编辑 AI 模型";
  if (aiModelName) aiModelName.value = model.name || "";
  if (aiModelProvider) aiModelProvider.value = model.provider || "custom";
  if (aiModelCode) aiModelCode.value = model.model || "";
  if (aiModelBaseUrl) aiModelBaseUrl.value = model.baseUrl || "";
  if (aiModelApiKey) {
    aiModelApiKey.value = "";
    aiModelApiKey.placeholder = model.apiKeyConfigured ? "已配置，留空保持原 Key；如需更换请重新输入" : "请输入 API Key";
  }
  if (aiModelEnabled) aiModelEnabled.checked = model.enabled !== false;
  if (aiModelDefault) aiModelDefault.checked = Boolean(model.isDefault);
  if (aiModelModalMask) aiModelModalMask.classList.remove("hidden");
}

function openAddAiModelModal() {
  resetAiModelForm();
  if (aiModelModalMask) aiModelModalMask.classList.remove("hidden");
}

function resetAiModelForm() {
  if (aiModelForm) aiModelForm.reset();
  if (aiModelId) aiModelId.value = "";
  if (aiModelFormTitle) aiModelFormTitle.textContent = "添加 AI 模型";
  if (aiModelEnabled) aiModelEnabled.checked = true;
  if (aiModelDefault) aiModelDefault.checked = false;
  if (aiModelApiKey) aiModelApiKey.placeholder = "新建时填写；编辑时留空保持原 Key";
}

function closeAiModelModal() {
  if (aiModelModalMask) aiModelModalMask.classList.add("hidden");
}

function onAiModelModalMaskClick(event) {
  if (event.target === aiModelModalMask) closeAiModelModal();
}

function onAiModelModalEscClose(event) {
  if (event.key === "Escape" && aiModelModalMask && !aiModelModalMask.classList.contains("hidden")) {
    closeAiModelModal();
  }
}

async function onAiModelFormSubmit(event) {
  event.preventDefault();
  if (!can("aiConfig")) {
    setAiConfigPageMessage("无权管理 AI 配置");
    return;
  }
  const id = String(aiModelId?.value || "").trim();
  const payload = {
    name: String(aiModelName?.value || "").trim(),
    provider: String(aiModelProvider?.value || "custom").trim(),
    model: String(aiModelCode?.value || "").trim(),
    baseUrl: String(aiModelBaseUrl?.value || "").trim(),
    enabled: Boolean(aiModelEnabled?.checked),
    isDefault: Boolean(aiModelDefault?.checked)
  };
  const apiKey = String(aiModelApiKey?.value || "");
  if (apiKey.trim()) payload.apiKey = apiKey;
  const result = await apiRequest(id ? `/api/ai/models/${encodeURIComponent(id)}` : "/api/ai/models", {
    method: id ? "PUT" : "POST",
    body: JSON.stringify(payload)
  });
  if (!result.ok) {
    setAiConfigPageMessage(result.error || "保存失败");
    return;
  }
  resetAiModelForm();
  closeAiModelModal();
  await loadAiConfigModels();
  setAiConfigPageMessage(id ? "AI 模型已更新" : "AI 模型已添加", true);
}

async function testAiModelById(id) {
  const result = await apiRequest(`/api/ai/models/${encodeURIComponent(id)}/test`, { method: "POST" });
  setAiConfigPageMessage(result.ok ? (result.data?.message || "连接成功") : (result.error || "连接测试失败"), result.ok);
}

async function testCurrentAiModel() {
  const id = String(aiModelId?.value || "").trim();
  if (!id) {
    setAiConfigPageMessage("请先保存模型，再测试连接");
    return;
  }
  await testAiModelById(id);
}

async function onAiModelsTableClick(event) {
  const button = event.target.closest("[data-ai-model-action]");
  if (!button) return;
  const id = String(button.dataset.id || "").trim();
  const model = state.aiModels.find((item) => item.id === id);
  if (!model) return;
  const action = button.dataset.aiModelAction;
  if (action === "edit") {
    fillAiModelForm(model);
    return;
  }
  if (action === "test") {
    await testAiModelById(id);
    return;
  }
  if (action === "delete") {
    if (!window.confirm(`确定删除 AI 模型“${model.name || model.model}”吗？`)) return;
    const result = await apiRequest(`/api/ai/models/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!result.ok) {
      setAiConfigPageMessage(result.error || "删除失败");
      return;
    }
    if (String(aiModelId?.value || "") === id) {
      resetAiModelForm();
      closeAiModelModal();
    }
    await loadAiConfigModels();
    setAiConfigPageMessage("AI 模型已删除", true);
  }
}

function getAiImageTaskStatusLabel(status) {
  const normalized = String(status || "draft").trim().toLowerCase();
  const labels = {
    draft: "草稿",
    queued: "排队中",
    processing: "处理中",
    succeeded: "完成",
    failed: "错误",
    blocked: "阻断",
    canceled: "已取消"
  };
  return labels[normalized] || status || "草稿";
}

function getAiImageTaskStatusClass(status) {
  const normalized = String(status || "draft").trim().toLowerCase();
  if (normalized === "succeeded") return "is-enabled";
  if (normalized === "failed" || normalized === "blocked") return "is-disabled";
  if (normalized === "processing" || normalized === "queued") return "is-pending";
  return "";
}

function getAiImageTaskStatusFilter(label) {
  const value = String(label || "all").trim().toLowerCase();
  if (["all", "queued", "processing", "succeeded", "failed"].includes(value)) return value;
  return "all";
}

function matchesAiImageTaskStatusFilter(task, filter) {
  const normalized = getAiImageTaskStatusFilter(filter);
  const status = String(task?.status || "").trim().toLowerCase();
  if (normalized === "all") return true;
  if (normalized === "failed") return status === "failed" || status === "blocked";
  return status === normalized;
}

function getAiImageTaskFilterCount(tasks, filter) {
  const normalized = getAiImageTaskStatusFilter(filter);
  const source = Array.isArray(tasks) ? tasks : [];
  return source.filter((task) => matchesAiImageTaskStatusFilter(task, normalized)).length;
}

function getDefaultAiImagePrompt(modelId = "") {
  const items = Array.isArray(aiImagePrompts) ? aiImagePrompts : [];
  const targetModelId = String(modelId || "").trim();
  const exact = targetModelId ? items.filter((item) => String(item?.modelId || "").trim() === targetModelId) : [];
  const global = items.filter((item) => !String(item?.modelId || "").trim());
  return String(exact.find((item) => item?.isDefault)?.prompt || exact[0]?.prompt || global.find((item) => item?.isDefault)?.prompt || global[0]?.prompt || "保留商品主体，替换为干净、适合电商刊登的背景").trim();
}

function getAiModelDisplayName(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return "全部模型";
  const model = (Array.isArray(state.aiModels) ? state.aiModels : []).find((item) => String(item?.id || item?.model || "").trim() === id);
  return model ? `${model.name || model.model} (${model.model || id})` : id;
}

function renderAiImagePromptModelOptions(selectedId = "") {
  if (!aiImagePromptModelId) return;
  const current = String(selectedId || "").trim();
  const models = (Array.isArray(state.aiModels) ? state.aiModels : []).filter((item) => item && item.enabled !== false && String(item.model || "").trim());
  aiImagePromptModelId.innerHTML = [
    `<option value=""${current ? "" : " selected"}>全部模型（通用）</option>`,
    ...models.map((item) => {
      const value = String(item.id || item.model || "").trim();
      const label = `${String(item.name || item.model || value).trim()} (${String(item.model || value).trim()})`;
      return `<option value="${escapeHtml(value)}"${current === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
    })
  ].join("");
}

function renderAiImagePrompts() {
  if (!aiImagePromptList) return;
  if (!aiImagePrompts.length) {
    aiImagePromptList.innerHTML = '<p class="small-text">还没有提示词，请先添加一条并设为默认。</p>';
    return;
  }
  aiImagePromptList.innerHTML = aiImagePrompts.map((item) => `
    <article class="ai-prompt-settings-item">
      <div><strong>${escapeHtml(item.name || "未命名提示词")}${item.isDefault ? ' <span class="ai-prompt-default">默认</span>' : ""}</strong><span class="small-text">适用模型：${escapeHtml(getAiModelDisplayName(item.modelId))}</span><p>${escapeHtml(item.prompt || "")}</p></div>
      <button class="secondary-btn" type="button" data-ai-image-prompt-delete="${escapeHtml(item.id || "")}">删除</button>
    </article>
  `).join("");
}

async function loadAiImagePrompts() {
  const result = await apiRequest("/api/ai/image-prompts", { method: "GET" });
  if (!result.ok) {
    aiImagePrompts = [];
    renderAiImagePrompts();
    return false;
  }
  aiImagePrompts = Array.isArray(result.data?.items) ? result.data.items : [];
  renderAiImagePrompts();
  return true;
}

async function openAiImagePromptSettings() {
  if (!aiImagePromptSettingsModalMask) return;
  renderAiImagePromptModelOptions("");
  aiImagePromptSettingsModalMask.classList.remove("hidden");
  await loadAiImagePrompts();
}

function closeAiImagePromptSettings() {
  if (aiImagePromptSettingsModalMask) aiImagePromptSettingsModalMask.classList.add("hidden");
}

async function onAiImagePromptFormSubmit(event) {
  event.preventDefault();
  const result = await apiRequest("/api/ai/image-prompts", {
    method: "POST",
    body: JSON.stringify({ name: String(aiImagePromptName?.value || "").trim(), modelId: String(aiImagePromptModelId?.value || "").trim(), prompt: String(aiImagePromptValue?.value || "").trim(), isDefault: Boolean(aiImagePromptDefault?.checked) })
  });
  if (!result.ok) {
    window.alert(result.error || "添加提示词失败");
    return;
  }
  if (aiImagePromptForm) aiImagePromptForm.reset();
  await loadAiImagePrompts();
}

async function onAiImagePromptListClick(event) {
  const button = event.target.closest("[data-ai-image-prompt-delete]");
  const id = String(button?.dataset?.aiImagePromptDelete || "").trim();
  if (!id || !window.confirm("确定删除这条提示词吗？")) return;
  const result = await apiRequest(`/api/ai/image-prompts/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!result.ok) { window.alert(result.error || "删除提示词失败"); return; }
  await loadAiImagePrompts();
}

function renderAiImageTaskModelOptions(selectedId = "") {
  if (!aiImageTaskModelId) return;
  const models = Array.isArray(state.aiModels) ? state.aiModels : [];
  const available = models.filter((item) => item && item.enabled !== false && String(item.model || "").trim());
  const current = String(selectedId || "").trim();
  aiImageTaskModelId.innerHTML = [
    '<option value="">自动选择默认模型</option>',
    ...available.map((item) => {
      const value = String(item.id || item.model || "").trim();
      const label = `${String(item.name || item.model || value).trim()} (${String(item.model || value).trim()})`;
      return `<option value="${escapeHtml(value)}"${current === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
    })
  ].join("");
}

function getAiImageTaskById(id) {
  const taskId = String(id || "").trim();
  if (!taskId) return null;
  return (Array.isArray(state.aiImageTasks) ? state.aiImageTasks : []).find((item) => String(item?.id || "").trim() === taskId) || null;
}

function setAiImageTaskDetailHidden(hidden) {
  if (aiImageTaskDetailCard) aiImageTaskDetailCard.classList.toggle("hidden", hidden);
  if (aiImageTaskDetail) aiImageTaskDetail.classList.toggle("hidden", hidden);
  if (aiImageTaskWorkspace) aiImageTaskWorkspace.classList.toggle("is-detail-hidden", hidden);
}

function clearAiImageTaskDetail() {
  setAiImageTaskDetailHidden(true);
  if (aiImageTaskDetailTitle) aiImageTaskDetailTitle.textContent = "-";
  if (aiImageTaskDetailSubtitle) aiImageTaskDetailSubtitle.textContent = "";
  if (aiImageTaskDetailStatus) {
    aiImageTaskDetailStatus.className = "ai-model-status";
    aiImageTaskDetailStatus.textContent = "草稿";
  }
  if (aiImageTaskSourcePreview) aiImageTaskSourcePreview.removeAttribute("src");
  if (aiImageTaskResultPreview) aiImageTaskResultPreview.removeAttribute("src");
  if (aiImageTaskDetailSourceType) aiImageTaskDetailSourceType.textContent = "-";
  if (aiImageTaskDetailSourceId) aiImageTaskDetailSourceId.textContent = "-";
  if (aiImageTaskDetailProductId) aiImageTaskDetailProductId.textContent = "-";
  if (aiImageTaskDetailModel) aiImageTaskDetailModel.textContent = "-";
  if (aiImageTaskDetailUpdatedAt) aiImageTaskDetailUpdatedAt.textContent = "-";
  if (aiImageTaskDetailProgress) aiImageTaskDetailProgress.textContent = "0%";
  if (aiImageTaskDetailError) aiImageTaskDetailError.textContent = "-";
  if (aiImageTaskDetailEditBtn) aiImageTaskDetailEditBtn.disabled = true;
  if (aiImageTaskDetailRetryBtn) aiImageTaskDetailRetryBtn.disabled = true;
  if (aiImageTaskDetailDeleteBtn) aiImageTaskDetailDeleteBtn.disabled = true;
}

function renderAiImageTaskDetail(task) {
  if (!task) {
    clearAiImageTaskDetail();
    return;
  }
  setAiImageTaskDetailHidden(false);
  const statusLabel = getAiImageTaskStatusLabel(task.status);
  const statusClass = getAiImageTaskStatusClass(task.status);
  const sourceLabel = [task.sourceType, task.sourceId || task.productId].filter(Boolean).join(" / ") || "未关联来源";
  const sourceUrl = String(task.sourceImageUrl || "").trim();
  const resultUrl = String(task.resultImageUrl || "").trim();
  if (aiImageTaskDetailTitle) aiImageTaskDetailTitle.textContent = task.id || "-";
  if (aiImageTaskDetailSubtitle) aiImageTaskDetailSubtitle.textContent = sourceLabel;
  if (aiImageTaskDetailStatus) {
    aiImageTaskDetailStatus.className = `ai-model-status ${statusClass}`.trim();
    aiImageTaskDetailStatus.textContent = statusLabel;
  }
  if (aiImageTaskSourcePreview) {
    // 图片地址统一走项目自己的 http(s) 白名单（其余页面都这么做，这里原先漏了）：
    // 这些 URL 来自采集/平台侧数据，HTML 转义挡不住 javascript:/data: 载荷。
    const safeSourceUrl = sourceUrl ? safeImageUrl(sourceUrl) : "";
    if (safeSourceUrl) {
      aiImageTaskSourcePreview.src = safeSourceUrl;
      aiImageTaskSourcePreview.classList.remove("hidden");
    } else {
      aiImageTaskSourcePreview.removeAttribute("src");
      aiImageTaskSourcePreview.classList.add("hidden");
    }
  }
  if (aiImageTaskResultPreview) {
    const safeResultUrl = resultUrl ? safeImageUrl(resultUrl) : "";
    if (safeResultUrl) {
      aiImageTaskResultPreview.src = safeResultUrl;
      aiImageTaskResultPreview.classList.remove("hidden");
    } else {
      aiImageTaskResultPreview.removeAttribute("src");
      aiImageTaskResultPreview.classList.add("hidden");
    }
  }
  if (aiImageTaskDetailSourceType) aiImageTaskDetailSourceType.textContent = task.sourceType || "-";
  if (aiImageTaskDetailSourceId) aiImageTaskDetailSourceId.textContent = task.sourceId || "-";
  if (aiImageTaskDetailProductId) aiImageTaskDetailProductId.textContent = task.productId || "-";
  if (aiImageTaskDetailModel) aiImageTaskDetailModel.textContent = task.modelName || task.modelId || "自动选择";
  if (aiImageTaskDetailUpdatedAt) aiImageTaskDetailUpdatedAt.textContent = formatDateTime(task.updatedAt || task.createdAt || "");
  if (aiImageTaskDetailProgress) {
    const progress = Number(task.progress || 0);
    aiImageTaskDetailProgress.textContent = `${Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0}%`;
  }
  if (aiImageTaskDetailError) aiImageTaskDetailError.textContent = task.errorMessage || "暂无错误信息";
  if (aiImageTaskDetailEditBtn) aiImageTaskDetailEditBtn.disabled = false;
  if (aiImageTaskDetailRetryBtn) aiImageTaskDetailRetryBtn.disabled = false;
  if (aiImageTaskDetailDeleteBtn) aiImageTaskDetailDeleteBtn.disabled = false;
}

function selectAiImageTask(taskOrId) {
  const id = typeof taskOrId === "object" && taskOrId ? String(taskOrId.id || "").trim() : String(taskOrId || "").trim();
  state.aiImageTaskSelectedId = id;
  activeAiImageTaskId = id;
  renderAiImageTasks();
}

function getAiImageTaskSkus(task) {
  let metadata = {};
  try {
    metadata = typeof task?.metadataJson === "object"
      ? (task.metadataJson || {})
      : JSON.parse(String(task?.metadataJson || "{}"));
  } catch {
    metadata = {};
  }
  return Array.from(new Set([
    metadata.sourceSku,
    metadata.systemSku,
    metadata.platformSku,
    metadata.variantSku
  ].map((value) => String(value || "").trim()).filter(Boolean)));
}

function renderAiImageTasks() {
  const tasks = Array.isArray(state.aiImageTasks) ? state.aiImageTasks : [];
  const activeFilter = getAiImageTaskStatusFilter(state.aiImageTaskStatusFilter);
  const visibleTasks = tasks.filter((task) => matchesAiImageTaskStatusFilter(task, activeFilter));
  if (activeFilter === "succeeded") {
    visibleTasks.sort((left, right) => {
      const rightTime = new Date(right?.finishedAt || right?.updatedAt || right?.createdAt || 0).getTime();
      const leftTime = new Date(left?.finishedAt || left?.updatedAt || left?.createdAt || 0).getTime();
      return rightTime - leftTime;
    });
  }
  const validIds = new Set(tasks.map((task) => String(task.id || "").trim()).filter(Boolean));
  state.aiImageTaskCheckedIds = (Array.isArray(state.aiImageTaskCheckedIds) ? state.aiImageTaskCheckedIds : [])
    .map((id) => String(id || "").trim())
    .filter((id) => validIds.has(id));
  const checkedIds = new Set(state.aiImageTaskCheckedIds);
  const visibleIds = visibleTasks.map((task) => String(task.id || "").trim()).filter(Boolean);
  const visibleCheckedCount = visibleIds.filter((id) => checkedIds.has(id)).length;
  if (aiImageTaskSelectAll) {
    aiImageTaskSelectAll.checked = visibleIds.length > 0 && visibleCheckedCount === visibleIds.length;
    aiImageTaskSelectAll.indeterminate = visibleCheckedCount > 0 && visibleCheckedCount < visibleIds.length;
    aiImageTaskSelectAll.disabled = visibleIds.length === 0;
  }
  if (aiImageTaskCount) {
    const total = tasks.length;
    const visible = visibleTasks.length;
    aiImageTaskCount.textContent = activeFilter === "all" ? `${total} 个任务` : `${visible}/${total} 个任务`;
  }
  if (aiImageTaskStatusTabs) {
    aiImageTaskStatusTabs.querySelectorAll("[data-ai-image-task-status]").forEach((button) => {
      const filter = getAiImageTaskStatusFilter(button.dataset.aiImageTaskStatus);
      const count = getAiImageTaskFilterCount(tasks, filter);
      const baseLabel = ({
        all: "全部任务",
        queued: "排队中",
        processing: "进行中",
        succeeded: "完成",
        failed: "错误"
      })[filter] || "全部任务";
      button.classList.toggle("active", filter === activeFilter);
      button.textContent = `${baseLabel}${filter === "all" ? ` (${count})` : ` (${count})`}`;
    });
  }
  const selectedTask = visibleTasks.find((task) => String(task.id || "").trim() === String(state.aiImageTaskSelectedId || "").trim())
    || visibleTasks[0]
    || null;
  const selectedTaskId = String(selectedTask?.id || "").trim();
  if (selectedTaskId !== String(state.aiImageTaskSelectedId || "").trim()) {
    state.aiImageTaskSelectedId = selectedTaskId;
    activeAiImageTaskId = selectedTaskId;
  }
  if (selectedTask) {
    renderAiImageTaskDetail(selectedTask);
  } else {
    clearAiImageTaskDetail();
  }
  if (!aiImageTasksTableBody) return;
  if (!visibleTasks.length) {
    aiImageTasksTableBody.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="ai-empty-state">
            <div class="ai-empty-state-icon" aria-hidden="true">✦</div>
            <strong>${tasks.length ? "当前筛选下暂无任务" : "还没有 AI 图任务"}</strong>
            <p>${tasks.length ? "换一个状态筛选继续查看。" : "采集插件接入后，任务会自动进入这里。"} </p>
          </div>
        </td>
      </tr>`;
    return;
  }
  aiImageTasksTableBody.innerHTML = visibleTasks.map((item) => {
    const status = getAiImageTaskStatusLabel(item.status);
    const resultLink = String(item.resultImageUrl || "").trim();
    const sourceLink = String(item.sourceImageUrl || "").trim();
    const sourceLabel = [item.sourceType, item.sourceId || item.productId].filter(Boolean).join(" / ") || "-";
    const skuLabel = getAiImageTaskSkus(item).join(" / ");
    const isSelected = String(item.id || "").trim() === String(state.aiImageTaskSelectedId || "").trim();
    return `
      <tr data-ai-image-task-row data-id="${escapeHtml(item.id || "")}" class="${isSelected ? "is-selected" : ""}">
        <td class="ai-task-check-column">
          <input type="checkbox" data-ai-image-task-check data-id="${escapeHtml(item.id || "")}" aria-label="选择任务 ${escapeHtml(item.id || "")}" ${checkedIds.has(String(item.id || "").trim()) ? "checked" : ""} />
        </td>
        <td>
          <div class="ai-model-name-cell">
            <strong>${escapeHtml(item.id || "-")}</strong>
          </div>
        </td>
        <td>
          <div class="ai-task-source-cell">
            <div>${escapeHtml(sourceLabel)}</div>
            ${skuLabel ? `<span class="small-text">店铺SKU：${escapeHtml(skuLabel)}</span>` : ""}
            ${safeExternalUrl(sourceLink) ? `<a href="${escapeHtml(safeExternalUrl(sourceLink))}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceLink)}</a>` : "<span class='small-text'>未填写源图片</span>"}
          </div>
        </td>
        <td>
          <div class="ai-model-name-cell">
            <strong>${escapeHtml(item.modelName || item.modelId || "自动选择")}</strong>
            <span>${escapeHtml(item.modelId || "-")}</span>
          </div>
        </td>
        <td><span class="ai-model-status ${getAiImageTaskStatusClass(item.status)}">${escapeHtml(status)}</span></td>
        <td>
          <button type="button" class="ai-task-result-link secondary-btn" data-ai-image-task-action="result" data-id="${escapeHtml(item.id)}">查看结果</button>
          ${item.errorMessage ? `<div class="ai-task-error">${escapeHtml(item.errorMessage)}</div>` : ""}
        </td>
        <td>${escapeHtml(formatDateTime(String(item.status || "").toLowerCase() === "succeeded" ? (item.finishedAt || item.updatedAt || item.createdAt || "") : (item.updatedAt || item.createdAt || "")))}</td>
        <td>
          <div class="ai-model-actions">
            <button type="button" class="secondary-btn" data-ai-image-task-action="edit" data-id="${escapeHtml(item.id)}">编辑</button>
            <button type="button" class="secondary-btn" data-ai-image-task-action="retry" data-id="${escapeHtml(item.id)}">${String(item.status || "").toLowerCase() === "succeeded" ? "再次处理" : "重试"}</button>
            <button type="button" class="secondary-btn" data-ai-image-task-action="delete" data-id="${escapeHtml(item.id)}">删除</button>
            <button type="button" class="secondary-btn" data-ai-image-task-action="logs" data-id="${escapeHtml(item.id)}">日志</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

function onAiImageTaskCheckboxChange(event) {
  const checkbox = event.target.closest("[data-ai-image-task-check]");
  if (!checkbox) return;
  const id = String(checkbox.dataset.id || "").trim();
  if (!id) return;
  const checkedIds = new Set(Array.isArray(state.aiImageTaskCheckedIds) ? state.aiImageTaskCheckedIds : []);
  if (checkbox.checked) checkedIds.add(id);
  else checkedIds.delete(id);
  state.aiImageTaskCheckedIds = Array.from(checkedIds);
  renderAiImageTasks();
}

function onAiImageTaskSelectAllChange() {
  const tasks = Array.isArray(state.aiImageTasks) ? state.aiImageTasks : [];
  const activeFilter = getAiImageTaskStatusFilter(state.aiImageTaskStatusFilter);
  const visibleIds = tasks
    .filter((task) => matchesAiImageTaskStatusFilter(task, activeFilter))
    .map((task) => String(task.id || "").trim())
    .filter(Boolean);
  const checkedIds = new Set(Array.isArray(state.aiImageTaskCheckedIds) ? state.aiImageTaskCheckedIds : []);
  visibleIds.forEach((id) => {
    if (aiImageTaskSelectAll?.checked) checkedIds.add(id);
    else checkedIds.delete(id);
  });
  state.aiImageTaskCheckedIds = Array.from(checkedIds);
  renderAiImageTasks();
}

function onAiImageTaskStatusTabClick(event) {
  const button = event.target.closest("[data-ai-image-task-status]");
  if (!button || !aiImageTaskStatusTabs) return;
  const nextFilter = getAiImageTaskStatusFilter(button.dataset.aiImageTaskStatus);
  state.aiImageTaskStatusFilter = nextFilter;
  aiImageTaskStatusTabs.querySelectorAll("[data-ai-image-task-status]").forEach((tab) => {
    tab.classList.toggle("active", tab === button);
  });
  renderAiImageTasks();
}

async function onAiImageTaskSearchSubmit(event) {
  event.preventDefault();
  state.aiImageTaskKeyword = String(aiImageTaskSearchInput?.value || "").trim();
  state.aiImageTaskSelectedId = "";
  state.aiImageTaskCheckedIds = [];
  await loadAiImageTasks(true);
}

async function onAiImageTaskSearchReset() {
  state.aiImageTaskKeyword = "";
  state.aiImageTaskSelectedId = "";
  state.aiImageTaskCheckedIds = [];
  if (aiImageTaskSearchInput) aiImageTaskSearchInput.value = "";
  await loadAiImageTasks(true);
}

async function loadAiImageTasks(showMessage = false) {
  if (!can("aiConfig")) return false;
  const loadSequence = Number(state.aiImageTaskLoadSequence || 0) + 1;
  state.aiImageTaskLoadSequence = loadSequence;
  const keyword = String(state.aiImageTaskKeyword || "").trim();
  const query = keyword ? `?keyword=${encodeURIComponent(keyword)}` : "";
  const result = await apiRequest(`/api/ai/image-tasks${query}`, { method: "GET" });
  if (loadSequence !== state.aiImageTaskLoadSequence) return false;
  if (!result.ok) {
    state.aiImageTasks = [];
    renderAiImageTasks();
    if (aiImageTaskPageMessage) {
      aiImageTaskPageMessage.style.color = "#c02030";
      aiImageTaskPageMessage.textContent = result.error || "AI 图任务加载失败";
    }
    return false;
  }
  state.aiImageTasks = Array.isArray(result.data?.items) ? result.data.items : [];
  renderAiImageTasks();
  if (showMessage && aiImageTaskPageMessage) {
    aiImageTaskPageMessage.style.color = "#1d6f3a";
    aiImageTaskPageMessage.textContent = keyword
      ? `搜索“${keyword}”，找到 ${state.aiImageTasks.length} 个任务`
      : "AI 图任务已刷新";
  } else if (aiImageTaskPageMessage) {
    aiImageTaskPageMessage.style.color = "#2f3d63";
    aiImageTaskPageMessage.textContent = keyword
      ? `搜索“${keyword}”，找到 ${state.aiImageTasks.length} 个任务`
      : (state.aiImageTasks.length ? `已加载 ${state.aiImageTasks.length} 个任务` : "还没有 AI 图任务");
  }
  return true;
}

function resetAiImageTaskForm() {
  if (aiImageTaskForm) aiImageTaskForm.reset();
  if (aiImageTaskId) aiImageTaskId.value = "";
  if (aiImageTaskFormTitle) aiImageTaskFormTitle.textContent = "编辑 AI 图任务";
  if (aiImageTaskStatus) aiImageTaskStatus.value = "draft";
  if (aiImageTaskResetProgress) aiImageTaskResetProgress.checked = true;
  if (queueAiImageTaskBtn) queueAiImageTaskBtn.dataset.mode = "queue";
  renderAiImageTaskModelOptions("");
}

function fillAiImageTaskForm(task) {
  if (!task || !aiImageTaskForm) return;
  if (aiImageTaskId) aiImageTaskId.value = task.id || "";
  if (aiImageTaskFormTitle) aiImageTaskFormTitle.textContent = "编辑 AI 图任务";
  if (aiImageTaskSourceType) aiImageTaskSourceType.value = task.sourceType || "product";
  if (aiImageTaskSourceId) aiImageTaskSourceId.value = task.sourceId || "";
  if (aiImageTaskProductId) aiImageTaskProductId.value = task.productId || "";
  if (aiImageTaskSourceImageUrl) aiImageTaskSourceImageUrl.value = task.sourceImageUrl || "";
  if (aiImageTaskStatus) aiImageTaskStatus.value = task.status || "draft";
  if (aiImageTaskResultImageUrl) aiImageTaskResultImageUrl.value = task.resultImageUrl || "";
  if (aiImageTaskErrorMessage) aiImageTaskErrorMessage.value = task.errorMessage || "";
  if (aiImageTaskNotes) aiImageTaskNotes.value = task.notes || "";
  renderAiImageTaskModelOptions(task.modelId || "");
  if (aiImageTaskModalMask) aiImageTaskModalMask.classList.remove("hidden");
}

function openAiImageTaskModal(task = null) {
  resetAiImageTaskForm();
  if (task) fillAiImageTaskForm(task);
  if (aiImageTaskModalMask) aiImageTaskModalMask.classList.remove("hidden");
}

function closeAiImageTaskModal() {
  if (aiImageTaskModalMask) aiImageTaskModalMask.classList.add("hidden");
}

function closeAiImageTaskLogModal() {
  if (aiImageTaskLogModalMask) aiImageTaskLogModalMask.classList.add("hidden");
}

function setAiImageTaskResultImage(image, emptyLabel, url) {
  if (!image || !emptyLabel) return;
  // 同 setUpAiImageTaskDetail：非 http(s) 地址一律当作"没有图片"，退回占位文案。
  const imageUrl = safeImageUrl(String(url || "").trim());
  if (imageUrl) {
    image.src = imageUrl;
    image.classList.remove("hidden");
    emptyLabel.classList.add("hidden");
  } else {
    image.removeAttribute("src");
    image.classList.add("hidden");
    emptyLabel.classList.remove("hidden");
  }
}

function openAiImageTaskResultModal(task) {
  if (!task || !aiImageTaskResultModalMask) return;
  const taskCode = String(task.id || "").trim();
  if (aiImageTaskResultTitle) aiImageTaskResultTitle.textContent = "图片处理结果";
  if (aiImageTaskResultCode) aiImageTaskResultCode.textContent = taskCode;
  setAiImageTaskResultImage(aiImageTaskResultSourceImage, aiImageTaskResultSourceEmpty, task.sourceImageUrl);
  setAiImageTaskResultImage(aiImageTaskResultImage, aiImageTaskResultEmpty, task.resultImageUrl);
  if (aiImageTaskResultError) {
    const message = String(task.errorMessage || "").trim();
    aiImageTaskResultError.textContent = message;
    aiImageTaskResultError.classList.toggle("hidden", !message);
  }
  aiImageTaskResultModalMask.classList.remove("hidden");
}

function closeAiImageTaskResultModal() {
  if (aiImageTaskResultModalMask) aiImageTaskResultModalMask.classList.add("hidden");
}

async function openAiImageTaskLogModal(id) {
  const taskCode = String(id || "").trim();
  if (!taskCode) return;
  if (aiImageTaskLogCode) aiImageTaskLogCode.textContent = taskCode;
  if (aiImageTaskLogContent) aiImageTaskLogContent.innerHTML = "<p class='small-text'>正在加载日志...</p>";
  if (aiImageTaskLogModalMask) aiImageTaskLogModalMask.classList.remove("hidden");
  const result = await apiRequest(`/api/ai/image-tasks/${encodeURIComponent(taskCode)}/logs`, { method: "GET" });
  if (!aiImageTaskLogContent) return;
  if (!result.ok) {
    aiImageTaskLogContent.innerHTML = `<p class="message small">${escapeHtml(result.error || "日志加载失败")}</p>`;
    return;
  }
  const items = Array.isArray(result.data?.items) ? result.data.items : [];
  if (!items.length) {
    aiImageTaskLogContent.innerHTML = "<p class='small-text'>暂无 ERP 内部处理日志。</p>";
    return;
  }
  aiImageTaskLogContent.innerHTML = items.map((item) => `
    <article class="ai-task-log-item">
      <time>${escapeHtml(formatDateTime(item.createdAt || ""))}</time>
      <strong>${escapeHtml(item.message || "任务状态更新")}</strong>
    </article>
  `).join("");
}

function onAiImageTaskModalMaskClick(event) {
  if (event.target === aiImageTaskModalMask) closeAiImageTaskModal();
}

function onAiImageTaskModalEscClose(event) {
  if (event.key === "Escape" && aiImageTaskModalMask && !aiImageTaskModalMask.classList.contains("hidden")) {
    closeAiImageTaskModal();
  }
  if (event.key === "Escape" && aiImageTaskResultModalMask && !aiImageTaskResultModalMask.classList.contains("hidden")) {
    closeAiImageTaskResultModal();
  }
}

async function saveAiImageTask(shouldQueue = false) {
  if (!can("aiConfig")) {
    if (aiImageTaskPageMessage) aiImageTaskPageMessage.textContent = "无权管理 AI 图任务";
    return;
  }
  const id = String(aiImageTaskId?.value || "").trim();
  const modelValue = String(aiImageTaskModelId?.value || "").trim();
  // Resolve the model name from state.aiModels (the option text is a display
  // label like "名称 (模型代码)" and must not be stored verbatim).
  const selectedModel = (Array.isArray(state.aiModels) ? state.aiModels : []).find(
    (item) => item && String(item.id || item.model || "") === modelValue
  );
  const payload = {
    sourceType: String(aiImageTaskSourceType?.value || "product").trim(),
    sourceId: String(aiImageTaskSourceId?.value || "").trim(),
    productId: String(aiImageTaskProductId?.value || "").trim(),
    sourceImageUrl: String(aiImageTaskSourceImageUrl?.value || "").trim(),
    modelId: modelValue,
    modelName: selectedModel ? String(selectedModel.name || selectedModel.model || "").trim() : "",
    prompt: getDefaultAiImagePrompt(modelValue),
    status: shouldQueue ? "queued" : String(aiImageTaskStatus?.value || "draft").trim(),
    resultImageUrl: String(aiImageTaskResultImageUrl?.value || "").trim(),
    errorMessage: String(aiImageTaskErrorMessage?.value || "").trim(),
    notes: String(aiImageTaskNotes?.value || "").trim(),
    progress: shouldQueue || Boolean(aiImageTaskResetProgress?.checked) ? 0 : undefined
  };
  if (payload.progress === undefined) delete payload.progress;
  const result = await apiRequest(id ? `/api/ai/image-tasks/${encodeURIComponent(id)}` : "/api/ai/image-tasks", {
    method: id ? "PUT" : "POST",
    body: JSON.stringify({ item: payload })
  });
  if (!result.ok) {
    if (aiImageTaskPageMessage) {
      aiImageTaskPageMessage.style.color = "#c02030";
      aiImageTaskPageMessage.textContent = result.error || "保存 AI 图任务失败";
    }
    return;
  }
  resetAiImageTaskForm();
  closeAiImageTaskModal();
  await loadAiImageTasks();
  if (aiImageTaskPageMessage) {
    aiImageTaskPageMessage.style.color = "#1d6f3a";
    aiImageTaskPageMessage.textContent = shouldQueue ? "AI 图任务已保存并排队" : (id ? "AI 图任务已更新" : "AI 图任务已创建");
  }
}

async function retryAiImageTaskById(id) {
  const result = await apiRequest(`/api/ai/image-tasks/${encodeURIComponent(id)}/retry`, { method: "POST" });
  if (!result.ok) {
    if (aiImageTaskPageMessage) {
      aiImageTaskPageMessage.style.color = "#c02030";
      aiImageTaskPageMessage.textContent = result.error || "重试失败";
    }
    return;
  }
  await loadAiImageTasks();
  if (aiImageTaskPageMessage) {
    aiImageTaskPageMessage.style.color = "#1d6f3a";
    aiImageTaskPageMessage.textContent = "任务已重新排队";
  }
}

async function onAiImageTasksTableClick(event) {
  if (event.target.closest("[data-ai-image-task-check]")) return;
  const row = event.target.closest("[data-ai-image-task-row]");
  const button = event.target.closest("[data-ai-image-task-action]");
  if (!button && row) {
    const id = String(row.dataset.id || "").trim();
    if (id) selectAiImageTask(id);
    return;
  }
  if (!button) return;
  const id = String(button.dataset.id || "").trim();
  const task = state.aiImageTasks.find((item) => item.id === id);
  const action = String(button.dataset.aiImageTaskAction || "").trim();
  if (action === "edit") {
    openAiImageTaskModal(task || null);
    return;
  }
  if (action === "retry") {
    await retryAiImageTaskById(id);
    return;
  }
  if (action === "result") {
    openAiImageTaskResultModal(task || null);
    return;
  }
  if (action === "delete") {
    if (!window.confirm(`确定删除 AI 图任务“${id}”吗？`)) return;
    const result = await apiRequest(`/api/ai/image-tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!result.ok) {
      if (aiImageTaskPageMessage) {
        aiImageTaskPageMessage.style.color = "#c02030";
        aiImageTaskPageMessage.textContent = result.error || "删除失败";
      }
      return;
    }
    await loadAiImageTasks();
    if (aiImageTaskPageMessage) {
      aiImageTaskPageMessage.style.color = "#1d6f3a";
      aiImageTaskPageMessage.textContent = "AI 图任务已删除";
    }
    if (String(state.aiImageTaskSelectedId || "") === id) {
      state.aiImageTaskSelectedId = "";
      activeAiImageTaskId = "";
      renderAiImageTasks();
    }
    return;
  }
  if (action === "logs") {
    await openAiImageTaskLogModal(id);
  }
}

async function onAiImageTaskFormSubmit(event) {
  event.preventDefault();
  await saveAiImageTask(false);
}

async function onQueueAiImageTask() {
  await saveAiImageTask(true);
}

function setAiMessage(targetEl, message, success) {
  if (!targetEl) return;
  targetEl.style.color = success ? "#1d6f3a" : "#c02030";
  targetEl.textContent = message || "";
}

function getSelectedAiModel() {
  if (!aiModelSelect) return "";
  const active = aiModelSelect.querySelector("button[data-model].active");
  return active ? String(active.dataset.model || "").trim() : "";
}

function renderAiImagePreview(file) {
  if (!aiImagePreview || !file) return;
  const reader = new FileReader();
  reader.onload = () => {
    aiImagePreview.innerHTML = "";
    const img = document.createElement("img");
    img.src = String(reader.result || "");
    img.alt = "pasted";
    aiImagePreview.appendChild(img);
    if (aiPasteArea) aiPasteArea.classList.add("has-text");
    lastAiImageDataUrl = String(reader.result || "");
  };
  reader.readAsDataURL(file);
}

function renderAiResultImages(images) {
  if (!aiResultPreview) return;
  const validImages = (Array.isArray(images) ? images : [])
    .map((src) => String(src || "").trim())
    .filter((src) => /^https?:\/\//i.test(src));
  aiResultPreview.innerHTML = "";
  validImages.forEach((src, index) => {
    const img = document.createElement("img");
    img.src = src;
    img.alt = `AI 生成图片 ${index + 1}`;
    img.loading = "lazy";
    aiResultPreview.appendChild(img);
  });
}

// 从 app.js 下沉的 DOM 常量与事件绑定。

let lastAiImageDataUrl = "";
const aiModelSelect = document.getElementById("aiModelSelect");
const aiWorkspace = document.getElementById("aiWorkspace");
const aiChatMessages = document.getElementById("aiChatMessages");
const aiPasteArea = document.getElementById("aiPasteArea");
const aiImageInput = document.getElementById("aiImageInput");
const aiImagePreview = document.getElementById("aiImagePreview");
const aiPromptInput = document.getElementById("aiPromptInput");
const aiSendBtn = document.getElementById("aiSendBtn");
const aiClearBtn = document.getElementById("aiClearBtn");
const aiHint = document.getElementById("aiHint");
const aiResponse = document.getElementById("aiResponse");
const aiResultPreview = document.getElementById("aiResultPreview");
const aiPingBtn = document.getElementById("aiPingBtn");
const aiConfigPageMessage = document.getElementById("aiConfigPageMessage");
const aiModelForm = document.getElementById("aiModelForm");
const aiModelId = document.getElementById("aiModelId");
const aiModelFormTitle = document.getElementById("aiModelFormTitle");
const aiModelName = document.getElementById("aiModelName");
const aiModelProvider = document.getElementById("aiModelProvider");
const aiModelCode = document.getElementById("aiModelCode");
const aiModelBaseUrl = document.getElementById("aiModelBaseUrl");
const aiModelApiKey = document.getElementById("aiModelApiKey");
const aiModelEnabled = document.getElementById("aiModelEnabled");
const aiModelDefault = document.getElementById("aiModelDefault");
const aiModelsTableBody = document.getElementById("aiModelsTableBody");
const aiModelsCount = document.getElementById("aiModelsCount");
const refreshAiModelsBtn = document.getElementById("refreshAiModelsBtn");
const openAddAiModelBtn = document.getElementById("openAddAiModelBtn");
const closeAiModelModalBtn = document.getElementById("closeAiModelModalBtn");
const aiModelModalMask = document.getElementById("aiModelModalMask");
const testAiModelFormBtn = document.getElementById("testAiModelFormBtn");
const aiImageTaskPageMessage = document.getElementById("aiImageTaskPageMessage");
const aiImageTasksTableBody = document.getElementById("aiImageTasksTableBody");
const aiImageTaskSelectAll = document.getElementById("aiImageTaskSelectAll");
const aiImageTaskCount = document.getElementById("aiImageTaskCount");
const aiImageTaskWorkspace = document.getElementById("aiImageTaskWorkspace");
const refreshAiImageTasksBtn = document.getElementById("refreshAiImageTasksBtn");
const aiImageTaskSearchForm = document.getElementById("aiImageTaskSearchForm");
const aiImageTaskSearchInput = document.getElementById("aiImageTaskSearchInput");
const aiImageTaskSearchResetBtn = document.getElementById("aiImageTaskSearchResetBtn");
const openAiImagePromptSettingsBtn = document.getElementById("openAiImagePromptSettingsBtn");
const aiImagePromptSettingsModalMask = document.getElementById("aiImagePromptSettingsModalMask");
const closeAiImagePromptSettingsBtn = document.getElementById("closeAiImagePromptSettingsBtn");
const aiImagePromptForm = document.getElementById("aiImagePromptForm");
const aiImagePromptName = document.getElementById("aiImagePromptName");
const aiImagePromptModelId = document.getElementById("aiImagePromptModelId");
const aiImagePromptValue = document.getElementById("aiImagePromptValue");
const aiImagePromptDefault = document.getElementById("aiImagePromptDefault");
const aiImagePromptList = document.getElementById("aiImagePromptList");
const aiImageTaskStatusTabs = document.getElementById("aiImageTaskStatusTabs");
const closeAiImageTaskModalBtn = document.getElementById("closeAiImageTaskModalBtn");
const aiImageTaskModalMask = document.getElementById("aiImageTaskModalMask");
const aiImageTaskLogModalMask = document.getElementById("aiImageTaskLogModalMask");
const closeAiImageTaskLogModalBtn = document.getElementById("closeAiImageTaskLogModalBtn");
const aiImageTaskLogCode = document.getElementById("aiImageTaskLogCode");
const aiImageTaskLogContent = document.getElementById("aiImageTaskLogContent");
const aiImageTaskResultModalMask = document.getElementById("aiImageTaskResultModalMask");
const closeAiImageTaskResultModalBtn = document.getElementById("closeAiImageTaskResultModalBtn");
const aiImageTaskResultTitle = document.getElementById("aiImageTaskResultTitle");
const aiImageTaskResultCode = document.getElementById("aiImageTaskResultCode");
const aiImageTaskResultSourceImage = document.getElementById("aiImageTaskResultSourceImage");
const aiImageTaskResultImage = document.getElementById("aiImageTaskResultImage");
const aiImageTaskResultSourceEmpty = document.getElementById("aiImageTaskResultSourceEmpty");
const aiImageTaskResultEmpty = document.getElementById("aiImageTaskResultEmpty");
const aiImageTaskResultError = document.getElementById("aiImageTaskResultError");
const aiImageTaskForm = document.getElementById("aiImageTaskForm");
const aiImageTaskId = document.getElementById("aiImageTaskId");
const aiImageTaskFormTitle = document.getElementById("aiImageTaskFormTitle");
const aiImageTaskSourceType = document.getElementById("aiImageTaskSourceType");
const aiImageTaskSourceId = document.getElementById("aiImageTaskSourceId");
const aiImageTaskProductId = document.getElementById("aiImageTaskProductId");
const aiImageTaskSourceImageUrl = document.getElementById("aiImageTaskSourceImageUrl");
const aiImageTaskModelId = document.getElementById("aiImageTaskModelId");
const aiImageTaskStatus = document.getElementById("aiImageTaskStatus");
const aiImageTaskResultImageUrl = document.getElementById("aiImageTaskResultImageUrl");
const aiImageTaskErrorMessage = document.getElementById("aiImageTaskErrorMessage");
const aiImageTaskNotes = document.getElementById("aiImageTaskNotes");
const aiImageTaskResetProgress = document.getElementById("aiImageTaskResetProgress");
const saveAiImageTaskBtn = document.getElementById("saveAiImageTaskBtn");
const queueAiImageTaskBtn = document.getElementById("queueAiImageTaskBtn");
const aiImageTaskDetailCard = document.getElementById("aiImageTaskDetailCard");
const aiImageTaskDetail = document.getElementById("aiImageTaskDetail");
const aiImageTaskDetailTitle = document.getElementById("aiImageTaskDetailTitle");
const aiImageTaskDetailSubtitle = document.getElementById("aiImageTaskDetailSubtitle");
const aiImageTaskDetailStatus = document.getElementById("aiImageTaskDetailStatus");
const aiImageTaskSourcePreview = document.getElementById("aiImageTaskSourcePreview");
const aiImageTaskResultPreview = document.getElementById("aiImageTaskResultPreview");
const aiImageTaskDetailSourceType = document.getElementById("aiImageTaskDetailSourceType");
const aiImageTaskDetailSourceId = document.getElementById("aiImageTaskDetailSourceId");
const aiImageTaskDetailProductId = document.getElementById("aiImageTaskDetailProductId");
const aiImageTaskDetailModel = document.getElementById("aiImageTaskDetailModel");
const aiImageTaskDetailUpdatedAt = document.getElementById("aiImageTaskDetailUpdatedAt");
const aiImageTaskDetailProgress = document.getElementById("aiImageTaskDetailProgress");
const aiImageTaskDetailError = document.getElementById("aiImageTaskDetailError");
const aiImageTaskDetailEditBtn = document.getElementById("aiImageTaskDetailEditBtn");
const aiImageTaskDetailRetryBtn = document.getElementById("aiImageTaskDetailRetryBtn");
const aiImageTaskDetailDeleteBtn = document.getElementById("aiImageTaskDetailDeleteBtn");
let activeAiImageTaskId = "";
let aiImagePrompts = [];

function bindAiEvents() {
  if (refreshAiModelsBtn) refreshAiModelsBtn.addEventListener("click", () => loadAiConfigModels(true));
  if (openAddAiModelBtn) openAddAiModelBtn.addEventListener("click", openAddAiModelModal);
  if (closeAiModelModalBtn) closeAiModelModalBtn.addEventListener("click", closeAiModelModal);
  if (aiModelModalMask) aiModelModalMask.addEventListener("click", onAiModelModalMaskClick);
  if (testAiModelFormBtn) testAiModelFormBtn.addEventListener("click", testCurrentAiModel);
  if (aiModelForm) aiModelForm.addEventListener("submit", onAiModelFormSubmit);
  if (aiModelsTableBody) aiModelsTableBody.addEventListener("click", onAiModelsTableClick);
  if (aiModelProvider) aiModelProvider.addEventListener("change", syncAiProviderDefaults);
  document.addEventListener("keydown", onAiModelModalEscClose);
  
  if (refreshAiImageTasksBtn) refreshAiImageTasksBtn.addEventListener("click", () => loadAiImageTasks(true));
  if (aiImageTaskSearchForm) aiImageTaskSearchForm.addEventListener("submit", onAiImageTaskSearchSubmit);
  if (aiImageTaskSearchResetBtn) aiImageTaskSearchResetBtn.addEventListener("click", onAiImageTaskSearchReset);
  if (openAiImagePromptSettingsBtn) openAiImagePromptSettingsBtn.addEventListener("click", openAiImagePromptSettings);
  if (closeAiImagePromptSettingsBtn) closeAiImagePromptSettingsBtn.addEventListener("click", closeAiImagePromptSettings);
  if (aiImagePromptSettingsModalMask) aiImagePromptSettingsModalMask.addEventListener("click", (event) => { if (event.target === aiImagePromptSettingsModalMask) closeAiImagePromptSettings(); });
  if (aiImagePromptForm) aiImagePromptForm.addEventListener("submit", onAiImagePromptFormSubmit);
  if (aiImagePromptList) aiImagePromptList.addEventListener("click", onAiImagePromptListClick);
  if (closeAiImageTaskModalBtn) closeAiImageTaskModalBtn.addEventListener("click", closeAiImageTaskModal);
  if (aiImageTaskModalMask) aiImageTaskModalMask.addEventListener("click", onAiImageTaskModalMaskClick);
  if (closeAiImageTaskLogModalBtn) closeAiImageTaskLogModalBtn.addEventListener("click", closeAiImageTaskLogModal);
  if (aiImageTaskLogModalMask) aiImageTaskLogModalMask.addEventListener("click", (event) => {
  if (event.target === aiImageTaskLogModalMask) closeAiImageTaskLogModal();
  });
  if (closeAiImageTaskResultModalBtn) closeAiImageTaskResultModalBtn.addEventListener("click", closeAiImageTaskResultModal);
  if (aiImageTaskResultModalMask) aiImageTaskResultModalMask.addEventListener("click", (event) => {
  if (event.target === aiImageTaskResultModalMask) closeAiImageTaskResultModal();
  });
  if (aiImageTaskForm) aiImageTaskForm.addEventListener("submit", onAiImageTaskFormSubmit);
  if (aiImageTasksTableBody) aiImageTasksTableBody.addEventListener("click", onAiImageTasksTableClick);
  if (aiImageTasksTableBody) aiImageTasksTableBody.addEventListener("change", onAiImageTaskCheckboxChange);
  if (aiImageTaskSelectAll) aiImageTaskSelectAll.addEventListener("change", onAiImageTaskSelectAllChange);
  if (queueAiImageTaskBtn) queueAiImageTaskBtn.addEventListener("click", onQueueAiImageTask);
  if (aiImageTaskStatusTabs) aiImageTaskStatusTabs.addEventListener("click", onAiImageTaskStatusTabClick);
  if (aiImageTaskDetailEditBtn) aiImageTaskDetailEditBtn.addEventListener("click", () => {
  const task = getAiImageTaskById(state.aiImageTaskSelectedId);
  if (task) openAiImageTaskModal(task);
  });
  if (aiImageTaskDetailRetryBtn) aiImageTaskDetailRetryBtn.addEventListener("click", async () => {
  const id = String(state.aiImageTaskSelectedId || "").trim();
  if (id) await retryAiImageTaskById(id);
  });
  if (aiImageTaskDetailDeleteBtn) aiImageTaskDetailDeleteBtn.addEventListener("click", async () => {
  const id = String(state.aiImageTaskSelectedId || "").trim();
  const task = getAiImageTaskById(id);
  if (!id || !task) return;
  if (!window.confirm(`确定删除 AI 图任务“${id}”吗？`)) return;
  const result = await apiRequest(`/api/ai/image-tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!result.ok) {
  if (aiImageTaskPageMessage) {
  aiImageTaskPageMessage.style.color = "#c02030";
  aiImageTaskPageMessage.textContent = result.error || "删除失败";
  }
  return;
  }
  state.aiImageTaskSelectedId = "";
  activeAiImageTaskId = "";
  await loadAiImageTasks();
  if (aiImageTaskPageMessage) {
  aiImageTaskPageMessage.style.color = "#1d6f3a";
  aiImageTaskPageMessage.textContent = "AI 图任务已删除";
  }
  });
  document.addEventListener("keydown", onAiImageTaskModalEscClose);
  
  
  
  if (aiModelSelect) aiModelSelect.addEventListener("click", onAiModelSelectClick);
  document.addEventListener("click", closeAiModelMenu);
  if (aiPasteArea) aiPasteArea.addEventListener("paste", onAiPaste);
  if (aiPasteArea) aiPasteArea.addEventListener("input", onAiPasteInput);
  if (aiImageInput) aiImageInput.addEventListener("change", onAiImageUpload);
  if (aiSendBtn) aiSendBtn.addEventListener("click", onAiSend);
  if (aiClearBtn) aiClearBtn.addEventListener("click", clearAiComposer);
  if (aiPingBtn) aiPingBtn.addEventListener("click", onAiPing);
}
