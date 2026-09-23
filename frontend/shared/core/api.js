async function uploadPublishImportFile(file, shopId = "") {
  const headers = {};
  if (file?.name) headers["X-File-Name"] = encodeURIComponent(file.name);
  if (file?.type) headers["Content-Type"] = file.type;
  const query = shopId ? `?shopId=${encodeURIComponent(shopId)}` : "";
  try {
    const response = await fetch(`/api/product-publish/import-file${query}`, {
      method: "POST",
      headers,
      body: file
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        clearAuth();
        showAuth();
      }
      return { ok: false, status: response.status, error: data.message || `HTTP ${response.status}` };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof TypeError ? "网络连接失败，请确认本地服务已启动并可访问" : String(error) };
  }
}

async function fetchBinary(path, options = {}) {
  const headers = {};
  try {
    const response = await fetch(path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        clearAuth();
        showAuth();
      }
      return { ok: false, error: data.message || `HTTP ${response.status}` };
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename=\"?([^\";]+)\"?/i);
    const filename = match ? match[1] : "";
    return { ok: true, blob, filename };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function apiRequest(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };

  try {
    const response = await fetch(path, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        clearAuth();
        showAuth();
      }
      // Keep the whole body: error responses carry per-item detail (for example the
      // fields that are still missing), and callers need it to explain the failure.
      return { ok: false, status: response.status, error: data.message || `HTTP ${response.status}`, data };
    }
    return { ok: true, data };
  } catch (error) {
    if (error instanceof TypeError) {
      return { ok: false, status: 0, error: "网络连接失败，请确认本地服务已启动并可访问", data: null };
    }
    return { ok: false, status: 0, error: String(error), data: null };
  }
}
