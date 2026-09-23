const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { isSafeExternalHttpUrl } = require("./network-safety");

const DEFAULT_PROVIDER = "qwen";
const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:-]{2,120}$/;

function createAiConfigModule(deps) {
  const {
    getSqlPool,
    isSqlReady,
    getDataDir,
    makeId,
    encryptSecret,
    decryptSecret,
    checkPermission,
    requireAuth,
    respondApi,
    parseJsonBody
  } = deps;

  let localModels = [];
  let initialized = false;
  let sqlTableReady = false;

  function getLocalFile() {
    return path.join(getDataDir(), "ai-config.json");
  }

  function companyIdForUser(user) {
    return String(user?.companyId || (user?.role === "admin" ? "system" : "")).trim() || "system";
  }

  function normalizeModel(input, fallback = {}) {
    const source = input && typeof input === "object" ? input : {};
    const id = String(source.id || fallback.id || "").trim();
    const model = String(source.model || fallback.model || "").trim();
    const name = String(source.name || fallback.name || model).trim();
    const provider = String(source.provider || fallback.provider || DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
    const baseUrl = String(source.baseUrl || fallback.baseUrl || "").trim().replace(/\/+$/, "");
    const companyId = String(source.companyId || fallback.companyId || "").trim();
    const createdAt = String(source.createdAt || fallback.createdAt || new Date().toISOString());
    const updatedAt = String(source.updatedAt || fallback.updatedAt || createdAt);
    return {
      id,
      companyId,
      name,
      provider,
      model,
      baseUrl,
      apiKeyEncrypted: String(source.apiKeyEncrypted || fallback.apiKeyEncrypted || "").trim(),
      enabled: source.enabled === false || source.enabled === 0 || source.enabled === "0" ? false : true,
      isDefault: source.isDefault === true || source.isDefault === 1 || source.isDefault === "1",
      createdAt,
      updatedAt
    };
  }

  function toPublicModel(model) {
    const apiKey = decryptSecret(model.apiKeyEncrypted || "");
    return {
      id: model.id,
      name: model.name,
      provider: model.provider,
      model: model.model,
      baseUrl: model.baseUrl,
      enabled: Boolean(model.enabled),
      isDefault: Boolean(model.isDefault),
      apiKeyConfigured: Boolean(apiKey),
      apiKeyMasked: apiKey ? maskSecret(apiKey) : "",
      createdAt: model.createdAt,
      updatedAt: model.updatedAt
    };
  }

  function maskSecret(secret) {
    const text = String(secret || "");
    if (!text) return "";
    if (text.length <= 8) return "***";
    return `${text.slice(0, 3)}***${text.slice(-3)}`;
  }

  function readLocalModels() {
    try {
      const file = getLocalFile();
      if (!fs.existsSync(file)) {
        localModels = [];
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      localModels = Array.isArray(parsed) ? parsed.map((item) => normalizeModel(item)).filter((item) => item.id) : [];
    } catch (error) {
      localModels = [];
      console.error("AI config local storage unavailable:", String(error));
    }
  }

  function saveLocalModels() {
    fs.mkdirSync(getDataDir(), { recursive: true });
    fs.writeFileSync(getLocalFile(), JSON.stringify(localModels, null, 2), "utf8");
  }

  function sqlConfigured() {
    return Boolean(isSqlReady() && getSqlPool());
  }

  function sqlAvailable() {
    return Boolean(sqlTableReady && sqlConfigured());
  }

  async function initialize() {
    if (initialized) return;
    readLocalModels();
    if (sqlConfigured()) {
      try {
        await getSqlPool().query(`
          CREATE TABLE IF NOT EXISTS ai_models (
            id VARCHAR(64) NOT NULL PRIMARY KEY,
            companyId VARCHAR(64) NOT NULL,
            name VARCHAR(128) NOT NULL,
            provider VARCHAR(64) NOT NULL,
            model VARCHAR(128) NOT NULL,
            baseUrl VARCHAR(512) NOT NULL,
            apiKeyEncrypted TEXT NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            isDefault TINYINT(1) NOT NULL DEFAULT 0,
            createdAt TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            updatedAt TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
            INDEX idx_ai_models_company (companyId),
            INDEX idx_ai_models_default (companyId, isDefault)
          ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
        `);
        sqlTableReady = true;
      } catch (error) {
        sqlTableReady = false;
        console.error("AI config table unavailable, using local storage:", String(error));
      }
    }
    initialized = true;
  }

  function mapSqlRow(row) {
    return normalizeModel({
      ...row,
      enabled: Boolean(Number(row.enabled)),
      isDefault: Boolean(Number(row.isDefault)),
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt
    });
  }

  async function listForCompany(companyId) {
    if (sqlAvailable()) {
      const [rows] = await getSqlPool().execute(
        `SELECT id, companyId, name, provider, model, baseUrl, apiKeyEncrypted, enabled, isDefault, createdAt, updatedAt
         FROM ai_models WHERE companyId = ? ORDER BY isDefault DESC, updatedAt DESC, createdAt DESC`,
        [companyId]
      );
      return rows.map(mapSqlRow);
    }
    return localModels
      .filter((item) => item.companyId === companyId)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function validatePayload(body, existing = null) {
    const model = String(body.model ?? existing?.model ?? "").trim();
    if (!MODEL_ID_PATTERN.test(model)) {
      return { ok: false, message: "模型标识只能包含字母、数字、点、冒号、下划线或短横线，长度 2-120 位" };
    }
    const name = String(body.name ?? existing?.name ?? model).trim();
    if (!name || name.length > 128) return { ok: false, message: "模型名称不能为空且不能超过 128 个字符" };
    const provider = String(body.provider ?? existing?.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
    const baseUrl = String(body.baseUrl ?? existing?.baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!baseUrl) return { ok: false, message: "API 地址不能为空" };
    try {
      const parsed = new URL(baseUrl);
      if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("protocol");
      if (!isSafeExternalHttpUrl(baseUrl)) throw new Error("private host");
    } catch {
      return { ok: false, message: "API 地址必须是 http 或 https 链接" };
    }
    return { ok: true, model, name, provider, baseUrl };
  }

  function requestedBoolean(value, fallback) {
    if (value === true || value === 1 || value === "1" || value === "true") return true;
    if (value === false || value === 0 || value === "0" || value === "false") return false;
    return fallback;
  }

  async function clearDefault(companyId, exceptId = "") {
    if (sqlAvailable()) {
      await getSqlPool().execute(
        "UPDATE ai_models SET isDefault = 0 WHERE companyId = ? AND id <> ?",
        [companyId, exceptId]
      );
      return;
    }
    localModels = localModels.map((item) => item.companyId === companyId && item.id !== exceptId ? { ...item, isDefault: false } : item);
  }

  async function createModel(user, body) {
    const companyId = companyIdForUser(user);
    const validation = validatePayload(body);
    if (!validation.ok) return validation;
    const current = await listForCompany(companyId);
    const now = new Date();
    const item = normalizeModel({
      id: makeId("AIM"),
      companyId,
      ...validation,
      apiKeyEncrypted: encryptSecret(String(body.apiKey || "").trim()),
      enabled: requestedBoolean(body.enabled, true),
      isDefault: requestedBoolean(body.isDefault, current.length === 0),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    });
    if (item.isDefault) await clearDefault(companyId, item.id);
    if (sqlAvailable()) {
      await getSqlPool().execute(
        `INSERT INTO ai_models (id, companyId, name, provider, model, baseUrl, apiKeyEncrypted, enabled, isDefault, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [item.id, item.companyId, item.name, item.provider, item.model, item.baseUrl, item.apiKeyEncrypted, item.enabled ? 1 : 0, item.isDefault ? 1 : 0, now, now]
      );
    } else {
      localModels.push(item);
      saveLocalModels();
    }
    return { ok: true, item };
  }

  async function updateModel(user, id, body) {
    const companyId = companyIdForUser(user);
    const items = await listForCompany(companyId);
    const existing = items.find((item) => item.id === id);
    if (!existing) return { ok: false, statusCode: 404, message: "AI 模型不存在" };
    const validation = validatePayload(body, existing);
    if (!validation.ok) return validation;
    const apiKeyProvided = Object.prototype.hasOwnProperty.call(body, "apiKey");
    const apiKey = apiKeyProvided ? String(body.apiKey || "").trim() : decryptSecret(existing.apiKeyEncrypted);
    const item = normalizeModel({
      ...existing,
      ...validation,
      apiKeyEncrypted: apiKey ? encryptSecret(apiKey) : "",
      enabled: requestedBoolean(body.enabled, existing.enabled),
      isDefault: requestedBoolean(body.isDefault, existing.isDefault),
      updatedAt: new Date().toISOString()
    });
    if (item.isDefault) await clearDefault(companyId, item.id);
    if (!item.isDefault && existing.isDefault) {
      const remaining = items.filter((candidate) => candidate.id !== id && candidate.enabled);
      if (remaining.length) {
        item.isDefault = false;
      }
    }
    if (sqlAvailable()) {
      await getSqlPool().execute(
        `UPDATE ai_models SET name = ?, provider = ?, model = ?, baseUrl = ?, apiKeyEncrypted = ?, enabled = ?, isDefault = ?, updatedAt = ?
         WHERE id = ? AND companyId = ?`,
        [item.name, item.provider, item.model, item.baseUrl, item.apiKeyEncrypted, item.enabled ? 1 : 0, item.isDefault ? 1 : 0, new Date(), item.id, companyId]
      );
    } else {
      localModels = localModels.map((candidate) => candidate.id === id && candidate.companyId === companyId ? item : candidate);
      saveLocalModels();
    }
    return { ok: true, item };
  }

  async function deleteModel(user, id) {
    const companyId = companyIdForUser(user);
    const items = await listForCompany(companyId);
    const existing = items.find((item) => item.id === id);
    if (!existing) return { ok: false, statusCode: 404, message: "AI 模型不存在" };
    if (sqlAvailable()) {
      await getSqlPool().execute("DELETE FROM ai_models WHERE id = ? AND companyId = ?", [id, companyId]);
    } else {
      localModels = localModels.filter((item) => !(item.id === id && item.companyId === companyId));
      saveLocalModels();
    }
    if (existing.isDefault) {
      const remaining = await listForCompany(companyId);
      const next = remaining.find((item) => item.enabled) || remaining[0];
      if (next) {
        await updateModel(user, next.id, { isDefault: true });
      }
    }
    return { ok: true };
  }

  function requestJson(baseUrl, endpoint, apiKey, requestBody) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(`${baseUrl.replace(/\/+$/, "")}${endpoint}`);
      } catch {
        reject(new Error("API 地址无效"));
        return;
      }
      const client = parsed.protocol === "https:" ? https : http;
      const request = client.request(parsed, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(requestBody),
          Authorization: `Bearer ${apiKey}`
        }
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 100000) response.destroy(new Error("响应过大"));
        });
        response.on("end", () => {
          const statusCode = Number(response.statusCode || 0);
          if (statusCode >= 200 && statusCode < 300) {
            resolve({ statusCode });
            return;
          }
          reject(new Error(`接口返回 HTTP ${statusCode || 0}`));
        });
      });
      request.setTimeout(10000, () => request.destroy(new Error("连接超时（10秒）")));
      request.on("error", reject);
      request.end(requestBody);
    });
  }

  function requestChatCompletion(baseUrl, apiKey, model) {
    const requestBody = JSON.stringify({
      model,
      messages: [{ role: "user", content: "请仅回复 OK" }],
      max_tokens: 1,
      stream: false
    });
    return requestJson(baseUrl, "/chat/completions", apiKey, requestBody);
  }

  function requestImageGeneration(baseUrl, apiKey, model) {
    const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
    let parsedBaseUrl;
    try {
      parsedBaseUrl = new URL(normalizedBaseUrl);
    } catch {
      parsedBaseUrl = null;
    }
    const imageBaseUrl = parsedBaseUrl
      ? `${parsedBaseUrl.protocol}//${parsedBaseUrl.host}/api/v1`
      : normalizedBaseUrl.replace(/\/compatible-mode\/v1$/i, "/api/v1");
    const requestBody = JSON.stringify({
      model,
      input: {
        messages: [{
          role: "user",
          content: [{ text: "连接测试：生成一张简洁的白色背景产品展示图" }]
        }]
      },
      parameters: {
        size: "512*512",
        n: 1,
        prompt_extend: false,
        watermark: false
      }
    });
    return requestJson(imageBaseUrl, "/services/aigc/multimodal-generation/generation", apiKey, requestBody);
  }

  function isImageModel(model) {
    return /(?:image|t2i|i2i|video)/i.test(String(model || ""));
  }

  async function testModel(user, id) {
    const companyId = companyIdForUser(user);
    const items = await listForCompany(companyId);
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return { ok: false, statusCode: 404, message: "AI 模型不存在" };
    const apiKey = decryptSecret(item.apiKeyEncrypted);
    if (!apiKey) return { ok: false, statusCode: 400, message: "请先在 ERP 的 AI 配置中填写 API Key" };
    const startedAt = Date.now();
    try {
      const imageModel = isImageModel(item.model);
      const result = imageModel
        ? await requestImageGeneration(item.baseUrl, apiKey, item.model)
        : await requestChatCompletion(item.baseUrl, apiKey, item.model);
      const mode = imageModel ? "图像生成接口" : "文本对话接口";
      return { ok: true, detail: `连接成功（HTTP ${result.statusCode}，${mode}已验证模型 ${item.model}，${Date.now() - startedAt}ms）` };
    } catch (error) {
      return { ok: false, statusCode: 502, message: `连接失败：${String(error?.message || error)}` };
    }
  }

  function permissionDenied(auth, req, res, auditBase) {
    respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_model" }, 403, { message: "无权管理 AI 配置" });
  }

  async function handleRequest(req, res, url, auditBase) {
    const pathname = url.pathname;
    const match = pathname.match(/^\/api\/ai\/models(?:\/([^/]+))?(\/test)?$/);
    if (!match) return false;
    const auth = requireAuth(req, res, { ...auditBase, resourceType: "ai_model" });
    if (!auth.ok) return true;
    const id = match[1] ? decodeURIComponent(match[1]) : "";
    const isTest = Boolean(match[2]);
    const isListRequest = req.method === "GET" && !id;
    const allowed = isListRequest
      ? checkPermission(auth.user, "product.ai")
      : checkPermission(auth.user, "ai.config");
    if (!allowed) {
      permissionDenied(auth, req, res, auditBase);
      return true;
    }
    try {
      if (req.method === "GET" && !id) {
        const items = await listForCompany(companyIdForUser(auth.user));
        respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_model" }, 200, { items: items.map(toPublicModel) });
        return true;
      }
      if (req.method === "POST" && !id) {
        const body = await parseJsonBody(req);
        const result = await createModel(auth.user, body);
        if (!result.ok) {
          respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_model", actionType: "create", requestBodyMasked: maskRequestBody(body) }, result.statusCode || 400, { message: result.message });
          return true;
        }
        respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_model", actionType: "create", resourceId: result.item.id, requestBodyMasked: maskRequestBody(body) }, 201, { item: toPublicModel(result.item) });
        return true;
      }
      if (req.method === "PUT" && id && !isTest) {
        const body = await parseJsonBody(req);
        const result = await updateModel(auth.user, id, body);
        if (!result.ok) {
          respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_model", actionType: "update", resourceId: id, requestBodyMasked: maskRequestBody(body) }, result.statusCode || 400, { message: result.message });
          return true;
        }
        respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_model", actionType: "update", resourceId: id, requestBodyMasked: maskRequestBody(body) }, 200, { item: toPublicModel(result.item) });
        return true;
      }
      if (req.method === "DELETE" && id && !isTest) {
        const result = await deleteModel(auth.user, id);
        if (!result.ok) {
          respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_model", actionType: "delete", resourceId: id }, result.statusCode || 400, { message: result.message });
          return true;
        }
        respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_model", actionType: "delete", resourceId: id }, 200, { message: "AI 模型已删除" });
        return true;
      }
      if (req.method === "POST" && id && isTest) {
        const result = await testModel(auth.user, id);
        respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_model", actionType: "test", resourceId: id }, result.ok ? 200 : (result.statusCode || 502), result.ok ? { message: result.detail } : { message: result.message });
        return true;
      }
      respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_model", resourceId: id }, 405, { message: "Method not allowed" });
      return true;
    } catch (error) {
      respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_model", resourceId: id }, 500, { message: "AI 配置处理失败" });
      return true;
    }
  }

  return { initialize, handleRequest };
}

function maskRequestBody(body) {
  if (!body || typeof body !== "object") return null;
  const masked = { ...body };
  if (Object.prototype.hasOwnProperty.call(masked, "apiKey")) masked.apiKey = masked.apiKey ? "***" : "";
  return masked;
}

module.exports = { createAiConfigModule };
