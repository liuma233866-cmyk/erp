const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTaskMysqlConnectionOptions } = require("./ai-image-tasks");

test("AI task completion connection uses injected password and UTC", () => {
  const options = buildTaskMysqlConnectionOptions({
    MYSQL_HOST: "db",
    MYSQL_PORT: "3307",
    MYSQL_USER: "erp_app",
    MYSQL_PASSWORD: "wrong-env-password",
    MYSQL_DATABASE: "erp"
  }, "password-from-file");

  assert.equal(options.password, "password-from-file");
  assert.equal(options.timezone, "Z");
  assert.equal(options.port, 3307);
});
