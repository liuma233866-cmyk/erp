// 商品管理（pdev）SKU 索引 + SKU关系管理 绑定关系索引：用于显示「商品SKU」
// 【task-15】取数顺序 = **绑定关系优先、同码兜底**：
//   ① GET /api/product-dev/products → publicId(lower) → { sku, purchasePrice }（同码兜底 + 采购价来源）
//   ② GET /api/pdev-links          → offerId / marketSku / onlineProductId（lower + trim）
//                                      → { sku: pdevSku, purchasePrice }，后写入 = 绑定优先（覆盖①同 key 项）
//   ③ 两条都没有 → 返回 ""（页面显示 -）
// 【task-26】索引已抽到 shared/core/pdev-sku-index.js（单一命名空间 window.PdevSkuIndex）：
//   以前 orders.js / product-list.js / online-products.js 各自一份同名裸全局、互相覆盖；
//   这里只留薄封装：索引变量与加载函数都收进共享命名空间，本文件不再有同名的裸全局。
function pdevSkuFor(shopSku) {
  return window.PdevSkuIndex ? window.PdevSkuIndex.skuFor(shopSku) : "";
}
function renderProductListSummary() {
  const items = Array.isArray(state.productListFilteredProducts) ? state.productListFilteredProducts : [];
  if (productListCount) productListCount.textContent = String(items.length);
  if (productListCategoryCount) {
    const categories = new Set(
      items
        .map((item) => String(item.marketCategoryName || item.categoryName || item.marketCategoryId || item.categoryId || "").trim())
        .filter(Boolean)
    );
    productListCategoryCount.textContent = String(categories.size);
  }
  if (productListShopCount) {
    const shops = new Set(items.map((item) => String(item.shopName || item.shopId || "").trim()).filter(Boolean));
    productListShopCount.textContent = String(shops.size);
  }
  if (productListSelectedCount) {
    productListSelectedCount.textContent = `当前 ${items.length} 条`;
  }
}

