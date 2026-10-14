"use strict";

// 产品开发库（product-dev）路由注册表：契约 §5 的 13 个接口。
//
// 形式与 erp/backend/routes/*.js 一致：createPdevRoutes(deps) 返回
// [{ matches(pathname, method), handler(req, res, query, auditBase, pathname, url) }]。
// handler 内自己 requireAuth + respondApi；审计由现有 /api/* 层自动覆盖，这里不自己写审计。
// PdevError → HTTP 状态码的映射在本文件完成；routes 只做编排，不在内部自建 service（§9.8）。

const RESOURCE_TYPE = "product_dev";

const PRODUCTS_PATTERN = /^\/api\/product-dev\/products$/;
const SUMMARY_PATTERN = /^\/api\/product-dev\/summary$/;
const PRODUCT_PATTERN = /^\/api\/product-dev\/products\/([^/]+)$/;
const PRODUCT_SOURCES_PATTERN = /^\/api\/product-dev\/products\/([^/]+)\/sources$/;
const PRODUCT_ASSETS_PATTERN = /^\/api\/product-dev\/products\/([^/]+)\/assets$/;
const PRODUCT_VARIANTS_PATTERN = /^\/api\/product-dev\/products\/([^/]+)\/variants$/;
const PRODUCT_STATUS_PATTERN = /^\/api\/product-dev\/products\/([^/]+)\/status$/;
const SOURCE_PATTERN = /^\/api\/product-dev\/sources\/([^/]+)$/;
const ASSET_PATTERN = /^\/api\/product-dev\/assets\/([^/]+)$/;

function decodeParam(value) {
  try {
    return decodeURIComponent(String(value ?? ""));
  } catch {
    return String(value ?? "");
  }
}

