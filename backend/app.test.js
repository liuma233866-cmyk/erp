// Integration tests for the auth chain (login -> token -> protected API).
// Runs against a dedicated MySQL database (ecommerce_order_admin_test) that is
// created and dropped by this file, so local/production data is never touched.
// When MySQL credentials are unavailable, the whole file skips gracefully.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const TEST_DB = "ecommerce_order_admin_test";
const TEST_ADMIN_USERNAME = "admin";
const TEST_ADMIN_PASSWORD = "TestAdmin-X9!zz";
const TEST_SECRET = "integration-test-secret-0123456789abcdef";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-test-"));
process.env.APP_SECRET_KEY = TEST_SECRET;
process.env.MYSQL_DATABASE = TEST_DB;
process.env.DATA_DIR = tmpDir;
process.env.LOG_DIR = path.join(tmpDir, "logs");
process.env.DEFAULT_ADMIN_USERNAME = TEST_ADMIN_USERNAME;
process.env.DEFAULT_ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
process.env.TRUST_PROXY = "0";

const serverModule = require("./server");
const mysql = require("mysql2/promise");
const { createPasswordHash } = require("./security");

// Keep integration coverage active when deployments use MYSQL_PASSWORD_FILE.
// TEST_MYSQL_PASSWORD is an explicit CI override and never belongs in .env.
if (process.env.TEST_MYSQL_PASSWORD) process.env.MYSQL_PASSWORD = process.env.TEST_MYSQL_PASSWORD;
else if (!process.env.MYSQL_PASSWORD) process.env.MYSQL_PASSWORD = serverModule.readMysqlPassword();

let mysqlAvailable = false;
let testServer = null;
let baseUrl = "";

function skipIfUnavailable(t) {
  if (!mysqlAvailable) {
    t.skip("MySQL is not configured locally; integration tests skipped");
    return true;
  }
  return false;
}

function seedProfitDetailTestUser() {
  const username = `pd${Date.now().toString(36)}`.slice(0, 20);
  const password = "ProfitTest-X9!z";
  const credentials = createPasswordHash(password);
  serverModule.seedUserForTest({
    id: `USR-${username}`,
    username,
    passwordSalt: credentials.passwordSalt,
    passwordHash: credentials.passwordHash,
    role: "admin",
    companyId: "system",
    companyName: "系统",
    createdAt: new Date().toISOString()
  });
  return { username, password };
}

async function connectWithoutDatabase() {
  return mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD
  });
}