function renderProductListTable() {
  if (!productListTableBody) return;
  const items = getProductListPage();
  if (!can("productRead")) {
    productListTableBody.innerHTML = "<tr><td colspan='7'>无权限查看产品列表</td></tr>";
    if (productListMessage) {
      productListMessage.style.color = "#c02030";
      productListMessage.textContent = "当前账号没有产品查看权限";
    }
    return;
  }
  if (!items.length) {
    productListTableBody.innerHTML = "<tr><td colspan='7'>暂无产品数据</td></tr>";
    if (productListMessage) {
      productListMessage.style.color = "#2f3d63";
      productListMessage.textContent = "没有匹配到产品";
    }
    return;
  }
  productListTableBody.innerHTML = items
    .map((item) => {
      const image = item.imageUrl || (Array.isArray(item.pictures) ? item.pictures[0] : "");
      const name = String(item.name || "-").trim();
      const sku = String(item.shopSku || item.vendorCode || item.marketSku || item.offerId || item.id || "-").trim();
      const brand = String(item.vendor || item.brand || "-").trim();
      const category = String(item.marketCategoryName || item.categoryName || item.marketCategoryId || item.categoryId || "-").trim();
      const salePrice = formatOnlineMoney(Number(item.salePrice ?? item.price));
      const stock = String(item.stockCount ?? item.availableStock ?? item.inventory ?? "-");
      const shop = String(item.shopName || item.shopId || "-").trim();
      const updatedAt = formatDateTime(item.updatedAt || item.createdAt || "");
      const productLink = String(item.collectUrl || item.url || "").trim();
      return `
        <tr>
          <td>
            <div class="online-product-info">
              <div class="product-thumb small">
                ${
                  image
                    ? `<button type="button" class="online-image-preview-btn" data-product-list-preview="${escapeHtml(String(item.id || ""))}" title="预览图片">
                         <img src="${escapeHtml(safeImageUrl(image))}" alt="product" referrerpolicy="no-referrer" />
                       </button>`
                    : "<span class='thumb-placeholder'>暂无图片</span>"
                }
              </div>
              <div class="product-info">
                <div class="product-title clamp-2">${escapeHtml(name)}</div>
                <div class="product-sub">
                  <div>店铺SKU：${escapeHtml(sku)}</div>
            <div>商品SKU: <span data-pdev-sku-cell data-shop-sku="${escapeHtml(sku)}">${escapeHtml(pdevSkuFor(sku) || "-")}</span></div>
                  <div>品牌：${escapeHtml(brand)}</div>
                </div>
              </div>
            </div>
          </td>
          <td title="${escapeHtml(category)}">${escapeHtml(category)}</td>
          <td>${escapeHtml(salePrice)}</td>
          <td>${escapeHtml(stock)}</td>
          <td>${escapeHtml(shop)}</td>
          <td>${escapeHtml(updatedAt || "-")}</td>
          <td>
            <div class="online-actions-cell">
              ${
                safeExternalUrl(productLink)
                  ? `<a class="online-action-link" href="${escapeHtml(safeExternalUrl(productLink))}" target="_blank" rel="noopener noreferrer">查看</a>`
                  : `<span class="online-action-link disabled">查看</span>`
              }
              <button type="button" class="online-action-link" data-product-list-edit="${escapeHtml(String(item.id || ""))}">修改</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
  if (productListMessage) productListMessage.textContent = "";
}

function renderProductListPagination() {
  if (!productListPaginationInfo) return;
  const total = Array.isArray(state.productListFilteredProducts) ? state.productListFilteredProducts.length : 0;
  const pageSize = state.productListPageSize || DEFAULT_PRODUCT_LIST_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (state.productListCurrentPage > totalPages) state.productListCurrentPage = totalPages;
  productListPaginationInfo.innerHTML = `${state.productListCurrentPage} <span class="page-sep">/</span> <span class="page-total">${totalPages}</span>`;
  if (productListPrevPageBtn) productListPrevPageBtn.disabled = state.productListCurrentPage <= 1;
  if (productListNextPageBtn) productListNextPageBtn.disabled = state.productListCurrentPage >= totalPages;
  if (productListGotoPage) productListGotoPage.value = String(state.productListCurrentPage);
}

function onProductListFilterSubmit(event) {
  event.preventDefault();
  state.productListFilters = readProductListFilterFormValues();
  state.productListCurrentPage = 1;
  applyProductListFilters();
  renderProductListSummary();
  renderProductListTable();
  renderProductListPagination();
}

function onProductListFilterReset() {
  if (productListFilterForm) productListFilterForm.reset();
  state.productListFilters = { shopId: "", keyword: "", category: "" };
  state.productListCurrentPage = 1;
  applyProductListFilters();
  syncProductListShopOptions();
  renderProductListSummary();
  renderProductListTable();
  renderProductListPagination();
}

function onProductListGotoPage() {
  const nextPage = Number(productListGotoPage?.value || 1) || 1;
  changeProductListPage(nextPage);
}

function onProductListPageSizeChange() {
  state.productListPageSize = Number(productListPageSize?.value || DEFAULT_PRODUCT_LIST_PAGE_SIZE) || DEFAULT_PRODUCT_LIST_PAGE_SIZE;
  state.productListCurrentPage = 1;
  renderProductListTable();
  renderProductListPagination();
}

function onProductListTableClick(event) {
  const previewBtn = event.target.closest("[data-product-list-preview]");
  if (previewBtn) {
    const id = String(previewBtn.getAttribute("data-product-list-preview") || "").trim();
    if (!id) return;
    const item = (state.onlineProducts || []).find((entry) => String(entry?.id || "").trim() === id);
    if (item) openPublishGallery(item);
    return;
  }
  const editBtn = event.target.closest("[data-product-list-edit]");
  if (editBtn) {
    const id = String(editBtn.getAttribute("data-product-list-edit") || "").trim();
    if (id) openOnlineSourceModal(id);
  }
}

// 从 app.js 拆出的商品列表核心逻辑（过滤/分页/数据访问）。

function getYandexProducts() {
  return (state.onlineProducts || []).filter((item) => !getOnlineProductPlatform(item).includes("ozon"));
}
function readProductListFilterFormValues() {
  if (!productListFilterForm) return { ...state.productListFilters };
  const form = new FormData(productListFilterForm);
  return {
    shopId: String(form.get("shopId") || "").trim(),
    keyword: String(form.get("keyword") || "").trim(),
    category: String(form.get("category") || "").trim()
  };
}
function syncProductListFilterFormFromState() {
  if (!productListFilterForm) return;
  const fields = ["shopId", "keyword", "category"];
  for (const name of fields) {
    const field = productListFilterForm.elements?.namedItem(name);
    if (!field) continue;
    field.value = String(state.productListFilters?.[name] || "");
  }
}
function syncProductListShopOptions() {
  if (!productListShopFilter) return;
  const current = String(state.productListFilters.shopId || "");
  const source = (state.shops || []).length
    ? state.shops.map((shop) => ({ id: String(shop.id || ""), name: String(shop.name || "") }))
    : (state.onlineProducts || []).map((product) => ({
        id: String(product.shopId || ""),
        name: String(product.shopName || product.shopId || "")
      }));
  const seen = new Set();
  const options = source
    .filter((item) => {
      const id = String(item.id || "").trim();
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === current ? "selected" : ""}>${escapeHtml(item.name || item.id)}</option>`)
    .join("");
  productListShopFilter.innerHTML = `<option value="">店铺(全部)</option>${options}`;
}
function applyProductListFilters() {
  const filters = state.productListFilters || {};
  const keywordList = splitFilterText(filters.keyword);
  const categoryList = splitFilterText(filters.category);
  const shopId = String(filters.shopId || "").trim();
  let items = Array.isArray(state.onlineProducts) ? [...state.onlineProducts] : [];

  if (shopId) {
    items = items.filter((item) => String(item.shopId || "") === shopId);
  }
  if (keywordList.length) {
    items = items.filter((item) =>
      matchesAny(
        `${item.name || ""} ${item.shopSku || ""} ${item.marketSku || ""} ${item.vendor || ""} ${item.vendorCode || ""} ${item.offerId || ""}`,
        keywordList
      )
    );
  }
  if (categoryList.length) {
    items = items.filter((item) =>
      matchesAny(
        `${item.marketCategoryName || ""} ${item.categoryName || ""} ${item.marketCategoryId || ""} ${item.categoryId || ""}`,
        categoryList
      )
    );
  }

  state.productListFilteredProducts = items;
}
function getProductListPage() {
  const pageSize = state.productListPageSize || DEFAULT_PRODUCT_LIST_PAGE_SIZE;
  const start = (state.productListCurrentPage - 1) * pageSize;
  return (state.productListFilteredProducts || []).slice(start, start + pageSize);
}
function changeProductListPage(nextPage) {
  const pageSize = state.productListPageSize || DEFAULT_PRODUCT_LIST_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil((state.productListFilteredProducts || []).length / pageSize));
  if (nextPage < 1 || nextPage > totalPages) return;
  state.productListCurrentPage = nextPage;
  renderProductListTable();
  renderProductListPagination();
}

