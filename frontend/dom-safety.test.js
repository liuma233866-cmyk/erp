// 「DOM 注入面」的回归测试：图片地址白名单、角色标签转义、预览遮罩不残留。
//
// 三条都属纵深防御，但方向明确：
//   - ai.js 的三处 <img src> 是唯一没走项目自己的 http(s) 白名单的地方（其余页面都走了）；
//   - users.js:213 是唯一把服务端值未转义塞进 innerHTML 的地方（后端白名单使其当前不可利用）；
//   - ui.js 的预览遮罩：openImagePreview() 每次新建遮罩，而 closeImagePreview() 原先只处理
//     第一个 —— 快速连续打开会叠加多个全屏遮罩，极端情况下留下一个吞掉点击的遮罩。
//
// 页面/核心模块不是 CommonJS，用 node:vm 加载后真实调用相关函数。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const AI_PATH = path.join(__dirname, "pages", "ai", "ai.js");
const USERS_PATH = path.join(__dirname, "pages", "users", "users.js");
const UI_PATH = path.join(__dirname, "shared", "core", "ui.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 与 shared/core/safe-image-url.js 同语义：只放行 http(s)，其余返回空串。
function safeImageUrl(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) ? text : "";
}

// 与 shared/core/ui.js 的 escapeHtml 同语义（顺序很重要：先 & 再其余）。
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function makeElement() {
  const classes = new Set();
  return {
    src: undefined,
    textContent: "",
    innerHTML: "",
    style: {},
    dataset: {},
    className: "",
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name) => (classes.has(name) ? classes.delete(name) : classes.add(name))
    },
    setAttribute() {},
    removeAttribute(name) {
      if (name === "src") this.src = undefined;
    },
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => []
  };
}

function loadModule(file, ids, extras) {
  const elements = new Map(ids.map((id) => [id, makeElement()]));
  const sandbox = {
    document: { getElementById: (id) => elements.get(id) || null, addEventListener() {} },
    window: { addEventListener() {} },
    console,
    safeImageUrl,
    escapeHtml,
    ...extras
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: path.basename(file) });
  return { sandbox, elements };
}

// ------------------------------------------------------------------------ ai.js

function loadAi() {
  return loadModule(AI_PATH, [
    "aiImageTaskSourcePreview",
    "aiImageTaskResultPreview"
  ], { state: {} });
}

test("AI 详情预览：javascript:/data: 图片地址不得进入 <img src>", () => {
  const { sandbox, elements } = loadAi();
  sandbox.__task = {
    id: "AIT-1",
    status: "succeeded",
    sourceImageUrl: "javascript:alert(1)",
    resultImageUrl: "data:image/png;base64,AAAA"
  };

  vm.runInContext("renderAiImageTaskDetail(__task)", sandbox);

  for (const id of ["aiImageTaskSourcePreview", "aiImageTaskResultPreview"]) {
    const element = elements.get(id);
    assert.equal(element.src, undefined, `${id} 不得写入非法地址`);
    assert.ok(element.classList.contains("hidden"), `${id} 应保持隐藏`);
  }
});

test("AI 详情预览：合法 http(s) 地址照常显示", () => {
  const { sandbox, elements } = loadAi();
  sandbox.__task = {
    id: "AIT-2",
    status: "succeeded",
    sourceImageUrl: "https://example.com/source.png",
    resultImageUrl: "https://example.com/result.png"
  };

  vm.runInContext("renderAiImageTaskDetail(__task)", sandbox);

  assert.equal(elements.get("aiImageTaskSourcePreview").src, "https://example.com/source.png");
  assert.equal(elements.get("aiImageTaskResultPreview").src, "https://example.com/result.png");
  assert.ok(!elements.get("aiImageTaskResultPreview").classList.contains("hidden"));
});

test("AI 结果图占位：非法地址退回占位文案", () => {
  const { sandbox } = loadAi();
  const image = makeElement();
  const emptyLabel = makeElement();
  sandbox.__image = image;
  sandbox.__emptyLabel = emptyLabel;

  vm.runInContext("setAiImageTaskResultImage(__image, __emptyLabel, 'javascript:alert(1)')", sandbox);

  assert.equal(image.src, undefined);
  assert.ok(image.classList.contains("hidden"), "图片应隐藏");
  assert.ok(!emptyLabel.classList.contains("hidden"), "应显示占位文案");
});

