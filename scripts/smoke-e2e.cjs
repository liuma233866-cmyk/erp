#!/usr/bin/env node
"use strict";
/**
 * erp 端到端冒烟回归基线。
 *
 * 覆盖链路：启动/健康 → 登录 → 订单同步 → CBR 汇率 → 类目费率快照 → 刊登（Yandex 三步）
 *
 * 刊登段落不碰真实店铺：脚本会另起一个实例（默认 3100），把 YANDEX_MARKET_BASE_URL
 * 指向本进程内的 mock（默认 3199），并新建一条专用测试草稿，跑完即删除、设置复原。
 *
 * 用法：
 *   SMOKE_USER=admin SMOKE_PASS=*** node scripts/smoke-e2e.cjs
 *   node scripts/smoke-e2e.cjs --skip-phase-a            # 只跑 mock 段（不触外部平台）
 *   node scripts/smoke-e2e.cjs --skip-sync               # 跳过订单同步（只读外部链路）
 *   node scripts/smoke-e2e.cjs --base http://127.0.0.1:3000 --report logs/smoke-report.json
 *
 * 退出码：0 = 全部通过；1 = 存在断点；2 = 用法/前置条件错误。
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");

function parseArgs(argv) {
  const args = { base: "http://127.0.0.1:3000", mockPort: 3199, publishPort: 3100, report: path.join(ROOT, "logs", "smoke-report.json") };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];
    switch (token) {
      case "--base": args.base = value; i += 1; break;
      case "--mock-port": args.mockPort = Number(value); i += 1; break;
      case "--publish-port": args.publishPort = Number(value); i += 1; break;
      case "--report": args.report = value; i += 1; break;
      case "--skip-phase-a": args.skipPhaseA = true; break;
      case "--skip-sync": args.skipSync = true; break;
      case "--verbose": args.verbose = true; break;
      case "--help": args.help = true; break;
      default:
        if (token.startsWith("--")) { console.error(`未知参数: ${token}`); args.help = true; }
    }
  }
  return args;
}

const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.help) {
  console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\*\*?/, "").trim());
  process.exit(0);
}

const USER = process.env.SMOKE_USER || "";
const PASS = process.env.SMOKE_PASS || "";
const SERVER_LOG = path.join(ROOT, "logs", "smoke-publish-server.log");
const MOCK_CAPTURE = path.join(ROOT, "logs", "smoke-mock-capture.json");

const results = [];
const mockRequests = [];

function record(step, status, detail, ms) {
  results.push({ step, status, detail, ms: ms || 0 });
  console.log(`[${status}] ${step}${ms ? ` (${ms}ms)` : ""}${detail ? ` :: ${detail}` : ""}`);
}
function firstLine(text, max = 300) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

async function call(pathname, { method = "GET", token = "", cookie = "", body, timeoutMs = 30000, base = ARGS.base } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: response.status, ok: response.ok, text, json: parsed, setCookie: response.headers.get("set-cookie") || "" };
}

async function login(base) {
  const res = await call("/api/login", { method: "POST", body: { username: USER, password: PASS }, base });
  const token = res.json?.token || res.json?.sessionToken || "";
  if (ARGS.verbose) {
    console.log(`      login: status=${res.status} keys=${res.json ? Object.keys(res.json).join(",") : "-"} tokenLen=${token.length}`);
  }
  return { token, cookie: res.setCookie.split(";")[0], res };
}

async function waitForHealth(base, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await call("/health", { timeoutMs: 3000, base });
      if (res.ok && res.json?.sqlReady) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function startMock(port) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      mockRequests.push({ method: req.method, url: req.url, bytes: raw.length, body: raw.slice(0, 4000) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "OK", result: { parameters: [], offerMappings: [], offers: [] } }));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function summarize() {
  const failed = results.filter((r) => r.status === "FAIL");
  console.log("\n== 冒烟汇总 ==");
  for (const r of results) console.log(`  ${r.status.padEnd(4)} ${r.step}`);
  if (failed.length) console.log(`\n第一个断点：${failed[0].step} :: ${failed[0].detail}`);
  else console.log("\n本次执行的全部步骤通过。");
  return failed;
}

function writeReport(failed) {
  const report = {
    startedAt: new Date().toISOString(),
    base: ARGS.base,
    skipPhaseA: Boolean(ARGS.skipPhaseA),
    skipSync: Boolean(ARGS.skipSync),
    results,
    mockRequests,
    firstBreakPoint: failed.length ? { step: failed[0].step, detail: failed[0].detail } : null
  };
  try {
    fs.mkdirSync(path.dirname(ARGS.report), { recursive: true });
    fs.writeFileSync(ARGS.report, JSON.stringify(report, null, 2));
    fs.mkdirSync(path.dirname(MOCK_CAPTURE), { recursive: true });
    fs.writeFileSync(MOCK_CAPTURE, JSON.stringify(mockRequests, null, 2));
    console.log(`\n报告：${path.relative(ROOT, ARGS.report)}　mock 捕获：${path.relative(ROOT, MOCK_CAPTURE)}`);
  } catch (error) {
    console.log(`写报告失败：${String(error.message)}`);
  }
}

async function runPhaseA() {
  console.log(`== Phase A：真实环境（${ARGS.base}）==`);
  let t = Date.now();
  const health = await call("/health");
  record("A1 健康检查", health.ok && health.json?.mysqlHealthy ? "PASS" : "FAIL",
    `status=${health.status} sqlReady=${health.json?.sqlReady} mysqlHealthy=${health.json?.mysqlHealthy}`, Date.now() - t);

  t = Date.now();
  const loginA = await login(ARGS.base);
  record("A2 登录", loginA.token ? "PASS" : "FAIL",
    loginA.token ? `tokenLen=${loginA.token.length} cookie=${loginA.cookie ? "有" : "无"}` : `status=${loginA.res.status} ${firstLine(loginA.res.text)}`, Date.now() - t);
  if (!loginA.token) return { token: "", cookie: "" };

  t = Date.now();
  const profile = await call("/api/profile", { token: loginA.token, cookie: loginA.cookie });
  record("A3 取当前用户", profile.ok && profile.json?.username ? "PASS" : "FAIL",
    profile.ok ? `username=${profile.json?.username} role=${profile.json?.role}` : `status=${profile.status}`, Date.now() - t);

  if (ARGS.skipSync) {
    record("A4 订单同步", "SKIP", "--skip-sync 已指定", 0);
  } else {
    t = Date.now();
    try {
      const syncRes = await call("/api/orders/sync", { method: "POST", token: loginA.token, cookie: loginA.cookie, body: {}, timeoutMs: 300000 });
      const s = syncRes.json || {};
      const errorCount = Array.isArray(s.errors) ? s.errors.length : 0;
      record("A4 订单同步", syncRes.ok ? "PASS" : "FAIL",
        `status=${syncRes.status} added=${s.added ?? "-"} updated=${s.updated ?? "-"} skipped=${s.skipped ?? "-"} errors=${errorCount}${syncRes.ok ? "" : ` ${firstLine(syncRes.text)}`}`, Date.now() - t);
      for (const e of (Array.isArray(s.errors) ? s.errors.slice(0, 4) : [])) console.log(`      sync error: shop=${e.shopId || "-"} ${firstLine(e.message, 220)}`);
    } catch (error) {
      record("A4 订单同步", "FAIL", `请求异常: ${error.name === "TimeoutError" ? "超时(300s)" : String(error.message)}`, Date.now() - t);
    }
  }

  t = Date.now();
  try {
    const cbr = await call("/api/rates/cbr", { token: loginA.token, cookie: loginA.cookie });
    record("A5 CBR 汇率", cbr.ok ? "PASS" : "FAIL", `status=${cbr.status} ${cbr.ok ? firstLine(JSON.stringify(cbr.json), 160) : firstLine(cbr.text)}`, Date.now() - t);
  } catch (error) {
    record("A5 CBR 汇率", "FAIL", String(error.message), Date.now() - t);
  }

  t = Date.now();
  try {
    const commission = await call("/api/market-category-commissions?platform=yandex&page=1&pageSize=3", { token: loginA.token, cookie: loginA.cookie });
    record("A6 类目费率快照", commission.ok ? "PASS" : "FAIL",
      `status=${commission.status} total=${commission.json?.total ?? commission.json?.items?.length ?? "-"}`, Date.now() - t);
  } catch (error) {
    record("A6 类目费率快照", "FAIL", String(error.message), Date.now() - t);
  }

  return { token: loginA.token, cookie: loginA.cookie };
}

async function runPhaseB() {
  console.log(`\n== Phase B：本地 mock 接管 Yandex API（实例 ${ARGS.publishPort} → mock ${ARGS.mockPort}）==`);
  let mockServer = null;
  let child = null;
  const publishBase = `http://127.0.0.1:${ARGS.publishPort}`;
  try {
    mockServer = await startMock(ARGS.mockPort);
    fs.mkdirSync(path.dirname(SERVER_LOG), { recursive: true });
    fs.writeFileSync(SERVER_LOG, `[${new Date().toISOString()}] smoke publish instance start\n`);
    const out = fs.openSync(SERVER_LOG, "a");
    child = spawn(process.execPath, [path.join(ROOT, "backend", "server.js")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(ARGS.publishPort), YANDEX_MARKET_BASE_URL: `http://127.0.0.1:${ARGS.mockPort}` },
      stdio: ["ignore", out, out]
    });

    let t = Date.now();
    const ready = await waitForHealth(publishBase);
    record("B1 启动 mock 实例", ready ? "PASS" : "FAIL", ready ? `${publishBase} 就绪，Yandex 端点指向 mock` : `45s 内未就绪，见 ${path.relative(ROOT, SERVER_LOG)}`, Date.now() - t);
    if (!ready) return;

    t = Date.now();
    const loginB = await login(publishBase);
    record("B2 mock 实例登录", loginB.token ? "PASS" : "FAIL", loginB.token ? `tokenLen=${loginB.token.length}` : `status=${loginB.res.status} ${firstLine(loginB.res.text)}`, Date.now() - t);
    if (!loginB.token) return;

    const auth = { token: loginB.token, cookie: loginB.cookie, base: publishBase };

    t = Date.now();
    const profileB = await call("/api/profile", auth);
    record("B3 鉴权回验", profileB.ok ? "PASS" : "FAIL", profileB.ok ? `username=${profileB.json?.username}` : `status=${profileB.status}`, Date.now() - t);

    t = Date.now();
    const listRes = await call("/api/product-publish", auth);
    const shopsRes = await call("/api/shops", auth);
    const items = Array.isArray(listRes.json?.items) ? listRes.json.items : [];
    const shops = Array.isArray(shopsRes.json?.items) ? shopsRes.json.items : Array.isArray(shopsRes.json?.shops) ? shopsRes.json.shops : [];
    const publishableShopIds = new Set(shops.filter((s) => s.provider === "yandex_market" && s.enabled).map((s) => String(s.id || "")));
    const template = items.find((i) => publishableShopIds.has(String(i.shopId || "")) && String(i.lastPublishStatus || "") === "success" && i.sku && i.title && i.imageUrl);
    const statusDist = {};
    for (const i of items) {
      const s = String(i.lastPublishStatus || i.publishStatus || "(empty)");
      statusDist[s] = (statusDist[s] || 0) + 1;
    }
    record("B4 读取刊登工作台", template ? "PASS" : "FAIL",
      `工作台 ${items.length} 条 状态=${JSON.stringify(statusDist)}` + (template ? ` → 模板 ${template.id} (shop=${template.shopId})` : " → 无可克隆的成功草稿"), Date.now() - t);
    if (!template) return;

    t = Date.now();
    const smokeSku = `SMOKE-${Date.now().toString(36).toUpperCase()}`;
    const createRes = await call("/api/product-publish", {
      ...auth, method: "POST",
      body: {
        item: {
          ...template,
          id: undefined, shopName: undefined, platformSku: undefined,
          sku: smokeSku, title: `SMOKE TEST ${smokeSku}`,
          publishStatus: "", lastPublishStatus: "", lastPublishAt: "", publishAt: "", publishResultMessage: ""
        }
      }
    });
    const testId = createRes.json?.item?.id || "";
    record("B5 创建测试草稿", testId ? "PASS" : "FAIL", testId ? `${testId} sku=${smokeSku} shop=${createRes.json?.item?.shopId}` : `status=${createRes.status} ${firstLine(createRes.text)}`, Date.now() - t);
    if (!testId) return;

    t = Date.now();
    const settings = await call("/api/product-publish/settings", auth);
    const originalSettings = settings.json?.settings || {};
    record("B6 读取刊登设置", settings.ok ? "PASS" : "FAIL",
      `simulateBackendPublishToYandex=${originalSettings.simulateBackendPublishToYandex}（原值，稍后恢复）`, Date.now() - t);

    t = Date.now();
    const toggle = await call("/api/product-publish/settings", {
      ...auth, method: "PUT", body: { settings: { ...originalSettings, simulateBackendPublishToYandex: true } }
    });
    record("B7 打开 simulate 开关", toggle.ok && toggle.json?.settings?.simulateBackendPublishToYandex === true ? "PASS" : "FAIL",
      `status=${toggle.status} 现在=${toggle.json?.settings?.simulateBackendPublishToYandex}`, Date.now() - t);

    t = Date.now();
    try {
      const publishRes = await call("/api/product-publish/publish-yandex", { ...auth, method: "POST", body: { ids: [testId] }, timeoutMs: 120000 });
      const p = publishRes.json || {};
      const mode = p.results?.[0]?.details?.simulation ? "simulate(逐条串行)" : "batched(批量)";
      record("B8 刊登上架（mock）", publishRes.ok ? "PASS" : "FAIL",
        `status=${publishRes.status} 模式=${mode} success=${p.success ?? "-"} failed=${p.failed ?? "-"}${publishRes.ok ? "" : ` ${firstLine(publishRes.text)}`}`, Date.now() - t);
      for (const e of (Array.isArray(p.errors) ? p.errors.slice(0, 2) : [])) console.log(`      publish error: ${firstLine(JSON.stringify(e), 300)}`);
    } catch (error) {
      record("B8 刊登上架（mock）", "FAIL", `请求异常: ${error.name === "TimeoutError" ? "超时(120s)" : String(error.message)}`, Date.now() - t);
    }

    t = Date.now();
    const restore = await call("/api/product-publish/settings", { ...auth, method: "PUT", body: { settings: { ...originalSettings } } });
    record("B9 恢复刊登设置", restore.ok ? "PASS" : "FAIL", `simulate 恢复为 ${restore.json?.settings?.simulateBackendPublishToYandex}`, Date.now() - t);

    t = Date.now();
    const delRes = await call("/api/product-publish", { ...auth, method: "DELETE", body: { ids: [testId] } });
    record("B10 清理测试草稿", delRes.ok ? "PASS" : "FAIL", `status=${delRes.status} ${firstLine(delRes.text, 120)}`, Date.now() - t);

    console.log("\n== mock 捕获到的 Yandex 调用 ==");
    if (!mockRequests.length) console.log("  （没有任何请求到达 mock）");
    for (const r of mockRequests) {
      let shape = "";
      try {
        const parsed = JSON.parse(r.body);
        if (Array.isArray(parsed.offerMappings)) shape = `offerMappings=${parsed.offerMappings.length}`;
        else if (Array.isArray(parsed.offers)) shape = `offers=${parsed.offers.length}`;
        else if (Array.isArray(parsed.skus)) shape = `skus=${parsed.skus.length}`;
      } catch { /* ignore */ }
      console.log(`  ${r.method} ${r.url} bytes=${r.bytes} ${shape}`);
    }
  } catch (error) {
    record("Phase B", "FAIL", String(error?.stack || error));
  } finally {
    if (child) { try { child.kill(); } catch { /* ignore */ } }
    if (mockServer) { try { mockServer.close(); } catch { /* ignore */ } }
  }
}

(async () => {
  if (!USER || !PASS) {
    console.error("缺少 SMOKE_USER / SMOKE_PASS（本地登录账号），无法执行冒烟。");
    process.exit(2);
  }
  if (!ARGS.skipPhaseA) await runPhaseA();
  else console.log("== 跳过 Phase A（--skip-phase-a）==");
  await runPhaseB();
  const failed = summarize();
  writeReport(failed);
  setTimeout(() => process.exit(failed.length ? 1 : 0), 500);
})().catch((error) => {
  console.error("SMOKE_FAILED", String(error?.stack || error));
  process.exit(1);
});
