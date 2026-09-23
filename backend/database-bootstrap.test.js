const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveInitialDatabase } = require("./database-bootstrap");

test("uses persisted AppState without creating bootstrap credentials", () => {
  let bootstrapCalls = 0;
  const persisted = { users: [{ username: "existing-admin" }] };
  const result = resolveInitialDatabase([persisted], {
    createDefaultDatabase: () => {
      bootstrapCalls += 1;
      return { users: [{ username: "new-admin" }] };
    },
    normalizeDatabase: (value) => value
  });

  assert.equal(bootstrapCalls, 0);
  assert.equal(result.created, false);
  assert.equal(result.database, persisted);
});

test("creates bootstrap credentials only when AppState is empty", () => {
  let bootstrapCalls = 0;
  const created = { users: [{ username: "new-admin" }] };
  const result = resolveInitialDatabase([], {
    createDefaultDatabase: () => {
      bootstrapCalls += 1;
      return created;
    },
    normalizeDatabase: (value) => value
  });

  assert.equal(bootstrapCalls, 1);
  assert.equal(result.created, true);
  assert.equal(result.database, created);
});
