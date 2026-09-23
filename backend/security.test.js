const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PASSWORD_HASH_ITERATIONS,
  createPasswordHash,
  generateBootstrapPassword,
  hashPassword,
  hashSessionToken,
  maskSecret,
  maskSensitive,
  validateAppSecretKey,
  rotateInsecureDefaultAdmins,
  validateCredentials,
  validateLoginCredentials,
  verifyPassword
} = require("./security");

const LEGACY_SALT = "order-admin-salt";

test("validates login credentials without enforcing registration complexity", () => {
  assert.deepEqual(validateLoginCredentials("user_1", "x"), { ok: true });
  assert.equal(validateLoginCredentials("abc", "x").ok, false);
  assert.equal(validateLoginCredentials("user_1", "x".repeat(257)).message, "Password is too long");
});

test("enforces password length, character classes, weak patterns, and username exclusion", () => {
  assert.equal(validateCredentials("user_1", "Aa1!short").message, "Password length must be 10-64 chars");
  assert.equal(validateCredentials("user_1", "abcdefghijk").message, "Password must include upper/lower letters, numbers and symbols");
  assert.equal(validateCredentials("user_1", "Good123456!").message, "Password is too weak, please avoid common patterns");
  assert.equal(validateCredentials("user_1", "Xuser_1good9!").message, "Password must not contain username");
  assert.deepEqual(validateCredentials("user_1", "Strong-X9!z"), { ok: true });
});

test("creates salted hashes and verifies current and legacy password records", () => {
  const current = createPasswordHash("Strong-X9!z");
  assert.equal(current.passwordSalt.length, 32);
  assert.equal(verifyPassword(current, "Strong-X9!z", LEGACY_SALT), true);
  assert.equal(verifyPassword(current, "wrong", LEGACY_SALT), false);

  const legacy = { passwordHash: hashPassword("Old-X9!pass", LEGACY_SALT) };
  assert.equal(verifyPassword(legacy, "Old-X9!pass", LEGACY_SALT), true);
  assert.equal(verifyPassword(legacy, "wrong", LEGACY_SALT), false);
});

test("uses OWASP-recommended iterations and verifies hashes from the old iteration count", () => {
  assert.equal(PASSWORD_HASH_ITERATIONS, 210000);
  assert.equal(hashPassword("x", "salt", 300000).length, 128);

  const oldIterationHash = hashPassword("Old-X9!pass", "some-salt", 100000);
  const legacyRecord = { passwordSalt: "some-salt", passwordHash: oldIterationHash };
  assert.equal(verifyPassword(legacyRecord, "Old-X9!pass", LEGACY_SALT), true);
  assert.equal(verifyPassword(legacyRecord, "wrong", LEGACY_SALT), false);
  // Re-hashing with current iterations produces a different hash that also verifies.
  const rehashed = { passwordSalt: "some-salt", passwordHash: hashPassword("Old-X9!pass", "some-salt", PASSWORD_HASH_ITERATIONS) };
  assert.equal(verifyPassword(rehashed, "Old-X9!pass", LEGACY_SALT), true);
});

test("hashes session tokens deterministically without exposing the token", () => {
  const token = "abc123";
  const hash = hashSessionToken(token);
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hashSessionToken(token), hash);
  assert.notEqual(hashSessionToken(token), hashSessionToken("abc124"));
  assert.equal(hashSessionToken(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("masks secrets and sensitive top-level fields with the existing rules", () => {
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret("12345678"), "***");
  assert.equal(maskSecret("123456789"), "123***789");
  assert.deepEqual(maskSensitive({ username: "user", password: "secret", api_key: "key" }), {
    username: "user",
    password: "***",
    api_key: "***"
  });
});

test("generates bootstrap passwords using the requested length", () => {
  assert.equal(generateBootstrapPassword(24).length, 24);
});

test("rejects public APP_SECRET_KEY placeholders", () => {
  assert.equal(validateAppSecretKey("dev-insecure-secret-change-me").ok, false);
  assert.equal(validateAppSecretKey("change-me-to-a-long-random-secret").ok, false);
  assert.equal(validateAppSecretKey("short-secret").ok, false);
  assert.equal(validateAppSecretKey("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef").ok, true);
});

test("rotates only admins still using the insecure default password", () => {
  const oldHash = hashPassword("Admin@123", LEGACY_SALT);
  const database = {
    users: [
      { username: "admin", role: "admin", passwordHash: oldHash },
      { username: "support", role: "support", passwordHash: oldHash }
    ]
  };
  const result = rotateInsecureDefaultAdmins(database, {
    adminRole: "admin",
    defaultAdminPassword: "Replacement-X9!",
    legacyPasswordSalt: LEGACY_SALT,
    normalizeRole: (role) => role
  });

  assert.equal(result.rotated, true);
  assert.equal(result.notice, "Insecure default admin password was rotated. New credentials: admin:Replacement-X9!. Change them after login.");
  assert.equal(verifyPassword(database.users[0], "Replacement-X9!", LEGACY_SALT), true);
  assert.equal(database.users[1].passwordSalt, undefined);
});
