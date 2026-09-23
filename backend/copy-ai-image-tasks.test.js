const test = require("node:test");
const assert = require("node:assert/strict");
const { createCopyAiImageTasks } = require("./copy-ai-image-tasks");

test("retries a previously missing image when the copied product now has one", async () => {
  const item = {
    id: "PUB-1", sourceOnlineProductId: "ONLINE-1", shopId: "TARGET", publishPlatform: "ozon",
    sku: "SKU-1", platformSku: "SKU-1", imageUrl: "https://example.com/new.jpg",
    aiTaskIdsBySku: { "SKU-1": "missing_source_image" }
  };
  const created = [];
  const result = await createCopyAiImageTasks({
    items: [item], companyId: "COMPANY-1", defaultPrompt: "prompt",
    buildTaskCode: () => "TASK-CODE",
    createSystemTask: async (input) => { created.push(input); return { ok: true, item: { id: "AIT-1" } }; }
  });

  assert.deepEqual(result.aiTasks, ["AIT-1"]);
  assert.equal(item.aiTaskIdsBySku["SKU-1"], "AIT-1");
  assert.equal(created[0].companyId, "COMPANY-1");
  assert.equal(JSON.parse(created[0].metadataJson).sourcePlatform, "ozon");
});

test("keeps creating tasks after one SKU fails", async () => {
  const items = ["A", "B"].map((sku) => ({ id: `PUB-${sku}`, sourceOnlineProductId: `ONLINE-${sku}`, shopId: "TARGET", sku, platformSku: sku, imageUrl: `https://example.com/${sku}.jpg` }));
  const result = await createCopyAiImageTasks({
    items, companyId: "COMPANY-1", defaultPrompt: "prompt",
    buildTaskCode: (item) => `TASK-${item.sku}`,
    createSystemTask: async (input) => input.taskCode === "TASK-A"
      ? (() => { throw new Error("database unavailable"); })()
      : { ok: true, item: { id: "AIT-B" } }
  });

  assert.deepEqual(result.aiTasks, ["AIT-B"]);
  assert.equal(items[0].aiImageStatus, "failed");
  assert.match(items[0].aiImageError, /database unavailable/);
  assert.equal(items[1].aiImageStatus, "queued");
});

test("supports main-only and none AI modes", async () => {
  const makeItem = () => ({ id: "PUB-MODES", sourceOnlineProductId: "ONLINE-MODES", shopId: "TARGET", variants: [
    { sku: "MAIN", imageUrl: "https://example.com/main.jpg" },
    { sku: "ALT", imageUrl: "https://example.com/alt.jpg" }
  ] });
  const calls = [];
  await createCopyAiImageTasks({ items: [makeItem()], companyId: "C", defaultPrompt: "p", aiMode: "main", buildTaskCode: (item) => item.sku, createSystemTask: async (input) => { calls.push(input); return { ok: true, item: { id: input.taskCode } }; } });
  assert.deepEqual(calls.map((call) => call.taskCode), ["MAIN"]);
  const skipped = makeItem();
  const result = await createCopyAiImageTasks({ items: [skipped], companyId: "C", defaultPrompt: "p", aiMode: "none", buildTaskCode: () => "NO", createSystemTask: async () => { throw new Error("must not run"); } });
  assert.deepEqual(result.aiTasks, []);
  assert.equal(skipped.aiImageStatus, "skipped");
});
