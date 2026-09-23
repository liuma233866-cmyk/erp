const fs = require("fs");
const path = require("path");

const APP_ROOT = path.resolve(__dirname, "..");
const LOG_DIR = path.resolve(APP_ROOT, String(process.env.LOG_DIR || APP_ROOT));
const APP_LOG_FILE = path.join(LOG_DIR, "server.out.log");
const LOG_LINE_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+/;

// 从 server.js 拆出的日志检查器（审计日志归类 + 本地错误日志读取）。

function formatAuditWarnings(payload) {
  const errors = payload && Array.isArray(payload.errors) ? payload.errors : [];
  if (!errors.length) return "";
  return errors
    .map((err) => {
      if (!err) return "";
      if (typeof err === "string") return err;
      const shopId = err.shopId ? `店铺${err.shopId}` : "";
      const shopName = err.shopName ? `店铺${err.shopName}` : "";
      const prefix = shopId || shopName;
      const msg = err.message || err.error || "";
      if (prefix && msg) return `${prefix}: ${msg}`;
      if (prefix) return prefix;
      if (msg) return msg;
      try {
        return JSON.stringify(err);
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join(" | ");
}

function sanitizeProductPublishAuditPayload(auditMeta, value) {
  if (!value || String(auditMeta?.resourceType || "") !== "product_publish") return value || null;
  const actionType = String(auditMeta?.actionType || "");
  if (actionType === "update") {
    const item = value?.item && typeof value.item === "object" ? value.item : value;
    return { changedFields: item && typeof item === "object" ? Object.keys(item).filter((key) => key !== "id") : [] };
  }
  if (actionType === "publish") return { recorded: true };
  if (actionType === "delete") return { deleted: true };
  if (actionType === "copy") return { copied: true, aiTaskCreated: Boolean(value?.aiTaskId) };
  if (actionType === "ai_image") return { status: String(value?.status || (value?.errorMessage ? "failed" : "recorded")) };
  return { recorded: true };
}

function sanitizeAuditLogForClient(log) {
  if (!log || String(log.resourceType || "") !== "product_publish") return log;
  const requestSummary = sanitizeProductPublishAuditPayload(log, log.requestBodyMasked);
  const changedFields = Array.isArray(requestSummary?.changedFields) ? requestSummary.changedFields : [];
  const recordText = changedFields.length ? `修改字段：${changedFields.join("、")}` : "";
  return {
    ...log,
    requestBodyMasked: null,
    responseBodyMasked: null,
    recordText
  };
}

function readLocalLogTail(filename, maxChars = 4000) {
  try {
    const filePath = path.join(LOG_DIR, filename);
    if (!fs.existsSync(filePath)) return "";
    const text = fs.readFileSync(filePath, "utf8");
    if (!text) return "";
    return text.slice(-maxChars);
  } catch {
    return "";
  }
}

function getLatestServerStartTime() {
  try {
    if (!fs.existsSync(APP_LOG_FILE)) return 0;
    const text = fs.readFileSync(APP_LOG_FILE, "utf8");
    const matches = text.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) Server running at http:\/\/.+$/gm);
    if (!matches || !matches.length) return 0;
    let latest = 0;
    for (const line of matches) {
      const ts = new Date(String(line).split(" ")[0]).getTime();
      if (Number.isFinite(ts) && ts > latest) latest = ts;
    }
    return latest;
  } catch {
    return 0;
  }
}

function stripLogBom(text) {
  return String(text || "").replace(/^\uFEFF/, "");
}

function extractFreshLogEntries(text, sinceTs) {
  const kept = [];
  let keepContinuation = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    const tsText = line.match(LOG_LINE_TIMESTAMP_RE);
    if (!tsText) {
      if (keepContinuation && line.trim()) kept.push(line);
      continue;
    }
    const ts = new Date(tsText[1]).getTime();
    keepContinuation = Number.isFinite(ts) && ts >= sinceTs;
    if (keepContinuation) kept.push(line);
  }
  return kept.join("\n");
}

