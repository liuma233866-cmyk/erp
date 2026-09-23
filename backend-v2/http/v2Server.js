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

function createV2Handler({ auth, controller, maxBodyBytes } = {}) {
  if (!auth || !controller) throw new TypeError("auth and controller are required");
  return async function v2Handler(request, response) {
    const requestId = getOrCreateRequestId(request);
    attachRequestId(response, requestId);
    try {
      const user = await auth.authenticate(request);
      const url = new URL(request.url || "/", "http://v2.local");
      const prefix = "/api/v2/central";
      if (!url.pathname.startsWith(prefix)) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Unknown V2 route");
      const pathname = url.pathname.slice(prefix.length) || "/";
      const result = await controller.handle({
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
  const handler = createV2Handler({ auth: security.auth, controller });
  return { security, repository, service, controller, handler, server: http.createServer(handler) };
}

module.exports = { createV2Handler, createV2Application, readJsonBody, sendJson };

