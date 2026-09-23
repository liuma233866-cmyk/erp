"use strict";

const mysql = require("mysql2/promise");
const fs = require("node:fs");
const path = require("node:path");

function readMysqlPassword(env = process.env) {
  if (env.V2_MYSQL_PASSWORD) return String(env.V2_MYSQL_PASSWORD);
  const passwordFile = String(env.V2_MYSQL_PASSWORD_FILE || env.MYSQL_PASSWORD_FILE || "").trim();
  if (passwordFile) {
    try {
      const target = path.resolve(__dirname, "..", "..", passwordFile);
      if (fs.existsSync(target)) return String(fs.readFileSync(target, "utf8")).replace(/\r?\n$/, "");
    } catch {}
  }
  return String(env.MYSQL_PASSWORD || "");
}

function buildV2PoolOptions(env = process.env) {
  return {
    host: env.V2_MYSQL_HOST || env.MYSQL_HOST || "127.0.0.1",
    port: Number(env.V2_MYSQL_PORT || env.MYSQL_PORT || 3306),
    user: env.V2_MYSQL_USER || env.MYSQL_USER || "root",
    password: readMysqlPassword(env),
    database: env.V2_MYSQL_DATABASE || env.MYSQL_DATABASE || "erp_v2",
    waitForConnections: true,
    connectionLimit: Number(env.V2_MYSQL_CONNECTION_LIMIT || 10),
    charset: "utf8mb4",
    timezone: "Z",
    dateStrings: true
  };
}

function createV2Pool(env = process.env) {
  return mysql.createPool(buildV2PoolOptions(env));
}

module.exports = { buildV2PoolOptions, createV2Pool, readMysqlPassword };
