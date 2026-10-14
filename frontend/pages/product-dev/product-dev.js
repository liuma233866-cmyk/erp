// ============================================================================
// 商品管理 · 前端工作台（目录/面板 id 仍沿用 product-dev / productDevPanel，改名只改用户可见文案）
// ----------------------------------------------------------------------------
// 唯一接口依据：PRODUCT_DEV_API_CONTRACT.md（含 §10 v1.2 / §11 v1.3 增量决议）；
// 本文件不新增、不修改接口形状。
// 复用现有约定：apiRequest（shared/core/api.js，401 统一清登录态）、switchPanel（router.js）、
// escapeHtml / formatDateTime（shared/core/ui.js）；面板一次性加载标记沿用 state.panelLoaded.productDev。
//
// §11.4 错误展示规范（硬约束）：
//   非 2xx 一律显示「可读文案 + 状态码」，绝不把服务端原始 message 直接展示；
//   原始 message 只进 title 属性 / 折叠的「技术详情」区。401 沿用现有清登录态逻辑。
// §11.2 / §11.3 / §11.5 “缺什么”：
//   计数用接口 13，筛选直接用接口 1 的 ?missing=noSource,noActivePrice（服务端 AND 精确过滤）；
//   列表项用服务端返回的 item.missing[]（顺序固定）渲染，前端不自己推算、不再“扫 300 条 + 近似判定”。
//   后端未挂载时降级为「只展示 + 明确提示数据不完整」，不给出会漏判的结论。
//
// 本地 mock 自测（后端未就绪时）：
//   a) 地址后加 ?pdevMock=1     例如 http://127.0.0.1:3080/?pdevMock=1
//   b) 或 localStorage.setItem("pdev_mock", "1") 后刷新
//   开启后内置 mock 覆盖全部 13 个接口（含 §11 列表 missing 字段与 missing 过滤、
//   400+missing、409 占用 PD_xxx、409 版本冲突），用于在真实后端挂载前自测交互。
// ============================================================================

const PDEV_API = "/api/product-dev";

const PDEV_STATUS_ORDER = ["new", "developing", "info_ready", "finalized", "archived"];

const PDEV_STATUS_LABEL = {
  new: "新建",
  developing: "开发中",
  info_ready: "资料齐备",
  finalized: "已定稿",
  archived: "已归档"
};

// 契约 §4 状态机：目标状态 → 允许的来源状态
const PDEV_ALLOWED_FROM = {
  developing: ["new"],
  info_ready: ["new", "developing"],
  finalized: ["info_ready"],
  archived: ["new", "developing", "info_ready", "finalized"]
};

// 按钮悬停说明：只讲「推进到该状态需要什么」，不出现状态机术语与字段名。
const PDEV_TRANSITION_RULE = {
  developing: "开始开发，没有额外要求",
  info_ready: "需至少 1 条在售且有供货价的货源，以及至少 1 张主图",
  finalized: "需至少 1 个变体",
  archived: "任意状态都可归档；归档后不能再流转"
};

// §10.3 / §11.5：missing token 与 §5.1 同名
// （原 PDEV_MISSING_ORDER / PDEV_MISSING_CHIP_LABEL 只服务于已移除的「缺什么」看板，一并删除）
const PDEV_MISSING_SHORT = {
  noSource: "货源",
  noActivePrice: "价格",
  noMainAsset: "主图",
  noVariant: "变体"
};

// §11.5 精确判定口径（服务端与 §4 硬校验同源；前端只做文案，不自己推算）
const PDEV_MISSING_DESC = {
  noSource: "没有挂任何货源",
  noActivePrice: "没有「在售且填了供货价」的货源",
  noMainAsset: "没有主图",
  noVariant: "没有变体"
};

const PDEV_PLATFORM_LABEL = { 1688: "1688", taobao: "淘宝/天猫", ozon: "Ozon", other: "其他" };
const PDEV_SOURCE_STATUS_LABEL = { active: "在售", out_of_stock: "缺货", discontinued: "停产", unknown: "未知" };
const PDEV_SOURCE_STATUS_OPTIONS = ["active", "out_of_stock", "discontinued", "unknown"];
const PDEV_ASSET_TYPE_LABEL = { main: "主图", gallery: "轮播图", detail: "详情图", ai: "AI图" };
const PDEV_ASSET_TYPE_OPTIONS = ["main", "gallery", "detail", "ai"];

// 未知/新增 token 也能给出人话（原始 token 一并展示，不丢信息）
const PDEV_MISSING_RULES = [
  [/source|supply|货源/i, "缺少可用货源：至少要挂 1 条在售且有供货价的货源"],
  [/price|价格/i, "货源缺少供货价：给在售货源填上供货价"],
  [/main|asset|image|主图|图片/i, "缺少主图：至少要 1 张主图"],
  [/variant|spec|变体|规格/i, "缺少变体：至少要 1 个变体"]
];

const PDEV_WAITING_NOTICE = "数据加载不完整";

const pdevState = {
  ownerKey: "",
  loaded: false,
  loading: false,
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
  statusFilter: "",
  keyword: "",
  // 本次搜索里"后端暂不支持"的字段（商品SKU 模糊 / 商品名称 精准）：用于如实说明未生效，而不是假装过滤了
  searchPending: [],
  // 勾选框选中的产品编号（只存状态，尚未接任何批量操作）
  selectedIds: [],
  gaps: [], // 已选的 missing token（多选 = AND，§11.2）；「缺什么」看板已移除，目前恒为空
  backend: {
    attempted: false,
    listOk: false
  },
  selectedPublicId: "",
  detail: null,
  detailLoading: false
};

// ---------------------------------------------------------------------------
// DOM 常量（片段由 index.html 的 SSI include 内联，脚本在页面底部执行）
// ---------------------------------------------------------------------------
const pdevBackendNotice = document.getElementById("pdevBackendNotice");
const pdevRefreshBtn = document.getElementById("pdevRefreshBtn");
const pdevToggleCreateBtn = document.getElementById("pdevToggleCreateBtn");
const pdevCreateForm = document.getElementById("pdevCreateForm");
const pdevCreateTitle = document.getElementById("pdevCreateTitle");
const pdevCreateCategory = document.getElementById("pdevCreateCategory");
const pdevCreatePlatform = document.getElementById("pdevCreatePlatform");
const pdevCreateRemark = document.getElementById("pdevCreateRemark");
const pdevCreateMsg = document.getElementById("pdevCreateMsg");
const pdevCancelCreateBtn = document.getElementById("pdevCancelCreateBtn");
const pdevCreateModalMask = document.getElementById("pdevCreateModalMask");
const pdevCloseCreateBtn = document.getElementById("pdevCloseCreateBtn");
// 搜索：商品SKU / 商品名称（「价格」筛选已按需求移除，后续再加）
const pdevSearchForm = document.getElementById("pdevSearchForm");
const pdevSearchSku = document.getElementById("pdevSearchSku");
const pdevSearchSkuMode = document.getElementById("pdevSearchSkuMode");
const pdevSearchTitle = document.getElementById("pdevSearchTitle");
const pdevSearchTitleMode = document.getElementById("pdevSearchTitleMode");
const pdevSearchResetBtn = document.getElementById("pdevSearchResetBtn");
// 结果区沿用原来的列表渲染/分页/点选逻辑：这里把常量指到新容器即可
// （原来的 pdevListMeta / pdevList / pdevPager 元素已按要求移除；"共 N 条"那行也已删除）
const pdevList = document.getElementById("pdevSearchResults");
const pdevPager = document.getElementById("pdevSearchPager");
const pdevSelectAll = document.getElementById("pdevSelectAll");
// 日志弹窗
const pdevLogModalMask = document.getElementById("pdevLogModalMask");
const pdevLogModalTitle = document.getElementById("pdevLogModalTitle");
const pdevLogRows = document.getElementById("pdevLogRows");
const pdevLogHint = document.getElementById("pdevLogHint");
const pdevCloseLogBtn = document.getElementById("pdevCloseLogBtn");
const pdevMockBadge = document.getElementById("pdevMockBadge");
const pdevDetail = document.getElementById("pdevDetail");
const pdevDetailPublicId = document.getElementById("pdevDetailPublicId");
const pdevDetailTitle = document.getElementById("pdevDetailTitle");
const pdevDetailMeta = document.getElementById("pdevDetailMeta");
const pdevDetailStatus = document.getElementById("pdevDetailStatus");
const pdevDetailReloadBtn = document.getElementById("pdevDetailReloadBtn");
const pdevDetailMessage = document.getElementById("pdevDetailMessage");
const pdevFlowHint = document.getElementById("pdevFlowHint");
const pdevStatusActions = document.getElementById("pdevStatusActions");
const pdevMissingBox = document.getElementById("pdevMissingBox");
const pdevProductForm = document.getElementById("pdevProductForm");
const pdevProductTitle = document.getElementById("pdevProductTitle");
const pdevProductCategory = document.getElementById("pdevProductCategory");
const pdevProductPlatform = document.getElementById("pdevProductPlatform");
const pdevProductOwner = document.getElementById("pdevProductOwner");
const pdevProductRemark = document.getElementById("pdevProductRemark");
const pdevProductFormMsg = document.getElementById("pdevProductFormMsg");
const pdevDeleteProductBtn = document.getElementById("pdevDeleteProductBtn");
const pdevSourceList = document.getElementById("pdevSourceList");
const pdevSourceForm = document.getElementById("pdevSourceForm");
const pdevSourceUrl = document.getElementById("pdevSourceUrl");
const pdevParseSourceUrlBtn = document.getElementById("pdevParseSourceUrlBtn");
const pdevSourcePlatform = document.getElementById("pdevSourcePlatform");
const pdevSourceProductId = document.getElementById("pdevSourceProductId");
const pdevSourcePrice = document.getElementById("pdevSourcePrice");
const pdevSourceCurrency = document.getElementById("pdevSourceCurrency");
const pdevSourceMoq = document.getElementById("pdevSourceMoq");
const pdevSourceSupplier = document.getElementById("pdevSourceSupplier");
const pdevSourceStatus = document.getElementById("pdevSourceStatus");
const pdevSourceFormMsg = document.getElementById("pdevSourceFormMsg");
const pdevAssetList = document.getElementById("pdevAssetList");
const pdevAssetForm = document.getElementById("pdevAssetForm");
const pdevAssetType = document.getElementById("pdevAssetType");
const pdevAssetUrl = document.getElementById("pdevAssetUrl");
const pdevAssetSortNo = document.getElementById("pdevAssetSortNo");
const pdevAssetFormMsg = document.getElementById("pdevAssetFormMsg");
const pdevVariantList = document.getElementById("pdevVariantList");
const pdevVariantForm = document.getElementById("pdevVariantForm");
const pdevVariantSpec = document.getElementById("pdevVariantSpec");
const pdevVariantPrice = document.getElementById("pdevVariantPrice");
const pdevVariantWeight = document.getElementById("pdevVariantWeight");
const pdevVariantLength = document.getElementById("pdevVariantLength");
const pdevVariantWidth = document.getElementById("pdevVariantWidth");
const pdevVariantHeight = document.getElementById("pdevVariantHeight");
const pdevVariantFormMsg = document.getElementById("pdevVariantFormMsg");

