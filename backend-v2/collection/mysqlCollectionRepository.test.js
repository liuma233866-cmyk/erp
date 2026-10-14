"use strict";
// 采集仓储单元测试：行映射、唯一冲突回退、更新白名单、事务边界。
const test = require("node:test");
const assert = require("node:assert/strict");

const { MysqlCollectionRepository, mapBatch, mapItem } = require("./mysqlCollectionRepository");

function makePool(handlers = {}) {
  const calls = [];
  const pool = {
    calls,
    async execute(sql, values) {
      calls.push({ sql, values });
      return handlers.execute ? handlers.execute(sql, values) : [{ insertId: 7, affectedRows: 1 }];
    }
  };
  pool.getConnection = async () => ({
    beginTransaction: async () => { pool.calls.push({ sql: "BEGIN" }); },
    commit: async () => { pool.calls.push({ sql: "COMMIT" }); },
    rollback: async () => { pool.calls.push({ sql: "ROLLBACK" }); },
    release: () => { pool.calls.push({ sql: "RELEASE" }); },
    execute: pool.execute.bind(pool)
  });
  return pool;
}

test("mapBatch / mapItem 把 snake_case 行映射成 camelCase，并解析 JSON 载荷", () => {
  const batch = mapBatch({
    id: 1, public_id: "CB_1", company_id: 9, source: "excel", requested_by: 3, status: "running",
    item_count: 2, success_count: 1, failed_count: 1, request_namespace: "collector.import", request_id: "r1",
    created_at: "2026-09-27 10:00:00.000", finished_at: null
  });
  assert.equal(batch.publicId, "CB_1");
  assert.equal(batch.itemCount, 2);
  assert.equal(batch.requestNamespace, "collector.import");
  assert.equal(batch.finishedAt, null);

  const item = mapItem({
    id: 5, collection_batch_id: 1, company_id: 9, source_platform: "ozon", source_product_id: "P-1",
    raw_payload_json: '{"title":"x"}', central_product_id: 42, status: "succeeded", error_code: null,
    error_message: null, created_at: "2026-09-27 10:00:00.000", updated_at: "2026-09-27 10:00:01.000"
  });
  assert.deepEqual(item.rawPayload, { title: "x" });
  assert.equal(item.centralProductId, 42);
  assert.equal(item.sourcePlatform, "ozon");

  assert.equal(mapBatch(null), null);
  assert.equal(mapItem(undefined), null);
  assert.deepEqual(mapItem({ id: 1, raw_payload_json: "{bad json" }).rawPayload, {}, "坏 JSON 回退为空对象");
});

test("createBatch 撞唯一约束时回读已存在批次", async () => {
  const existing = { id: 3, publicId: "CB_EXIST", companyId: 9, requestNamespace: "ns", requestId: "r1", status: "created" };
  const pool = makePool({
    execute: async (sql) => {
      if (sql.startsWith("INSERT")) { const error = new Error("duplicate"); error.code = "ER_DUP_ENTRY"; throw error; }
      if (sql.startsWith("SELECT")) return [[{
        id: 3, public_id: "CB_EXIST", company_id: 9, request_namespace: "ns", request_id: "r1", status: "created",
        item_count: 0, success_count: 0, failed_count: 0
      }]];
      return [{}];
    }
  });
  const repository = new MysqlCollectionRepository({ pool });
  const created = await repository.createBatch({
    publicId: "CB_NEW", companyId: 9, source: "excel", status: "created", requestNamespace: "ns", requestId: "r1", createdAt: "2026-09-27 10:00:00.000"
  });
  assert.equal(created.publicId, existing.publicId);
  assert.equal(pool.calls.some((call) => call.sql.startsWith("SELECT")), true);
});

test("createItem 撞唯一约束时回读已存在项目", async () => {
  const pool = makePool({
    execute: async (sql) => {
      if (sql.startsWith("INSERT")) { const error = new Error("duplicate"); error.code = "ER_DUP_ENTRY"; throw error; }
      return [[{
        id: 11, collection_batch_id: 1, company_id: 9, source_platform: "ozon", source_product_id: "P-1",
        raw_payload_json: "{}", status: "pending"
      }]];
    }
  });
  const repository = new MysqlCollectionRepository({ pool });
  const item = await repository.createItem({
    collectionBatchId: 1, companyId: 9, sourcePlatform: "ozon", sourceProductId: "P-1", rawPayload: {},
    status: "pending", createdAt: "a", updatedAt: "b"
  });
  assert.equal(item.id, 11);
});

test("updateBatch / updateItem 只写白名单列，未知 patch 字段被忽略", async () => {
  const pool = makePool({ execute: async (sql) => (sql.startsWith("UPDATE") ? [{ affectedRows: 1 }] : [[{
    id: 1, public_id: "CB_1", company_id: 9, status: "running", item_count: 1, success_count: 0, failed_count: 0,
    request_namespace: "ns", request_id: "r1"
  }]]) });
  const repository = new MysqlCollectionRepository({ pool });
  await repository.updateBatch(1, { status: "running", itemCount: 1, finishedAt: "2026-09-27 10:00:05.000", updatedAt: "不该写入" });

  const update = pool.calls.find((call) => call.sql.startsWith("UPDATE collection_batches"));
  assert.ok(update, "应发出 UPDATE");
  assert.match(update.sql, /status = \?/);
  assert.match(update.sql, /finished_at = \?/);
  assert.doesNotMatch(update.sql, /updated_at/, "collection_batches 没有 updated_at 列");
});

test("createItem 把 rawPayload 序列化为 JSON 字符串", async () => {
  const pool = makePool();
  const repository = new MysqlCollectionRepository({ pool });
  await repository.createItem({
    collectionBatchId: 1, companyId: 9, sourcePlatform: "ozon", sourceProductId: "P-1",
    rawPayload: { title: "焊接", price: 12 }, status: "pending", createdAt: "a", updatedAt: "b"
  });
  const insert = pool.calls.find((call) => call.sql.startsWith("INSERT"));
  const payloadIndex = insert.values.findIndex((value) => typeof value === "string" && value.includes("焊接"));
  assert.notEqual(payloadIndex, -1);
  assert.deepEqual(JSON.parse(insert.values[payloadIndex]), { title: "焊接", price: 12 });
});

test("transaction 提交并释放连接，出错时回滚", async () => {
  const pool = makePool();
  const repository = new MysqlCollectionRepository({ pool });
  await repository.transaction(async () => "ok");
  assert.deepEqual(pool.calls.filter((call) => ["BEGIN", "COMMIT", "RELEASE"].includes(call.sql)).map((call) => call.sql), ["BEGIN", "COMMIT", "RELEASE"]);

  const failing = makePool();
  const failingRepository = new MysqlCollectionRepository({ pool: failing });
  await assert.rejects(() => failingRepository.transaction(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(failing.calls.some((call) => call.sql === "ROLLBACK"), true);
  assert.equal(failing.calls.some((call) => call.sql === "COMMIT"), false);
});
