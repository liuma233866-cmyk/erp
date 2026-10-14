// ==================================================================
// 【task-26】商品SKU / 绑定关系 / 佣金 索引 —— 全站**唯一一份**（单一命名空间 window.PdevSkuIndex）
// ------------------------------------------------------------------
// 背景：原先 orders.js / product-list.js / online-products.js **各自**有一份同名裸全局
//   （`var PDEV_SKU_INDEX` + `ensurePdevSkuIndex()` + `pdevSkuFor()`，谁后加载谁生效 → 隐患），
//   orders.js 另有一份佣金索引。现在统一收敛到这里；三个页面文件只保留**薄封装**。
//
// 取数顺序（沿用 task-15 语义：绑定关系优先 → 同码兜底）：
//   ① GET /api/product-dev/products?pageSize=500
//        → publicId(trim+lower) → { sku: publicId, purchasePrice }
//   ② GET /api/pdev-links
//        → link.offerId / link.marketSku / link.onlineProductId（trim+lower）
//        → { sku: link.pdevSku, purchasePrice:（同码项的采购价，没有则 0） }
//          后写入 ⇒ 绑定关系优先（覆盖①里同 key 的项）
//        → 同时登记 link.commissionPercent（**百分数**口径：26 表示 26%）
//   ③ 两条都没有 → skuFor 返回 ""（页面显示 -）、purchasePriceFor / commissionPercentFor 返回 0
//
// 惰性：**顶层不发起任何请求**；第一次查询（或显式 ensure()）才发请求；两个接口各只请求一次并缓存。
// 到位后：回填页面上已有的 [data-pdev-sku-cell]，并触发已注册的 onReady 回调
//   （orders.js 用 onReady(fillPdevEstimates) 注册 → 采购价/佣金到位后补算预估利润）。
//
// 【task-27】refresh()：绑定/解绑/换绑/导入建绑定之后，让同一个 SPA 会话里的其它页面**立刻**用上新映射。
//   · 清缓存 → 重新拉两个接口 → 重建索引
//   · 重新回填**所有** [data-pdev-sku-cell]：命中写新 SKU，**不再命中的写回 "-"**
//   · 重新触发已注册的 onReady 回调（订单页预估利润跟着补算）
//   · 请求合并：进行中的那一轮会被复用（burst 调用只发一轮）；若调用发生在**响应已到、正在重建**之后，
//     最多再补**一轮**（保证刚写完的数据能看到），见 startLoad()
//   · 失败安静处理（不抛未捕获异常），返回 Promise 便于调用方 await
// ==================================================================
window.PdevSkuIndex = (function () {
  var skuIndex = null;                 // Map<key, { sku, purchasePrice }>
  var commissionIndex = null;          // Map<key, percent>
  var pending = null;                  // 进行中那一轮的 Promise（用于合并/去重）
  var roundFetched = false;            // 本轮两个响应是否已到手（决定是否需要再补一轮）
  var rerunRequested = false;          // 是否需要在本轮结束后再补一轮
  var registeredCallbacks = [];        // onReady 注册的回调（refresh 后要重新触发）
  var loadRounds = 0;                  // 实际发起的轮数（诊断用：证明合并生效）
  var lastLoadedAt = 0;

  function lower(value) {
    return String(value == null ? "" : value).trim().toLowerCase();
  }

  // 用最新索引回填所有 [data-pdev-sku-cell]：命中写 SKU，**未命中写回 "-"**（解绑后要能变回 -）
  function backfillCells() {
    document.querySelectorAll("[data-pdev-sku-cell]").forEach(function (el) {
      var hit = skuIndex ? skuIndex.get(lower(el.getAttribute("data-shop-sku"))) : null;
      el.textContent = hit && hit.sku ? hit.sku : "-";
    });
  }

  function fireReadyCallbacks() {
    registeredCallbacks.slice().forEach(function (callback) {
      try { callback(); } catch (error) { /* 单个回调异常不影响其它回调 */ }
    });
  }

  // 真正发起一轮请求（并发调用会被合并；去重策略见函数内注释）
  function startLoad() {
    if (pending) {
      // ① 响应还没到 → 复用这一轮（burst 调用合并成一轮请求）
      // ② 响应已到、正在重建 → 这次调用想看到更新的数据，补排一轮（多次也只补一轮）
      if (roundFetched) rerunRequested = true;
      return pending;
    }
    loadRounds += 1;
    roundFetched = false;
    var options = { credentials: "same-origin", headers: { Accept: "application/json" } };
    var productsTask = fetch("/api/product-dev/products?pageSize=500", options)
      .then(function (response) { return response.ok ? response.json() : null; })
      .catch(function () { return null; });
    var linksTask = fetch("/api/pdev-links", options)
      .then(function (response) { return response.ok ? response.json() : null; })
      .catch(function () { return null; });
    var round = Promise.all([productsTask, linksTask])
      .then(function (results) {
        roundFetched = true;
        var idx = new Map();
        var priceBySku = new Map();                       // publicId(lower) → { sku, purchasePrice }
        ((results[0] && results[0].items) || []).forEach(function (product) {
          var id = String((product && product.publicId) || "").trim();
          if (!id) return;
          var entry = { sku: id, purchasePrice: Number(product.purchasePrice) || 0 };
          idx.set(id.toLowerCase(), entry);               // ① 同码兜底（先写）
          priceBySku.set(id.toLowerCase(), entry);
        });
        var commission = new Map();
        ((results[1] && results[1].items) || []).forEach(function (link) {
          if (!link) return;
          var percent = Number(link.commissionPercent);
          var pdevSku = String(link.pdevSku || "").trim();
          [link.offerId, link.marketSku, link.onlineProductId].forEach(function (raw) {
            var key = lower(raw);
            if (!key) return;
            if (pdevSku) {
              var known = priceBySku.get(pdevSku.toLowerCase());
              idx.set(key, { sku: pdevSku, purchasePrice: known ? known.purchasePrice : 0 });   // ② 绑定优先（覆盖①）
            }
            if (Number.isFinite(percent)) commission.set(key, percent);                        // null / 缺列 → 不登记，按 0
          });
        });
        skuIndex = idx;
        commissionIndex = commission;
        lastLoadedAt = Date.now();
        backfillCells();
        fireReadyCallbacks();
      })
      .catch(function () { /* 拉取/重建失败：安静处理，不抛未捕获异常；索引保持清空态，下次查询会重试 */ })
      .then(function () {
        pending = null;
        roundFetched = false;
        if (rerunRequested) {
          rerunRequested = false;
          return startLoad();
        }
      });
    pending = round;
    return round;
  }

  function ensure() {
    if (skuIndex && commissionIndex) return pending || Promise.resolve();
    return startLoad();
  }

  // 【task-27】清缓存 + 重拉 + 重建 + 重新回填 + 重新触发 onReady；进行中的调用会被合并；返回 Promise
  function refresh() {
    skuIndex = null;
    commissionIndex = null;
    return startLoad();
  }

  function skuFor(shopSku) {
    if (!skuIndex) ensure();
    var key = lower(shopSku);
    if (!key || !skuIndex) return "";
    var hit = skuIndex.get(key);
    if (!hit) return "";
    // 兼容旧形态：Map 里可能是字符串
    return typeof hit === "string" ? hit : String(hit.sku || "");
  }

  function purchasePriceFor(shopSku) {
    if (!skuIndex) ensure();
    var key = lower(shopSku);
    if (!key || !skuIndex) return 0;
    var hit = skuIndex.get(key);
    if (!hit || typeof hit !== "object") return 0;
    return Number(hit.purchasePrice) || 0;
  }

  function commissionPercentFor(shopSku) {
    if (!commissionIndex) ensure();
    var key = lower(shopSku);
    if (!key || !commissionIndex) return 0;
    var percent = commissionIndex.get(key);
    return Number.isFinite(percent) ? percent : 0;
  }

  function isReady() {
    return !!(skuIndex && commissionIndex);
  }

  function onReady(callback) {
    if (typeof callback !== "function") return;
    // 同一个回调只登记一次；refresh 后会重新触发已登记的回调
    if (registeredCallbacks.indexOf(callback) < 0) registeredCallbacks.push(callback);
    if (isReady()) {
      try { callback(); } catch (error) { /* 忽略单次回调异常 */ }
    }
  }

  // 诊断用（只读）：证明合并/去重是否生效
  function stats() {
    return { loadRounds: loadRounds, lastLoadedAt: lastLoadedAt, isReady: isReady(), loading: !!pending, callbacks: registeredCallbacks.length };
  }

  return {
    ensure: ensure,
    refresh: refresh,
    skuFor: skuFor,
    purchasePriceFor: purchasePriceFor,
    commissionPercentFor: commissionPercentFor,
    isReady: isReady,
    onReady: onReady,
    stats: stats
  };
})();
