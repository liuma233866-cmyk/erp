(function attachSafeImageUrl(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SafeImageUrl = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function createSafeImageUrl() {
  // Only http(s) URLs may be used in <img src>: product image URLs come from
  // third-party (Ozon/Yandex) data, and HTML-escaping alone cannot stop
  // javascript:/data: payloads. Anything else becomes an empty string and the
  // caller renders a placeholder.
  function safeImageUrl(value) {
    const text = String(value || "").trim();
    return /^https?:\/\//i.test(text) ? text : "";
  }

  return { safeImageUrl, safeExternalUrl: safeImageUrl };
});
