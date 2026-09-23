const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { isSafeExternalHttpUrl } = require("./network-safety");
const { callWithThrottleRetry, isProviderThrottlingError } = require("./ai-provider-throttle");

const MAX_PROMPT_LENGTH = 20000;
const MAX_IMAGE_DATA_URL_LENGTH = 14 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = Math.max(60000, Number(process.env.AI_PROVIDER_TIMEOUT_MS || 300000));
const PROVIDER_TIMEOUT_SECONDS = Math.floor(PROVIDER_TIMEOUT_MS / 1000);

function createAiMainModule(deps) {
  const {
    getSqlPool,
    isSqlReady,
    getDataDir,
    decryptSecret,
    checkPermission,
    requireAuth,
    respondApi,
    parseJsonBody
  } = deps;

  function companyIdForUser(user) {
    return String(user?.companyId || (user?.role === "admin" ? "system" : "")).trim() || "system";
  }

  function sqlConfigured() {
    return Boolean(isSqlReady() && getSqlPool());
  }

  function localConfigPath() {
    return path.join(getDataDir(), "ai-config.json");
  }

  function normalizeModel(row) {
    return {
      id: String(row.id || "").trim(),
      companyId: String(row.companyId || "").trim(),
      name: String(row.name || row.model || "").trim(),
      provider: String(row.provider || "custom").trim(),
      model: String(row.model || "").trim(),
      baseUrl: String(row.baseUrl || "").trim().replace(/\/+$/, ""),
      apiKeyEncrypted: String(row.apiKeyEncrypted || "").trim(),
      enabled: !(row.enabled === false || row.enabled === 0 || row.enabled === "0"),
      isDefault: row.isDefault === true || row.isDefault === 1 || row.isDefault === "1"
    };
  }

  async function listModels(companyId) {
    if (sqlConfigured()) {
      const [rows] = await getSqlPool().execute(
        `SELECT id, companyId, name, provider, model, baseUrl, apiKeyEncrypted, enabled, isDefault
         FROM ai_models WHERE companyId = ? ORDER BY isDefault DESC, updatedAt DESC, createdAt DESC`,
        [companyId]
      );
      return rows.map(normalizeModel);
    }
    try {
      const file = localConfigPath();
      if (!fs.existsSync(file)) return [];
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return (Array.isArray(parsed) ? parsed : [])
        .map(normalizeModel)
        .filter((item) => item.companyId === companyId);
    } catch {
      return [];
    }
  }

  function isImageModel(model) {
    return /(?:image|t2i|i2i|video)/i.test(String(model || ""));
  }

  function validateInput(body) {
    const source = body && typeof body === "object" ? body : {};
    const prompt = String(source.prompt || "").trim();
    const imageDataUrl = String(source.imageDataUrl || "").trim();
    const requestedModel = String(source.model || "").trim();
    if (!prompt && !imageDataUrl) return { ok: false, statusCode: 400, message: "请输入文字或上传图片" };
    if (prompt.length > MAX_PROMPT_LENGTH) return { ok: false, statusCode: 400, message: "提示词过长" };
    if (imageDataUrl && (!/^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(imageDataUrl) || imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH)) {
      return { ok: false, statusCode: 400, message: "图片格式无效或图片过大" };
    }
    return { ok: true, prompt, imageDataUrl, requestedModel };
  }

  async function selectModel(user, requestedModel) {
    const items = (await listModels(companyIdForUser(user))).filter((item) => item.enabled);
    if (!items.length) return { ok: false, statusCode: 400, message: "请先在系统管理 → AI配置中添加并启用模型" };
    const selected = requestedModel
      ? items.find((item) => item.model === requestedModel || item.id === requestedModel)
      : null;
    const item = selected || items.find((candidate) => candidate.isDefault) || items[0];
    if (requestedModel && !selected) return { ok: false, statusCode: 422, message: `Requested AI model ${requestedModel} is not configured or enabled; choose an enabled model in AI Configuration` };
    if (requestedModel && !selected) return { ok: false, statusCode: 400, message: "所选 AI 模型未配置或已停用" };
    const apiKey = decryptSecret(item.apiKeyEncrypted);
    if (!apiKey) return { ok: false, statusCode: 400, message: "请先在 ERP 的 AI配置中填写 API Key" };
    if (!item.baseUrl) return { ok: false, statusCode: 400, message: "当前 AI 模型缺少 API 地址" };
    return { ok: true, item, apiKey };
  }

  function providerErrorMessage(data, statusCode) {
    const source = data && typeof data === "object" ? data : {};
    const nested = source.error && typeof source.error === "object" ? source.error : {};
    const message = String(source.message || nested.message || source.code || nested.code || "").trim();
    return message ? `AI 接口返回 HTTP ${statusCode}：${message}` : `AI 接口返回 HTTP ${statusCode}`;
  }

  function requestProvider(baseUrl, endpoint, apiKey, requestBody, signal) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(`${String(baseUrl || "").replace(/\/+$/, "")}${endpoint}`);
      } catch {
        const error = new Error("AI API 地址无效");
        error.statusCode = 400;
        reject(error);
        return;
      }
      const client = target.protocol === "https:" ? https : http;
      const request = client.request(target, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(requestBody),
          Authorization: `Bearer ${apiKey}`
        },
        ...(signal ? { signal } : {})
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 12000000) response.destroy(new Error("AI 接口响应过大"));
        });
        response.on("end", () => {
          const statusCode = Number(response.statusCode || 0);
          let data = null;
          try {
            data = body ? JSON.parse(body) : null;
          } catch {
            data = null;
          }
          if (statusCode >= 200 && statusCode < 300) {
            resolve({ statusCode, data });
            return;
          }
          const error = new Error(providerErrorMessage(data, statusCode || 0));
          error.statusCode = 502;
          error.providerStatusCode = statusCode;
          error.providerCode = String(data?.code || data?.error?.code || "").trim();
          error.providerRequestId = String(data?.request_id || data?.requestId || data?.request_id || response.headers["x-request-id"] || "").trim();
          error.providerMessage = String(data?.message || data?.error?.message || error.message || "").trim();
          const retryAfterSeconds = Number(response.headers["retry-after"] || 0);
          error.providerRetryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0;
          reject(error);
        });
      });
      request.setTimeout(PROVIDER_TIMEOUT_MS, () => request.destroy(new Error(`AI 接口请求超时（${PROVIDER_TIMEOUT_SECONDS} 秒），请稍后重试`)));
      request.on("error", reject);
      request.end(requestBody);
    });
  }

  function imageRequestBody(model, prompt, imageDataUrl) {
    const content = [];
    if (imageDataUrl) content.push({ image: imageDataUrl });
    content.push({ text: prompt || "请保持商品主体不变，替换为干净的白色电商产品背景，主体居中，光线自然。" });
    return JSON.stringify({
      model,
      input: { messages: [{ role: "user", content }] },
      parameters: {
        n: 1,
        size: "1024*1024",
        prompt_extend: true,
        watermark: false
      }
    });
  }

  function textRequestBody(model, prompt, imageDataUrl) {
    const content = imageDataUrl
      ? [
          { type: "text", text: prompt || "请描述并处理这张图片。" },
          { type: "image_url", image_url: { url: imageDataUrl } }
        ]
      : prompt;
    return JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      max_tokens: 2000,
      stream: false
    });
  }

  function extractText(data) {
    const content = data?.choices?.[0]?.message?.content ?? data?.output?.text ?? "";
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => typeof part === "string" ? part : String(part?.text || part?.content || ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  function extractImages(data) {
    const content = data?.output?.choices?.[0]?.message?.content;
    if (!Array.isArray(content)) return [];
    return content
      .map((part) => String(part?.image || "").trim())
      .filter((value) => /^https?:\/\//i.test(value));
  }

  function imageApiBaseUrl(baseUrl) {
    const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
    try {
      const parsed = new URL(normalized);
      if (/\/compatible-mode\/v1$/i.test(parsed.pathname)) {
        return `${parsed.protocol}//${parsed.host}/api/v1`;
      }
      return normalized;
    } catch {
      return normalized;
    }
  }

  /* legacy source-image downloader removed; retained block disabled for compatibility
  function fetchImageAsDataUrl(sourceUrl, redirectCount = 0) {
    const maxBytes = 12 * 1024 * 1024;
    if (redirectCount > 3) return Promise.reject(new Error("源图片重定向次数过多"));
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(sourceUrl);
      } catch {
        reject(new Error("源图片地址无效"));
        return;
      }
      if (!/^https?:$/.test(target.protocol)) {
        reject(new Error("源图片地址必须为 http 或 https"));
        return;
      }
      const client = target.protocol === "https:" ? https : http;
      const request = client.get(target, { headers: { Accept: "image/*" } }, (response) => {
        const statusCode = Number(response.statusCode || 0);
        const redirectTo = response.headers.location;
        if (statusCode >= 300 && statusCode < 400 && redirectTo) {
          response.resume();
          fetchImageAsDataUrl(new URL(redirectTo, target).toString(), redirectCount + 1).then(resolve, reject);
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(new Error(`下载源图片失败：HTTP ${statusCode || 0}`));
          return;
        }
        const contentType = String(response.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        if (!/^image\/(png|jpe?g|webp)$/i.test(contentType)) {
          response.resume();
          reject(new Error("源地址未返回 PNG、JPG 或 WEBP 图片"));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy(new Error("源图片超过 12MB"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve(`data:${contentType};base64,${Buffer.concat(chunks).toString("base64")}`));
        response.on("error", reject);
      });
      request.setTimeout(PROVIDER_TIMEOUT_MS, () => request.destroy(new Error("下载源图片超时")));
      request.on("error", reject);
    });
  }
  */

  async function runImageTask(task, reportEvent = null, signal = null) {
    const report = (stage, message, detail = null) => {
      if (typeof reportEvent !== "function") return;
      // 任务日志是审计信息，不能反过来阻塞图片结果写回。
      Promise.resolve(reportEvent(stage, message, detail)).catch((error) => {
        console.error("AI image task event log failed:", String(error?.message || error));
      });
    };
    const sourceImageUrl = String(task?.sourceImageUrl || "").trim();
    if (!sourceImageUrl) return { ok: false, statusCode: 400, message: "任务缺少源图片地址" };
    if (!isSafeExternalHttpUrl(sourceImageUrl)) return { ok: false, statusCode: 400, message: "源图片地址必须是公网 HTTP(S) 地址" };
    const selected = await selectModel(
      { companyId: String(task?.companyId || "system").trim() || "system", role: "admin" },
      String(task?.modelId || "").trim()
    );
    if (!selected.ok) return selected;
    if (!isImageModel(selected.item.model)) {
      return { ok: false, statusCode: 400, message: `模型 ${selected.item.model} 不是图片生成模型` };
    }
    await report("source_ready", "源图片公网地址已校验，将由 AI 平台直接读取");
    await report("model_request", `开始调用模型 ${selected.item.model}`, { modelId: selected.item.id, model: selected.item.model });
    let response;
    try {
      response = await callWithThrottleRetry(
        () => requestProvider(
          imageApiBaseUrl(selected.item.baseUrl),
          "/services/aigc/multimodal-generation/generation",
          selected.apiKey,
          imageRequestBody(selected.item.model, String(task?.prompt || "").trim(), sourceImageUrl),
          signal
        ),
        {
          onRetry: async ({ error, retryIndex, delayMs, nextAttempt }) => {
            const throttled = isProviderThrottlingError(error);
            await report(throttled ? "provider_throttled" : "provider_network_retry", `${throttled ? "AI 平台限流" : "AI 平台连接中断"}，${Math.ceil(delayMs / 1000)} 秒后进行第 ${nextAttempt} 次请求`, {
              providerStatusCode: Number(error?.providerStatusCode || 0) || null,
              providerCode: String(error?.providerCode || error?.code || ""),
              providerRequestId: String(error?.providerRequestId || ""),
              retryIndex,
              delayMs
            });
          },
          signal
        }
      );
    } catch (error) {
      const providerDetail = {
        providerStatusCode: Number(error?.providerStatusCode || 0) || null,
        providerCode: String(error?.providerCode || error?.code || ""),
        providerRequestId: String(error?.providerRequestId || ""),
        providerMessage: String(error?.providerMessage || error?.message || "AI 平台请求失败")
      };
      await report("provider_error", `AI 平台返回错误：${providerDetail.providerMessage}`, providerDetail);
      const exhausted = /^Throttling(?:\.|$)/i.test(providerDetail.providerCode) || providerDetail.providerStatusCode === 429;
      const wrapped = new Error(exhausted
        ? `千问 AI 调用频率超过额度，已自动退避重试 3 次仍未恢复（${providerDetail.providerCode || "HTTP 429"}，requestId: ${providerDetail.providerRequestId || "无"}）`
        : providerDetail.providerMessage);
      wrapped.providerDetail = providerDetail;
      throw wrapped;
    }
    const resultImageUrl = extractImages(response.data)[0] || "";
    if (!resultImageUrl) return { ok: false, statusCode: 502, message: "AI 接口未返回结果图片地址" };
    await report("result_received", "AI 已返回结果图片地址", { resultImageUrl, requestId: String(response.data?.request_id || response.data?.requestId || "").trim() });
    return {
      ok: true,
      modelId: selected.item.id,
      // Persist the provider's actual model code in task history. A friendly
      // configuration label is not enough to audit which image model ran.
      modelName: selected.item.model,
      resultImageUrl,
      requestId: String(response.data?.request_id || response.data?.requestId || "").trim()
    };
  }

  async function invokeModel(user, body) {
    const input = validateInput(body);
    if (!input.ok) return input;
    const selected = await selectModel(user, input.requestedModel);
    if (!selected.ok) return selected;
    const { item, apiKey } = selected;
    const imageModel = isImageModel(item.model);
    const response = imageModel
      ? await requestProvider(imageApiBaseUrl(item.baseUrl), "/services/aigc/multimodal-generation/generation", apiKey, imageRequestBody(item.model, input.prompt, input.imageDataUrl))
      : await requestProvider(item.baseUrl, "/chat/completions", apiKey, textRequestBody(item.model, input.prompt, input.imageDataUrl));
    return {
      ok: true,
      statusCode: 200,
      data: {
        model: item.model,
        modelName: item.name,
        kind: imageModel ? "image" : "text",
        outputText: imageModel ? "" : extractText(response.data),
        images: imageModel ? extractImages(response.data) : [],
        requestId: String(response.data?.request_id || response.data?.requestId || "")
      }
    };
  }

  async function handleRequest(req, res, url, auditBase) {
    if (url.pathname !== "/api/ai/chat") return false;
    const auth = requireAuth(req, res, { ...auditBase, resourceType: "ai_main" });
    if (!auth.ok) return true;
    if (!checkPermission(auth.user, "product.ai")) {
      respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_main" }, 403, { message: "无权使用 AI" });
      return true;
    }
    if (req.method !== "POST") {
      respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_main" }, 405, { message: "Method not allowed" });
      return true;
    }
    try {
      const body = await parseJsonBody(req, 15 * 1024 * 1024);
      const result = await invokeModel(auth.user, body);
      const requestBodyMasked = {
        model: String(body?.model || "").trim(),
        promptLength: String(body?.prompt || "").trim().length,
        hasImage: Boolean(String(body?.imageDataUrl || "").trim())
      };
      if (!result.ok) {
        respondApi(req, res, auth.user, { ...auditBase, actionType: "invoke", resourceType: "ai_main", requestBodyMasked }, result.statusCode || 400, { message: result.message });
        return true;
      }
      respondApi(req, res, auth.user, { ...auditBase, actionType: "invoke", resourceType: "ai_main", resourceId: result.data.model, requestBodyMasked }, 200, result.data);
      return true;
    } catch (error) {
      const statusCode = Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500 ? Number(error.statusCode) : 502;
      respondApi(req, res, auth.user, { ...auditBase, actionType: "invoke", resourceType: "ai_main" }, statusCode, { message: String(error?.message || "AI 请求失败") });
      return true;
    }
  }

  return { handleRequest, runImageTask };
}

module.exports = { createAiMainModule };
