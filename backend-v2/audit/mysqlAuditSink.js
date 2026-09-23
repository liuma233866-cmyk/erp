"use strict";

const { toMysqlDatetime } = require("../core/dateTime");

class MySqlAuditSink {
  constructor({ pool }) {
    if (!pool || typeof pool.execute !== "function") throw new TypeError("A mysql pool is required");
    this.pool = pool;
  }

  async write(entry) {
    await this.pool.execute(
      `INSERT INTO v2_audit_logs
       (request_id, company_id, actor_id, action, resource_type, resource_id, outcome, status_code, metadata_json, occurred_at)
       VALUES (?, NULLIF(?, ''), NULLIF(?, ''), ?, ?, NULLIF(?, ''), ?, ?, ?, ?)`,
      [
        entry.requestId,
        entry.companyId,
        entry.actorId,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        entry.outcome,
        entry.statusCode,
        JSON.stringify(entry.metadata || {}),
        toMysqlDatetime(entry.occurredAt)
      ]
    );
  }
}

module.exports = { MySqlAuditSink };
