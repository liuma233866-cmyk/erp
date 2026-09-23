"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AuthAdapter } = require("./authAdapter");
const { TenantAdapter } = require("./tenantAdapter");
const { PermissionAdapter } = require("./permissionAdapter");
const { ERROR_CODES, V2Error } = require("../core/errorCodes");

test("auth adapter verifies bearer tokens through an injected adapter", async () => {
  const auth = new AuthAdapter({ verifyToken: async (token) => token === "good" ? { id: "u-1", companyId: "c-1" } : null });
  await assert.rejects(() => auth.authenticate({ headers: {} }), (error) => error.code === ERROR_CODES.AUTH_REQUIRED);
  await assert.rejects(() => auth.authenticate({ headers: { authorization: "Bearer bad" } }), (error) => error.code === ERROR_CODES.AUTH_INVALID);
  assert.deepEqual(await auth.authenticate({ headers: { authorization: "Bearer good" } }), { id: "u-1", companyId: "c-1" });
});

test("tenant adapter prevents cross-company access", () => {
  const tenant = new TenantAdapter();
  assert.equal(tenant.resolve({ id: "u-1", companyId: "c-1" }), "c-1");
  assert.throws(() => tenant.resolve({ id: "u-1", companyId: "c-1" }, "c-2"), (error) => error instanceof V2Error && error.code === ERROR_CODES.TENANT_FORBIDDEN);
  assert.equal(tenant.resolve({ id: "u-1", companyId: "c-1", isPlatformAdmin: true }, "c-2"), "c-2");
});

test("permission adapter supports user permissions and role defaults", () => {
  const permissions = new PermissionAdapter({ permissions: { operator: ["product.read"] } });
  assert.equal(permissions.has({ role: "operator" }, "product.read"), true);
  assert.equal(permissions.has({ permissions: ["product.write"] }, "product.write"), true);
  assert.throws(() => permissions.require({ role: "operator" }, "product.publish"), (error) => error.code === ERROR_CODES.PERMISSION_DENIED);
});
