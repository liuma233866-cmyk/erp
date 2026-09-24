const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSessionCookie } = require("./http-utils");

test("buildSessionCookie keeps HttpOnly and SameSite and omits Secure by default", () => {
  const previous = process.env.COOKIE_SECURE;
  delete process.env.COOKIE_SECURE;
  try {
    const cookie = buildSessionCookie("token-1", 3600);
    assert.match(cookie, /auth_token=token-1/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.doesNotMatch(cookie, /Secure/);
  } finally {
    if (previous === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = previous;
  }
});

test("buildSessionCookie adds Secure when COOKIE_SECURE is enabled", () => {
  const previous = process.env.COOKIE_SECURE;
  process.env.COOKIE_SECURE = "1";
  try {
    const cookie = buildSessionCookie("token-2", 3600);
    assert.match(cookie, /Secure/);
  } finally {
    if (previous === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = previous;
  }
});

test("buildSessionCookie accepts an explicit Secure override", () => {
  const previous = process.env.COOKIE_SECURE;
  process.env.COOKIE_SECURE = "1";
  try {
    const cookie = buildSessionCookie("token-3", 0, false);
    assert.doesNotMatch(cookie, /Secure/);
    assert.match(cookie, /Max-Age=0/);
  } finally {
    if (previous === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = previous;
  }
});
