const crypto = require("crypto");

const ENC_PREFIX = "enc:v1:";

// Derives a 32-byte AES-256-GCM key from the application secret.
function deriveAppKey(secret) {
  return crypto.createHash("sha256").update(String(secret || "")).digest();
}

function encryptSecret(value, secret) {
  const plain = String(value || "").trim();
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const key = deriveAppKey(secret);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]).toString("base64");
  return `${ENC_PREFIX}${payload}`;
}

function decryptSecret(value, secret) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!text.startsWith(ENC_PREFIX)) return text;
  try {
    const payload = Buffer.from(text.slice(ENC_PREFIX.length), "base64");
    if (payload.length < 29) return "";
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const key = deriveAppKey(secret);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return "";
  }
}

module.exports = { ENC_PREFIX, deriveAppKey, decryptSecret, encryptSecret };
