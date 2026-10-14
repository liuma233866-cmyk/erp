function setAddUserPasswordVisibility(visible) {
  if (!addUserPassword) return;
  addUserPassword.type = visible ? "text" : "password";
  if (toggleAddUserPasswordBtn) {
    toggleAddUserPasswordBtn.textContent = visible ? "🙈" : "👁";
    toggleAddUserPasswordBtn.setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
    toggleAddUserPasswordBtn.setAttribute("aria-pressed", visible ? "true" : "false");
  }
}

function toggleAddUserPasswordVisibility() {
  setAddUserPasswordVisibility(addUserPassword?.type === "password");
}

function onGenerateAddUserPassword() {
  if (!addUserPassword || !can("userManage")) return;
  const username = String(addUserForm?.elements?.username?.value || "").trim().toLowerCase();
  let generated = generateStrongPassword();
  for (let attempt = 0; username && generated.toLowerCase().includes(username) && attempt < 10; attempt += 1) {
    generated = generateStrongPassword();
  }
  addUserPassword.value = generated;
  setAddUserPasswordVisibility(true);
  addUserPassword.focus();
  addUserPassword.select();
  setAddUserMessage("已生成强密码，请妥善保存", "#1d6f3a");
}

function setAddUserMessage(message, color = "#c02030") {
  if (usersMessage) {
    usersMessage.style.color = color;
    usersMessage.textContent = message || "";
  }
  if (addUserModalMessage) {
    addUserModalMessage.style.color = color;
    addUserModalMessage.textContent = message || "";
  }
}

function openAddUserModal() {
  if (!can("userManage")) return;
  if (addUserForm) addUserForm.reset();
  setAddUserPasswordVisibility(false);
  applyRoleVisibility();
  setAddUserMessage("");
  if (addUserModalMask) addUserModalMask.classList.remove("hidden");
  addUserForm?.querySelector("input[name='username']")?.focus();
}

function closeAddUserModal() {
  if (addUserModalMask) addUserModalMask.classList.add("hidden");
}

function onAddUserModalMaskClick(event) {
  if (event.target === addUserModalMask) closeAddUserModal();
}

function onAddUserModalEscClose(event) {
  if (event.key === "Escape" && addUserModalMask && !addUserModalMask.classList.contains("hidden")) {
    closeAddUserModal();
  }
}

async function onAddUserSubmit(event) {
  event.preventDefault();
  setAddUserMessage("");
  if (!can("userManage")) {
    setAddUserMessage("无权限查看");
    return;
  }

  const form = new FormData(addUserForm);
  const companyName = String(form.get("companyName") || state.user?.companyName || "").trim();
  const username = String(form.get("username") || "").trim();
  const password = String(form.get("password") || "");
  const role = String(form.get("role") || "operations");
  if (!validateCredentials(username, password, addUserModalMessage || usersMessage)) {
    setAddUserMessage((addUserModalMessage || usersMessage)?.textContent || "密码不符合要求");
    return;
  }
  if (!companyName) {
    setAddUserMessage("公司户名称不能为空");
    return;
  }

  const result = await apiRequest("/api/users", {
    method: "POST",
    body: JSON.stringify({ companyName, username, password, role })
  });
  if (!result.ok) {
    setAddUserMessage(result.error || "创建失败");
    return;
  }

  addUserForm.reset();
  const companyInput = addUserForm.querySelector("input[name='companyName']");
  if (companyInput) companyInput.value = String(state.user?.companyName || "系统");
  setAddUserPasswordVisibility(false);
  closeAddUserModal();
  setAddUserMessage("用户已创建", "#1d6f3a");
  await loadUsers();
}

function openCreateCompanyModal() {
  if (state.user?.role !== "admin") return;
  if (createCompanyForm) createCompanyForm.reset();
  if (createCompanyModalMask) createCompanyModalMask.classList.remove("hidden");
}

function closeCreateCompanyModal() {
  if (createCompanyModalMask) createCompanyModalMask.classList.add("hidden");
}

function onCreateCompanyModalMaskClick(event) {
  if (event.target === createCompanyModalMask) closeCreateCompanyModal();
}

function onCreateCompanyModalEscClose(event) {
  if (event.key === "Escape" && createCompanyModalMask && !createCompanyModalMask.classList.contains("hidden")) {
    closeCreateCompanyModal();
  }
}