async function apiFetch(method, apiPath, token, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${apiPath}`, { method, headers, body: payload });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, json };
}

test.before(async () => {
  if (!process.env.MYSQL_HOST || !process.env.MYSQL_USER || !process.env.MYSQL_PASSWORD) {
    console.warn("app.test.js: MYSQL_* credentials not available, skipping integration tests");
    return;
  }
  try {
    const conn = await connectWithoutDatabase();
    // Start from a clean database every run. The bootstrap admin and the default
    // state are only created when no persisted state exists, so leftovers from an
    // aborted run would otherwise be reused and break unrelated tests.
    await conn.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${TEST_DB}\` CHARACTER SET utf8mb4`);
    await conn.end();
    await serverModule.initializeAppRuntime();
    testServer = http.createServer(serverModule.createApp());
    await new Promise((resolve) => testServer.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${testServer.address().port}`;
    mysqlAvailable = true;
  } catch (error) {
    console.warn(`app.test.js: MySQL setup failed, skipping integration tests: ${String(error?.message || error)}`);
  }
});

test.after(async () => {
  if (testServer) await new Promise((resolve) => testServer.close(resolve));
  try { await serverModule.closeAppRuntime(); } catch {}
  if (process.env.MYSQL_HOST && process.env.MYSQL_USER && process.env.MYSQL_PASSWORD) {
    try {
      const conn = await connectWithoutDatabase();
      await conn.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
      await conn.end();
    } catch {}
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("POST /api/login rejects bad credentials with 401", async (t) => {
  if (skipIfUnavailable(t)) return;
  const res = await apiFetch("POST", "/api/login", null, { username: TEST_ADMIN_USERNAME, password: "wrong-password" });
  assert.equal(res.status, 401);
});

test("POST /api/login issues a token and /api/profile accepts it", async (t) => {
  if (skipIfUnavailable(t)) return;
  const login = await apiFetch("POST", "/api/login", null, { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD });
  assert.equal(login.status, 200);
  assert.match(login.json.token, /^[0-9a-f]{64}$/);
  assert.equal(login.json.user.username, TEST_ADMIN_USERNAME);

  const profile = await apiFetch("GET", "/api/profile", login.json.token);
  assert.equal(profile.status, 200);
  assert.equal(profile.json.username, TEST_ADMIN_USERNAME);
});

test("GET /api/orders requires a token and works with one", async (t) => {
  if (skipIfUnavailable(t)) return;
  const unauthenticated = await apiFetch("GET", "/api/orders", null);
  assert.equal(unauthenticated.status, 401);

  const login = await apiFetch("POST", "/api/login", null, { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD });
  const orders = await apiFetch("GET", "/api/orders", login.json.token);
  assert.equal(orders.status, 200);
  assert.ok(orders.json && typeof orders.json === "object");
});

test("POST /api/register stays disabled (403)", async (t) => {
  if (skipIfUnavailable(t)) return;
  const res = await apiFetch("POST", "/api/register", null, { username: "intruder", password: "Whatever-X9!z" });
  assert.equal(res.status, 403);
});

test("GET /api/sessions lists sessions and DELETE revokes other sessions only", async (t) => {
  if (skipIfUnavailable(t)) return;
  const first = await apiFetch("POST", "/api/login", null, { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD });
  const second = await apiFetch("POST", "/api/login", null, { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD });

  const list = await apiFetch("GET", "/api/sessions", first.json.token);
  assert.equal(list.status, 200);
  assert.ok(list.json.sessions.length >= 2, "expected at least two sessions for this user");
  const current = list.json.sessions.filter((s) => s.current === true);
  assert.equal(current.length, 1, "exactly one session is marked current");

  const revokeCurrent = await apiFetch("DELETE", `/api/sessions/${current[0].id}`, first.json.token);
  assert.equal(revokeCurrent.status, 400);

  // Revoke every other session; the first token must keep working.
  for (const other of list.json.sessions.filter((s) => s.current === false)) {
    const res = await apiFetch("DELETE", `/api/sessions/${other.id}`, first.json.token);
    assert.equal(res.status, 200);
  }

  const afterRevoke = await apiFetch("GET", "/api/sessions", first.json.token);
  assert.equal(afterRevoke.json.sessions.length, 1);

  const revokedTokenStillWorks = await apiFetch("GET", "/api/profile", second.json.token);
  assert.equal(revokedTokenStillWorks.status, 401);

  const stillCurrent = await apiFetch("GET", "/api/profile", first.json.token);
  assert.equal(stillCurrent.status, 200);

  const missing = await apiFetch("DELETE", `/api/sessions/${"0".repeat(64)}`, first.json.token);
  assert.equal(missing.status, 404);
});

test("login rate limit returns 429 after repeated failures", async (t) => {
  if (skipIfUnavailable(t)) return;
  let blocked = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const res = await apiFetch("POST", "/api/login", null, { username: "ratelimit_probe", password: "wrong-password-1" });
    if (res.status === 429) {
      blocked = true;
      break;
    }
    assert.equal(res.status, 401);
  }
  assert.equal(blocked, true, "expected a 429 after the login rate limit threshold");
});

// ---------------------------------------------------------------------------
// POST /api/yandex/card-quality
//
// The lookup must be auth-gated, read-only, and must never persist what it reads.
// These live in this file so they share one test database and runtime with the
// other integration tests; a separate file would race for the same MySQL database
// whenever the runner is invoked with --test-isolation=none.
// ---------------------------------------------------------------------------

const CARD_QUALITY_SHOP_ID = "SHP-CARD-QUALITY-TEST";
const CARD_QUALITY_OFFER_ID = "SKU-CARD-QUALITY-1";
const CARD_QUALITY_RECOMMENDATION = "Добавьте видео";

function seedCardQualityShop() {
  // Seeded straight into the live database, so the apiKey must be plain: seeding
  // bypasses normalizeDatabase(), which is what decrypts apiKeyEncrypted on load.
  serverModule.seedShopForTest({
    id: CARD_QUALITY_SHOP_ID,
    name: "Card Quality Test Shop",
    code: "ym-card-quality",
    enabled: true,
    provider: "yandex_market",
    campaignId: "123456",
    businessId: "987654",
    apiKey: "card-quality-test-api-key",
    companyName: "系统",
    companyId: "system",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

// Routes local calls to the real fetch and answers only the Yandex host, so a
// genuine outbound request can never escape during the tests.
async function withYandexStub(run) {
  const originalFetch = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith(baseUrl)) return originalFetch(url, options);
    outbound.push({ url: target, method: options.method || "GET" });
    if (!target.includes("api.partner.market.yandex.ru")) {
      throw new Error(`Unexpected outbound request to ${target}`);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: "OK",
        result: {
          categoryAverageRating: 82.5,
          offers: [
            {
              offerId: CARD_QUALITY_OFFER_ID,
              cardStatus: "HAS_CARD_CAN_NOT_UPDATE",
              rating: 60,
              recommendations: [{ type: "HAS_VIDEO", description: CARD_QUALITY_RECOMMENDATION, fieldNames: ["видео"] }],
              errors: [],
              warnings: [{ message: "Заполните характеристики" }]
            }
          ]
        }
      })
    };
  };
  try {
    return await run(outbound);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("card-quality rejects an unauthenticated request without calling Yandex", async (t) => {
  if (skipIfUnavailable(t)) return;
  await withYandexStub(async (outbound) => {
    const res = await apiFetch("POST", "/api/yandex/card-quality", null, { shopId: CARD_QUALITY_SHOP_ID });
    assert.equal(res.status, 401);
    assert.equal(outbound.length, 0, "an unauthenticated request must not reach Yandex");
  });
});

test("card-quality returns parsed ratings, recommendations and warnings", async (t) => {
  if (skipIfUnavailable(t)) return;
  seedCardQualityShop();
  await withYandexStub(async (outbound) => {
    const login = await apiFetch("POST", "/api/login", null, { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD });
    assert.equal(login.status, 200);

    const res = await apiFetch("POST", "/api/yandex/card-quality", login.json.token, { shopId: CARD_QUALITY_SHOP_ID });
    assert.equal(res.status, 200, `unexpected body: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.categoryAverageRating, 82.5);
    assert.equal(res.json.averageRating, 60);
    assert.equal(res.json.offerCount, 1);
    assert.equal(res.json.offers[0].offerId, CARD_QUALITY_OFFER_ID);
    assert.equal(res.json.offers[0].recommendations[0].type, "HAS_VIDEO");
    assert.equal(res.json.offers[0].warnings[0].message, "Заполните характеристики");

    assert.equal(outbound.length, 1, "exactly one Yandex call");
    assert.equal(outbound[0].method, "POST");
    assert.match(outbound[0].url, /\/v2\/businesses\/987654\/offer-cards/);
  });
});