// 这两处是块级提示，允许把原始 message 放进折叠的「技术详情」（§11.4）
const pdevDetailTargets = new Set([pdevDetailMessage].filter(Boolean));

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function pdevEsc(value) {
  if (typeof escapeHtml === "function") return escapeHtml(value == null ? "" : String(value));
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pdevText(value, fallback = "-") {
  const text = String(value == null ? "" : value).trim();
  return text || fallback;
}

// 包装信息 23 个字段（与详情页 data-pdev-pack 及数据库列一一对应）
const PDEV_PACK_KEYS = ["packForm","packOuter","packCushion","packReinforce","samplePackSize","samplePackWeight","basePackSizeCm","basePackWeightKg","basePackSizeInch","basePackWeightLb","basePackVolumeM3","itemSizeCm","itemNetWeightKg","cartonSizeCm","cartonWeightKg","cartonVolumeM3","cartonPcs","baseUnit","cartonLayers","cartonInnerGsm","cartonOuterGsm","laborCost","cartonPrice"];

function pdevSetValue(element, value) {
  if (!element) return;
  element.value = value == null ? "" : String(value);
}

function pdevNumberOrNull(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function pdevSafeHttpUrl(value) {
  const text = String(value == null ? "" : value).trim();
  return /^https?:\/\//i.test(text) ? text : "";
}

function pdevFormatTime(value) {
  if (!value) return "-";
  if (typeof formatDateTime === "function") {
    const text = formatDateTime(value);
    if (text && text !== "-") return text;
  }
  return String(value);
}

function pdevFormatPrice(value, currency) {
  if (value === null || value === undefined || value === "") return "未填价";
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `${String(currency || "CNY").toUpperCase()} ${num.toFixed(2)}`;
}

function pdevUserKey() {
  const user = typeof state !== "undefined" && state ? state.user : null;
  if (!user) return "";
  return String(user.id || user.username || "");
}

function pdevSetPanelLoaded(flag) {
  if (typeof state !== "undefined" && state && state.panelLoaded) state.panelLoaded.productDev = Boolean(flag);
}

function pdevFindRow(container, dataAttribute, id) {
  if (!container || typeof container.querySelectorAll !== "function") return null;
  const target = String(id);
  const rows = container.querySelectorAll(`[data-${dataAttribute}]`);
  for (const row of Array.from(rows || [])) {
    if (String(row.getAttribute(`data-${dataAttribute}`)) === target) return row;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 提示 / 错误（§11.4：可读文案 + 状态码；原始 message 只进 title 或折叠区）
// ---------------------------------------------------------------------------
function pdevApplyMessage(element, text, tone = "", detail = "") {
  if (!element) return;
  element.classList.toggle("is-error", tone === "error");
  element.classList.toggle("is-ok", tone === "ok");
  const safeText = String(text == null ? "" : text);
  const raw = String(detail == null ? "" : detail).trim();
  if (raw) {
    element.title = raw;
    if (pdevDetailTargets.has(element)) {
      element.innerHTML = `${pdevEsc(safeText)}<details class="pdev-tech"><summary>技术详情（原始返回，仅供排查）</summary><code>${pdevEsc(raw)}</code></details>`;
      return;
    }
  } else if (typeof element.removeAttribute === "function") {
    element.removeAttribute("title");
  }
  element.textContent = safeText;
}

// 顶部状态行（#pdevMessage）已按需求移除。成功/加载类文案不再显示——它们原本是给旧的
// 缺口看板与列表做说明的；但**错误不能就此消失**，否则会变成静默失败，因此错误统一改由
// 后端提示条（#pdevBackendNotice）承载（那里同时仍由 pdevSyncBackendNotice() 汇报原因）。
function pdevSetMessage(text, tone = "", detail = "") {
  if (tone !== "error") return;
  pdevApplyMessage(pdevBackendNotice, text, tone, detail);
  if (pdevBackendNotice) pdevBackendNotice.classList.remove("hidden");
}

function pdevSetInline(element, text, tone = "", detail = "") {
  pdevApplyMessage(element, text, tone, detail);
}

function pdevSetWorking(element, text) {
  pdevSetInline(element, text, "");
}

// 结构化错误 → 可读文案（只依据 HTTP 状态码与结构化字段，不回显原始 message）
function pdevErrorInfo(result, fallback) {
  const status = Number((result && result.status) || 0);
  const data = (result && result.data) || null;
  const raw = String((result && result.error) || "").trim();
  const missing = Array.isArray(data && data.missing) ? data.missing : [];
  let text = "";
  if (status === 401) {
    text = "登录态已失效（HTTP 401），已清除登录状态，请重新登录";
  } else if (status === 0) {
    text = "网络连接失败，请确认本地服务已启动并可访问";
  } else if (status === 404) {
    text = "接口暂不可用（HTTP 404）";
  } else if (status === 409) {
    // 契约 §6 / §11.4：占用方 PD_xxx 来自结构化字段 publicId，不是原始 message
    const occupied = pdevExtractPublicId(data);
    if (occupied) {
      text = `该货源已被 ${occupied} 占用（HTTP 409），不能重复挂到本产品`;
    } else if (/variant|变体|规格|specification/i.test(raw)) {
      text = "变体重复：同一规格已存在（HTTP 409）";
    } else if (/modified by another user|row_?version|expectedRowVersion/i.test(raw)) {
      text = "资料已被他人修改，请点「重载详情」后重试（HTTP 409）";
    } else {
      text = "冲突：资源已被占用或版本已过期（HTTP 409）";
    }
  } else if (status === 400) {
    if (/does not meet the requirements for "[a-z_]+"/i.test(raw)) {
      text = "状态推进被拒绝（HTTP 400）：还有资料没补齐";
    } else if (/Cannot change dev status/i.test(raw)) {
      text = "状态流转不被允许（HTTP 400）：只能推进到当前状态允许的目标";
    } else if (/expectedRowVersion/i.test(raw)) {
      text = "缺少版本号或格式不对（HTTP 400），请点「重载详情」后重试";
    } else {
      text = "提交的数据不合法（HTTP 400），请检查必填项";
    }
  } else if (status === 413) {
    text = "请求体过大（HTTP 413）";
  } else if (status >= 500) {
    text = `服务端内部错误（HTTP ${status}）`;
  } else {
    text = `${fallback || "请求失败"}（HTTP ${status}）`;
  }
  if (missing.length) {
    text += `｜缺：${missing.map((code) => `${pdevMissingLabel(code)}（${code}）`).join("；")}`;
  }
  return { text, detail: raw, status, missing };
}

// 统一入口：把结构化错误按 §11.4 展示到指定元素，并返回结构化信息
function pdevShowError(element, result, fallback) {
  const info = pdevErrorInfo(result, fallback);
  pdevSetInline(element, info.text, "error", info.detail);
  return info;
}

// ---------------------------------------------------------------------------
// 纯逻辑（可单独验证）
// ---------------------------------------------------------------------------

// 贴货源链接 → 猜平台 + 货源商品 ID（仅前端便利，最终以后端 201/409 为准）
function pdevParseSourceUrl(rawUrl) {
  const url = String(rawUrl == null ? "" : rawUrl).trim();
  const result = { platform: "", sourceProductId: "" };
  if (!url) return result;
  const lower = url.toLowerCase();
  if (lower.includes("1688.com")) result.platform = "1688";
  else if (lower.includes("taobao.com") || lower.includes("tmall.com")) result.platform = "taobao";
  else if (lower.includes("ozon.")) result.platform = "ozon";
  const patterns = [
    /offer\/(\d{5,})/i,
    /[?&](?:id|offerId|itemId|productId|goodsId)=(\d{5,})/i,
    /\/(?:item|product|goods)\/(\d{5,})/i,
    /\/detail\/(?:id\/)?(\d{5,})/i,
    /\/(\d{6,})(?:\.html?)?(?:[?#]|$)/i
  ];
  for (const pattern of patterns) {
    const matched = url.match(pattern);
    if (matched) {
      result.sourceProductId = matched[1];
      break;
    }
  }
  return result;
}

// 规格文本 "颜色=黑;尺寸=L" → { 颜色:"黑", 尺寸:"L" }
function pdevParseSpec(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw) return { ok: false, error: "规格必填，格式：颜色=黑;尺寸=L", spec: {} };
  const spec = {};
  const pairs = raw.split(/[;；\n]+/).map((item) => item.trim()).filter(Boolean);
  for (const pair of pairs) {
    const matched = pair.match(/^([^=:：]+)[=:：](.+)$/);
    if (!matched) return { ok: false, error: `规格片段「${pair}」不是 k=v 形式`, spec: {} };
    const key = matched[1].trim();
    const value = matched[2].trim();
    if (!key || !value) return { ok: false, error: `规格片段「${pair}」的键或值为空`, spec: {} };
    spec[key] = value;
  }
  if (!Object.keys(spec).length) return { ok: false, error: "规格必填，格式：颜色=黑;尺寸=L", spec: {} };
  return { ok: true, error: "", spec };
}

// 契约 §3.4：variant_key = 键排序 + 小写 trim，k=v;k=v
function pdevVariantKey(spec) {
  return Object.entries(spec || {})
    .map(([key, value]) => [String(key).trim().toLowerCase(), String(value).trim().toLowerCase()])
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(";");
}

function pdevAllowedTargets(currentStatus) {
  const current = String(currentStatus || "new");
  return PDEV_STATUS_ORDER.filter((target) => (PDEV_ALLOWED_FROM[target] || []).includes(current));
}

function pdevMissingLabel(code) {
  const raw = String(code == null ? "" : code).trim();
  if (!raw) return "未说明的缺失项";
  for (const [pattern, label] of PDEV_MISSING_RULES) {
    if (pattern.test(raw)) return label;
  }
  return raw;
}

function pdevMissingShortLabel(token) {
  return PDEV_MISSING_SHORT[token] || String(token || "");
}

function pdevMissingDesc(token) {
  return PDEV_MISSING_DESC[token] || "缺失项";
}

function pdevMissingListHtml(missing) {
  const list = Array.isArray(missing) ? missing : [];
  return list
    .map((code) => `<li>${pdevEsc(pdevMissingLabel(code))}<code>${pdevEsc(code)}</code></li>`)
    .join("");
}

function pdevExtractPublicId(source) {
  if (!source || typeof source !== "object") return "";
  const keys = [
    "publicId",
    "occupiedByPublicId",
    "occupiedPublicId",
    "productPublicId",
    "ownerPublicId",
    "ownerProductPublicId"
  ];
  for (const key of keys) {
    const value = String(source[key] || "").trim();
    if (/^PD_[A-Za-z0-9_-]+$/.test(value)) return value;
  }
  return "";
}

// 列表项缺口标签：只信服务端返回的 item.missing（§11.1，顺序固定）
function pdevItemGapTagsHtml(item) {
  const missing = item && Array.isArray(item.missing) ? item.missing : null;
  if (!missing) return '<span class="pdev-gap-tag is-unknown" title="缺口信息暂不可用">缺口未知</span>';
  if (!missing.length) return '<span class="pdev-gap-tag is-clear" title="服务端精确判定：无缺口">资料齐备</span>';
  return missing
    .map((token) => `<span class="pdev-gap-tag" title="${pdevEsc(pdevMissingDesc(token))}">缺${pdevEsc(pdevMissingShortLabel(token))}</span>`)
    .join("");
}

// ---------------------------------------------------------------------------
// 请求层：正常走 apiRequest，自测时走内置 mock
// ---------------------------------------------------------------------------
function pdevMockEnabled() {
  try {
    if (globalThis.PDEV_MOCK === true) return true;
    const search = String((globalThis.location && globalThis.location.search) || "");
    if (/[?&]pdevMock=1(?:&|$)/.test(search)) return true;
    const stored = globalThis.localStorage ? globalThis.localStorage.getItem("pdev_mock") : "";
    return String(stored || "") === "1";
  } catch (error) {
    return false;
  }
}

async function pdevRequest(path, options = {}) {
  if (pdevMockEnabled()) return pdevMockRequest(path, options);
  return apiRequest(path, options);
}

// 演示数据角标：mock 模式必须在页面上显眼标注，避免把 mock 当成真实库
function pdevSyncMockBadge() {
  const enabled = pdevMockEnabled();
  const panel = document.getElementById("productDevPanel");
  if (panel && panel.classList) panel.classList.toggle("is-mock", enabled);
  if (!pdevMockBadge) return;
  pdevMockBadge.classList.toggle("hidden", !enabled);
  pdevMockBadge.textContent = enabled
    ? "⚠ 演示数据（mock）：当前列表、计数与详情全部来自前端内置 mock，不是公司真实产品库；去掉地址里的 ?pdevMock=1 并刷新即回到真实数据。"
    : "";
}

function pdevApiPath(suffix) {
  return `${PDEV_API}${suffix}`;
}

// ---------------------------------------------------------------------------
// 内置 mock（仅在 ?pdevMock=1 / localStorage pdev_mock=1 时启用）
// 目的：后端挂载前自测交互；形状与 §5.1 + §11.1 + §10 的 token/错误码保持一致。
// ---------------------------------------------------------------------------
let pdevMockDb = null;

function pdevMockSeed() {
  const now = "2026-04-19 10:00:00.000";
  const products = [
    { id: 1, publicId: "PD_MOCK0001", title: "加热宠物窝（冬季爆款）", remark: "Yandex 搜索量上升", categoryHint: "Pet Supplies/Beds", targetPlatform: "yandex", devStatus: "new", ownerUserId: "", createdBy: "1", createdAt: now, updatedAt: now, rowVersion: 0 },
    { id: 2, publicId: "PD_MOCK0002", title: "折叠收纳箱 60L", remark: "", categoryHint: "", targetPlatform: "ozon", devStatus: "developing", ownerUserId: "", createdBy: "1", createdAt: now, updatedAt: now, rowVersion: 1 },
    { id: 3, publicId: "PD_MOCK0003", title: "LED 氛围灯带 5m", remark: "", categoryHint: "", targetPlatform: "", devStatus: "info_ready", ownerUserId: "", createdBy: "1", createdAt: now, updatedAt: now, rowVersion: 2 },
    { id: 4, publicId: "PD_MOCK0004", title: "硅胶烘焙刷（已定稿）", remark: "", categoryHint: "", targetPlatform: "yandex", devStatus: "finalized", ownerUserId: "9", createdBy: "1", createdAt: now, updatedAt: now, rowVersion: 3 },
    { id: 5, publicId: "PD_MOCK0005", title: "旧样品（已归档）", remark: "", categoryHint: "", targetPlatform: "", devStatus: "archived", ownerUserId: "", createdBy: "1", createdAt: now, updatedAt: now, rowVersion: 1 }
  ];
  const sources = [
    { id: 201, pdevProductId: 2, platform: "1688", sourceProductId: "620000000002", sourceUrl: "https://detail.1688.com/offer/620000000002.html", supplyPrice: 18.5, supplyCurrency: "CNY", moq: 2, supplierName: "义乌某厂", supplyStatus: "active", note: "", createdAt: now, updatedAt: now },
    { id: 202, pdevProductId: 2, platform: "taobao", sourceProductId: "710000000002", sourceUrl: "", supplyPrice: null, supplyCurrency: "CNY", moq: null, supplierName: "", supplyStatus: "unknown", note: "备用货源，还没问价", createdAt: now, updatedAt: now },
    { id: 203, pdevProductId: 3, platform: "1688", sourceProductId: "620000000003", sourceUrl: "https://detail.1688.com/offer/620000000003.html", supplyPrice: 26, supplyCurrency: "CNY", moq: 1, supplierName: "", supplyStatus: "active", note: "", createdAt: now, updatedAt: now },
    { id: 204, pdevProductId: 4, platform: "1688", sourceProductId: "620000000004", sourceUrl: "https://detail.1688.com/offer/620000000004.html", supplyPrice: 7.9, supplyCurrency: "CNY", moq: 10, supplierName: "", supplyStatus: "active", note: "用于 409 占用自测", createdAt: now, updatedAt: now }
  ];
  const assets = [
    { id: 301, pdevProductId: 3, assetType: "main", sourceUrl: "https://img.example.com/led-main.jpg", storageUrl: "", sortNo: 0, checksum: null, status: "ready", createdAt: now, updatedAt: now },
    { id: 302, pdevProductId: 4, assetType: "main", sourceUrl: "https://img.example.com/brush-main.jpg", storageUrl: "", sortNo: 0, checksum: null, status: "ready", createdAt: now, updatedAt: now },
    { id: 303, pdevProductId: 4, assetType: "gallery", sourceUrl: "https://img.example.com/brush-2.jpg", storageUrl: "", sortNo: 1, checksum: null, status: "ready", createdAt: now, updatedAt: now }
  ];
  const variants = [
    { id: 401, pdevProductId: 4, variantKey: "尺寸=l;颜色=黑", spec: { 颜色: "黑", 尺寸: "L" }, supplyPrice: 7.9, weightKg: 0.15, packageLengthCm: 20, packageWidthCm: 12, packageHeightCm: 3, status: "active", createdAt: now }
  ];
  return { seq: 9000, products, sources, assets, variants };
}

function pdevMockStore() {
  if (!pdevMockDb) pdevMockDb = pdevMockSeed();
  return pdevMockDb;
}

function pdevMockCounts(db, productId) {
  const sources = db.sources.filter((item) => item.pdevProductId === productId);
  return {
    sourceCount: sources.length,
    activeSourceCount: sources.filter((item) => item.supplyStatus === "active").length,
    // §11.5：noActivePrice 的口径是「active 且有价」，与 §4 硬校验同源
    activePricedSourceCount: sources.filter(
      (item) => item.supplyStatus === "active" && item.supplyPrice !== null && item.supplyPrice !== undefined && Number.isFinite(Number(item.supplyPrice))
    ).length,
    assetCount: db.assets.filter((item) => item.pdevProductId === productId).length,
    mainAssetCount: db.assets.filter((item) => item.pdevProductId === productId && item.assetType === "main").length,
    variantCount: db.variants.filter((item) => item.pdevProductId === productId).length
  };
}

// §11.1 / §11.5：服务端精确推导，顺序固定
function pdevMockMissingTokens(counts) {
  const tokens = [];
  if (counts.sourceCount === 0) tokens.push("noSource");
  else if (counts.activePricedSourceCount === 0) tokens.push("noActivePrice");
  if (counts.mainAssetCount === 0) tokens.push("noMainAsset");
  if (counts.variantCount === 0) tokens.push("noVariant");
  return tokens;
}

function pdevMockProductView(db, product) {
  const counts = pdevMockCounts(db, product.id);
  return { ...product, ...counts, missing: pdevMockMissingTokens(counts) };
}

function pdevMockOk(status, data) {
  return { ok: true, status, data };
}

function pdevMockFail(status, message, extra) {
  const data = { message, ...(extra || {}) };
  return { ok: false, status, error: message, data };
}

function pdevMockNow() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function pdevMockFindProduct(db, publicId) {
  return db.products.find((item) => String(item.publicId) === String(publicId)) || null;
}

function pdevMockRequest(path, options = {}) {
  const db = pdevMockStore();
  const method = String(options.method || "GET").toUpperCase();
  let body = {};
  if (options.body) {
    try {
      body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
    } catch (error) {
      return Promise.resolve(pdevMockFail(400, "Invalid JSON body"));
    }
  }

  let url = null;
  try {
    url = new URL(path, "http://pdev.mock.local");
  } catch (error) {
    return Promise.resolve(pdevMockFail(400, `Invalid path: ${path}`));
  }

  const segments = url.pathname
    .replace(/^\/api\/product-dev\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));

  // 13. GET /summary
  if (segments.length === 1 && segments[0] === "summary" && method === "GET") {
    const byStatus = {};
    for (const status of PDEV_STATUS_ORDER) byStatus[status] = 0;
    for (const product of db.products) {
      if (byStatus[product.devStatus] === undefined) byStatus[product.devStatus] = 0;
      byStatus[product.devStatus] += 1;
    }
    const missing = { noSource: 0, noActivePrice: 0, noMainAsset: 0, noVariant: 0 };
    for (const product of db.products) {
      for (const token of pdevMockMissingTokens(pdevMockCounts(db, product.id))) {
        if (missing[token] !== undefined) missing[token] += 1;
      }
    }
    return Promise.resolve(pdevMockOk(200, { byStatus, missing }));
  }

  // 1/2. /products
  if (segments[0] === "products" && segments.length === 1) {
    if (method === "GET") {
      const statusFilter = String(url.searchParams.get("devStatus") || "").trim();
      const keyword = String(url.searchParams.get("q") || "").trim().toLowerCase();
      // §11.2：missing=noSource,noActivePrice，逗号分隔，AND 语义
      const missingFilter = String(url.searchParams.get("missing") || "")
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean);
      const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") || 20) || 20));
      let items = db.products.map((product) => pdevMockProductView(db, product));
      if (statusFilter) items = items.filter((item) => item.devStatus === statusFilter);
      if (keyword) items = items.filter((item) => String(item.title || "").toLowerCase().includes(keyword));
      if (missingFilter.length) items = items.filter((item) => missingFilter.every((token) => item.missing.includes(token)));
      const total = items.length;
      const start = (page - 1) * pageSize;
      return Promise.resolve(pdevMockOk(200, { items: items.slice(start, start + pageSize), total, page, pageSize }));
    }
    if (method === "POST") {
      const title = String(body.title || "").trim();
      if (!title) return Promise.resolve(pdevMockFail(400, "title is required"));
      db.seq += 1;
      const product = {
        id: db.seq,
        publicId: `PD_MOCK${db.seq}`,
        title,
        remark: String(body.remark || ""),
        categoryHint: String(body.categoryHint || ""),
        targetPlatform: String(body.targetPlatform || ""),
        devStatus: "new",
        ownerUserId: String(body.ownerUserId || ""),
        createdBy: "1",
        createdAt: pdevMockNow(),
        updatedAt: pdevMockNow(),
        rowVersion: 0
      };
      db.products.push(product);
      return Promise.resolve(pdevMockOk(201, { product: pdevMockProductView(db, product) }));
    }
    return Promise.resolve(pdevMockFail(405, `Unsupported method: ${method}`));
  }

  // 3/4/5 + 6/9/11/12. /products/:publicId[...]
  if (segments[0] === "products" && segments.length >= 2) {
    const product = pdevMockFindProduct(db, segments[1]);
    if (!product) return Promise.resolve(pdevMockFail(404, "Not found"));

    if (segments.length === 2 && method === "GET") {
      return Promise.resolve(pdevMockOk(200, {
        product: pdevMockProductView(db, product),
        sources: db.sources.filter((item) => item.pdevProductId === product.id),
        assets: db.assets.filter((item) => item.pdevProductId === product.id),
        variants: db.variants.filter((item) => item.pdevProductId === product.id)
      }));
    }

    if (segments.length === 2 && method === "PATCH") {
      // §10.3 #1：expectedRowVersion 缺失/非整数 → 400；不符 → 409
      const expected = Number(body.expectedRowVersion);
      if (body.expectedRowVersion === undefined || body.expectedRowVersion === null || !Number.isInteger(Number(body.expectedRowVersion))) {
        return Promise.resolve(pdevMockFail(400, "expectedRowVersion is required and must be an integer"));
      }
      if (expected !== Number(product.rowVersion)) {
        return Promise.resolve(pdevMockFail(409, "The product was modified by another user; please refresh and retry"));
      }
      const patch = body.patch && typeof body.patch === "object" ? body.patch : {};
      if (!Object.keys(patch).length) return Promise.resolve(pdevMockFail(400, "At least one updatable field is required"));
      for (const key of ["title", "remark", "categoryHint", "targetPlatform", "ownerUserId"]) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) product[key] = patch[key] == null ? "" : String(patch[key]);
      }
      if (!String(product.title || "").trim()) return Promise.resolve(pdevMockFail(400, "title must not be empty"));
      product.rowVersion = Number(product.rowVersion || 0) + 1;
      product.updatedAt = pdevMockNow();
      return Promise.resolve(pdevMockOk(200, { product: pdevMockProductView(db, product) }));
    }

    if (segments.length === 2 && method === "DELETE") {
      db.products = db.products.filter((item) => item.id !== product.id);
      db.sources = db.sources.filter((item) => item.pdevProductId !== product.id);
      db.assets = db.assets.filter((item) => item.pdevProductId !== product.id);
      db.variants = db.variants.filter((item) => item.pdevProductId !== product.id);
      return Promise.resolve(pdevMockOk(200, { removed: true }));
    }

    // 6. POST /products/:publicId/sources
    if (segments.length === 3 && segments[2] === "sources" && method === "POST") {
      const platform = String(body.platform || "").trim();
      const sourceProductId = String(body.sourceProductId || "").trim();
      if (!platform) return Promise.resolve(pdevMockFail(400, "platform is required"));
      if (!["1688", "taobao", "ozon", "other"].includes(platform)) {
        return Promise.resolve(pdevMockFail(400, "platform must be one of 1688/taobao/ozon/other"));
      }
      if (!sourceProductId) return Promise.resolve(pdevMockFail(400, "sourceProductId is required"));
      const owner = db.sources.find(
        (item) => item.platform === platform && String(item.sourceProductId) === sourceProductId && item.pdevProductId !== product.id
      );
      if (owner) {
        const ownerProduct = db.products.find((item) => item.id === owner.pdevProductId);
        const ownerPublicId = ownerProduct ? ownerProduct.publicId : "";
        return Promise.resolve(
          pdevMockFail(409, ownerPublicId ? `This source already belongs to product ${ownerPublicId}` : "This source already belongs to another product", ownerPublicId ? { publicId: ownerPublicId } : {})
        );
      }
      const duplicated = db.sources.find(
        (item) => item.platform === platform && String(item.sourceProductId) === sourceProductId && item.pdevProductId === product.id
      );
      if (duplicated) {
        return Promise.resolve(pdevMockFail(409, "This source is already attached to this product", { publicId: product.publicId }));
      }
      db.seq += 1;
      const source = {
        id: db.seq,
        pdevProductId: product.id,
        platform,
        sourceProductId,
        sourceUrl: String(body.sourceUrl || ""),
        supplyPrice: body.supplyPrice === undefined || body.supplyPrice === null || body.supplyPrice === "" ? null : Number(body.supplyPrice),
        supplyCurrency: String(body.supplyCurrency || "CNY").toUpperCase().slice(0, 3),
        moq: body.moq === undefined || body.moq === null || body.moq === "" ? null : Number(body.moq),
        supplierName: String(body.supplierName || ""),
        supplyStatus: PDEV_SOURCE_STATUS_OPTIONS.includes(String(body.supplyStatus || "")) ? String(body.supplyStatus) : "unknown",
        note: String(body.note || ""),
        createdAt: pdevMockNow(),
        updatedAt: pdevMockNow()
      };
      db.sources.push(source);
      return Promise.resolve(pdevMockOk(201, { source }));
    }

    // 9. POST /products/:publicId/assets
    if (segments.length === 3 && segments[2] === "assets" && method === "POST") {
      const assetType = String(body.assetType || "").trim();
      if (!assetType) return Promise.resolve(pdevMockFail(400, "assetType is required"));
      if (!PDEV_ASSET_TYPE_OPTIONS.includes(assetType)) {
        return Promise.resolve(pdevMockFail(400, `assetType must be one of ${PDEV_ASSET_TYPE_OPTIONS.join("/")}`));
      }
      db.seq += 1;
      const asset = {
        id: db.seq,
        pdevProductId: product.id,
        assetType,
        sourceUrl: String(body.sourceUrl || ""),
        storageUrl: String(body.storageUrl || ""),
        sortNo: Number.isFinite(Number(body.sortNo)) ? Number(body.sortNo) : 0,
        checksum: null,
        status: "ready",
        createdAt: pdevMockNow(),
        updatedAt: pdevMockNow()
      };
      db.assets.push(asset);
      return Promise.resolve(pdevMockOk(201, { asset }));
    }

    // 11. POST /products/:publicId/variants
    if (segments.length === 3 && segments[2] === "variants" && method === "POST") {
      const spec = body.spec && typeof body.spec === "object" && !Array.isArray(body.spec) ? body.spec : null;
      if (!spec || !Object.keys(spec).length) return Promise.resolve(pdevMockFail(400, "spec is required and must be a non-empty object"));
      const variantKey = pdevVariantKey(spec);
      const exists = db.variants.some((item) => item.pdevProductId === product.id && item.variantKey === variantKey);
      if (exists) return Promise.resolve(pdevMockFail(409, "A variant with the same specification already exists for this product"));
      db.seq += 1;
      const variant = {
        id: db.seq,
        pdevProductId: product.id,
        variantKey,
        spec,
        supplyPrice: body.supplyPrice === undefined || body.supplyPrice === null || body.supplyPrice === "" ? null : Number(body.supplyPrice),
        weightKg: body.weightKg === undefined || body.weightKg === null || body.weightKg === "" ? null : Number(body.weightKg),
        packageLengthCm: body.packageLengthCm === undefined || body.packageLengthCm === null || body.packageLengthCm === "" ? null : Number(body.packageLengthCm),
        packageWidthCm: body.packageWidthCm === undefined || body.packageWidthCm === null || body.packageWidthCm === "" ? null : Number(body.packageWidthCm),
        packageHeightCm: body.packageHeightCm === undefined || body.packageHeightCm === null || body.packageHeightCm === "" ? null : Number(body.packageHeightCm),
        status: "active",
        createdAt: pdevMockNow()
      };
      db.variants.push(variant);
      return Promise.resolve(pdevMockOk(201, { variant }));
    }

    // 12. POST /products/:publicId/status
    if (segments.length === 3 && segments[2] === "status" && method === "POST") {
      const to = String(body.to || "").trim();
      if (!PDEV_STATUS_ORDER.includes(to)) {
        return Promise.resolve(pdevMockFail(400, `to must be one of ${PDEV_STATUS_ORDER.join("/")}`));
      }
      const current = String(product.devStatus || "new");
      if (current === to) return Promise.resolve(pdevMockFail(400, `Product is already in status "${to}"`));
      const allowedFrom = PDEV_ALLOWED_FROM[to] || [];
      if (!allowedFrom.includes(current)) {
        return Promise.resolve(
          pdevMockFail(400, `Cannot change dev status from "${current}" to "${to}"; allowed source statuses for "${to}": ${allowedFrom.length ? allowedFrom.join(", ") : "(none)"}`)
        );
      }
      const expected = Number(body.expectedRowVersion);
      if (body.expectedRowVersion !== undefined && body.expectedRowVersion !== null && Number.isInteger(expected) && expected !== Number(product.rowVersion)) {
        return Promise.resolve(pdevMockFail(409, "The product was modified by another user; please refresh and retry"));
      }
      const missing = [];
      if (to === "info_ready") {
        const counts = pdevMockCounts(db, product.id);
        if (counts.sourceCount === 0) missing.push("noSource");
        else if (counts.activePricedSourceCount === 0) missing.push("noActivePrice");
        if (counts.mainAssetCount === 0) missing.push("noMainAsset");
      }
      if (to === "finalized") {
        const counts = pdevMockCounts(db, product.id);
        if (counts.variantCount === 0) missing.push("noVariant");
      }
      if (missing.length) {
        return Promise.resolve(pdevMockFail(400, `Product does not meet the requirements for "${to}"`, { missing }));
      }
      product.devStatus = to;
      product.rowVersion = Number(product.rowVersion || 0) + 1;
      product.updatedAt = pdevMockNow();
      return Promise.resolve(pdevMockOk(200, { product: pdevMockProductView(db, product) }));
    }

    return Promise.resolve(pdevMockFail(405, `Unsupported path/method: ${method} ${url.pathname}`));
  }

  // 7/8. /sources/:id
  if (segments[0] === "sources" && segments.length === 2) {
    const source = db.sources.find((item) => String(item.id) === String(segments[1])) || null;
    if (!source) return Promise.resolve(pdevMockFail(404, "Source not found"));
    if (method === "PATCH") {
      const fields = ["sourceUrl", "supplyPrice", "supplyCurrency", "moq", "supplierName", "supplyStatus", "note"];
      const provided = fields.filter((key) => Object.prototype.hasOwnProperty.call(body, key));
      if (!provided.length) return Promise.resolve(pdevMockFail(400, "At least one updatable field is required"));
      for (const key of provided) {
        if (key === "supplyPrice" || key === "moq") {
          source[key] = body[key] === null || body[key] === "" ? null : Number(body[key]);
        } else if (key === "supplyCurrency") {
          source[key] = String(body[key] || "CNY").toUpperCase().slice(0, 3);
        } else if (key === "supplyStatus") {
          source[key] = PDEV_SOURCE_STATUS_OPTIONS.includes(String(body[key])) ? String(body[key]) : source.supplyStatus;
        } else {
          source[key] = String(body[key] == null ? "" : body[key]);
        }
      }
      source.updatedAt = pdevMockNow();
      return Promise.resolve(pdevMockOk(200, { source }));
    }
    if (method === "DELETE") {
      db.sources = db.sources.filter((item) => item.id !== source.id);
      return Promise.resolve(pdevMockOk(200, { removed: true }));
    }
    return Promise.resolve(pdevMockFail(405, `Unsupported method: ${method}`));
  }

  // 10. /assets/:id
  if (segments[0] === "assets" && segments.length === 2) {
    const asset = db.assets.find((item) => String(item.id) === String(segments[1])) || null;
    if (!asset) return Promise.resolve(pdevMockFail(404, "Asset not found"));
    if (method === "DELETE") {
      db.assets = db.assets.filter((item) => item.id !== asset.id);
      return Promise.resolve(pdevMockOk(200, { removed: true }));
    }
    return Promise.resolve(pdevMockFail(405, `Unsupported method: ${method}`));
  }

  return Promise.resolve(pdevMockFail(404, "Not found"));
}

// ---------------------------------------------------------------------------
// 加载（接口 1 / 3 / 13）
// ---------------------------------------------------------------------------
function pdevResetForUser(ownerKey) {
  pdevState.ownerKey = ownerKey;
  pdevState.loaded = false;
  pdevState.items = [];
  pdevState.total = 0;
  pdevState.page = 1;
  pdevState.gaps = [];
  pdevState.selectedPublicId = "";
  pdevState.detail = null;
  pdevState.backend = { attempted: false, listOk: false };
  pdevSetPanelLoaded(false);
}

// 后端提示条：现在只有"产品列表没拿到"这一种情况需要告诉用户
//（缺口统计接口已不再调用，见 pdevLoadList 注释）
function pdevSyncBackendNotice() {
  if (!pdevBackendNotice) return;
  const backend = pdevState.backend;
  if (!backend.attempted || backend.listOk) {
    pdevBackendNotice.classList.add("hidden");
    pdevBackendNotice.textContent = "";
    return;
  }
  pdevBackendNotice.classList.remove("hidden");
  pdevBackendNotice.textContent = `${PDEV_WAITING_NOTICE}（产品列表加载失败）。请点「刷新」重试。`;
}

async function pdevLoadList() {
  pdevState.backend.attempted = true;
  const params = new URLSearchParams();
  if (pdevState.keyword) params.set("q", pdevState.keyword);
  // §11.2：服务端过滤，逗号分隔 = AND（看板移除后 gaps 恒为空，保留以备筛选恢复）
  if (pdevState.gaps.length) params.set("missing", pdevState.gaps.join(","));
  params.set("page", String(Math.max(1, pdevState.page)));
  params.set("pageSize", String(pdevState.pageSize));

  const result = await pdevRequest(pdevApiPath(`/products?${params.toString()}`), { method: "GET" });
  if (!result.ok) {
    pdevState.items = [];
    pdevState.total = 0;
    pdevState.backend.listOk = false;
    // 列表加载失败由下面的 pdevSyncBackendNotice() 汇报（顶部状态行已移除）
    pdevRenderList();
    pdevRenderPager();
    pdevSyncBackendNotice();
    return false;
  }

  const data = result.data || {};
  const items = Array.isArray(data.items) ? data.items : [];
  pdevState.items = items;
  pdevState.total = Number(data.total != null ? data.total : items.length) || 0;
  pdevState.page = Math.max(1, Number(data.page || pdevState.page) || 1);
  pdevState.pageSize = Math.min(100, Math.max(1, Number(data.pageSize || pdevState.pageSize) || 20));
  pdevState.backend.listOk = true;
  pdevRenderList();
  pdevRenderPager();
  pdevSyncBackendNotice();
  return true;
}

async function pdevLoadDetail(publicId, options = {}) {
  const target = String(publicId || "").trim();
  if (!target) return false;
  pdevState.detailLoading = true;
  const result = await pdevRequest(pdevApiPath(`/products/${encodeURIComponent(target)}`), { method: "GET" });
  pdevState.detailLoading = false;
  if (!result.ok) {
    if (result.status === 404) {
      pdevState.detail = null;
      pdevState.selectedPublicId = "";
      pdevRenderDetail();
      pdevRenderList();
      // 404 语义（契约 §6：不得泄露其他公司的存在性）
      pdevSetInline(pdevDetailMessage, `${target} 不存在或不属于本公司（HTTP 404）`, "error", result.error);
      return false;
    }
    pdevShowError(pdevDetailMessage, result, "详情加载失败");
    return false;
  }
  const data = result.data || {};
  pdevState.detail = {
    product: data.product || null,
    sources: Array.isArray(data.sources) ? data.sources : [],
    assets: Array.isArray(data.assets) ? data.assets : [],
    variants: Array.isArray(data.variants) ? data.variants : []
  };
  pdevState.selectedPublicId = String((data.product && data.product.publicId) || target);
  if (!options.silent) pdevSetInline(pdevDetailMessage, "", "");
  pdevRenderDetail();
  pdevRenderList();
  return true;
}

async function pdevEnsurePanelLoaded() {
  const ownerKey = pdevUserKey();
  if (!ownerKey) return false; // 未登录不请求，避免误触发 401 清登录态
  if (pdevState.ownerKey !== ownerKey) pdevResetForUser(ownerKey);
  if (pdevState.loaded || pdevState.loading) return true;
  pdevState.loading = true;
  pdevSyncMockBadge();
  const listOk = await pdevLoadList();
  pdevState.loading = false;
  pdevState.loaded = Boolean(listOk);
  pdevSetPanelLoaded(pdevState.loaded);
  pdevSyncBackendNotice();
  return pdevState.loaded;
}

async function pdevReload(options = {}) {
  if (!pdevUserKey()) {
    pdevSetMessage("请先登录后再使用商品管理", "error");
    return false;
  }
  pdevState.loading = true;
  pdevSyncMockBadge();
  const listOk = await pdevLoadList();
  pdevState.loading = false;
  pdevState.loaded = Boolean(listOk);
  pdevSetPanelLoaded(pdevState.loaded);
  pdevSyncBackendNotice();
  if (pdevState.loaded && pdevState.selectedPublicId && !pdevState.detail) {
    await pdevLoadDetail(pdevState.selectedPublicId, { silent: true });
  }
  return pdevState.loaded;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
// 说明：「缺什么」看板（chips）已按需求整体移除，因此原来的 pdevFilterReady() 与
// pdevRenderGaps() 一并删除；缺口信息现在只在结果表的「商品资料」列里体现（来自列表项的 missing[]）。

function pdevStatusBadgeHtml(status) {
  const key = String(status || "new");
  const label = PDEV_STATUS_LABEL[key] || key;
  return `<span class="pdev-status-badge s-${pdevEsc(key)}">${pdevEsc(label)}</span>`;
}

function pdevRenderList() {
  if (!pdevList) return;
  const items = pdevState.items;
  if (!items.length) {
    const hint = pdevState.keyword
      ? "没有标题匹配的产品。"
      : "还没有产品，点右上角「新建商品」。";
    pdevList.innerHTML = `<tr><td colspan="15" class="pdev-empty-cell">${pdevEsc(hint)}</td></tr>`;
    pdevSyncSelectAll();
    return;
  }
  // 表头为需求方给定的 11 列（在原 18 列基础上删去了：海外商服务状态 / 近期销量 / 近期售价 /
  // 近期毛利 / 侵权信息 / 关务状态 / 违禁信息），顺序与命名一字不差。
  // 本系统当前没有数据的列一律显示 "—"：空就是空，不填假值。
  // 有真实数据来源的列：
  //   商品SKU  → publicId（产品在本系统里的编号）
  //   商品名称  → title（下面附货源/素材/变体数量）
  //   状态标签  → devStatus（开发状态）
  //   商品资料  → 服务端返回的 missing[]（缺货源/缺主图/缺变体；为空即"齐备"）
  //   负责人    → ownerUserId    时间 → updatedAt    操作人 → createdBy
  const selectedIds = new Set(pdevState.selectedIds);
  pdevList.innerHTML = items
    .map((product) => {
      const publicId = String(product.publicId || "");
      const isActive = publicId && publicId === pdevState.selectedPublicId;
      const gapHtml = pdevItemGapTagsHtml(product);
      // 详情已搬到独立页：列表里只有「商品SKU」是入口（新标签页），整行不再可点
      return `<tr class="pdev-result-row${isActive ? " active" : ""}">
        <td class="pdev-cell-check"><input type="checkbox" data-pdev-select="${pdevEsc(publicId)}"${selectedIds.has(publicId) ? " checked" : ""} aria-label="选择" /></td>
        <td class="pdev-cell-sku">${publicId ? `<a class="pdev-sku-link" href="${pdevEsc(pdevDetailHref(publicId, "view"))}" target="_blank" rel="noopener" data-pdev-sku="${pdevEsc(publicId)}" title="在新标签页打开该商品详情">${pdevEsc(publicId)}</a><button type="button" class="pdev-copy-btn" data-pdev-copy="${pdevEsc(publicId)}" title="复制商品SKU" aria-label="复制商品SKU"><svg class="pdev-copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg><svg class="pdev-copy-icon pdev-copy-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg></button>` : "—"}</td>
        <td class="pdev-cell-title">
          <div class="pdev-item-title">${pdevEsc(pdevText(product.title, "（无标题）"))}</div>
        </td>
        <td class="pdev-cell-image">${product.mainAssetUrl ? `<img class="pdev-thumb" src="${pdevEsc(String(product.mainAssetUrl))}" alt="" loading="lazy" referrerpolicy="no-referrer" data-pdev-zoom="${pdevEsc(String(product.mainAssetUrl))}" title="点击放大" />` : "—"}</td>
        <td class="pdev-cell-tags">${pdevStatusTagsHtml(product)}</td>
        <td>—</td>
        <!-- 近期销量：数据来自订单系统（7/30/60/90 天）。当前商品尚未与在线产品绑定，故先显示 —，等绑定链路做好再取值。 -->
        <td class="pdev-cell-recent-sales">
                  <div style="line-height:1.6;">
                    <div>7天: —</div>
                    <div>30天: —</div>
                    <div>60天: —</div>
                    <div>90天: —</div>
                  </div>
                </td>
        <td class="pdev-cell-bundle" style="text-align:center;">${pdevEsc(String(product.isBundle || "").trim() || "—")}</td>
        <td class="pdev-cell-material">${pdevMaterialCellHtml(product)}</td>
        <td>—</td>
        <td>${pdevEsc(String(product.ownerUserId || "").trim() || "—")}</td>
        <td class="pdev-cell-time">
                  <div style="line-height:1.6;">创建时间: ${pdevEsc(pdevFormatTime(product.createdAt))}</div>
                  <div style="line-height:1.6;">更新时间: ${pdevEsc(pdevFormatTime(product.updatedAt))}</div>
                </td><td>${`<span class="pdev-who-line">创建 ${pdevEsc(String(product.createdByName || product.createdBy || "").trim() || "—")}</span><span class="pdev-who-line">更新 ${pdevEsc(String(product.updatedByName || "").trim() || "—")}</span>`}</td>
        <!-- 业务类型：当前数据模型还没有这个字段，先占位显示 —。字段确定后在此取值。 -->
        <td class="pdev-cell-biz-type">—</td>
        <td class="pdev-cell-actions">${publicId ? `${pdevCanWrite()
          ? `<button type="button" class="pdev-act pdev-act-edit" data-pdev-edit="${pdevEsc(publicId)}" title="在新标签页打开详情页编辑">编辑</button><button type="button" class="pdev-act pdev-act-delete" data-pdev-delete="${pdevEsc(publicId)}" title="删除该商品">删除</button>`
          : `<span class="pdev-act-readonly" title="只读账号：只有「产品开发」或「管理员」可以修改">只读</span>`}<button type="button" class="pdev-act pdev-act-log" data-pdev-log="${pdevEsc(publicId)}" title="查看该商品的编辑日志（所有人可看）">日志</button>` : "—"}</td>
      </tr>`;
    })
    .join("");
  pdevSyncSelectAll();
}

// 勾选：表头全选框与每行勾选框（只维护选中状态，尚未接任何批量操作）
function pdevOnSelectAllChange() {
  const checked = Boolean(pdevSelectAll && pdevSelectAll.checked);
  const set = new Set(pdevState.selectedIds);
  for (const product of pdevState.items) {
    const id = String((product && product.publicId) || "");
    if (!id) continue;
    if (checked) set.add(id);
    else set.delete(id);
  }
  pdevState.selectedIds = Array.from(set);
  pdevRenderList();
}

function pdevToggleRowSelection(publicId, checked) {
  const id = String(publicId || "").trim();
  if (!id) return;
  const set = new Set(pdevState.selectedIds);
  if (checked) set.add(id);
  else set.delete(id);
  pdevState.selectedIds = Array.from(set);
  pdevSyncSelectAll();
}

function pdevSyncSelectAll() {
  if (!pdevSelectAll) return;
  const selected = new Set(pdevState.selectedIds);
  const ids = pdevState.items.map((product) => String((product && product.publicId) || "")).filter(Boolean);
  pdevSelectAll.checked = ids.length > 0 && ids.every((id) => selected.has(id));
}

function pdevRenderPager() {
  if (!pdevPager) return;
  const totalPages = Math.max(1, Math.ceil((pdevState.total || 0) / pdevState.pageSize));
  pdevPager.innerHTML = `
    <button type="button" class="secondary-btn" data-pdev-page="${Math.max(1, pdevState.page - 1)}" ${pdevState.page <= 1 ? "disabled" : ""}>上一页</button>
    <span>第 ${Math.min(pdevState.page, totalPages)} / ${totalPages} 页</span>
    <button type="button" class="secondary-btn" data-pdev-page="${Math.min(totalPages, pdevState.page + 1)}" ${pdevState.page >= totalPages ? "disabled" : ""}>下一页</button>`;
}

function pdevRenderDetail() {
  if (!pdevDetail) return;
  const detail = pdevState.detail;
  const product = detail && detail.product ? detail.product : null;
  if (!product) {
    pdevDetail.classList.add("hidden");
    pdevHideMissing();
    return;
  }
  pdevDetail.classList.remove("hidden");

  if (pdevDetailPublicId) pdevDetailPublicId.textContent = String(product.publicId || "-");
  if (pdevDetailTitle) pdevDetailTitle.textContent = pdevText(product.title, "（无标题）");
  if (pdevDetailMeta) {
    // 契约 §11.7：{product} 不含 missing 键（missing 只出现在列表项 ProductSummary 上）。
    // 所以这里不再显示「缺口」——那样只会永远显示「缺口未知」。要补什么由下方
    // 货源 / 素材 / 变体 三个区块各自的空态精确说明（"还没有货源""至少补 1 张主图…"）。
    pdevDetailMeta.textContent = [
      `状态 ${PDEV_STATUS_LABEL[product.devStatus] || product.devStatus}`,
      `更新 ${pdevFormatTime(product.updatedAt)}`
    ].join(" ｜ ");
  }
  if (pdevDetailStatus) {
    const status = String(product.devStatus || "new");
    pdevDetailStatus.className = `pdev-status-badge s-${status}`;
    pdevDetailStatus.textContent = PDEV_STATUS_LABEL[status] || status;
  }

  pdevSetValue(pdevProductTitle, product.title);
        pdevSetValue(pdevProductGoodsStatus, product.goodsStatus || "");
        pdevSetValue(pdevProductSalesStatus, product.salesStatus || "");
        pdevSetValue(pdevProductSourceStatus, product.sourceStatus || "");
        pdevSetValue(pdevProductPurchasePrice, product.purchasePrice === null || product.purchasePrice === undefined ? "" : String(product.purchasePrice));
        pdevSetValue(pdevProductPurchaseUrl, product.purchaseUrl || "");
        pdevSetValue(pdevProductReferenceUrl, product.referenceUrl || "");
        pdevSetValue(pdevProductIsBundle, product.isBundle || "");
        pdevSetValue(pdevProductSystemCategory, product.systemCategory || "");
        // 包装信息（23 个字段，表单在详情页的「包装信息」模块里）
        PDEV_PACK_KEYS.forEach((key) => {
          const el = document.getElementById("pdevPack_" + key);
          if (el) pdevSetValue(el, product[key] === null || product[key] === undefined ? "" : product[key]);
        });
  pdevSetValue(pdevProductOwner, product.ownerUserId);
  pdevSetValue(pdevProductRemark, product.remark);

  pdevRenderStatusActions();
  pdevRenderSources();
  pdevRenderAssets();
  pdevRenderVariants();
}

function pdevRenderStatusActions() {
  if (!pdevStatusActions || !pdevFlowHint) return;
  const product = pdevState.detail && pdevState.detail.product ? pdevState.detail.product : null;
  if (!product) {
    pdevStatusActions.innerHTML = "";
    pdevFlowHint.textContent = "";
    return;
  }
  const current = String(product.devStatus || "new");
  const targets = pdevAllowedTargets(current);
  pdevFlowHint.textContent = `当前状态：${PDEV_STATUS_LABEL[current] || current} → 可推进到：${
    targets.map((target) => PDEV_STATUS_LABEL[target] || target).join("、") || "无（已归档）"
  }`;
  if (!targets.length) {
    pdevStatusActions.innerHTML = '<span class="pdev-inline-msg">已归档（终态），不可再流转。</span>';
    return;
  }
  pdevStatusActions.innerHTML = targets
    .map(
      (target) =>
        `<button type="button" data-pdev-status="${pdevEsc(target)}" title="${pdevEsc(PDEV_TRANSITION_RULE[target] || "")}">→ ${pdevEsc(PDEV_STATUS_LABEL[target] || target)}</button>`
    )
    .join("");
}

function pdevRenderSources() {
  if (!pdevSourceList) return;
  const sources = (pdevState.detail && pdevState.detail.sources) || [];
  if (!sources.length) {
    pdevSourceList.innerHTML = '<div class="pdev-empty">还没有货源。贴一条货源链接挂上（推进到「资料齐备」前必须至少 1 条在售且有价的货源）。</div>';
    return;
  }
  pdevSourceList.innerHTML = sources.map((source) => pdevSourceRowHtml(source)).join("");
}

function pdevSourceRowHtml(source) {
  const id = String(source.id);
  const platform = String(source.platform || "");
  const sourceUrl = String(source.sourceUrl || "").trim();
  const href = pdevSafeHttpUrl(sourceUrl);
  const status = String(source.supplyStatus || "unknown");
  return `<article class="pdev-source-row" data-pdev-source-row="${pdevEsc(id)}">
    <div class="pdev-source-head">
      <span class="pdev-source-platform">${pdevEsc(PDEV_PLATFORM_LABEL[platform] || platform || "未知平台")}</span>
      <span>货源ID <code>${pdevEsc(source.sourceProductId)}</code></span>
      <span class="pdev-status-badge">${pdevEsc(PDEV_SOURCE_STATUS_LABEL[status] || status)}</span>
      <span>${pdevEsc(pdevFormatPrice(source.supplyPrice, source.supplyCurrency))}</span>
      <span>起订 ${source.moq == null ? "-" : pdevEsc(source.moq)}</span>
    </div>

    <label class="pdev-field pdev-source-link-field">
      <span class="pdev-field-label pdev-manual-tag">货源链接<small>人工粘贴 · 可编辑 · 比价第一依据</small></span>
      <input type="url" data-pdev-source-field="sourceUrl" value="${pdevEsc(sourceUrl)}" placeholder="https://detail.1688.com/offer/....html" />
      ${href ? `<a class="pdev-link" href="${pdevEsc(href)}" target="_blank" rel="noopener noreferrer">打开货源链接 ↗</a>` : '<span class="pdev-inline-msg">未填货源链接：人工补齐后才能核对与比价</span>'}
    </label>

    <div class="pdev-source-fields">
      <label class="pdev-field"><span>供货价</span><input type="number" step="0.01" min="0" data-pdev-source-field="supplyPrice" value="${source.supplyPrice == null ? "" : pdevEsc(source.supplyPrice)}" /></label>
      <label class="pdev-field"><span>币种</span><input type="text" maxlength="3" data-pdev-source-field="supplyCurrency" value="${pdevEsc(source.supplyCurrency || "CNY")}" /></label>
      <label class="pdev-field"><span>起订量</span><input type="number" step="1" min="0" data-pdev-source-field="moq" value="${source.moq == null ? "" : pdevEsc(source.moq)}" /></label>
      <label class="pdev-field"><span>供应商</span><input type="text" maxlength="255" data-pdev-source-field="supplierName" value="${pdevEsc(source.supplierName || "")}" /></label>
      <label class="pdev-field"><span>供货状态</span>
        <select data-pdev-source-field="supplyStatus">
          ${PDEV_SOURCE_STATUS_OPTIONS.map((item) => `<option value="${pdevEsc(item)}" ${item === status ? "selected" : ""}>${pdevEsc(PDEV_SOURCE_STATUS_LABEL[item] || item)}</option>`).join("")}
        </select>
      </label>
      <label class="pdev-field pdev-field-wide"><span>备注</span><input type="text" data-pdev-source-field="note" value="${pdevEsc(source.note || "")}" /></label>
    </div>

    <div class="pdev-source-actions">
      <button type="button" data-pdev-source-save="${pdevEsc(id)}">保存这条货源</button>
      <button type="button" class="pdev-danger-btn" data-pdev-source-delete="${pdevEsc(id)}">删除</button>
      <span class="pdev-inline-msg" data-pdev-source-msg="${pdevEsc(id)}"></span>
    </div>
  </article>`;
}

function pdevRenderAssets() {
  if (!pdevAssetList) return;
  const assets = (pdevState.detail && pdevState.detail.assets) || [];
  if (!assets.length) {
    pdevAssetList.innerHTML = '<div class="pdev-empty">还没有素材。至少补 1 张主图才能推进到「资料齐备」。</div>';
    return;
  }
  pdevAssetList.innerHTML = assets
    .map((asset) => {
      const type = String(asset.assetType || "");
      const url = String(asset.sourceUrl || asset.storageUrl || "").trim();
      const href = pdevSafeHttpUrl(url);
      const safeImg = typeof safeImageUrl === "function" ? safeImageUrl(url) : pdevSafeHttpUrl(url);
      return `<div class="pdev-asset-row" data-pdev-asset-row="${pdevEsc(asset.id)}">
        ${safeImg ? `<img class="pdev-asset-thumb" src="${pdevEsc(safeImg)}" alt="${pdevEsc(type)}" loading="lazy" / referrerpolicy="no-referrer">` : ""}
        <span class="pdev-status-badge ${type === "main" ? "s-info_ready" : ""}">${pdevEsc(PDEV_ASSET_TYPE_LABEL[type] || type)}</span>
        <span class="pdev-field-label pdev-auto-tag">${href ? `<a class="pdev-link" href="${pdevEsc(href)}" target="_blank" rel="noopener noreferrer">${pdevEsc(url)}</a>` : pdevEsc(url || "（无地址）")}</span>
        <span>排序 ${pdevEsc(asset.sortNo == null ? 0 : asset.sortNo)}</span>
        <button type="button" class="pdev-danger-btn" data-pdev-asset-delete="${pdevEsc(asset.id)}">删除</button>
      </div>`;
    })
    .join("");
}

function pdevRenderVariants() {
  if (!pdevVariantList) return;
  const variants = (pdevState.detail && pdevState.detail.variants) || [];
  if (!variants.length) {
    pdevVariantList.innerHTML = '<div class="pdev-empty">还没有变体。至少 1 个变体才能推进到「已定稿」。</div>';
    return;
  }
  pdevVariantList.innerHTML = variants
    .map((variant) => {
      const spec = variant.spec && typeof variant.spec === "object" ? variant.spec : {};
      const specText = Object.entries(spec).map(([key, value]) => `${key}=${value}`).join("; ") || "（空规格）";
      return `<div class="pdev-variant-row" data-pdev-variant-row="${pdevEsc(variant.id)}">
        <span class="pdev-variant-spec">${pdevEsc(specText)}</span>
        <span>${pdevEsc(pdevFormatPrice(variant.supplyPrice, "CNY"))}</span>
        <span>重量 ${variant.weightKg == null ? "-" : pdevEsc(variant.weightKg)} kg</span>
        <span>包装 ${variant.packageLengthCm == null ? "-" : pdevEsc(variant.packageLengthCm)}×${variant.packageWidthCm == null ? "-" : pdevEsc(variant.packageWidthCm)}×${variant.packageHeightCm == null ? "-" : pdevEsc(variant.packageHeightCm)} cm</span>
        <span class="pdev-inline-msg">变体暂不支持删除</span>
      </div>`;
    })
    .join("");
}

function pdevHideMissing() {
  if (!pdevMissingBox) return;
  pdevMissingBox.classList.add("hidden");
  pdevMissingBox.innerHTML = "";
}

// 状态推进失败：展示契约的 missing 列表（缺什么就提示补什么）
function pdevShowMissing(missing, to, rawDetail) {
  if (!pdevMissingBox) return;
  const list = Array.isArray(missing) ? missing : [];
  if (!list.length) {
    pdevHideMissing();
    return;
  }
  const raw = String(rawDetail || "").trim();
  if (raw) pdevMissingBox.title = raw;
  pdevMissingBox.classList.remove("hidden");
  pdevMissingBox.innerHTML = `<strong>推进到「${pdevEsc(PDEV_STATUS_LABEL[to] || to || "目标状态")}」失败：还缺以下资料</strong>
    <ul>${pdevMissingListHtml(list)}</ul>
    <div class="pdev-inline-msg">按清单补齐后重试：缺货源用下面的「贴货源链接」挂上，缺价格给在售货源填供货价，缺主图在素材区加一张主图，缺变体在变体区添加。</div>
    ${raw ? `<details class="pdev-tech"><summary>技术详情（原始返回，仅供排查）</summary><code>${pdevEsc(raw)}</code></details>` : ""}`;
}

// ---------------------------------------------------------------------------
// 交互：列表 / 新建 / 筛选
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 详情入口只有一个：点列表里的「商品SKU」→ 新标签页打开独立详情页
//   /product-detail.html?id=<编号>（无菜单外壳；状态推进/产品资料/货源/素材/变体 全部在那里）
// 该独立页复用本文件的渲染与交互逻辑（同一份代码，不存在第二套实现）。
// ---------------------------------------------------------------------------
// 「在新标签页打开详情」的地址：指向**独立页面**
function pdevDetailHref(publicId, mode) {
  return (() => { const baseHref = `/product-detail.html?id=${encodeURIComponent(String(publicId || ""))}`; const sep = baseHref.indexOf("?") >= 0 ? "&" : "?"; return baseHref + sep + "mode=" + encodeURIComponent(mode === "view" ? "view" : "edit") + "&v=20261011"; })();
}

// 复制编号到剪贴板（「复制」小组件用）。
// 本页是 http://127.0.0.1:3000，属于浏览器认定的安全上下文，navigator.clipboard 可用；
// 万一不可用（旧浏览器/非安全上下文）则退回 textarea + execCommand。
async function pdevCopySku(text, button) {
  const value = String(text || "").trim();
  if (!value) return;
  let ok = false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(value);
      ok = true;
    }
  } catch (error) {
    ok = false;
  }
  if (!ok) {
    try {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "-1000px";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      ok = Boolean(document.execCommand && document.execCommand("copy"));
      document.body.removeChild(area);
    } catch (error) {
      ok = false;
    }
  }
  if (!button) return;
  // 图标组件：成功 → 换成绿色对勾；失败 → 图标染红。1.2 秒后复位。
  button.classList.toggle("is-copied", ok);
  button.classList.toggle("is-failed", !ok);
  button.title = ok ? "已复制" : "复制失败（浏览器拒绝写剪贴板）";
  setTimeout(() => {
    button.classList.remove("is-copied", "is-failed");
    button.title = "复制商品SKU";
  }, 1200);
}

