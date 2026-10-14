// 「选择集收敛到可见行 / 不可逆操作要确认 / 会话过期要登出」的回归测试。
//
// 三条缺陷都属于"界面上看不见的行被动了手"或"该说的话没说"：
//   - online-products：pruneSelectedOnlineProducts() 只按「整表里是否还存在」过滤，
//     被筛选隐藏的行仍留在选择集里 → 批量删除/改库存作用在看不见的行上；
//   - publish：切换工作区页签时不收敛选择集（状态筛选那条路径本来就是清空的）→
//     删除/改库存会把另一个页签的行一起带上；
//   - orders：废弃订单不可逆且一次点击即生效（无确认），且没有在途守卫（双击发两次）。
//
// 页面模块不是 CommonJS，用 node:vm 加载后真实调用相关函数。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ONLINE_PATH = path.join(__dirname, "pages", "online-products", "online-products.js");
const PUBLISH_PATH = path.join(__dirname, "pages", "publish", "publish.js");
const ORDERS_PATH = path.join(__dirname, "pages", "orders", "orders.js");

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleBriefly(promise) {
  // 没有守卫时第二次调用会一直等在被挂起的同一个请求上，直接 await 会让测试挂死而不是失败。
  await Promise.race([promise, sleep(50)]);
}

function makeElement(overrides = {}) {
  return {
    value: "",
    checked: false,
    disabled: false,
    files: [],
    textContent: "",
    innerHTML: "",
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    querySelectorAll: () => [],
    ...overrides
  };
}

function loadPage(file, ids, extras) {
  const elements = new Map(ids.map((id) => [id, makeElement()]));
  const sandbox = {
    document: { getElementById: (id) => elements.get(id) || null, addEventListener() {} },
    window: { addEventListener() {}, confirm: () => true },
    console,
    escapeHtml: (value) => String(value ?? ""),
    ...extras
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: path.basename(file) });
  return { sandbox, elements };
}

// ---------------------------------------------------------------- online-products

function loadOnline(state) {
  return loadPage(ONLINE_PATH, ["onlineProductMessage"], {
    apiRequest: async () => ({ ok: true, data: { items: [] } }),
    can: () => true,
    state
  });
}

test("在线产品：筛选变化后选择集收敛到可见行，不含被筛掉的行", () => {
  const { sandbox } = loadOnline({
    onlineProducts: [{ id: "A" }, { id: "B" }, { id: "C" }],
    onlineFilteredProducts: [{ id: "A" }],
    onlineSelectedIds: ["A", "B", "C"]
  });

  vm.runInContext("pruneSelectedOnlineProducts()", sandbox);

  assert.deepEqual(vm.runInContext("state.onlineSelectedIds", sandbox), ["A"]);
});

test("在线产品：同一筛选条件下的跨页选择仍然保留", () => {
  const { sandbox } = loadOnline({
    onlineProducts: [{ id: "A" }, { id: "B" }, { id: "C" }],
    // A 与 B 都在筛选结果里（只是分处不同页），C 被筛掉
    onlineFilteredProducts: [{ id: "A" }, { id: "B" }],
    onlineSelectedIds: ["A", "B", "C"]
  });

  vm.runInContext("pruneSelectedOnlineProducts()", sandbox);

  assert.deepEqual(vm.runInContext("state.onlineSelectedIds", sandbox), ["A", "B"]);
});

// ---------------------------------------------------------------------- publish

const PUBLISH_STATE = {
  shops: [{ id: "S-Y", provider: "yandex_market" }, { id: "S-O", provider: "ozon" }],
  publishProducts: [{ id: "Y1", shopId: "S-Y" }, { id: "O1", shopId: "S-O" }],
  publishSelectedIds: ["Y1", "O1"]
};

function loadPublish(state) {
  return loadPage(PUBLISH_PATH, [], {
    apiRequest: async () => ({ ok: true, data: { items: [] } }),
    state: { ...PUBLISH_STATE, ...state }
  });
}

test("刊登：切到 Ozon 页签后，Yandex 行的选择被移除", () => {
  const { sandbox } = loadPublish({ publishWorkspaceTab: "ozon" });

  vm.runInContext("prunePublishSelectionToWorkspace()", sandbox);

  assert.deepEqual(vm.runInContext("state.publishSelectedIds", sandbox), ["O1"]);
});

test("刊登：发布中心页签保留全部选择", () => {
  const { sandbox } = loadPublish({ publishWorkspaceTab: "center" });

  vm.runInContext("prunePublishSelectionToWorkspace()", sandbox);

  assert.deepEqual(vm.runInContext("state.publishSelectedIds", sandbox), ["Y1", "O1"]);
});