async function onCreateCompanySubmit(event) {
  event.preventDefault();
  if (usersMessage) {
    usersMessage.style.color = "#c02030";
    usersMessage.textContent = "";
  }
  if (state.user?.role !== "admin") {
    if (usersMessage) usersMessage.textContent = "无权限查看";
    return;
  }

  const form = new FormData(createCompanyForm);
  const companyName = String(form.get("companyName") || "").trim();
  const username = String(form.get("username") || "").trim();
  const password = String(form.get("password") || "");
  if (!companyName) {
    if (usersMessage) usersMessage.textContent = "公司名不能为空";
    return;
  }
  if (!validateCredentials(username, password, usersMessage)) return;

  const result = await apiRequest("/api/users", {
    method: "POST",
    body: JSON.stringify({ companyName, username, password, role: "supervisor" })
  });
  if (!result.ok) {
    if (usersMessage) usersMessage.textContent = result.error || "创建失败";
    return;
  }

  closeCreateCompanyModal();
  if (createCompanyForm) createCompanyForm.reset();
  if (usersMessage) {
    usersMessage.style.color = "#1d6f3a";
    usersMessage.textContent = "公司户已创建";
  }
  await loadUsers();
}

async function loadUsers() {
  if (!usersTableBody) return;
  if (usersMessage) usersMessage.textContent = "";
  if (!can("userManage")) {
    usersTableBody.innerHTML = "<tr><td colspan='7'>仅管理员可查看</td></tr>";
    return false;
  }

  if (canShopRead()) {
    const shopsResult = await apiRequest("/api/shops", { method: "GET" });
    if (shopsResult.ok) {
      state.shops = shopsResult.data.items || [];
    }
  }

  usersTableBody.innerHTML = "<tr><td colspan='7'>加载中...</td></tr>";
  const result = await apiRequest("/api/users", { method: "GET" });
  if (!result.ok) {
    usersTableBody.innerHTML = "<tr><td colspan='7'>加载失败</td></tr>";
    if (usersMessage) usersMessage.textContent = result.error || "用户加载失败";
    return false;
  }
  renderUsersTable(result.data.items || []);
  return true;
}