// ---------------------------------------------------------------------------
// 编辑权限 与 编辑日志
//   · 写权限：只有「产品开发」（product_dev）与「管理员」（admin）。其余角色（运营/客服/财务/超级管理员）只读。
//     前端只是不渲染按钮——真正的拦截在后端 pdev.write 权限校验里（绕过前端照样 403）。
//   · 日志：**所有人都能看**（后端该接口只要求登录），不设角色限制。
// ---------------------------------------------------------------------------
function pdevCanWrite() {
  const role = (typeof state !== "undefined" && state && state.user) ? String(state.user.role || "").trim() : "";
  return role === "admin" || role === "product_dev";
}

const PDEV_ACTION_LABEL = { create: "新建", update: "修改", delete: "删除", read: "查看", diagnose: "诊断" };

// 「状态标签」列：三个维度的状态标签（商品状态 / 销售状态 / 货源状态）。
// 三个都是人工在「产品资料」里选的（货源状态也由人工判断，不做自动推导）。
const PDEV_STATUS_TAG_DEFS = [
  ["goodsStatus", "商品状况", "goods", ["在售", "停售", "禁售"]],
  ["salesStatus", "销售状况", "sales", ["新品", "畅销", "平销", "低销", "清仓", "待下架", "下架"]],
  ["sourceStatus", "货源状况", "source", ["正常货源", "货源受限"]]
];
// 这些取值是"负向/需注意"的，标成橙色以便一眼看出来
const PDEV_STATUS_TAG_WARN = new Set(["停售", "禁售", "低销", "清仓", "待下架", "下架", "货源受限"]);

