function hydratePayloadRow(row) {
  if (!row || typeof row !== "object") return null;
  let payload = {};
  try { payload = JSON.parse(String(row.payloadJson || "{}")); } catch {}
  const result = { ...payload, ...row };
  for (const field of ["shopPermissions", "shopAssignments"]) {
    if (row[field] !== undefined && row[field] !== null) {
      try { result[field] = JSON.parse(String(row[field])); } catch { result[field] = row[field]; }
    }
  }
  delete result.payloadJson;
  return result;
}

function userSqlValues(user) {
  const item = { ...(user || {}) };
  return [
    String(item.id || ""), String(item.username || ""), String(item.passwordHash || ""), String(item.passwordSalt || ""),
    String(item.role || ""), String(item.companyId || ""), String(item.companyName || ""), String(item.createdAt || ""),
    JSON.stringify(item.shopPermissions || {}), JSON.stringify(Array.isArray(item.shopAssignments) ? item.shopAssignments : [])
  ];
}

function sessionSqlValues(session) {
  const item = { ...(session || {}) };
  // The token column stores the SHA-256 hash of the bearer token, never the
  // token itself; verification happens by hashing the presented token.
  return [String(item.tokenHash || ""), String(item.userId || ""), Number(item.expiresAt || 0) || 0, JSON.stringify(item)];
}

module.exports = { hydratePayloadRow, sessionSqlValues, userSqlValues };
