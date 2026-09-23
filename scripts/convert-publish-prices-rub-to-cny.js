const fs = require("fs");
const net = require("net");
const path = require("path");
const mysql = require("mysql2/promise");
const { convertRubPublishPricesToCny } = require("../backend/rub-to-cny-publish-prices");

const root = path.resolve(__dirname, "..");
for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
  const index = line.indexOf("=");
  if (index <= 0 || line.trim().startsWith("#")) continue;
  const key = line.slice(0, index).trim();
  if (process.env[key] === undefined) process.env[key] = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
}

function readMysqlPassword() {
  const passwordFile = String(process.env.MYSQL_PASSWORD_FILE || "").trim();
  if (passwordFile) {
    const target = path.resolve(root, passwordFile);
    if (fs.existsSync(target)) return String(fs.readFileSync(target, "utf8")).replace(/\r?\n$/, "");
  }
  return String(process.env.MYSQL_PASSWORD || "").trim();
}

function argument(name) {
  const prefix = `--${name}=`;
  const entry = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length).trim() : "";
}

function isPortOpen(port = 3000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(600);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

(async () => {
  const shopId = argument("shop-id");
  const apply = process.argv.includes("--apply");
  if (!shopId) throw new Error("Usage: node scripts/convert-publish-prices-rub-to-cny.js --shop-id=SHP-... [--rate=12.34] [--apply]");
  if (apply && await isPortOpen(Number(process.env.PORT || 3000))) {
    throw new Error("正式写入前请先停止 ERP 服务，避免运行中的内存状态覆盖转换结果");
  }
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: readMysqlPassword(),
    database: process.env.MYSQL_DATABASE
  });
  try {
    const [[shop]] = await connection.query("SELECT id, name, shopCurrency FROM shops WHERE id=? LIMIT 1", [shopId]);
    if (!shop) throw new Error(`店铺不存在: ${shopId}`);
    if (String(shop.shopCurrency || "").toUpperCase() !== "CNY") throw new Error("目标店铺的店铺币种必须先设置为 CNY");
    let rate = Number(argument("rate"));
    let rateDate = "manual";
    if (!(rate > 0)) {
      const [[rateRow]] = await connection.query("SELECT rateDate, cnyRateRub FROM exchange_rates_daily WHERE cnyRateRub > 0 ORDER BY rateDate DESC LIMIT 1");
      rate = Number(rateRow?.cnyRateRub);
      rateDate = String(rateRow?.rateDate || "");
    }
    if (!(rate > 0)) throw new Error("没有可用汇率，请通过 --rate=每人民币对应卢布数 指定");
    const [[stateRow]] = await connection.query("SELECT stateJson FROM AppState WHERE stateKey='app_state_v1' LIMIT 1");
    const state = JSON.parse(String(stateRow?.stateJson || "{}"));
    const result = convertRubPublishPricesToCny(state.publishProducts || [], { shopId, cnyRateRub: rate, rateDate });
    console.log(`店铺: ${shop.name || shop.id}`);
    console.log(`汇率: 1 CNY = ${rate} RUB (${rateDate || "无日期"})`);
    console.log(`可转换: ${result.converted} 条，跳过: ${result.skipped} 条`);
    console.table(result.convertedItems.slice(0, 20));
    if (!apply) {
      console.log("当前为预览模式；确认后增加 --apply，并先停止 ERP 服务。");
      return;
    }
    await connection.execute("UPDATE AppState SET stateJson=?, updatedAt=CURRENT_TIMESTAMP(6) WHERE stateKey='app_state_v1'", [JSON.stringify(state)]);
    console.log(`已写入 ${result.converted} 条，请重新启动 ERP 服务。`);
  } finally {
    await connection.end();
  }
})().catch((error) => { console.error(`转换失败: ${String(error.message || error)}`); process.exitCode = 1; });