function pdevStatusTagsHtml(product) {
  const tags = PDEV_STATUS_TAG_DEFS.map(([key, prefix, tone, allowed]) => {
    const value = String((product && product[key]) || "").trim();
    if (!value) return "";
    const warn = PDEV_STATUS_TAG_WARN.has(value) ? " is-warn" : "";
    const ok = allowed.indexOf(value) >= 0 ? "" : " is-unknown";
    return `<span class="pdev-tag pdev-tag-${tone}${warn}${ok}" title="${pdevEsc(prefix)}状态：${pdevEsc(value)}">${pdevEsc(prefix)}：${pdevEsc(value)}</span>`;
  }).filter(Boolean);
  return tags.length ? tags.join("") : "—";
}

// 字段名 → 人话（日志里"改了哪个字段"要看得懂）
const PDEV_FIELD_LABEL = {
  title: "商品名称", remark: "备注", categoryHint: "平台类目", systemCategory: "系统类目", targetPlatform: "目标平台", ownerUserId: "负责人账号",
  to: "推进到", status: "状态",
  platform: "平台", sourceProductId: "货源商品ID", sourceUrl: "货源链接", supplyPrice: "供货价",
  supplyCurrency: "币种", moq: "起订量", supplierName: "供应商", supplyStatus: "供货状态", note: "备注",
  assetType: "素材类型", url: "素材地址", sortNo: "排序",
  variantKey: "规格", spec: "规格明细", weightKg: "重量kg",
  packageLengthCm: "包装长cm", packageWidthCm: "包装宽cm", packageHeightCm: "包装高cm"
};

