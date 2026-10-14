"use strict";
// 产品开发库 · 真实 MySQL 集成门禁（契约 §3 建表 / §4 状态机 / §5.1 落库回读 / §2 隔离 / §10 调用面）
//
// 默认跳过；显式开启后运行：
//   V2_MYSQL_RUN_INTEGRATION=1 node --test backend/product-dev/pdev.integration.test.js
// 本地不方便把密码放进环境变量时回退读 erp/.env 的 MYSQL_*（密钥不出现在命令行）。
//
// 自带独立测试库：跑前 CREATE、跑完 DROP，绝不碰业务库。
// 注意：默认库名沿用 erp_app 有权限的那个测试库（与 backend/app.test.js 同库），
// **不要与 `npm test` 并发运行**；要换独立库请设 V2_MYSQL_TEST_PDEV_DATABASE。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");

const { ensurePdevTables } = require("./pdev-schema");
const { createPdevRepository } = require("./pdev-repository");
const { createPdevService, PdevError } = require("./pdev-service");

function readEnvFile() {
  const envPath = path.join(__dirname, "..", "..", ".env");
  const env = {};
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

const enabled = process.env.V2_MYSQL_RUN_INTEGRATION === "1";
const fileEnv = readEnvFile();
const baseEnv = {
  host: process.env.V2_MYSQL_HOST || fileEnv.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.V2_MYSQL_PORT || fileEnv.MYSQL_PORT || 3306),
  user: process.env.V2_MYSQL_USER || fileEnv.MYSQL_USER || "root",
  password: process.env.V2_MYSQL_PASSWORD || fileEnv.MYSQL_PASSWORD || ""
};
const database = process.env.V2_MYSQL_TEST_PDEV_DATABASE || "ecommerce_order_admin_test";

const SKIP_REASON = "真实 MySQL 门禁未开启：设置 V2_MYSQL_RUN_INTEGRATION=1（账号可用 V2_MYSQL_* 或 erp/.env）后运行";

const USER_A = { id: "USR-IT-A", companyName: "系统", companyId: "system" };
const USER_B = { id: "USR-IT-B", companyName: "集成测试B公司", companyId: "CMP-IT-B" };

const MYSQL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

async function expectPdevError(promise, expected, label) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `${label}: 期望抛错，但调用成功了`);
  assert.ok(error instanceof PdevError, `${label}: 应抛 PdevError，实际 ${error && error.constructor && error.constructor.name}`);
  if (expected.code !== undefined) assert.equal(error.code, expected.code, `${label}: PdevError.code 不符`);
  if (expected.statusCode !== undefined) assert.equal(Number(error.statusCode), expected.statusCode, `${label}: statusCode 不符`);
  return error;
}

function indexColumns(rows, keyName) {
  return rows.filter((row) => row.Key_name === keyName).map((row) => String(row.Column_name));
}

function findUniqueIndex(rows, columns) {
  const names = new Set(rows.map((row) => row.Key_name));
  for (const name of names) {
    const group = rows.filter((row) => row.Key_name === name);
    if (group.every((row) => Number(row.Non_unique) === 0)) {
      const cols = indexColumns(rows, name);
      if (columns.every((column) => cols.includes(column))) return name;
    }
  }
  return null;
}