function readRecentLocalErrorTail(filename, sinceTs = 0, maxChars = 4000) {
  try {
    const filePath = path.join(LOG_DIR, filename);
    if (!fs.existsSync(filePath)) return "";
    const text = stripLogBom(fs.readFileSync(filePath, "utf8"));
    if (!text.trim()) return "";
    if (!sinceTs) return text.slice(-maxChars);
    const recentText = extractFreshLogEntries(text, sinceTs);
    return recentText ? recentText.slice(-maxChars) : "";
  } catch {
    return "";
  }
}

function createIssueBucket(type, severity, title, description, suggestion) {
  return {
    type,
    severity,
    title,
    description,
    suggestion,
    count: 0,
    latestAt: "",
    examples: []
  };
}

function upsertIssue(map, key, config, sample, ts) {
  if (!map.has(key)) {
    map.set(key, createIssueBucket(key, config.severity, config.title, config.description, config.suggestion));
  }
  const item = map.get(key);
  item.count += 1;
  if (!item.latestAt || new Date(ts).getTime() > new Date(item.latestAt).getTime()) {
    item.latestAt = ts;
  }
  if (sample && item.examples.length < 3 && !item.examples.includes(sample)) {
    item.examples.push(sample);
  }
}

function analyzeAuditLogIssue(log) {
  const text = `${log.errorMessage || ""} ${log.warningMessage || ""}`.trim();
  const sample = `${log.method || ""} ${log.path || ""} | ${text}`.trim();
  const rules = [
    {
      key: "unauthorized",
      test: () => Number(log.statusCode || 0) === 401 || /unauthorized/i.test(text),
      severity: "medium",
      title: "未授权请求过多",
      description: "有接口在没有有效登录态或令牌时被调用。",
      suggestion: "检查前端登录态是否失效，或确认脚本请求是否带了正确鉴权。"
    },
    {
      key: "order_sync_running",
      test: () => /order sync already running/i.test(text),
      severity: "low",
      title: "订单同步重复触发",
      description: "同一时间重复点击了同步，后端正在执行中的任务被再次触发。",
      suggestion: "避免连续点击同步按钮，必要时给前端加禁用态或进度提示。"
    },
    {
      key: "quality_gate_block",
      test: () => /卡片质量分低于|卡片质量拦截/i.test(text),
      severity: "low",
      title: "卡片质量门槛拦截（正常防护）",
      description: "新刊登的卡片质量分低于设置的下限，已被自动拦截，未发布到 Yandex。",
      suggestion: "完善卡片内容后刷新卡片质量分，达到下限后再刊登；这是预期防护，不是系统故障。"
    },
    {
      key: "network_fetch_failed",
      test: () => /fetch failed|network error|request failed/i.test(text),
      severity: "high",
      title: "外部接口网络失败",
      description: "请求外部平台时发生网络或 TLS 连接失败。",
      suggestion: "重点检查目标平台连通性、DNS/TLS、代理和重试策略。"
    },
    {
      key: "deprecated_api",
      test: () => /NO_ACCESS_BY_DEPRECATION_POLICY|deprecated/i.test(text),
      severity: "high",
      title: "调用了已废弃接口",
      description: "外部平台返回接口弃用错误，当前对接方式需要升级。",
      suggestion: "替换为平台最新接口版本，不要继续依赖旧路径。"
    },
    {
      key: "order_not_found",
      test: () => {
        if (!/order not found/i.test(text)) return false;
        const method = String(log.method || "").toUpperCase();
        const pathText = String(log.path || "");
        // 变更类请求（更新/采购/作废等）找不到订单属于真实引用失配，照常告警。
        if (method !== "GET") return true;
        // 只读 GET 的 404 常来自占位探针（如 ORD-NOPE）；只有引用形状像
        // 真实订单号（稳定 ID / 历史种子 ID / 纯数字 ID）时才需要告警。
        const ref = decodeURIComponent(pathText.split("/")[3] || "");
        return (
          /^ORD-(YM|OZ)-/i.test(ref) ||
          /^ORD-\d{8}-\d+$/.test(ref) ||
          /^ORD-[A-Z0-9]+-[A-F0-9]{4}$/.test(ref) ||
          /^\d+$/.test(ref)
        );
      },
      severity: "medium",
      title: "订单引用失配",
      description: "订单更新或采购保存时，后端没有找到对应记录。",
      suggestion: "检查传入的订单号、店铺号和本地主键映射是否一致。"
    },
    {
      key: "publish_validation",
      test: () => /must be greater than 0|required|格式无效|invalid/i.test(text) && /publish|stock|brand|title|sku/i.test(`${text} ${log.path || ""}`),
      severity: "medium",
      title: "发布或同步参数校验失败",
      description: "请求参数缺失或格式不合法，被后端直接拦截。",
      suggestion: "先检查库存、品牌、SKU、图片、时间参数等必填字段。"
    },
    {
      key: "ai_provider_failure",
      test: () => /ai 图任务|ai 平台|ai 图片|provider_error|\/ai-image/i.test(`${text} ${log.path || ""}`),
      severity: "medium",
      title: "AI 图片平台处理失败",
      description: "AI 图片平台返回错误，或未在任务时限内返回结果。",
      suggestion: "查看 AI 图片任务日志中的平台状态码、错误码、请求 ID 和错误消息后重试。"
    },
    {
      key: "server_5xx",
      test: () => Number(log.statusCode || 0) >= 500,
      severity: "high",
      title: "服务端 5xx 错误",
      description: "后端处理请求时发生了未预期异常。",
      suggestion: "优先查看同时间段错误详情，定位具体接口和异常栈。"
    }
  ];
  for (const rule of rules) {
    if (rule.test()) {
      return { key: rule.key, config: rule, sample };
    }
  }
  if (!text) return null;
  return {
    key: "other_issue",
    config: {
      severity: "medium",
      title: "其他异常或警告",
      description: "发现未归类的问题日志。",
      suggestion: "查看最近样例，必要时补充新的日志规则。"
    },
    sample
  };
}