function pdevBriefValue(value) {
  if (value === null || value === undefined || value === "") return "（空）";
  if (typeof value === "object") {
    try {
      const text = JSON.stringify(value);
      return text.length > 60 ? `${text.slice(0, 60)}…` : text;
    } catch (error) {
      return "[对象]";
    }
  }
  const text = String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

// 把「这次请求改了什么」说清楚：新建列出初始值；修改列出 字段 → 新值；推进状态写目标状态；删除写整条删除。
function pdevDescribeChange(log) {
  const action = String((log && log.actionType) || "");
  if (action === "delete") return "删除整条商品（连带货源 / 素材 / 变体）";
  const body = (log && (log.requestBodyMasked || log.requestBody)) || null;
  const skip = new Set(["expectedRowVersion", "rowVersion", "publicId", "id"]);
  if (action === "create") {
    const keys = body && typeof body === "object" ? Object.keys(body).filter((k) => !skip.has(k)) : [];
    if (!keys.length) return "新建商品";
    return `新建：${keys.slice(0, 6).map((k) => `${PDEV_FIELD_LABEL[k] || k}=${pdevBriefValue(body[k])}`).join("、")}`;
  }
  const source = body && typeof body === "object" && (body.patch || body.changes)
    ? (body.patch || body.changes)
    : body;
  if (!source || typeof source !== "object") return "—";
  const entries = Object.entries(source).filter(([k]) => !skip.has(k));
  if (!entries.length) return "—";
  return entries.slice(0, 8)
    .map(([k, v]) => (k === "to" ? `推进到：${pdevBriefValue(PDEV_STATUS_LABEL[String(v)] || v)}` : `${PDEV_FIELD_LABEL[k] || k} → ${pdevBriefValue(v)}`))
    .join("；");
}

async function pdevOpenLogModal(publicId) {
  const id = String(publicId || "").trim();
  if (!id || !pdevLogModalMask) return;
  if (pdevLogModalTitle) pdevLogModalTitle.textContent = `编辑日志 · ${id}`;
  if (pdevLogHint) pdevLogHint.textContent = "正在加载…";
  if (pdevLogRows) pdevLogRows.innerHTML = `<tr><td colspan="7" class="pdev-empty-cell">正在加载…</td></tr>`;
  pdevLogModalMask.classList.remove("hidden");
  const result = await pdevRequest(pdevApiPath(`/products/${encodeURIComponent(id)}/logs`), { method: "GET" });
  if (!result.ok) {
    if (pdevLogRows) pdevLogRows.innerHTML = `<tr><td colspan="7" class="pdev-empty-cell">日志加载失败（HTTP ${pdevEsc(result.status)}）</td></tr>`;
    if (pdevLogHint) pdevLogHint.textContent = "";
    return;
  }
  const items = (result.data && Array.isArray(result.data.items)) ? result.data.items : [];
  if (pdevLogHint) pdevLogHint.textContent = items.length ? `共 ${items.length} 条，最近在前` : "这件商品还没有任何操作记录。";
  if (!pdevLogRows) return;
  if (!items.length) {
    pdevLogRows.innerHTML = `<tr><td colspan="7" class="pdev-empty-cell">暂无日志</td></tr>`;
    return;
  }
  pdevLogRows.innerHTML = items.map((log) => {
    const ok = Number(log.success) === 1;
    const note = String(log.errorMessage || log.warningMessage || "").trim();
    return `<tr>
      <td class="pdev-log-time">${pdevEsc(pdevFormatTime(log.tsDt || log.ts))}</td>
      <td>${pdevEsc(String(log.actorUsername || "-"))}</td>
      <td>${pdevEsc(String(log.actorRole || "-"))}</td>
      <td>${pdevEsc(PDEV_ACTION_LABEL[String(log.actionType || "")] || String(log.actionType || "-"))}</td>
      <td class="pdev-log-change">${pdevEsc(pdevDescribeChange(log))}</td>
      <td class="${ok ? "" : "pdev-log-fail"}">${ok ? "成功" : "失败"}</td>
      <td class="pdev-log-note">${pdevEsc(note || "—")}</td>
    </tr>`;
  }).join("");
}

function pdevCloseLogModal() {
  if (pdevLogModalMask) pdevLogModalMask.classList.add("hidden");
}

// 「商品资料」列：最新采购价（￥）/ 采购链接 / 参考链接，三行竖排
// 平台矢量徽标（内联 SVG）：按链接域名识别平台，用品牌色画一个可缩放的徽标。
// 用 SVG 而不是图片文件：放大不糊、不依赖外部资源、不会被防盗链拦。
function pdevPlatformLogo(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  let host = "";
  try { host = new URL(raw, location.origin).hostname.toLowerCase(); } catch (e) { host = raw.toLowerCase(); }
  const table = [
    [/1688\.com/, "1688", "#FF6A00"],
    [/alibaba\.com/, "Alibaba", "#FF6A00"],
    [/taobao\.com/, "淘宝", "#FF5000"],
    [/tmall\.com/, "天猫", "#FF0036"],
    [/yangkeduo\.com|pinduoduo\.com/, "拼多多", "#E02E24"],
    [/(^|\.)jd\.com/, "京东", "#E1251B"],
    [/amazon\./, "Amazon", "#FF9900"],
    [/(^|\.)ozon\./, "Ozon", "#005BFF"],
    [/yandex\./, "Yandex", "#FC3F1D"],
    [/(^|\.)aliexpress\./, "AliExpress", "#E62E04"],
    [/goofish\.com|2\.taobao/, "闲鱼", "#FFE60F"]
  ];
  let name = host.replace(/^www\./, "");
  let color = "#2563eb";
  for (const [re, label, hex] of table) {
    if (re.test(host)) { name = label; color = hex; break; }
  }
  // 有官方 logo 图的平台优先用真图（用户提供的 1688 官方 logo，已放进 frontend/assets/logos/）
  if (name === "1688") {
    return '<img class="pdev-plat-logo" src="/assets/logos/1688.png" alt="1688" title="1688" style="height:16px;width:auto;display:inline-block;vertical-align:-3px;" />';
  }
  if (!name) return "";
  const text = name.length > 12 ? name.slice(0, 12) : name;
  const w = Math.max(34, text.length * 8 + 16);
  const dark = color === "#FFE60F";
  const fg = dark ? "#111827" : "#ffffff";
  return '<svg class="pdev-plat-logo" width="' + w + '" height="20" viewBox="0 0 ' + w + ' 20" role="img" aria-label="' + pdevEsc(text) + '" xmlns="http://www.w3.org/2000/svg">'
    + '<rect x="0" y="0" width="' + w + '" height="20" rx="4" fill="' + color + '" />'
    + '<text x="' + (w / 2) + '" y="14" text-anchor="middle" font-family="-apple-system,Segoe UI,Microsoft YaHei,sans-serif" font-size="12" font-weight="700" fill="' + fg + '">' + pdevEsc(text) + "</text>"
    + "</svg>";
}
function pdevMaterialCellHtml(product) {
  const price = product && product.purchasePrice !== null && product.purchasePrice !== undefined && String(product.purchasePrice) !== ""
    ? pdevEsc(String(product.purchasePrice))
    : "—";
  const link = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return "—";
    // title = 完整地址（鼠标悬停可见）；target=_blank 点击新标签打开
    // 可见内容 = 平台矢量徽标（识别不出平台时退回显示短地址）；悬停显示完整地址，点击新标签打开
    const logo = pdevPlatformLogo(raw);
    return '<a class="pdev-mat-link" href="' + pdevEsc(raw) + '" title="' + pdevEsc(raw) + '" target="_blank" rel="noopener noreferrer">' + (logo || pdevEsc(pdevShortUrl(raw))) + "</a>";
  };
  return '<span class="pdev-mat-line">最新采购价（￥）：' + price + "</span>"
    + '<span class="pdev-mat-line">采购链接：' + link(product && product.purchaseUrl) + "</span>"
    + '<span class="pdev-mat-line">参考链接：' + link(product && product.referenceUrl) + "</span>";
}