// --------------------------------------------------------------------- users.js

test("用户表：未知角色标签必须转义后再进 innerHTML", () => {
  const { sandbox, elements } = loadModule(USERS_PATH, ["usersTableBody"], {
    state: { user: { role: "support", companyId: "C1" } },
    isSameCompanyEntity: () => true,
    getRoleLabel: (role) => (role === "support" ? "客服" : role), // 未知角色按原值返回（与 ui.js 一致）
    getEffectiveShopPermissions: () => ({ shopRead: false, shopCreate: false, shopDelete: false, shopToggle: false }),
    normalizeRole: (role) => role
  });
  sandbox.__items = [{ id: "U1", username: "u1", role: "<img src=x onerror=alert(1)>", companyId: "C1" }];

  vm.runInContext("renderUsersTable(__items)", sandbox);

  const html = elements.get("usersTableBody").innerHTML;
  assert.ok(!html.includes("<img"), "不得把原始标签写进 innerHTML");
  assert.ok(html.includes("&lt;img"), "应输出转义后的标签");
});

// ------------------------------------------------------------------------ ui.js

function loadUiWithDom() {
  function makeNode(tag) {
    const classes = new Set();
    const node = {
      tagName: tag,
      className: "",
      childNodes: [],
      parentNode: null,
      style: {},
      tabIndex: 0,
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name)
      },
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      removeEventListener() {},
      focus() {},
      appendChild(child) {
        child.parentNode = node;
        node.childNodes.push(child);
        return child;
      },
      removeChild(child) {
        const index = node.childNodes.indexOf(child);
        if (index >= 0) {
          node.childNodes.splice(index, 1);
          child.parentNode = null;
        }
        return child;
      }
    };
    return node;
  }
  const body = makeNode("body");
  const document = {
    body,
    createElement: makeNode,
    getElementById: () => null,
    querySelectorAll(selector) {
      const wanted = String(selector || "").replace(/^\./, "");
      return body.childNodes.filter((node) => String(node.className).split(/\s+/).includes(wanted));
    },
    addEventListener() {}
  };
  document.querySelector = (selector) => document.querySelectorAll(selector)[0] || null;

  const sandbox = {
    document,
    window: { addEventListener() {} },
    console,
    requestAnimationFrame: (callback) => callback(),
    setTimeout,
    clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(UI_PATH, "utf8"), sandbox, { filename: "ui.js" });
  return { sandbox, document };
}

test("图片预览：关闭时处理全部遮罩（防御历史上叠加出来的残留）", async () => {
  const { sandbox, document } = loadUiWithDom();
  const masks = () => document.querySelectorAll(".order-image-preview-mask");
  // 人为造出两个遮罩（模拟旧实现遗留的叠加状态），closeImagePreview 必须把两个都收掉。
  sandbox.__m1 = Object.assign(document.createElement("div"), { className: "order-image-preview-mask" });
  sandbox.__m2 = Object.assign(document.createElement("div"), { className: "order-image-preview-mask" });
  vm.runInContext("document.body.appendChild(__m1); document.body.appendChild(__m2);", sandbox);
  assert.equal(masks().length, 2);

  vm.runInContext("closeImagePreview()", sandbox);
  await sleep(260);

  assert.equal(masks().length, 0, "两个遮罩都必须被移除，否则会留下吞掉点击的全屏层");
});

test("图片预览：连续打开时任何时刻只有一个遮罩，关闭后不残留", async () => {
  const { sandbox, document } = loadUiWithDom();
  const masks = () => document.querySelectorAll(".order-image-preview-mask");
  sandbox.__src = "https://example.com/a.png";

  // 模拟快速连续点击三张图
  vm.runInContext("openImagePreview(__src); openImagePreview(__src); openImagePreview(__src);", sandbox);

  assert.equal(masks().length, 1, "openImagePreview 必须保证任何时刻只有一个遮罩");

  vm.runInContext("closeImagePreview()", sandbox);
  await sleep(260);

  assert.equal(masks().length, 0, "关闭后不得残留全屏遮罩");
});
