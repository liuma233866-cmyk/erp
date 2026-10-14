// SKU关系管理：新增弹窗显隐 + 店铺账户下拉填充（GET /api/shops）+ 商品SKU自动带出产品名（GET /api/product-dev/products）
(function () {
  function el(id) { return document.getElementById(id); }
  function open() {
    const mask = el("sklAddModalMask");
    if (mask) mask.classList.remove("hidden");
    setAddMsg("");          // 打开时清掉上一次的报错
    setAddBindingInfo("");  // 【task-11】打开时清掉上一次的「绑定信息」
    syncShopSelects();
  }
  function close() {
    const mask = el("sklAddModalMask");
    if (mask) mask.classList.add("hidden");
  }
  document.addEventListener("click", function (event) {
    const t = event.target;
    if (!t || !t.closest) return;
    // ① 点「新增」按钮 → 打开
    if (t.closest("#sklAddBtn")) { open(); return; }
    // ② 四个弹窗（新增 / 编辑 / 日志 / 导入）各自的「× / 取消 / 关闭」与遮罩空白处 → 关闭
    //    （document 级监听是互相独立的：这里 return 不影响下面那个委托处理器继续处理确认按钮）
    const masks = [
      { node: el("sklAddModalMask"), closeSelector: "#sklAddModalClose, #sklAddCancel", closeFn: close },
      { node: el("sklEditModalMask"), closeSelector: "#sklEditModalClose, #sklEditCancel", closeFn: closeEditModal },
      { node: el("sklLogModalMask"), closeSelector: "#sklLogModalClose, #sklLogClose", closeFn: closeLogModal },
      { node: el("sklImportModalMask"), closeSelector: "#sklImportModalClose, #sklImportClose", closeFn: closeImportModal },
      // 【task-28】导出弹窗（与导入同款遮罩关闭逻辑）
      { node: el("sklExportModalMask"), closeSelector: "#sklExportModalClose, #sklExportClose", closeFn: closeExportModal }
    ];
    for (let i = 0; i < masks.length; i++) {
      const entry = masks[i];
      if (!entry.node || entry.node.classList.contains("hidden")) continue;
      if (t.closest(entry.closeSelector)) { entry.closeFn(); return; }
      if (t === entry.node) { entry.closeFn(); return; }   // 只有点在遮罩空白处才关
      return;                                              // 弹窗内部的点击交给下面的委托处理器
    }
  });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    close();
    closeEditModal();
    closeLogModal();
    closeImportModal();
    closeExportModal();          // 【task-28】
  });

  // ------------------------------------------------------------------
  // 店铺账户下拉：只读侦察结论（真实请求 /api/shops 得到）
  //   GET /api/shops → { items: [{ id, name, provider, enabled, ... }], pagination }
  //   provider 实测取值：yandex_market / ozon
  //   页面「销售平台」下拉取值：yandex / ozon（所以这里做一次归一化映射）
  // ------------------------------------------------------------------
  const shopsState = { items: [], loaded: false };

  function normalizeProvider(value) {
    const text = String(value || "").trim().toLowerCase();
    if (text.indexOf("yandex") >= 0) return "yandex";
    if (text.indexOf("ozon") >= 0) return "ozon";
    return text;
  }

  function shopMatchesProvider(shop, provider) {
    if (!provider) return true;   // 「请选择平台」→ 显示全部店铺
    return normalizeProvider(shop && shop.provider) === provider;
  }

  function fillShopSelect(selectEl, providerValue) {
    if (!selectEl) return;
    const previous = selectEl.value;
    const provider = normalizeProvider(providerValue);
    const shops = shopsState.items.filter(function (shop) { return shopMatchesProvider(shop, provider); });
    selectEl.textContent = "";
    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "全部店铺";
    selectEl.appendChild(allOption);
    shops.forEach(function (shop) {
      const id = String(shop && shop.id != null ? shop.id : "").trim();
      if (!id) return;
      const option = document.createElement("option");
      option.value = id;
      option.textContent = String((shop && shop.name) || id);
      selectEl.appendChild(option);
    });
    // 尽量保留原选择；选中的店铺不属于当前平台时回到「全部店铺」
    const keepPrevious = Array.prototype.some.call(selectEl.options, function (o) { return o.value === previous; });
    selectEl.value = keepPrevious ? previous : "";
  }

  function syncShopSelects() {
    const filterProvider = el("sklFilterProvider");
    const addProvider = el("sklAddProvider");
    fillShopSelect(el("sklFilterShop"), filterProvider ? filterProvider.value : "");
    fillShopSelect(el("sklAddShop"), addProvider ? addProvider.value : "");
  }

  async function loadShops() {
    if (typeof apiRequest !== "function") return;   // shared/core/api.js 还没加载完
    let result = null;
    try {
      result = await apiRequest("/api/shops", { method: "GET" });
    } catch (error) {
      result = null;
    }
    // 请求失败 / 无数据：保留「全部店铺」，静默处理，不抛异常
    if (!result || !result.ok || !result.data || !Array.isArray(result.data.items)) return;
    shopsState.items = result.data.items;
    shopsState.loaded = true;
    syncShopSelects();
  }

  // 「销售平台」变化 → 对应店铺下拉联动过滤
  document.addEventListener("change", function (event) {
    const target = event.target;
    if (!target || !target.id) return;
    if (target.id === "sklFilterProvider") fillShopSelect(el("sklFilterShop"), target.value);
    else if (target.id === "sklAddProvider") fillShopSelect(el("sklAddShop"), target.value);
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", loadShops);
  else setTimeout(loadShops, 0);   // 放进回调，避免顶层直接调用（守卫的加载顺序约定）

  // ------------------------------------------------------------------
  // 商品SKU → 产品名 自动带出
  // 只读侦察结论（本次真实请求实测，不是猜）：
  //   · 「商品SKU」就是商品管理里的 publicId（见 product-dev.js 注释「商品SKU → publicId」）。
  //   · GET /api/product-dev/products 真实读取的过滤参数是 q，且只按 title 模糊匹配
  //     （pdev-repository.js: where.push("p.title LIKE ?")）；
  //     传 keyword=<SKU> 会被静默忽略——实测 keyword=ZZZ_NOT_EXIST 与不传参数返回完全一致。
  //     所以「只靠列表接口按 SKU 精确匹配」查不到，必须补一条精确点名。
  //   · 列表 item 字段：{ id, publicId, title, devStatus, ... }，返回 { items, total, page, pageSize }。
  //   · 精确点名（product-dev.js 里查「商品SKU」用的同一条）：
  //     GET /api/product-dev/products/<publicId> → 200 { product:{publicId,title,...}, sources, assets, variants }；
  //     查不到 → 404 { message: "Product not found" }。
  //   · publicId 查询大小写不敏感（实测 SKU-261010-HPIH 与 sku-261010-hpih 都能取到）。
  // 规则：① 先用列表接口把商品拉回来，客户端按 publicId 精确匹配（忽略大小写）；
  //       ② 只有当列表没有覆盖全部商品（total > items.length，即超过一页）时，才用「精确点名」兜底；
  //          这一步是必要的，因为对「确实不存在」的 SKU 点名会返回 404，浏览器控制台会记一条
  //          Failed to load resource(404)。列表已覆盖全部商品时就不点名，保证控制台干净（0 报错）。
  //       ③ 仍找不到 → 不写产品名（保留用户原本输入的内容），只在 title 提示，不弹窗、不抛异常。
  // ------------------------------------------------------------------
  const PDEV_LOOKUP_DEBOUNCE_MS = 300;
  const pdevLookupCache = new Map();   // 小写 SKU → 产品对象或 null
  let pdevLookupTimer = null;
  let pdevLookupSeq = 0;

  function setPdevNameHint(text) {
    const nameInput = el("sklAddItemName");
    if (!nameInput) return;
    if (text) nameInput.title = text;
    else nameInput.removeAttribute("title");
  }

  function applyPdevProductName(seq, sku, product) {
    if (seq !== pdevLookupSeq) return;                       // 已有更新的输入，丢弃旧结果
    const skuInput = el("sklAddItemSku");
    if (!skuInput || String(skuInput.value || "").trim() !== sku) return;   // 输入已变化，丢弃
    const nameInput = el("sklAddItemName");
    if (!nameInput) return;
    if (!product) {
      // 查不到：不动 nameInput.value（不清空用户手填的内容），只留一条不打扰的提示
      setPdevNameHint("未找到商品SKU「" + sku + "」对应的商品，可手动填写产品名");
      return;
    }
    nameInput.value = String(product.title || "");
    nameInput.title = "已按商品SKU " + String(product.publicId || sku) + " 自动带出，可手动修改";
  }

  async function findPdevProductBySku(sku) {
    const wanted = String(sku || "").toLowerCase();
    if (pdevLookupCache.has(wanted)) return pdevLookupCache.get(wanted);
    let product = null;
    let listCoversAllProducts = false;
    // ① 列表接口：客户端按 publicId 精确匹配（忽略大小写）。
    //    注意：真实过滤参数是 q 且只按 title 模糊匹配（keyword= 被静默忽略），
    //    所以这里不靠后端过滤，直接取一页最多 100 条在本地比对 publicId。
    const listResult = await apiRequest("/api/product-dev/products?pageSize=100", { method: "GET" });
    if (listResult && listResult.ok && listResult.data && Array.isArray(listResult.data.items)) {
      const items = listResult.data.items;
      const hit = items.find(function (item) {
        return String((item && item.publicId) || "").trim().toLowerCase() === wanted;
      });
      if (hit) product = { publicId: hit.publicId, title: hit.title };
      // 后端 pageSize 上限 100：total <= 返回条数 说明这一页就是全部商品，缺席即真的不存在
      listCoversAllProducts = Number(listResult.data.total) <= items.length;
    }
    // ② 仅当列表没覆盖全部商品时，才用精确点名兜底（避免对「确实不存在」的 SKU 打出 404 噪音）
    if (!product && !listCoversAllProducts) {
      const detailResult = await apiRequest("/api/product-dev/products/" + encodeURIComponent(sku), { method: "GET" });
      if (detailResult && detailResult.ok && detailResult.data && detailResult.data.product) {
        const detail = detailResult.data.product;
        if (String(detail.publicId || "").trim().toLowerCase() === wanted) {
          product = { publicId: detail.publicId, title: detail.title };
        }
      }
    }
    pdevLookupCache.set(wanted, product);
    return product;
  }

  async function lookupPdevProductName() {
    const skuInput = el("sklAddItemSku");
    if (!skuInput || typeof apiRequest !== "function") return;
    const sku = String(skuInput.value || "").trim();
    const seq = ++pdevLookupSeq;
    if (!sku) { setPdevNameHint(""); return; }   // 清空输入：只去掉提示，不动产品名
    let product = null;
    try {
      product = await findPdevProductBySku(sku);
    } catch (error) {
      product = null;   // 失败静默：不清空、不报错
    }
    applyPdevProductName(seq, sku, product);
  }

  function schedulePdevProductNameLookup() {
    if (pdevLookupTimer) clearTimeout(pdevLookupTimer);
    pdevLookupTimer = setTimeout(function () {
      pdevLookupTimer = null;
      lookupPdevProductName();
    }, PDEV_LOOKUP_DEBOUNCE_MS);
  }

  function flushPdevProductNameLookup() {
    if (pdevLookupTimer) { clearTimeout(pdevLookupTimer); pdevLookupTimer = null; }
    lookupPdevProductName();
  }

  // input 走 300ms 防抖；change / 失焦立即补一次
  document.addEventListener("input", function (event) {
    if (event.target && event.target.id === "sklAddItemSku") schedulePdevProductNameLookup();
  });
  document.addEventListener("change", function (event) {
    if (event.target && event.target.id === "sklAddItemSku") flushPdevProductNameLookup();
  });
  document.addEventListener("focusout", function (event) {
    if (event.target && event.target.id === "sklAddItemSku") flushPdevProductNameLookup();
  }, true);

  // ==================================================================
  // 【task-5】核心闭环：列表渲染 + 搜索/重置 + 新增确认（解绑/删除见 task-10 的批量删除）
  //
  // 只读侦察结论（本次真实请求实测，不是猜）：
  //   · GET /api/online-products **完全不读 query 参数**。实测对比（基线 items=1529）：
  //       无参数 / ?shopSku=<真实值> / ?shopSku=__ZZZ_NOT_EXIST__ / ?q= / ?keyword= /
  //       ?offerId= / ?marketSku= / ?sku= / ?pageSize=1 / ?page=2 / ?shopId= / ?provider= / ?status=
  //     全部 status=200、items=1529、首条 id 也相同 —— 参数被静默忽略。
  //     后端 backend/routes/online-products.js:7-23 的 handler 只做鉴权 + 店铺分配过滤，
  //     没有参数解析；响应体只有 { items }，没有 pagination。
  //   · 结论：不存在「按店铺SKU精确过滤」的参数。策略 = 直接拉全量（接口本来就返回全量）
  //     + 客户端精确匹配（忽略大小写）：先比 shopSku / offerId / vendorCode，
  //     都没有命中时再兜底比 marketSku / id。
  //   · 在线产品字段：{ id, provider:"yandex_market"|"ozon", shopId, shopName, offerId,
  //     shopSku, vendorCode, marketSku, name, salePrice, ... }；provider 要归一化到 yandex/ozon。
  //   · GET /api/pdev-links 返回 { items:[{ id, pdevSku, onlineProductId, shopId, shopName,
  //     provider, marketSku, offerId, productTitle, salePrice, note, createdBy, createdAt }] }，
  //     ?pdevSku= 是精确过滤；写操作要 pdev.write（403 文案见后端）。
  // ==================================================================
  const linksState = { items: [], rows: [], loaded: false };
  const onlineProductState = { items: [], loadedAt: 0, pending: null };
  // 商品管理商品索引：小写 publicId(=商品SKU) → { isBundle, title }
  const pdevBundleState = { map: null, pending: null };
  let linksSeq = 0;

  function sklText(value) { return String(value == null ? "" : value).trim(); }

  function providerText(value) {
    const normalized = normalizeProvider(value);
    if (!normalized) return "-";
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  function linkShopSku(item) {
    return sklText(item && item.offerId) || sklText(item && item.marketSku) || sklText(item && item.onlineProductId) || "-";
  }

  function linkCreatedAtText(value) {
    if (!value) return "-";
    if (typeof formatDateTime === "function") return formatDateTime(value);
    return sklText(value);
  }

  // 【task-27】绑定/解绑/换绑/导入建绑定成功后，让共享索引（订单/产品列表的「商品SKU」与预估利润）立刻生效。
  //   fire-and-forget：不 await、不改动现有提示与流程；共享索引内部对失败已安静处理，这里再兜一层 try。
  function refreshSharedSkuIndex() {
    try {
      if (window.PdevSkuIndex && typeof window.PdevSkuIndex.refresh === "function") {
        const task = window.PdevSkuIndex.refresh();
        if (task && typeof task.catch === "function") task.catch(function () { /* 安静：失败不影响本页 */ });
      }
    } catch (error) { /* 容错：共享索引不可用时也不影响本页 */ }
  }

  // ---------- 页面级提示 ----------
  let sklPageMsgTimer = null;
  function setPageMsg(kind, message) {
    const box = el("sklPageMsg");
    if (!box) return;
    if (sklPageMsgTimer) { clearTimeout(sklPageMsgTimer); sklPageMsgTimer = null; }
    box.textContent = message || "";
    box.className = "skl-page-msg" + (kind ? " " + kind : "") + (message ? "" : " hidden");
    if (message && kind === "ok") {
      sklPageMsgTimer = setTimeout(function () { setPageMsg("", ""); }, 5000);
    }
  }

  // ---------- 弹窗内提示（红色文字，不用 alert） ----------
  function setAddMsg(message) {
    const box = el("sklAddModalMsg");
    if (!box) return;
    box.textContent = message || "";
    box.className = "skl-modal-msg" + (message ? "" : " hidden");
  }

  // ---------- 【task-11】新增成功后的「绑定信息」：显示在新增弹窗内部、底部按钮上方 ----------
  // 为什么不再用 setPageMsg：用户明确要求这行字出现在新增弹窗里，而列表上方那条「新增成功…」
  // 不再显示。setPageMsg 机制本身完整保留（删除结果 / 加载失败 / 换绑 / 校验等仍照旧显示），
  // 只是新增成功这一条改成写进 #sklAddBindingInfo。
  function setAddBindingInfo(message) {
    const box = el("sklAddBindingInfo");
    if (!box) return;
    box.textContent = message || "";
    box.className = "skl-add-binding-info" + (message ? "" : " hidden");
  }

  // 创建人 = 当前登录用户：优先取全局 state.user.username（shared/core/state.js + auth.js 登录后写入），
  // 取不到时退到页面右上角用户名 (#currentUser) 的文本；都取不到就显示 "-"，不抛异常。
  function currentUserName() {
    try {
      if (typeof state !== "undefined" && state && state.user) {
        const name = sklText(state.user.username);
        if (name) return name;
      }
    } catch (error) {
      // 忽略：走下面的兜底
    }
    const node = el("currentUser");
    return sklText(node && node.textContent) || "-";
  }

  // ---------- 在线产品：一次拉全量 + 客户端精确匹配 ----------
  const ONLINE_PRODUCTS_TTL_MS = 30000;

  async function loadSklOnlineProducts() {
    if (typeof apiRequest !== "function") return [];
    if (onlineProductState.pending) return onlineProductState.pending;
    onlineProductState.pending = (async function () {
      try {
        const result = await apiRequest("/api/online-products", { method: "GET" });
        if (result && result.ok && result.data && Array.isArray(result.data.items)) {
          onlineProductState.items = result.data.items;
          onlineProductState.loadedAt = Date.now();
        }
      } catch (error) {
        // 静默：保留上一次缓存，由调用方按「找不到」处理
      }
      onlineProductState.pending = null;
      return onlineProductState.items;
    })();
    return onlineProductState.pending;
  }

  async function ensureOnlineProducts() {
    const fresh = onlineProductState.loadedAt && (Date.now() - onlineProductState.loadedAt) < ONLINE_PRODUCTS_TTL_MS;
    if (fresh) return onlineProductState.items;
    return loadSklOnlineProducts();
  }

  // 精确匹配（忽略大小写、去空白）：主键 shopSku/offerId/vendorCode，兜底 marketSku/id
  function findOnlineProducts(shopSku) {
    const wanted = sklText(shopSku).toLowerCase();
    if (!wanted) return { candidates: [], matchedBy: "" };
    const all = onlineProductState.items;
    const equalsAny = function (product, keys) {
      return keys.some(function (key) { return sklText(product && product[key]).toLowerCase() === wanted; });
    };
    let candidates = all.filter(function (product) { return equalsAny(product, ["shopSku", "offerId", "vendorCode"]); });
    let matchedBy = candidates.length ? "shopSku/offerId/vendorCode" : "";
    if (!candidates.length) {
      candidates = all.filter(function (product) { return equalsAny(product, ["marketSku", "id"]); });
      if (candidates.length) matchedBy = "marketSku/id";
    }
    return { candidates: candidates, matchedBy: matchedBy };
  }

  // ---------- 商品SKU → 商品管理商品索引（isBundle + title） ----------
  // /api/pdev-links 的绑定记录里没有「是否组合」字段（后端表 pdev_online_links 也没有），
  // 所以这个筛选条件只能借商品管理的 isBundle 判定；查不到时保守放行（不误杀）。
  // 【task-7】索引值由「isBundle 文本」扩展为 { isBundle, title }：
  //   · isBundle → task-5「是否为组合SKU」列 / 组合筛选；
  //   · title    → 本任务「产品名称」列：用户要求产品名称取「商品SKU」对应的商品管理商品名（中文），
  //                而不是绑定记录里的 productTitle（来源 online_products.name，是店铺在线产品的俄文名）。
  //   仍然复用同一个请求（/api/product-dev/products?pageSize=100），不新增任何重复网络请求。
  async function loadPdevBundleIndex() {
    if (pdevBundleState.map) return pdevBundleState.map;
    if (pdevBundleState.pending) return pdevBundleState.pending;
    pdevBundleState.pending = (async function () {
      const map = new Map();
      try {
        const result = await apiRequest("/api/product-dev/products?pageSize=100", { method: "GET" });
        if (result && result.ok && result.data && Array.isArray(result.data.items)) {
          result.data.items.forEach(function (product) {
            const key = sklText(product && product.publicId).toLowerCase();
            if (key) map.set(key, { isBundle: sklText(product && product.isBundle), title: sklText(product && product.title) });
          });
          pdevBundleState.map = map;
        }
      } catch (error) {
        // 静默：拿不到索引时该条件保守放行
      }
      pdevBundleState.pending = null;
      return map;
    })();
    return pdevBundleState.pending;
  }

  // 取某个商品SKU 在商品管理里的索引项（找不到 → undefined）
  function pdevProductEntry(pdevSku) {
    const map = pdevBundleState.map;
    if (!map) return undefined;
    return map.get(sklText(pdevSku).toLowerCase());
  }

  function bundleFilterAllows(pdevSku, wanted) {
    if (!wanted) return true;
    const map = pdevBundleState.map;
    if (!map) return true;                                  // 索引还没到位：保守放行
    const entry = pdevProductEntry(pdevSku);
    if (entry === undefined) return true;                    // 商品列表里查不到：无法判定，保守放行
    const flag = entry.isBundle;
    return wanted === "1" ? flag === "是" : flag !== "是";
  }

  // ---------- 客户端筛选（商品SKU 走后端 ?pdevSku=） ----------
  function selectedOptionText(selectEl) {
    if (!selectEl || !selectEl.options) return "";
    const option = selectEl.options[selectEl.selectedIndex];
    return option ? sklText(option.textContent) : "";
  }

  function passesClientFilters(item) {
    const shopSkuInput = el("sklFilterPlatformSku");
    const shopSkuList = typeof splitFilterText === "function" ? splitFilterText(shopSkuInput && shopSkuInput.value) : [];
    if (shopSkuList.length) {
      const field = [item.offerId, item.marketSku, item.onlineProductId].map(sklText).join(" ");
      if (typeof matchesAny === "function" && !matchesAny(field, shopSkuList)) return false;
    }
    const bundleValue = sklText(el("sklFilterBundle") && el("sklFilterBundle").value);
    if (!bundleFilterAllows(item.pdevSku, bundleValue)) return false;
    const creatorValue = sklText(el("sklFilterCreator") && el("sklFilterCreator").value);
    if (creatorValue && sklText(item.createdBy) !== creatorValue) return false;
    const providerValue = sklText(el("sklFilterProvider") && el("sklFilterProvider").value);
    if (providerValue && normalizeProvider(item.provider) !== normalizeProvider(providerValue)) return false;
    const shopSelect = el("sklFilterShop");
    const shopValue = sklText(shopSelect && shopSelect.value);
    if (shopValue) {
      const shopName = selectedOptionText(shopSelect);
      const idHit = sklText(item.shopId) === shopValue;
      const nameHit = shopName && sklText(item.shopName) === shopName;
      if (!idHit && !nameHit) return false;
    }
    return true;
  }

  // ---------- 表格渲染（8 列，列宽/顺序与表头一致：
  //   ☐ | 店铺SKU | 商品SKU | 产品名称 | 店铺账户 | 是否为组合SKU | 组合信息 | 操作） ----------
  function buildCell(value, className) {
    const td = document.createElement("td");
    if (className) td.className = className;
    td.textContent = value === null || value === undefined || value === "" ? "-" : String(value);
    return td;
  }

  // 店铺SKU 文本右侧的小蓝色图标（内联 SVG，不引外链图片）
  const SKU_LINK_ICON_SVG = '<svg class="skl-sku-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><rect x="2.2" y="5.4" width="8.4" height="8.4" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.6 5.4V3.3c0-.7.6-1.3 1.3-1.3h6.1c.7 0 1.3.6 1.3 1.3v6.1c0 .7-.6 1.3-1.3 1.3h-2.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

  // 【task-14】复制按钮用到的常量（放在 buildShopSkuCell 之前，避免任何声明顺序问题）
  const COPY_SKU_TITLE = "复制店铺SKU";
  const COPY_FEEDBACK_MS = 1200;
  // 复制成功那一刻临时显示的 ✓（13x13，与常态图标同尺寸；颜色由 .is-copied 变绿）
  const SKU_COPIED_ICON_SVG = '<svg class="skl-sku-icon skl-sku-icon-check" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path d="M6.6 12.3 2.9 8.6l1.4-1.4 2.3 2.3 5.1-5.1 1.4 1.4z" fill="currentColor"/></svg>';

  // ② 店铺SKU：最左侧可点展开箭头 + SKU 文本 + 小蓝色图标
  // 【task-8】箭头由「视觉占位」改为真正的展开按钮：收起 ▸ / 展开 ▾，带 aria-expanded。
  function buildShopSkuCell(item) {
    const td = document.createElement("td");
    const wrap = document.createElement("span");
    wrap.className = "skl-shop-sku";
    const arrow = document.createElement("span");
    arrow.className = "skl-expand";
    arrow.setAttribute("data-skl-expand", "1");
    arrow.setAttribute("role", "button");
    arrow.setAttribute("tabindex", "0");
    arrow.setAttribute("aria-expanded", "false");
    arrow.title = "展开组合明细";
    arrow.textContent = "▸";
    const text = document.createElement("span");
    text.className = "skl-sku-text";
    const value = linkShopSku(item);
    text.textContent = value;
    if (value && value !== "-") text.title = value;
    // 【task-14】小蓝图标由「纯装饰 span」改成真正的「复制店铺SKU」按钮（button 自带键盘可达：Enter / 空格）
    const iconWrap = document.createElement("button");
    iconWrap.type = "button";
    iconWrap.className = "skl-sku-icon-wrap";
    iconWrap.setAttribute("data-skl-copy", "1");
    iconWrap.setAttribute("data-sku", value === "-" ? "" : value);
    iconWrap.setAttribute("aria-label", COPY_SKU_TITLE);
    iconWrap.title = COPY_SKU_TITLE;
    iconWrap.innerHTML = SKU_LINK_ICON_SVG;   // 固定常量，无用户数据
    wrap.appendChild(arrow);
    wrap.appendChild(text);
    wrap.appendChild(iconWrap);
    td.appendChild(wrap);
    return td;
  }

  // ==================================================================
  // 【task-14】店铺SKU 复制按钮（修 bug：原来那个小蓝图标只是装饰，点了没反应）
  //   · 复制内容 = 该行「店铺SKU」格子里 <span class="skl-sku-text"> 的实时文本，与屏幕上显示的
  //     逐字符一致（不含 ▸/▾ 箭头、不含空格、不含其它列）；取不到才退回 data-sku 属性。
  //   · 优先 navigator.clipboard.writeText；不可用/抛错 → document.execCommand('copy') + 临时 textarea；
  //     两条都失败 → 页面级红字提示。全程 try/catch，绝不抛未捕获异常 / 未处理 Promise。
  //   · 点击时 stopPropagation()，不连带触发行展开等副作用。
  //   · 反馈方式（二选一，这里选图标）：成功 → 图标短暂变 ✓（绿色，1.2s 后复原），不打扰、不占用页面提示；
  //     失败 → 才用页面级提示（图标本身表达不了失败）。
  // ==================================================================
  function copyTextOfButton(button) {
    const wrap = button && button.closest ? button.closest(".skl-shop-sku") : null;
    const textNode = wrap ? wrap.querySelector(".skl-sku-text") : null;
    const live = sklText(textNode && textNode.textContent);
    if (live) return live;
    return sklText(button && button.getAttribute("data-sku"));
  }

  // 兜底：临时 textarea + document.execCommand('copy')
  function copyTextLegacy(text) {
    let ok = false;
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "readonly");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.left = "-1000px";
    area.style.width = "1px";
    area.style.height = "1px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    try {
      area.select();
      if (typeof area.setSelectionRange === "function") area.setSelectionRange(0, area.value.length);
      ok = document.execCommand("copy") === true;
    } catch (error) {
      ok = false;                                    // 兜底也失败：转成提示，不抛
    } finally {
      if (area.parentNode) area.parentNode.removeChild(area);
    }
    return ok;
  }

  function showCopyResult(button, ok) {
    if (!ok) {
      setPageMsg("err", "复制失败，请手动选中店铺SKU 复制");
      return;
    }
    if (!button || !button.isConnected) return;
    if (button._sklCopyTimer) clearTimeout(button._sklCopyTimer);
    button.classList.add("is-copied");
    button.innerHTML = SKU_COPIED_ICON_SVG;
    button.title = "已复制";
    button._sklCopyTimer = setTimeout(function () {
      button._sklCopyTimer = null;
      if (!button.isConnected) return;               // 行已被重渲染：无需复原
      button.classList.remove("is-copied");
      button.innerHTML = SKU_LINK_ICON_SVG;
      button.title = COPY_SKU_TITLE;
    }, COPY_FEEDBACK_MS);
  }

  async function copyShopSku(button, event) {
    if (event && typeof event.stopPropagation === "function") event.stopPropagation();
    try {
      const text = copyTextOfButton(button);
      if (!text || text === "-") {
        setPageMsg("err", "这一行没有可复制的店铺SKU");
        return;
      }
      let ok = false;
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(text);
          ok = true;
        }
      } catch (error) {
        ok = false;                                  // clipboard 不可用 / 被拒 → 走兜底
      }
      if (!ok) ok = copyTextLegacy(text);
      showCopyResult(button, ok);
    } catch (error) {
      setPageMsg("err", "复制失败：" + String((error && error.message) || error));
    }
  }

  // ⑥ 是否为组合SKU：沿用商品管理 isBundle 索引（task-5 已建；绑定记录里没有该字段）。
  //    索引里查不到该商品 / 索引还没到位时按「否」显示（与参考图的「否」一致）。
  function bundleFlagText(pdevSku) {
    const entry = pdevProductEntry(pdevSku);
    const text = sklText(entry && entry.isBundle);
    if (text === "是" || text === "1" || /^(true|yes|y)$/i.test(text)) return "是";
    return "否";
  }

  function buildBundleCell(item) {
    const td = document.createElement("td");
    td.className = "skl-cell-center";
    const span = document.createElement("span");
    span.className = "skl-bundle";
    span.textContent = bundleFlagText(item.pdevSku);
    td.appendChild(span);
    return td;
  }

  // ④ 产品名称：取「商品SKU」在商品管理里的商品名（中文），不是绑定记录的 productTitle。
  //    productTitle 来源 online_products.name，是店铺在线产品的名字（俄文），用户明确说这是错的。
  //    退路：按 pdevSku 在商品管理里查不到（历史脏数据 / 索引未覆盖）→ 显示原 productTitle，
  //    并用 title 属性说明「未找到商品管理中的商品，显示的是店铺产品名」，避免整列空白。
  function buildProductNameCell(item) {
    const td = document.createElement("td");
    const pdevSku = sklText(item && item.pdevSku);
    const entry = pdevProductEntry(pdevSku);
    const productTitle = sklText(entry && entry.title);
    if (productTitle) {
      td.textContent = productTitle;
      td.title = "来自商品管理：商品SKU " + (pdevSku || "-") + " 的商品名";
      return td;
    }
    const fallback = sklText(item && item.productTitle);
    td.textContent = fallback || "-";
    td.title = "未找到商品管理中的商品，显示的是店铺产品名";
    return td;
  }

  // ==================================================================
  // 【task-8】父行 + 可展开的组合明细子表（商品SKU / 数量 / 产品名称）
  //
  // 只读侦察结论（本次实跑 SQL / information_schema / API，不是猜；详见汇报）：
  //   · 全库 42 张表里与「组合」有关的字段只有一个：pdev_products.is_bundle VARCHAR(8)。
  //     按名称扫 bundle/combo/child/component/qty/quantity 也只命中 pdev_products.is_bundle
  //     —— 数据库里**不存在**「组合子项明细表」（没有 bundle_items / combo_items / pdev_bundle_*）。
  //   · pdev_variants 是「规格变体」：列是 variant_key（实测形如「尺寸=l;颜色=黑」）+ spec_json，
  //     没有子 SKU、没有数量，语义上不是组合子项；本次库里唯一带 is_bundle 值的商品
  //     SKU-261010-HPIH 的 is_bundle="否"、pdev_variants=0 行、pdev_sources=0 行。
  //   · pdev_online_links.note 形如「商品名 x数量」（新增弹窗写入 name + " x" + qty，
  //     实测现网那条 note="网红棕熊… x1"）——这是「数量」唯一真实的来源。
  //   · 因此三列取值：商品SKU = 绑定记录 pdevSku(=pdev_products.public_id)；
  //     数量 = note 末尾「xN」的 N（解析不到按 1，与任务约定的兜底一致）；
  //     产品名称 = 商品管理里该商品SKU 的商品名（与列表「产品名称」列同源 pdevBundleState.map
  //     ，拿不到时依次退 note 里的名称、绑定记录 productTitle，保证不空白）。
  //   · 分支：仅当商品管理索引里该商品 is_bundle="是" 时，才去点名
  //     GET /api/product-dev/products/<sku> 取 variants；有几个变体就列几行（数量 1，
  //     产品名称 = 商品名（规格键））。查不到变体 / 不是组合 → 固定一行兜底。
  //     只在确认是组合时才点名，避免对不存在的 SKU 打 404 污染控制台。
  // ==================================================================
  const expandState = { byRowKey: new Map(), variantsBySku: new Map() };

  // note 形如「商品名 x1」→ { name, qty }；末尾没有「x数字」时按 1
  function parseNoteQuantity(note) {
    const text = sklText(note);
    const matched = /(?:^|\s)x\s*(\d+)\s*$/i.exec(text);
    if (!matched) return { name: text, qty: 1 };
    const qty = Number(matched[1]);
    return { name: text.slice(0, matched.index).trim(), qty: Number.isFinite(qty) && qty > 0 ? qty : 1 };
  }

  function expandProductTitle(item, parsed) {
    const entry = pdevProductEntry(sklText(item && item.pdevSku));
    return sklText(entry && entry.title) || sklText(parsed && parsed.name) || sklText(item && item.productTitle) || "-";
  }

  // 兜底明细行：单个商品 / 查不到组合子项时至少一行，不空白
  function defaultExpandRows(item) {
    const parsed = parseNoteQuantity(item && item.note);
    return [{ sku: sklText(item && item.pdevSku) || "-", qty: parsed.qty, name: expandProductTitle(item, parsed) }];
  }

  // 组合子项：把 pdev_variants 的每个变体列一行（数量 1；SKU 仍取该商品的商品SKU）
  function variantExpandRows(item, variants) {
    const parsed = parseNoteQuantity(item && item.note);
    const sku = sklText(item && item.pdevSku) || "-";
    const title = expandProductTitle(item, parsed);
    return variants.map(function (variant) {
      const variantKey = sklText(variant && variant.variantKey);
      return { sku: sku, qty: 1, name: variantKey ? title + "（" + variantKey + "）" : title };
    });
  }

  // 详情接口（只在「索引里确认是组合」时调用），按 SKU 缓存 Promise 去重
  function pdevVariants(pdevSku) {
    const key = sklText(pdevSku).toLowerCase();
    let task = expandState.variantsBySku.get(key);
    if (!task) {
      task = (async function () {
        try {
          const result = await apiRequest("/api/product-dev/products/" + encodeURIComponent(pdevSku), { method: "GET" });
          if (result && result.ok && result.data && Array.isArray(result.data.variants)) return result.data.variants;
        } catch (error) {
          // 静默：拿不到组合子项就退回兜底行
        }
        return [];
      })();
      expandState.variantsBySku.set(key, task);
    }
    return task;
  }

  function setExpandArrowState(parentTr, expanded) {
    const arrow = parentTr && parentTr.querySelector(".skl-expand");
    if (!arrow) return;
    arrow.textContent = expanded ? "▾" : "▸";
    arrow.setAttribute("aria-expanded", expanded ? "true" : "false");
    arrow.title = expanded ? "收起组合明细" : "展开组合明细";
  }

  // 只认紧跟自己那条 tr 的展开行（同一时刻可展开多行）
  function expandRowOf(parentTr) {
    const node = parentTr && parentTr.nextElementSibling;
    if (!node || !node.classList || !node.classList.contains("skl-expand-row")) return null;
    return node.getAttribute("data-skl-expand-for") === parentTr.getAttribute("data-skl-row-id") ? node : null;
  }

  function renderExpandContent(td, item, rows) {
    td.textContent = "";
    const table = document.createElement("table");
    table.className = "skl-expand-inner";
    // 【task-10】① 子表铺满整行（width:100%）；table-layout:fixed 下列宽由表头 th 决定，
    // 所以 th 与 td 用同一组 class：商品SKU 22% / 数量 10% / 产品名称 68%。
    const columns = [
      { text: "商品SKU", className: "skl-expand-sku" },
      { text: "数量", className: "skl-expand-qty" },
      { text: "产品名称", className: "skl-expand-name" }
    ];
    const thead = document.createElement("thead");
    const headTr = document.createElement("tr");
    columns.forEach(function (column) {
      const th = document.createElement("th");
      th.className = column.className;
      th.textContent = column.text;
      headTr.appendChild(th);
    });
    thead.appendChild(headTr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    rows.forEach(function (row) {
      const tr = document.createElement("tr");
      const cells = [
        { className: "skl-expand-sku", value: row.sku || "-" },
        { className: "skl-expand-qty", value: String(row.qty == null ? 1 : row.qty) },
        { className: "skl-expand-name", value: row.name || "-" }
      ];
      cells.forEach(function (cell) {
        const cellTd = document.createElement("td");
        cellTd.className = cell.className;
        cellTd.textContent = cell.value;
        tr.appendChild(cellTd);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    td.appendChild(table);
    if (bundleFlagText(sklText(item && item.pdevSku)) === "是") {
      const hint = document.createElement("div");
      hint.className = "skl-expand-hint";
      hint.textContent = rows.length > 1 ? "组合明细：" + rows.length + " 个子项" : "组合明细";
      td.appendChild(hint);
    }
  }

  async function toggleExpand(arrow) {
    const parentTr = arrow && arrow.closest ? arrow.closest("tr") : null;
    if (!parentTr) return;
    const rowKey = parentTr.getAttribute("data-skl-row-id") || "";
    const opened = expandRowOf(parentTr);
    if (opened) {                          // 再次点击 → 收起
      opened.remove();
      setExpandArrowState(parentTr, false);
      return;
    }
    setExpandArrowState(parentTr, true);   // 支持同时展开多行：每行各插一条，互不影响
    const tr = document.createElement("tr");
    tr.className = "skl-expand-row";
    tr.setAttribute("data-skl-expand-for", rowKey);
    const td = document.createElement("td");
    td.className = "skl-expand-cell";
    td.colSpan = 7;                        // 【task-10】父表 7 列
    td.textContent = "加载中…";
    tr.appendChild(td);
    parentTr.parentNode.insertBefore(tr, parentTr.nextSibling);

    const item = expandState.byRowKey.get(rowKey);
    if (!item) return;                     // 数据已换批：保留加载态即可，不抛异常
    try {
      let rows = defaultExpandRows(item);
      if (bundleFlagText(sklText(item.pdevSku)) === "是") {
        const variants = await pdevVariants(sklText(item.pdevSku));
        if (variants && variants.length) rows = variantExpandRows(item, variants);
      }
      if (!tr.isConnected) return;         // 等待期间被收起 / 列表重渲染
      renderExpandContent(td, item, rows);
    } catch (error) {
      if (tr.isConnected) renderExpandContent(td, item, defaultExpandRows(item));
    }
  }

  // ---------- 【task-9】⑦ 操作列：编辑 / 日志（蓝色文字链接，沿用 .skl-link 与事件委托）
  // 【task-10】② 操作列去掉「解绑」：解绑能力改由顶部「删除」按钮承担（DELETE /api/pdev-links/:id）。
  function buildActionLink(text, dataAttr, id, title) {
    const link = document.createElement("a");
    link.className = "skl-link";
    link.setAttribute("role", "button");
    link.setAttribute("tabindex", "0");
    link.setAttribute(dataAttr, "1");
    link.setAttribute("data-id", id);
    if (title) link.title = title;
    link.textContent = text;
    return link;
  }

  function buildActionCell(item) {
    const td = document.createElement("td");
    td.className = "skl-cell-center";
    const id = sklText(item && item.id);
    const wrap = document.createElement("span");
    wrap.className = "skl-action-links";
    wrap.appendChild(buildActionLink("编辑", "data-skl-edit", id, "编辑这条绑定的店铺SKU / 商品SKU"));
    wrap.appendChild(buildActionLink("日志", "data-skl-logs", id, "查看这条绑定的操作日志"));
    td.appendChild(wrap);
    return td;
  }

  function buildLinkRow(item, rowKey) {
    const tr = document.createElement("tr");
    tr.setAttribute("data-skl-row-id", rowKey || "");
    const tdCheck = document.createElement("td");
    tdCheck.className = "skl-cell-center";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "skl-row-check";
    checkbox.setAttribute("data-id", sklText(item.id));
    tdCheck.appendChild(checkbox);
    // 【task-10】④ 父行 7 列（与表头一一对应）：
    //    ① 复选框 ② 店铺SKU ③ 产品名称 ④ 店铺账户 ⑤ 是否为组合SKU ⑥ 组合信息 ⑦ 操作
    //    原先的「商品SKU」列已从父行移除（展开的子表里保留该列），colspan 同步改为 7。
    tr.appendChild(tdCheck);                                        // ① 复选框
    tr.appendChild(buildShopSkuCell(item));                         // ② 店铺SKU（可点箭头 + 文本 + 小蓝图标）
    tr.appendChild(buildProductNameCell(item));                     // ③ 产品名称（商品管理的商品名，非店铺产品名）
    tr.appendChild(buildCell(sklText(item.shopName)));              // ④ 店铺账户
    tr.appendChild(buildBundleCell(item));                          // ⑤ 是否为组合SKU（红字）
    tr.appendChild(buildCell("-", "skl-cell-center skl-combo"));    // ⑥ 组合信息（暂无数据源，统一 -）
    tr.appendChild(buildActionCell(item));                          // ⑦ 操作：编辑 / 日志
    return tr;
  }

  function renderLinks() {
    const tbody = el("skuLinksTableBody");
    if (!tbody) return;
    rememberBindings(linksState.items);   // 【task-12】留一份会话内绑定快照，供日志明细在绑定被删后仍能解析
    const rows = linksState.items.filter(passesClientFilters);
    linksState.rows = rows;
    tbody.textContent = "";
    expandState.byRowKey = new Map();   // 重新渲染：旧展开行的行键失效，展开行本身也随 tbody 一起没了
    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.className = "skl-empty";
      td.colSpan = 7;                    // 【task-10】父表 7 列
      td.textContent = linksState.loaded ? "暂无数据" : "加载中…";
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      rows.forEach(function (item, index) {
        const rowKey = sklText(item && item.id) || "idx-" + index;
        expandState.byRowKey.set(rowKey, item);
        tbody.appendChild(buildLinkRow(item, rowKey));
      });
    }
    const selectAll = el("sklSelectAll");
    if (selectAll) selectAll.checked = false;
  }

  // 「创建人」下拉用真实数据填充（保留当前选择），让该筛选条件可用
  function populateCreatorOptions() {
    const selectEl = el("sklFilterCreator");
    if (!selectEl) return;
    const previous = selectEl.value;
    const names = [];
    linksState.items.forEach(function (item) {
      const name = sklText(item.createdBy);
      if (name && names.indexOf(name) < 0) names.push(name);
    });
    names.sort();
    // 用户已选的创建人即使本次数据里没有也要保留，否则重填下拉会把筛选值悄悄清掉
    if (previous && names.indexOf(previous) < 0) names.unshift(previous);
    selectEl.textContent = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "请选择创建人";
    selectEl.appendChild(placeholder);
    names.forEach(function (name) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      selectEl.appendChild(option);
    });
    selectEl.value = names.indexOf(previous) >= 0 ? previous : "";
  }

  async function loadLinks() {
    const tbody = el("skuLinksTableBody");
    if (!tbody || typeof apiRequest !== "function") return;
    const seq = ++linksSeq;
    const pdevSku = sklText(el("sklFilterWarehouseSku") && el("sklFilterWarehouseSku").value);
    const path = pdevSku ? "/api/pdev-links?pdevSku=" + encodeURIComponent(pdevSku) : "/api/pdev-links";
    let result = null;
    try {
      result = await apiRequest(path, { method: "GET" });
    } catch (error) {
      result = null;
    }
    if (seq !== linksSeq) return;
    if (!result || !result.ok || !result.data || !Array.isArray(result.data.items)) {
      linksState.items = [];
      linksState.loaded = true;
      renderLinks();
      setPageMsg("err", (result && result.error) ? String(result.error) : "列表加载失败");
      return;
    }
    linksState.items = result.data.items;
    linksState.loaded = true;
    populateCreatorOptions();
    // 「是否为组合SKU」列要显示真实 isBundle，所以不管筛选值是什么都先确保索引到位
    // （原来只在选了组合筛选项时才加载；查不到时该列按「否」显示）
    if (!pdevBundleState.map) {
      await loadPdevBundleIndex();
      if (seq !== linksSeq) return;
    }
    renderLinks();
  }

  function resetFilters() {
    ["sklFilterPlatformSku", "sklFilterWarehouseSku", "sklFilterBundle", "sklFilterCreator"].forEach(function (id) {
      const node = el(id);
      if (node) node.value = "";
    });
    const providerSelect = el("sklFilterProvider");
    if (providerSelect) providerSelect.value = "";
    // 【task-10 顺手修掉实测发现的既有 bug】fillShopSelect 的契约是「尽量保留原选择」，
    // 所以「重置」里只调它并不能清空「店铺账户」：之前选过的店铺只要还在选项里就会被保留，
    // 于是点「重置」后列表仍被店铺过滤（本次实测：选过 Seagull → 点重置后依然只剩 Seagull 的行）。
    // 重置的语义必须是真的清空 → 重填后显式回到「全部店铺」。
    const shopSelect = el("sklFilterShop");
    fillShopSelect(shopSelect, "");
    if (shopSelect) shopSelect.value = "";
    setPageMsg("", "");
  }

  // ---------- 新增确认 ----------
  let addSubmitting = false;

  function resetAddForm() {
    const values = { sklAddShopSku: "", sklAddItemSku: "", sklAddItemName: "" };
    Object.keys(values).forEach(function (id) {
      const node = el(id);
      if (node) node.value = values[id];
    });
    const qty = el("sklAddItemQty");
    if (qty) qty.value = "1";
    const providerSelect = el("sklAddProvider");
    if (providerSelect) providerSelect.value = "";
    fillShopSelect(el("sklAddShop"), "");
    const bundleNo = document.querySelector('input[name="sklAddBundle"][value="0"]');
    if (bundleNo) bundleNo.checked = true;
    setPdevNameHint("");
    setAddMsg("");
    setAddBindingInfo("");   // 【task-11】表单重置时一并清掉上次的绑定信息（成功后再写入新的）
  }

  function validationMessage(pdevSku, shopSku) {
    if (!pdevSku && !shopSku) return "请填写商品SKU 与 店铺SKU";
    if (!pdevSku) return "请填写商品SKU";
    if (!shopSku) return "请填写店铺SKU";
    return "";
  }

  async function submitAdd() {
    if (addSubmitting) return;
    const pdevSku = sklText(el("sklAddItemSku") && el("sklAddItemSku").value);
    const shopSku = sklText(el("sklAddShopSku") && el("sklAddShopSku").value);
    setAddMsg("");
    const invalid = validationMessage(pdevSku, shopSku);
    if (invalid) { setAddMsg(invalid); return; }

    const confirmBtn = el("sklAddConfirm");
    addSubmitting = true;
    if (confirmBtn) confirmBtn.disabled = true;
    try {
      // ① 店铺SKU → 在线产品（拉全量 + 客户端精确匹配）
      await ensureOnlineProducts();
      const found = findOnlineProducts(shopSku);
      if (!found.candidates.length) {
        setAddMsg("未找到店铺SKU「" + shopSku + "」对应的在线产品");
        return;
      }
      let product = found.candidates[0];

      // ② 销售平台 / 店铺账户 一致性校验（选了就必须一致，否则阻止提交，避免绑错）
      const providerValue = sklText(el("sklAddProvider") && el("sklAddProvider").value);
      if (providerValue) {
        const hit = found.candidates.find(function (candidate) {
          return normalizeProvider(candidate.provider) === normalizeProvider(providerValue);
        });
        if (!hit) {
          setAddMsg("店铺SKU「" + shopSku + "」命中的在线产品属于 " + providerText(product.provider) +
            "，与所选销售平台 " + providerText(providerValue) + " 不一致，已阻止提交");
          return;
        }
        product = hit;
      }
      const shopValue = sklText(el("sklAddShop") && el("sklAddShop").value);
      if (shopValue) {
        const hit = found.candidates.find(function (candidate) { return sklText(candidate.shopId) === shopValue; });
        if (!hit) {
          setAddMsg("店铺SKU「" + shopSku + "」命中的在线产品不属于所选店铺账户，已阻止提交");
          return;
        }
        product = hit;
      }

      // ③ 提交绑定
      const name = sklText(el("sklAddItemName") && el("sklAddItemName").value) || sklText(product.name);
      const qty = sklText(el("sklAddItemQty") && el("sklAddItemQty").value) || "1";
      const note = (name ? name + " x" + qty : "x" + qty).slice(0, 255);
      const result = await apiRequest("/api/pdev-links", {
        method: "POST",
        body: JSON.stringify({ pdevSku: pdevSku, onlineProductId: sklText(product.id), note: note })
      });
      if (result && result.ok) {
        // 【task-11】新增成功的处理有两处变化（用户明确要求）：
        //   ① 成功信息写进新增弹窗内部（底部按钮上方），不再写列表上方的 #sklPageMsg；
        //   ② 弹窗不再自动关闭，用户能直接看到这行「绑定信息」。
        // 其余行为不变：清空新增表单、刷新列表（新记录出现在表格里）。
        const createdId = sklText(result.data && result.data.id) || "-";
        resetAddForm();                       // 会清掉绑定信息，所以下面再写入本次成功信息
        setAddBindingInfo(
          "商品SKU：" + pdevSku + " ↔ 店铺SKU：" + shopSku +
          "（绑定 id " + createdId + "，创建人 " + currentUserName() + "）"
        );
        await loadLinks();
        refreshSharedSkuIndex();              // 【task-27】新增绑定成功 → 订单/产品列表的映射立刻生效
        return;
      }
      const status = result ? result.status : 0;
      if (status === 409) setAddMsg("这对关系已经绑定过了");
      else if (status === 403) setAddMsg("当前账号没有维护 SKU 关系的权限");
      else setAddMsg((result && result.error) ? String(result.error) : "新增失败，请稍后重试");
    } catch (error) {
      setAddMsg("新增失败：" + String((error && error.message) || error));
    } finally {
      addSubmitting = false;
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  // ==================================================================
  // 【task-10】③ 顶部「删除」按钮：勾选哪条删哪条（真删数据，务必谨慎）
  //
  // 语义与安全约束：
  //   · 只删「当前页被勾选的行」：目标来自 tbody 里 .skl-row-check:checked 的 data-id，
  //     绝不按筛选条件批量删、绝不隐式删除未勾选的记录（用户那条只有在被显式勾选时才会进目标）。
  //   · 没勾选 → 只提示「请先勾选要删除的关系」，不发任何写请求。
  //   · 有勾选 → confirm 二次确认，文案逐条列出「店铺SKU / 商品SKU（绑定 id）」让人看清删什么。
  //   · 逐条 DELETE /api/pdev-links/:id：单条失败不中断，其余继续删，最后汇总成功/失败条数与失败明细。
  //   · 整段包在 try/catch 里，任何异常都转成页面提示，不抛未捕获异常。
  //   · 原先操作列的行内「解绑」已按本任务要求移除，删除能力集中到这里（同一个 DELETE 接口）。
  // ==================================================================
  let deleteBusy = false;

  function selectedLinkTargets() {
    const tbody = el("skuLinksTableBody");
    if (!tbody) return [];
    const boxes = tbody.querySelectorAll(".skl-row-check");
    const targets = [];
    Array.prototype.forEach.call(boxes, function (box) {
      if (!box.checked) return;
      const id = sklText(box.getAttribute("data-id"));
      if (!id) return;
      const item = findLinkItemById(id);
      targets.push({
        id: id,
        label: "店铺SKU " + linkShopSku(item || {}) + " / 商品SKU " + (sklText(item && item.pdevSku) || "-") + "（绑定 id " + id + "）"
      });
    });
    return targets;
  }

  async function deleteSelected() {
    if (deleteBusy) return;
    const button = el("sklDeleteBtn");
    const targets = selectedLinkTargets();
    if (!targets.length) {                      // 没勾选：只提示，绝不写库
      setPageMsg("err", "请先勾选要删除的关系");
      return;
    }
    const lines = targets.map(function (target, index) { return (index + 1) + ". " + target.label; });
    const confirmed = typeof confirm !== "function" || confirm(
      "确认删除以下 " + targets.length + " 条 SKU 关系？此操作不可撤销。\n\n" + lines.join("\n")
    );
    if (!confirmed) {
      setPageMsg("", "已取消，未删除任何关系");
      return;
    }
    deleteBusy = true;
    if (button) button.disabled = true;
    const failed = [];
    let removed = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        try {
          const result = await apiRequest("/api/pdev-links/" + encodeURIComponent(target.id), { method: "DELETE" });
          if (result && result.ok) removed += 1;
          else failed.push(target.label + "：" + ((result && result.error) ? String(result.error) : "删除失败"));
        } catch (error) {
          failed.push(target.label + "：" + String((error && error.message) || error));
        }
      }
    } finally {
      deleteBusy = false;
      if (button) button.disabled = false;
    }
    try {
      await loadLinks();                        // 重新拉列表（勾选状态随重渲染清空）
    } catch (error) {
      // 刷新失败不影响删除结果提示
    }
    if (removed > 0) refreshSharedSkuIndex();   // 【task-27】解绑成功 → 让订单/产品列表的映射立刻失效/更新
    if (!failed.length) {
      setPageMsg("ok", "已删除 " + removed + " 条关系");
      return;
    }
    setPageMsg("err", "已删除 " + removed + " 条，失败 " + failed.length + " 条 —— " + failed.join("；"));
  }

  // ==================================================================
  // 【task-9】操作列「编辑」「日志」
  //
  // 只读侦察结论（本次真实请求实测，不是猜；样例见汇报）：
  //   · 日志接口存在：GET /api/audit-logs（backend/routes/audit.js:15，需要 audit.read 权限，
  //     admin2 实测 200）。服务端过滤参数只有 username / actionType / path / statusCode /
  //     dateFrom / dateTo / page / pageSize（backend/order-filters.js:133 filterAuditLogs）。
  //     **没有 resourceType / resourceId 过滤**：实测 ?resourceId=PL-34DC28B716DAB7A2 返回的条数
  //     与不传该参数完全一致（都被静默忽略）。
  //     但 **path 是子串过滤且真的生效**：?path=/api/pdev-links 实测把 707 条全量日志收敛到 200 条，
  //     且这 200 条的 resourceType 全是 pdev_link —— 所以先用它把范围缩小，再在客户端按
  //     resourceId === 本条绑定 id 过滤。
  //     pageSize 上限 200（backend/pagination.js:14），items 按插入顺序（旧→新）返回，故客户端按 ts 倒序。
  //   · 每条绑定的归属：创建 / 解绑的审计带 resourceId = 绑定 id（pdev-links.js:105 / :130）；
  //     但「列表查看」（GET /api/pdev-links）的审计 resourceId 是空串（pdev-links.js:53 没有 resourceId），
  //     无法归属到某一条绑定 —— 所以弹窗只列能归属到本条 id 的记录，并在弹窗底部说明这个局限。
  //   · 编辑能力：后端只有 GET/POST /api/pdev-links、DELETE /api/pdev-links/:id（pdev-links.js），
  //     **没有 PATCH/PUT**；POST 的语义是「商品SKU ↔ 在线产品 id」这一对（唯一键 uk_pdev_online）。
  //
  // 因此编辑的语义取舍（安全第一）：
  //   ① 改了「绑定的另一方」（店铺SKU 或 商品SKU）→ 「先 POST 建新的，201 成功后才 DELETE 旧的」。
  //      409（这对已存在）/ 403 / 404 / 其它失败 → 一律不碰旧记录，只提示。
  //      DELETE 旧记录失败 → 新的已建成、旧的还在（两条并存，不丢数据），并提示旧 id 让人工删除。
  //   ② 只改备注 → 后端没有 PATCH，**不做「删了再建」**（会短暂丢数据，且 id / 创建人 / 创建时间 /
  //      审计链都会变）。弹窗把备注设为只读并明确告知「备注暂不支持修改」，保持原值。
  // ==================================================================
  const AUDIT_LOG_PATH_FILTER = "/api/pdev-links";
  const AUDIT_LOG_PAGE_SIZE = 200;
  const AUDIT_LOG_MAX_PAGES = 10;   // 防御性上限：即使以后 pdev_link 日志暴涨也不会打死浏览器

  function findLinkItemById(id) {
    const wanted = sklText(id);
    if (!wanted) return null;
    return linksState.items.find(function (item) { return sklText(item && item.id) === wanted; }) || null;
  }

  // ---------- 编辑弹窗 ----------
  const editState = { id: "", item: null, submitting: false };

  function setEditMsg(message) {
    const box = el("sklEditModalMsg");
    if (!box) return;
    box.textContent = message || "";
    box.className = "skl-modal-msg" + (message ? "" : " hidden");
  }

  function setText(id, value) {
    const node = el(id);
    if (node) node.textContent = value === null || value === undefined || value === "" ? "-" : String(value);
  }

  function openEditModal(id) {
    const item = findLinkItemById(id);
    if (!item) { setPageMsg("err", "找不到这条绑定关系，请刷新后重试"); return; }
    editState.id = sklText(item.id);
    editState.item = item;
    const shopSkuInput = el("sklEditShopSku");
    if (shopSkuInput) shopSkuInput.value = linkShopSku(item) === "-" ? "" : linkShopSku(item);
    const itemSkuInput = el("sklEditItemSku");
    if (itemSkuInput) itemSkuInput.value = sklText(item.pdevSku);
    const noteInput = el("sklEditNote");           // 只读：后端没有 PATCH，保持原值
    if (noteInput) noteInput.value = sklText(item.note) || "（无备注）";
    setText("sklEditProviderText", providerText(item.provider));
    setText("sklEditShopText", sklText(item.shopName) || "-");
    setEditMsg("");
    const mask = el("sklEditModalMask");
    if (mask) mask.classList.remove("hidden");
  }

  function closeEditModal() {
    const mask = el("sklEditModalMask");
    if (mask) mask.classList.add("hidden");
    editState.id = "";
    editState.item = null;
  }

  async function submitEdit() {
    if (editState.submitting) return;
    const item = editState.item;
    if (!item) { setEditMsg("没有可编辑的记录，请关闭后重新点「编辑」"); return; }
    const oldId = sklText(item.id);
    const oldPdevSku = sklText(item.pdevSku);
    const oldShopSkuText = linkShopSku(item);
    const newPdevSku = sklText(el("sklEditItemSku") && el("sklEditItemSku").value);
    const newShopSku = sklText(el("sklEditShopSku") && el("sklEditShopSku").value);
    setEditMsg("");
    if (!newPdevSku && !newShopSku) { setEditMsg("请填写商品SKU 与 店铺SKU"); return; }
    if (!newPdevSku) { setEditMsg("请填写商品SKU"); return; }
    if (!newShopSku) { setEditMsg("请填写店铺SKU"); return; }

    const confirmBtn = el("sklEditConfirm");
    editState.submitting = true;
    if (confirmBtn) confirmBtn.disabled = true;
    try {
      // ① 店铺SKU → 在线产品。
      //    ⚠️ 事故教训（本任务实测踩到过）：**店铺SKU 文本没变时绝不能重新解析在线产品**。
      //    库里有大量「不同店铺共用同一个 offerId」的在线产品（实测 offerId=235279001 至少命中
      //    PRD-MN1NILSE-D4DB 与 PRD-MN1NIGAI-F586 两条、分属不同店铺），重新解析会解析到另一条，
      //    导致「什么都没改」却被判定成换绑。所以：文本没变 → 直接沿用记录里的 onlineProductId。
      const shopSkuUnchanged = newShopSku.toLowerCase() === oldShopSkuText.toLowerCase();
      let newOnlineProductId = sklText(item.onlineProductId);
      let resolvedNote = "";
      if (!shopSkuUnchanged) {
        await ensureOnlineProducts();
        const found = findOnlineProducts(newShopSku);
        if (!found.candidates.length) {
          setEditMsg("未找到店铺SKU「" + newShopSku + "」对应的在线产品，未做任何修改");
          return;
        }
        // 同名候选可能跨店铺：优先取与当前记录同一个店铺的那条，避免绑到别的店
        const chosen = found.candidates.find(function (candidate) {
          return sklText(candidate.shopId) === sklText(item.shopId);
        }) || found.candidates[0];
        newOnlineProductId = sklText(chosen.id);
        resolvedNote = "\n解析到的在线产品：" + newOnlineProductId +
          "（" + (sklText(chosen.shopName) || "-") + " / " + providerText(chosen.provider) + "）" +
          (found.candidates.length > 1 ? "\n注意：店铺SKU「" + newShopSku + "」命中 " + found.candidates.length + " 条同名在线产品，已选与当前记录同店铺的那条。" : "");
      }
      const pairChanged = newPdevSku.toLowerCase() !== oldPdevSku.toLowerCase()
        || newOnlineProductId !== sklText(item.onlineProductId);
      if (!pairChanged) {
        // 只动了备注（字段只读，实际改不了）或什么都没改：绝不用「删了再建」
        setEditMsg("没有检测到需要保存的修改。备注暂不支持修改：后端没有 PATCH 接口，为避免「删了再建」造成数据短暂丢失，本次未做任何改动。");
        return;
      }
      const confirmed = typeof confirm !== "function" || confirm(
        "确认修改这条 SKU 绑定？\n\n" +
        "商品SKU：" + (oldPdevSku || "-") + " → " + newPdevSku + "\n" +
        "店铺SKU：" + oldShopSkuText + " → " + newShopSku + resolvedNote + "\n\n" +
        "将先创建新绑定，成功后再删除旧记录（旧 id " + oldId + "）。\n" +
        "若创建失败，旧记录保持不动。备注沿用原值（暂不支持修改）。"
      );
      if (!confirmed) { setEditMsg("已取消，未做任何修改"); return; }

      // ② 先建新的（失败则旧记录原封不动）
      const note = sklText(item.note);
      const created = await apiRequest("/api/pdev-links", {
        method: "POST",
        body: JSON.stringify({ pdevSku: newPdevSku, onlineProductId: newOnlineProductId, note: note || undefined })
      });
      if (!created || !created.ok) {
        const status = created ? created.status : 0;
        if (status === 409) {
          setEditMsg("这对关系（商品SKU " + newPdevSku + " ↔ 店铺SKU " + newShopSku + "）已经绑定过了，未做任何修改，旧记录保留。");
        } else if (status === 403) {
          setEditMsg("当前账号没有维护 SKU 关系的权限，未做任何修改，旧记录保留。");
        } else {
          setEditMsg("创建新绑定失败：" + ((created && created.error) ? String(created.error) : "未知错误") + "。旧记录未改动。");
        }
        return;
      }
      const newId = sklText(created.data && created.data.id);

      // ③ 新记录已成功创建 → 再删旧的
      const removed = await apiRequest("/api/pdev-links/" + encodeURIComponent(oldId), { method: "DELETE" });
      if (!removed || !removed.ok) {
        setEditMsg("新绑定已创建（新 id " + newId + "），但旧记录（id " + oldId + "）删除失败：" +
          ((removed && removed.error) ? String(removed.error) : "未知错误") +
          "。数据没有丢失，请在列表里勾选旧记录后用顶部「删除」重试。");
        setPageMsg("err", "换绑部分完成：新绑定 " + newId + " 已建立，旧记录 " + oldId + " 仍在，请用顶部「删除」手动清理");
        await loadLinks();
        refreshSharedSkuIndex();              // 【task-27】新绑定已建立（旧记录待清理）→ 映射也要立刻生效
        return;
      }
      closeEditModal();
      setPageMsg("ok", "已换绑：商品SKU " + newPdevSku + " ↔ 店铺SKU " + newShopSku + "（旧记录 " + oldId + " 已删除，新 id " + newId + "）");
      await loadLinks();
      refreshSharedSkuIndex();                // 【task-27】换绑成功（先建后删）→ 映射立刻生效
    } catch (error) {
      setEditMsg("修改失败：" + String((error && error.message) || error) + "（旧记录未被主动删除）");
    } finally {
      editState.submitting = false;
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  // ==================================================================
  // 【task-12】日志弹窗：按参考图改成 `# / 内容 / 操作人名称 / 创建时间` + 底部客户端分页条
  //
  // 数据来源（只读侦察结论，实测非猜测）：
  //   · GET /api/audit-logs?path=/api/pdev-links（服务端 path 子串过滤有效；无 resourceId 过滤）。
  //   · pdev_link 的审计行**没有请求体**：实测 requestBodyMasked / responseBodyMasked 全为 null、
  //     query 全为 {}，唯一能与绑定关联的字段是 resourceId（create/delete 会写，read 是空串）。
  //   · 所以「平台SKU / 系统SKU / 店铺 / 数量」只能靠 resourceId → 绑定信息解析：
  //     ① 当前点开的那条（logState.item）；② 本次会话见过的绑定快照 bindingCache；
  //     ③ 仍拿不到 → 按任务要求写 `-`（删除类记录对应的绑定可能已不存在，属正常，不抛异常）。
  //   · 【task-13 修正】本表**只列当前打开这条绑定自己的记录**：resourceId 与绑定 id 严格相等
  //     （忽略大小写与首尾空白）。不再为了「让分页有内容」放宽成「全部写操作」—— 参考图里某条绑定的
  //     日志就只有属于它的记录。仍然排除「查看」(read/GET)：它们不带 resourceId，本来就归不到单条绑定。
  //   · 排序按时间倒序；底部保留客户端分页（共 N 条 = 该绑定自身的记录数），1 页时上一页/下一页禁用；
  //     该绑定没有任何可归属记录时显示「暂无日志」。
  // ==================================================================
  const logState = { id: "", item: null, seq: 0, logs: [], page: 1, pageSize: 10 };
  const LOG_PAGE_SIZES = [10, 20, 50];
  // 会话内见过的绑定快照：绑定被删除后仍能解析出历史日志的明细（仅当前会话）
  const bindingCache = new Map();

  function rememberBindings(items) {
    (Array.isArray(items) ? items : []).forEach(function (item) {
      const id = sklText(item && item.id);
      if (id) bindingCache.set(id, item);
    });
  }

  // 创建时间：YYYY-MM-DD HH:mm:ss（本地时区，参考图格式）
  function logStampText(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    const pad = function (n) { return n < 10 ? "0" + n : String(n); };
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
      " " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
  }

  // 内容第一行：动作标题
  function logActionTitle(log) {
    const method = sklText(log && log.method).toUpperCase();
    const action = sklText(log && log.actionType).toLowerCase();
    if (method === "POST" || action === "create") return "新增 SKU 映射关系：";
    if (method === "DELETE" || action === "delete") return "删除 SKU 映射关系：";
    if (method === "PUT" || method === "PATCH" || action === "update") return "修改 SKU 映射关系：";
    if (method === "GET" || action === "read") return "查看 SKU 映射关系：";
    return "操作：";
  }

  // 该条日志能关联到的绑定（找不到 → null）
  function resolveLogBinding(log) {
    const id = sklText(log && log.resourceId);
    if (!id) return null;
    if (logState.item && id === sklText(logState.item.id)) return logState.item;
    return bindingCache.get(id) || null;
  }

  // 内容第二行：平台SKU / 系统SKU / 店铺 / 数量 / 创建人（取不到一律 -；数量沿用 note 的 xN 解析，默认 1）
  function logDetailText(log) {
    const binding = resolveLogBinding(log);
    const actor = sklText(log && log.actorUsername) || "-";
    const shopSku = binding ? linkShopSku(binding) : "-";
    const pdevSku = binding ? (sklText(binding.pdevSku) || "-") : "-";
    const shopName = binding ? (sklText(binding.shopName) || "-") : "-";
    let qty = 1;
    if (binding) {
      const parsed = parseNoteQuantity(binding.note);
      if (parsed && parsed.qty) qty = parsed.qty;
    }
    return "平台SKU: " + shopSku + ";系统SKU: " + pdevSku + ";店铺: " + shopName +
      ";数量: " + qty + ";创建人: " + actor + ";";
  }

  // 【task-12】# / 内容（两行）/ 操作人名称 / 创建时间；startIndex = 本页首条在整批数据里的下标（序号从 1 连续）
  function renderLogRows(logs, emptyText, startIndex) {
    const tbody = el("sklLogTableBody");
    if (!tbody) return;
    tbody.textContent = "";
    const list = Array.isArray(logs) ? logs : [];
    if (!list.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.className = "skl-log-empty";
      td.textContent = emptyText || "暂无日志";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    const base = Number(startIndex) || 0;
    list.forEach(function (log, index) {
      const tr = document.createElement("tr");
      const tdSeq = document.createElement("td");
      tdSeq.className = "skl-log-cell-seq";
      tdSeq.textContent = String(base + index + 1);
      const tdContent = document.createElement("td");
      tdContent.className = "skl-log-cell-content";
      const line1 = document.createElement("div");
      line1.className = "skl-log-line1";
      line1.textContent = logActionTitle(log);
      const line2 = document.createElement("div");
      line2.className = "skl-log-line2";
      line2.textContent = logDetailText(log);
      tdContent.appendChild(line1);
      tdContent.appendChild(line2);
      const tdActor = document.createElement("td");
      tdActor.className = "skl-log-cell-actor";
      tdActor.textContent = sklText(log && log.actorUsername) || "-";
      const tdTime = document.createElement("td");
      tdTime.className = "skl-log-cell-time";
      tdTime.textContent = logStampText(log && log.ts);
      tr.appendChild(tdSeq);
      tr.appendChild(tdContent);
      tr.appendChild(tdActor);
      tr.appendChild(tdTime);
      tbody.appendChild(tr);
    });
  }

  function setLogStatus(text) {
    const node = el("sklLogStatus");
    if (node) node.textContent = text || "";
  }

  // 拉「当前这条绑定自己的」审计日志（【task-13】严格按 resourceId 过滤）。
  // 分页说明：paginateItems 会把 page 夹到 [1, totalPages] 且 items 按插入顺序（旧→新），第 1 页是最旧的，
  // 所以必须真的按 totalPages 翻页才能拿全（并设了最大页数防御）。
  async function fetchLinkAuditLogs(linkId) {
    const wanted = sklText(linkId).toLowerCase();   // 严格相等，忽略大小写与首尾空白
    const collected = [];
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages && page <= AUDIT_LOG_MAX_PAGES) {
      const result = await apiRequest(
        "/api/audit-logs?path=" + encodeURIComponent(AUDIT_LOG_PATH_FILTER) +
        "&pageSize=" + AUDIT_LOG_PAGE_SIZE + "&page=" + page,
        { method: "GET" }
      );
      if (!result || !result.ok || !result.data || !Array.isArray(result.data.items)) {
        if (page === 1) throw new Error((result && result.error) ? String(result.error) : "日志加载失败");
        break;
      }
      const items = result.data.items;
      items.forEach(function (log) {
        if (sklText(log && log.resourceType) !== "pdev_link") return;
        // 【task-13】只保留「这一条绑定自己」的记录（严格相等，忽略大小写与首尾空白）
        if (sklText(log && log.resourceId).toLowerCase() !== wanted) return;
        if (sklText(log && log.actionType).toLowerCase() === "read") return;   // 「查看」不列（不带绑定 id）
        if (sklText(log && log.method).toUpperCase() === "GET") return;
        collected.push(log);
      });
      const pagination = (result.data && result.data.pagination) || {};
      totalPages = Math.max(1, Number(pagination.totalPages) || 1);
      if (!items.length) break;
      page += 1;
    }
    collected.sort(function (a, b) {
      return new Date((b && b.ts) || 0).getTime() - new Date((a && a.ts) || 0).getTime();   // 时间倒序
    });
    return collected;
  }

  // ---------- 【task-12】客户端分页（数据已整批在 logState.logs，翻页只重渲染，不重新请求、不丢数据） ----------
  function logPageCount() {
    return Math.max(1, Math.ceil(logState.logs.length / logState.pageSize));
  }

  // 页码按钮：总页数 ≤ 7 全列出；否则 1 … 当前±1 … 末页
  function logPageNumbers(totalPages) {
    const out = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) out.push(i);
      return out;
    }
    const candidates = [1, logState.page - 1, logState.page, logState.page + 1, totalPages].filter(function (n) {
      return n >= 1 && n <= totalPages;
    });
    const unique = [];
    candidates.forEach(function (n) { if (unique.indexOf(n) < 0) unique.push(n); });
    unique.sort(function (a, b) { return a - b; });
    unique.forEach(function (n, i) {
      if (i > 0 && n - unique[i - 1] > 1) out.push("...");
      out.push(n);
    });
    return out;
  }

  function renderLogPager() {
    const totalPages = logPageCount();
    if (logState.page > totalPages) logState.page = totalPages;
    if (logState.page < 1) logState.page = 1;
    const totalNode = el("sklLogTotal");
    if (totalNode) totalNode.textContent = "共 " + logState.logs.length + " 条";
    const prev = el("sklLogPrev");
    if (prev) prev.disabled = logState.page <= 1;
    const next = el("sklLogNext");
    if (next) next.disabled = logState.page >= totalPages;
    const pagesNode = el("sklLogPages");
    if (pagesNode) {
      pagesNode.textContent = "";
      logPageNumbers(totalPages).forEach(function (num) {
        if (num === "...") {
          const gap = document.createElement("span");
          gap.className = "skl-log-pagegap";
          gap.textContent = "…";
          pagesNode.appendChild(gap);
          return;
        }
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "skl-log-pagenum" + (num === logState.page ? " active" : "");
        btn.setAttribute("data-skl-log-page", String(num));
        btn.textContent = String(num);
        pagesNode.appendChild(btn);
      });
    }
    const jump = el("sklLogJump");
    if (jump) {
      jump.max = String(totalPages);
      jump.value = String(logState.page);
    }
  }

  function renderLogPage() {
    const totalPages = logPageCount();
    if (logState.page > totalPages) logState.page = totalPages;
    if (logState.page < 1) logState.page = 1;
    const start = (logState.page - 1) * logState.pageSize;
    renderLogRows(logState.logs.slice(start, start + logState.pageSize), "暂无日志", start);
    renderLogPager();
    setLogStatus("");            // 渲染成功即清掉「加载中…」/上一次的失败提示
  }

  function setLogPage(page) {
    const totalPages = logPageCount();
    const wanted = Number(page);
    logState.page = Number.isFinite(wanted) ? Math.min(Math.max(1, Math.floor(wanted)), totalPages) : 1;
    renderLogPage();
    setLogStatus("");
  }

  async function openLogModal(id) {
    const item = findLinkItemById(id);
    if (!item) { setPageMsg("err", "找不到这条绑定关系，请刷新后重试"); return; }
    const linkId = sklText(item.id);
    const seq = ++logState.seq;
    logState.id = linkId;
    logState.item = item;
    logState.logs = [];                     // 新一次查询：整批数据先清空，避免串数据
    logState.page = 1;
    const sizeSelect = el("sklLogPageSize");
    const wantedSize = Number(sizeSelect && sizeSelect.value);
    logState.pageSize = LOG_PAGE_SIZES.indexOf(wantedSize) >= 0 ? wantedSize : 10;
    const meta = el("sklLogMeta");
    if (meta) {
      meta.textContent = "当前绑定：商品SKU " + (sklText(item.pdevSku) || "-") + " ↔ 店铺SKU " + linkShopSku(item) +
        "（id " + linkId + "，创建人 " + (sklText(item.createdBy) || "-") + "）";
    }
    const hint = el("sklLogHint");
    if (hint) {
      hint.textContent = "说明：仅显示该绑定自身的操作记录（按时间倒序；读取类记录不列出）。" +
        "明细中的平台SKU / 系统SKU / 店铺 / 数量来自该次操作对应的绑定记录，绑定点已被删除时显示 -；" +
        "后端审计不保存请求体，取不到明细时一律以 - 兜底。";
    }
    renderLogRows([], "加载中…", 0);
    renderLogPager();
    setLogStatus("加载中…");
    const mask = el("sklLogModalMask");
    if (mask) mask.classList.remove("hidden");
    try {
      const logs = await fetchLinkAuditLogs(linkId);
      if (seq !== logState.seq) return;                    // 期间又打开了别的绑定 / 已关闭
      logState.logs = logs;
      renderLogPage();
      if (!logs.length) {
        renderLogRows([], "暂无日志", 0);
        setLogStatus("该绑定暂无操作日志");
      }
    } catch (error) {
      if (seq !== logState.seq) return;
      logState.logs = [];
      renderLogPage();
      setLogStatus("日志加载失败：" + String((error && error.message) || error));
    }
  }

  function closeLogModal() {
    const mask = el("sklLogModalMask");
    if (mask) mask.classList.add("hidden");
    logState.seq += 1;      // 让进行中的请求结果失效
    logState.id = "";
    logState.item = null;
  }

  // 【task-12】分页条交互：每页条数下拉 / 页码输入框回车、失焦
  // （上一页、下一页、页码按钮走下面的 document click 委托）
  document.addEventListener("change", function (event) {
    const target = event.target;
    if (!target || target.id !== "sklLogPageSize") return;
    const size = Number(target.value);
    logState.pageSize = LOG_PAGE_SIZES.indexOf(size) >= 0 ? size : 10;
    logState.page = 1;
    renderLogPage();
  });

  document.addEventListener("keydown", function (event) {
    const target = event.target;
    if (!target || target.id !== "sklLogJump" || event.key !== "Enter") return;
    event.preventDefault();
    setLogPage(target.value);
  });

  document.addEventListener("focusout", function (event) {
    const target = event.target;
    if (!target || target.id !== "sklLogJump") return;
    setLogPage(target.value);
  }, true);

  // ==================================================================
  // 【task-18】导入弹窗（照参考图：三模式 + 步骤1 下载模板 / 步骤2 上传文件 + 筛选 + 历史表格 + 分页条）
  //
  // 本阶段范围与取舍：
  //   · 历史记录需要后端记账（文件/创建人/状态/进度/失败原因/时间），本阶段**没有数据源**，
  //     所以表格只渲染空态「暂无记录」；但 7 列结构、行模板（展开链接 / 进度环 / 两行操作时间 /
  //     点击下载文件）与分页条都已按参考图实现，第二阶段接上后端记账即可直接出数。
  //   · 「下载模板」优先调后端只读接口 GET /api/pdev-links/import-template 拿**真 .xlsx**
  //     （复用项目已有 xlsx 依赖）；接口不可用（例如服务未重启）时自动退化为前端生成 UTF-8 带 BOM 的 CSV。
  //   · 「上传文件」真调 POST /api/uploads（base64 dataUrl）；后端已放开 xlsx/xls/csv。
  //   · 三种模式目前共用同一套模板列，仅切换视觉选中态（不同模式的导入解析留到第二阶段）。
  // ==================================================================
  const IMPORT_TEMPLATE_HEADERS = ["店铺SKU", "商品SKU", "店铺账户", "店铺ID", "数量", "备注"];   // 【task-22】加「店铺ID」列
  const IMPORT_ALLOWED_EXT = /\.(xlsx|xls|csv)$/i;
  const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
  const IMPORT_MAX_ROWS = 5000;
  const importState = { mode: "single", rows: [], page: 1, pageSize: 10, total: 0, totalPages: 1, loading: false };

  const IMPORT_MODE_LABELS = { single: "单品映射", systemCombo: "系统组合映射", selfCombo: "自配对组合映射" };

  function importModeLabel() {
    return IMPORT_MODE_LABELS[importState.mode] || IMPORT_MODE_LABELS.single;
  }

  function setImportMsg(kind, message) {
    const box = el("sklImportMsg");
    if (!box) return;
    box.textContent = message || "";
    box.className = "skl-import-msg" + (kind ? " " + kind : "") + (message ? "" : " hidden");
  }

  function openImportModal() {
    importState.page = 1;
    setImportMsg("", "");
    importState.rows = [];
    renderImportRows("加载中…");
    renderImportPager();
    const mask = el("sklImportModalMask");
    if (mask) mask.classList.remove("hidden");
    loadImportFiles();                 // 【task-19】打开即加载第一页
  }

  function closeImportModal() {
    const mask = el("sklImportModalMask");
    if (mask) mask.classList.add("hidden");
  }

  // 【task-19】拉导入历史（列表接口：fileName 模糊 + created_at 区间 + 分页）
  async function loadImportFiles() {
    if (importState.loading) return;
    if (typeof apiRequest !== "function") return;
    const params = new URLSearchParams();
    params.set("page", String(importState.page));
    params.set("pageSize", String(importState.pageSize));
    const fileName = sklText(el("sklImportFilterName") && el("sklImportFilterName").value);
    const dateFrom = sklText(el("sklImportFilterFrom") && el("sklImportFilterFrom").value);
    const dateTo = sklText(el("sklImportFilterTo") && el("sklImportFilterTo").value);
    if (fileName) params.set("fileName", fileName);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    importState.loading = true;
    let result = null;
    try {
      result = await apiRequest("/api/pdev-links/import-files?" + params.toString(), { method: "GET" });
    } catch (error) {
      result = null;
    }
    importState.loading = false;
    if (!result || !result.ok || !result.data || !Array.isArray(result.data.items)) {
      importState.rows = [];
      importState.total = 0;
      importState.totalPages = 1;
      renderImportRows("暂无记录");
      renderImportPager();
      setImportMsg("err", "导入记录加载失败" + ((result && result.error) ? "：" + String(result.error) : ""));
      return;
    }
    const pagination = (result.data && result.data.pagination) || {};
    importState.rows = result.data.items;
    importState.total = Number(pagination.total) || importState.rows.length;
    importState.totalPages = Math.max(1, Number(pagination.totalPages) || 1);
    importState.page = Math.max(1, Number(pagination.page) || importState.page);
    renderImportRows("暂无记录");
    renderImportPager();
  }

  // 进度环（参考图是蓝色圆环 + 百分比）；纯展示，无用户数据
  function importRingSvg(percent) {
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    const radius = 9;
    const circumference = 2 * Math.PI * radius;
    const dash = (circumference * pct) / 100;
    return '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">' +
      '<circle cx="12" cy="12" r="' + radius + '" fill="none" stroke="#e6ecf5" stroke-width="3"></circle>' +
      '<circle cx="12" cy="12" r="' + radius + '" fill="none" stroke="#1976f3" stroke-width="3" ' +
      'stroke-dasharray="' + dash.toFixed(2) + ' ' + circumference.toFixed(2) + '" stroke-linecap="round" ' +
      'transform="rotate(-90 12 12)"></circle></svg>';
  }

  // 单行渲染（第二阶段接后端记账后直接复用）
  function buildImportRow(row) {
    const tr = document.createElement("tr");
    // ① 文件名称 + 「展开」小链接
    const tdName = document.createElement("td");
    const nameWrap = document.createElement("span");
    nameWrap.className = "skl-import-name";
    const nameText = document.createElement("span");
    nameText.className = "skl-import-name-text";        // 【task-23】过长省略号 + title 看全名
    nameText.textContent = sklText(row && row.fileName) || "-";
    if (row && row.fileName) nameText.title = String(row.fileName);
    const expandLink = document.createElement("a");
    expandLink.className = "skl-import-link";
    expandLink.setAttribute("role", "button");
    expandLink.setAttribute("tabindex", "0");
    expandLink.setAttribute("data-skl-import-expand", sklText(row && row.id));
    expandLink.setAttribute("aria-expanded", "false");
    expandLink.textContent = "展开";
    nameWrap.appendChild(nameText);
    nameWrap.appendChild(expandLink);
    tdName.appendChild(nameWrap);
    tr.appendChild(tdName);
    // ② 创建人（【task-24】nowrap，避免窄列把 admin2 折成两行）
    const tdUser = buildCell(sklText(row && row.createdBy) || "-");
    tdUser.className = "skl-import-user-cell";
    tr.appendChild(tdUser);
    // ③ 状态（按状态给颜色：【task-19】处理中=蓝、处理成功=绿、处理失败=红）
    const tdStatus = document.createElement("td");
    tdStatus.className = "skl-cell-center skl-import-status-cell";   // 【task-24】nowrap
    const statusSpan = document.createElement("span");
    const statusText = sklText(row && row.status) || "-";
    statusSpan.textContent = statusText;
    if (statusText === "处理成功") statusSpan.className = "skl-import-status-ok";
    else if (statusText === "处理失败") statusSpan.className = "skl-import-status-fail";
    else if (statusText === "处理中") statusSpan.className = "skl-import-status-doing";
    else if (statusText === "部分成功") statusSpan.className = "skl-import-status-partial";   // 【task-20】第三种状态
    tdStatus.appendChild(statusSpan);
    tr.appendChild(tdStatus);
    // ④ 进度：圆环 + 百分比
    const tdProgress = document.createElement("td");
    tdProgress.className = "skl-cell-center skl-import-ring-cell";   // 【task-23】nowrap，避免 100% 折行
    const ringWrap = document.createElement("span");
    ringWrap.className = "skl-import-ring";
    ringWrap.innerHTML = importRingSvg(row && row.progress);   // 固定常量，无用户数据
    const pctText = document.createElement("span");
    pctText.textContent = Math.max(0, Math.min(100, Number(row && row.progress) || 0)) + "%";
    ringWrap.appendChild(pctText);
    tdProgress.appendChild(ringWrap);
    tr.appendChild(tdProgress);
    // ④b 【task-24】「跳过」列（位于 进度 与 失败原因 之间）：显示 skippedRows；老记录没有该列则显示 "-"
    const tdSkip = document.createElement("td");
    tdSkip.className = "skl-cell-center skl-import-skip-cell";
    tdSkip.textContent = row && row.skippedRows == null ? "-" : String(Number(row.skippedRows) || 0);
    tr.appendChild(tdSkip);
    // ⑤ 失败原因（【task-22】没有真实失败时：若有跳过就用中性灰色说明，否则 "-"）
    //    【task-23】② 外层 div 限高 + 内部滚动，title 悬停看全文
    const failReasonText = sklText(row && row.failureReason);
    const skippedCount = row && row.skippedRows != null ? Number(row.skippedRows) || 0 : 0;
    const tdReason = document.createElement("td");
    tdReason.className = "skl-import-reason-cell";
    if (failReasonText) {
      const reasonBox = document.createElement("div");
      reasonBox.className = "skl-import-reason";
      reasonBox.textContent = failReasonText;
      reasonBox.title = failReasonText;
      tdReason.appendChild(reasonBox);
    } else if (skippedCount > 0) {
      const skipSpan = document.createElement("span");
      skipSpan.className = "skl-import-skip-note";
      const newCount = row && row.okRows != null ? Number(row.okRows) || 0 : 0;
      skipSpan.textContent = newCount > 0
        ? "跳过 " + skippedCount + " 行（已存在绑定）"
        : "全部已存在，未新建（跳过 " + skippedCount + " 行）";
      tdReason.appendChild(skipSpan);
    } else {
      tdReason.textContent = "-";
    }
    tr.appendChild(tdReason);
    // ⑥ 操作时间（创建时间 + 完成时间；未完成只显示创建时间）
    const tdTimes = document.createElement("td");
    tdTimes.className = "skl-import-times-cell";   // 【task-24】给时间戳留够内容宽度（左右 padding 收窄）
    const times = document.createElement("div");
    times.className = "skl-import-times";
    const createdLine = document.createElement("div");
    createdLine.textContent = "创建时间: " + logStampText(row && row.createdAt);
    times.appendChild(createdLine);
    if (row && row.finishedAt) {
      const doneLine = document.createElement("div");
      doneLine.textContent = "完成时间: " + logStampText(row.finishedAt);
      times.appendChild(doneLine);
    }
    tdTimes.appendChild(times);
    tr.appendChild(tdTimes);
    // ⑦ 操作：点击下载文件（指向 file_url，新窗口打开）
    const tdAction = document.createElement("td");
    tdAction.className = "skl-cell-center skl-import-action-cell";   // 【task-23】nowrap，避免「删除」折行
    const downloadLink = document.createElement("a");
    downloadLink.className = "skl-import-link";
    downloadLink.setAttribute("role", "button");
    downloadLink.setAttribute("tabindex", "0");
    downloadLink.textContent = "点击下载文件";
    if (row && row.fileUrl) {
      downloadLink.setAttribute("data-skl-import-file", String(row.fileUrl));
      downloadLink.title = String(row.fileUrl);
    } else {
      downloadLink.setAttribute("data-skl-import-file", "");
    }
    tdAction.appendChild(downloadLink);
    // 【task-20】自助删除该条导入历史（两步式：第一次点变「确认删除」，再点才真删；只删历史记录，不动绑定）
    const deleteLink = document.createElement("a");
    deleteLink.className = "skl-import-link skl-import-del";
    deleteLink.setAttribute("role", "button");
    deleteLink.setAttribute("tabindex", "0");
    deleteLink.setAttribute("data-skl-import-delete", sklText(row && row.id));
    deleteLink.textContent = "删除";
    tdAction.appendChild(deleteLink);
    tr.appendChild(tdAction);
    return tr;
  }

  // 【task-20】展开：在该行下面插入一条明细行，显示这条导入记录的逐行失败原因（完整文本）
  function importRowById(id) {
    const wanted = sklText(id);
    return (Array.isArray(importState.rows) ? importState.rows : []).filter(function (r) { return sklText(r && r.id) === wanted; })[0] || null;
  }

  function toggleImportDetail(linkEl) {
    const tr = linkEl && linkEl.closest ? linkEl.closest("tr") : null;
    if (!tr) return;
    const rowId = sklText(linkEl.getAttribute("data-skl-import-expand"));
    const next = tr.nextElementSibling;
    if (next && next.classList && next.classList.contains("skl-import-detail-row")) {
      next.remove();
      linkEl.setAttribute("aria-expanded", "false");
      return;
    }
    const record = importRowById(rowId);
    const detailTr = document.createElement("tr");
    detailTr.className = "skl-import-detail-row";
    detailTr.setAttribute("data-skl-import-detail-for", rowId);
    const td = document.createElement("td");
    td.className = "skl-import-detail-cell";
    td.colSpan = 8;                              // 【task-24】父表改成 8 列（新增「跳过」列）
    const reason = sklText(record && record.failureReason);
    const skippedDetail = record && record.skippedRows != null ? Number(record.skippedRows) || 0 : 0;
    const okDetail = record && record.okRows != null ? Number(record.okRows) || 0 : 0;
    const summary = "共 " + (record && record.totalRows != null ? record.totalRows : "?") + " 行：新建 " + okDetail + " 条，跳过 " + skippedDetail + " 条（已存在绑定）";
    // 【task-22】有真实失败才叫「失败明细」；只有跳过时用中性说明
    td.textContent = reason
      ? "失败明细（共 " + (record && record.failRows != null ? record.failRows : "?") + " 行失败）：" + reason + "。另有 " + summary
      : (okDetail === 0 && skippedDetail > 0 ? "本次全部已存在，未新建。" + summary : "无失败明细。" + summary);
    detailTr.appendChild(td);
    tr.parentNode.insertBefore(detailTr, tr.nextSibling);
    linkEl.setAttribute("aria-expanded", "true");
  }

  // 【task-20】删除一条导入历史（两步式确认；只删 pdev_import_files 记录）
  async function deleteImportFile(linkEl) {
    const id = sklText(linkEl.getAttribute("data-skl-import-delete"));
    if (!id) return;
    if (linkEl.getAttribute("data-confirm") !== "1") {
      linkEl.setAttribute("data-confirm", "1");
      linkEl.textContent = "确认删除";
      linkEl.title = "再点一次即删除该条导入记录（不会删除任何绑定）";
      return;
    }
    linkEl.textContent = "删除中…";
    let result = null;
    try {
      result = await apiRequest("/api/pdev-links/import-files/" + encodeURIComponent(id), { method: "DELETE" });
    } catch (error) {
      result = null;
    }
    if (!result || !result.ok) {
      setImportMsg("err", "删除导入记录失败：" + ((result && result.error) ? String(result.error) : "未知错误"));
      linkEl.textContent = "删除";
      linkEl.removeAttribute("data-confirm");
      return;
    }
    setImportMsg("ok", "已删除导入记录 " + id);
    await loadImportFiles();
  }

  function renderImportRows(emptyText) {
    const tbody = el("sklImportTableBody");
    if (!tbody) return;
    tbody.textContent = "";
    const rows = Array.isArray(importState.rows) ? importState.rows : [];
    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.className = "skl-import-empty";
      td.colSpan = 8;                            // 【task-24】空态也要覆盖 8 列（否则错位）
      td.textContent = emptyText || "暂无记录";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    // 【task-19】分页改为服务端：importState.rows 就是当前页的数据
    rows.forEach(function (row) { tbody.appendChild(buildImportRow(row)); });
  }

  // 页码按钮：总页数 ≤ 7 全列出；否则 1 … 当前±1 … 末页（与日志弹窗一致）
  function importPageNumbers(totalPages) {
    const out = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) out.push(i);
      return out;
    }
    const candidates = [1, importState.page - 1, importState.page, importState.page + 1, totalPages].filter(function (n) {
      return n >= 1 && n <= totalPages;
    });
    const unique = [];
    candidates.forEach(function (n) { if (unique.indexOf(n) < 0) unique.push(n); });
    unique.sort(function (a, b) { return a - b; });
    unique.forEach(function (n, i) {
      if (i > 0 && n - unique[i - 1] > 1) out.push("...");
      out.push(n);
    });
    return out;
  }

  function renderImportPager() {
    const total = Number(importState.total) || 0;
    const totalPages = Math.max(1, Number(importState.totalPages) || 1);
    if (importState.page > totalPages) importState.page = totalPages;
    if (importState.page < 1) importState.page = 1;
    const totalNode = el("sklImportTotal");
    if (totalNode) totalNode.textContent = "共 " + total + " 条";
    const prev = el("sklImportPrev");
    if (prev) prev.disabled = total === 0 || importState.page <= 1;
    const next = el("sklImportNext");
    if (next) next.disabled = total === 0 || importState.page >= totalPages;
    const pagesNode = el("sklImportPages");
    if (pagesNode) {
      pagesNode.textContent = "";
      importPageNumbers(totalPages).forEach(function (num) {
        if (num === "...") {
          const gap = document.createElement("span");
          gap.className = "skl-log-pagegap";
          gap.textContent = "…";
          pagesNode.appendChild(gap);
          return;
        }
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "skl-log-pagenum" + (num === importState.page ? " active" : "");
        btn.setAttribute("data-skl-import-page", String(num));
        btn.textContent = String(num);
        pagesNode.appendChild(btn);
      });
    }
    const jump = el("sklImportJump");
    if (jump) jump.value = String(importState.page);
  }

  function setImportPage(page) {
    const totalPages = Math.max(1, Number(importState.totalPages) || 1);
    const wanted = Number(page);
    const next = Number.isFinite(wanted) ? Math.min(Math.max(1, Math.floor(wanted)), totalPages) : 1;
    if (next === importState.page && Array.isArray(importState.rows) && importState.rows.length) { renderImportPager(); return; }
    importState.page = next;
    loadImportFiles();
  }

  function resetImportFilters() {
    ["sklImportFilterName", "sklImportFilterFrom", "sklImportFilterTo"].forEach(function (id) {
      const node = el(id);
      if (node) node.value = "";
    });
    importState.page = 1;
    setImportMsg("", "");
    loadImportFiles();
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (link.parentNode) link.parentNode.removeChild(link);
    }, 0);
  }

  function downloadCsvTemplateFallback(reason) {
    const csv = "\uFEFF" + IMPORT_TEMPLATE_HEADERS.join(",") + "\n";
    triggerBlobDownload(new Blob([csv], { type: "text/csv;charset=utf-8" }), "sku-link-import-template.csv");
    setImportMsg(reason, "已下载 CSV 模板 sku-link-import-template.csv（列：" + IMPORT_TEMPLATE_HEADERS.join(" / ") + "）");
  }

  let importTemplateBusy = false;
  async function downloadImportTemplate() {
    if (importTemplateBusy) return;
    importTemplateBusy = true;
    const button = el("sklImportTemplateBtn");
    const originalText = button ? button.textContent : "";
    if (button) button.textContent = "下载中…";
    setImportMsg("", "");
    try {
      const res = await fetch("/api/pdev-links/import-template", { credentials: "same-origin", headers: { Accept: "*/*" } });
      if (!res.ok) {
        // 后端接口不可用（例如模块还没重启）→ 退化为前端 CSV，不让用户点了个没反应的按钮
        downloadCsvTemplateFallback("err");
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const matched = /filename="?([^";]+)"?/i.exec(disposition);
      const isCsv = /csv/i.test(res.headers.get("content-type") || "");
      const filename = matched ? matched[1] : (isCsv ? "sku-link-import-template.csv" : "sku-link-import-template.xlsx");
      triggerBlobDownload(blob, filename);
      setImportMsg("ok", "已下载模板 " + filename + "（" + importModeLabel() + "；列：" + IMPORT_TEMPLATE_HEADERS.join(" / ") + "）");
    } catch (error) {
      downloadCsvTemplateFallback("err");
    } finally {
      importTemplateBusy = false;
      if (button) button.textContent = originalText || "⬇ 下载模板";
    }
  }

  // 上传文件：类型/大小/（CSV）行数校验 → base64 → POST /api/uploads
  let importUploading = false;
  async function uploadImportFile(file) {
    if (importUploading || !file) return;
    const name = String(file.name || "");
    if (!IMPORT_ALLOWED_EXT.test(name)) {
      setImportMsg("err", "只支持 .xlsx / .xls / .csv 文件，当前选择的是「" + (name || "未命名") + "」");
      return;
    }
    if (file.size > IMPORT_MAX_BYTES) {
      setImportMsg("err", "文件超过 5MB 限制（当前 " + (file.size / 1024 / 1024).toFixed(2) + "MB）");
      return;
    }
    importUploading = true;
    const button = el("sklImportUploadBtn");
    const originalText = button ? button.textContent : "";
    if (button) button.textContent = "上传中…";
    try {
      // CSV 能直接数行数（含表头），超过 5000 条先拦下来；xlsx/xls 是二进制，行数校验留到第二阶段（需后端解析）
      if (/\.csv$/i.test(name)) {
        const text = await file.text();
        const lineCount = text.split(/\r?\n/).filter(function (line) { return String(line).trim() !== ""; }).length;
        const dataRows = Math.max(0, lineCount - 1);
        if (dataRows > IMPORT_MAX_ROWS) {
          setImportMsg("err", "CSV 数据行 " + dataRows + " 条，超过最大上传数量 " + IMPORT_MAX_ROWS + " 条，已阻止上传");
          return;
        }
      }
      const dataUrl = await new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result || "")); };
        reader.onerror = function () { reject(new Error("文件读取失败")); };
        reader.readAsDataURL(file);
      });
      const res = await fetch("/api/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ filename: name, dataUrl: dataUrl })
      });
      const data = await res.json().catch(function () { return null; });
      if (!res.ok) {
        setImportMsg("err", "上传失败：" + ((data && data.message) || ("HTTP " + res.status)));
        return;
      }
      const fileUrl = String((data && data.url) || "");
      // 【task-19】上传成功 → 登记一条导入历史（status=处理中、progress=0），然后刷新表格
      let registered = null;
      try {
        registered = await apiRequest("/api/pdev-links/import-files", {
          method: "POST",
          body: JSON.stringify({ fileName: name, fileUrl: fileUrl, importMode: importState.mode })
        });
      } catch (error) {
        registered = null;
      }
      if (!registered || !registered.ok) {
        // 上传成功但登记失败：必须明确说出来，不能让用户以为已登记
        setImportMsg("err", "文件已上传（" + fileUrl + "），但导入记录登记失败：" +
          ((registered && registered.error) ? String(registered.error) : "未知错误") + "，请重试或联系管理员");
        return;
      }
      // 【task-20】登记接口现在是**同步解析入库**，响应里已带最终结果
      const record = (registered.data && registered.data.id) ? registered.data : null;
      const totalRows = record && record.totalRows != null ? record.totalRows : "-";
      const okRows = record && record.okRows != null ? Number(record.okRows) || 0 : 0;
      const failRows = record && record.failRows != null ? Number(record.failRows) || 0 : 0;
      const skippedRows = record && record.skippedRows != null ? Number(record.skippedRows) || 0 : 0;
      // 【task-27】导入真的新建了绑定（ok_rows > 0）→ 让其它页面的映射/预估利润立刻生效
      if (okRows > 0) refreshSharedSkuIndex();
      if (record && record.status === "处理失败") {
        setImportMsg("err", "已上传 " + name + "，导入失败：" + (record.failureReason || "未知原因"));
      } else if (record && record.status === "部分成功") {
        setImportMsg("err", "已上传 " + name + "，导入部分成功：共 " + totalRows + " 行，新建 " + okRows + " 条，失败 " + failRows + " 行" +
          (skippedRows > 0 ? "，跳过 " + skippedRows + " 条（已存在）" : "") + "（点「展开」看逐行原因）");
      } else if (record && record.status === "处理成功") {
        // 【task-22】重复（已存在）不再报失败：用中性口吻，全部重复时说明「未新建」
        setImportMsg("ok", "已上传 " + name + "，导入完成：共 " + totalRows + " 行，新建 " + okRows + " 条" +
          (skippedRows > 0 ? "，跳过 " + skippedRows + " 条（已存在绑定）" : "") +
          (okRows === 0 && skippedRows > 0 ? "；本次全部已存在，未新建" : ""));
      } else {
        setImportMsg("ok", "已上传 " + name + "（" + Math.round((Number(data && data.size) || file.size) / 1024) + " KB），已登记为处理中：" + fileUrl);
      }
      importState.page = 1;               // 新记录在最前 → 回第一页刷新
      await loadImportFiles();
    } catch (error) {
      setImportMsg("err", "上传异常：" + String((error && error.message) || error));
    } finally {
      importUploading = false;
      if (button) button.textContent = originalText || "⬆ 上传文件";
      const input = el("sklImportFileInput");
      if (input) input.value = "";        // 允许再次选择同一个文件
    }
  }

  // ==================================================================
  // 【task-28】导出弹窗（照参考图）：标题 + 必填文件名称 + [导出] + 分隔线 + 筛选行 + 7 列历史表 + 分页条
  //   · 后端 POST /api/pdev-links/export-files 读**全部绑定关系**生成 xlsx（列与导入模板一致 → 可直接再导入）
  //   · 历史列表走 GET /api/pdev-links/export-files（服务端分页/筛选，照导入那份）
  //   · 行模板复用导入那套：进度环 importRingSvg / 时间 logStampText / 失败原因限高 + title / 点击下载文件
  // ==================================================================
  const exportState = { rows: [], page: 1, pageSize: 10, total: 0, totalPages: 1, loading: false };
  let exportRunning = false;

  function setExportMsg(kind, message) {
    const box = el("sklExportMsg");
    if (!box) return;
    box.textContent = message || "";
    box.className = "skl-import-msg" + (kind ? " " + kind : "") + (message ? "" : " hidden");
  }

  function openExportModal() {
    exportState.page = 1;
    setExportMsg("", "");
    resetExportDeleteConfirm();          // 【task-29】打开时不要残留「确认删除」
    const input = el("sklExportFileName");
    if (input) input.value = "";
    exportState.rows = [];
    renderExportRows("加载中…");
    renderExportPager();
    const mask = el("sklExportModalMask");
    if (mask) mask.classList.remove("hidden");
    loadExportFiles();
  }

  function closeExportModal() {
    resetExportDeleteConfirm();          // 【task-29】关闭时复位「确认删除」
    const mask = el("sklExportModalMask");
    if (mask) mask.classList.add("hidden");
  }

  async function loadExportFiles() {
    if (exportState.loading) return;
    if (typeof apiRequest !== "function") return;
    resetExportDeleteConfirm();          // 【task-29】重新加载/切筛选时复位「确认删除」
    const params = new URLSearchParams();
    params.set("page", String(exportState.page));
    params.set("pageSize", String(exportState.pageSize));
    const fileName = sklText(el("sklExportFilterName") && el("sklExportFilterName").value);
    const dateFrom = sklText(el("sklExportFilterFrom") && el("sklExportFilterFrom").value);
    const dateTo = sklText(el("sklExportFilterTo") && el("sklExportFilterTo").value);
    if (fileName) params.set("fileName", fileName);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    exportState.loading = true;
    let result = null;
    try {
      result = await apiRequest("/api/pdev-links/export-files?" + params.toString(), { method: "GET" });
    } catch (error) {
      result = null;
    }
    exportState.loading = false;
    if (!result || !result.ok || !result.data || !Array.isArray(result.data.items)) {
      exportState.rows = [];
      exportState.total = 0;
      exportState.totalPages = 1;
      renderExportRows("暂无记录");
      renderExportPager();
      setExportMsg("err", "导出记录加载失败" + ((result && result.error) ? "：" + String(result.error) : ""));
      return;
    }
    const pagination = (result.data && result.data.pagination) || {};
    exportState.rows = result.data.items;
    exportState.total = Number(pagination.total) || exportState.rows.length;
    exportState.totalPages = Math.max(1, Number(pagination.totalPages) || 1);
    exportState.page = Math.max(1, Number(pagination.page) || exportState.page);
    renderExportRows("暂无记录");
    renderExportPager();
  }

  // 单行渲染：7 列（文件名称+展开 / 创建人 / 状态 / 进度 / 失败原因 / 操作时间 / 操作=点击下载文件）
  function buildExportRow(row) {
    const tr = document.createElement("tr");
    // ① 文件名称 + 「展开」（展开显示失败原因/说明全文）
    const tdName = document.createElement("td");
    const nameWrap = document.createElement("span");
    nameWrap.className = "skl-import-name";
    const nameText = document.createElement("span");
    nameText.className = "skl-import-name-text";
    nameText.textContent = sklText(row && row.fileName) || "-";
    if (row && row.fileName) nameText.title = String(row.fileName);
    const expandLink = document.createElement("a");
    expandLink.className = "skl-import-link";
    expandLink.setAttribute("role", "button");
    expandLink.setAttribute("tabindex", "0");
    expandLink.setAttribute("data-skl-export-expand", sklText(row && row.id));
    expandLink.textContent = "展开";
    nameWrap.appendChild(nameText);
    nameWrap.appendChild(expandLink);
    tdName.appendChild(nameWrap);
    tr.appendChild(tdName);
    // ② 创建人
    const tdUser = buildCell(sklText(row && row.createdBy) || "-");
    tdUser.className = "skl-import-user-cell";
    tr.appendChild(tdUser);
    // ③ 状态
    const tdStatus = document.createElement("td");
    tdStatus.className = "skl-cell-center skl-import-status-cell";
    const statusSpan = document.createElement("span");
    const statusText = sklText(row && row.status) || "-";
    statusSpan.textContent = statusText;
    if (statusText === "处理成功") statusSpan.className = "skl-import-status-ok";
    else if (statusText === "处理失败") statusSpan.className = "skl-import-status-fail";
    else if (statusText === "处理中") statusSpan.className = "skl-import-status-doing";
    else if (statusText === "部分成功") statusSpan.className = "skl-import-status-partial";
    tdStatus.appendChild(statusSpan);
    tr.appendChild(tdStatus);
    // ④ 进度：圆环 + 百分比
    const tdProgress = document.createElement("td");
    tdProgress.className = "skl-cell-center skl-import-ring-cell";
    const ringWrap = document.createElement("span");
    ringWrap.className = "skl-import-ring";
    ringWrap.innerHTML = importRingSvg(row && row.progress);   // 固定常量，无用户数据
    const pctText = document.createElement("span");
    pctText.textContent = Math.max(0, Math.min(100, Number(row && row.progress) || 0)) + "%";
    ringWrap.appendChild(pctText);
    tdProgress.appendChild(ringWrap);
    tr.appendChild(tdProgress);
    // ⑤ 失败原因（导出一般没有；0 条时后端给中性说明）
    const reasonText = sklText(row && row.failureReason);
    const tdReason = document.createElement("td");
    tdReason.className = "skl-import-reason-cell";
    if (reasonText) {
      const reasonBox = document.createElement("div");
      reasonBox.className = "skl-import-reason";
      reasonBox.textContent = reasonText;
      reasonBox.title = reasonText;
      tdReason.appendChild(reasonBox);
    } else {
      tdReason.textContent = "-";
    }
    tr.appendChild(tdReason);
    // ⑥ 操作时间（创建时间 / 完成时间，各自不折行）
    const tdTimes = document.createElement("td");
    tdTimes.className = "skl-import-times-cell";
    const times = document.createElement("div");
    times.className = "skl-import-times";
    const createdLine = document.createElement("div");
    createdLine.textContent = "创建时间: " + logStampText(row && row.createdAt);
    times.appendChild(createdLine);
    if (row && row.finishedAt) {
      const doneLine = document.createElement("div");
      doneLine.textContent = "完成时间: " + logStampText(row.finishedAt);
      times.appendChild(doneLine);
    }
    tdTimes.appendChild(times);
    tr.appendChild(tdTimes);
    // ⑦ 操作：点击下载文件（新窗口打开 file_url）
    const tdAction = document.createElement("td");
    tdAction.className = "skl-cell-center skl-import-action-cell";
    const downloadLink = document.createElement("a");
    downloadLink.className = "skl-import-link";
    downloadLink.setAttribute("role", "button");
    downloadLink.setAttribute("tabindex", "0");
    downloadLink.setAttribute("data-skl-export-file", sklText(row && row.fileUrl));
    downloadLink.textContent = "点击下载文件";
    if (row && row.fileUrl) downloadLink.title = String(row.fileUrl);
    tdAction.appendChild(downloadLink);
    // 【task-29】删除这条导出历史（两步式：第一次点变「确认删除」，再点才真删；不弹原生 confirm）
    //   后端会把该记录自己的导出文件一起删掉（只允许 exports 目录内）
    const exportDelete = document.createElement("a");
    exportDelete.className = "skl-import-link skl-import-del";
    exportDelete.setAttribute("role", "button");
    exportDelete.setAttribute("tabindex", "0");
    exportDelete.setAttribute("data-skl-export-delete", sklText(row && row.id));
    exportDelete.textContent = "删除";
    tdAction.appendChild(exportDelete);
    tr.appendChild(tdAction);
    return tr;
  }

  // 【task-29】「确认删除」状态复位（切筛选/关闭弹窗/点其它地方）
  function resetExportDeleteConfirm() {
    document.querySelectorAll("[data-skl-export-delete]").forEach(function (linkEl) {
      if (linkEl.getAttribute("data-confirm") === "1") {
        linkEl.removeAttribute("data-confirm");
        linkEl.textContent = "删除";
        linkEl.removeAttribute("title");
      }
    });
  }

  // 【task-29】删除一条导出历史（两步式；后端同时删除它自己的导出文件）
  async function deleteExportFile(linkEl) {
    const id = sklText(linkEl.getAttribute("data-skl-export-delete"));
    if (!id) return;
    if (linkEl.getAttribute("data-confirm") !== "1") {
      linkEl.setAttribute("data-confirm", "1");
      linkEl.textContent = "确认删除";
      linkEl.title = "再点一次即删除该条导出记录，并删除它对应的导出文件（不会影响绑定关系）";
      return;
    }
    linkEl.textContent = "删除中…";
    let result = null;
    try {
      result = await apiRequest("/api/pdev-links/export-files/" + encodeURIComponent(id), { method: "DELETE" });
    } catch (error) {
      result = null;
    }
    if (!result || !result.ok) {
      const status = result ? result.status : 0;
      const detail = (result && result.error) ? String(result.error) : "未知错误";
      setExportMsg("err", status === 404 ? ("导出记录不存在（可能已被删除）：" + id) : (status === 403 ? "当前账号没有删除导出记录的权限" : ("删除导出记录失败：" + detail)));
      linkEl.textContent = "删除";
      linkEl.removeAttribute("data-confirm");
      return;
    }
    const data = result.data || {};
    if (data.fileDeleted) {
      setExportMsg("ok", "已删除导出记录 " + id + " 及其导出文件");
    } else {
      setExportMsg("ok", "已删除导出记录 " + id + (data.fileNote ? "（未删除文件：" + String(data.fileNote) + "）" : ""));
    }
    await loadExportFiles();          // 刷新当前页（服务端会把越界页码夹回有效页，与导入一致）
  }

  function renderExportRows(emptyText) {
    const tbody = el("sklExportTableBody");
    if (!tbody) return;
    tbody.textContent = "";
    const rows = Array.isArray(exportState.rows) ? exportState.rows : [];
    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.className = "skl-import-empty";
      td.colSpan = 7;                       // 导出表 7 列
      td.textContent = emptyText || "暂无记录";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    rows.forEach(function (row) { tbody.appendChild(buildExportRow(row)); });
  }

  function renderExportPager() {
    const total = Number(exportState.total) || 0;
    const totalPages = Math.max(1, Number(exportState.totalPages) || 1);
    if (exportState.page > totalPages) exportState.page = totalPages;
    if (exportState.page < 1) exportState.page = 1;
    const totalNode = el("sklExportTotal");
    if (totalNode) totalNode.textContent = "共 " + total + " 条";
    const prev = el("sklExportPrev");
    if (prev) prev.disabled = total === 0 || exportState.page <= 1;
    const next = el("sklExportNext");
    if (next) next.disabled = total === 0 || exportState.page >= totalPages;
    const pagesNode = el("sklExportPages");
    if (pagesNode) {
      pagesNode.textContent = "";
      importPageNumbers(totalPages).forEach(function (num) {
        if (num === "...") {
          const gap = document.createElement("span");
          gap.className = "skl-log-pagegap";
          gap.textContent = "…";
          pagesNode.appendChild(gap);
          return;
        }
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "skl-log-pagenum" + (num === exportState.page ? " active" : "");
        btn.setAttribute("data-skl-export-page", String(num));
        btn.textContent = String(num);
        pagesNode.appendChild(btn);
      });
    }
    const jump = el("sklExportJump");
    if (jump) jump.value = String(exportState.page);
  }

  function setExportPage(page) {
    const totalPages = Math.max(1, Number(exportState.totalPages) || 1);
    const wanted = Number(page);
    const next = Number.isFinite(wanted) ? Math.min(Math.max(1, Math.floor(wanted)), totalPages) : 1;
    if (next === exportState.page && Array.isArray(exportState.rows) && exportState.rows.length) { renderExportPager(); return; }
    exportState.page = next;
    loadExportFiles();
  }

  function resetExportFilters() {
    ["sklExportFilterName", "sklExportFilterFrom", "sklExportFilterTo"].forEach(function (id) {
      const node = el(id);
      if (node) node.value = "";
    });
    exportState.page = 1;
    setExportMsg("", "");
    loadExportFiles();
  }

  // 展开：插入明细行显示这条导出记录的说明/失败原因全文
  function toggleExportDetail(linkEl) {
    const tr = linkEl && linkEl.closest ? linkEl.closest("tr") : null;
    if (!tr) return;
    const next = tr.nextElementSibling;
    if (next && next.classList && next.classList.contains("skl-import-detail-row")) { next.remove(); return; }
    const id = sklText(linkEl.getAttribute("data-skl-export-expand"));
    const record = (Array.isArray(exportState.rows) ? exportState.rows : []).filter(function (r) { return sklText(r && r.id) === id; })[0] || null;
    const detailTr = document.createElement("tr");
    detailTr.className = "skl-import-detail-row";
    const td = document.createElement("td");
    td.className = "skl-import-detail-cell";
    td.colSpan = 7;
    const reason = sklText(record && record.failureReason);
    const totalRows = record && record.totalRows != null ? record.totalRows : "?";
    td.textContent = (reason ? "说明：" + reason + "。" : "无失败明细。") + "共 " + totalRows + " 行（导出文件列：店铺SKU / 商品SKU / 店铺账户 / 店铺ID / 数量 / 备注）";
    detailTr.appendChild(td);
    tr.parentNode.insertBefore(detailTr, tr.nextSibling);
  }

  // 真正执行导出：必填文件名称 → POST → 中性提示 + 刷新历史
  async function runExport() {
    if (exportRunning) return;
    const input = el("sklExportFileName");
    const fileName = sklText(input && input.value);
    if (!fileName) {                                  // 必填校验：只提示、不发请求
      setExportMsg("err", "请先填写文件名称");
      return;
    }
    exportRunning = true;
    const button = el("sklExportRunBtn");
    const originalText = button ? button.textContent : "";
    if (button) button.textContent = "导出中…";
    setExportMsg("", "");
    try {
      const result = await apiRequest("/api/pdev-links/export-files", {
        method: "POST",
        body: JSON.stringify({ fileName: fileName })
      });
      if (!result || !result.ok) {
        setExportMsg("err", "导出失败：" + ((result && result.error) ? String(result.error) : ("HTTP " + ((result && result.status) || 0))));
        return;
      }
      const record = result.data || {};
      const rows = record.totalRows != null ? record.totalRows : "-";
      setExportMsg("ok", "已导出 " + rows + " 条绑定：" + (record.fileName || fileName) + "（点「点击下载文件」下载）");
      exportState.page = 1;                           // 新记录在最前
      await loadExportFiles();
    } catch (error) {
      setExportMsg("err", "导出异常：" + String((error && error.message) || error));
    } finally {
      exportRunning = false;
      if (button) button.textContent = originalText || "导出";
    }
  }

  document.addEventListener("change", function (event) {
    const target = event.target;
    if (!target || target.id !== "sklImportFileInput") return;
    const file = target.files && target.files[0];
    if (file) uploadImportFile(file);
  });

  document.addEventListener("change", function (event) {
    const target = event.target;
    if (!target) return;
    if (target.name === "sklImportMode") {
      importState.mode = String(target.value || "single");                 // 只切换视觉选中态，导入解析留到第二阶段
      return;
    }
    if (target.id === "sklImportPageSize") {
      const size = Number(target.value);
      importState.pageSize = LOG_PAGE_SIZES.indexOf(size) >= 0 ? size : 10;
      importState.page = 1;
      loadImportFiles();
      return;
    }
    // 【task-28】导出历史：每页条数
    if (target.id === "sklExportPageSize") {
      const size = Number(target.value);
      exportState.pageSize = LOG_PAGE_SIZES.indexOf(size) >= 0 ? size : 10;
      exportState.page = 1;
      loadExportFiles();
    }
  });

  document.addEventListener("keydown", function (event) {
    const target = event.target;
    // 【task-28】导出历史：前往第 N 页
    if (target && target.id === "sklExportJump" && event.key === "Enter") {
      event.preventDefault();
      setExportPage(target.value);
      return;
    }
    if (!target || target.id !== "sklImportJump" || event.key !== "Enter") return;
    event.preventDefault();
    setImportPage(target.value);
  });

  document.addEventListener("focusout", function (event) {
    const target = event.target;
    // 【task-28】导出历史：失焦也应用页码
    if (target && target.id === "sklExportJump") { setExportPage(target.value); return; }
    if (!target || target.id !== "sklImportJump") return;
    setImportPage(target.value);
  }, true);

  // ---------- 事件绑定（document 级委托：面板/表格是动态渲染的） ----------
  document.addEventListener("click", function (event) {
    const t = event.target;
    if (!t || !t.closest) return;
    if (t.closest("#sklSearchBtn")) { loadLinks(); return; }
    if (t.closest("#sklResetBtn")) { resetFilters(); loadLinks(); return; }
    if (t.closest("#sklAddConfirm")) { submitAdd(); return; }
    if (t.closest("#sklEditConfirm")) { submitEdit(); return; }      // 【task-9】编辑确认
    if (t.closest("#sklDeleteBtn")) { deleteSelected(); return; }    // 【task-10】③ 批量删除（勾选哪条删哪条）
    // 【task-18】导入弹窗
    if (t.closest("#sklImportBtn")) { openImportModal(); return; }
    if (t.closest("#sklImportTemplateBtn")) { downloadImportTemplate(); return; }
    if (t.closest("#sklImportUploadBtn")) { const fileInput = el("sklImportFileInput"); if (fileInput) fileInput.click(); return; }
    if (t.closest("#sklImportSearchBtn")) { importState.page = 1; setImportMsg("", ""); loadImportFiles(); return; }
    if (t.closest("#sklImportResetBtn")) { resetImportFilters(); return; }
    if (t.closest("#sklImportPrev")) { setImportPage(importState.page - 1); return; }
    if (t.closest("#sklImportNext")) { setImportPage(importState.page + 1); return; }
    const importPageBtn = t.closest("[data-skl-import-page]");
    if (importPageBtn) { setImportPage(Number(importPageBtn.getAttribute("data-skl-import-page"))); return; }
    const importFileLink = t.closest("[data-skl-import-file]");
    if (importFileLink) {                                     // 【task-19】点击下载文件 → 新窗口打开
      const fileUrl = String(importFileLink.getAttribute("data-skl-import-file") || "").trim();
      if (fileUrl) window.open(fileUrl, "_blank");
      return;
    }
    // 【task-20】展开失败明细 / 自助删除导入记录
    const importExpand = t.closest("[data-skl-import-expand]");
    if (importExpand) { toggleImportDetail(importExpand); return; }
    const importDelete = t.closest("[data-skl-import-delete]");
    if (importDelete) { deleteImportFile(importDelete); return; }
    // 【task-28】导出弹窗：打开 / 执行导出 / 筛选 / 重置 / 分页 / 下载 / 展开
    if (t.closest("#sklExportBtn")) { openExportModal(); return; }
    if (t.closest("#sklExportRunBtn")) { runExport(); return; }
    if (t.closest("#sklExportSearchBtn")) { exportState.page = 1; setExportMsg("", ""); loadExportFiles(); return; }
    if (t.closest("#sklExportResetBtn")) { resetExportFilters(); return; }
    if (t.closest("#sklExportPrev")) { setExportPage(exportState.page - 1); return; }
    if (t.closest("#sklExportNext")) { setExportPage(exportState.page + 1); return; }
    const exportPageBtn = t.closest("[data-skl-export-page]");
    if (exportPageBtn) { setExportPage(Number(exportPageBtn.getAttribute("data-skl-export-page"))); return; }
    const exportFileLink = t.closest("[data-skl-export-file]");
    if (exportFileLink) {                                     // 点击下载文件 → 新窗口打开
      const fileUrl = String(exportFileLink.getAttribute("data-skl-export-file") || "").trim();
      if (fileUrl) window.open(fileUrl, "_blank");
      return;
    }
    const exportExpand = t.closest("[data-skl-export-expand]");
    if (exportExpand) { toggleExportDetail(exportExpand); return; }
    const exportDeleteLink = t.closest("[data-skl-export-delete]");
    if (exportDeleteLink) { deleteExportFile(exportDeleteLink); return; }   // 【task-29】两步式删除
    // 【task-12】日志弹窗客户端分页：上一页 / 下一页 / 页码按钮
    if (t.closest("#sklLogPrev")) { setLogPage(logState.page - 1); return; }
    if (t.closest("#sklLogNext")) { setLogPage(logState.page + 1); return; }
    const logPageBtn = t.closest("[data-skl-log-page]");
    if (logPageBtn) { setLogPage(Number(logPageBtn.getAttribute("data-skl-log-page"))); return; }
    // 【task-14】店铺SKU 后面的小蓝图标 → 复制该行店铺SKU（放在展开分支之前，并已 stopPropagation）
    const copyBtn = t.closest("[data-skl-copy]");
    if (copyBtn) { copyShopSku(copyBtn, event); return; }
    const expandArrow = t.closest("[data-skl-expand]");     // 【task-8】行首箭头 → 展开/收起明细
    if (expandArrow) { toggleExpand(expandArrow); return; }
    // 【task-9】操作列：编辑 / 日志（【task-10】② 解绑链接已移除）
    const editLink = t.closest("[data-skl-edit]");
    if (editLink) { openEditModal(editLink.getAttribute("data-id")); return; }
    const logLink = t.closest("[data-skl-logs]");
    if (logLink) { openLogModal(logLink.getAttribute("data-id")); return; }
  });

  // 【task-8】箭头是 role=button，补键盘可达性（Enter / 空格）；【task-9】操作列两个链接同样补上
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
    const t = event.target;
    if (!t || !t.closest) return;
    const expandArrow = t.closest("[data-skl-expand]");
    if (expandArrow) { event.preventDefault(); toggleExpand(expandArrow); return; }
    const editLink = t.closest("[data-skl-edit]");
    if (editLink) { event.preventDefault(); openEditModal(editLink.getAttribute("data-id")); return; }
    const logLink = t.closest("[data-skl-logs]");
    if (logLink) { event.preventDefault(); openLogModal(logLink.getAttribute("data-id")); return; }
  });

  // 表头全选 / 行首复选框
  //   全选框 #sklSelectAll：勾上 = 全选当前列表；再点 = 取消（原生 checkbox 的 change 已带新状态）
  //   【task-10】单个行复选框变动时反过来同步表头框（含 indeterminate「部分选中」）
  function syncSelectAllState() {
    const selectAll = el("sklSelectAll");
    const tbody = el("skuLinksTableBody");
    if (!selectAll || !tbody) return;
    const boxes = tbody.querySelectorAll(".skl-row-check");
    if (!boxes.length) { selectAll.checked = false; selectAll.indeterminate = false; return; }
    let checkedCount = 0;
    Array.prototype.forEach.call(boxes, function (box) { if (box.checked) checkedCount += 1; });
    selectAll.checked = checkedCount === boxes.length;
    selectAll.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
  }

  document.addEventListener("change", function (event) {
    const target = event.target;
    if (!target) return;
    if (target.id === "sklSelectAll") {
      const checked = Boolean(target.checked);
      const tbody = el("skuLinksTableBody");
      if (!tbody) return;
      Array.prototype.forEach.call(tbody.querySelectorAll(".skl-row-check"), function (box) { box.checked = checked; });
      target.indeterminate = false;
      return;
    }
    if (target.classList && target.classList.contains("skl-row-check")) syncSelectAllState();
  });

  // 【task-29】点「其它地方」时把导出历史的「确认删除」状态复位（点同一个删除链接本身不算，保证两步式可用）
  document.addEventListener("click", function (event) {
    const target = event.target;
    if (target && target.closest && target.closest("[data-skl-export-delete]")) return;
    resetExportDeleteConfirm();
  });

  function initSkuLinks() {
    setAddMsg("");
    setPageMsg("", "");
    loadLinks();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initSkuLinks);
  else setTimeout(initSkuLinks, 0);   // 放进回调，避免顶层直接调用（守卫的加载顺序约定）

  window.sklAddModal = { open: open, close: close };
})();
