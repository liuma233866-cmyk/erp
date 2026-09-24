const test = require("node:test");
const assert = require("node:assert/strict");
const { isSafeExternalHttpUrl, isSafeExternalHttpUrlWithDnsValidation, resolveClientIp } = require("./network-safety");
test("rejects private network URLs", () => {
  for (const value of ["http://127.0.0.1/x", "http://169.254.169.254/", "http://10.0.0.1/", "http://localhost/"]) assert.equal(isSafeExternalHttpUrl(value), false);
  assert.equal(isSafeExternalHttpUrl("https://example.com/image.png"), true);
});

test("rejects IPv6 loopback, unique-local and link-local literals", () => {
  for (const value of [
    "http://[::1]/a.jpg",
    "http://[::]/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/"
  ]) assert.equal(isSafeExternalHttpUrl(value), false);
});

test("allows public domains that start with fc/fd", () => {
  assert.equal(isSafeExternalHttpUrl("https://fc2.com/a.jpg"), true);
  assert.equal(isSafeExternalHttpUrl("https://fd.example.org/x.png"), true);
  assert.equal(isSafeExternalHttpUrl("http://[2606:4700:4700::1111]/"), true);
});

test("ignores X-Forwarded-For unless a proxy is trusted", () => {
  assert.equal(resolveClientIp("203.0.113.9", "127.0.0.1", false), "127.0.0.1");
  assert.equal(resolveClientIp("203.0.113.9", "127.0.0.1", "false"), "127.0.0.1");
});

test("uses the last forwarded entry when a proxy is trusted", () => {
  assert.equal(resolveClientIp("203.0.113.9", "127.0.0.1", true), "203.0.113.9");
  assert.equal(resolveClientIp("203.0.113.9, 10.0.0.5", "127.0.0.1", true), "10.0.0.5");
  assert.equal(resolveClientIp(" 203.0.113.9 , 10.0.0.5 ", "127.0.0.1", true), "10.0.0.5");
});

test("falls back to the socket address when the trusted header is empty", () => {
  assert.equal(resolveClientIp("", "127.0.0.1", true), "127.0.0.1");
  assert.equal(resolveClientIp("   ", "127.0.0.1", true), "127.0.0.1");
  assert.equal(resolveClientIp(undefined, "127.0.0.1", true), "127.0.0.1");
  assert.equal(resolveClientIp(undefined, "", true), "");
});

test("isSafeExternalHttpUrlWithDnsValidation rejects domains resolving to private IPs", async () => {
  const resolveToPrivate = async () => ["192.168.1.10"];
  assert.equal(await isSafeExternalHttpUrlWithDnsValidation("https://images.example.com/a.jpg", resolveToPrivate), false);
});

test("isSafeExternalHttpUrlWithDnsValidation allows domains resolving to public IPs", async () => {
  const resolveToPublic = async () => ["93.158.134.216"];
  assert.equal(await isSafeExternalHttpUrlWithDnsValidation("https://images.example.com/a.jpg", resolveToPublic), true);
});

test("isSafeExternalHttpUrlWithDnsValidation rejects literal private hosts without DNS", async () => {
  let called = false;
  const resolver = async () => {
    called = true;
    return ["93.158.134.216"];
  };
  assert.equal(await isSafeExternalHttpUrlWithDnsValidation("http://127.0.0.1/a.jpg", resolver), false);
  assert.equal(called, false);
});

test("isSafeExternalHttpUrlWithDnsValidation treats ENOTFOUND as pass-through and other DNS errors as reject", async () => {
  const notFound = async () => {
    const error = new Error("not found");
    error.code = "ENOTFOUND";
    throw error;
  };
  const timeout = async () => {
    const error = new Error("timeout");
    error.code = "ETIMEOUT";
    throw error;
  };
  assert.equal(await isSafeExternalHttpUrlWithDnsValidation("https://missing.example.com/a.jpg", notFound), true);
  assert.equal(await isSafeExternalHttpUrlWithDnsValidation("https://flaky.example.com/a.jpg", timeout), false);
});
