"use strict";
// 采集/发布批次状态机 + 刊登占用的真实 MySQL 集成门禁。
//
// 默认跳过；设置 V2_MYSQL_RUN_INTEGRATION=1 并提供 V2_MYSQL_* 后运行：
//   V2_MYSQL_RUN_INTEGRATION=1 V2_MYSQL_USER=... V2_MYSQL_PASSWORD=... \
//   node --test backend-v2/collection/collectionBatch.integration.test.js
//
// 测试自带独立库（默认 v2test_batch），跑完 drop，不触碰业务库。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");

const { createV2Pool } = require("../db/pool");
const { runMigrations } = require("../migrations/migrationRunner");
const { MysqlCollectionRepository } = require("./mysqlCollectionRepository");
const { CollectionBatchService, COLLECTION_BATCH_STATUS, COLLECTION_ITEM_STATUS } = require("./collectionBatchService");
const { MysqlPublishRepository } = require("../publish/mysqlPublishRepository");
const { PublishBatchService, PUBLISH_BATCH_STATUS } = require("../publish/publishBatchService");
const { PublishClaimService, CLAIM_STATUS } = require("../publish/publishClaimService");

// 本地跑不方便把密码放进环境变量时，回退读 erp/.env 的 MYSQL_*（密钥不出现在命令行里）。
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
// 默认用 erp/.env 里 erp_app 唯一有权的测试库（与 backend/app.test.js 共用，两者不要并发跑）。
const database = process.env.V2_MYSQL_TEST_BATCH_DATABASE || "ecommerce_order_admin_test";
const fileEnv = readEnvFile();
const baseEnv = {
  host: process.env.V2_MYSQL_HOST || fileEnv.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.V2_MYSQL_PORT || fileEnv.MYSQL_PORT || 3306),
  user: process.env.V2_MYSQL_USER || fileEnv.MYSQL_USER || "root",
  password: process.env.V2_MYSQL_PASSWORD || fileEnv.MYSQL_PASSWORD || ""
};
const COMPANY_ID = 990001;

