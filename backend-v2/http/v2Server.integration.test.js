"use strict";
// V2 全栈 HTTP 集成门禁：HTTP handler → 认证/租户/权限适配器 → 控制器 → 状态机 → MySQL 仓储 → 真实表。
//
// 默认跳过；设置 V2_MYSQL_RUN_INTEGRATION=1 后运行：
//   node --test backend-v2/http/v2Server.integration.test.js
// 自带独立库（默认 ecommerce_order_admin_test，erp_app 唯一有权的测试库），跑完即删。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const mysql = require("mysql2/promise");

const { createV2Pool } = require("../db/pool");
const { runMigrations } = require("../migrations/migrationRunner");
const { createV2Application } = require("./v2Server");

function readEnvFile() {
  const envPath = path.join(__dirname, "..", "..", ".env");
  const env = {};
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const enabled = process.env.V2_MYSQL_RUN_INTEGRATION === "1";
const database = process.env.V2_MYSQL_TEST_HTTP_DATABASE || process.env.V2_MYSQL_TEST_BATCH_DATABASE || "ecommerce_order_admin_test";
const fileEnv = readEnvFile();
const baseEnv = {
  host: process.env.V2_MYSQL_HOST || fileEnv.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.V2_MYSQL_PORT || fileEnv.MYSQL_PORT || 3306),
  user: process.env.V2_MYSQL_USER || fileEnv.MYSQL_USER || "root",
  password: process.env.V2_MYSQL_PASSWORD || fileEnv.MYSQL_PASSWORD || ""
};
const COMPANY_ID = "990002";
const AUTH_TOKEN = "v2-integration-token";

async function call(baseUrl, method, pathname, body, token = AUTH_TOKEN) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text, requestId: response.headers.get("x-request-id") || "" };
}

