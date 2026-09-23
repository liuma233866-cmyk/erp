"use strict";

const ERROR_CODES = Object.freeze({
  AUTH_REQUIRED: "V2_AUTH_REQUIRED",
  AUTH_INVALID: "V2_AUTH_INVALID",
  TENANT_REQUIRED: "V2_TENANT_REQUIRED",
  TENANT_FORBIDDEN: "V2_TENANT_FORBIDDEN",
  PERMISSION_DENIED: "V2_PERMISSION_DENIED",
  VALIDATION_FAILED: "V2_VALIDATION_FAILED",
  IDEMPOTENCY_CONFLICT: "V2_IDEMPOTENCY_CONFLICT",
  CLAIM_CONFLICT: "V2_CLAIM_CONFLICT",
  ROW_VERSION_CONFLICT: "V2_ROW_VERSION_CONFLICT",
  DUPLICATE_SOURCE: "V2_DUPLICATE_SOURCE",
  MIGRATION_CHECKSUM_MISMATCH: "V2_MIGRATION_CHECKSUM_MISMATCH",
  MIGRATION_ORDER_INVALID: "V2_MIGRATION_ORDER_INVALID",
  INTERNAL_ERROR: "V2_INTERNAL_ERROR"
});

const STATUS_BY_CODE = Object.freeze({
  [ERROR_CODES.AUTH_REQUIRED]: 401,
  [ERROR_CODES.AUTH_INVALID]: 401,
  [ERROR_CODES.TENANT_REQUIRED]: 400,
  [ERROR_CODES.TENANT_FORBIDDEN]: 403,
  [ERROR_CODES.PERMISSION_DENIED]: 403,
  [ERROR_CODES.VALIDATION_FAILED]: 400,
  [ERROR_CODES.IDEMPOTENCY_CONFLICT]: 409,
  [ERROR_CODES.CLAIM_CONFLICT]: 409,
  [ERROR_CODES.ROW_VERSION_CONFLICT]: 409,
  [ERROR_CODES.DUPLICATE_SOURCE]: 409,
  [ERROR_CODES.MIGRATION_CHECKSUM_MISMATCH]: 500,
  [ERROR_CODES.MIGRATION_ORDER_INVALID]: 500,
  [ERROR_CODES.INTERNAL_ERROR]: 500
});

class V2Error extends Error {
  constructor(code, message, details = undefined, options = {}) {
    super(message);
    this.name = "V2Error";
    this.code = code;
    this.details = details;
    this.statusCode = options.statusCode || STATUS_BY_CODE[code] || 500;
    this.expose = options.expose !== false;
    if (options.cause) this.cause = options.cause;
  }
}

function toErrorResponse(error, requestId = "") {
  const known = error instanceof V2Error;
  const code = known ? error.code : ERROR_CODES.INTERNAL_ERROR;
  const message = known && error.expose ? error.message : "Internal server error";
  return {
    statusCode: known ? error.statusCode : 500,
    body: {
      error: {
        code,
        message,
        ...(known && error.details !== undefined ? { details: error.details } : {}),
        requestId: String(requestId || "")
      }
    }
  };
}

module.exports = {
  ERROR_CODES,
  STATUS_BY_CODE,
  V2Error,
  toErrorResponse
};
