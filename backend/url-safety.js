function normalizeExternalHttpUrl(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) ? text : "";
}

function validateOptionalExternalHttpUrl(value, fieldName = "URL") {
  const text = String(value || "").trim();
  if (!text || normalizeExternalHttpUrl(text)) return { ok: true, value: text };
  return { ok: false, message: `${fieldName} must use http:// or https://` };
}

module.exports = { normalizeExternalHttpUrl, validateOptionalExternalHttpUrl };
