"use strict";
// 发布批次 / 刊登占用仓储单元测试：行映射、唯一冲突回退、列白名单、过期租约查询。
const test = require("node:test");
const assert = require("node:assert/strict");

const { MysqlPublishRepository, mapBatch, mapClaim } = require("./mysqlPublishRepository");

function makePool(handlers = {}) {
  const calls = [];
  const pool = {
    calls,
    async execute(sql, values) {
      calls.push({ sql, values });
      return handlers.execute ? handlers.execute(sql, values) : [{ insertId: 5, affectedRows: 1 }];
    }
  };
  pool.getConnection = async () => ({
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    execute: pool.execute.bind(pool)
  });
  return pool;
}

test("mapBatch / mapClaim 映射列名并补齐数字类型", () => {
  const batch = mapBatch({
    id: 1, public_id: "PB_1", company_id: 9, requested_by: 3, status: "running", requested_item_count: 4,
    job_count: 4, estimated_cost: "1.2500", actual_cost: "2.5000", estimated_seconds: 30,
    request_namespace: "publish.create", client_request_id: "cli-1", created_at: "2026-09-27 10:00:00.000",
    finished_at: null, row_version: 3
  });
  assert.equal(batch.publicId, "PB_1");
  assert.equal(batch.requestedItemCount, 4);
  assert.equal(batch.estimatedCost, 1.25);
  assert.equal(batch.rowVersion, 3);

  const claim = mapClaim({
    id: 2, company_id: 9, platform: "yandex", shop_id: 100, business_key: "SKU-1", publish_job_id: 77,
    status: "held", lease_until: "2026-09-27 10:05:00.000", created_at: "a", updated_at: "b"
  });
  assert.equal(claim.businessKey, "SKU-1");
  assert.equal(claim.publishJobId, 77);
  assert.equal(claim.status, "held");

  assert.equal(mapBatch(null), null);
  assert.equal(mapClaim(null), null);
});

test("createBatch 撞唯一约束时回读已存在批次", async () => {
  const pool = makePool({
    execute: async (sql) => {
      if (sql.startsWith("INSERT")) { const error = new Error("duplicate"); error.code = "ER_DUP_ENTRY"; throw error; }
      return [[{
        id: 4, public_id: "PB_EXIST", company_id: 9, status: "created", request_namespace: "publish.create",
        client_request_id: "cli-1", requested_item_count: 2, job_count: 0, row_version: 0
      }]];
    }
  });
  const repository = new MysqlPublishRepository({ pool });
  const batch = await repository.createBatch({
    publicId: "PB_NEW", companyId: 9, status: "created", requestNamespace: "publish.create",
    clientRequestId: "cli-1", requestedItemCount: 2, createdAt: "2026-09-27 10:00:00.000"
  });
  assert.equal(batch.publicId, "PB_EXIST");
});

test("updateBatch 不写 updated_at（publish_batches 没有该列）", async () => {
  const pool = makePool({ execute: async (sql) => (sql.startsWith("UPDATE") ? [{ affectedRows: 1 }] : [[{
    id: 1, public_id: "PB_1", company_id: 9, status: "running", requested_item_count: 2, job_count: 0, row_version: 1
  }]]) });
  const repository = new MysqlPublishRepository({ pool });
  await repository.updateBatch(1, { status: "running", rowVersion: 1, updatedAt: "2026-09-27 10:00:00.000", finishedAt: "2026-09-27 10:01:00.000" });

  const update = pool.calls.find((call) => call.sql.startsWith("UPDATE publish_batches"));
  assert.ok(update);
  assert.match(update.sql, /status = \?/);
  assert.match(update.sql, /row_version = \?/);
  assert.match(update.sql, /finished_at = \?/);
  assert.doesNotMatch(update.sql, /updated_at/);
});

test("createClaim 撞唯一约束时回读已有占用（并发兜底）", async () => {
  const pool = makePool({
    execute: async (sql) => {
      if (sql.startsWith("INSERT")) { const error = new Error("duplicate"); error.code = "ER_DUP_ENTRY"; throw error; }
      return [[{
        id: 8, company_id: 9, platform: "yandex", shop_id: 100, business_key: "SKU-1", status: "held",
        lease_until: "2026-09-27 10:05:00.000", publish_job_id: 1
      }]];
    }
  });
  const repository = new MysqlPublishRepository({ pool });
  const claim = await repository.createClaim({
    companyId: 9, platform: "yandex", shopId: "100", businessKey: "SKU-1", status: "held",
    leaseUntil: "2026-09-27 10:05:00.000", createdAt: "a", updatedAt: "b"
  });
  assert.equal(claim.id, 8);
  assert.equal(claim.status, "held");
});

test("listExpiredHeldClaims 只查 held 且租约已到期，并钳制 limit", async () => {
  const pool = makePool({ execute: async () => [[{ id: 1, company_id: 9, platform: "yandex", shop_id: 1, business_key: "K", status: "held", lease_until: "2026-09-27 09:00:00.000" }]] });
  const repository = new MysqlPublishRepository({ pool });
  const rows = await repository.listExpiredHeldClaims("2026-09-27 10:00:00.000", 5000);

  assert.equal(rows.length, 1);
  const query = pool.calls[0];
  assert.match(query.sql, /status = 'held'/);
  assert.match(query.sql, /lease_until IS NOT NULL AND lease_until <= \?/);
  assert.match(query.sql, /LIMIT 1000/, "limit 被钳制到 1000");
  assert.equal(query.values[0], "2026-09-27 10:00:00.000");
});

test("updateClaim 更新状态、租约与 updated_at", async () => {
  const pool = makePool({ execute: async (sql) => (sql.startsWith("UPDATE") ? [{ affectedRows: 1 }] : [[{
    id: 2, company_id: 9, platform: "yandex", shop_id: 1, business_key: "K", status: "probe_required", lease_until: null
  }]]) });
  const repository = new MysqlPublishRepository({ pool });
  await repository.updateClaim(2, { status: "probe_required", leaseUntil: null, updatedAt: "2026-09-27 10:00:00.000" });

  const update = pool.calls.find((call) => call.sql.startsWith("UPDATE publish_claims"));
  assert.match(update.sql, /status = \?/);
  assert.match(update.sql, /lease_until = \?/);
  assert.match(update.sql, /updated_at = \?/);
  assert.equal(update.values.includes(null), true, "释放时 lease_until 写 NULL");
});
