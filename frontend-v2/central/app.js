import { createCatalogApi } from "./catalogApi.js";
import { productRow, productDetail } from "./catalogViewModel.js";

const api = createCatalogApi({ getToken: () => localStorage.getItem("v2_token") || "" });
const state = { products: [], selected: null };
const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function renderList() {
  $("count-label").textContent = String(state.products.length);
  $("product-list").innerHTML = state.products.map((product) => {
    const row = productRow(product);
    const active = state.selected?.publicId === row.publicId ? " active" : "";
    return `<button class="product-row${active}" data-id="${escapeHtml(row.publicId)}"><span><strong>${escapeHtml(row.title)}</strong><small>${escapeHtml(row.sku)} · ${escapeHtml(row.status)}</small></span><b>v${row.version}</b></button>`;
  }).join("") || '<div class="detail-empty">暂无中央商品</div>';
  document.querySelectorAll(".product-row").forEach((button) => button.addEventListener("click", () => selectProduct(button.dataset.id)));
}

function renderDetail(product) {
  if (!product) { $("detail-id").textContent = "—"; $("product-detail").className = "detail-empty"; $("product-detail").textContent = "选择一个中央商品查看版本、变体和图片资产。"; return; }
  const detail = productDetail(product);
  $("detail-id").textContent = detail.publicId;
  $("product-detail").className = "detail-content";
  $("product-detail").innerHTML = `<h2>${escapeHtml(detail.title)}</h2><p>${escapeHtml(detail.description || "暂无描述")}</p><dl><dt>状态</dt><dd>${escapeHtml(detail.status)}</dd><dt>库存</dt><dd>${detail.stockCount}</dd><dt>当前版本</dt><dd>v${detail.version}</dd></dl><h3>变体（${detail.variants.length}）</h3><ul>${detail.variants.map((v) => `<li><b>${escapeHtml(v.systemSku)}</b><span>${escapeHtml(v.variantKey)} · 库存 ${v.stockCount}</span></li>`).join("") || "<li>暂无变体</li>"}</ul><h3>版本（${detail.versions.length}）</h3><ul>${detail.versions.map((v) => `<li><b>v${escapeHtml(v.versionNo)}</b><span>${escapeHtml(v.reason || "")}</span></li>`).join("") || "<li>暂无版本</li>"}</ul><h3>图片资产（${detail.assets.length}）</h3><ul>${detail.assets.map((asset) => `<li><b>${escapeHtml(asset.asset_type || asset.assetType || "asset")}</b><span>${escapeHtml(asset.status || "pending")}</span></li>`).join("") || "<li>暂无图片资产</li>"}</ul>`;
}

async function selectProduct(publicId) {
  try { const body = await api.detail(publicId); state.selected = body.data ?? body; renderList(); renderDetail(state.selected); } catch (error) { showError(error); }
}

async function loadProducts() {
  try {
    clearError();
    const body = await api.list({ search: $("search-input").value.trim(), status: $("status-select").value });
    const data = body.data ?? body;
    state.products = data.items || data.products || data;
    renderList();
    if (state.selected) renderDetail(state.selected);
  } catch (error) { showError(error); }
}

function showError(error) { $("error-message").hidden = false; $("error-message").textContent = `${error.message}${error.requestId ? `（requestId: ${error.requestId}）` : ""}`; }
function clearError() { $("error-message").hidden = true; }

$("refresh-button").addEventListener("click", loadProducts);
$("search-button").addEventListener("click", loadProducts);
loadProducts();
