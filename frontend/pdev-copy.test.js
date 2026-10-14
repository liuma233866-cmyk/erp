// 商品管理（目录 product-dev）的「文案守门」测试。
//
// 背景：这个页面的用户可见文案曾经整片是开发语言——契约章节号（§11.2）、接口编号（接口 13）、
// HTTP 方法与路径（POST /products/:publicId/sources）、数据库字段名（asset_type=main、
// supply_status=active）、查询参数（?missing=a,b）、以及乐观锁版本号（rowVersion）——
// 全部直接渲染给运营看。文件开头自己定的 §11.4 规则（技术细节只进 title / 折叠区）被静态文案违反了。
//
// 这个测试扫描**去掉注释后的源码文本**（HTML 注释 + JS 行/块注释）：注释里保留契约引用是有价值的
// （给维护者看），只要不渲染给用户就行。它是源码级的代理检查，不是渲染级断言——够用且零成本。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PDEV_DIR = path.join(__dirname, "pages", "product-dev");

// 去掉注释：块注释、行注释（避免误伤 https://）、HTML 注释。
function stripComments(source, isHtml) {
  let text = source;
  if (isHtml) text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/\/\*[\s\S]*?\*\//g, "");
  text = text.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  return text;
}

const FORBIDDEN = [
  { pattern: /§/, label: "契约章节号（§）" },
  { pattern: /接口\s*\d/, label: "接口编号" },
  { pattern: /(GET|POST|PATCH|PUT|DELETE)\s+\/api/, label: "HTTP 方法 + 接口路径" },
  { pattern: /\/products\/:publicId/, label: "接口路径" },
  { pattern: /\?(missing|devStatus|pageSize)=/, label: "接口查询参数" },
  { pattern: /\b(asset_type|supply_status|dev_status|variant_key)\b/, label: "数据库字段名" },
  { pattern: /rowVersion\s*\$/, label: "内部版本号 rowVersion（模板插值）" },
  { pattern: /rowVersion\s*\d/, label: "内部版本号 rowVersion（字面量）" },
  { pattern: /missing\[\]|missing 字段|missing 过滤|服务端 missing/, label: "missing 字段术语" }
];
// 说明：`/api/product-dev`（PDEV_API 常量）与 `expectedRowVersion`（PATCH/状态接口的线上字段）
// 是合法的**代码**，不是文案，因此不作为禁用词；它们是否出现在界面文案里由下面的 HTML 断言兜底。

// 明确的例外：mock 角标只在 ?pdevMock=1 时显示，是给开发者自测用的，允许提到 mock。
const ALLOWED_LINES = [/演示数据/, /pdevMockBadge/, /is-mock/];

function findJargon(file, isHtml) {
  const lines = stripComments(fs.readFileSync(path.join(PDEV_DIR, file), "utf8"), isHtml).split(/\r?\n/);
  const hits = [];
  lines.forEach((line, index) => {
    if (ALLOWED_LINES.some((allowed) => allowed.test(line))) return;
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(line)) {
        hits.push(`${file}:${index + 1} 出现${rule.label} → ${line.trim().slice(0, 120)}`);
      }
    }
  });
  return hits;
}

test("商品管理的界面文案不得出现开发术语（接口/契约/字段名/内部版本号）", () => {
  const hits = [...findJargon("product-dev.js", false), ...findJargon("product-dev.html", true)];
  assert.deepEqual(hits, [], `界面文案里仍残留开发术语：\n${hits.join("\n")}`);
});

test("内部版本号 rowVersion 仍参与逻辑，只是不再展示", () => {
  const source = fs.readFileSync(path.join(PDEV_DIR, "product-dev.js"), "utf8");

  // 去掉展示之后，最容易被顺手删掉的就是它真正的用途：乐观锁。
  // 两个写操作（保存资料 / 推进状态）都必须携带 expectedRowVersion，否则并发保护静默失效。
  const guarded = source.match(/expectedRowVersion:\s*Number\(product\.rowVersion/g) || [];
  assert.equal(guarded.length, 2, "保存资料与状态推进都必须携带 expectedRowVersion");

  // 但静态界面文案里不得再出现它（页面 HTML 是用户直接看到的）。
  const html = fs.readFileSync(path.join(PDEV_DIR, "product-dev.html"), "utf8");
  assert.doesNotMatch(html, /rowVersion|expectedRowVersion/, "界面文案不得展示内部版本号");
});

test("状态推进按钮的悬停说明是业务语言（不含字段名）", () => {
  const source = fs.readFileSync(path.join(PDEV_DIR, "product-dev.js"), "utf8");
  const block = /const PDEV_TRANSITION_RULE = \{[\s\S]*?\n\};/.exec(source);
  assert.ok(block, "应能找到 PDEV_TRANSITION_RULE");
  assert.doesNotMatch(block[0], /supply_status|asset_type|允许来源|new \/ developing/);
  assert.match(block[0], /主图/, "应说明推进到「资料齐备」需要主图");
});

// 契约 §11.7：missing 只出现在列表项 ProductSummary，单个产品 {product} 不含 missing 键。
// 前端一度在详情里读 product.missing，于是只能永远显示「缺口未知」——那是前端违约，不是后端缺字段。
test("前端不得从单个产品 payload 读 missing（契约 §11.7）", () => {
  const source = fs.readFileSync(path.join(PDEV_DIR, "product-dev.js"), "utf8");
  assert.doesNotMatch(source, /\bproduct\.missing\b/, "单个产品载荷没有 missing 键，不得读取");
  // 列表项与错误体上的 missing 是契约允许的，必须仍然被使用。
  assert.match(source, /\bitem\.missing\b/, "列表项 missing 仍须使用（§11.1）");
});
