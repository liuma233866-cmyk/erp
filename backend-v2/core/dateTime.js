"use strict";

function parseUtcDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  const raw = String(value ?? "").trim();
  if (!raw) return new Date(NaN);
  // A MySQL DATETIME has no timezone marker; V2 treats it as UTC by contract.
  const mysqlDate = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?$/.exec(raw);
  if (mysqlDate) {
    const milliseconds = (mysqlDate[3] || "").padEnd(3, "0");
    return new Date(`${mysqlDate[1]}T${mysqlDate[2]}.${milliseconds || "000"}Z`);
  }
  return new Date(raw);
}

function toMysqlDatetime(value) {
  const date = parseUtcDate(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("A valid date is required");
  return date.toISOString().slice(0, 23).replace("T", " ");
}

module.exports = { parseUtcDate, toMysqlDatetime };