function buildLogCheckerReport(recentIssues, hours = 24) {
  const issueMap = new Map();
  let errorCount = 0;
  let warningCount = 0;

  for (const log of recentIssues) {
    if (!log.success) errorCount += 1;
    if (String(log.warningMessage || "").trim()) warningCount += 1;
    const analyzed = analyzeAuditLogIssue(log);
    if (!analyzed) continue;
    upsertIssue(issueMap, analyzed.key, analyzed.config, analyzed.sample, log.ts);
  }

  const recentServerStart = getLatestServerStartTime();
  // startup_err.log is never written by this codebase; monitoring it was dead
  // weight. Only server.err.log (written by logError) carries local errors.
  const localErrorText = readRecentLocalErrorTail("server.err.log", recentServerStart);
  if (localErrorText) {
    upsertIssue(
      issueMap,
      "local_error_log",
      {
        severity: "high",
        title: "本地错误日志有内容",
        description: "服务本地错误日志存在输出，说明进程最近出现过异常或启动问题。",
        suggestion: "优先查看最近错误日志内容，并和审计日志时间对齐。"
      },
      localErrorText.slice(-400),
      new Date().toISOString()
    );
  }

  const issues = Array.from(issueMap.values()).sort((a, b) => {
    const severityRank = { high: 3, medium: 2, low: 1 };
    const sa = severityRank[a.severity] || 0;
    const sb = severityRank[b.severity] || 0;
    if (sa !== sb) return sb - sa;
    if (a.count !== b.count) return b.count - a.count;
    return new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime();
  });

  return {
    summary: {
      hours,
      issueCount: issues.length,
      errorCount,
      warningCount
    },
    issues
  };
}

module.exports = {
  analyzeAuditLogIssue,
  buildLogCheckerReport,
  createIssueBucket,
  extractFreshLogEntries,
  formatAuditWarnings,
  getLatestServerStartTime,
  readLocalLogTail,
  readRecentLocalErrorTail,
  sanitizeAuditLogForClient,
  sanitizeProductPublishAuditPayload,
  stripLogBom,
  upsertIssue,
};