// 链接列只显示"主机名/…/末段"，避免长链接把表格撑爆；完整地址在 href 里（可点、可复制）
function pdevShortUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, location.origin);
    const host = url.hostname || "";
    const parts = url.pathname && url.pathname !== "/" ? url.pathname.split("/").filter(Boolean) : [];
    const tail = parts.length ? parts[parts.length - 1] : "";
    return tail ? host + "/…/" + tail : host;
  } catch (error) {
    return raw.length > 32 ? raw.slice(0, 32) + "…" : raw;
  }
}
// 商品管理里的「系统类目」选项来自系统类目清单接口（/api/system-categories），只列启用的。
function pdevFillSystemCategoryOptions() {
  const targets = [document.getElementById("pdevProductSystemCategory"), document.getElementById("pdevCreateSystemCategory")];
  if (!targets.some(Boolean)) return;
  pdevRequest(pdevApiPath("/../system-categories"), { method: "GET" }).then((result) => {
    if (!result || !result.ok) return;
    const items = (result.data && Array.isArray(result.data.items)) ? result.data.items : [];
    const options = items.filter((item) => item && item.enabled !== false && String(item.name || "").trim());
    targets.forEach((el) => {
      if (!el) return;
      const keep = String(el.value || "");
      el.innerHTML = '<option value="">不标记</option>' + options
        .map((item) => '<option value="' + pdevEsc(String(item.name)) + '">' + pdevEsc(String(item.name)) + '</option>')
        .join("");
      if (keep) el.value = keep;
    });
  }).catch(() => { /* 取不到就保持空下拉，不影响保存 */ });
}

async function pdevSelectProduct(publicId) {
  const target = String(publicId || "").trim();
  if (!target) return;
  pdevState.selectedPublicId = target;
  pdevRenderList();
  await pdevLoadDetail(target);
}

async function pdevOnCreateSubmit(event) {
  event.preventDefault();
  const title = String((pdevCreateTitle && pdevCreateTitle.value) || "").trim();
  if (!title) {
    pdevSetInline(pdevCreateMsg, "标题必填", "error");
    return;
  }
  const payload = { title };
  const remark = String((pdevCreateRemark && pdevCreateRemark.value) || "").trim();
  const categoryHint = String((pdevCreateCategory && pdevCreateCategory.value) || "").trim();
  const targetPlatform = String((pdevCreatePlatform && pdevCreatePlatform.value) || "").trim();
  if (remark) payload.remark = remark;
  if (categoryHint) payload.categoryHint = categoryHint;
  if (targetPlatform) payload.targetPlatform = targetPlatform;
      for (const [key, id] of [["goodsStatus", "pdevCreateGoodsStatus"], ["salesStatus", "pdevCreateSalesStatus"], ["sourceStatus", "pdevCreateSourceStatus"]]) {
        const el = document.getElementById(id);
        const value = String((el && el.value) || "").trim();
        if (value) payload[key] = value;
      }
      for (const [key, id] of [["purchasePrice", "pdevCreatePurchasePrice"], ["purchaseUrl", "pdevCreatePurchaseUrl"], ["referenceUrl", "pdevCreateReferenceUrl"], ["isBundle", "pdevCreateIsBundle"], ["sku", "pdevCreateSku"], ["systemCategory", "pdevCreateSystemCategory"]]) {
        const el = document.getElementById(id);
        const value = String((el && el.value) || "").trim();
        if (value) payload[key] = value;
      }
  pdevSetWorking(pdevCreateMsg, "正在创建…");
  const result = await pdevRequest(pdevApiPath("/products"), { method: "POST", body: JSON.stringify(payload) });
  if (!result.ok) {
    pdevShowError(pdevCreateMsg, result, "创建产品失败");
    return;
  }
  const product = (result.data && result.data.product) || null;
  pdevSetInline(pdevCreateMsg, `已创建 ${product ? product.publicId : ""}`, "ok");
  pdevCloseCreateModal();
  pdevState.page = 1;
  await pdevReload({ silent: true });
  if (product && product.publicId) await pdevSelectProduct(product.publicId);
}

function pdevOnListClick(event) {
  const el = event.target;
  // 勾选框只切换选中状态，不能顺带打开详情
  if (el && typeof el.matches === "function" && el.matches("input[data-pdev-select]")) {
    pdevToggleRowSelection(el.getAttribute("data-pdev-select"), el.checked);
    return;
  }
  // 「商品SKU」链接：交给浏览器开新标签页，本标签页不要跟着切到详情视图
  if (el && typeof el.matches === "function" && el.matches("a[data-pdev-sku]")) return;
  // 「复制」小组件：只把编号复制到剪贴板，不跳转、不打开详情
  const copyBtn = el && typeof el.closest === "function" ? el.closest("[data-pdev-copy]") : null;
  if (copyBtn) {
    pdevCopySku(copyBtn.getAttribute("data-pdev-copy"), copyBtn);
    return;
  }
  // 「日志」：所有人可看（后端只要求登录）
  const logBtn = el && typeof el.closest === "function" ? el.closest("[data-pdev-log]") : null;
  if (logBtn) {
    pdevOpenLogModal(logBtn.getAttribute("data-pdev-log"));
    return;
  }
  // 「编辑」：在新标签页打开详情页（编辑表单都在那里，与点 SKU 同一个页面）
  const editBtn = el && typeof el.closest === "function" ? el.closest("[data-pdev-edit]") : null;
  if (editBtn) {
    const id = String(editBtn.getAttribute("data-pdev-edit") || "").trim();
    if (id) globalThis.open(pdevDetailHref(id, "edit"), "_blank", "noopener");
    return;
  }
  // 「删除」：二次确认后删除（会连带货源/素材/变体），成功则刷新列表
  const delBtn = el && typeof el.closest === "function" ? el.closest("[data-pdev-delete]") : null;
  if (delBtn) {
    pdevDeleteProductRow(delBtn.getAttribute("data-pdev-delete"), delBtn);
    return;
  }
  const target = event.target && event.target.closest ? event.target.closest("[data-pdev-open]") : null;
  if (!target) return;
  const publicId = String(target.getAttribute("data-pdev-open") || "").trim();
  if (publicId) pdevSelectProduct(publicId);
}

// 列表里的「删除」：二次确认 → DELETE /products/:publicId → 刷新列表
async function pdevDeleteProductRow(publicId, button) {
  const id = String(publicId || "").trim();
  if (!id) return;
  const confirmed = typeof confirm === "function"
    ? confirm(`删除商品 ${id}？会连带删除其货源/素材/变体，且不可恢复。`)
    : false;
  if (!confirmed) return;
  if (button) {
    button.disabled = true;
    button.textContent = "删除中…";
  }
  const result = await pdevRequest(pdevApiPath(`/products/${encodeURIComponent(id)}`), { method: "DELETE" });
  if (!result.ok) {
    if (button) {
      button.disabled = false;
      button.textContent = "删除";
    }
    pdevSetMessage(`删除 ${id} 失败：${pdevErrorInfo(result, "删除失败").text}`, "error");
    return;
  }
  pdevSetMessage(`已删除 ${id}`, "ok");
  if (pdevState.selectedPublicId === id) {
    pdevState.selectedPublicId = "";
    pdevState.detail = null;
  }
  await pdevReload({ silent: true });
}

async function pdevOnPagerClick(event) {
  const target = event.target && event.target.closest ? event.target.closest("[data-pdev-page]") : null;
  if (!target) return;
  const page = Number(target.getAttribute("data-pdev-page") || 0);
  if (!Number.isFinite(page) || page < 1) return;
  pdevState.page = page;
  await pdevLoadList();
}

async function pdevOnSearch() {
  const sku = String((pdevSearchSku && pdevSearchSku.value) || "").trim();
  const skuMode = String((pdevSearchSkuMode && pdevSearchSkuMode.value) || "exact").trim();
  const title = String((pdevSearchTitle && pdevSearchTitle.value) || "").trim();
  const titleMode = String((pdevSearchTitleMode && pdevSearchTitleMode.value) || "fuzzy").trim();

  // 列表接口只有一个 q，且服务端只拿它去 LIKE 标题（= 模糊）；没有商品名称精准 / SKU 筛选。
  // 因此：商品名称「模糊」= 真筛选；商品SKU「精准」= 借详情接口 GET /products/:publicId 直接点名取（现有接口
  // 就支持，真能用）；商品名称「精准」、商品SKU「模糊」= 服务端不支持，记进 searchPending 明确告知，
  // 绝不静默忽略（商品名称精准时会照常给出模糊结果，但会写明精准未生效）。
  // 注：「价格」筛选已按需求移除，后续再加（见 product-dev.html 里的加回清单）。
  pdevState.keyword = title;
  pdevState.searchPending = [];
  pdevState.page = 1;
  await pdevLoadList(); // 先按标题刷新列表（唯一的服务端筛选）

  const notices = [];
  if (sku) {
    if (skuMode === "exact") {
      // 精准：按编号直接点名取（GET /products/:publicId，与详情是同一个接口）。
      // 支持批量：空白 / 逗号 / 分号分隔多个编号（从表格粘贴一列正好是这个形态），逐个探测后打开第一个命中的。
      const targets = sku.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean);
      const hits = [];
      for (const target of targets) {
        // 先探测是否存在，避免把 404 渲染成详情区的报错
        const probe = await pdevRequest(pdevApiPath(`/products/${encodeURIComponent(target)}`), { method: "GET" });
        if (probe.ok) hits.push(target);
      }
      if (hits.length) {
        await pdevSelectProduct(hits[0]);
        notices.push(
          targets.length > 1
            ? `商品SKU 精准命中 ${hits.length}/${targets.length} 个（${hits.join("、")}），已打开「${hits[0]}」`
            : `商品SKU 精准命中「${hits[0]}」，已打开它的详情`
        );
      } else {
        notices.push(
          targets.length > 1
            ? `这 ${targets.length} 个商品SKU 都没有对应商品`
            : `没有商品SKU 为「${targets[0]}」的商品`
        );
      }
    } else {
      pdevState.searchPending.push("商品SKU（模糊）");
    }
  }
  if (title && titleMode === "exact") pdevState.searchPending.push("商品名称（精准）");
  if (pdevState.searchPending.length) {
    notices.push(`本次未参与筛选：${pdevState.searchPending.join("、")}（后端暂无对应字段）`);
  }
  // 提示条由 #pdevBackendNotice 承载（"共 N 条"那行与旧状态行均已按要求移除）
  if (notices.length) pdevSetMessage(notices.join("；"), "error");
}

