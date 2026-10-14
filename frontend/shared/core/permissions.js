// 从 app.js 拆出的权限判断模块（classic script，全局作用域）。

const PERMISSIONS = {
  admin: {
    orderRead: true,
    orderCreate: true,
    orderUpdate: true,
    orderUpdateStatus: true,
    orderDelete: true,
    orderVoid: true,
    orderReactivate: true,
    userManage: true,
    shopRead: true,
    shopCreate: true,
    shopToggle: true,
    shopDelete: true,
    messageRead: true,
    messageCreate: true,
    productAi: true,
    productRead: true,
    productSync: true,
    aiConfig: true
  },
  operations: {
    orderRead: true,
    orderCreate: true,
    orderUpdate: true,
    orderUpdateStatus: true,
    orderDelete: false,
    orderVoid: true,
    orderReactivate: true,
    userManage: false,
    shopRead: false,
    shopCreate: false,
    shopToggle: false,
    shopDelete: false,
    messageRead: true,
    messageCreate: true,
    productAi: true,
    productRead: true,
    productSync: true,
    aiConfig: true
  },
  support: {
    orderRead: true,
    orderCreate: false,
    orderUpdate: false,
    orderUpdateStatus: true,
    orderDelete: false,
    orderVoid: false,
    orderReactivate: false,
    userManage: false,
    shopRead: false,
    shopCreate: false,
    shopToggle: false,
    shopDelete: false,
    messageRead: true,
    messageCreate: true,
    productAi: true,
    productRead: true,
    productSync: false
  },
  finance: {
    orderRead: true,
    orderCreate: false,
    orderUpdate: false,
    orderUpdateStatus: false,
    orderDelete: false,
    orderVoid: false,
    orderReactivate: false,
    userManage: false,
    shopRead: false,
    shopCreate: false,
    shopToggle: false,
    shopDelete: false,
    messageRead: true,
    messageCreate: true,
    productAi: true,
    productRead: true,
    productSync: false
  },
  supervisor: {
  product_dev: "产品开发",
    orderRead: true,
    orderCreate: true,
    orderUpdate: true,
    orderUpdateStatus: true,
    orderDelete: false,
    orderVoid: true,
    orderReactivate: true,
    userManage: true,
    shopRead: true,
    shopCreate: true,
    shopToggle: true,
    shopDelete: true,
    messageRead: true,
    messageCreate: true,
    productAi: true,
    productRead: true,
    productSync: true,
    aiConfig: true
  }
};
const ROLE_LABELS = {
  // The system account is reserved for IT development; company supervisors
  // are the super-admins for their own company and cannot cross tenants.
  admin: "IT开发管理员",
  operations: "运营",
  support: "客服",
  finance: "财务",
  supervisor: "超级管理员"
};
function can(permissionKey) {
  const role = state.user?.role;
  if (!role) return false;
  if ((permissionKey === "shopRead" || permissionKey === "shopCreate" || permissionKey === "shopToggle") && isShopRestrictedRole(role)) {
    return false;
  }
  const shopPermissionKeyMap = { shopRead: "shopRead", shopCreate: "shopCreate", shopToggle: "shopToggle" };
  if (shopPermissionKeyMap[permissionKey] && state.user?.shopPermissions) {
    return Boolean(state.user.shopPermissions[shopPermissionKeyMap[permissionKey]]);
  }
  const rolePerms = PERMISSIONS[role] || {};
  return Boolean(rolePerms[permissionKey]);
}
function canAuditRead() {
  return state.user?.role === "admin";
}
function canShopRead() {
  return can("shopRead");
}
function canMessageRead() {
  return can("messageRead");
}
function isShopRestrictedRole(role) {
  return role === "support" || role === "finance";
}
function isPanelBlocked(panelId, capability = null) {
  const caps = capability || {
    canManageUsers: can("userManage"),
    canReadShops: canShopRead(),
    canReadAudit: canAuditRead(),
    canUseProductAi: can("productAi"),
    canManageAiConfig: can("aiConfig"),
    canManageAiImageTasks: can("aiConfig"),
    canManageCategoryMapping: can("productSync")
  };
  return (
    (panelId === "usersPanel" && !caps.canManageUsers) ||
    (panelId === "apiPanel" && !caps.canReadShops) ||
    (panelId === "logsPanel" && !caps.canReadAudit) ||
    (panelId === "aiPanel" && !caps.canUseProductAi) ||
    (panelId === "aiConfigPanel" && !caps.canManageAiConfig) ||
    (panelId === "aiImageTaskPanel" && !caps.canManageAiImageTasks) ||
    (panelId === "categoryMappingPanel" && !caps.canManageCategoryMapping) ||
    (panelId === "reviewRulesPanel" && !can("productSync"))
  );
}

