const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAiImageTasksModule, resolveTaskConcurrency } = require("./ai-image-tasks");

function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error("Timed out waiting for AI task worker"));
      setTimeout(check, 10);
    };
    check();
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("AI image task concurrency defaults to 3 and rejects unsafe configuration", () => {
  assert.equal(resolveTaskConcurrency(""), 3);
  assert.equal(resolveTaskConcurrency("invalid"), 3);
  assert.equal(resolveTaskConcurrency("5workers"), 3);
  assert.equal(resolveTaskConcurrency("2.5"), 3);
  assert.equal(resolveTaskConcurrency("0"), 3);
  assert.equal(resolveTaskConcurrency("5"), 5);
  assert.equal(resolveTaskConcurrency("100"), 20);
});

test("AI image task worker runs up to the configured number of tasks in parallel", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-task-concurrency-"));
  const previousConcurrency = process.env.AI_IMAGE_TASK_CONCURRENCY;
  process.env.AI_IMAGE_TASK_CONCURRENCY = "3";
  const started = [];
  const releases = new Map();
  let active = 0;
  let maximumActive = 0;
  let nextId = 0;

  const module = createAiImageTasksModule({
    getSqlPool: () => null,
    isSqlReady: () => false,
    getDataDir: () => dataDir,
    makeId: (prefix) => `${prefix}-${++nextId}`,
    checkPermission: () => true,
    requireAuth: () => ({ ok: false }),
    respondApi: () => {},
    parseJsonBody: async () => ({}),
    getMysqlPassword: () => "",
    runImageTask: (task) => new Promise((resolve, reject) => {
      started.push(task.id);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      releases.set(task.id, (succeeds = true) => {
        releases.delete(task.id);
        active -= 1;
        if (!succeeds) reject(new Error("provider rejected one task"));
        else resolve({ ok: true, resultImageUrl: `https://example.test/${task.id}.png` });
      });
    })
  });

  try {
    await module.initialize();
    for (let index = 1; index <= 4; index += 1) {
      await module.createSystemTask({ taskCode: `AIT-CONCURRENCY-${index}`, companyId: "COMPANY-1" });
    }

    await waitFor(() => started.length === 3);
    assert.equal(maximumActive, 3);
    assert.deepEqual(started, ["AIT-CONCURRENCY-1", "AIT-CONCURRENCY-2", "AIT-CONCURRENCY-3"]);

    releases.get("AIT-CONCURRENCY-1")(false);
    await waitFor(() => started.length === 4);
    assert.equal(maximumActive, 3);

    for (const taskId of started.slice(1)) releases.get(taskId)?.();
    const tasksFile = path.join(dataDir, "ai-image-tasks.json");
    const logsFile = path.join(dataDir, "ai-image-task-logs.json");
    await waitFor(() => {
      const tasks = readJson(tasksFile);
      return tasks.length === 4 && tasks.every((task) => task.status === "succeeded" || task.status === "failed");
    });

    const tasks = readJson(tasksFile);
    const logs = readJson(logsFile);
    assert.equal(new Set(started).size, 4, "a queued task must not be claimed twice");
    assert.equal(tasks.find((task) => task.id === "AIT-CONCURRENCY-1").status, "failed");
    assert.ok(tasks.slice(1).every((task) => task.status === "succeeded"));
    assert.ok(logs.some((log) => log.taskId === "AIT-CONCURRENCY-1" && log.stage === "failed"));
    for (let index = 2; index <= 4; index += 1) {
      assert.ok(logs.some((log) => log.taskId === `AIT-CONCURRENCY-${index}` && log.stage === "succeeded"));
    }
  } finally {
    for (const release of [...releases.values()]) release();
    await module.shutdown();
    if (previousConcurrency === undefined) delete process.env.AI_IMAGE_TASK_CONCURRENCY;
    else process.env.AI_IMAGE_TASK_CONCURRENCY = previousConcurrency;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
