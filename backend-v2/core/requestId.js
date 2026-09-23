"use strict";

const crypto = require("node:crypto");

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function normalizeRequestId(value) {
  const candidate = String(value || "").trim();
  return REQUEST_ID_PATTERN.test(candidate) ? candidate : "";
}

function createRequestId(prefix = "v2") {
  return `${prefix}-${crypto.randomUUID()}`;
}

function getOrCreateRequestId(request, options = {}) {
  const headerName = String(options.headerName || "x-request-id").toLowerCase();
  const headers = request?.headers || {};
  const incoming = headers[headerName] ?? headers["X-Request-Id"] ?? "";
  return normalizeRequestId(incoming) || createRequestId(options.prefix || "v2");
}

function attachRequestId(response, requestId, headerName = "X-Request-Id") {
  if (response && typeof response.setHeader === "function") {
    response.setHeader(headerName, requestId);
  }
  return requestId;
}

module.exports = {
  REQUEST_ID_PATTERN,
  normalizeRequestId,
  createRequestId,
  getOrCreateRequestId,
  attachRequestId
};
