"use strict";

function createCatalogApi({ fetchImpl = globalThis.fetch, baseUrl = "/api/v2/central", getToken = () => "" } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");

  async function request(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchImpl(`${baseUrl}${path}`, { ...options, headers });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body?.error?.message || "Central catalog request failed");
      error.code = body?.error?.code;
      error.requestId = body?.error?.requestId;
      throw error;
    }
    return body;
  }

  return {
    list(filters = {}) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== "") query.set(key, value);
      return request(`/products${query.toString() ? `?${query}` : ""}`);
    },
    detail(publicId) { return request(`/products/${encodeURIComponent(publicId)}`); },
    create(payload) { return request("/products", { method: "POST", body: JSON.stringify(payload) }); },
    update(publicId, payload) { return request(`/products/${encodeURIComponent(publicId)}`, { method: "PATCH", body: JSON.stringify(payload) }); },
    addVariant(publicId, payload) { return request(`/products/${encodeURIComponent(publicId)}/variants`, { method: "POST", body: JSON.stringify(payload) }); },
    addAsset(publicId, payload) { return request(`/products/${encodeURIComponent(publicId)}/assets`, { method: "POST", body: JSON.stringify(payload) }); }
  };
}

module.exports = { createCatalogApi };

