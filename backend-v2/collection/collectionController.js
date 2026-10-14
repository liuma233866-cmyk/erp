"use strict";
// V2 采集批次 HTTP 控制器（挂载在 /api/v2/collection）。
//
// 路由：
//   POST /batches                                  开启（或复用）采集批次
//   GET  /batches/:publicId                        批次详情 + 项目
//   POST /batches/:publicId/items                  投递一个采集项目
//   POST /batches/:publicId/items/:itemId/succeeded
//   POST /batches/:publicId/items/:itemId/failed
//   POST /batches/:publicId/finish                 收尾（聚合批次状态）
//
// 与 central 控制器一致：租户由 TenantAdapter 解析，写操作要求 collection.write。

const { ERROR_CODES, V2Error, toErrorResponse } = require("../core/errorCodes");
const { routeParts } = require("../central/centralController");

function createCollectionController({ service, tenant, permission, audit } = {}) {
  if (!service || !tenant || !permission) throw new TypeError("service, tenant, and permission are required");

  return {
    async handle({ method = "GET", pathname = "/", query = {}, body = {}, user, requestId = "" } = {}) {
      const action = `${method} ${pathname}`;
      // v2_audit_logs.action 是 VARCHAR(64)：长路径（含批次号与项目 id）必须截断，
      // 否则审计插入会因 "Data too long" 抛错，把已经成功的业务调用变成 500。
      const auditAction = action.slice(0, 64);
      let companyId = "";
      try {
        const parts = routeParts(pathname);
        if (parts[0] !== "batches") throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Unknown collection route");
        const isWrite = method !== "GET";
        companyId = tenant.resolve(user, query.companyId || body.companyId || "");
        permission.require(user, isWrite ? "collection.write" : "collection.read");

        let result;
        if (parts.length === 1 && method === "POST") {
          result = await service.openBatch({
            companyId,
            source: body.source,
            requestedBy: body.requestedBy ?? user?.id ?? null,
            requestNamespace: body.requestNamespace,
            requestId: body.requestId
          });
        } else if (parts.length === 2 && method === "GET") {
          result = await service.getBatchSummary({ companyId, batchPublicId: parts[1] });
        } else if (parts.length === 3 && parts[2] === "items" && method === "POST") {
          result = await service.addItem({
            companyId,
            batchPublicId: parts[1],
            sourcePlatform: body.sourcePlatform,
            sourceProductId: body.sourceProductId,
            rawPayload: body.rawPayload || {}
          });
        } else if (parts.length === 5 && parts[2] === "items" && parts[4] === "succeeded" && method === "POST") {
          result = await service.markItemSucceeded({
            companyId, batchPublicId: parts[1], itemId: parts[3], centralProductId: body.centralProductId ?? null
          });
        } else if (parts.length === 5 && parts[2] === "items" && parts[4] === "failed" && method === "POST") {
          result = await service.markItemFailed({
            companyId, batchPublicId: parts[1], itemId: parts[3], errorCode: body.errorCode ?? null, errorMessage: body.errorMessage || ""
          });
        } else if (parts.length === 3 && parts[2] === "finish" && method === "POST") {
          result = await service.finishBatch({ companyId, batchPublicId: parts[1] });
        } else {
          throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Unsupported collection method");
        }

        if (audit) {
          await audit.record({
            requestId, companyId, actorId: user?.id, action: auditAction, resourceType: "collection_batch", outcome: "success", statusCode: 200,
            metadata: { path: pathname }
          });
        }
        return { statusCode: 200, body: { data: result, requestId } };
      } catch (error) {
        const response = toErrorResponse(error, requestId);
        if (audit) {
          await audit.record({
            requestId, companyId, actorId: user?.id, action: auditAction, resourceType: "collection_batch",
            outcome: "error", statusCode: response.statusCode, metadata: { path: pathname, errorCode: response.body.error.code }
          });
        }
        return response;
      }
    }
  };
}

module.exports = { createCollectionController };
