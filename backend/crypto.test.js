const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveAppKey, decryptSecret, encryptSecret } = require("./crypto");

test("roundtrips secrets with the same application key", () => {
  const secret = "s3cret-key-1";
  const value = "sk-abcdef123456";
  const encrypted = encryptSecret(value, secret);
  assert.ok(encrypted.startsWith("enc:v1:"));
  assert.equal(decryptSecret(encrypted, secret), value);
});

test("returns empty strings for empty or whitespace input", () => {
  assert.equal(encryptSecret("", "k"), "");
  assert.equal(encryptSecret("   ", "k"), "");
  assert.equal(decryptSecret("", "k"), "");
});

test("returns unencrypted values unchanged (legacy plaintext compatibility)", () => {
  assert.equal(decryptSecret("plain-text-key", "k"), "plain-text-key");
});

test("rejects tampered ciphertext and invalid base64 without throwing", () => {
  const encrypted = encryptSecret("value", "k");
  const tampered = `${encrypted.slice(0, -4)}AAAA`;
  assert.equal(decryptSecret(tampered, "k"), "");
  assert.equal(decryptSecret("enc:v1:!!!not-base64!!!", "k"), "");
  assert.equal(decryptSecret("enc:v1:c2hvcnQ=", "k"), "");
});

test("does not decrypt with a different application key", () => {
  const encrypted = encryptSecret("value", "key-one");
  assert.equal(decryptSecret(encrypted, "key-two"), "");
});

test("derives deterministic 32-byte keys", () => {
  const key = deriveAppKey("abc");
  assert.equal(key.length, 32);
  assert.deepEqual(deriveAppKey("abc"), key);
  assert.notDeepEqual(deriveAppKey("abd"), key);
});
