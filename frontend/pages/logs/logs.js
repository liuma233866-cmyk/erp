function onLogsFilterSubmit(event) {
  event.preventDefault();
  state.logsCurrentPage = 1;
  loadLogs();
}

function onLogsFilterReset() {
  logsFilterForm.reset();
  state.logsCurrentPage = 1;
  loadLogs();
}

async function loadLogs() {
  logsMessage.style.color = "#c02030";
  logsMessage.textContent = "";
  if (!canAuditRead()) {
    logsTableBody.innerHTML = "<tr><td colspan='9'>仅管理员可查看</td></tr>";
    if (logCheckerSummary) logCheckerSummary.innerHTML = "<div class='log-checker-empty'>仅管理员可查看</div>";
    state.logs = [];
    renderLogsPagination();
    return false;
  }

  const form = new FormData(logsFilterForm);
  const params = new URLSearchParams();
  ["username", "actionType", "path", "statusCode", "dateFrom", "dateTo"].forEach((key) => {
    const value = String(form.get(key) || "").trim();
    if (value) params.set(key, value);
  });

  const query = params.toString();
  logsTableBody.innerHTML = "<tr><td colspan='9'>加载中...</td></tr>";
  const result = await apiRequest(`/api/audit-logs${query ? `?${query}` : ""}`, { method: "GET" });
  if (!result.ok) {
    logsMessage.textContent = result.error || "日志加载失败";
    logsTableBody.innerHTML = "<tr><td colspan='9'>加载失败</td></tr>";
    state.logs = [];
    renderLogsPagination();
    return false;
  }

  state.logs = (result.data.items || []).slice().reverse();
  renderLogsTable();
  renderLogsPagination();
  await loadLogChecker(true);
  return true;
}

function renderLogCheckerEmpty(message) {
  if (!logCheckerSummary) return;
  logCheckerSummary.innerHTML = `<div class="log-checker-empty">${escapeHtml(message || "暂无诊断结果")}</div>`;
}

function renderLogCheckerSummary(payload) {
  if (!logCheckerSummary) return;
  const data = payload && typeof payload === "object" ? payload : {};
  const summary = data.summary || {};
  const issues = Array.isArray(data.issues) ? data.issues : [];
  if (!issues.length) {
    renderLogCheckerEmpty("最近没有检测到需要处理的错误");
    return;
  }
  const metrics = `
    <div class="log-checker-metrics">
      <div class="log-checker-metric"><span>检查窗口</span><strong>${escapeHtml(String(summary.hours || 24))}h</strong></div>
      <div class="log-checker-metric"><span>问题类型</span><strong>${escapeHtml(String(summary.issueCount || issues.length))}</strong></div>
      <div class="log-checker-metric"><span>错误记录</span><strong>${escapeHtml(String(summary.errorCount || 0))}</strong></div>
      <div class="log-checker-metric"><span>警告记录</span><strong>${escapeHtml(String(summary.warningCount || 0))}</strong></div>
    </div>
  `;
  const cards = issues
    .map((issue) => {
      const severity = String(issue.severity || "medium");
      const examples = Array.isArray(issue.examples) ? issue.examples : [];
      return `
        <article class="log-checker-card">
          <h4>${escapeHtml(issue.title || "未命名问题")}</h4>
          <div class="log-checker-meta">
            <span class="log-checker-badge severity-${escapeHtml(severity)}">${escapeHtml(severity.toUpperCase())}</span>
            <span class="log-checker-badge">出现 ${escapeHtml(String(issue.count || 0))} 次</span>
            <span class="log-checker-badge">最近 ${escapeHtml(issue.latestAt ? new Date(issue.latestAt).toLocaleString("zh-CN") : "-")}</span>
          </div>
          <div class="log-checker-lines">
            <div>说明：${escapeHtml(issue.description || "-")}</div>
            <div>建议：${escapeHtml(issue.suggestion || "-")}</div>
            ${examples[0] ? `<code>${escapeHtml(String(examples[0]))}</code>` : ""}
          </div>
        </article>
      `;
    })
    .join("");
  logCheckerSummary.innerHTML = `${metrics}<div class="log-checker-grid">${cards}</div>`;
}

