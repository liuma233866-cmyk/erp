const fs = require("fs");
const path = require("path");

const FALLBACK_PROMPT = "保留商品主体，替换为干净、适合电商刊登的背景";

function selectPromptForModel(items, modelId = "") {
  const prompts = Array.isArray(items) ? items : [];
  const targetModelId = String(modelId || "").trim();
  const exact = targetModelId ? prompts.filter((item) => String(item?.modelId || "").trim() === targetModelId) : [];
  const global = prompts.filter((item) => !String(item?.modelId || "").trim());
  return String(
    exact.find((item) => item?.isDefault)?.prompt ||
    exact[0]?.prompt ||
    global.find((item) => item?.isDefault)?.prompt ||
    global[0]?.prompt ||
    FALLBACK_PROMPT
  ).trim();
}

function createAiImagePromptsModule(deps) {
  const { getSqlPool, isSqlReady, getDataDir, makeId, checkPermission, requireAuth, respondApi, parseJsonBody } = deps;
  let localItems = [];
  let initialized = false;
  let sqlReady = false;
  const companyIdForUser = (user) => String(user?.companyId || (user?.role === "admin" ? "system" : "")).trim() || "system";
  const file = () => path.join(getDataDir(), "ai-image-prompts.json");
  const canUseSql = () => Boolean(sqlReady && isSqlReady() && getSqlPool());
  const normalize = (source = {}, fallback = {}) => ({
    id: String(source.id || fallback.id || "").trim(), companyId: String(source.companyId || fallback.companyId || "").trim(),
    name: String(source.name || fallback.name || "未命名提示词").trim() || "未命名提示词", modelId: String(source.modelId ?? fallback.modelId ?? "").trim(),
    prompt: String(source.prompt || fallback.prompt || "").trim(), isDefault: source.isDefault === true || source.isDefault === 1 || source.isDefault === "1",
    createdAt: String(source.createdAt || fallback.createdAt || new Date().toISOString()), updatedAt: String(source.updatedAt || fallback.updatedAt || new Date().toISOString())
  });
  const readLocal = () => { try { localItems = fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file(), "utf8")).map((item) => normalize(item)).filter((item) => item.id && item.prompt) : []; } catch { localItems = []; } };
  const saveLocal = () => { fs.mkdirSync(getDataDir(), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(localItems, null, 2), "utf8"); };
  async function initialize() {
    if (initialized) return;
    readLocal(); initialized = true;
    if (!isSqlReady() || !getSqlPool()) return;
    try {
      await getSqlPool().query(`CREATE TABLE IF NOT EXISTS ai_image_prompts (id VARCHAR(64) NOT NULL PRIMARY KEY, companyId VARCHAR(64) NOT NULL, name VARCHAR(128) NOT NULL, prompt TEXT NOT NULL, isDefault TINYINT(1) NOT NULL DEFAULT 0, createdAt TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), updatedAt TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX idx_ai_image_prompts_company (companyId, isDefault)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
      const [columns] = await getSqlPool().query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_image_prompts' AND COLUMN_NAME = 'modelId'");
      if (!columns.length) await getSqlPool().query("ALTER TABLE ai_image_prompts ADD COLUMN modelId VARCHAR(128) NOT NULL DEFAULT '' AFTER name, ADD INDEX idx_ai_image_prompts_model (companyId, modelId, isDefault)");
      sqlReady = true;
    } catch (error) { console.error("AI image prompt table unavailable:", String(error)); }
  }
  async function list(companyId) {
    if (canUseSql()) { const [rows] = await getSqlPool().execute("SELECT id, companyId, name, modelId, prompt, isDefault, createdAt, updatedAt FROM ai_image_prompts WHERE companyId = ? ORDER BY isDefault DESC, updatedAt DESC", [companyId]); return rows.map((row) => normalize(row)); }
    return localItems.filter((item) => item.companyId === companyId).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  }
  async function getDefaultPrompt(companyId = "system", modelId = "") { return selectPromptForModel(await list(companyId), modelId); }
  async function create(user, body) {
    const companyId = companyIdForUser(user); const prompt = String(body?.prompt || "").trim(); const name = String(body?.name || "").trim(); const modelId = String(body?.modelId || "").trim();
    if (!prompt) return { ok: false, statusCode: 400, message: "提示词不能为空" };
    const items = await list(companyId); const item = normalize({ id: makeId("AIP"), companyId, name: name || `提示词 ${items.length + 1}`, modelId, prompt, isDefault: body?.isDefault === true || !items.some((candidate) => String(candidate.modelId || "") === modelId) });
    if (canUseSql()) { if (item.isDefault) await getSqlPool().execute("UPDATE ai_image_prompts SET isDefault = 0 WHERE companyId = ? AND modelId = ?", [companyId, modelId]); await getSqlPool().execute("INSERT INTO ai_image_prompts (id, companyId, name, modelId, prompt, isDefault) VALUES (?, ?, ?, ?, ?, ?)", [item.id, companyId, item.name, item.modelId, item.prompt, item.isDefault ? 1 : 0]); }
    else { if (item.isDefault) localItems.forEach((candidate) => { if (candidate.companyId === companyId && String(candidate.modelId || "") === modelId) candidate.isDefault = false; }); localItems.unshift(item); saveLocal(); }
    return { ok: true, item };
  }
  async function remove(user, id) { const companyId = companyIdForUser(user); if (canUseSql()) { const [result] = await getSqlPool().execute("DELETE FROM ai_image_prompts WHERE id = ? AND companyId = ?", [id, companyId]); return result.affectedRows ? { ok: true } : { ok: false, statusCode: 404, message: "提示词不存在" }; } const before = localItems.length; localItems = localItems.filter((item) => !(item.id === id && item.companyId === companyId)); if (localItems.length === before) return { ok: false, statusCode: 404, message: "提示词不存在" }; saveLocal(); return { ok: true }; }
  async function handleRequest(req, res, url, auditBase) {
    const match = url.pathname.match(/^\/api\/ai\/image-prompts(?:\/([^/]+))?$/); if (!match) return false;
    const auth = requireAuth(req, res, { ...auditBase, resourceType: "ai_image_prompt" }); if (!auth.ok) return true;
    if (!checkPermission(auth.user, "ai.config")) { respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_image_prompt" }, 403, { message: "Forbidden" }); return true; }
    const id = match[1] ? decodeURIComponent(match[1]) : "";
    if (req.method === "GET" && !id) { respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_image_prompt" }, 200, { items: await list(companyIdForUser(auth.user)) }); return true; }
    if (req.method === "POST" && !id) { const result = await create(auth.user, await parseJsonBody(req)); respondApi(req, res, auth.user, { ...auditBase, actionType: "create", resourceType: "ai_image_prompt", resourceId: result.item?.id || "" }, result.ok ? 201 : result.statusCode || 400, result.ok ? { item: result.item } : { message: result.message }); return true; }
    if (req.method === "DELETE" && id) { const result = await remove(auth.user, id); respondApi(req, res, auth.user, { ...auditBase, actionType: "delete", resourceType: "ai_image_prompt", resourceId: id }, result.ok ? 200 : result.statusCode || 404, result.ok ? { ok: true } : { message: result.message }); return true; }
    respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_image_prompt" }, 405, { message: "Method not allowed" }); return true;
  }
  return { initialize, handleRequest, getDefaultPrompt };
}
module.exports = { createAiImagePromptsModule, FALLBACK_PROMPT, selectPromptForModel };