function renderUsersTable(items) {
  if (!usersTableBody) return;
  if (!items.length) {
    usersTableBody.innerHTML = "<tr><td colspan='7'>暂无用户</td></tr>";
    return;
  }

  const isAdmin = state.user?.role === "admin";
  const isCompanyAdmin = state.user?.role === "supervisor";
  const roleOptions = isAdmin
    ? ["supervisor", "operations", "finance"]
    : isCompanyAdmin
      ? ["operations", "finance"]
      : [];
  usersTableBody.innerHTML = items
    .map((user) => {
      const targetIsAdmin = user.role === "admin";
      const targetIsCompanyAdmin = user.role === "supervisor";
      const canEdit = !targetIsAdmin && (isAdmin || (isCompanyAdmin && !targetIsCompanyAdmin && isSameCompanyEntity(user, state.user)));
      const roleSelect = canEdit && roleOptions.length
        ? `<select class="role-select" data-field="role">${roleOptions
            .map((role) => `<option value="${role}" ${user.role === role ? "selected" : ""}>${escapeHtml(getRoleLabel(role))}</option>`)
            .join("")}</select>
           <button class="small-btn" data-action="save-role">保存角色</button>`
        : `<span>${escapeHtml(getRoleLabel(user.role))}</span>`;
      const currentShopPerm = user.shopPermissions || {};
      const permissionLevel = currentShopPerm.shopCreate || currentShopPerm.shopToggle
        ? "manage"
        : currentShopPerm.shopRead
          ? "read"
          : "none";
      const canEditShopPermission = canEdit && user.role === "operations";
      const shopPermissionCell = targetIsAdmin
        ? "-"
        : user.role !== "operations"
          ? "角色固定"
          : canEditShopPermission
            ? `<div class="user-shop-assignment">
                <select class="role-select" data-field="shop-permissions">
                  <option value="none" ${permissionLevel === "none" ? "selected" : ""}>不可见店铺</option>
                  <option value="read" ${permissionLevel === "read" ? "selected" : ""}>仅查看店铺</option>
                  <option value="manage" ${permissionLevel === "manage" ? "selected" : ""}>可管理店铺</option>
                </select>
                <button class="small-btn" data-action="save-shop-permissions">保存权限</button>
              </div>`
            : permissionLevel === "manage"
              ? "可管理店铺"
              : permissionLevel === "read"
                ? "仅查看店铺"
                : "不可见店铺";
      const companyShops = (state.shops || []).filter((shop) => isSameCompanyEntity(shop, user));
      const selectedShopIds = new Set(Array.isArray(user.shopAssignments) ? user.shopAssignments.map((id) => String(id || "").trim()) : []);
      const selectedShopId = Array.from(selectedShopIds)[0] || "";
      const shopAssignmentCell = targetIsAdmin
        ? "-"
        : user.role === "supervisor"
          ? "本公司全部店铺"
          : canEdit
            ? `<div class="user-shop-assignment">
                <select class="role-select" data-field="shop-assignments">
                  <option value="" ${!selectedShopId ? "selected" : ""}>未分配店铺</option>
                  ${companyShops.map((shop) => {
                    const shopId = String(shop.id || "").trim();
                    const selected = selectedShopId === shopId ? "selected" : "";
                    return `<option value="${escapeHtml(shopId)}" ${selected}>${escapeHtml(shop.name || shopId)}</option>`;
                  }).join("")}
                </select>
                <button class="small-btn" data-action="save-shop-assignments">保存店铺</button>
              </div>`
            : selectedShopId
              ? (() => {
                  const target = companyShops.find((shop) => String(shop.id || "").trim() === selectedShopId);
                  return escapeHtml(target?.name || selectedShopId);
                })()
              : "未分配店铺";
      const deleteCell = isAdmin && !targetIsAdmin
        ? `<button class="small-btn danger-btn" data-action="delete-user">删除</button>`
        : isCompanyAdmin && !targetIsAdmin && !targetIsCompanyAdmin
          ? `<button class="small-btn danger-btn" data-action="delete-user">删除</button>`
          : "-";
      return `<tr data-user-id="${escapeHtml(user.id)}">
        <td>${escapeHtml(user.companyName || "-")}</td>
        <td>${escapeHtml(user.username)}</td>
        <td>${roleSelect}</td>
        <td>${shopPermissionCell}</td>
        <td>${shopAssignmentCell}</td>
        <td>${user.createdAt ? new Date(user.createdAt).toLocaleString("zh-CN") : "-"}</td>
        <td>${deleteCell}</td>
      </tr>`;
    })
    .join("");
}