function pdevResetSearch() {
  if (pdevSearchSku) pdevSearchSku.value = "";
  if (pdevSearchTitle) pdevSearchTitle.value = "";
  return pdevOnSearch();
}

// 新建商品：弹窗（沿用项目 modal-mask 约定）
function pdevOpenCreateModal() {
  if (!pdevCreateModalMask) return;
  if (pdevCreateForm) pdevCreateForm.reset();
  pdevSetInline(pdevCreateMsg, "", "");
  pdevCreateModalMask.classList.remove("hidden");
  if (pdevCreateTitle) pdevCreateTitle.focus();
}

function pdevCloseCreateModal() {
  if (pdevCreateModalMask) pdevCreateModalMask.classList.add("hidden");
  pdevSetInline(pdevCreateMsg, "", "");
}

// ---------------------------------------------------------------------------
// 交互：详情（接口 4 / 5 / 12）
// ---------------------------------------------------------------------------
async function pdevOnProductSubmit(event) {
  event.preventDefault();
  const product = pdevState.detail && pdevState.detail.product;
  if (!product) return;
  const title = String((pdevProductTitle && pdevProductTitle.value) || "").trim();
  if (!title) {
    pdevSetInline(pdevProductFormMsg, "标题不能为空", "error");
    return;
  }
  const patch = {
    title,
    remark: String((pdevProductRemark && pdevProductRemark.value) || ""),
        systemCategory: String((pdevProductSystemCategory && pdevProductSystemCategory.value) || ""),
        // 包装信息：把表单里 23 个字段一起提交（后端已按白名单接收）
        ...PDEV_PACK_KEYS.reduce((acc, key) => {
          const el = document.getElementById("pdevPack_" + key);
          acc[key] = el ? String(el.value == null ? "" : el.value).trim() : "";
          return acc;
        }, {}),
        goodsStatus: String((pdevProductGoodsStatus && pdevProductGoodsStatus.value) || ""),
        salesStatus: String((pdevProductSalesStatus && pdevProductSalesStatus.value) || ""),
        sourceStatus: String((pdevProductSourceStatus && pdevProductSourceStatus.value) || ""),
        purchasePrice: String((pdevProductPurchasePrice && pdevProductPurchasePrice.value) || ""),
        purchaseUrl: String((pdevProductPurchaseUrl && pdevProductPurchaseUrl.value) || ""),
        referenceUrl: String((pdevProductReferenceUrl && pdevProductReferenceUrl.value) || ""),
        isBundle: String((pdevProductIsBundle && pdevProductIsBundle.value) || ""),
    ownerUserId: String((pdevProductOwner && pdevProductOwner.value) || "")
  };
  pdevSetWorking(pdevProductFormMsg, "正在保存…");
  const result = await pdevRequest(pdevApiPath(`/products/${encodeURIComponent(product.publicId)}`), {
    method: "PATCH",
    body: JSON.stringify({ expectedRowVersion: Number(product.rowVersion || 0), patch })
  });
  if (!result.ok) {
    pdevShowError(pdevProductFormMsg, result, "保存失败");
    return;
  }
  const updated = (result.data && result.data.product) || null;
  if (updated) pdevState.detail.product = updated;
  pdevSetInline(pdevProductFormMsg, "已保存", "ok");
  pdevRenderDetail();
  await pdevLoadList({ silent: true });
}

async function pdevOnDeleteProduct() {
  const product = pdevState.detail && pdevState.detail.product;
  if (!product) return;
  const label = `${product.publicId}（${pdevText(product.title, "无标题")}）`;
  const confirmed = typeof confirm === "function" ? confirm(`删除 ${label}？会连带删除其货源/素材/变体，且不可恢复。`) : false;
  if (!confirmed) return;
  pdevSetWorking(pdevProductFormMsg, "正在删除…");
  const result = await pdevRequest(pdevApiPath(`/products/${encodeURIComponent(product.publicId)}`), { method: "DELETE" });
  if (!result.ok) {
    pdevShowError(pdevProductFormMsg, result, "删除失败");
    return;
  }
  pdevState.detail = null;
  pdevState.selectedPublicId = "";
  pdevRenderDetail();
  await pdevReload({ silent: true });
  pdevSetMessage(`已删除 ${label}`, "ok");
}

async function pdevOnAdvanceStatus(to) {
  const product = pdevState.detail && pdevState.detail.product;
  if (!product) return;
  const target = String(to || "").trim();
  if (!target) return;
  pdevHideMissing();
  pdevSetWorking(pdevDetailMessage, `正在推进到「${PDEV_STATUS_LABEL[target] || target}」…`);
  const result = await pdevRequest(pdevApiPath(`/products/${encodeURIComponent(product.publicId)}/status`), {
    method: "POST",
    body: JSON.stringify({ to: target, expectedRowVersion: Number(product.rowVersion || 0) })
  });
  if (!result.ok) {
    const info = pdevErrorInfo(result, "状态推进失败");
    pdevSetInline(pdevDetailMessage, `状态推进失败：${info.text}`, "error", info.detail);
    // §11.4：missing 列表照旧展示（缺什么补什么）
    pdevShowMissing(info.missing, target, info.detail);
    return;
  }
  const updated = (result.data && result.data.product) || null;
  if (updated && pdevState.detail) pdevState.detail.product = updated;
  pdevSetInline(pdevDetailMessage, `状态已推进到「${PDEV_STATUS_LABEL[target] || target}」`, "ok");
  await pdevLoadDetail(product.publicId, { silent: true });
  await pdevLoadList({ silent: true });
}

// ---------------------------------------------------------------------------
// 交互：挂货源（接口 6 / 7 / 8）
// ---------------------------------------------------------------------------
function pdevOnParseSourceUrl() {
  const parsed = pdevParseSourceUrl(pdevSourceUrl && pdevSourceUrl.value);
  if (parsed.platform) pdevSetValue(pdevSourcePlatform, parsed.platform);
  if (parsed.sourceProductId) pdevSetValue(pdevSourceProductId, parsed.sourceProductId);
  if (!parsed.platform && !parsed.sourceProductId) {
    pdevSetInline(pdevSourceFormMsg, "没能从链接里解析出平台/货源ID，请手动填写（解析结果一律人工核对）", "error");
    return;
  }
  pdevSetInline(pdevSourceFormMsg, `已按链接填入：平台 ${pdevText(parsed.platform, "（未识别）")}｜货源ID ${pdevText(parsed.sourceProductId, "（未识别）")}，请核对后再挂`, "ok");
}

