"use strict";
// V2 发布批次与刊登占用 HTTP 控制器（挂载在 /api/v2/publish）。
//
// 路由：
//   POST /batches                          创建（或复用）发布批次
//   POST /batches/:publicId/transitions    状态迁移（body.to / body.expectedRowVersion）
//   POST /batches/:publicId/finish         由子流程状态聚合收尾（body.jobStatuses）
//   POST /claims                           获取刊登占用（唯一约束冲突时返回已有占用）
//   POST /claims/recover-expired           把租约过期的 held 转 probe_required
//   POST /claims/:id/renew                 续租
//   POST /claims/:id/probe-required        标记需要探测
//   POST /claims/:id/release               确认终态后释放
//
// 租户由 TenantAdapter 解析；写操作要求 publish.write。

const { ERROR_CODES, V2Error, toErrorResponse } = require("../core/errorCodes");
const { routeParts } = require("../central/centralController");

function createPublishController({ batchService, claimService, tenant, permission, audit } = {}) {
  if (!batchService || !claimService || !tenant || !permission) {
    throw new TypeError("batchService, claimService, tenant, and permission are required");
  }

  return {
    async handle({ method = "GET", pathname = "/", query = {}, body = {}, user, requestId = "" } = {}) {
      const action = `${method} ${pathname}`;
      // 同采集控制器：V2 审计表 action 只有 64 字符，长路径必须截断。
      const auditAction = action.slice(0, 64);
      let companyId = "";
      try {
        const parts = routeParts(pathname);
        const isWrite = method !== "GET";
        companyId = tenant.resolve(user, query.companyId || body.companyId || "");
        permission.require(user, isWrite ? "publish.write" : "publish.read");

        let result;
        if (parts[0] === "batches" && parts.length === 1 && method === "POST") {
          result = await batchService.createBatch({
            companyId,
            requestedBy: body.requestedBy ?? user?.id ?? null,
            requestedItemCount: body.requestedItemCount || 0,
            requestNamespace: body.requestNamespace,
            clientRequestId: body.clientRequestId,
            estimatedCost: body.estimatedCost || 0,
            estimatedSeconds: body.estimatedSeconds || 0
          });
        } else if (parts[0] === "batches" && parts.length === 3 && parts[2] === "transitions" && method === "POST") {
          result = await batchService.transition({
            companyId,
            batchPublicId: parts[1],
            to: body.to,
            expectedRowVersion: body.expectedRowVersion ?? null,
            patch: body.patch || {}
          });
        } else if (parts[0] === "batches" && parts.length === 3 && parts[2] === "finish" && method === "POST") {
          result = await batchService.finishBatch({
            companyId,
            batchPublicId: parts[1],
            jobStatuses: Array.isArray(body.jobStatuses) ? body.jobStatuses : [],
            jobCount: body.jobCount ?? null,
            actualCost: body.actualCost ?? null
          });
        } else if (parts[0] === "claims" && parts.length === 1 && method === "POST") {
          result = await claimService.acquire({
            companyId,
            platform: body.platform,
            shopId: body.shopId,
            businessKey: body.businessKey,
            publishJobId: body.publishJobId ?? null,
            leaseMs: body.leaseMs
          });
        } else if (parts[0] === "claims" && parts.length === 2 && parts[1] === "recover-expired" && method === "POST") {
          result = await claimService.recoverExpiredLeases();
        } else if (parts[0] === "claims" && parts.length === 3 && parts[2] === "renew" && method === "POST") {
          result = await claimService.renew({ companyId, claimId: parts[1], leaseMs: body.leaseMs });
        } else if (parts[0] === "claims" && parts.length === 3 && parts[2] === "probe-required" && method === "POST") {
          result = await claimService.markProbeRequired({ companyId, claimId: parts[1] });
        } else if (parts[0] === "claims" && parts.length === 3 && parts[2] === "release" && method === "POST") {
          result = await claimService.releaseTerminal({ companyId, claimId: parts[1] });
        } else {
          throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Unsupported publish method");
        }

        if (audit) {
          await audit.record({
            requestId, companyId, actorId: user?.id, action: auditAction, resourceType: "publish_batch", outcome: "success", statusCode: 200,
            metadata: { path: pathname }
          });
        }
        return { statusCode: 200, body: { data: result, requestId } };
      } catch (error) {
        const response = toErrorResponse(error, requestId);
        if (audit) {
          await audit.record({
            requestId, companyId, actorId: user?.id, action: auditAction, resourceType: "publish_batch",
            outcome: "error", statusCode: response.statusCode, metadata: { path: pathname, errorCode: response.body.error.code }
          });
        }
        return response;
      }
    }
  };
}

module.exports = { createPublishController };