async function onUsersTableClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const row = button.closest("tr");
  if (!row) return;
  const userId = row.dataset.userId;
  const action = button.dataset.action;

  if (!can("userManage")) {
    usersMessage.textContent = "无权限操作";
    return;
  }

  if (action === "save-role") {
    const isAdmin = state.user?.role === "admin";
    const isCompanyAdmin = state.user?.role === "supervisor";
    if (!isAdmin && !isCompanyAdmin) {
      usersMessage.textContent = "无权限操作";
      return;
    }
    const select = row.querySelector("select[data-field='role']");
    const role = select ? select.value : "";
    const result = await apiRequest(`/api/users/${encodeURIComponent(userId)}/role`, {
      method: "PUT",
      body: JSON.stringify({ role })
    });
    if (!result.ok) {
      usersMessage.textContent = result.error || "保存失败";
      return;
    }
    usersMessage.style.color = "#1d6f3a";
    usersMessage.textContent = "角色已更新";
    await loadUsers();
    return;
  }

  if (action === "save-shop-assignments") {
    const select = row.querySelector("select[data-field='shop-assignments']");
    if (!select) {
      usersMessage.textContent = "该用户角色无需店铺绑定";
      return;
    }
    const selected = String(select.value || "").trim();
    const shopIds = selected ? [selected] : [];
    const result = await apiRequest(`/api/users/${encodeURIComponent(userId)}/shop-assignments`, {
      method: "PUT",
      body: JSON.stringify({ shopIds })
    });
    if (!result.ok) {
      usersMessage.textContent = result.error || "保存失败";
      return;
    }
    usersMessage.style.color = "#1d6f3a";
    usersMessage.textContent = "店铺分配已更新";
    await loadUsers();
    return;
  }

  if (action === "save-shop-permissions") {
    const select = row.querySelector("select[data-field='shop-permissions']");
    if (!select) {
      usersMessage.textContent = "该用户角色无需店铺权限配置";
      return;
    }
    const level = String(select.value || "none").trim();
    const payload = level === "manage"
      ? { shopRead: true, shopCreate: true, shopToggle: true }
      : level === "read"
        ? { shopRead: true, shopCreate: false, shopToggle: false }
        : { shopRead: false, shopCreate: false, shopToggle: false };
    const result = await apiRequest(`/api/users/${encodeURIComponent(userId)}/shop-permissions`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    if (!result.ok) {
      usersMessage.textContent = result.error || "保存失败";
      return;
    }
    usersMessage.style.color = "#1d6f3a";
    usersMessage.textContent = "店铺权限已更新";
    await loadUsers();
    return;
  }

  if (action === "delete-user") {
    const canDeleteUser = state.user?.role === "admin" || state.user?.role === "supervisor";
    if (!canDeleteUser) {
      usersMessage.textContent = "无权限操作";
      return;
    }
    const ok = confirm("确认删除用户？");
    if (!ok) return;
    const result = await apiRequest(`/api/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
    if (!result.ok) {
      usersMessage.textContent = result.error || "删除失败";
      return;
    }
    usersMessage.style.color = "#1d6f3a";
    usersMessage.textContent = "用户已删除";
    await loadUsers();
  }
}

// 从 app.js 下沉的 DOM 常量与事件绑定。

const addUserForm = document.getElementById("addUserForm");
const openAddUserModalBtn = document.getElementById("openAddUserModalBtn");
const addUserModalMask = document.getElementById("addUserModalMask");
const addUserModalMessage = document.getElementById("addUserModalMessage");
const addUserPassword = document.getElementById("addUserPassword");
const toggleAddUserPasswordBtn = document.getElementById("toggleAddUserPasswordBtn");
const generateAddUserPasswordBtn = document.getElementById("generateAddUserPasswordBtn");
const closeAddUserModalBtn = document.getElementById("closeAddUserModalBtn");
const cancelAddUserBtn = document.getElementById("cancelAddUserBtn");
const openCreateCompanyModalBtn = document.getElementById("openCreateCompanyModalBtn");
const refreshUsersBtn = document.getElementById("refreshUsersBtn");
const usersMessage = document.getElementById("usersMessage");
const usersTableBody = document.getElementById("usersTableBody");
const createCompanyModalMask = document.getElementById("createCompanyModalMask");
const createCompanyForm = document.getElementById("createCompanyForm");
const closeCreateCompanyModalBtn = document.getElementById("closeCreateCompanyModalBtn");
const cancelCreateCompanyBtn = document.getElementById("cancelCreateCompanyBtn");

function bindUsersEvents() {
  if (openAddUserModalBtn) openAddUserModalBtn.addEventListener("click", openAddUserModal);
  if (closeAddUserModalBtn) closeAddUserModalBtn.addEventListener("click", closeAddUserModal);
  if (cancelAddUserBtn) cancelAddUserBtn.addEventListener("click", closeAddUserModal);
  if (addUserModalMask) addUserModalMask.addEventListener("click", onAddUserModalMaskClick);
  if (toggleAddUserPasswordBtn) toggleAddUserPasswordBtn.addEventListener("click", toggleAddUserPasswordVisibility);
  if (generateAddUserPasswordBtn) generateAddUserPasswordBtn.addEventListener("click", onGenerateAddUserPassword);
  document.addEventListener("keydown", onAddUserModalEscClose);
  
  if (openCreateCompanyModalBtn) openCreateCompanyModalBtn.addEventListener("click", openCreateCompanyModal);
  if (closeCreateCompanyModalBtn) closeCreateCompanyModalBtn.addEventListener("click", closeCreateCompanyModal);
  if (cancelCreateCompanyBtn) cancelCreateCompanyBtn.addEventListener("click", closeCreateCompanyModal);
  if (createCompanyModalMask) createCompanyModalMask.addEventListener("click", onCreateCompanyModalMaskClick);
  if (createCompanyForm) createCompanyForm.addEventListener("submit", onCreateCompanySubmit);
  document.addEventListener("keydown", onCreateCompanyModalEscClose);
  
  if (refreshUsersBtn) refreshUsersBtn.addEventListener("click", loadUsers);
  if (addUserForm) addUserForm.addEventListener("submit", onAddUserSubmit);
  if (usersTableBody) usersTableBody.addEventListener("click", onUsersTableClick);
}
