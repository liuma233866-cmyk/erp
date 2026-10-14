// 刊登设置弹窗的调用方回归测试。
//
// 页面模块不是 CommonJS，无法 require；但 publish.js 顶层只做 document.getElementById 与
// let 声明（无立即调用），因此可以用 node:vm 在最小沙箱里加载它并真实调用
// openPublishSettingsModal()。
//
// 锁定的不变量：设置 GET 失败时，绝不能把硬编码默认值（state.js 里
// erpAutoPublishToYandex 默认为 true）当成「当前设置」渲染，更不能让「保存」把这份默认值
// 写回服务端 —— 那会在一次网络抖动里悄悄改掉真实刊登配置。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PUBLISH_PATH = path.join(__dirname, "pages", "publish", "publish.js");

// 需要真实行为的最小元素集合；其余 id 一律返回 null —— 页面代码对每个 DOM 访问都有 if 守卫。
const ELEMENT_IDS = [
  "publishSettingsModalMask",
  "publishSettingsForm",
  "publishSettingsModalMessage",
  "publishAutoToYandexToggle",
  "publishAutoToOzonToggle",
  "publishSimulateToggle",
  "publishSkuPrefix",
  "publishSkuSeparator",
  "publishSkuIncludeSourceToggle",
  "publishIntervalSeconds",
  "dailyPublishLimit",
  "publishQualityGateToggle",
  "publishQualityMinScore",
  "savePublishSettingsBtn"
];

function makeField() {
  return { value: "", checked: false, disabled: false, style: {}, textContent: "" };
}

function loadPublishPanel(apiRequest) {
  const elements = new Map(ELEMENT_IDS.map((id) => [id, makeField()]));
  const mask = elements.get("publishSettingsModalMask");
  mask.classList = { add() {}, remove() {}, toggle() {} };
  // 只把输入控件放进表单的 querySelectorAll 结果里，模拟 setPublishSettingsFormDisabled 的目标集合。
  const fields = [
    elements.get("publishAutoToYandexToggle"),
    elements.get("publishAutoToOzonToggle"),
    elements.get("publishSimulateToggle"),
    elements.get("publishSkuPrefix"),
    elements.get("publishQualityMinScore")
  ];
  elements.get("publishSettingsForm").querySelectorAll = () => fields;

  const sandbox = {
    document: { getElementById: (id) => elements.get(id) || null, addEventListener() {} },
    window: { addEventListener() {} },
    console,
    // 与 shared/core/state.js 的默认值保持一致：erpAutoPublishToYandex 默认为 true。
    state: {
      shops: [],
      publishSettings: {
        erpAutoPublishToYandex: true,
        erpAutoPublishToOzon: false,
        simulateBackendPublishToYandex: false
      }
    },
    apiRequest
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PUBLISH_PATH, "utf8"), sandbox, { filename: "publish.js" });
  return { sandbox, elements };
}

test("设置加载失败时锁定表单，且不把硬编码默认值当成当前设置", async () => {
  const { sandbox, elements } = loadPublishPanel(async () => ({ ok: false, status: 500, error: "HTTP 500" }));

  await vm.runInContext("openPublishSettingsModal()", sandbox);

  assert.equal(
    elements.get("publishAutoToYandexToggle").checked,
    false,
    "不得把默认值 erpAutoPublishToYandex=true 渲染成服务端当前设置"
  );
  assert.equal(elements.get("savePublishSettingsBtn").disabled, true, "保存必须被禁用，否则一点就覆盖真实配置");
  for (const id of ["publishSkuPrefix", "publishQualityMinScore", "publishAutoToOzonToggle"]) {
    assert.equal(elements.get(id).disabled, true, `${id} 应被锁定`);
  }
  assert.match(elements.get("publishSettingsModalMessage").textContent, /加载设置失败/);
});

test("设置加载成功时按服务端值填表并允许保存", async () => {
  const { sandbox, elements } = loadPublishPanel(async () => ({
    ok: true,
    data: { settings: { erpAutoPublishToYandex: false, skuPrefix: "ABC" } }
  }));

  await vm.runInContext("openPublishSettingsModal()", sandbox);

  assert.equal(elements.get("publishAutoToYandexToggle").checked, false, "必须反映服务端的 false");
  assert.equal(elements.get("publishSkuPrefix").value, "ABC");
  assert.equal(elements.get("savePublishSettingsBtn").disabled, false, "加载成功时应可保存");
  assert.equal(elements.get("publishSettingsModalMessage").textContent, "");
});

test("失败之后再成功要能解锁并填入真实值（锁定不是永久的）", async () => {
  let calls = 0;
  const { sandbox, elements } = loadPublishPanel(async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 500, error: "HTTP 500" };
    return { ok: true, data: { settings: { erpAutoPublishToYandex: false, skuPrefix: "OK" } } };
  });

  await vm.runInContext("openPublishSettingsModal()", sandbox);
  assert.equal(elements.get("savePublishSettingsBtn").disabled, true);
  assert.equal(elements.get("publishSkuPrefix").disabled, true);

  await vm.runInContext("openPublishSettingsModal()", sandbox);
  assert.equal(elements.get("savePublishSettingsBtn").disabled, false);
  assert.equal(elements.get("publishSkuPrefix").disabled, false);
  assert.equal(elements.get("publishSkuPrefix").value, "OK");
});

test("保存成功后 state.publishSettings 必须带上质量门禁字段（此前回写漏了这两个）", async () => {
  const { sandbox } = loadPublishPanel(async () => ({
    ok: true,
    data: { settings: { qualityGateEnabled: false, qualityMinScore: 60, skuPrefix: "P" } }
  }));

  await vm.runInContext("savePublishSettingsFromForm()", sandbox);

  const settings = sandbox.state.publishSettings;
  assert.equal(settings.skuPrefix, "P");
  assert.equal(settings.qualityGateEnabled, false, "必须保留服务端返回的关闭状态，而不是丢失成 undefined");
  assert.equal(settings.qualityMinScore, 60, "必须保留服务端返回的阈值");
});
