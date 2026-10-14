#!/usr/bin/env node
"use strict";
/**
 * 持久化分歧检查：按 backend/persistence/store-manifest.js 的归属清单核对实际库。
 *
 * 检查项：
 *   1. 有专用表的实体不得同时出现在 AppState 快照里（出现即为双轨隐患）；
 *   2. 孤儿遗留表是否存在、是否还挂着旧数据；
 *   3. AppState 快照体积与各集合大小（提醒整块重写成本）。
 *
 * 用法：node scripts/persistence-divergence.cjs [--json logs/persistence-divergence.json]
 * 退出码：0 = 无分歧；1 = 发现分歧。
 */
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { TABLE_OWNED_ENTITIES, APPSTATE_OWNED_ENTITIES, LEGACY_ORPHAN_TABLES } = require("../backend/persistence/store-manifest");

const ROOT = path.join(__dirname, "..");

function parseArgs(argv) {
  const args = { json: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") { args.json = argv[i + 1]; i += 1; }
  }
  return args;
}

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

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const env = readEnv();
  const findings = [];
  const advisories = [];
  const conn = await mysql.createConnection({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
    connectTimeout: 8000
  });

  try {
    const [tables] = await conn.query("SHOW TABLES");
    const tableNames = new Set(tables.map((row) => Object.values(row)[0]));
    const [stateRows] = await conn.query("SELECT stateKey, stateJson FROM appstate");
    const snapshotByKey = new Map();
    for (const row of stateRows) {
      try { snapshotByKey.set(row.stateKey, JSON.parse(row.stateJson || "{}")); } catch { snapshotByKey.set(row.stateKey, {}); }
    }

    console.log("== 归属清单核对 ==");
    for (const entity of TABLE_OWNED_ENTITIES) {
      const inSnapshot = [];
      for (const [stateKey, snapshot] of snapshotByKey) {
        if (Array.isArray(snapshot[entity.key]) && snapshot[entity.key].length) inSnapshot.push(`${stateKey}(${snapshot[entity.key].length})`);
      }
      const hasTable = tableNames.has(entity.table);
      let tableCount = "-";
      if (hasTable) {
        const [[row]] = await conn.query(`SELECT COUNT(*) AS c FROM \`${entity.table}\``);
        tableCount = row.c;
      }
      const status = hasTable ? "OK" : "MISSING_TABLE";
      if (inSnapshot.length) {
        findings.push(`${entity.key} 同时存在于 AppState（${inSnapshot.join(", ")}）与专用表 ${entity.table}`);
      }
      console.log(`  ${entity.key.padEnd(24)} 表 ${entity.table.padEnd(22)} ${status.padEnd(14)} 行数=${String(tableCount).padEnd(6)} writeMode=${entity.writeMode.padEnd(9)} AppState=${inSnapshot.length ? inSnapshot.join(",") : "无"}`);
    }

    console.log("\n== AppState 快照概况 ==");
    for (const [stateKey, snapshot] of snapshotByKey) {
      const arrays = Object.entries(snapshot).filter(([, value]) => Array.isArray(value)).map(([key, value]) => `${key}=${value.length}`);
      console.log(`  ${stateKey}: 数组集合 ${arrays.length ? arrays.join(", ") : "（无）"}`);
      for (const entity of APPSTATE_OWNED_ENTITIES) {
        if (snapshot[entity.key] === undefined) continue;
        const value = snapshot[entity.key];
        console.log(`    ${entity.key} = ${Array.isArray(value) ? `${value.length} 条` : typeof value === "object" && value ? "对象" : String(value)}`);
      }
      // 体积主因：整块重写的成本由最大的键决定。
      const sized = Object.entries(snapshot)
        .map(([key, value]) => {
          let bytes = 0;
          try { bytes = JSON.stringify(value ?? null).length; } catch { bytes = -1; }
          return { key, bytes };
        })
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 5);
      console.log(`    体积占比最大的键: ${sized.map((entry) => `${entry.key}=${(entry.bytes / 1024).toFixed(1)}KB`).join(", ")}`);
    }

    console.log("\n== 历史遗留孤儿表 ==");
    const orphansPresent = [];
    for (const orphan of LEGACY_ORPHAN_TABLES) {
      if (!tableNames.has(orphan.table)) {
        console.log(`  ${orphan.table.padEnd(20)} 已不存在（已清理）`);
        continue;
      }
      const [[row]] = await conn.query(`SELECT COUNT(*) AS c FROM \`${orphan.table}\``);
      orphansPresent.push(orphan.table);
      console.log(`  ${orphan.table.padEnd(20)} 仍存在，${row.c} 行（应替换为 ${orphan.replacedBy}；${orphan.reason}）`);
      findings.push(`孤儿表 ${orphan.table} 仍存在（${row.c} 行），与 ${orphan.replacedBy} 构成双轨`);
    }

    const [[stateSize]] = await conn.query("SELECT SUM(LENGTH(stateJson)) AS bytes FROM appstate");
    console.log(`\n  AppState 总字节 = ${stateSize.bytes ?? 0}（每次 saveDatabase() 整块重写）`);
    if (Number(stateSize.bytes || 0) > 5 * 1024 * 1024) {
      advisories.push(`AppState 快照 ${Math.round(Number(stateSize.bytes) / 1024 / 1024)}MB，每次写入整块重写，建议继续把大集合移出快照`);
    }

    const report = {
      checkedAt: new Date().toISOString(),
      database: env.MYSQL_DATABASE,
      findings,
      advisories
    };
    if (args.json) {
      fs.mkdirSync(path.dirname(args.json), { recursive: true });
      fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
      console.log(`\n报告：${path.relative(ROOT, args.json)}`);
    }

    console.log("\n== 结论 ==");
    if (!findings.length) console.log("  未发现双轨分歧。");
    else for (const finding of findings) console.log(`  - 分歧：${finding}`);
    for (const advisory of advisories) console.log(`  - 建议：${advisory}`);
    process.exitCode = findings.length ? 1 : 0;
  } finally {
    await conn.end().catch(() => {});
  }
})().catch((error) => {
  console.error("DIVERGENCE_CHECK_FAILED", error.code || "", error.message);
  process.exit(2);
});
