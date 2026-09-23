function toMysqlDateTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid datetime value: ${String(value)}`);
  return date.toISOString().slice(0, 23).replace("T", " ");
}

module.exports = { toMysqlDateTime };
