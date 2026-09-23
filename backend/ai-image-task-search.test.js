const test = require("node:test");
const assert = require("node:assert/strict");
const { matchesAiImageTaskQuery } = require("./ai-image-tasks");

test("AI image task search matches a task code case-insensitively", () => {
  const task = {
    id: "AIT-MT19PK5P-B390",
    status: "succeeded",
    modelId: "MODEL-QWEN",
    sourceType: "publish_product"
  };

  assert.equal(matchesAiImageTaskQuery(task, { keyword: "mt19pk5p" }), true);
  assert.equal(matchesAiImageTaskQuery(task, { keyword: "missing-code" }), false);
});

test("AI image task search matches SKU fields stored in task metadata", () => {
  const task = {
    id: "AIT-MT19PK5P-B390",
    metadataJson: JSON.stringify({
      sourceSku: "SOURCE-SKU-001",
      systemSku: "SYSTEM-SKU-002",
      platformSku: "PLATFORM-SKU-003",
      variantSku: "VARIANT-SKU-004"
    })
  };

  for (const keyword of ["source-sku-001", "system-sku-002", "platform-sku-003", "variant-sku-004"]) {
    assert.equal(matchesAiImageTaskQuery(task, { keyword }), true, `expected ${keyword} to match`);
  }
});

test("AI image task search reads keyword from URLSearchParams used by the HTTP route", () => {
  const task = { id: "AIT-ROUTE-SEARCH-001" };
  const query = new URLSearchParams("keyword=route-search");

  assert.equal(matchesAiImageTaskQuery(task, query), true);
  query.set("keyword", "not-found");
  assert.equal(matchesAiImageTaskQuery(task, query), false);
});

test("AI image task SKU and task-code search does not match descriptive fields", () => {
  const task = {
    id: "AIT-001",
    title: "Product mentions PUB-NOT-A-SKU",
    prompt: "Generate an image for PROMPT-NOT-A-SKU",
    errorMessage: "ERROR-NOT-A-SKU"
  };

  assert.equal(matchesAiImageTaskQuery(task, { keyword: "PUB-NOT-A-SKU" }), false);
  assert.equal(matchesAiImageTaskQuery(task, { keyword: "PROMPT-NOT-A-SKU" }), false);
  assert.equal(matchesAiImageTaskQuery(task, { keyword: "ERROR-NOT-A-SKU" }), false);
});
