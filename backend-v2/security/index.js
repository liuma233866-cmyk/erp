"use strict";

const { AuthAdapter } = require("./authAdapter");
const { TenantAdapter } = require("./tenantAdapter");
const { PermissionAdapter } = require("./permissionAdapter");

function createSecurityAdapters(options = {}) {
  return {
    auth: new AuthAdapter({ verifyToken: options.verifyToken }),
    tenant: new TenantAdapter({ resolveCompanyId: options.resolveCompanyId }),
    permission: new PermissionAdapter({
      permissions: options.permissions,
      resolvePermissions: options.resolvePermissions
    })
  };
}

module.exports = {
  AuthAdapter,
  TenantAdapter,
  PermissionAdapter,
  createSecurityAdapters
};
