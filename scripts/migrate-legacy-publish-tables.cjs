#!/usr/bin/env node
"use strict";
/**
 * 清理历史遗留孤儿表（publish_products / publish_settings）。
 *
 * 这两张表在当前代码里既不被写入也不被读取，实体已经迁到 AppState 快照
 * （见 backend/persistence/store-manifest.js 与 scripts/persistence-divergence.cjs），
 * 但表里还留着旧数据，导致「查库」与「页面」看到不同的世界。
 *
 * 默认 dry-run，只打印计划；加 --apply 才会执行：
 *   1. 建 legacy_<table>_backup 并把原表数据整表复制过去（可回滚）；
 *   2. 校验备份行数与原表一致；
 *   3. DROP 原表。
 *
 * 用法：
 *   node scripts/migrate-legacy-publish-tables.cjs             # dry-run
 *   node scripts/migrate-legacy-publish-tables.cjs --apply     # 执行
 */
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { LEGACY_ORPHAN_TABLES } = require("../backend/persistence/store-manifest");

const ROOT = path.join(__dirname, "..");

function readEnv() {
  const env = {};
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

async function tableExists(conn, table) {
  const [rows] = await conn.query("SHOW TABLES LIKE ?", [table]);
  return rows.length > 0;
}

(async () => {
  const apply = process.argv.includes("--apply");
  const env = readEnv();
  const conn = await mysql.createConnection({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
    connectTimeout: 8000,
    multipleStatements: true
  });

  try {
    console.log(`模式：${apply ? "APPLY（会改库）" : "DRY-RUN（只打印计划）"}\n数据库：${env.MYSQL_DATABASE}\n`);
    for (const orphan of LEGACY_ORPHAN_TABLES) {
      if (!(await tableExists(conn, orphan.table))) {
        console.log(`- ${orphan.table}: 不存在，跳过`);
        continue;
      }
      const [[countRow]] = await conn.query(`SELECT COUNT(*) AS c FROM \`${orphan.table}\``);
      console.log(`- ${orphan.table}: ${countRow.c} 行`);
      console.log(`    当前代码不读写该表（${orphan.reason}）`);
      console.log(`    计划：CREATE TABLE ${orphan.backupTable} LIKE ${orphan.table}; INSERT INTO ${orphan.backupTable} SELECT * FROM ${orphan.table}; DROP TABLE ${orphan.table};`);
      if (!apply) continue;

      await conn.query(`DROP TABLE IF EXISTS \`${orphan.backupTable}\``);
      await conn.query(`CREATE TABLE \`${orphan.backupTable}\` LIKE \`${orphan.table}\``);
      await conn.query(`INSERT INTO \`${orphan.backupTable}\` SELECT * FROM \`${orphan.table}\``);
      const [[backupRow]] = await conn.query(`SELECT COUNT(*) AS c FROM \`${orphan.backupTable}\``);
      if (Number(backupRow.c) !== Number(countRow.c)) {
        throw new Error(`备份行数不一致（原 ${countRow.c} / 备份 ${backupRow.c}），已中止，原表未删除`);
      }
      await conn.query(`DROP TABLE \`${orphan.table}\``);
      console.log(`    ✓ 已备份到 ${orphan.backupTable}（${backupRow.c} 行）并删除原表`);
    }
    console.log("\n完成。回滚方式：CREATE TABLE <原表名> LIKE <备份表>; INSERT INTO <原表名> SELECT * FROM <备份表>; DROP TABLE <备份表>;");
  } finally {
    await conn.end().catch(() => {});
  }
})().catch((error) => {
  console.error("MIGRATION_FAILED", error.code || "", error.message);
  process.exit(2);
});