// 从 app.js 下沉的 DOM 常量与事件绑定。

const productListFilterForm = document.getElementById("productListFilterForm");
const productListResetBtn = document.getElementById("productListResetBtn");
const productListShopFilter = document.getElementById("productListShopFilter");
const productListMessage = document.getElementById("productListMessage");
const productListCount = document.getElementById("productListCount");
const productListCategoryCount = document.getElementById("productListCategoryCount");
const productListShopCount = document.getElementById("productListShopCount");
const productListTableBody = document.getElementById("productListTableBody");
const productListSelectedCount = document.getElementById("productListSelectedCount");
const productListPrevPageBtn = document.getElementById("productListPrevPageBtn");
const productListNextPageBtn = document.getElementById("productListNextPageBtn");
const productListPaginationInfo = document.getElementById("productListPaginationInfo");
const productListGotoPage = document.getElementById("productListGotoPage");
const productListPageSize = document.getElementById("productListPageSize");

function bindProductListEvents() {
  if (productListFilterForm) productListFilterForm.addEventListener("submit", onProductListFilterSubmit);
  if (productListResetBtn) productListResetBtn.addEventListener("click", onProductListFilterReset);
  if (productListTableBody) productListTableBody.addEventListener("click", onProductListTableClick);
  if (productListPrevPageBtn) productListPrevPageBtn.addEventListener("click", () => changeProductListPage(state.productListCurrentPage - 1));
  if (productListNextPageBtn) productListNextPageBtn.addEventListener("click", () => changeProductListPage(state.productListCurrentPage + 1));
  if (productListGotoPage) productListGotoPage.addEventListener("change", onProductListGotoPage);
  if (productListPageSize) productListPageSize.addEventListener("change", onProductListPageSizeChange);
}
