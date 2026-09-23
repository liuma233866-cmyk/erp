"use strict";

const { ERROR_CODES, V2Error } = require("../core/errorCodes");

class PermissionAdapter {
  constructor({ permissions = {}, resolvePermissions } = {}) {
    this.permissions = permissions;
    this.resolvePermissions = typeof resolvePermissions === "function"
      ? resolvePermissions
      : (user) => user?.permissions || [];
  }

  has(user, permission) {
    const granted = this.resolvePermissions(user);
    if (granted === "*") return true;
    if (Array.isArray(granted) && granted.includes(permission)) return true;
    const role = String(user?.role || "").trim();
    return Boolean(this.permissions[role]?.includes?.(permission));
  }

  require(user, permission) {
    if (!this.has(user, permission)) {
      throw new V2Error(ERROR_CODES.PERMISSION_DENIED, `Permission required: ${permission}`);
    }
    return true;
  }
}

module.exports = { PermissionAdapter };