test("V2 HTTP 全栈：采集批次与刊登占用走真实表", { skip: !enabled }, async () => {
  const admin = await mysql.createConnection(baseEnv);
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4`);
  await admin.end();

  const pool = createV2Pool({
    V2_MYSQL_HOST: baseEnv.host, V2_MYSQL_PORT: String(baseEnv.port),
    V2_MYSQL_USER: baseEnv.user, V2_MYSQL_PASSWORD: baseEnv.password, V2_MYSQL_DATABASE: database
  });
  let server = null;
  try {
    await runMigrations(pool);
    const app = createV2Application({
      pool,
      verifyToken: async (token) => {
        if (token !== AUTH_TOKEN) throw new Error("bad token");
        // V2 审计表的 actor_id / company_id 是 BIGINT，用户标识必须是数字字符串。
        return { id: "1", companyId: COMPANY_ID, permissions: "*" };
      },
      resolveCompanyId: (user) => user.companyId,
      resolvePermissions: (user) => user.permissions || []
    });
    server = http.createServer(app.handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    // 未带 token → 401
    const unauthorized = await call(baseUrl, "GET", "/api/v2/central/products", undefined, "");
    assert.equal(unauthorized.status, 401);

    // 未挂载路径 → 400
    const unknown = await call(baseUrl, "GET", "/api/v2/unknown");
    assert.equal(unknown.status, 400);

    // 采集批次：开启 → 投递 → 成功 → 收尾
    const opened = await call(baseUrl, "POST", "/api/v2/collection/batches", {
      source: "collector.extension", requestNamespace: "collector.import", requestId: "http-it-1"
    });
    assert.equal(opened.status, 200);
    const batchPublicId = opened.json.data.batch.publicId;
    assert.match(opened.json.data.batch.publicId, /^CB_/);
    assert.ok(opened.requestId, "响应应带 X-Request-Id");

    const added = await call(baseUrl, "POST", `/api/v2/collection/batches/${batchPublicId}/items`, {
      sourcePlatform: "ozon", sourceProductId: "SKU-HTTP-1", rawPayload: { title: "HTTP" }
    });
    assert.equal(added.status, 200);
    const itemId = added.json.data.item.id;

    const succeeded = await call(baseUrl, "POST", `/api/v2/collection/batches/${batchPublicId}/items/${itemId}/succeeded`, { centralProductId: 777 });
    assert.equal(succeeded.status, 200);

    const finished = await call(baseUrl, "POST", `/api/v2/collection/batches/${batchPublicId}/finish`);
    assert.equal(finished.status, 200);
    assert.equal(finished.json.data.status, "succeeded");

    const detail = await call(baseUrl, "GET", `/api/v2/collection/batches/${batchPublicId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.data.items.length, 1);
    assert.equal(detail.json.data.items[0].status, "succeeded");

    // 发布批次：创建 → 迁移 → 收尾
    const created = await call(baseUrl, "POST", "/api/v2/publish/batches", {
      requestedItemCount: 1, requestNamespace: "publish.create", clientRequestId: "http-it-cli-1"
    });
    assert.equal(created.status, 200);
    const publishPublicId = created.json.data.batch.publicId;

    const queued = await call(baseUrl, "POST", `/api/v2/publish/batches/${publishPublicId}/transitions`, { to: "queued", expectedRowVersion: 0 });
    assert.equal(queued.status, 200);
    assert.equal(queued.json.data.to, "queued");

    const conflict = await call(baseUrl, "POST", `/api/v2/publish/batches/${publishPublicId}/transitions`, { to: "running", expectedRowVersion: 0 });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, "V2_ROW_VERSION_CONFLICT");

    const running = await call(baseUrl, "POST", `/api/v2/publish/batches/${publishPublicId}/transitions`, { to: "running", expectedRowVersion: 1 });
    assert.equal(running.status, 200);

    const settled = await call(baseUrl, "POST", `/api/v2/publish/batches/${publishPublicId}/finish`, { jobStatuses: ["succeeded", "failed"] });
    assert.equal(settled.status, 200);
    assert.equal(settled.json.data.status, "partially_succeeded");

    // 刊登占用：获取 → 命中复用 → 释放 → 重新获取
    const claim = await call(baseUrl, "POST", "/api/v2/publish/claims", {
      platform: "yandex", shopId: "10001", businessKey: "SKU-HTTP-1", publishJobId: "1", leaseMs: 60000
    });
    assert.equal(claim.status, 200);
    assert.equal(claim.json.data.claim.status, "held");

    const reused = await call(baseUrl, "POST", "/api/v2/publish/claims", { platform: "yandex", shopId: "10001", businessKey: "SKU-HTTP-1" });
    assert.equal(reused.status, 200);
    assert.equal(reused.json.data.reused, true);

    const released = await call(baseUrl, "POST", `/api/v2/publish/claims/${claim.json.data.claim.id}/release`);
    assert.equal(released.status, 200);
    assert.equal(released.json.data.claim.status, "released");

    // 落库校验：直接查表确认状态与租约
    const [claimRows] = await pool.query("SELECT status, lease_until FROM publish_claims WHERE company_id = ? AND business_key = ?", [COMPANY_ID, "SKU-HTTP-1"]);
    assert.equal(claimRows.length, 1);
    assert.equal(claimRows[0].status, "released");
    assert.equal(claimRows[0].lease_until, null);

    const [batchRows] = await pool.query("SELECT status, success_count FROM collection_batches WHERE company_id = ? AND public_id = ?", [COMPANY_ID, batchPublicId]);
    assert.equal(batchRows[0].status, "succeeded");
    assert.equal(Number(batchRows[0].success_count), 1);

    // 审计：V2 审计表应有成功记录
    const [auditRows] = await pool.query("SELECT COUNT(*) AS c FROM v2_audit_logs WHERE company_id = ?", [COMPANY_ID]);
    assert.ok(Number(auditRows[0].c) > 0, "V2 审计日志应有记录");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { await pool.end(); } catch { /* ignore */ }
    const cleanup = await mysql.createConnection(baseEnv);
    await cleanup.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await cleanup.end();
  }
});