test("card-quality refresh stores the snapshot and GET reads it without calling Yandex", async (t) => {
  if (skipIfUnavailable(t)) return;
  seedCardQualityShop();
  await withYandexStub(async (outbound) => {
    const login = await apiFetch("POST", "/api/login", null, { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD });

    const refreshed = await apiFetch("POST", "/api/yandex/card-quality", login.json.token, { shopId: CARD_QUALITY_SHOP_ID });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.json.fetchedFromYandex, true);
    assert.equal(refreshed.json.savedCards, 1, "the pulled card must be persisted");

    const callsAfterRefresh = outbound.length;
    assert.equal(callsAfterRefresh, 1);

    // GET is the stored view: it must answer from MySQL and stay off the network.
    const stored = await apiFetch("GET", `/api/yandex/card-quality?shopId=${CARD_QUALITY_SHOP_ID}`, login.json.token);
    assert.equal(stored.status, 200);
    assert.equal(stored.json.stored, true);
    assert.equal(stored.json.total, 1);
    assert.equal(stored.json.offers[0].offerId, CARD_QUALITY_OFFER_ID);
    assert.equal(stored.json.offers[0].rating, 60);
    assert.equal(stored.json.offers[0].recommendations[0].type, "HAS_VIDEO");
    assert.equal(stored.json.categoryAverageRating, 82.5);
    assert.equal(outbound.length, callsAfterRefresh, "GET must not call Yandex");

    // The snapshot is durable, so a second GET still serves it.
    const again = await apiFetch("GET", `/api/yandex/card-quality?shopId=${CARD_QUALITY_SHOP_ID}`, login.json.token);
    assert.equal(again.status, 200);
    assert.equal(again.json.total, 1);
  });
});

