async function loadMessages() {
  messagesMessage.textContent = "";
  if (!canMessageRead()) {
    messagesTableBody.innerHTML = "<tr><td colspan='4'>无权限查看</td></tr>";
    state.messages = [];
    return false;
  }

  messagesTableBody.innerHTML = "<tr><td colspan='4'>加载中...</td></tr>";
  const result = await apiRequest("/api/messages", { method: "GET" });
  if (!result.ok) {
    messagesTableBody.innerHTML = `<tr><td colspan="4">${escapeHtml(result.error || "消息加载失败")}</td></tr>`;
    state.messages = [];
    return false;
  }

  state.messages = result.data.items || [];
  renderMessagesTable();
  return true;
}

function renderMessagesTable() {
  if (!state.messages.length) {
    messagesTableBody.innerHTML = "<tr><td colspan='4'>暂无消息</td></tr>";
    return;
  }

  messagesTableBody.innerHTML = state.messages
    .map((item) => {
      const by = item.createdBy?.username || "-";
      return `<tr>
        <td>${escapeHtml(item.title || "")}</td>
        <td>${escapeHtml(item.content || "")}</td>
        <td>${escapeHtml(by)}</td>
        <td>${new Date(item.createdAt).toLocaleString("zh-CN")}</td>
      </tr>`;
    })
    .join("");
}

async function onAddMessageSubmit(event) {
  event.preventDefault();
  messagesMessage.style.color = "#c02030";
  messagesMessage.textContent = "";
  if (!can("messageCreate")) {
    messagesMessage.textContent = "无权限操作";
    return;
  }

  const form = new FormData(addMessageForm);
  const title = String(form.get("title") || "").trim();
  const content = String(form.get("content") || "").trim();
  if (!title) {
    messagesMessage.textContent = "标题不能为空";
    return;
  }
  if (!content) {
    messagesMessage.textContent = "内容不能为空";
    return;
  }

  const result = await apiRequest("/api/messages", { method: "POST", body: JSON.stringify({ title, content }) });
  if (!result.ok) {
    messagesMessage.textContent = result.error || "创建失败";
    return;
  }

  addMessageForm.reset();
  messagesMessage.style.color = "#1d6f3a";
  messagesMessage.textContent = "消息已创建";
  await loadMessages();
}

// 从 app.js 下沉的 DOM 常量与事件绑定。

const refreshMessagesBtn = document.getElementById("refreshMessagesBtn");
const addMessageForm = document.getElementById("addMessageForm");
const messagesMessage = document.getElementById("messagesMessage");
const messagesTableBody = document.getElementById("messagesTableBody");

function bindMessagesEvents() {
  if (refreshMessagesBtn) refreshMessagesBtn.addEventListener("click", loadMessages);
  if (addMessageForm) addMessageForm.addEventListener("submit", onAddMessageSubmit);
}
