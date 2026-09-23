const test = require("node:test");
const assert = require("node:assert/strict");
const { hydratePayloadRow, sessionSqlValues, userSqlValues } = require("./sql-identity-store");

test("roundtrips user extension fields through payloadJson", () => {
  const user = { id: "u1", username: "admin", passwordHash: "hash", passwordSalt: "salt", role: "admin", shopAssignments: ["s1"] };
  const values = userSqlValues(user);
  assert.equal(values.length, 10);
  assert.deepEqual(hydratePayloadRow({ id: values[0], username: values[1], shopPermissions: values[8], shopAssignments: values[9] }).shopAssignments, ["s1"]);
  assert.equal(typeof values[7], "string");
});

test("roundtrips session identity and expiry", () => {
  // Sessions are persisted as SHA-256 token hashes; the plaintext token never
  // reaches storage.
  const values = sessionSqlValues({ tokenHash: "h1", userId: "u1", expiresAt: 123 });
  assert.deepEqual(values.slice(0, 3), ["h1", "u1", 123]);
});