test("产品开发库在真实 MySQL 上建表、走通全链路、隔离与唯一约束生效", { skip: enabled ? false : SKIP_REASON }, async () => {
  const admin = await mysql.createConnection(baseEnv);
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4`);
  await admin.end();

  const pool = mysql.createPool({
    host: baseEnv.host,
    port: baseEnv.port,
    user: baseEnv.user,
    password: baseEnv.password,
    database,
    charset: "utf8mb4",
    timezone: "Z",
    waitForConnections: true,
    connectionLimit: 4,
    decimalNumbers: true
  });

  try {
    // ── §3 建表：幂等 + 恰好 4 张表 + 关键唯一索引 ─────────────────────────
    await ensurePdevTables(pool);
    await ensurePdevTables(pool); // 幂等：第二次不得报错

    const [tables] = await pool.query("SHOW TABLES LIKE 'pdev_%'");
    const tableNames = tables.map((row) => Object.values(row)[0]).sort();
    assert.deepEqual(tableNames, ["pdev_assets", "pdev_products", "pdev_sources", "pdev_variants"], "§3 必须恰好 4 张 pdev_ 表");

    const [productIndexes] = await pool.query("SHOW INDEX FROM pdev_products");
    assert.ok(findUniqueIndex(productIndexes, ["public_id"]), "§3.1 需要 UNIQUE(public_id)");
    const [sourceIndexes] = await pool.query("SHOW INDEX FROM pdev_sources");
    assert.ok(findUniqueIndex(sourceIndexes, ["company_key", "platform", "source_product_id"]),
      "§3.2 需要 UNIQUE(company_key, platform, source_product_id)");
    const [variantIndexes] = await pool.query("SHOW INDEX FROM pdev_variants");
    assert.ok(findUniqueIndex(variantIndexes, ["company_key", "pdev_product_id", "variant_key"]),
      "§3.4 需要 UNIQUE(company_key, pdev_product_id, variant_key)");

    // ── §10.1 修正点 2：工厂是 createPdevRepository({ getPool }) ─────────────
    const repository = createPdevRepository({ getPool: () => pool });
    const service = createPdevService({ repository }); // 默认 resolveCompanyKey（§2 内置）

    // ── 建品 ──────────────────────────────────────────────────────────────
    const created = (await service.createProduct({
      user: USER_A, title: "集成测试露营帐篷", remark: "真实库门禁", categoryHint: "户外",
      targetPlatform: "ozon", ownerUserId: "USR-IT-A"
    })).product;
    assert.match(String(created.publicId), /^PD_/, "publicId 必须 PD_ 前缀");
    assert.equal(created.devStatus, "new");
    assert.equal(Number(created.rowVersion), 0);
    assert.match(String(created.createdAt), MYSQL_DATETIME, "§8 9.6：时间必须是 UTC 字符串 YYYY-MM-DD HH:mm:ss.SSS");
    assert.match(String(created.updatedAt), MYSQL_DATETIME);
    assert.equal(Object.prototype.hasOwnProperty.call(created, "company_key"), false, "对外对象不得含 company_key");

    // ── §5 #4 PATCH：expectedRowVersion 必填，write 后 +1，过期 409 ────────
    const patched = (await service.updateProduct({
      user: USER_A, publicId: created.publicId, expectedRowVersion: 0, patch: { title: "集成测试露营帐篷-改" }
    })).product;
    assert.equal(patched.title, "集成测试露营帐篷-改");
    assert.equal(Number(patched.rowVersion), 1);
    await expectPdevError(
      service.updateProduct({ user: USER_A, publicId: created.publicId, expectedRowVersion: 0, patch: { title: "并发覆盖" } }),
      { code: "VERSION_CONFLICT", statusCode: 409 },
      "过期 rowVersion PATCH"
    );

    // ── 挂货源（active + 有价）→ 改价 ─────────────────────────────────────
    const source = (await service.addSource({
      user: USER_A, publicId: created.publicId,
      platform: "1688", sourceProductId: "IT-SOURCE-1", sourceUrl: "https://detail.1688.com/offer/1.html",
      supplyPrice: 12.5, supplyCurrency: "CNY", moq: 2, supplierName: "集成供应商", supplyStatus: "active", note: "比价"
    })).source;
    assert.equal(Number(source.pdevProductId), Number(created.id));
    assert.equal(Number(source.supplyPrice), 12.5, "DECIMAL 应按数字回读");

    const updatedSource = (await service.updateSource({
      user: USER_A, id: source.id, supplyPrice: 11.5, supplyStatus: "active", note: "降价"
    })).source;
    assert.equal(Number(updatedSource.supplyPrice), 11.5);
    assert.equal(updatedSource.note, "降价");
    await expectPdevError(
      service.updateSource({ user: USER_A, id: source.id }),
      { code: "VALIDATION_FAILED", statusCode: 400 },
      "空补丁改货源（§8 9.4 / §10.3 #2）"
    );

    // ── 传主图 ────────────────────────────────────────────────────────────
    const asset = (await service.addAsset({
      user: USER_A, publicId: created.publicId, assetType: "main", sourceUrl: "https://img.example.com/it-main.jpg", sortNo: 0
    })).asset;
    assert.equal(asset.assetType, "main");
    assert.equal(asset.status, "ready");
    assert.equal(asset.checksum, null);

    // ── 越级流转必须被拦（真实库上读的是落库后的货源/图片） ────────────────
    await expectPdevError(
      service.changeStatus({ user: USER_A, publicId: created.publicId, to: "finalized", expectedRowVersion: 1 }),
      { statusCode: 400 },
      "new → finalized"
    );

    const infoReady = (await service.changeStatus({
      user: USER_A, publicId: created.publicId, to: "info_ready", expectedRowVersion: 1
    })).product;
    assert.equal(infoReady.devStatus, "info_ready");
    assert.equal(Number(infoReady.rowVersion), 2);
    assert.equal(Number(infoReady.sourceCount), 1);
    assert.equal(Number(infoReady.activeSourceCount), 1, "11.5 元 + active 必须被认作合格货源");
    assert.equal(Number(infoReady.assetCount), 1);

    // ── 建变体（归一化落库 + 唯一约束） ───────────────────────────────────
    const variant = (await service.addVariant({
      user: USER_A, publicId: created.publicId,
      spec: { 颜色: "黑", 尺寸: "L" }, supplyPrice: 12.5, weightKg: 0.35,
      packageLengthCm: 30, packageWidthCm: 20, packageHeightCm: 10
    })).variant;
    assert.equal(variant.variantKey, "尺寸=l;颜色=黑", "§3.4 归一化应落库");
    assert.deepEqual(variant.spec, { 颜色: "黑", 尺寸: "L" }, "spec_json 应往返一致");
    assert.match(String(variant.createdAt), MYSQL_DATETIME);

    await expectPdevError(
      service.addVariant({ user: USER_A, publicId: created.publicId, spec: { 尺寸: "l", 颜色: "黑" } }),
      { code: "VARIANT_TAKEN", statusCode: 409 },
      "重复 variant_key"
    );

    // ── finalized → archived（终态） ─────────────────────────────────────
    const finalized = (await service.changeStatus({
      user: USER_A, publicId: created.publicId, to: "finalized", expectedRowVersion: 2
    })).product;
    assert.equal(finalized.devStatus, "finalized");
    assert.equal(Number(finalized.rowVersion), 3);

    await expectPdevError(
      service.changeStatus({ user: USER_A, publicId: created.publicId, to: "archived", expectedRowVersion: 2 }),
      { code: "VERSION_CONFLICT", statusCode: 409 },
      "过期 rowVersion 流转"
    );

    const archived = (await service.changeStatus({
      user: USER_A, publicId: created.publicId, to: "archived", expectedRowVersion: 3
    })).product;
    assert.equal(archived.devStatus, "archived");
    assert.equal(Number(archived.rowVersion), 4);
    await expectPdevError(
      service.changeStatus({ user: USER_A, publicId: created.publicId, to: "developing", expectedRowVersion: 4 }),
      { statusCode: 400 },
      "archived 是终态"
    );

    // ── 落库回读：换一套全新 repository/service 实例，数据必须还在 ──────────
    const freshRepository = createPdevRepository({ getPool: () => pool });
    const freshService = createPdevService({ repository: freshRepository });
    const reloaded = await freshService.getProduct({ user: USER_A, publicId: created.publicId });
    assert.equal(reloaded.product.devStatus, "archived");
    assert.equal(reloaded.product.title, "集成测试露营帐篷-改");
    assert.equal(Number(reloaded.product.rowVersion), 4);
    assert.equal(Number(reloaded.product.variantCount), 1);
    assert.equal(Number(reloaded.product.sourceCount), 1);
    assert.equal(Number(reloaded.product.activeSourceCount), 1);
    assert.equal(Number(reloaded.product.assetCount), 1);
    assert.equal(reloaded.sources.length, 1);
    assert.equal(Number(reloaded.sources[0].supplyPrice), 11.5);
    assert.equal(reloaded.variants.length, 1);
    assert.equal(reloaded.variants[0].variantKey, "尺寸=l;颜色=黑");
    assert.equal(reloaded.assets.length, 1);
    assert.equal(reloaded.assets[0].assetType, "main");

    // ── §3.2 货源业务键唯一（同公司跨产品 409，带占用 publicId） ──────────
    const secondProduct = (await service.createProduct({ user: USER_A, title: "集成测试第二个产品" })).product;
    const conflict = await expectPdevError(
      service.addSource({ user: USER_A, publicId: secondProduct.publicId, platform: "1688", sourceProductId: "IT-SOURCE-1" }),
      { code: "SOURCE_TAKEN", statusCode: 409 },
      "同公司重复货源"
    );
    const occupier = (conflict.details && conflict.details.publicId) || conflict.publicId
      || (String(conflict.message).match(/PD_[A-Za-z0-9_-]+/) || [])[0];
    assert.equal(occupier, created.publicId, "409 应附占用者 publicId");

    // ── §2 公司隔离（真实 SQL 的 company_key 过滤） ───────────────────────
    const productB = (await service.createProduct({ user: USER_B, title: "B 公司产品" })).product;
    assert.notEqual(productB.publicId, created.publicId);

    const listA = await service.listProducts({ user: USER_A, page: 1, pageSize: 100 });
    const publicIdsA = listA.items.map((item) => item.publicId);
    assert.ok(publicIdsA.includes(created.publicId));
    assert.ok(publicIdsA.includes(secondProduct.publicId));
    assert.ok(!publicIdsA.includes(productB.publicId), "A 的列表不得含 B 的产品");
    assert.equal(Number(listA.total), 2, "A 公司只应统计自己的产品");

    await expectPdevError(
      service.getProduct({ user: USER_A, publicId: productB.publicId }),
      { code: "NOT_FOUND", statusCode: 404 },
      "A 查 B 的产品"
    );
    await expectPdevError(
      service.deleteProduct({ user: USER_A, publicId: productB.publicId }),
      { code: "NOT_FOUND", statusCode: 404 },
      "A 删 B 的产品"
    );
    const stillB = (await service.getProduct({ user: USER_B, publicId: productB.publicId })).product;
    assert.equal(stillB.publicId, productB.publicId, "B 的产品不得被 A 删除");

    // 跨公司同业务键货源允许（唯一索引按公司）
    const sourceB = (await service.addSource({
      user: USER_B, publicId: productB.publicId, platform: "1688", sourceProductId: "IT-SOURCE-1",
      supplyPrice: 9.9, supplyStatus: "active"
    })).source;
    assert.ok(sourceB.id);

    // A 不能改 B 的货源（§8 9.5：读写子表前后校验 company_key，否则 404）
    await expectPdevError(
      service.updateSource({ user: USER_A, id: sourceB.id, supplyPrice: 0.01 }),
      { code: "NOT_FOUND", statusCode: 404 },
      "A 改 B 的货源"
    );

    // ── §11 列表 missing：字段 / 固定顺序 / 过滤 / §11.5 互斥 / §11.7 不在 {product} 上 ──
    const MISSING_ORDER = ["noSource", "noActivePrice", "noMainAsset", "noVariant"];
    const listForMissing = await service.listProducts({ user: USER_A, page: 1, pageSize: 100 });
    for (const item of listForMissing.items) {
      assert.ok(Array.isArray(item.missing), "§11.1 列表项必须有 missing: string[]");
      for (const token of item.missing) assert.ok(MISSING_ORDER.includes(token), `未知 missing token ${token}`);
      const order = item.missing.map((token) => MISSING_ORDER.indexOf(token));
      assert.deepEqual(order, [...order].sort((a, b) => a - b), "§11.1 missing 顺序必须固定");
    }
    const createdItem = listForMissing.items.find((item) => item.publicId === created.publicId);
    assert.deepEqual(createdItem.missing, [], "资料齐全的商品 missing 必须为空数组");
    const secondItem = listForMissing.items.find((item) => item.publicId === secondProduct.publicId);
    assert.deepEqual(secondItem.missing, ["noSource", "noMainAsset", "noVariant"], "§11.5：无货源只报 noSource");

    const detailCreated = await freshService.getProduct({ user: USER_A, publicId: created.publicId });
    assert.equal(Object.prototype.hasOwnProperty.call(detailCreated.product, "missing"), false,
      "§11.7：{product} 不含 missing 键");

    const noSourceList = await service.listProducts({ user: USER_A, missing: "noSource", page: 1, pageSize: 100 });
    assert.deepEqual(noSourceList.items.map((item) => item.publicId), [secondProduct.publicId]);
    const noPriceList = await service.listProducts({ user: USER_A, missing: "noActivePrice", page: 1, pageSize: 100 });
    assert.deepEqual(noPriceList.items.map((item) => item.publicId), [], "§11.5：无货源商品不得被计进 noActivePrice");

    // ── §5 #13 汇总（真实库 COUNT） ───────────────────────────────────────
    const summary = await service.getSummary({ user: USER_A });
    assert.deepEqual(Object.keys(summary.byStatus).sort(), ["archived", "developing", "finalized", "info_ready", "new"]);
    assert.deepEqual(Object.keys(summary.missing).sort(), ["noActivePrice", "noMainAsset", "noSource", "noVariant"]);
    assert.equal(Number(summary.byStatus.archived), 1, "A 公司归档 1 个产品");
    assert.equal(Number(summary.byStatus.new), 1, "A 公司还有 1 个 new（第二个产品）");
    assert.equal(Number(summary.byStatus.finalized), 0, "B 公司数据不得计入 A");

    // §11.8：summary 的每个 missing 桶必须等于 ?missing=token 的列表 total（chip 与列表自洽）
    for (const token of MISSING_ORDER) {
      const filtered = await service.listProducts({ user: USER_A, missing: token, page: 1, pageSize: 100 });
      assert.equal(Number(summary.missing[token]), Number(filtered.total),
        `§11.8 summary.missing.${token} 必须等于 ?missing=${token} 的 total`);
    }
    assert.equal(Number(summary.missing.noSource), 1);
    assert.equal(Number(summary.missing.noActivePrice), 0, "§11.5：只报 noSource 的商品不得同时计入 noActivePrice");
    assert.equal(Number(summary.missing.noMainAsset), 1);
    assert.equal(Number(summary.missing.noVariant), 1);

    // ── §5 #5 删除级联（真实库事务） ──────────────────────────────────────
    const removed = await service.deleteProduct({ user: USER_A, publicId: created.publicId });
    assert.deepEqual(removed, { removed: true });
    const [sourceRows] = await pool.query("SELECT COUNT(*) AS n FROM pdev_sources WHERE pdev_product_id = ?", [created.id]);
    const [assetRows] = await pool.query("SELECT COUNT(*) AS n FROM pdev_assets WHERE pdev_product_id = ?", [created.id]);
    const [variantRows] = await pool.query("SELECT COUNT(*) AS n FROM pdev_variants WHERE pdev_product_id = ?", [created.id]);
    assert.equal(Number(sourceRows[0].n), 0, "删除产品应连带删除货源");
    assert.equal(Number(assetRows[0].n), 0, "删除产品应连带删除图片");
    assert.equal(Number(variantRows[0].n), 0, "删除产品应连带删除变体");
    await expectPdevError(
      service.getProduct({ user: USER_A, publicId: created.publicId }),
      { code: "NOT_FOUND", statusCode: 404 },
      "删除后回读"
    );
  } finally {
    try { await pool.end(); } catch { /* ignore */ }
    try {
      const cleanup = await mysql.createConnection(baseEnv);
      await cleanup.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await cleanup.end();
    } catch (error) {
      console.error(`pdev.integration.test.js: 清理测试库 ${database} 失败：${String((error && error.message) || error)}`);
    }
  }
});
