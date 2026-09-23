const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { toMysqlDateTime } = require("./mysql-datetime");

const TASK_STATUSES = new Set(["draft", "queued", "processing", "succeeded", "failed", "blocked", "canceled"]);
const TASK_CODE_PATTERN = /^[A-Za-z0-9._:-]{3,64}$/;
const TASK_TIMEOUT_MS = Math.max(300000, Number(process.env.AI_IMAGE_TASK_TIMEOUT_MS || 600000));
const TASK_TIMEOUT_SECONDS = Math.floor(TASK_TIMEOUT_MS / 1000);
const DEFAULT_TASK_CONCURRENCY = 3;
const MAX_TASK_CONCURRENCY = 20;

function resolveTaskConcurrency(value = process.env.AI_IMAGE_TASK_CONCURRENCY) {
  const parsed = Number(String(value || ""));
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_TASK_CONCURRENCY;
  return Math.min(parsed, MAX_TASK_CONCURRENCY);
}

function buildTaskMysqlConnectionOptions(env, password) {
  return {
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER,
    password,
    database: env.MYSQL_DATABASE,
    charset: "utf8mb4",
    timezone: "Z"
  };
}

function aiImageTaskQueryValue(query, key) {
  if (query && typeof query.get === "function") return query.get(key);
  return query?.[key];
}

