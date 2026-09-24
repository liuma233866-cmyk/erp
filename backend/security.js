const crypto = require("crypto");

// PBKDF2-SHA512 iteration count (OWASP recommends >= 210000 as of 2023).
// Overridable via PASSWORD_HASH_ITERATIONS for slow local machines.
const LEGACY_HASH_ITERATIONS = 100000;
const DEFAULT_HASH_ITERATIONS = 210000;
function resolvePasswordHashIterations() {
  const raw = Number(process.env.PASSWORD_HASH_ITERATIONS);
  if (Number.isFinite(raw) && raw >= 10000 && raw <= 10000000) return Math.floor(raw);
  return DEFAULT_HASH_ITERATIONS;
}
const PASSWORD_HASH_ITERATIONS = resolvePasswordHashIterations();

const SENSITIVE_KEYS = new Set([
  "password", "token", "passwordHash", "passwordSalt", "confirmPassword",
  "apiKey", "apiKeyEncrypted", "api_key", "clientSecret", "imageDataUrl"
]);

function maskSensitive(body) {
  if (!body || typeof body !== "object") return body;
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    out[key] = SENSITIVE_KEYS.has(key) ? "***" : value;
  }
  return out;
}

function validateLoginCredentials(username, password) {
  if (!username || !password) return { ok: false, message: "Username and password are required" };
  if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) {
    return { ok: false, message: "Username must be 4-20 chars (letters/numbers/underscore)" };
  }
  if (String(password || "").length > 256) return { ok: false, message: "Password is too long" };
  return { ok: true };
}

function validateCredentials(username, password) {
  if (!username || !password) return { ok: false, message: "Username and password are required" };
  if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) {
    return { ok: false, message: "Username must be 4-20 chars (letters/numbers/underscore)" };
  }
  if (password.length < 10 || password.length > 64) return { ok: false, message: "Password length must be 10-64 chars" };
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return { ok: false, message: "Password must include upper/lower letters, numbers and symbols" };
  }
  const lowered = password.toLowerCase();
  if (["123456", "password", "qwerty", "admin", "111111", "abc123"].some((pattern) => lowered.includes(pattern))) {
    return { ok: false, message: "Password is too weak, please avoid common patterns" };
  }
  if (lowered.includes(String(username || "").toLowerCase())) return { ok: false, message: "Password must not contain username" };
  return { ok: true };
}

function generateBootstrapPassword(length = 18) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*_-+=";
  const bytes = crypto.randomBytes(length);
  let password = "";
  for (let index = 0; index < length; index += 1) password += alphabet[bytes[index] % alphabet.length];
  return password;
}

function makePasswordSalt() {
  return crypto.randomBytes(16).toString("hex");
}

function hashPassword(password, salt, iterations = PASSWORD_HASH_ITERATIONS) {
  return crypto.pbkdf2Sync(password, salt, iterations, 64, "sha512").toString("hex");
}

function createPasswordHash(password) {
  const passwordSalt = makePasswordSalt();
  return { passwordSalt, passwordHash: hashPassword(password, passwordSalt) };
}

// 恒定时间比较两个十六进制哈希；长度不一致时直接返回 false（timingSafeEqual
// 在长度不同时会抛异常，所以先做长度检查）。
function timingSafeHexEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (!a || !b || a.length !== b.length) return false;
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

function verifyPassword(user, password, legacyPasswordSalt, iterations = PASSWORD_HASH_ITERATIONS) {
  if (!user || typeof user !== "object") return false;
  const salt = user.passwordSalt || legacyPasswordSalt;
  if (timingSafeHexEqual(user.passwordHash, hashPassword(password, salt, iterations))) return true;
  // Backward compatibility: hashes created with the previous (lower) iteration count.
  if (iterations !== LEGACY_HASH_ITERATIONS && timingSafeHexEqual(user.passwordHash, hashPassword(password, salt, LEGACY_HASH_ITERATIONS))) return true;
  return false;
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function maskSecret(secret) {
  const text = String(secret || "");
  if (!text) return "";
  if (text.length <= 8) return "***";
  return `${text.slice(0, 3)}***${text.slice(-3)}`;
}

const INSECURE_APP_SECRET_KEYS = new Set([
  "dev-insecure-secret-change-me",
  "change-me-to-a-long-random-secret"
]);

function validateAppSecretKey(secret) {
  const value = String(secret || "").trim();
  if (!value || value.length < 32 || INSECURE_APP_SECRET_KEYS.has(value)) {
    return { ok: false, message: "APP_SECRET_KEY is missing, too short, or uses a public placeholder" };
  }
  return { ok: true };
}

function rotateInsecureDefaultAdmins(database, options) {
  if (!database || !Array.isArray(database.users)) return { rotated: false, notice: null };
  const { adminRole, defaultAdminPassword, legacyPasswordSalt, normalizeRole } = options;
  const rotatedUsers = [];
  for (const user of database.users) {
    if (normalizeRole(user.role, user.username) !== adminRole) continue;
    if (!verifyPassword(user, "Admin@123", legacyPasswordSalt)) continue;
    const nextPassword = defaultAdminPassword || generateBootstrapPassword();
    Object.assign(user, createPasswordHash(nextPassword));
    rotatedUsers.push(`${user.username}:${nextPassword}`);
  }
  if (!rotatedUsers.length) return { rotated: false, notice: null };
  return {
    rotated: true,
    notice: `Insecure default admin password was rotated. New credentials: ${rotatedUsers.join(", ")}. Change them after login.`
  };
}

module.exports = {
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
};
