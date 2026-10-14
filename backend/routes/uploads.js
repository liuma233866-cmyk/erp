// 文件上传（独立模块）：POST /api/uploads  { filename?, dataUrl }  →  { url }
// 存盘位置：erp/frontend/uploads/<YYYY-MM-DD>/<随机名>.<ext>（被现有静态服务直接访问）
// 【task-18】除图片外，放开 SKU 关系导入用的表格文件：xlsx / xls / csv
"use strict";

const nodeFs = require("fs");
const nodePath = require("path");
const nodeCrypto = require("crypto");

const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_EXT_BY_MIME = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
// 【task-18】表格文件：MIME 白名单 + 文件名扩展名兜底（浏览器对 xlsx/csv 常给 application/octet-stream）
const SHEET_EXT_BY_MIME = {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "text/csv": "csv",
  "application/csv": "csv",
  "text/plain": "csv"
};
const SHEET_EXT_BY_NAME = /\.(xlsx|xls|csv)$/i;
const TYPE_MESSAGE = "只支持 png / jpg / webp / gif 图片，或 xlsx / xls / csv 表格文件";

function createUploadRoutes(deps = {}) {
  const { authService, respondApi, parseJsonBody } = deps;
  if (!authService) throw new Error("createUploadRoutes requires authService");
  if (typeof respondApi !== "function") throw new Error("createUploadRoutes requires respondApi");
  if (typeof parseJsonBody !== "function") throw new Error("createUploadRoutes requires parseJsonBody");
  const rootDir = deps.uploadDir || nodePath.join(__dirname, "..", "..", "frontend", "uploads");

  return [
    {
      matches: (pathname, method) => pathname === "/api/uploads" && method === "POST",
      handler: async (req, res, query, auditBase) => {
        const auditContext = { ...auditBase, actionType: "create", resourceType: "upload" };
        const auth = authService.requireAuth(req, res, auditContext);
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "pdev.write")) {
          respondApi(req, res, auth.user, auditContext, 403, { message: "只读账号：只有「产品开发」或「管理员」可以上传文件" });
          return;
        }
        try {
          const body = await parseJsonBody(req);
          const raw = String((body && body.dataUrl) || "");
          const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(raw);
          if (!match) { respondApi(req, res, auth.user, auditContext, 400, { message: TYPE_MESSAGE }); return; }
          const mime = String(match[1] || "").toLowerCase();
          const filename = String((body && body.filename) || "");
          // ① 图片按 MIME 白名单；② 表格再按文件名扩展名兜底（MIME 可能是 octet-stream / 空）
          let ext = IMAGE_EXT_BY_MIME[mime] || SHEET_EXT_BY_MIME[mime] || "";
          if (!ext) {
            const byName = SHEET_EXT_BY_NAME.exec(filename);
            if (byName) ext = byName[1].toLowerCase();
          }
          const buffer = Buffer.from(match[2], "base64");
          if (!ext || !buffer.length) { respondApi(req, res, auth.user, auditContext, 400, { message: TYPE_MESSAGE }); return; }
          if (buffer.length > MAX_BYTES) { respondApi(req, res, auth.user, auditContext, 413, { message: "文件超过 5MB 限制" }); return; }
          const day = new Date().toISOString().slice(0, 10);
          const dir = nodePath.join(rootDir, day);
          nodeFs.mkdirSync(dir, { recursive: true });
          const name = nodeCrypto.randomBytes(8).toString("hex") + "." + ext;
          nodeFs.writeFileSync(nodePath.join(dir, name), buffer);
          const url = "/uploads/" + day + "/" + name;
          auditContext.resourceId = url;
          respondApi(req, res, auth.user, auditContext, 201, { url, size: buffer.length });
        } catch (error) {
          respondApi(req, res, auth.user, auditContext, 500, { message: String((error && error.message) || error) });
        }
      }
    }
  ];
}

module.exports = { createUploadRoutes };