function matchesAiImageTaskQuery(item, query) {
  const status = String(aiImageTaskQueryValue(query, "status") || "").trim().toLowerCase();
  const keyword = String(aiImageTaskQueryValue(query, "keyword") || "").trim().toLowerCase();
  const modelId = String(aiImageTaskQueryValue(query, "modelId") || "").trim().toLowerCase();
  const sourceType = String(aiImageTaskQueryValue(query, "sourceType") || "").trim().toLowerCase();
  if (status && String(item?.status || "").toLowerCase() !== status) return false;
  if (modelId && String(item?.modelId || "").toLowerCase() !== modelId) return false;
  if (sourceType && String(item?.sourceType || "").toLowerCase() !== sourceType) return false;
  if (!keyword) return true;
  let metadata = {};
  if (item?.metadataJson && typeof item.metadataJson === "object") {
    metadata = item.metadataJson;
  } else {
    try {
      metadata = JSON.parse(String(item?.metadataJson || "{}"));
    } catch {
      metadata = {};
    }
  }
  const haystack = [
    item?.id,
    metadata?.sourceSku,
    metadata?.systemSku,
    metadata?.platformSku,
    metadata?.variantSku
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
  return haystack.includes(keyword);
}

function createAiImageTasksModule(deps) {
  const {
    getSqlPool,
    isSqlReady,
    getDataDir,
    makeId,
    checkPermission,
    requireAuth,
    respondApi,
    parseJsonBody,
    getMysqlPassword,
    runImageTask,
    resolvePromptForModel,
    onTaskSucceeded,
    onTaskFailed
  } = deps;

  let localTasks = [];
  let localTaskLogs = [];
  let initialized = false;
  let sqlTableReady = false;
  let workerTimer = null;
  let watchdogTimer = null;
  let workerFilling = false;
  let activeTaskCount = 0;
  const taskConcurrency = resolveTaskConcurrency();
  let workerStopped = false;
  const activeExecutions = new Set();

  function getLocalFile() {
    return path.join(getDataDir(), "ai-image-tasks.json");
  }

  function getLocalLogFile() {
    return path.join(getDataDir(), "ai-image-task-logs.json");
  }

  function companyIdForUser(user) {
    return String(user?.companyId || (user?.role === "admin" ? "system" : "")).trim() || "system";
  }

  function sqlConfigured() {
    return Boolean(isSqlReady() && getSqlPool());
  }

  function sqlAvailable() {
    return Boolean(sqlTableReady && sqlConfigured());
  }

  function normalizeStatus(value, fallback = "draft") {
    const status = String(value || fallback || "draft").trim().toLowerCase();
    return TASK_STATUSES.has(status) ? status : "draft";
  }

  function normalizeTask(input, fallback = {}) {
    const source = input && typeof input === "object" ? input : {};
    const id = String(source.id || fallback.id || "").trim();
    const companyId = String(source.companyId || fallback.companyId || "").trim();
    const title = String(source.title || fallback.title || id).trim() || id;
    const sourceType = String(source.sourceType || fallback.sourceType || "product").trim() || "product";
    const sourceId = String(source.sourceId || fallback.sourceId || "").trim();
    const productId = String(source.productId || fallback.productId || "").trim();
    const sourceImageUrl = String(source.sourceImageUrl || fallback.sourceImageUrl || "").trim();
    const prompt = String(source.prompt || fallback.prompt || "").trim();
    const modelId = String(source.modelId || fallback.modelId || "").trim();
    const modelName = String(source.modelName || fallback.modelName || "").trim();
    const status = normalizeStatus(source.status, fallback.status);
    const progress = clampPercent(source.progress ?? fallback.progress ?? 0);
    const resultImageUrl = String(source.resultImageUrl || fallback.resultImageUrl || "").trim();
    const errorMessage = String(source.errorMessage || fallback.errorMessage || "").trim();
    const notes = String(source.notes || fallback.notes || "").trim();
    const metadataJson = String(source.metadataJson || fallback.metadataJson || "").trim();
    const requestedBy = String(source.requestedBy || fallback.requestedBy || "").trim();
    const createdAt = String(source.createdAt || fallback.createdAt || new Date().toISOString());
    const updatedAt = String(source.updatedAt || fallback.updatedAt || createdAt);
    const startedAt = String(source.startedAt || fallback.startedAt || "").trim();
    const finishedAt = String(source.finishedAt || fallback.finishedAt || "").trim();
    return {
      id,
      companyId,
      title,
      sourceType,
      sourceId,
      productId,
      sourceImageUrl,
      prompt,
      modelId,
      modelName,
      status,
      progress,
      resultImageUrl,
      errorMessage,
      notes,
      metadataJson,
      requestedBy,
      createdAt,
      updatedAt,
      startedAt,
      finishedAt
    };
  }

  function clampPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(100, Math.round(num)));
  }

  function readLocalTasks() {
    try {
      const file = getLocalFile();
      if (!fs.existsSync(file)) {
        localTasks = [];
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      localTasks = Array.isArray(parsed) ? parsed.map((item) => normalizeTask(item)).filter((item) => item.id) : [];
    } catch (error) {
      localTasks = [];
      console.error("AI image tasks local storage unavailable:", String(error));
    }
  }

  function readLocalTaskLogs() {
    try {
      const file = getLocalLogFile();
      if (!fs.existsSync(file)) {
        localTaskLogs = [];
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      localTaskLogs = Array.isArray(parsed) ? parsed : [];
    } catch {
      localTaskLogs = [];
    }
  }

  function saveLocalTasks() {
    fs.mkdirSync(getDataDir(), { recursive: true });
    fs.writeFileSync(getLocalFile(), JSON.stringify(localTasks, null, 2), "utf8");
  }

  function saveLocalTaskLogs() {
    fs.mkdirSync(getDataDir(), { recursive: true });
    fs.writeFileSync(getLocalLogFile(), JSON.stringify(localTaskLogs, null, 2), "utf8");
  }

  async function initialize() {
    if (initialized) return;
    workerStopped = false;
    readLocalTasks();
    readLocalTaskLogs();
    if (sqlConfigured()) {
      try {
        await getSqlPool().query(`
          CREATE TABLE IF NOT EXISTS ai_image_tasks (
            id VARCHAR(64) NOT NULL PRIMARY KEY,
            companyId VARCHAR(64) NOT NULL,
            title VARCHAR(255) NOT NULL,
            sourceType VARCHAR(64) NOT NULL DEFAULT 'product',
            sourceId VARCHAR(128) NOT NULL DEFAULT '',
            productId VARCHAR(128) NOT NULL DEFAULT '',
            sourceImageUrl TEXT NULL,
            prompt TEXT NULL,
            modelId VARCHAR(128) NOT NULL DEFAULT '',
            modelName VARCHAR(255) NOT NULL DEFAULT '',
            status VARCHAR(32) NOT NULL DEFAULT 'draft',
            progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
            resultImageUrl TEXT NULL,
            errorMessage TEXT NULL,
            notes TEXT NULL,
            metadataJson LONGTEXT NULL,
            requestedBy VARCHAR(128) NOT NULL DEFAULT '',
            startedAt TIMESTAMP(6) NULL DEFAULT NULL,
            finishedAt TIMESTAMP(6) NULL DEFAULT NULL,
            createdAt TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            updatedAt TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
            INDEX idx_ai_image_tasks_company (companyId),
            INDEX idx_ai_image_tasks_status (companyId, status),
            INDEX idx_ai_image_tasks_updated (companyId, updatedAt)
          ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
        `);
        await getSqlPool().query(`
          CREATE TABLE IF NOT EXISTS ai_image_task_logs (
            id VARCHAR(64) NOT NULL PRIMARY KEY,
            taskId VARCHAR(64) NOT NULL,
            companyId VARCHAR(64) NOT NULL,
            stage VARCHAR(64) NOT NULL,
            message VARCHAR(500) NOT NULL,
            detailJson LONGTEXT NULL,
            createdAt TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            INDEX idx_ai_image_task_logs_task (taskId, createdAt),
            INDEX idx_ai_image_task_logs_company (companyId, createdAt)
          ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
        `);
        sqlTableReady = true;
      } catch (error) {
        sqlTableReady = false;
        console.error("AI image task table unavailable, using local storage:", String(error));
      }
    }
    await backfillTaskModelsFromLogs();
    await recoverReturnedImageResults();
    await reconcileSucceededTaskResults();
    await expireTimedOutTasks();
    initialized = true;
    await recoverInterruptedProcessingTasks();
    startProcessingWatchdog();
    scheduleWorker(0);
  }

  function mapSqlRow(row) {
    return normalizeTask({
      ...row,
      progress: Number(row.progress || 0),
      startedAt: row.startedAt instanceof Date ? row.startedAt.toISOString() : row.startedAt,
      finishedAt: row.finishedAt instanceof Date ? row.finishedAt.toISOString() : row.finishedAt,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt
    });
  }

  async function writeTaskLog(task, stage, message, detail = null) {
    const taskId = String(task?.id || task?.taskId || "").trim();
    const companyId = String(task?.companyId || "system").trim() || "system";
    if (!taskId) return;
    const entry = {
      id: makeId("AITL"),
      taskId,
      companyId,
      stage: String(stage || "event").trim() || "event",
      message: String(message || "").trim() || "任务状态更新",
      detailJson: detail ? JSON.stringify(detail) : "",
      createdAt: new Date().toISOString()
    };
    entry.message = (String(message || "").trim() || "任务状态更新").slice(0, 500);
    if (sqlAvailable()) {
      await getSqlPool().execute(
        `INSERT INTO ai_image_task_logs (id, taskId, companyId, stage, message, detailJson, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [entry.id, entry.taskId, entry.companyId, entry.stage, entry.message, entry.detailJson, toMysqlDateTime(entry.createdAt)]
      );
      return;
    }
    localTaskLogs.push(entry);
    localTaskLogs = localTaskLogs.slice(-5000);
    saveLocalTaskLogs();
  }

  async function recordTaskFailure(task, message) {
    await writeTaskLog(task, 'failed', `AI 图任务失败：${message}`);
    if (typeof onTaskFailed !== 'function') return;
    try {
      await onTaskFailed(task);
    } catch (callbackError) {
      await writeTaskLog(task, 'callback_failed', `失败回调执行异常：${String(callbackError?.message || callbackError)}`);
    }
  }

  async function listTaskLogs(companyId, taskId) {
    if (sqlAvailable()) {
      const [rows] = await getSqlPool().execute(
        `SELECT id, taskId, companyId, stage, message, detailJson, createdAt
         FROM ai_image_task_logs WHERE taskId = ? AND companyId = ? ORDER BY createdAt DESC`,
        [taskId, companyId]
      );
      return rows.map((row) => ({
        ...row,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt
      }));
    }
    return localTaskLogs
      .filter((item) => item.taskId === taskId && item.companyId === companyId)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  async function listForCompany(companyId) {
    if (sqlAvailable()) {
      const [rows] = await getSqlPool().execute(
        `SELECT id, companyId, title, sourceType, sourceId, productId, sourceImageUrl, prompt, modelId, modelName, status, progress, resultImageUrl, errorMessage, notes, metadataJson, requestedBy, startedAt, finishedAt, createdAt, updatedAt
         FROM ai_image_tasks
         WHERE companyId = ?
         ORDER BY updatedAt DESC, createdAt DESC`,
        [companyId]
      );
      return rows.map(mapSqlRow);
    }
    return localTasks
      .filter((item) => item.companyId === companyId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function validatePayload(body, existing = null) {
    const source = body && typeof body === "object" ? body : {};
    const title = String(source.title ?? existing?.title ?? "").trim();
    const sourceImageUrl = String(source.sourceImageUrl ?? existing?.sourceImageUrl ?? "").trim();
    const prompt = String(source.prompt ?? existing?.prompt ?? "").trim();
    const modelId = String(source.modelId ?? existing?.modelId ?? "").trim();
    const modelName = String(source.modelName ?? existing?.modelName ?? "").trim();
    const sourceType = String(source.sourceType ?? existing?.sourceType ?? "product").trim() || "product";
    const sourceId = String(source.sourceId ?? existing?.sourceId ?? "").trim();
    const productId = String(source.productId ?? existing?.productId ?? "").trim();
    const notes = String(source.notes ?? existing?.notes ?? "").trim();
    const metadataJson = String(source.metadataJson ?? existing?.metadataJson ?? "").trim();
    const resultImageUrl = String(source.resultImageUrl ?? existing?.resultImageUrl ?? "").trim();
    const errorMessage = String(source.errorMessage ?? existing?.errorMessage ?? "").trim();

    if (sourceImageUrl && !/^https?:\/\//i.test(sourceImageUrl)) {
      return { ok: false, message: "源图片地址必须是完整的 http/https URL" };
    }
    if (resultImageUrl && !/^https?:\/\//i.test(resultImageUrl)) {
      return { ok: false, message: "结果图片地址必须是完整的 http/https URL" };
    }
    if (metadataJson) {
      try {
        JSON.parse(metadataJson);
      } catch {
        return { ok: false, message: "任务元数据必须是有效 JSON" };
      }
    }

    return {
      ok: true,
      title,
      sourceType,
      sourceId,
      productId,
      sourceImageUrl,
      prompt,
      modelId,
      modelName,
      notes,
      metadataJson,
      resultImageUrl,
      errorMessage
    };
  }

  function requestedBoolean(value, fallback) {
    if (value === true || value === 1 || value === "1" || value === "true") return true;
    if (value === false || value === 0 || value === "0" || value === "false") return false;
    return fallback;
  }

  function isValidTaskTransition(from, to) {
    const source = normalizeStatus(from, "draft");
    const target = normalizeStatus(to, source);
    if (source === target) return true;
    const transitions = {
      draft: new Set(["queued", "canceled"]), queued: new Set(["processing", "canceled"]),
      processing: new Set(["failed", "canceled"]), failed: new Set(["queued", "canceled"]),
      blocked: new Set(["queued", "canceled"]), canceled: new Set(["queued"]), succeeded: new Set(["queued"])
    };
    return Boolean(transitions[source]?.has(target));
  }

  async function createTask(user, body) {
    const companyId = companyIdForUser(user);
    const validation = validatePayload(body);
    if (!validation.ok) return validation;
    const now = new Date().toISOString();
    const requestedTaskCode = String(body?.taskCode || body?.id || "").trim();
    if (requestedTaskCode && !TASK_CODE_PATTERN.test(requestedTaskCode)) {
      return { ok: false, statusCode: 400, message: "任务码格式无效" };
    }
    const taskCode = requestedTaskCode || makeId("AIT");
    const requestedStatus = normalizeStatus(body?.status, "draft");
    if (["succeeded", "processing", "failed"].includes(requestedStatus)) return { ok: false, statusCode: 400, message: "新建任务只能处于草稿或排队状态" };
    if (validation.resultImageUrl) return { ok: false, statusCode: 400, message: "只有成功任务才能设置结果图片" };
    const item = normalizeTask({
      id: taskCode,
      companyId,
      ...validation,
      title: validation.title || taskCode,
      status: requestedStatus,
      progress: clampPercent(body?.progress ?? 0),
      requestedBy: String(user?.username || "").trim(),
      createdAt: now,
      updatedAt: now,
      startedAt: String(body?.startedAt || "").trim(),
      finishedAt: String(body?.finishedAt || "").trim()
    });

    if (sqlAvailable()) {
      try { await getSqlPool().execute(
        `INSERT INTO ai_image_tasks (
          id, companyId, title, sourceType, sourceId, productId, sourceImageUrl, prompt, modelId, modelName, status,
          progress, resultImageUrl, errorMessage, notes, metadataJson, requestedBy, startedAt, finishedAt, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          item.companyId,
          item.title,
          item.sourceType,
          item.sourceId,
          item.productId,
          item.sourceImageUrl,
          item.prompt,
          item.modelId,
          item.modelName,
          item.status,
          item.progress,
          item.resultImageUrl,
          item.errorMessage,
          item.notes,
          item.metadataJson,
          item.requestedBy,
          toMysqlDateTime(item.startedAt),
          toMysqlDateTime(item.finishedAt),
          toMysqlDateTime(item.createdAt),
          toMysqlDateTime(item.updatedAt)
        ]
      ); } catch (error) {
        if (error?.code === "ER_DUP_ENTRY") return { ok: false, statusCode: 409, message: "任务码已存在" };
        throw error;
      }
    } else {
      if (localTasks.some((candidate) => candidate.id === item.id && candidate.companyId === item.companyId)) {
        return { ok: false, statusCode: 409, message: "任务码已存在" };
      }
      localTasks.push(item);
      saveLocalTasks();
    }
    return { ok: true, item };
  }

  async function updateTask(user, id, body) {
    const companyId = companyIdForUser(user);
    const items = await listForCompany(companyId);
    const existing = items.find((item) => item.id === id);
    if (!existing) return { ok: false, statusCode: 404, message: "AI 图任务不存在" };
    const requestedStatus = normalizeStatus(body?.status, existing.status);
    if (body?.status !== undefined && !isValidTaskTransition(existing.status, requestedStatus)) return { ok: false, statusCode: 409, message: "任务状态转换无效" };
    if (requestedStatus === "succeeded") return { ok: false, statusCode: 403, message: "任务结果必须由处理器确认" };
    if (body?.resultImageUrl && requestedStatus !== "succeeded") return { ok: false, statusCode: 400, message: "只有成功任务才能设置结果图片" };
    const validation = validatePayload(body, existing);
    if (!validation.ok) return validation;
    const nextStatus = requestedStatus;
    const now = new Date().toISOString();
    const item = normalizeTask({
      ...existing,
      ...validation,
      status: nextStatus,
      progress: clampPercent(body?.progress ?? existing.progress),
      resultImageUrl: String(body?.resultImageUrl ?? existing.resultImageUrl ?? "").trim(),
      errorMessage: String(body?.errorMessage ?? existing.errorMessage ?? "").trim(),
      requestedBy: String(existing.requestedBy || user?.username || "").trim(),
      startedAt: String(body?.startedAt ?? existing.startedAt ?? "").trim(),
      finishedAt: String(body?.finishedAt ?? existing.finishedAt ?? "").trim(),
      updatedAt: now
    });

    if (sqlAvailable()) {
      await getSqlPool().execute(
        `UPDATE ai_image_tasks
         SET title = ?, sourceType = ?, sourceId = ?, productId = ?, sourceImageUrl = ?, prompt = ?, modelId = ?, modelName = ?, status = ?, progress = ?, resultImageUrl = ?, errorMessage = ?, notes = ?, metadataJson = ?, requestedBy = ?, startedAt = ?, finishedAt = ?, updatedAt = ?
         WHERE id = ? AND companyId = ?`,
        [
          item.title,
          item.sourceType,
          item.sourceId,
          item.productId,
          item.sourceImageUrl,
          item.prompt,
          item.modelId,
          item.modelName,
          item.status,
          item.progress,
          item.resultImageUrl,
          item.errorMessage,
          item.notes,
          item.metadataJson,
          item.requestedBy,
          toMysqlDateTime(item.startedAt),
          toMysqlDateTime(item.finishedAt),
          toMysqlDateTime(item.updatedAt),
          item.id,
          companyId
        ]
      );
    } else {
      localTasks = localTasks.map((candidate) => candidate.id === id && candidate.companyId === companyId ? item : candidate);
      saveLocalTasks();
    }
    return { ok: true, item };
  }

  async function deleteTask(user, id) {
    const companyId = companyIdForUser(user);
    const items = await listForCompany(companyId);
    const existing = items.find((item) => item.id === id);
    if (!existing) return { ok: false, statusCode: 404, message: "AI 图任务不存在" };
    if (sqlAvailable()) {
      await getSqlPool().execute("DELETE FROM ai_image_tasks WHERE id = ? AND companyId = ?", [id, companyId]);
    } else {
      localTasks = localTasks.filter((item) => !(item.id === id && item.companyId === companyId));
      saveLocalTasks();
    }
    return { ok: true };
  }

  async function retryTask(user, id) {
    const companyId = companyIdForUser(user);
    const existing = await findTaskForCompany(companyId, id);
    if (!existing) return { ok: false, statusCode: 404, message: "AI 图任务不存在" };
    const refreshedPrompt = typeof resolvePromptForModel === "function"
      ? await resolvePromptForModel(companyId, String(existing.modelId || "").trim())
      : existing.prompt;
    const result = await updateTask(user, id, {
      // A retry after success uses the already processed image as its next source.
      // This enables unlimited successive background changes for the same product.
      sourceImageUrl: String(existing.resultImageUrl || existing.sourceImageUrl || "").trim(),
      prompt: String(refreshedPrompt || existing.prompt || "").trim(),
      status: "queued",
      progress: 0,
      errorMessage: "",
      resultImageUrl: "",
      finishedAt: "",
      startedAt: ""
    });
    if (result.ok) scheduleWorker(0);
    return result;
  }

  async function findTaskForCompany(companyId, id) {
    const taskCode = String(id || "").trim();
    if (!taskCode) return null;
    if (sqlAvailable()) {
      const [rows] = await getSqlPool().execute(
        `SELECT id, companyId, title, sourceType, sourceId, productId, sourceImageUrl, prompt, modelId, modelName, status, progress, resultImageUrl, errorMessage, notes, metadataJson, requestedBy, startedAt, finishedAt, createdAt, updatedAt
         FROM ai_image_tasks WHERE id = ? AND companyId = ? LIMIT 1`,
        [taskCode, companyId]
      );
      return rows.length ? mapSqlRow(rows[0]) : null;
    }
    return localTasks.find((item) => item.id === taskCode && item.companyId === companyId) || null;
  }

  async function recoverInterruptedProcessingTasks() {
    if (sqlAvailable()) {
      await getSqlPool().execute(
        `UPDATE ai_image_tasks
         SET status = 'queued', progress = 0, errorMessage = '', startedAt = NULL, finishedAt = NULL, updatedAt = ?
         WHERE status = 'processing'`,
        [toMysqlDateTime(new Date())]
      );
      return;
    }
    let changed = false;
    localTasks = localTasks.map((item) => {
      if (item.status !== 'processing') return item;
      changed = true;
      return { ...item, status: 'queued', progress: 0, errorMessage: '', startedAt: '', finishedAt: '', updatedAt: new Date().toISOString() };
    });
    if (changed) saveLocalTasks();
  }

  async function expireTimedOutTasks() {
    const cutoff = new Date(Date.now() - TASK_TIMEOUT_MS);
    if (sqlAvailable()) {
      const [rows] = await getSqlPool().execute(
        `SELECT id, companyId, title, sourceType, sourceId, productId, sourceImageUrl, prompt, modelId, modelName, status, progress, resultImageUrl, errorMessage, notes, metadataJson, requestedBy, startedAt, finishedAt, createdAt, updatedAt
         FROM ai_image_tasks WHERE status = 'processing' AND startedAt IS NOT NULL AND startedAt < ?`,
        [toMysqlDateTime(cutoff)]
      );
      for (const row of rows) {
        const task = mapSqlRow(row);
        const message = `AI 图任务执行超时（${TASK_TIMEOUT_SECONDS} 秒），AI 平台未在时限内返回结果或错误`;
        const now = new Date();
        const [result] = await getSqlPool().execute(
          `UPDATE ai_image_tasks
           SET status = 'failed', errorMessage = ?, finishedAt = ?, updatedAt = ?
           WHERE id = ? AND companyId = ? AND status = 'processing'`,
          [message, toMysqlDateTime(now), toMysqlDateTime(now), task.id, task.companyId]
        );
        if (!result.affectedRows) continue;
        const failed = { ...task, status: 'failed', errorMessage: message, finishedAt: now.toISOString(), updatedAt: now.toISOString() };
        await recordTaskFailure(failed, message);
      }
      return;
    }
    const now = Date.now();
    for (let index = 0; index < localTasks.length; index += 1) {
      const task = localTasks[index];
      if (task.status !== 'processing' || new Date(task.startedAt || 0).getTime() >= now - TASK_TIMEOUT_MS) continue;
      const message = `AI 图任务执行超时（${TASK_TIMEOUT_SECONDS} 秒），AI 平台未在时限内返回结果或错误`;
      const failed = { ...task, status: 'failed', errorMessage: message, finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      localTasks[index] = failed;
      await recordTaskFailure(failed, message);
    }
    saveLocalTasks();
  }

  async function recoverReturnedImageResults() {
    if (!sqlAvailable()) return;
    const [rows] = await getSqlPool().execute(
      `SELECT t.id, t.companyId, t.title, t.sourceType, t.sourceId, t.productId, t.sourceImageUrl, t.prompt,
              t.modelId, t.modelName, t.status, t.progress, t.resultImageUrl, t.errorMessage, t.notes,
              t.metadataJson, t.requestedBy, t.startedAt, t.finishedAt, t.createdAt, t.updatedAt, l.detailJson
       FROM ai_image_tasks t
       INNER JOIN ai_image_task_logs l ON l.taskId = t.id AND l.companyId = t.companyId
       WHERE l.stage = 'result_received' AND t.resultImageUrl = ''
         AND (t.status = 'processing' OR (t.status = 'failed' AND t.errorMessage LIKE 'AI 图任务执行超时%'))
       ORDER BY l.createdAt DESC`
    );
    for (const row of rows) {
      let detail = null;
      try { detail = JSON.parse(String(row.detailJson || '')); } catch {}
      const resultImageUrl = String(detail?.resultImageUrl || '').trim();
      if (!resultImageUrl) continue;
      const task = mapSqlRow(row);
      const now = new Date();
      const [update] = await getSqlPool().execute(
        `UPDATE ai_image_tasks
         SET status = 'succeeded', progress = 100, resultImageUrl = ?, errorMessage = '', notes = ?, finishedAt = ?, updatedAt = ?
         WHERE id = ? AND companyId = ? AND resultImageUrl = ''`,
        [resultImageUrl, detail?.requestId ? `AI requestId: ${detail.requestId}` : task.notes, toMysqlDateTime(now), toMysqlDateTime(now), task.id, task.companyId]
      );
      if (!update.affectedRows) continue;
      const completed = { ...task, status: 'succeeded', progress: 100, resultImageUrl, errorMessage: '', notes: detail?.requestId ? `AI requestId: ${detail.requestId}` : task.notes, finishedAt: now.toISOString(), updatedAt: now.toISOString() };
      if (typeof onTaskSucceeded === 'function') await onTaskSucceeded(completed);
      await writeTaskLog(completed, 'returned', '结果图片已回传 ERP 并更新产品');
    }
  }

  async function reconcileSucceededTaskResults() {
    if (!sqlAvailable() || typeof onTaskSucceeded !== "function") return;
    const [rows] = await getSqlPool().query(
      `SELECT id, companyId, title, sourceType, sourceId, productId, sourceImageUrl, prompt, modelId, modelName,
              status, progress, resultImageUrl, errorMessage, notes, metadataJson, requestedBy,
              startedAt, finishedAt, createdAt, updatedAt
       FROM ai_image_tasks
       WHERE status = 'succeeded' AND resultImageUrl <> ''
       ORDER BY finishedAt DESC, updatedAt DESC`
    );
    for (const row of rows) {
      const task = mapSqlRow(row);
      try {
        const result = await onTaskSucceeded(task);
        if (result?.changed) await writeTaskLog(task, "product_sync_recovered", "已补偿同步 AI 结果图片到刊登产品");
      } catch (error) {
        console.error(`AI image product reconciliation failed for ${task.id}:`, String(error?.message || error));
      }
    }
  }

  async function backfillTaskModelsFromLogs() {
    if (!sqlAvailable()) return;
    const [rows] = await getSqlPool().query(
      `SELECT t.id, t.companyId, l.detailJson
       FROM ai_image_tasks t
       INNER JOIN ai_image_task_logs l ON l.taskId = t.id AND l.companyId = t.companyId
       WHERE l.stage = 'model_request'
         AND (t.modelId = '' OR t.modelName = '')
       ORDER BY l.createdAt DESC`
    );
    const repaired = new Set();
    for (const row of rows) {
      const key = `${row.companyId}:${row.id}`;
      if (repaired.has(key)) continue;
      let detail = null;
      try { detail = JSON.parse(String(row.detailJson || '')); } catch {}
      const modelId = String(detail?.modelId || '').trim();
      const modelName = String(detail?.model || '').trim();
      if (!modelId && !modelName) continue;
      await getSqlPool().execute(
        `UPDATE ai_image_tasks
         SET modelId = CASE WHEN modelId = '' THEN ? ELSE modelId END,
             modelName = CASE WHEN modelName = '' THEN ? ELSE modelName END
         WHERE id = ? AND companyId = ?`,
        [modelId, modelName, row.id, row.companyId]
      );
      repaired.add(key);
    }
  }

  function startProcessingWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => {
      recoverReturnedImageResults()
        .then(() => expireTimedOutTasks())
        .catch((error) => console.error('AI image task watchdog failed:', String(error)));
    }, 15000);
    if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
  }

  async function claimNextQueuedTask() {
    if (sqlAvailable()) {
      const [rows] = await getSqlPool().query(
        `SELECT id, companyId, title, sourceType, sourceId, productId, sourceImageUrl, prompt, modelId, modelName, status, progress, resultImageUrl, errorMessage, notes, metadataJson, requestedBy, startedAt, finishedAt, createdAt, updatedAt
         FROM ai_image_tasks
         WHERE status = 'queued'
         ORDER BY createdAt ASC
         LIMIT 1`
      );
      const task = rows.length ? mapSqlRow(rows[0]) : null;
      if (!task) return null;
      const now = new Date();
      const [result] = await getSqlPool().execute(
        `UPDATE ai_image_tasks
         SET status = 'processing', progress = 10, startedAt = ?, errorMessage = '', updatedAt = ?
         WHERE id = ? AND companyId = ? AND status = 'queued'`,
        [toMysqlDateTime(now), toMysqlDateTime(now), task.id, task.companyId]
      );
      if (!result.affectedRows) return null;
      return { ...task, status: 'processing', progress: 10, startedAt: now.toISOString(), errorMessage: '', updatedAt: now.toISOString() };
    }
    const index = localTasks.findIndex((item) => item.status === 'queued');
    if (index < 0) return null;
    const now = new Date().toISOString();
    const item = { ...localTasks[index], status: 'processing', progress: 10, startedAt: now, errorMessage: '', updatedAt: now };
    localTasks[index] = item;
    saveLocalTasks();
    return item;
  }

  function scheduleWorker(delay = 15000) {
    if (workerStopped) return;
    if (workerTimer) clearTimeout(workerTimer);
    workerTimer = setTimeout(() => {
      workerTimer = null;
      fillWorkerSlots().catch((error) => console.error('AI image task worker failed:', String(error)));
    }, delay);
    if (typeof workerTimer.unref === 'function') workerTimer.unref();
  }

  function runWithTaskTimeout(task, reportEvent) {
    let timer = null;
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), TASK_TIMEOUT_MS);
    return Promise.race([
      Promise.resolve().then(() => runImageTask(task, reportEvent, controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`AI 图任务执行超时（${TASK_TIMEOUT_SECONDS} 秒），AI 平台未在时限内返回结果或错误`)), TASK_TIMEOUT_MS);
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer);
      clearTimeout(abortTimer);
    });
  }

  async function finishProcessingTask(task, patch) {
    const now = new Date().toISOString();
    const item = normalizeTask({
      ...task,
      ...patch,
      finishedAt: now,
      startedAt: task.startedAt || now,
      updatedAt: now
    });
    if (sqlAvailable()) {
      const statement = `UPDATE ai_image_tasks
        SET modelId = ?, modelName = ?, status = ?, progress = ?, resultImageUrl = ?, errorMessage = ?, notes = ?, startedAt = ?, finishedAt = ?, updatedAt = ?
        WHERE id = ? AND companyId = ? AND status = 'processing'`;
      const values = [
        item.modelId, item.modelName, item.status, item.progress, item.resultImageUrl, item.errorMessage, item.notes,
        toMysqlDateTime(item.startedAt), toMysqlDateTime(item.finishedAt), toMysqlDateTime(item.updatedAt), item.id, item.companyId
      ];
      // 任务完成不能被订单同步等长查询占住连接池；单独短连接只用于这一次条件更新。
      let connection = null;
      try {
        connection = await mysql.createConnection(buildTaskMysqlConnectionOptions(process.env, getMysqlPassword()));
        const [result] = await connection.execute(statement, values);
        return result.affectedRows ? { ok: true, item } : { ok: false, message: '任务状态已变更' };
      } finally {
        if (connection) await connection.end();
      }
    }
    const index = localTasks.findIndex((candidate) => candidate.id === item.id && candidate.companyId === item.companyId && candidate.status === 'processing');
    if (index < 0) return { ok: false, message: '任务状态已变更' };
    localTasks[index] = item;
    saveLocalTasks();
    return { ok: true, item };
  }

  async function processClaimedTask(task) {
    try {
      if (typeof runImageTask !== 'function') throw new Error('AI 图任务执行器未加载');
      await writeTaskLog(task, "started", "ERP 已开始执行 AI 图任务");
      const result = await runWithTaskTimeout(task, async (stage, message, detail) => writeTaskLog(task, stage, message, detail));
      if (!result?.ok) throw new Error(String(result?.message || 'AI 图片处理失败'));
      const saved = await finishProcessingTask(task, {
        modelId: String(result.modelId || task.modelId || '').trim(),
        modelName: String(result.modelName || task.modelName || '').trim(),
        status: 'succeeded',
        progress: 100,
        resultImageUrl: String(result.resultImageUrl || '').trim(),
        errorMessage: '',
        notes: String(result.requestId || '').trim() ? `AI requestId: ${result.requestId}` : task.notes
      });
      if (!saved.ok) throw new Error(String(saved.message || '任务结果保存失败'));
      await writeTaskLog(saved.item, "succeeded", "AI 图任务已成功生成结果图片");
      if (typeof onTaskSucceeded === 'function') {
        try {
          await onTaskSucceeded(saved.item);
        } catch (error) {
          await writeTaskLog(saved.item, "callback_failed", `结果图片生成成功，但后续产品更新失败：${String(error?.message || error)}`);
          return;
        }
      }
      await writeTaskLog(saved.item, "returned", "结果图片已回传 ERP 并更新产品");
    } catch (error) {
      const message = String(error?.message || error || 'AI 图片处理失败');
      const failed = await finishProcessingTask(task, { status: 'failed', progress: task.progress || 10, errorMessage: message });
      if (failed.ok) await recordTaskFailure(failed.item, message);
    }
  }

  async function fillWorkerSlots() {
    if (workerStopped || workerFilling) return;
    workerFilling = true;
    let queueWasEmpty = false;
    try {
      while (activeTaskCount < taskConcurrency) {
        const task = await claimNextQueuedTask();
        if (!task) {
          queueWasEmpty = true;
          break;
        }
        activeTaskCount += 1;
        const execution = processClaimedTask(task)
          .catch((error) => console.error('AI image task execution failed:', String(error)))
          .finally(() => {
            activeTaskCount -= 1;
            scheduleWorker(0);
          });
        activeExecutions.add(execution);
        execution.finally(() => activeExecutions.delete(execution));
      }
    } catch (error) {
      scheduleWorker(1000);
      throw error;
    } finally {
      workerFilling = false;
      if (queueWasEmpty && activeTaskCount === 0) scheduleWorker(15000);
    }
  }

  async function shutdown() {
    workerStopped = true;
    if (workerTimer) clearTimeout(workerTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    workerTimer = null;
    watchdogTimer = null;
    await Promise.allSettled([...activeExecutions]);
  }

  function maskRequestBody(body) {
    if (!body || typeof body !== "object") return null;
    const item = body.item && typeof body.item === "object" ? body.item : body;
    return {
      title: String(item.title || "").trim(),
      sourceType: String(item.sourceType || "").trim(),
      sourceId: String(item.sourceId || "").trim(),
      productId: String(item.productId || "").trim(),
      modelId: String(item.modelId || "").trim(),
      status: String(item.status || "").trim()
    };
  }

  function permissionDenied(auth, req, res, auditBase) {
    respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_image_task" }, 403, { message: "无权管理 AI 图任务" });
  }

  async function handleRequest(req, res, url, auditBase) {
    const pathname = url.pathname;
    const logMatch = pathname.match(/^\/api\/ai\/image-tasks\/([^/]+)\/logs$/);
    if (logMatch) {
      const auth = requireAuth(req, res, { ...auditBase, resourceType: "ai_image_task" });
      if (!auth.ok) return true;
      if (!checkPermission(auth.user, "ai.config")) {
        permissionDenied(auth, req, res, auditBase);
        return true;
      }
      if (req.method !== "GET") {
        respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_image_task", resourceId: decodeURIComponent(logMatch[1]) }, 405, { message: "Method not allowed" });
        return true;
      }
      const taskId = decodeURIComponent(logMatch[1]);
      const companyId = companyIdForUser(auth.user);
      const task = await findTaskForCompany(companyId, taskId);
      if (!task) {
        respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_image_task", resourceId: taskId }, 404, { message: "AI 图任务不存在" });
        return true;
      }
      const items = await listTaskLogs(companyId, taskId);
      respondApi(req, res, auth.user, { ...auditBase, actionType: "read", resourceType: "ai_image_task_log", resourceId: taskId }, 200, { items });
      return true;
    }
    const match = pathname.match(/^\/api\/ai\/image-tasks(?:\/([^/]+))?(\/retry)?$/);
    if (!match) return false;
    const auth = requireAuth(req, res, { ...auditBase, resourceType: "ai_image_task" });
    if (!auth.ok) return true;
    const id = match[1] ? decodeURIComponent(match[1]) : "";
    const isRetry = Boolean(match[2]);
    const allowed = checkPermission(auth.user, "ai.config");
    if (!allowed) {
      permissionDenied(auth, req, res, auditBase);
      return true;
    }
    try {
      if (req.method === "GET" && !id) {
        const items = (await listForCompany(companyIdForUser(auth.user))).filter((item) => matchesAiImageTaskQuery(item, url.searchParams));
        respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_image_task" }, 200, { items });
        return true;
      }
      if (req.method === "POST" && !id) {
        const body = await parseJsonBody(req);
        const result = await createTask(auth.user, body?.item || body || {});
        if (!result.ok) {
          respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_image_task", actionType: "create", requestBodyMasked: maskRequestBody(body) }, result.statusCode || 400, { message: result.message });
          return true;
        }
        respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_image_task", actionType: "create", resourceId: result.item.id, requestBodyMasked: maskRequestBody(body) }, 201, { item: result.item });
        return true;
      }
      if (req.method === "PUT" && id && !isRetry) {
        const body = await parseJsonBody(req);
        const result = await updateTask(auth.user, id, body?.item || body || {});
        if (!result.ok) {
          respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_image_task", actionType: "update", resourceId: id, requestBodyMasked: maskRequestBody(body) }, result.statusCode || 400, { message: result.message });
          return true;
        }
        respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_image_task", actionType: "update", resourceId: id, requestBodyMasked: maskRequestBody(body) }, 200, { item: result.item });
        return true;
      }
      if (req.method === "POST" && id && isRetry) {
        const result = await retryTask(auth.user, id);
        if (!result.ok) {
          respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_image_task", actionType: "retry", resourceId: id }, result.statusCode || 400, { message: result.message });
          return true;
        }
        respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_image_task", actionType: "retry", resourceId: id }, 200, { item: result.item });
        return true;
      }
      if (req.method === "DELETE" && id) {
        const result = await deleteTask(auth.user, id);
        if (!result.ok) {
          respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_image_task", actionType: "delete", resourceId: id }, result.statusCode || 400, { message: result.message });
          return true;
        }
        respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_image_task", actionType: "delete", resourceId: id }, 200, { message: "AI 图任务已删除" });
        return true;
      }
      respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_image_task", resourceId: id }, 405, { message: "Method not allowed" });
      return true;
    } catch (error) {
      respondApi(req, res, auth.user, { ...auditBase, resourceType: "ai_image_task", resourceId: id }, 500, { message: "AI 图任务处理失败" });
      return true;
    }
  }

  async function createSystemTask(input = {}) {
    const companyId = String(input.companyId || "system").trim() || "system";
    const systemUser = { companyId, username: "collector" };
    const taskCode = String(input.taskCode || input.id || "").trim();
    const existing = taskCode ? await findTaskForCompany(companyId, taskCode) : null;
    const result = existing
      ? await updateTask(systemUser, existing.id, {
          ...input,
          title: existing.id,
          status: "queued",
          progress: 0,
          errorMessage: "",
          resultImageUrl: "",
          startedAt: "",
          finishedAt: ""
        })
      : await createTask(systemUser, { ...input, title: taskCode || undefined, status: "queued" });
    if (result.ok) {
      await writeTaskLog(result.item, "task_code_ready", `ERP 已生成任务码 ${result.item.id}`);
      scheduleWorker(0);
    }
    return result;
  }

  return { initialize, handleRequest, createSystemTask, shutdown };
}

module.exports = { buildTaskMysqlConnectionOptions, createAiImageTasksModule, matchesAiImageTaskQuery, resolveTaskConcurrency };