test("采集与发布批次状态机在真实表上落库并可回读", { skip: !enabled }, async () => {
  const admin = await mysql.createConnection(baseEnv);
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4`);
  await admin.end();

  const pool = createV2Pool({
    V2_MYSQL_HOST: baseEnv.host,
    V2_MYSQL_PORT: String(baseEnv.port),
    V2_MYSQL_USER: baseEnv.user,
    V2_MYSQL_PASSWORD: baseEnv.password,
    V2_MYSQL_DATABASE: database
  });

  try {
    await runMigrations(pool);

    // ── 采集批次 ──────────────────────────────────────────────────────────
    const collectionRepository = new MysqlCollectionRepository({ pool });
    const collection = new CollectionBatchService({ repository: collectionRepository, clock: () => new Date("2026-09-27T10:00:00.000Z") });

    const opened = await collection.openBatch({
      companyId: COMPANY_ID, source: "collector.extension", requestedBy: 7, requestNamespace: "collector.import", requestId: "it-req-1"
    });
    assert.equal(opened.reused, false);
    const reopened = await collection.openBatch({
      companyId: COMPANY_ID, source: "collector.extension", requestNamespace: "collector.import", requestId: "it-req-1"
    });
    assert.equal(reopened.reused, true, "唯一约束应保证幂等");
    assert.equal(reopened.batch.publicId, opened.batch.publicId);

    const first = await collection.addItem({
      companyId: COMPANY_ID, batchPublicId: opened.batch.publicId, sourcePlatform: "ozon", sourceProductId: "SKU-A", rawPayload: { title: "A" }
    });
    const second = await collection.addItem({
      companyId: COMPANY_ID, batchPublicId: opened.batch.publicId, sourcePlatform: "ozon", sourceProductId: "SKU-B", rawPayload: { title: "B" }
    });
    const duplicate = await collection.addItem({
      companyId: COMPANY_ID, batchPublicId: opened.batch.publicId, sourcePlatform: "ozon", sourceProductId: "SKU-A"
    });
    assert.equal(duplicate.duplicate, true);

    await collection.markItemSucceeded({ companyId: COMPANY_ID, batchPublicId: opened.batch.publicId, itemId: first.item.id, centralProductId: 555 });
    await collection.markItemFailed({ companyId: COMPANY_ID, batchPublicId: opened.batch.publicId, itemId: second.item.id, errorMessage: "bad payload" });

    const finished = await collection.finishBatch({ companyId: COMPANY_ID, batchPublicId: opened.batch.publicId });
    assert.equal(finished.status, COLLECTION_BATCH_STATUS.PARTIALLY_SUCCEEDED);
    assert.equal(finished.counts.successCount, 1);
    assert.equal(finished.counts.failedCount, 1);

    const summary = await collection.getBatchSummary({ companyId: COMPANY_ID, batchPublicId: opened.batch.publicId });
    assert.equal(summary.batch.status, COLLECTION_BATCH_STATUS.PARTIALLY_SUCCEEDED);
    assert.equal(summary.items.length, 2);
    const storedFirst = summary.items.find((item) => item.sourceProductId === "SKU-A");
    assert.equal(storedFirst.status, COLLECTION_ITEM_STATUS.SUCCEEDED);
    assert.equal(Number(storedFirst.centralProductId), 555);
    assert.deepEqual(storedFirst.rawPayload, { title: "A" }, "JSON 载荷应往返一致");

    // ── 发布批次 ──────────────────────────────────────────────────────────
    const publishRepository = new MysqlPublishRepository({ pool });
    const publishClock = { now: new Date("2026-09-27T10:00:00.000Z") };
    const publish = new PublishBatchService({ repository: publishRepository, clock: () => publishClock.now });

    const created = await publish.createBatch({
      companyId: COMPANY_ID, requestedBy: 7, requestedItemCount: 2, requestNamespace: "publish.create", clientRequestId: "it-cli-1", estimatedCost: 1.25
    });
    const reuse = await publish.createBatch({
      companyId: COMPANY_ID, requestedItemCount: 2, requestNamespace: "publish.create", clientRequestId: "it-cli-1"
    });
    assert.equal(reuse.reused, true);
    assert.equal(reuse.batch.publicId, created.batch.publicId);

    const queued = await publish.transition({ companyId: COMPANY_ID, batchPublicId: created.batch.publicId, to: "queued", expectedRowVersion: 0 });
    assert.equal(queued.batch.rowVersion, 1);
    await publish.transition({ companyId: COMPANY_ID, batchPublicId: created.batch.publicId, to: "running", expectedRowVersion: 1 });

    await assert.rejects(
      () => publish.transition({ companyId: COMPANY_ID, batchPublicId: created.batch.publicId, to: "succeeded", expectedRowVersion: 1 }),
      (error) => error.code === "V2_ROW_VERSION_CONFLICT"
    );

    const done = await publish.finishBatch({
      companyId: COMPANY_ID, batchPublicId: created.batch.publicId, jobStatuses: ["succeeded", "blocked"], actualCost: 2.5
    });
    assert.equal(done.status, PUBLISH_BATCH_STATUS.PARTIALLY_SUCCEEDED);
    assert.equal(done.batch.jobCount, 2);
    assert.equal(done.batch.actualCost, 2.5);

    const reloaded = await publishRepository.findBatchByPublicId(COMPANY_ID, created.batch.publicId);
    assert.equal(reloaded.status, PUBLISH_BATCH_STATUS.PARTIALLY_SUCCEEDED);
    assert.ok(reloaded.finishedAt, "finished_at 应落库");

    // ── 刊登占用：租约到期转探测态，终态释放后可重新获取 ──────────────────
    const claims = new PublishClaimService({ repository: publishRepository, clock: () => publishClock.now });
    const acquired = await claims.acquire({
      companyId: COMPANY_ID, platform: "yandex", shopId: "10001", businessKey: "SKU-A", publishJobId: "1", leaseMs: 60000
    });
    assert.equal(acquired.claim.status, CLAIM_STATUS.HELD);

    const reused = await claims.acquire({ companyId: COMPANY_ID, platform: "yandex", shopId: "10001", businessKey: "SKU-A" });
    assert.equal(reused.reused, true, "唯一约束应保证同一业务键只有一个占用");
    assert.equal(reused.leaseExpired, false);

    publishClock.now = new Date("2026-09-27T10:05:00.000Z");
    const recovered = await claims.recoverExpiredLeases();
    assert.equal(recovered.count, 1);
    assert.equal((await publishRepository.findClaim(COMPANY_ID, "yandex", "10001", "SKU-A")).status, CLAIM_STATUS.PROBE_REQUIRED);

    await claims.releaseTerminal({ companyId: COMPANY_ID, claimId: acquired.claim.id });
    const released = await publishRepository.findClaim(COMPANY_ID, "yandex", "10001", "SKU-A");
    assert.equal(released.status, CLAIM_STATUS.RELEASED);
    assert.equal(released.leaseUntil, null);

    const reacquired = await claims.acquire({ companyId: COMPANY_ID, platform: "yandex", shopId: "10001", businessKey: "SKU-A" });
    assert.equal(reacquired.claim.status, CLAIM_STATUS.HELD);
    assert.equal(reacquired.reacquired, true);
  } finally {
    try { await pool.end(); } catch { /* ignore */ }
    const cleanup = await mysql.createConnection(baseEnv);
    await cleanup.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await cleanup.end();
  }
});