const CARD_QUALITY_EMPTY_SHOP_ID = "SHP-CARD-QUALITY-EMPTY";

test("card-quality GET reports a shop with no stored snapshot without querying Yandex", async (t) => {
  if (skipIfUnavailable(t)) return;
  await withYandexStub(async (outbound) => {
    const login = await apiFetch("POST", "/api/login", null, { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD });

    // An unknown shop is rejected outright.
    const unknown = await apiFetch("GET", "/api/yandex/card-quality?shopId=SHP-DOES-NOT-EXIST", login.json.token);
    assert.equal(unknown.status, 404);

    // A real shop that has never been refreshed answers with an explicit empty store.
    serverModule.seedShopForTest({
      id: CARD_QUALITY_EMPTY_SHOP_ID,
      name: "Card Quality Empty Shop",
      code: "ym-card-quality-empty",
      enabled: true,
      provider: "yandex_market",
      campaignId: "654321",
      businessId: "111222",
      apiKey: "card-quality-test-api-key",
      companyName: "系统",
      companyId: "system",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const empty = await apiFetch("GET", `/api/yandex/card-quality?shopId=${CARD_QUALITY_EMPTY_SHOP_ID}`, login.json.token);
    assert.equal(empty.status, 200);
    assert.equal(empty.json.stored, false);
    assert.equal(empty.json.total, 0);
    assert.deepEqual(empty.json.offers, []);
    assert.equal(outbound.length, 0, "a read-only GET must never reach Yandex");
  });
});

test("card-quality history records at most one snapshot per shop, offer and day", async (t) => {
  if (skipIfUnavailable(t)) return;
  seedCardQualityShop();
  await withYandexStub(async () => {
    const login = await apiFetch("POST", "/api/login", null, { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD });
    await apiFetch("POST", "/api/yandex/card-quality", login.json.token, { shopId: CARD_QUALITY_SHOP_ID });
    await apiFetch("POST", "/api/yandex/card-quality", login.json.token, { shopId: CARD_QUALITY_SHOP_ID });

    const stored = await apiFetch("GET", `/api/yandex/card-quality?shopId=${CARD_QUALITY_SHOP_ID}`, login.json.token);
    assert.equal(stored.status, 200);
    // Two refreshes on the same day collapse into a single history point.
    assert.equal(stored.json.trend.length, 1, `expected one snapshot day, got ${JSON.stringify(stored.json.trend)}`);
    assert.equal(stored.json.trend[0].cards, 1);
    assert.equal(stored.json.total, 1, "the latest table holds one row per offer, not per refresh");
  });
});

test("card-quality rejects an unknown shop and conflicting filters", async (t) => {
  if (skipIfUnavailable(t)) return;
  const login = await apiFetch("POST", "/api/login", null, { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD });

  const missing = await apiFetch("POST", "/api/yandex/card-quality", login.json.token, { shopId: "SHP-DOES-NOT-EXIST" });
  assert.equal(missing.status, 404);

  seedCardQualityShop();
  const conflicting = await apiFetch("POST", "/api/yandex/card-quality", login.json.token, {
    shopId: CARD_QUALITY_SHOP_ID,
    offerIds: [CARD_QUALITY_OFFER_ID],
    cardStatuses: ["NO_CARD"]
  });
  assert.equal(conflicting.status, 400);
});

// ---------------------------------------------------------------------------
// GET /api/yandex/category-parameters
//
// The route is what makes "what does this category require" answerable. It must
// resolve the category's required parameters, expose their allowed values, and say
// which of the shop's products still miss them.
// ---------------------------------------------------------------------------

const CATEGORY_TEST_ID = 90588;
// The login rate limit is keyed per username, and the card-quality tests above
// already spend admin's budget. These tests act as a second operator so they cannot
// be starved by the rate-limit test or by the tests that ran before them.
const CATEGORY_TEST_USERNAME = "category_operator";
const CATEGORY_TEST_PASSWORD = "CategoryOp-T9!zz";

async function loginAsCategoryOperator() {
  ensureCategoryOperator();
  const login = await apiFetch("POST", "/api/login", null, {
    username: CATEGORY_TEST_USERNAME,
    password: CATEGORY_TEST_PASSWORD
  });
  assert.equal(login.status, 200, `category operator login failed: ${JSON.stringify(login.json)}`);
  return login.json.token;
}

let categoryOperatorReady = false;
function ensureCategoryOperator() {
  if (categoryOperatorReady) return;
  const { createPasswordHash } = require("./security");
  const { getRoleShopPermissionDefaults, ROLE_ADMIN } = require("./permissions");
  const creds = createPasswordHash(CATEGORY_TEST_PASSWORD);
  // findUserByUsername reads the in-memory list, so seed it there.
  serverModule.seedUserForTest({
    id: "USR-CATEGORY-OPERATOR",
    username: CATEGORY_TEST_USERNAME,
    passwordHash: creds.passwordHash,
    passwordSalt: creds.passwordSalt,
    role: ROLE_ADMIN,
    companyId: "system",
    companyName: "系统",
    shopPermissions: getRoleShopPermissionDefaults(ROLE_ADMIN),
    shopAssignments: [],
    createdAt: new Date().toISOString()
  });
  categoryOperatorReady = true;
}

function seedCategoryTestData() {
  serverModule.seedShopForTest({
    id: CARD_QUALITY_SHOP_ID,
    name: "Card Quality Test Shop",
    code: "ym-card-quality",
    enabled: true,
    provider: "yandex_market",
    campaignId: "123456",
    businessId: "987654",
    apiKey: "card-quality-test-api-key",
    companyName: "系统",
    companyId: "system",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  // Two products: one complete, one missing a required parameter.
  serverModule.seedPublishProductForTest({
    id: "PUB-CATEGORY-TEST-1",
    shopId: CARD_QUALITY_SHOP_ID,
    sku: "SKU-CATEGORY-1",
    title: "Complete product",
    categoryId: String(CATEGORY_TEST_ID),
    attributeTerms: { "Цвет": "красный", "Материал": "хлопок" }
  });
  serverModule.seedPublishProductForTest({
    id: "PUB-CATEGORY-TEST-2",
    shopId: CARD_QUALITY_SHOP_ID,
    sku: "SKU-CATEGORY-2",
    title: "Incomplete product",
    categoryId: String(CATEGORY_TEST_ID),
    attributeTerms: { "Цвет": "синий" }
  });
}

async function withCategoryParametersStub(run) {
  const originalFetch = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith(baseUrl)) return originalFetch(url, options);
    outbound.push({ url: target, method: options.method || "GET" });
    if (!target.includes("api.partner.market.yandex.ru")) {
      throw new Error(`Unexpected outbound request to ${target}`);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: "OK",
        result: {
          categoryId: CATEGORY_TEST_ID,
          parameters: [
            {
              id: 1,
              name: "Цвет",
              type: "ENUM",
              required: true,
              allowCustomValues: false,
              values: [{ id: 11, value: "красный" }, { id: 12, value: "синий" }]
            },
            { id: 2, name: "Материал", type: "TEXT", required: true, constraints: { maxLength: 50 } },
            { id: 3, name: "Видео", type: "TEXT", required: false, recommendationTypes: ["HAS_VIDEO"] }
          ]
        }
      })
    };
  };
  try {
    return await run(outbound);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("category-parameters exposes required fields, allowed values and per-product gaps", async (t) => {
  if (skipIfUnavailable(t)) return;
  await withCategoryParametersStub(async () => {
    const token = await loginAsCategoryOperator();
    seedCategoryTestData();

    const res = await apiFetch(
      "GET",
      `/api/yandex/category-parameters?shopId=${CARD_QUALITY_SHOP_ID}&categoryId=${CATEGORY_TEST_ID}`,
      token
    );
    assert.equal(res.status, 200, `unexpected body: ${JSON.stringify(res.json)}`);

    assert.equal(res.json.parameterCount, 3);
    assert.equal(res.json.requiredCount, 2, "two parameters are marked required");
    assert.equal(res.json.recommendedCount, 1, "the video recommendation is surfaced");

    const color = res.json.parameters.find((parameter) => parameter.name === "Цвет");
    assert.equal(color.required, true);
    assert.equal(color.allowCustomValues, false);
    assert.deepEqual(color.values.map((option) => option.value), ["красный", "синий"]);

    const material = res.json.parameters.find((parameter) => parameter.name === "Материал");
    assert.equal(material.constraints.maxLength, 50);

    // One product satisfies everything, the other is missing "Материал".
    assert.equal(res.json.validation.productCount, 2);
    assert.equal(res.json.validation.readyCount, 1);
    assert.equal(res.json.validation.blockedCount, 1);

    const blocked = res.json.products.find((product) => product.id === "PUB-CATEGORY-TEST-2");
    assert.deepEqual(blocked.missingRequired.map((parameter) => parameter.name), ["Материал"]);
    assert.equal(blocked.readiness, 50);

    const complete = res.json.products.find((product) => product.id === "PUB-CATEGORY-TEST-1");
    assert.deepEqual(complete.missingRequired, []);
    assert.equal(complete.readiness, 100);
  });
});

test("category-parameters rejects a bad category id and an unknown shop", async (t) => {
  if (skipIfUnavailable(t)) return;
  const token = await loginAsCategoryOperator();
  seedCategoryTestData();

  const badCategory = await apiFetch(
    "GET",
    `/api/yandex/category-parameters?shopId=${CARD_QUALITY_SHOP_ID}&categoryId=abc`,
    token
  );
  assert.equal(badCategory.status, 400);

  const missingShop = await apiFetch(
    "GET",
    `/api/yandex/category-parameters?shopId=SHP-DOES-NOT-EXIST&categoryId=${CATEGORY_TEST_ID}`,
    token
  );
  assert.equal(missingShop.status, 404);

  const noAuth = await apiFetch(
    "GET",
    `/api/yandex/category-parameters?shopId=${CARD_QUALITY_SHOP_ID}&categoryId=${CATEGORY_TEST_ID}`,
    null
  );
  assert.equal(noAuth.status, 401);
});

test("order profit-detail returns the stored snapshot for an existing order", async (t) => {
  if (skipIfUnavailable(t)) return;

  const tester = seedProfitDetailTestUser();
  const login = await apiFetch("POST", "/api/login", null, {
    username: tester.username,
    password: tester.password
  });
  assert.equal(login.status, 200);

  const created = await apiFetch("POST", "/api/orders", login.json.token, {
    customerName: "Profit Detail Test",
    amount: 1500,
    status: "paid"
  });
  assert.equal(created.status, 201, `unexpected body: ${JSON.stringify(created.json)}`);
  const orderId = created.json.item.id;

  const detail = await apiFetch(
    "GET",
    `/api/orders/${encodeURIComponent(orderId)}/profit-detail`,
    login.json.token
  );
  assert.equal(detail.status, 200, `unexpected body: ${JSON.stringify(detail.json)}`);
  assert.equal(detail.json.item.id, orderId);
  assert.equal(detail.json.item.amount, 1500);
  assert.equal(detail.json.item.customerName, "Profit Detail Test");
});

test("order profit-detail rejects unauthenticated access and unknown orders", async (t) => {
  if (skipIfUnavailable(t)) return;

  const noAuth = await apiFetch("GET", "/api/orders/ORD-DOES-NOT-EXIST/profit-detail", null);
  assert.equal(noAuth.status, 401, "unauthenticated requests are rejected before lookup");

  const tester = seedProfitDetailTestUser();
  const login = await apiFetch("POST", "/api/login", null, {
    username: tester.username,
    password: tester.password
  });
  assert.equal(login.status, 200);

  const notFound = await apiFetch("GET", "/api/orders/ORD-DOES-NOT-EXIST/profit-detail", login.json.token);
  assert.equal(notFound.status, 404);
  assert.equal(notFound.json.message, "Order not found");
});

test("review rules support create, list, update and delete", async (t) => {
  if (skipIfUnavailable(t)) return;

  const tester = seedProfitDetailTestUser();
  const login = await apiFetch("POST", "/api/login", null, {
    username: tester.username,
    password: tester.password
  });
  assert.equal(login.status, 200);

  const created = await apiFetch("POST", "/api/review-rules", login.json.token, {
    name: "集成测试规则",
    titleKeyword: "camping",
    commissionPercent: 8
  });
  assert.equal(created.status, 201, `unexpected body: ${JSON.stringify(created.json)}`);
  const ruleId = created.json.item.id;
  assert.ok(ruleId, "created rule should have an id");

  const list = await apiFetch("GET", "/api/review-rules", login.json.token);
  assert.equal(list.status, 200);
  assert.ok(list.json.items.some((rule) => rule.id === ruleId), "created rule should appear in the list");

  const updated = await apiFetch("PUT", `/api/review-rules/${encodeURIComponent(ruleId)}`, login.json.token, {
    name: "集成测试规则-改",
    commissionPercent: 12
  });
  assert.equal(updated.status, 200, `unexpected body: ${JSON.stringify(updated.json)}`);
  assert.equal(updated.json.item.name, "集成测试规则-改");
  assert.equal(updated.json.item.commissionPercent, 12);

  const removed = await apiFetch("DELETE", `/api/review-rules/${encodeURIComponent(ruleId)}`, login.json.token);
  assert.equal(removed.status, 200);

  const listAfter = await apiFetch("GET", "/api/review-rules", login.json.token);
  assert.equal(listAfter.status, 200);
  assert.ok(!listAfter.json.items.some((rule) => rule.id === ruleId), "deleted rule should be gone");
});

test("review rules reject unauthenticated access", async (t) => {
  if (skipIfUnavailable(t)) return;

  const noAuthList = await apiFetch("GET", "/api/review-rules", null);
  assert.equal(noAuthList.status, 401);

  const noAuthCreate = await apiFetch("POST", "/api/review-rules", null, { name: "越权规则" });
  assert.equal(noAuthCreate.status, 401);
});