function createPdevRoutes(deps = {}) {
  const { pdevService, authService, respondApi, parseJsonBody } = deps;
  // 商品日志接口要用：读审计日志 + 脱敏（与 /api/audit-logs 用的是同一套实现）。
  const getDb = typeof deps.getDb === "function" ? deps.getDb : () => null;
  const sanitizeAuditLogForClient = typeof deps.sanitizeAuditLogForClient === "function"
    ? deps.sanitizeAuditLogForClient
    : (log) => log;
  // 审计条目是增量写 MySQL 的，内存里的 db.auditLogs 只有「本次进程运行期间」的条目 ✗
  // 所以查历史日志必须走 auditStore.loadRecent()（它从 audit_logs 表读）。
  const auditStore = deps.auditStore || null;
  const maskSensitive = typeof deps.maskSensitive === "function" ? deps.maskSensitive : (value) => value;

  if (!pdevService) {
    throw new Error("createPdevRoutes requires pdevService");
  }
  if (!authService || typeof authService.requireAuth !== "function") {
    throw new Error("createPdevRoutes requires authService with requireAuth()");
  }
  if (typeof respondApi !== "function") {
    throw new Error("createPdevRoutes requires respondApi");
  }
  if (typeof parseJsonBody !== "function") {
    throw new Error("createPdevRoutes requires parseJsonBody");
  }

  // PdevError → HTTP；非业务异常一律 500 且不泄露内部信息。
  function respondError(req, res, actor, auditContext, error) {
    const statusCode = Number(error?.statusCode);
    if (Number.isFinite(statusCode) && statusCode >= 400 && statusCode < 600) {
      const body = { message: String(error?.message || "Request failed") };
      if (Array.isArray(error.missing)) body.missing = error.missing;
      const publicId = error?.details?.publicId || error?.publicId;
      if (publicId) body.publicId = String(publicId);
      respondApi(req, res, actor, auditContext, statusCode, body);
      return;
    }
    console.error(`[product-dev] ${String(error?.stack || error)}`);
    respondApi(req, res, actor, auditContext, 500, { message: "Internal error" });
  }

  async function readBody(req, res, actor, auditContext) {
    try {
      const body = await parseJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return {};
      return body;
    } catch (error) {
      const tooLarge = Number(error?.statusCode) === 413;
      respondApi(req, res, actor, auditContext, tooLarge ? 413 : 400, {
        message: tooLarge ? "Request body is too large" : "Invalid JSON body"
      });
      return null;
    }
  }

  function defineRoute({ method, pattern, actionType, needsBody = false, run }) {
    const match = (pathname) => pattern.exec(String(pathname || ""));
    return {
      matches: (pathname, requestMethod) => requestMethod === method && match(pathname) !== null,
      handler: async (req, res, query, auditBase, pathname) => {
        const matched = match(pathname);
        const pathParam = matched && matched[1] !== undefined ? decodeParam(matched[1]) : "";
        const auditContext = {
          ...auditBase,
          actionType,
          resourceType: RESOURCE_TYPE,
          resourceId: pathParam
        };
        const auth = authService.requireAuth(req, res, auditContext);
        if (!auth.ok) return;
        // 写操作（非 read）需要 pdev.write：只有「产品开发」与「管理员」有，运营等角色只读。
        // 必须在服务端拦——只在前端藏按钮不构成权限（绕过前端照样能改）。
        if (actionType !== "read" && !authService.checkPermission(auth.user, "pdev.write")) {
          respondApi(req, res, auth.user, auditContext, 403, {
            message: "只读账号：只有「产品开发」或「管理员」可以修改商品管理"
          });
          return;
        }

        let body = null;
        if (needsBody) {
          body = await readBody(req, res, auth.user, auditContext);
          if (body === null) return;
          auditContext.requestBodyMasked = maskSensitive(body);
        }

        try {
          const outcome = await run({
            req,
            res,
            query: query || {},
            user: auth.user,
            body,
            pathParam,
            pathname,
            auditContext
          });
          respondApi(req, res, auth.user, auditContext, Number(outcome?.status) || 200, outcome?.result);
        } catch (error) {
          respondError(req, res, auth.user, auditContext, error);
        }
      }
    };
  }

  return [
    // 14) GET /api/product-dev/products/:publicId/logs
    //     该商品的编辑日志。**只要登录就能看**（需求：日志所有人可看）——不要求 pdev.write。
    //     公司隔离：先按调用者的公司取一次商品，取不到即 404（与详情一致，不泄露其它公司是否存在）。
    {
      matches: (pathname, method) => method === "GET" && /^\/api\/product-dev\/products\/([^/]+)\/logs$/.test(String(pathname || "")),
      handler: async (req, res, query, auditBase, pathname) => {
        const matched = /^\/api\/product-dev\/products\/([^/]+)\/logs$/.exec(String(pathname || ""));
        const publicId = decodeParam(matched && matched[1]);
        const auditContext = { ...auditBase, actionType: "read", resourceType: RESOURCE_TYPE, resourceId: publicId };
        const auth = authService.requireAuth(req, res, auditContext);
        if (!auth.ok) return;
        try {
          await pdevService.getProduct({ user: auth.user, publicId });
          const db = getDb();
          const fromTable = auditStore && typeof auditStore.loadRecent === "function"
            ? await auditStore.loadRecent(20000)
            : null;
          const all = Array.isArray(fromTable)
            ? fromTable
            : (db && Array.isArray(db.auditLogs) ? db.auditLogs : []);
          const items = all
            .filter((log) => String((log && log.resourceType) || "") === RESOURCE_TYPE
              && String((log && log.resourceId) || "") === String(publicId)
              // 只列「编辑动作」：read 是查看（含未授权的探测），不属于编辑日志；全量日志在管理员的面板里
              && String((log && log.actionType) || "") !== "read")
            .slice(-300)
            .reverse()
            .map((log) => sanitizeAuditLogForClient(log));
          respondApi(req, res, auth.user, auditContext, 200, { publicId, items });
        } catch (error) {
          respondError(req, res, auth.user, auditContext, error);
        }
      }
    },
    // 1) GET /api/product-dev/products
    defineRoute({
      method: "GET",
      pattern: PRODUCTS_PATTERN,
      actionType: "read",
      run: async ({ user, query }) => ({
        status: 200,
        result: await pdevService.listProducts({
          user,
          devStatus: query.devStatus,
          q: query.q,
          missing: query.missing,
          page: query.page,
          pageSize: query.pageSize
        })
      })
    }),

    // 2) POST /api/product-dev/products
    defineRoute({
      method: "POST",
      pattern: PRODUCTS_PATTERN,
      actionType: "create",
      needsBody: true,
      run: async ({ user, body, auditContext }) => {
        const result = await pdevService.createProduct({ ...body, user });
        if (result && result.product) auditContext.resourceId = String(result.product.publicId || "");
        return { status: 201, result };
      }
    }),

    // 13) GET /api/product-dev/summary（静态路径，避免与参数化路径歧义）
    defineRoute({
      method: "GET",
      pattern: SUMMARY_PATTERN,
      actionType: "read",
      run: async ({ user }) => ({ status: 200, result: await pdevService.getSummary({ user }) })
    }),

    // 3) GET /api/product-dev/products/:publicId
    defineRoute({
      method: "GET",
      pattern: PRODUCT_PATTERN,
      actionType: "read",
      run: async ({ user, pathParam }) => ({
        status: 200,
        result: await pdevService.getProduct({ user, publicId: pathParam })
      })
    }),

    // 4) PATCH /api/product-dev/products/:publicId
    defineRoute({
      method: "PATCH",
      pattern: PRODUCT_PATTERN,
      actionType: "update",
      needsBody: true,
      run: async ({ user, body, pathParam, auditContext }) => {
        const result = await pdevService.updateProduct({ ...body, user, publicId: pathParam });
        if (result && result.product) auditContext.resourceId = String(result.product.publicId || "");
        return { status: 200, result };
      }
    }),

    // 5) DELETE /api/product-dev/products/:publicId
    defineRoute({
      method: "DELETE",
      pattern: PRODUCT_PATTERN,
      actionType: "delete",
      run: async ({ user, pathParam }) => ({
        status: 200,
        result: await pdevService.deleteProduct({ user, publicId: pathParam })
      })
    }),

    // 6) POST /api/product-dev/products/:publicId/sources
    defineRoute({
      method: "POST",
      pattern: PRODUCT_SOURCES_PATTERN,
      actionType: "create",
      needsBody: true,
      run: async ({ user, body, pathParam, auditContext }) => {
        const result = await pdevService.addSource({ ...body, user, publicId: pathParam });
        if (result && result.source) auditContext.resourceId = `${pathParam}#source:${result.source.id}`;
        return { status: 201, result };
      }
    }),

    // 7) PATCH /api/product-dev/sources/:id
    defineRoute({
      method: "PATCH",
      pattern: SOURCE_PATTERN,
      actionType: "update",
      needsBody: true,
      run: async ({ user, body, pathParam, auditContext }) => {
        const result = await pdevService.updateSource({ ...body, user, id: pathParam });
        if (result && result.source) auditContext.resourceId = String(result.source.id);
        return { status: 200, result };
      }
    }),

    // 8) DELETE /api/product-dev/sources/:id
    defineRoute({
      method: "DELETE",
      pattern: SOURCE_PATTERN,
      actionType: "delete",
      run: async ({ user, pathParam }) => ({
        status: 200,
        result: await pdevService.deleteSource({ user, id: pathParam })
      })
    }),

    // 9) POST /api/product-dev/products/:publicId/assets
    defineRoute({
      method: "POST",
      pattern: PRODUCT_ASSETS_PATTERN,
      actionType: "create",
      needsBody: true,
      run: async ({ user, body, pathParam, auditContext }) => {
        const result = await pdevService.addAsset({ ...body, user, publicId: pathParam });
        if (result && result.asset) auditContext.resourceId = `${pathParam}#asset:${result.asset.id}`;
        return { status: 201, result };
      }
    }),

    // 10) DELETE /api/product-dev/assets/:id
    defineRoute({
      method: "DELETE",
      pattern: ASSET_PATTERN,
      actionType: "delete",
      run: async ({ user, pathParam }) => ({
        status: 200,
        result: await pdevService.deleteAsset({ user, id: pathParam })
      })
    }),

    // 11) POST /api/product-dev/products/:publicId/variants
    defineRoute({
      method: "POST",
      pattern: PRODUCT_VARIANTS_PATTERN,
      actionType: "create",
      needsBody: true,
      run: async ({ user, body, pathParam, auditContext }) => {
        const result = await pdevService.addVariant({ ...body, user, publicId: pathParam });
        if (result && result.variant) auditContext.resourceId = `${pathParam}#variant:${result.variant.id}`;
        return { status: 201, result };
      }
    }),

    // 12) POST /api/product-dev/products/:publicId/status
    defineRoute({
      method: "POST",
      pattern: PRODUCT_STATUS_PATTERN,
      actionType: "update",
      needsBody: true,
      run: async ({ user, body, pathParam, auditContext }) => {
        const result = await pdevService.changeStatus({ ...body, user, publicId: pathParam });
        if (result && result.product) auditContext.resourceId = String(result.product.publicId || "");
        return { status: 200, result };
      }
    })
  ];
}

module.exports = { createPdevRoutes };
