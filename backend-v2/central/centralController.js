"use strict";

const { ERROR_CODES, V2Error, toErrorResponse } = require("../core/errorCodes");

function routeParts(pathname) {
  return String(pathname || "").split("?")[0].split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function createCentralController({ service, tenant, permission, audit } = {}) {
  if (!service || !tenant || !permission) throw new TypeError("service, tenant, and permission are required");

  return {
    async handle({ method = "GET", pathname = "/", query = {}, body = {}, user, requestId = "" } = {}) {
      try {
        const parts = routeParts(pathname);
        if (parts[0] !== "products" && parts[0] !== "collections") throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Unknown central route");
        const requestedCompanyId = query.companyId || body.companyId || "";
        const companyId = tenant.resolve(user, requestedCompanyId);
        const isWrite = method !== "GET";
        permission.require(user, isWrite ? "central.write" : "central.read");
        let result;
        if (parts[0] === "collections" && parts[1] === "items" && method === "POST") {
          result = await service.ingestCollectedItem({ ...body, companyId });
        } else if (parts[0] === "products" && parts.length === 1 && method === "GET") {
          result = { items: await service.listProducts(companyId, query) };
        } else if (parts[0] === "products" && parts.length === 1 && method === "POST") {
          result = await service.createProduct({ ...body, companyId });
        } else if (parts[0] === "products" && parts.length === 2 && method === "GET") {
          result = await service.getProduct(companyId, parts[1]);
          if (!result) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Central product not found");
        } else if (parts[0] === "products" && parts.length === 2 && method === "PATCH") {
          result = await service.updateProduct({ companyId, publicId: parts[1], expectedRowVersion: body.expectedRowVersion, patch: body.patch || body, actorId: user?.id, changeReason: body.changeReason || "manual" });
        } else if (parts[0] === "products" && parts.length === 3 && parts[2] === "variants" && method === "POST") {
          const product = await service.getProduct(companyId, parts[1]);
          if (!product) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Central product not found");
          result = await service.addVariant({ ...body, companyId, centralProductId: product.id });
        } else if (parts[0] === "products" && parts.length === 3 && parts[2] === "assets" && method === "POST") {
          const product = await service.getProduct(companyId, parts[1]);
          if (!product) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Central product not found");
          result = await service.addAsset({ ...body, companyId, centralProductId: product.id });
        } else {
          throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Unsupported central method");
        }
        if (audit) await audit.record({ requestId, companyId, actorId: user?.id, action: `${method} ${pathname}`, resourceType: "central_catalog", outcome: "success", statusCode: 200 });
        return { statusCode: 200, body: { data: result, requestId } };
      } catch (error) {
        const response = toErrorResponse(error, requestId);
        if (audit) await audit.record({ requestId, companyId: user?.companyId || user?.company_id || "", actorId: user?.id, action: `${method} ${pathname}`, resourceType: "central_catalog", outcome: "error", statusCode: response.statusCode, metadata: { errorCode: response.body.error.code } });
        return response;
      }
    }
  };
}

module.exports = { createCentralController, routeParts };
