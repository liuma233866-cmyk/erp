const ROLE_ADMIN = "admin";
const ROLE_OPERATIONS = "operations";
const ROLE_SUPPORT = "support";
const ROLE_FINANCE = "finance";
const ROLE_SUPERVISOR = "supervisor";
const ALL_ROLES = [ROLE_ADMIN, ROLE_OPERATIONS, ROLE_SUPPORT, ROLE_FINANCE, ROLE_SUPERVISOR];
const SHOP_RESTRICTED_ROLES = new Set([ROLE_OPERATIONS, ROLE_SUPPORT, ROLE_FINANCE]);

const PERMISSIONS = {
  [ROLE_ADMIN]: new Set([
    "order.read",
    "order.create",
    "order.update",
    "order.update_status",
    "order.delete",
    "order.void",
    "order.reactivate",
    "product.read",
    "product.sync",
    "user.read",
    "user.create",
    "user.delete",
    "user.role.update",
    "user.shop.permission.update",
    "shop.read",
    "shop.create",
    "shop.delete",
    "shop.toggle",
    "message.read",
    "message.create",
    "product.ai",
    "ai.config",
    "audit.read"
  ]),
  [ROLE_OPERATIONS]: new Set([
    "order.read",
    "order.create",
    "order.update",
    "order.update_status",
    "order.void",
    "order.reactivate",
    "product.read",
    "product.sync",
    "message.read",
    "message.create",
    "product.ai",
    "ai.config"
  ]),
  [ROLE_SUPPORT]: new Set(["order.read", "order.update_status", "product.read", "message.read", "message.create", "product.ai"]),
  [ROLE_FINANCE]: new Set(["order.read", "product.read", "message.read", "message.create", "product.ai"]),
  [ROLE_SUPERVISOR]: new Set([
    "order.read",
    "order.create",
    "order.update",
    "order.update_status",
    "order.void",
    "order.reactivate",
    "product.read",
    "product.sync",
    "user.read",
    "user.create",
    "user.delete",
    "user.role.update",
    "user.shop.permission.update",
    "shop.read",
    "shop.create",
    "shop.delete",
    "shop.toggle",
    "message.read",
    "message.create",
    "product.ai",
    "ai.config"
  ])
};

function normalizeRole(role, username, fallbackRole = ROLE_SUPPORT) {
  if (ALL_ROLES.includes(role)) return role;
  if (String(username).toLowerCase() === "admin") return ROLE_ADMIN;
  return fallbackRole;
}

function isShopRestrictedRole(role) {
  return SHOP_RESTRICTED_ROLES.has(role);
}

function getRoleShopPermissionDefaults(role) {
  if (isShopRestrictedRole(role)) {
    return { shopRead: false, shopCreate: false, shopDelete: false, shopToggle: false };
  }
  const set = PERMISSIONS[role];
  return {
    shopRead: Boolean(set && set.has("shop.read")),
    shopCreate: Boolean(set && set.has("shop.create")),
    shopDelete: Boolean(set && set.has("shop.delete")),
    shopToggle: Boolean(set && set.has("shop.toggle"))
  };
}

function normalizeShopPermissions(rawPermissions, role) {
  if (isShopRestrictedRole(role)) {
    return { shopRead: false, shopCreate: false, shopDelete: false, shopToggle: false };
  }
  const defaults = getRoleShopPermissionDefaults(role);
  if (!rawPermissions || typeof rawPermissions !== "object") {
    return defaults;
  }

  const next = {
    shopRead: typeof rawPermissions.shopRead === "boolean" ? rawPermissions.shopRead : defaults.shopRead,
    shopCreate: typeof rawPermissions.shopCreate === "boolean" ? rawPermissions.shopCreate : defaults.shopCreate,
    shopDelete: typeof rawPermissions.shopDelete === "boolean" ? rawPermissions.shopDelete : defaults.shopDelete,
    shopToggle: typeof rawPermissions.shopToggle === "boolean" ? rawPermissions.shopToggle : defaults.shopToggle
  };

  if ((next.shopCreate || next.shopDelete || next.shopToggle) && !next.shopRead) {
    next.shopRead = true;
  }
  return next;
}

function getEffectiveShopPermissions(user, fallbackRole = ROLE_SUPPORT) {
  const role = normalizeRole(user.role, user.username, fallbackRole);
  return normalizeShopPermissions(user.shopPermissions, role);
}

module.exports = {
  ALL_ROLES,
  PERMISSIONS,
  ROLE_ADMIN,
  ROLE_FINANCE,
  ROLE_OPERATIONS,
  ROLE_SUPERVISOR,
  ROLE_SUPPORT,
  SHOP_RESTRICTED_ROLES,
  getEffectiveShopPermissions,
  getRoleShopPermissionDefaults,
  isShopRestrictedRole,
  normalizeRole,
  normalizeShopPermissions
};