async function loadLogChecker(silent = false) {
  if (!canAuditRead()) {
    renderLogCheckerEmpty("仅管理员可查看");
    return;
  }
  if (!silent) {
    renderLogCheckerEmpty("正在检查最近错误...");
  }
  const result = await apiRequest("/api/log-checker?hours=24", { method: "GET" });
  if (!result.ok) {
    renderLogCheckerEmpty(result.error || "日志检查失败");
    return;
  }
  renderLogCheckerSummary(result.data);
}

function getCurrentLogsPageItems() {
  const start = (state.logsCurrentPage - 1) * LOGS_PAGE_SIZE;
  return state.logs.slice(start, start + LOGS_PAGE_SIZE);
}

function renderLogsTable() {
  const items = getCurrentLogsPageItems();
  if (!items.length) {
    logsTableBody.innerHTML = "<tr><td colspan='9'>暂无日志</td></tr>";
    return;
  }

  logsTableBody.innerHTML = items
    .map((log) => {
      const warningText = log.errorMessage || log.warningMessage || "";
      return `<tr>
        <td>${new Date(log.ts).toLocaleString("zh-CN")}</td>
        <td>${escapeHtml(log.actorUsername || "")}</td>
        <td>${escapeHtml(getRoleLabel(log.actorRole || ""))}</td>
        <td>${escapeHtml(log.actionType || "")}</td>
        <td>${escapeHtml(log.method || "")}</td>
        <td>${escapeHtml(log.path || "")}</td>
        <td>${escapeHtml(String(log.statusCode || ""))}</td>
        <td>${log.success ? "Yes" : "No"}</td>
        <td>${escapeHtml(warningText)}</td>
      </tr>`;
    })
    .join("");
}

function renderLogsPagination() {
  const total = state.logs.length;
  const totalPages = Math.max(1, Math.ceil(total / LOGS_PAGE_SIZE));
  if (state.logsCurrentPage > totalPages) state.logsCurrentPage = totalPages;

  logsPaginationInfo.textContent = `第 ${state.logsCurrentPage} / ${totalPages} 页，共 ${total} 条`;
  prevLogsPageBtn.disabled = state.logsCurrentPage <= 1;
  nextLogsPageBtn.disabled = state.logsCurrentPage >= totalPages;
}

function changeLogsPage(nextPage) {
  const totalPages = Math.max(1, Math.ceil(state.logs.length / LOGS_PAGE_SIZE));
  if (nextPage < 1 || nextPage > totalPages) return;
  state.logsCurrentPage = nextPage;
  renderLogsTable();
  renderLogsPagination();
}

// 从 app.js 下沉的 DOM 常量与事件绑定。

const logsFilterForm = document.getElementById("logsFilterForm");
const resetLogsFilterBtn = document.getElementById("resetLogsFilterBtn");
const refreshLogsBtn = document.getElementById("refreshLogsBtn");
const runLogCheckerBtn = document.getElementById("runLogCheckerBtn");
const logsMessage = document.getElementById("logsMessage");
const logsTableBody = document.getElementById("logsTableBody");
const logCheckerSummary = document.getElementById("logCheckerSummary");
const prevLogsPageBtn = document.getElementById("prevLogsPageBtn");
const nextLogsPageBtn = document.getElementById("nextLogsPageBtn");
const logsPaginationInfo = document.getElementById("logsPaginationInfo");

function bindLogsEvents() {
  if (refreshLogsBtn) refreshLogsBtn.addEventListener("click", loadLogs);
  if (runLogCheckerBtn) runLogCheckerBtn.addEventListener("click", loadLogChecker);
  if (logsFilterForm) logsFilterForm.addEventListener("submit", onLogsFilterSubmit);
  if (resetLogsFilterBtn) resetLogsFilterBtn.addEventListener("click", onLogsFilterReset);
  if (prevLogsPageBtn) prevLogsPageBtn.addEventListener("click", () => changeLogsPage(state.logsCurrentPage - 1));
  if (nextLogsPageBtn) nextLogsPageBtn.addEventListener("click", () => changeLogsPage(state.logsCurrentPage + 1));
}
