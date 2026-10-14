"use strict";

const http = require("node:http");
const { URL } = require("node:url");
const { ERROR_CODES, V2Error, toErrorResponse } = require("../core/errorCodes");
const { getOrCreateRequestId, attachRequestId } = require("../core/requestId");
const { createSecurityAdapters } = require("../security");
const { AuditLogger } = require("../audit/auditLogger");
const { MySqlAuditSink } = require("../audit/mysqlAuditSink");
const { MysqlCentralCatalogRepository } = require("../central/mysqlCatalogRepository");
const { CentralCatalogService } = require("../central/catalogService");
const { createCentralController } = require("../central/centralController");
const { MysqlCollectionRepository } = require("../collection/mysqlCollectionRepository");
const { CollectionBatchService } = require("../collection/collectionBatchService");
const { createCollectionController } = require("../collection/collectionController");
const { MysqlPublishRepository } = require("../publish/mysqlPublishRepository");
const { PublishBatchService } = require("../publish/publishBatchService");
const { PublishClaimService } = require("../publish/publishClaimService");
const { createPublishController } = require("../publish/publishController");

function readJsonBody(request, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        reject(new V2Error(ERROR_CODES.VALIDATION_FAILED, "Request body is too large"));
        request.destroy();
        return;
      }
      raw += chunk;
    });
    request.on("end", () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new V2Error(ERROR_CODES.VALIDATION_FAILED, "Request body must be valid JSON")); }
    });
    request.on("error", reject);
  });
}

function sendJson(response, result, requestId) {
  const statusCode = result.statusCode || 200;
  const body = JSON.stringify(result.body || {});
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  attachRequestId(response, requestId);
  response.end(body);
}

// 按最长前缀匹配挂载点，未命中返回 null。prefix 末尾斜杠会被归一化。
function pickMount(mounts, pathname) {
  let best = null;
  for (const mount of mounts) {
    const prefix = String(mount?.prefix || "").replace(/\/+$/, "");
    if (!prefix) continue;
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, controller: mount.controller };
  }
  return best;
}

function createV2Handler({ auth, controller, routes, maxBodyBytes } = {}) {
  const mounts = Array.isArray(routes) && routes.length
    ? routes.map((route) => ({ prefix: route.prefix, controller: route.controller }))
    : (controller ? [{ prefix: "/api/v2/central", controller }] : []);
  if (!auth || !mounts.length) throw new TypeError("auth and at least one route mount are required");
  for (const mount of mounts) {
    if (!mount.controller) throw new TypeError(`Route mount ${mount.prefix} has no controller`);
  }
  return async function v2Handler(request, response) {
    const requestId = getOrCreateRequestId(request);
    attachRequestId(response, requestId);
    try {
      const user = await auth.authenticate(request);
      const url = new URL(request.url || "/", "http://v2.local");
      const mount = pickMount(mounts, url.pathname);
      if (!mount) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Unknown V2 route");
      const pathname = url.pathname.slice(mount.prefix.length) || "/";
      const result = await mount.controller.handle({
        method: request.method,
        pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        body: await readJsonBody(request, maxBodyBytes),
        user,
        requestId
      });
      sendJson(response, result, requestId);
    } catch (error) {
      sendJson(response, toErrorResponse(error, requestId), requestId);
    }
  };
}

function createV2Application({ pool, verifyToken, resolveCompanyId, resolvePermissions, permissions, clock } = {}) {
  if (!pool) throw new TypeError("A V2 mysql pool is required");
  const security = createSecurityAdapters({ verifyToken, resolveCompanyId, resolvePermissions, permissions });
  const repository = new MysqlCentralCatalogRepository({ pool });
  const service = new CentralCatalogService({ repository, clock });
  const audit = new AuditLogger({ sink: new MySqlAuditSink({ pool }), clock });
  const controller = createCentralController({ service, tenant: security.tenant, permission: security.permission, audit });

  const collectionService = new CollectionBatchService({ repository: new MysqlCollectionRepository({ pool }), clock });
  const collectionController = createCollectionController({
    service: collectionService, tenant: security.tenant, permission: security.permission, audit
  });

  const publishRepository = new MysqlPublishRepository({ pool });
  const publishBatchService = new PublishBatchService({ repository: publishRepository, clock });
  const publishClaimService = new PublishClaimService({ repository: publishRepository, clock });
  const publishController = createPublishController({
    batchService: publishBatchService, claimService: publishClaimService,
    tenant: security.tenant, permission: security.permission, audit
  });

  const routes = [
    { prefix: "/api/v2/central", controller },
    { prefix: "/api/v2/collection", controller: collectionController },
    { prefix: "/api/v2/publish", controller: publishController }
  ];
  const handler = createV2Handler({ auth: security.auth, routes });
  return {
    security, repository, service, controller, routes, handler,
    collectionService, collectionController,
    publishBatchService, publishClaimService, publishController,
    server: http.createServer(handler)
  };
}

module.exports = { createV2Handler, createV2Application, pickMount, readJsonBody, sendJson };

