// "失败不要伪装成正常" 的回归测试。
//
// 两个页面此前都把「全量数据没拿到」塌缩成一种看起来正常的状态：
//   - finance：全量订单拉取失败 → getFinanceOrders() 回退到 state.orders（只有当前一页），
//     利润/采购总额于是变成"当前页之和"却被当成全站总额；消息还写成
//     「当前还没有命中审单规则的订单」——听起来像"确实没有"。
//   - online-products：佣金未匹配接口失败 → 空列表 → 渲染成「当前全部商品都已匹配佣金」，
//     500/401 看起来像"合规检查通过"。
//
// 页面模块不是 CommonJS，用 node:vm 加载后真实调用相关函数。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const FINANCE_PATH = path.join(__dirname, "pages", "finance", "finance.js");
const ONLINE_PATH = path.join(__dirname, "pages", "online-products", "online-products.js");

function makeElement(overrides = {}) {
  return {
    value: "",
    checked: false,
    disabled: false,
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

function loadPage(file, ids, sandboxExtras) {
  const elements = new Map(ids.map((id) => [id, makeElement()]));
  const sandbox = {
    document: { getElementById: (id) => elements.get(id) || null, addEventListener() {} },
    window: { addEventListener() {}, confirm: () => true },
    console,
    // 其他 core 模块提供的全局；以下用例数据为空，大多不会走到，但沙箱里必须先存在。
    escapeHtml: (value) => String(value ?? ""),
    toMoneyNumber: (value) => Number(value) || 0,
    toNullableMoneyNumber: (value) => (value === null || value === undefined || value === "" ? null : Number(value)),
    getPurchaseTimestamp: () => 0,
    getProfitTimestamp: () => 0,
    getCustomerOrderStatusDisplay: () => "",
    hasPurchaseInfo: () => false,
    computeOrderProfit: () => ({}),
    startOfDay: (date) => date,
    startOfWeek: (date) => date,
    startOfMonth: (date) => date,
    normalizeOrderForView: (order) => order,
    ...sandboxExtras
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: path.basename(file) });
  return { sandbox, elements };
}

function pageOrders(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `ORD-${index}`, amount: 10 }));
}

const FINANCE_IDS = [
  "financeProfitMessage", "financeProfitMatchedCount", "financeProfitTotalRmb",
  "financeProfitTotalRub", "financeProfitTableBody", "financeProfitPaginationInfo"
];

function loadFinance(apiRequest) {
  return loadPage(FINANCE_PATH, FINANCE_IDS, {
    apiRequest,
    can: () => true,
    state: {
      orders: pageOrders(50),        // 订单管理页留下的"当前一页"
      financeOrders: [],
      financeProfitFilters: {},
      financeProfitPageSize: 20
    }
  });
}

test("财务聚合绝不回退到当前分页：全量没拿到时就是空，而不是前 50 条", () => {
  const { sandbox } = loadFinance(async () => ({ ok: false, status: 500, error: "HTTP 500" }));

  const count = vm.runInContext("getFinanceOrders().length", sandbox);
  assert.equal(count, 0, "不得回退到 state.orders（只有一页），否则总额会被当成全站总额");
});

test("全量订单加载失败时显式报错，而不是说「当前还没有命中审单规则的订单」", async () => {
  const { sandbox, elements } = loadFinance(async () => ({ ok: false, status: 500, error: "HTTP 500" }));

  const loaded = await vm.runInContext("loadFinanceOrders()", sandbox);
  assert.equal(loaded, false);

  vm.runInContext("buildFinanceProfitView()", sandbox);
  const message = elements.get("financeProfitMessage").textContent;
  assert.match(message, /全量订单加载失败/, "必须说明统计不完整");
  assert.match(message, /HTTP 500/, "应带上原因");
  assert.doesNotMatch(message, /当前还没有命中审单规则/, "不得给出「确实没有」的错觉");
});

test("全量订单加载成功时消息回到正常口径", async () => {
  const { sandbox, elements } = loadFinance(async () => ({
    ok: true,
    data: { items: [{ id: "ORD-1", matchedRuleName: "规则A", profitRub: 5 }] }
  }));

  await vm.runInContext("loadFinanceOrders()", sandbox);
  vm.runInContext("buildFinanceProfitView()", sandbox);

  const message = elements.get("financeProfitMessage").textContent;
  assert.doesNotMatch(message, /加载失败/);
  assert.match(message, /命中规则/);
});

const ONLINE_IDS = ["onlineCommissionTableBody", "onlineCommissionMessage"];

test("佣金未匹配接口失败时不得渲染成「全部都已匹配佣金」", async () => {
  const { sandbox, elements } = loadPage(ONLINE_PATH, ONLINE_IDS, {
    apiRequest: async () => ({ ok: false, status: 500, error: "HTTP 500" }),
    can: () => true,
    state: { onlineCommissionUnmatched: [] }
  });

  await vm.runInContext("loadOnlineCommissionUnmatched()", sandbox);
  vm.runInContext("renderOnlineCommissionUnmatched()", sandbox);

  const message = elements.get("onlineCommissionMessage").textContent;
  assert.match(message, /加载失败/, "必须说明加载失败");
  assert.match(message, /HTTP 500/);
  assert.doesNotMatch(message, /都已匹配佣金/, "不得给出合规通过的错觉");
});

test("佣金未匹配接口成功且确实为空时才说「全部都已匹配佣金」", async () => {
  const { sandbox, elements } = loadPage(ONLINE_PATH, ONLINE_IDS, {
    apiRequest: async () => ({ ok: true, data: { items: [] } }),
    can: () => true,
    state: { onlineCommissionUnmatched: [] }
  });

  await vm.runInContext("loadOnlineCommissionUnmatched()", sandbox);
  vm.runInContext("renderOnlineCommissionUnmatched()", sandbox);

  assert.equal(elements.get("onlineCommissionMessage").textContent, "当前全部商品都已匹配佣金");
});
