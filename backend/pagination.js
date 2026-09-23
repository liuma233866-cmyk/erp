function paginateItems(items, query, defaultPageSize = 50) {
  const source = Array.isArray(items) ? items : [];
  const usePaging = query.page !== undefined || query.pageSize !== undefined;
  if (!usePaging) {
    const total = source.length;
    return { items: source, pagination: { page: 1, pageSize: total || defaultPageSize, total, totalPages: total > 0 ? 1 : 0 } };
  }
  const pageRaw = query.page !== undefined ? Number(query.page) : 1;
  const pageSizeRaw = query.pageSize !== undefined ? Number(query.pageSize) : defaultPageSize;
  // Fractional values like 0.5 must not produce page 0 or pageSize 0 (which
  // yields totalPages Infinity / empty items), while <= 0 still falls back to
  // the defaults.
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.max(1, Math.floor(pageRaw)) : 1;
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.max(1, Math.min(200, Math.floor(pageSizeRaw))) : defaultPageSize;
  const total = source.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const sliced = source.slice(start, start + pageSize);
  return { items: sliced, pagination: { page: safePage, pageSize, total, totalPages } };
}

function readPositiveIntParam(value, fallback, min = 1, max = 1000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function validateNonEmptyString(value, fieldName, maxLen = 256) {
  const text = String(value || "").trim();
  if (!text) {
    return { ok: false, message: `${fieldName} is required` };
  }
  if (text.length > maxLen) {
    return { ok: false, message: `${fieldName} is too long (max ${maxLen})` };
  }
  return { ok: true, value: text };
}

module.exports = { paginateItems, readPositiveIntParam, validateNonEmptyString };
