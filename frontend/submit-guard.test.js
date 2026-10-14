// "重复提交要拦截并报错" 的回归测试。
//
// 页面模块不是 CommonJS，无法 require；但这两个文件顶层只做 document.getElementById 与
// let/const 声明（无立即调用），因此可以用 node:vm 加载并真实调用事件处理函数。
//
// 锁定的不变量：一次请求在途时再次提交，必须**不再发出第二个请求**并给出明确报错。
//   - 刊登重复提交 → 平台侧产生重复 offer；
//   - 批量库存是 { ids, delta } 增量操作 → 重复提交会把库存加两次；
//   - 刊登设置是全量 PUT → 重复提交会用两次表单快照依次覆盖服务端。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PUBLISH_PATH = path.join(__dirname, "pages", "publish", "publish.js");
const ONLINE_PATH = path.join(__dirname, "pages", "online-products", "online-products.js");

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 断言「第二次提交没有发出请求」时必须用 race 而不是直接 await：没有守卫时第二次提交会一直
// 等在被挂起的同一个请求上，直接 await 会让测试**挂死**而不是失败（那样回归就检测不出来）。
async function settleBriefly(promise) {
  await Promise.race([promise, sleep(50)]);
}

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

function makeDocument(elementIds) {
  const elements = new Map(elementIds.map((id) => [id, makeElement()]));
  return {
    elements,
    document: {
      getElementById: (id) => elements.get(id) || null,
      addEventListener() {}
    }
  };
}

const PUBLISH_IDS = [
  "publishSettingsModalMask", "publishSettingsForm", "publishSettingsModalMessage", "savePublishSettingsBtn",
  "publishAutoToYandexToggle", "publishAutoToOzonToggle", "publishSimulateToggle",
  "publishSkuPrefix", "publishSkuSeparator", "publishSkuIncludeSourceToggle",
  "publishIntervalSeconds", "dailyPublishLimit", "publishQualityGateToggle", "publishQualityMinScore",
  "publishMessage", "publishShopSelect"
];

function loadPublishPanel(apiRequest) {
  const { elements, document } = makeDocument(PUBLISH_IDS);
  elements.get("publishSettingsForm").querySelectorAll = () => [
    elements.get("publishAutoToYandexToggle"),
    elements.get("publishSkuPrefix"),
    elements.get("publishQualityMinScore")
  ];
  const sandbox = {
    document,
    window: { addEventListener() {} },
    console,
    apiRequest,
    state: {
      shops: [],
      publishSelectedIds: [],
      publishWorkspaceTab: "yandex",
      publishSettings: { erpAutoPublishToYandex: true }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PUBLISH_PATH, "utf8"), sandbox, { filename: "publish.js" });
  return { sandbox, elements };
}

test("刊登设置重复提交：第二次被拦截并报错，只发出一个 PUT", async () => {
  const calls = [];
  const gate = deferred();
  const { sandbox, elements } = loadPublishPanel(async (url, options) => {
    calls.push({ url: String(url), method: options?.method });
    return gate.promise;
  });

  const event = { preventDefault() {} };
  const first = vm.runInContext("onPublishSettingsSubmit(__event)", Object.assign(sandbox, { __event: event }));
  const second = vm.runInContext("onPublishSettingsSubmit(__event)", sandbox);
  await settleBriefly(second);

  assert.equal(calls.length, 1, "第二次提交不得再发请求");
  assert.equal(calls[0].method, "PUT");
  assert.match(elements.get("publishSettingsModalMessage").textContent, /请勿重复提交/);

  gate.resolve({ ok: true, data: { settings: {} } });
  await first;
});

test("Ozon 刊登重复提交：第二次被拦截并报错，只发出一个 POST", async () => {
  const calls = [];
  const gate = deferred();
  const { sandbox, elements } = loadPublishPanel(async (url, options) => {
    calls.push({ url: String(url), method: options?.method });
    return gate.promise;
  });
  sandbox.state.publishSelectedIds = ["PUB-1"];
  sandbox.state.publishWorkspaceTab = "ozon";
  // 这三个是 publish.js 里的 function 声明（在 context 里即全局属性），加载后替换即可生效。
  sandbox.getPublishWorkspaceItems = () => [{ id: "PUB-1", publishPlatform: "ozon" }];
  sandbox.getPublishShopProvider = () => "ozon";
  sandbox.loadPublishProducts = async () => {};

  const first = vm.runInContext("onPublishToYandex()", sandbox);
  await Promise.resolve();
  const second = vm.runInContext("onPublishToYandex()", sandbox);
  await settleBriefly(second);

  assert.equal(calls.length, 1, "第二次刊登不得再发请求");
  assert.equal(calls[0].url, "/api/product-publish/publish-ozon");
  assert.match(elements.get("publishMessage").textContent, /请勿重复提交/);

  gate.resolve({ ok: true, data: { success: 1, processing: 0, failed: 0 } });
  await first;
});

const ONLINE_IDS = ["onlineInventoryForm", "onlineInventoryMessage", "onlineProductMessage", "onlineInventoryModalMask"];

function loadOnlinePanel(apiRequest) {
  const { elements, document } = makeDocument(ONLINE_IDS);
  class FormDataStub {
    get() { return "5"; }
  }
  const sandbox = {
    document,
    window: { addEventListener() {}, confirm: () => true },
    console,
    apiRequest,
    FormData: FormDataStub,
    state: { onlineSelectedIds: ["OP-1", "OP-2"] }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(ONLINE_PATH, "utf8"), sandbox, { filename: "online-products.js" });
  // 成功路径会调用它做整表刷新；守卫测试只关心请求次数。
  sandbox.loadOnlineProducts = async () => {};
  return { sandbox, elements };
}

test("批量库存重复提交：第二次被拦截并报错，只发出一个 PUT", async () => {
  const calls = [];
  const gate = deferred();
  const { sandbox, elements } = loadOnlinePanel(async (url, options) => {
    calls.push({ url: String(url), method: options?.method, body: options?.body });
    return gate.promise;
  });

  const event = { preventDefault() {} };
  Object.assign(sandbox, { __event: event });
  const first = vm.runInContext("onOnlineInventorySubmit(__event)", sandbox);
  const second = vm.runInContext("onOnlineInventorySubmit(__event)", sandbox);
  await settleBriefly(second);

  assert.equal(calls.length, 1, "第二次提交不得再发请求");
  assert.equal(calls[0].url, "/api/online-products/batch-inventory");
  assert.equal(calls[0].method, "PUT");
  assert.match(elements.get("onlineInventoryMessage").textContent, /请勿重复提交/);

  gate.resolve({ ok: true, data: { updated: 2, syncedToYandex: 0, syncErrors: [] } });
  await first;
});
