"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createV2Pool } = require("../db/pool");
const { runMigrations } = require("./migrationRunner");

function loadProjectEnv() {
  const filePath = path.resolve(__dirname, "..", "..", ".env");
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0 || line.trim().startsWith("#")) continue;
    const key = line.slice(0, index).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

async function main() {
  loadProjectEnv();
  const pool = createV2Pool();
  try {
    const result = await runMigrations(pool);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const code = error.code ? `${error.code}: ` : "";
  process.stderr.write(`${code}${error.stack || error.message}\n`);
  process.exitCode = 1;
});
