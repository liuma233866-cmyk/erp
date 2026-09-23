const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ROLE_ADMIN,
  ROLE_OPERATIONS,
  ROLE_SUPPORT,
  ROLE_FINANCE,
  ROLE_SUPERVISOR,
  getEffectiveShopPermissions,
  getRoleShopPermissionDefaults,
  isShopRestrictedRole,
  normalizeRole,
  normalizeShopPermissions
} = require("./permissions");

test("assigns each role its expected permission set", () => {
  const { PERMISSIONS } = require("./permissions");
  assert.ok(PERMISSIONS[ROLE_ADMIN].has("order.delete"));
  assert.ok(PERMISSIONS[ROLE_ADMIN].has("user.role.update"));
  assert.ok(PERMISSIONS[ROLE_SUPERVISOR].has("user.create"));
  assert.ok(PERMISSIONS[ROLE_SUPERVISOR].has("user.delete"));
  assert.ok(PERMISSIONS[ROLE_SUPERVISOR].has("user.role.update"));
  assert.ok(PERMISSIONS[ROLE_OPERATIONS].has("order.update"));
  assert.ok(!PERMISSIONS[ROLE_OPERATIONS].has("order.delete"));
  assert.ok(PERMISSIONS[ROLE_FINANCE].has("order.read"));
  assert.ok(!PERMISSIONS[ROLE_FINANCE].has("order.create"));
  assert.ok(!PERMISSIONS[ROLE_FINANCE].has("product.sync"));
  assert.ok(PERMISSIONS[ROLE_SUPPORT].has("order.update_status"));
  assert.ok(!PERMISSIONS[ROLE_SUPPORT].has("product.sync"));
});

test("normalizes roles: valid pass through, invalid fall back, admin username wins", () => {
  assert.equal(normalizeRole(ROLE_OPERATIONS, "bob"), ROLE_OPERATIONS);
  assert.equal(normalizeRole("bogus", "bob"), ROLE_SUPPORT);
  assert.equal(normalizeRole("bogus", "admin"), ROLE_ADMIN);
  assert.equal(normalizeRole(undefined, "admin"), ROLE_ADMIN);
  assert.equal(normalizeRole("bogus", "bob", ROLE_FINANCE), ROLE_FINANCE);
});

test("flags shop-restricted roles", () => {
  assert.equal(isShopRestrictedRole(ROLE_OPERATIONS), true);
  assert.equal(isShopRestrictedRole(ROLE_SUPPORT), true);
  assert.equal(isShopRestrictedRole(ROLE_FINANCE), true);
  assert.equal(isShopRestrictedRole(ROLE_ADMIN), false);
  assert.equal(isShopRestrictedRole(ROLE_SUPERVISOR), false);
});

test("shop permissions: restricted roles are always fully denied", () => {
  assert.deepEqual(getRoleShopPermissionDefaults(ROLE_SUPPORT), { shopRead: false, shopCreate: false, shopDelete: false, shopToggle: false });
  assert.deepEqual(
    normalizeShopPermissions({ shopRead: true, shopCreate: true, shopDelete: true, shopToggle: true }, ROLE_SUPPORT),
    { shopRead: false, shopCreate: false, shopDelete: false, shopToggle: false }
  );
});

test("shop permissions: unrestricted roles fall back to role defaults", () => {
  assert.deepEqual(getRoleShopPermissionDefaults(ROLE_ADMIN), { shopRead: true, shopCreate: true, shopDelete: true, shopToggle: true });
  assert.deepEqual(normalizeShopPermissions(undefined, ROLE_ADMIN), { shopRead: true, shopCreate: true, shopDelete: true, shopToggle: true });
  assert.deepEqual(normalizeShopPermissions({}, ROLE_ADMIN), { shopRead: true, shopCreate: true, shopDelete: true, shopToggle: true });
});

test("shop permissions: write flags without read auto-promote read", () => {
  assert.deepEqual(
    normalizeShopPermissions({ shopRead: false, shopCreate: true, shopDelete: false, shopToggle: false }, ROLE_ADMIN),
    { shopRead: true, shopCreate: true, shopDelete: false, shopToggle: false }
  );
  assert.deepEqual(
    normalizeShopPermissions({ shopRead: false, shopCreate: false, shopDelete: false, shopToggle: true }, ROLE_SUPERVISOR),
    { shopRead: true, shopCreate: false, shopDelete: false, shopToggle: true }
  );
});

test("effective permissions merge role defaults with user overrides", () => {
  const user = { username: "ops1", role: ROLE_OPERATIONS, shopPermissions: undefined };
  assert.deepEqual(getEffectiveShopPermissions(user), { shopRead: false, shopCreate: false, shopDelete: false, shopToggle: false });
  const admin = { username: "boss", role: ROLE_ADMIN, shopPermissions: { shopCreate: false } };
  assert.deepEqual(getEffectiveShopPermissions(admin), { shopRead: true, shopCreate: false, shopDelete: true, shopToggle: true });
});