async function pdevOnSourceSubmit(event) {
  event.preventDefault();
  const product = pdevState.detail && pdevState.detail.product;
  if (!product) {
    pdevSetInline(pdevSourceFormMsg, "请先在左侧选择一个产品", "error");
    return;
  }
  const platform = String((pdevSourcePlatform && pdevSourcePlatform.value) || "1688").trim();
  const sourceProductId = String((pdevSourceProductId && pdevSourceProductId.value) || "").trim();
  if (!platform || !sourceProductId) {
    pdevSetInline(pdevSourceFormMsg, "平台和货源商品ID必填", "error");
    return;
  }
  const payload = {
    platform,
    sourceProductId,
    sourceUrl: String((pdevSourceUrl && pdevSourceUrl.value) || "").trim(),
    supplyCurrency: String((pdevSourceCurrency && pdevSourceCurrency.value) || "CNY").trim() || "CNY",
    supplyStatus: String((pdevSourceStatus && pdevSourceStatus.value) || "unknown").trim() || "unknown"
  };
  const supplyPrice = pdevNumberOrNull(pdevSourcePrice && pdevSourcePrice.value);
  const moq = pdevNumberOrNull(pdevSourceMoq && pdevSourceMoq.value);
  const supplierName = String((pdevSourceSupplier && pdevSourceSupplier.value) || "").trim();
  if (supplyPrice !== null) payload.supplyPrice = supplyPrice;
  if (moq !== null) payload.moq = moq;
  if (supplierName) payload.supplierName = supplierName;

  pdevSetWorking(pdevSourceFormMsg, "正在匹配并挂货源…");
  const result = await pdevRequest(pdevApiPath(`/products/${encodeURIComponent(product.publicId)}/sources`), {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (!result.ok) {
    // 409：把「该货源已被 PD_xxx 占用」讲清楚（占用方来自结构化 publicId）
    pdevShowError(pdevSourceFormMsg, result, "挂货源失败");
    return;
  }
  const source = (result.data && result.data.source) || null;
  pdevSetInline(pdevSourceFormMsg, `已挂上货源 #${source ? source.id : "-"}（${platform} / ${sourceProductId}）`, "ok");
  if (pdevSourceForm) {
    if (pdevSourceUrl) pdevSourceUrl.value = "";
    if (pdevSourceProductId) pdevSourceProductId.value = "";
    if (pdevSourcePrice) pdevSourcePrice.value = "";
    if (pdevSourceMoq) pdevSourceMoq.value = "";
    if (pdevSourceSupplier) pdevSourceSupplier.value = "";
  }
  await pdevLoadDetail(product.publicId, { silent: true });
  await pdevLoadList({ silent: true });
}

async function pdevSaveSourceRow(sourceId) {
  const source = ((pdevState.detail && pdevState.detail.sources) || []).find((item) => String(item.id) === String(sourceId));
  const row = pdevFindRow(pdevSourceList, "pdev-source-row", sourceId);
  const messageEl = row && row.querySelector ? row.querySelector("[data-pdev-source-msg]") : null;
  if (!source || !row) {
    pdevSetInline(messageEl, "这条货源已不在详情里，请重载详情", "error");
    return;
  }
  const readField = (name) => {
    const field = row.querySelector(`[data-pdev-source-field="${name}"]`);
    return field ? String(field.value == null ? "" : field.value).trim() : "";
  };
  const payload = {
    sourceUrl: readField("sourceUrl"),
    supplyCurrency: readField("supplyCurrency") || "CNY",
    supplierName: readField("supplierName"),
    supplyStatus: readField("supplyStatus") || source.supplyStatus || "unknown",
    note: readField("note")
  };
  payload.supplyPrice = pdevNumberOrNull(readField("supplyPrice"));
  payload.moq = pdevNumberOrNull(readField("moq"));
  pdevSetWorking(messageEl, "正在保存…");
  const result = await pdevRequest(pdevApiPath(`/sources/${encodeURIComponent(source.id)}`), {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
  if (!result.ok) {
    pdevShowError(messageEl, result, "货源保存失败");
    return;
  }
  const updated = (result.data && result.data.source) || null;
  if (updated && pdevState.detail) {
    pdevState.detail.sources = pdevState.detail.sources.map((item) => (String(item.id) === String(updated.id) ? updated : item));
  }
  pdevRenderSources();
  const nextRow = pdevFindRow(pdevSourceList, "pdev-source-row", source.id);
  const nextMsg = nextRow && nextRow.querySelector ? nextRow.querySelector("[data-pdev-source-msg]") : null;
  pdevSetInline(nextMsg, "已保存这条货源", "ok");
  await pdevLoadList({ silent: true });
}

async function pdevDeleteSourceRow(sourceId) {
  const source = ((pdevState.detail && pdevState.detail.sources) || []).find((item) => String(item.id) === String(sourceId));
  if (!source) return;
  const confirmed = typeof confirm === "function" ? confirm(`删除货源 ${source.platform} / ${source.sourceProductId}？`) : false;
  if (!confirmed) return;
  const row = pdevFindRow(pdevSourceList, "pdev-source-row", sourceId);
  const messageEl = row && row.querySelector ? row.querySelector("[data-pdev-source-msg]") : null;
  const result = await pdevRequest(pdevApiPath(`/sources/${encodeURIComponent(source.id)}`), { method: "DELETE" });
  if (!result.ok) {
    pdevShowError(messageEl, result, "货源删除失败");
    return;
  }
  if (pdevState.detail) {
    pdevState.detail.sources = pdevState.detail.sources.filter((item) => String(item.id) !== String(source.id));
  }
  pdevRenderSources();
  await pdevLoadList({ silent: true });
}

// ---------------------------------------------------------------------------
// 交互：素材（接口 9 / 10）与变体（接口 11）
// ---------------------------------------------------------------------------
async function pdevOnAssetSubmit(event) {
  event.preventDefault();
  const product = pdevState.detail && pdevState.detail.product;
  if (!product) {
    pdevSetInline(pdevAssetFormMsg, "请先在左侧选择一个产品", "error");
    return;
  }
  const assetType = String((pdevAssetType && pdevAssetType.value) || "main").trim();
  const sourceUrl = String((pdevAssetUrl && pdevAssetUrl.value) || "").trim();
  const sortNo = pdevNumberOrNull(pdevAssetSortNo && pdevAssetSortNo.value);
  const payload = { assetType, sourceUrl };
  if (sortNo !== null) payload.sortNo = sortNo;
  pdevSetWorking(pdevAssetFormMsg, "正在添加…");
  const result = await pdevRequest(pdevApiPath(`/products/${encodeURIComponent(product.publicId)}/assets`), {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (!result.ok) {
    pdevShowError(pdevAssetFormMsg, result, "素材添加失败");
    return;
  }
  pdevSetInline(pdevAssetFormMsg, `已添加${PDEV_ASSET_TYPE_LABEL[assetType] || assetType}素材`, "ok");
  if (pdevAssetUrl) pdevAssetUrl.value = "";
  await pdevLoadDetail(product.publicId, { silent: true });
  await pdevLoadList({ silent: true });
}

async function pdevDeleteAsset(assetId) {
  const asset = ((pdevState.detail && pdevState.detail.assets) || []).find((item) => String(item.id) === String(assetId));
  if (!asset) return;
  const confirmed = typeof confirm === "function" ? confirm(`删除素材 ${PDEV_ASSET_TYPE_LABEL[asset.assetType] || asset.assetType} #${asset.id}？`) : false;
  if (!confirmed) return;
  const result = await pdevRequest(pdevApiPath(`/assets/${encodeURIComponent(asset.id)}`), { method: "DELETE" });
  if (!result.ok) {
    pdevShowError(pdevAssetFormMsg, result, "素材删除失败");
    return;
  }
  if (pdevState.detail) {
    pdevState.detail.assets = pdevState.detail.assets.filter((item) => String(item.id) !== String(asset.id));
  }
  pdevRenderAssets();
  pdevSetInline(pdevAssetFormMsg, "已删除素材", "ok");
  await pdevLoadList({ silent: true });
}

async function pdevOnVariantSubmit(event) {
  event.preventDefault();
  const product = pdevState.detail && pdevState.detail.product;
  if (!product) {
    pdevSetInline(pdevVariantFormMsg, "请先在左侧选择一个产品", "error");
    return;
  }
  const parsed = pdevParseSpec(pdevVariantSpec && pdevVariantSpec.value);
  if (!parsed.ok) {
    pdevSetInline(pdevVariantFormMsg, parsed.error, "error");
    return;
  }
  const payload = { spec: parsed.spec };
  const price = pdevNumberOrNull(pdevVariantPrice && pdevVariantPrice.value);
  const weight = pdevNumberOrNull(pdevVariantWeight && pdevVariantWeight.value);
  const length = pdevNumberOrNull(pdevVariantLength && pdevVariantLength.value);
  const width = pdevNumberOrNull(pdevVariantWidth && pdevVariantWidth.value);
  const height = pdevNumberOrNull(pdevVariantHeight && pdevVariantHeight.value);
  if (price !== null) payload.supplyPrice = price;
  if (weight !== null) payload.weightKg = weight;
  if (length !== null) payload.packageLengthCm = length;
  if (width !== null) payload.packageWidthCm = width;
  if (height !== null) payload.packageHeightCm = height;

  pdevSetWorking(pdevVariantFormMsg, "正在添加变体…");
  const result = await pdevRequest(pdevApiPath(`/products/${encodeURIComponent(product.publicId)}/variants`), {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (!result.ok) {
    pdevShowError(pdevVariantFormMsg, result, "变体添加失败");
    return;
  }
  pdevSetInline(pdevVariantFormMsg, `已添加变体 ${pdevVariantKey(parsed.spec)}`, "ok");
  if (pdevVariantSpec) pdevVariantSpec.value = "";
  await pdevLoadDetail(product.publicId, { silent: true });
  await pdevLoadList({ silent: true });
}

// ---------------------------------------------------------------------------
// 事件绑定（app.js 的 bindEvents() 只加一行 bindProductDevEvents();）
// ---------------------------------------------------------------------------
function bindProductDevEvents() {
  pdevSyncMockBadge();
  if (pdevRefreshBtn) pdevRefreshBtn.addEventListener("click", () => pdevReload());
    // 商品SKU 生成：格式 SKU-YYMMDD-XXXX。留空时后端仍会用系统编号（PD_xxx）兜底，两者互不影响。
  function pdevGenerateSku() {
    const pad = (n) => String(n).padStart(2, "0");
    const d = new Date();
    const stamp = String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate());
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return "SKU-" + stamp + "-" + rand;
  }
  const pdevGenerateSkuBtn = document.getElementById("pdevGenerateSkuBtn");
  const pdevCreateSkuInput = document.getElementById("pdevCreateSku");
  if (pdevGenerateSkuBtn && pdevCreateSkuInput) {
    pdevGenerateSkuBtn.addEventListener("click", () => {
      pdevCreateSkuInput.value = pdevGenerateSku();
      pdevCreateSkuInput.focus();
    });
  }
  // 新建弹窗：把「label + 紧随的控件」两两包成一组，便于用两列排布（原来是一串平铺的 label/input）
  (function pdevGroupCreateFormFields() {
    const form = document.getElementById("pdevCreateForm");
    if (!form || form.dataset.pdGrouped === "1") return;
    const controls = ["INPUT", "SELECT", "TEXTAREA"];
    let wrapper = null;
    for (const node of Array.prototype.slice.call(form.children)) {
      if (node.tagName === "LABEL") {
        wrapper = document.createElement("div");
        wrapper.className = "pdev-field-pair";
        form.insertBefore(wrapper, node);
        wrapper.appendChild(node);
        continue;
      }
      if (wrapper && (controls.indexOf(node.tagName) >= 0 || (node.classList && node.classList.contains("pdev-sku-row")))) {
        wrapper.appendChild(node);
        continue;
      }
      wrapper = null;
    }
    form.dataset.pdGrouped = "1";
  })();

  pdevFillSystemCategoryOptions();
  if (pdevToggleCreateBtn) pdevToggleCreateBtn.addEventListener("click", pdevOpenCreateModal);
  if (pdevCloseCreateBtn) pdevCloseCreateBtn.addEventListener("click", pdevCloseCreateModal);
  // 日志弹窗
  if (pdevCloseLogBtn) pdevCloseLogBtn.addEventListener("click", pdevCloseLogModal);
  if (pdevLogModalMask) {
    pdevLogModalMask.addEventListener("click", (event) => {
      if (event.target === pdevLogModalMask) pdevCloseLogModal();
    });
  }
  if (pdevCancelCreateBtn) pdevCancelCreateBtn.addEventListener("click", pdevCloseCreateModal);
  if (pdevCreateModalMask) {
    // 点遮罩空白处关闭；点卡片内部不关
    pdevCreateModalMask.addEventListener("click", (event) => {
      if (event.target === pdevCreateModalMask) pdevCloseCreateModal();
    });
  }
  if (pdevCreateForm) pdevCreateForm.addEventListener("submit", pdevOnCreateSubmit);
  if (pdevSearchForm) {
    pdevSearchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      pdevOnSearch();
    });
  }
  if (pdevSearchResetBtn) pdevSearchResetBtn.addEventListener("click", pdevResetSearch);
  if (pdevList) {
    pdevList.addEventListener("click", pdevOnListClick);
    pdevList.addEventListener("keydown", (event) => {
      // 焦点在勾选框上时交给原生行为（空格=勾选），不要打开详情
      if (event.target && event.target.tagName === "INPUT") return;
      if (event.key === "Enter" || event.key === " ") {
        const item = event.target && event.target.closest ? event.target.closest("[data-pdev-open]") : null;
        if (item) {
          event.preventDefault();
          pdevSelectProduct(item.getAttribute("data-pdev-open"));
        }
      }
    });
  }
  if (pdevSelectAll) pdevSelectAll.addEventListener("change", pdevOnSelectAllChange);
  if (pdevPager) pdevPager.addEventListener("click", pdevOnPagerClick);
  if (pdevDetailReloadBtn) {
    pdevDetailReloadBtn.addEventListener("click", () => {
      if (pdevState.selectedPublicId) pdevLoadDetail(pdevState.selectedPublicId);
    });
  }
  if (pdevStatusActions) {
    pdevStatusActions.addEventListener("click", (event) => {
      const button = event.target && event.target.closest ? event.target.closest("[data-pdev-status]") : null;
      if (!button) return;
      pdevOnAdvanceStatus(button.getAttribute("data-pdev-status"));
    });
  }
  if (pdevProductForm) pdevProductForm.addEventListener("submit", pdevOnProductSubmit);
  if (pdevDeleteProductBtn) pdevDeleteProductBtn.addEventListener("click", pdevOnDeleteProduct);
  if (pdevParseSourceUrlBtn) pdevParseSourceUrlBtn.addEventListener("click", pdevOnParseSourceUrl);
  if (pdevSourceForm) pdevSourceForm.addEventListener("submit", pdevOnSourceSubmit);
  if (pdevSourceList) {
    pdevSourceList.addEventListener("click", (event) => {
      const saveBtn = event.target && event.target.closest ? event.target.closest("[data-pdev-source-save]") : null;
      if (saveBtn) {
        pdevSaveSourceRow(saveBtn.getAttribute("data-pdev-source-save"));
        return;
      }
      const deleteBtn = event.target && event.target.closest ? event.target.closest("[data-pdev-source-delete]") : null;
      if (deleteBtn) pdevDeleteSourceRow(deleteBtn.getAttribute("data-pdev-source-delete"));
    });
  }
  if (pdevAssetForm) pdevAssetForm.addEventListener("submit", pdevOnAssetSubmit);
  if (pdevAssetList) {
    pdevAssetList.addEventListener("click", (event) => {
      const deleteBtn = event.target && event.target.closest ? event.target.closest("[data-pdev-asset-delete]") : null;
      if (deleteBtn) pdevDeleteAsset(deleteBtn.getAttribute("data-pdev-asset-delete"));
    });
  }
  if (pdevVariantForm) pdevVariantForm.addEventListener("submit", pdevOnVariantSubmit);
}

// 点击缩略图放大（本文件自包含）：委托到 document，点任意处或 Esc 关闭。
(function () {
  function closeZoom() {
    var mask = document.getElementById("pdevZoomMask");
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
  }
  function openZoom(url) {
    closeZoom();
    var mask = document.createElement("div");
    mask.id = "pdevZoomMask";
    mask.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(12,20,32,.78);display:flex;align-items:center;justify-content:center;cursor:zoom-out;padding:24px;box-sizing:border-box;";
    var img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.setAttribute("referrerpolicy", "no-referrer");
    img.style.cssText = "max-width:92vw;max-height:92vh;border-radius:12px;box-shadow:0 24px 64px rgba(0,0,0,.45);background:#fff;cursor:default;display:block;";
    img.addEventListener("click", function (e) { e.stopPropagation(); });
    mask.appendChild(img);
    mask.addEventListener("click", closeZoom);
    document.body.appendChild(mask);
  }
  document.addEventListener("click", function (event) {
    var el = event.target;
    if (!el || typeof el.closest !== "function") return;
    var thumb = el.closest("[data-pdev-zoom]");
    if (!thumb) return;
    var url = thumb.getAttribute("data-pdev-zoom");
    if (!url) return;
    event.preventDefault();
    openZoom(url);
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeZoom();
  });
})();

// 批量删除（本文件自包含）：勾选左侧复选框 → 点「批量删除」→ 二次确认 → 逐个删除 → 汇总。
// 失败时把服务端返回的原文弹出来（便于排查），不用猜。
(function () {
  var TABLE_HINT = "#productDevPanel";
  function panelRoot() { return document.querySelector(TABLE_HINT) || document.body; }

  // 从复选框或它所在的行里，尽量找出商品编号（多种写法都兜住）
  function publicIdOf(cb) {
    var v = String(cb.value || "").trim();
    if (v && v !== "on") return v;
    var attrs = ["data-pdev-id", "data-id", "data-public-id", "data-sku"];
    for (var i = 0; i < attrs.length; i += 1) {
      var a = cb.getAttribute(attrs[i]);
      if (a) return String(a).trim();
    }
    var tr = cb.closest("tr");
    if (tr) {
      for (var j = 0; j < attrs.length; j += 1) {
        var b = tr.getAttribute(attrs[j]);
        if (b) return String(b).trim();
      }
      var copyBtn = tr.querySelector("[data-pdev-copy], [data-copy]") ;
      if (copyBtn) {
        var cv = copyBtn.getAttribute("data-pdev-copy") || copyBtn.getAttribute("data-copy");
        if (cv) return String(cv).trim();
      }
      var firstCell = tr.querySelector("td");
      // SKU 单元格里通常是蓝色链接文本（纯编号）
      var link = tr.querySelector("td a, td [data-pdev-open]");
      var text = (link ? link.textContent : (firstCell ? firstCell.textContent : "")) || "";
      var m = /[A-Za-z0-9_\-]{4,}/.exec(text.trim());
      if (m) return m[0];
    }
    return "";
  }

  function selectedBoxes() {
    var root = panelRoot();
    var all = root.querySelectorAll("input[type=checkbox]");
    var out = [];
    Array.prototype.forEach.call(all, function (cb) {
      if (cb.checked && cb.closest("thead") === null) out.push(cb);
    });
    return out;
  }

  async function runBulkDelete(btn) {
    var boxes = selectedBoxes();
    if (!boxes.length) { alert("请先勾选要删除的商品（表格左侧复选框）。"); return; }
    var ids = [];
    boxes.forEach(function (cb) { var id = publicIdOf(cb); if (id) ids.push(id); });
    ids = ids.filter(function (v, i) { return ids.indexOf(v) === i; });
    if (!ids.length) { alert("勾选了 " + boxes.length + " 行，但没能识别出商品编号。请把这句话发给我，我按真实结构修。"); return; }
    if (!confirm("确认删除选中的 " + ids.length + " 个商品？此操作不可恢复。\n\n" + ids.slice(0, 8).join("\n") + (ids.length > 8 ? "\n…" : ""))) return;
    btn.disabled = true;
    var okCount = 0, failed = [];
    for (var i = 0; i < ids.length; i += 1) {
      btn.textContent = "删除中 " + (i + 1) + "/" + ids.length;
      try {
        var res = await fetch("/api/product-dev/products/" + encodeURIComponent(ids[i]), { method: "DELETE", credentials: "same-origin", headers: { Accept: "application/json" } });
        if (res.ok) okCount += 1;
        else {
          var body = null; try { body = await res.json(); } catch (e) { /* 非 JSON */ }
          failed.push(ids[i] + " → HTTP " + res.status + ((body && body.message) ? "：" + body.message : ""));
        }
      } catch (e) { failed.push(ids[i] + " → " + (e && e.message ? e.message : "请求异常")); }
    }
    btn.disabled = false;
    btn.textContent = "批量删除";
    alert("批量删除完成：成功 " + okCount + " 个，失败 " + failed.length + " 个" + (failed.length ? "\n\n" + failed.slice(0, 6).join("\n") : ""));
    // 删完刷新：优先点页面上现有的「刷新/查询」按钮（避免引用不确定的函数名，静态守卫也会报未解析调用）
    var refreshed = false;
    var allBtns = panelRoot().querySelectorAll("button");
    for (var k = 0; k < allBtns.length; k += 1) {
      var label = (allBtns[k].textContent || "").trim();
      if (label === "刷新" || label === "查询") { try { allBtns[k].click(); refreshed = true; } catch (e) { /* 忽略 */ } break; }
    }
    if (!refreshed) location.reload();
  }

  function inject() {
    var root = panelRoot();
    if (!root || root.querySelector("#pdevBulkDeleteBtn")) return;
    // 挂在表格上方的工具栏里：优先找「刷新/新建」按钮所在容器，否则挂在表格容器前面
    var host = null;
    var btns = root.querySelectorAll("button");
    for (var i = 0; i < btns.length; i += 1) {
      var t = (btns[i].textContent || "").trim();
      if (t === "新建商品" || t === "刷新" || t.indexOf("新建") === 0) { host = btns[i].parentNode; break; }
    }
    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "pdevBulkDeleteBtn";
    btn.textContent = "批量删除";
    btn.style.cssText = "margin-left:8px;background:#fff1f0;border:1px solid #ffccc7;color:#b42318;border-radius:8px;padding:6px 12px;cursor:pointer;";
    btn.addEventListener("click", function () { runBulkDelete(btn); });
    if (host) host.appendChild(btn);
    else {
      var table = root.querySelector("table");
      if (table && table.parentNode) table.parentNode.insertBefore(btn, table);
      else root.insertBefore(btn, root.firstChild);
    }
  }

  // 面板是切换显示的，靠轮询兜住"后渲染"的情况（成本极低）
  inject();
  setInterval(inject, 1500);
})();

// 详情页只读预览模式（pdevViewModel）：只有 product-detail.html 会执行。
// 依据 URL 的 ?mode=view 禁用所有输入控件、隐藏保存/添加/删除类按钮，并在顶部显示提示。
(function pdevViewModel() {
  if (!/product-detail\.html$/.test(location.pathname)) return;
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode") === "view" ? "view" : "edit";
  document.documentElement.setAttribute("data-pdev-mode", mode);
  if (mode !== "view") return;
  const style = document.createElement("style");
  style.textContent = [
    "html[data-pdev-mode=view] input:not([type=checkbox]):not([type=radio]),",
    "html[data-pdev-mode=view] select,",
    "html[data-pdev-mode=view] textarea {",
    "  pointer-events: none; background: #f4f6f9; color: #5b6b7f;",
    "}",
    "html[data-pdev-mode=view] input[type=file] { display: none; }"
  ].join("\n");
  document.head.appendChild(style);
  const BAN = ["保存", "添加", "删除", "移除", "生成", "上传", "新建", "导入", "提交"];
  function hideWriteButtons() {
    document.querySelectorAll("button").forEach(function (btn) {
      const label = String(btn.textContent || "").trim();
      const isBan = BAN.some(function (word) { return label.indexOf(word) >= 0; });
      if (isBan && btn.id !== "pdevZoomMask") { btn.style.display = "none"; }
    });
  }
  hideWriteButtons();
  setInterval(hideWriteButtons, 1200);
  // （原顶部预览提示已按需求移除）
})();
