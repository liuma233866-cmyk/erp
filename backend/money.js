function normalizeMoney(value) {
  if (value === undefined || value === null) return NaN;
  if (typeof value === "object") {
    const inner = value.value ?? value.amount ?? value.price;
    // A non-standard object without these keys must degrade to NaN instead of
    // recursing on itself forever (stack overflow).
    return inner !== undefined ? normalizeMoney(inner) : NaN;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const text = String(value).replace(/[\s\u00A0\u202F￥¥₽руб]+/gi, "").trim();
  if (!text) return NaN;
  let normalized = text;
  const hasComma = normalized.includes(",");
  const hasDot = normalized.includes(".");
  if (hasComma && hasDot) normalized = normalized.replace(/,/g, "");
  else if (hasComma) normalized = /^\d{1,3}(,\d{3})+$/.test(normalized) ? normalized.replace(/,/g, "") : normalized.replace(/,/g, ".");
  normalized = normalized.replace(/[^0-9.-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}
module.exports = { normalizeMoney };
