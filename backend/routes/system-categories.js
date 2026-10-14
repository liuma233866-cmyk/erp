// 「系统类目」独立模块：自己的表、自己的接口，不依赖/不影响其它类目逻辑。
// 表：system_categories(id, name, parent_name, sort_no, enabled, note, created_at, updated_at)
"use strict";

const TABLE = "system_categories";
const DDL = `CREATE TABLE IF NOT EXISTS system_categories (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  parent_name VARCHAR(128) NULL,
  sort_no INT NOT NULL DEFAULT 0,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  note VARCHAR(512) NULL,
  created_at DATETIME(3) NULL,
  updated_at DATETIME(3) NULL,
  KEY idx_system_categories_name (name)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`;

function createSystemCategoryRoutes(deps = {}) {
  const { authService, respondApi, getSqlPool } = deps;
  if (!authService) throw new Error("createSystemCategoryRoutes requires authService");
  if (typeof respondApi !== "function") throw new Error("createSystemCategoryRoutes requires respondApi");
  // 注意：这里**不能**抛异常——否则依赖没注入时整个服务器都起不来。缺失时仅在使用时失败。
  const poolFn = typeof getSqlPool === "function" ? getSqlPool : null;

  let tableReady = null;
  async function ensureTable() {
    if (!poolFn) throw new Error("system-categories: 未注入 getSqlPool");
    if (!tableReady) tableReady = poolFn().query(DDL).catch((e) => { tableReady = null; throw e; });
    return tableReady;
  }
  const now = () => new Date();
  const toText = (v, max) => String(v === undefined || v === null ? "" : v).trim().slice(0, max);
  const toInt = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : d; };

  function rowToJson(row) {
    return {
      id: String(row.id || ""),
      name: String(row.name || ""),
      parentName: row.parent_name === null || row.parent_name === undefined ? "" : String(row.parent_name),
      sortNo: toInt(row.sort_no, 0),
      enabled: Number(row.enabled) === 1,
      note: row.note === null || row.note === undefined ? "" : String(row.note),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
    };
  }

  async function listAll() {
    await ensureTable();
    const [rows] = await poolFn().query(`SELECT * FROM ${TABLE} ORDER BY sort_no ASC, name ASC`);
    return (Array.isArray(rows) ? rows : []).map(rowToJson);
  }

  return [
    {
      matches: (pathname, method) => pathname === "/api/system-categories" && (method === "GET" || method === "POST"),
      handler: async (req, res, query, auditBase, pathname) => {
        const isWrite = req.method === "POST";
        const auditContext = { ...auditBase, actionType: isWrite ? "create" : "read", resourceType: "system_category" };
        const auth = authService.requireAuth(req, res, auditContext);
        if (!auth.ok) return;
        if (isWrite && !authService.checkPermission(auth.user, "pdev.write")) {
          respondApi(req, res, auth.user, auditContext, 403, { message: "只读账号：只有「产品开发」或「管理员」可以维护系统类目" });
          return;
        }
        try {
          if (!isWrite) { respondApi(req, res, auth.user, auditContext, 200, { items: await listAll() }); return; }
          const body = await deps.parseJsonBody(req);
          const name = toText(body && body.name, 128);
          if (!name) { respondApi(req, res, auth.user, auditContext, 400, { message: "名称必填" }); return; }
          await ensureTable();
          const id = "SC-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
          const ts = now();
          await poolFn().execute(
            `INSERT INTO ${TABLE} (id, name, parent_name, sort_no, enabled, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
            [id, name, toText(body.parentName, 128) || null, toInt(body.sortNo, 0), body.enabled === false ? 0 : 1, toText(body.note, 512) || null, ts, ts]
          );
          auditContext.resourceId = id;
          const [rows] = await poolFn().query(`SELECT * FROM ${TABLE} WHERE id = ?`, [id]);
          respondApi(req, res, auth.user, auditContext, 201, { item: rowToJson(rows && rows[0]) });
        } catch (error) {
          respondApi(req, res, auth.user, auditContext, 500, { message: String((error && error.message) || error) });
        }
      }
    },
    {
      matches: (pathname, method) => /^\/api\/system-categories\/[^/]+$/.test(String(pathname || "")) && (method === "PUT" || method === "DELETE"),
      handler: async (req, res, query, auditBase, pathname) => {
        const id = decodeURIComponent(String(pathname).split("/").pop() || "");
        const auditContext = { ...auditBase, actionType: req.method === "PUT" ? "update" : "delete", resourceType: "system_category", resourceId: id };
        const auth = authService.requireAuth(req, res, auditContext);
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "pdev.write")) {
          respondApi(req, res, auth.user, auditContext, 403, { message: "只读账号：只有「产品开发」或「管理员」可以维护系统类目" });
          return;
        }
        try {
          await ensureTable();
          const [exists] = await poolFn().query(`SELECT id FROM ${TABLE} WHERE id = ?`, [id]);
          if (!exists || !exists.length) { respondApi(req, res, auth.user, auditContext, 404, { message: "系统类目不存在" }); return; }
          if (req.method === "DELETE") {
            await poolFn().execute(`DELETE FROM ${TABLE} WHERE id = ?`, [id]);
            respondApi(req, res, auth.user, auditContext, 200, { removed: true });
            return;
          }
          const body = await deps.parseJsonBody(req);
          const name = toText(body && body.name, 128);
          if (!name) { respondApi(req, res, auth.user, auditContext, 400, { message: "名称必填" }); return; }
          await poolFn().execute(
            `UPDATE ${TABLE} SET name = ?, parent_name = ?, sort_no = ?, enabled = ?, note = ?, updated_at = ? WHERE id = ?`,
            [name, toText(body.parentName, 128) || null, toInt(body.sortNo, 0), body.enabled === false ? 0 : 1, toText(body.note, 512) || null, now(), id]
          );
          const [rows] = await poolFn().query(`SELECT * FROM ${TABLE} WHERE id = ?`, [id]);
          respondApi(req, res, auth.user, auditContext, 200, { item: rowToJson(rows && rows[0]) });
        } catch (error) {
          respondApi(req, res, auth.user, auditContext, 500, { message: String((error && error.message) || error) });
        }
      }
    }
  ];
}

module.exports = { createSystemCategoryRoutes };
