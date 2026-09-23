"use strict";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "token",
  "access_token",
  "apikey",
  "api_key",
  "secret",
  "password",
  "requestjson",
  "responsejson"
]);

function maskValue(value, depth = 0) {
  if (depth > 4) return "[masked-depth]";
  if (Array.isArray(value)) return value.map((item) => maskValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEYS.has(key.toLowerCase()) ? "[masked]" : maskValue(item, depth + 1)
  ]));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

class AuditLogger {
  constructor({ sink, clock = () => new Date() } = {}) {
    this.sink = sink || { write: async () => undefined };
    this.clock = clock;
  }

  async record(event) {
    const entry = deepFreeze({
      occurredAt: this.clock().toISOString(),
      requestId: String(event?.requestId || ""),
      companyId: String(event?.companyId || ""),
      actorId: String(event?.actorId || ""),
      action: String(event?.action || ""),
      resourceType: String(event?.resourceType || ""),
      resourceId: String(event?.resourceId || ""),
      outcome: String(event?.outcome || "success"),
      statusCode: Number(event?.statusCode || 200),
      metadata: maskValue(event?.metadata || {})
    });
    await this.sink.write(entry);
    return entry;
  }
}

module.exports = { AuditLogger, maskValue, deepFreeze };