// 从 app.js 迁出的公司域判断与角色可见性应用。

function getCompanyScopeKey(entity) {
  if (!entity || typeof entity !== "object") return "";
  const companyId = String(entity.companyId || "").trim();
  const companyName = String(entity.companyName || "").trim();
  // Include both dimensions in the key so entities that carry only the id can
  // still match entities that carry only the name (same company), instead of
  // the asymmetric id:X vs name:Y keys that never compare equal.
  return [companyId ? `id:${companyId}` : "", companyName ? `name:${companyName}` : ""].filter(Boolean).join("|");
}

function isSameCompanyEntity(left, right) {
  const leftKey = getCompanyScopeKey(left);
  const rightKey = getCompanyScopeKey(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;
  // Cross-dimension fallback: one side has an id, the other only a name.
  const leftId = String(left?.companyId || "").trim();
  const rightId = String(right?.companyId || "").trim();
  const leftName = String(left?.companyName || "").trim();
  const rightName = String(right?.companyName || "").trim();
  return Boolean((leftId && leftId === rightId) || (leftName && leftName === rightName));
}

function applyRoleVisibility() {
  if (openAddUserModalBtn) openAddUserModalBtn.classList.toggle("hidden", !can("userManage"));
  if (addUserForm) {
    const companyInput = addUserForm.querySelector("input[name='companyName']");
    const roleSelect = addUserForm.querySelector("select[name='role']");
    if (companyInput) {
      const companyName = String(state.user?.companyName || "系统").trim();
      companyInput.readOnly = state.user?.role !== "admin";
      companyInput.value = companyName;
      companyInput.placeholder = state.user?.role === "admin" ? "公司户名称" : companyName || "当前公司户";
    }
    if (roleSelect) {
      const isAdmin = state.user?.role === "admin";
      const options = isAdmin
        ? [
            ["supervisor", getRoleLabel("supervisor")],
              ["product_dev", "产品开发"],
            ["operations", "运营"],
            ["finance", "财务"]
          ]
        : [
            ["operations", "运营"],
            ["finance", "财务"]
          ];
      const currentValue = String(roleSelect.value || "").trim();
      roleSelect.innerHTML = options
        .map(([value, label]) => `<option value="${value}" ${currentValue === value ? "selected" : ""}>${label}</option>`)
        .join("");
      if (!roleSelect.value && options.length) roleSelect.value = options[0][0];
    }
  }
  if (openCreateCompanyModalBtn) openCreateCompanyModalBtn.classList.toggle("hidden", state.user?.role !== "admin");
  if (openAddShopModalBtn) openAddShopModalBtn.classList.toggle("hidden", !can("shopCreate"));
  if (addMessageForm) addMessageForm.classList.toggle("hidden", !can("messageCreate"));
  if (aiModelSelect) aiModelSelect.classList.toggle("hidden", !can("productAi"));
  if (aiPingBtn) aiPingBtn.classList.toggle("hidden", !can("productAi"));

  if (aiPasteArea) aiPasteArea.classList.toggle("hidden", !can("productAi"));
  if (aiPromptInput) aiPromptInput.classList.toggle("hidden", !can("productAi"));
  if (aiSendBtn) aiSendBtn.classList.toggle("hidden", !can("productAi"));
  if (syncOnlineProductsBtn) syncOnlineProductsBtn.classList.toggle("hidden", !can("productSync"));
  if (onlineExportBtn) onlineExportBtn.classList.toggle("hidden", !can("productRead"));
  document.querySelectorAll("[data-view='reviewRulesPanel']").forEach((el) => (el.style.display = can("productSync") ? "" : "none"));
  document.querySelectorAll("[data-view='categoryMappingPanel']").forEach((el) => (el.style.display = can("productSync") ? "" : "none"));
  document.querySelectorAll("[data-view='aiConfigPanel']").forEach((el) => (el.style.display = can("aiConfig") ? "" : "none"));
}