test("刊登：状态筛选页签只保留该状态的行", () => {
  const { sandbox } = loadPublish({
    publishWorkspaceTab: "yandex",
    publishProducts: [
      { id: "Y1", shopId: "S-Y", publishStatus: "success" },
      { id: "Y2", shopId: "S-Y", publishStatus: "draft" }
    ],
    publishSelectedIds: ["Y1", "Y2"],
    yandexPublishStatusFilter: "unpublished"
  });

  vm.runInContext("prunePublishSelectionToWorkspace()", sandbox);

  assert.deepEqual(vm.runInContext("state.publishSelectedIds", sandbox), ["Y2"], "只有 draft 属于未发布分组");
});

test("刊登：点击 Ozon 页签会真正触发选择集收敛（锁住调用方接线）", () => {
  const { sandbox } = loadPublish({ publishWorkspaceTab: "center" });
  // 走真实的事件处理器，而不是直接调用收敛函数。
  sandbox.__btn = { dataset: { publishTab: "ozon" } };
  sandbox.__event = { target: { closest: () => sandbox.__btn } };

  vm.runInContext("onPublishWorkspaceTabClick(__event)", sandbox);

  assert.equal(vm.runInContext("state.publishWorkspaceTab", sandbox), "ozon");
  assert.deepEqual(vm.runInContext("state.publishSelectedIds", sandbox), ["O1"], "另一个页签的行必须被移出选择集");
});

// ----------------------------------------------------------------------- orders

function loadOrders(apiRequest, confirmResult) {
  const harness = loadPage(ORDERS_PATH, ["orderMessage"], {
    apiRequest,
    clearAuth: () => {},
    showAuth: () => {},
    URLSearchParams,
    window: { addEventListener() {}, confirm: () => confirmResult },
    state: { selectedOrderIds: [] }
  });
  // 注意：脚本里的 function 声明（orders.js 自己也有 loadOrders）会成为 context 的全局属性，
  // 覆盖 extras 里传入的同名属性，所以必须在**加载之后**再替换。
  harness.sandbox.loadOrders = async () => {};
  return harness;
}

test("废弃订单：二次确认取消时一个请求都不发", async () => {
  const calls = [];
  const { sandbox } = loadOrders(async (url) => { calls.push(String(url)); return { ok: true, data: {} }; }, false);

  await vm.runInContext("voidOrder({ id: 'ORD-1', shopOrderNo: 'NO-1' })", sandbox);

  assert.equal(calls.length, 0, "取消确认后不得发请求");
});

test("废弃订单：确认后才发请求", async () => {
  const calls = [];
  const { sandbox } = loadOrders(async (url) => { calls.push(String(url)); return { ok: true, data: {} }; }, true);

  await vm.runInContext("voidOrder({ id: 'ORD-1', shopOrderNo: 'NO-1' })", sandbox);

  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/void$/);
});

test("废弃订单重复提交：第二次被拦截并报错，只发一个请求", async () => {
  const calls = [];
  const gate = deferred();
  const { sandbox } = loadOrders(async (url) => { calls.push(String(url)); return gate.promise; }, true);

  const first = vm.runInContext("voidOrder({ id: 'ORD-1' })", sandbox);
  const second = vm.runInContext("voidOrder({ id: 'ORD-1' })", sandbox);
  await settleBriefly(second);

  assert.equal(calls.length, 1, "第二次不得再发请求");
  assert.match(vm.runInContext("orderMessage.textContent", sandbox), /请勿重复提交/);

  gate.resolve({ ok: true, data: {} });
  await first;
});

// --------------------------------------------------------- 采购导入的会话过期处理

test("采购导入遇到 401 会清理会话并回到登录页（与 apiRequest 一致）", async () => {
  const events = [];
  const { sandbox, elements } = loadPage(ORDERS_PATH, ["orderMessage", "ordersPurchaseFileInput", "ordersPurchaseSubmitBtn"], {
    apiRequest: async () => ({ ok: true, data: {} }),
    loadOrders: async () => {},
    clearAuth: () => events.push("clearAuth"),
    showAuth: () => events.push("showAuth"),
    fetch: async () => ({ status: 401, ok: false, json: async () => ({ message: "Unauthorized" }) }),
    state: {}
  });
  elements.get("ordersPurchaseFileInput").files = [{ name: "purchase.xlsx", type: "" }];

  await vm.runInContext("onOrdersPurchaseImportSubmit({ preventDefault() {} })", sandbox);

  assert.deepEqual(events, ["clearAuth", "showAuth"], "会话过期必须登出，而不是停留在过期界面上");
});
