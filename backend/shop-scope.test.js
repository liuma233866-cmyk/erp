// 店铺范围（shop scope）回归测试。
//
// 核心不变量：受店铺限制的角色在「没有任何可见店铺」时，可见集合必须是**空**，
// 绝不能退化成「全部」。空分配与不受限制是两种不同状态，前者只能由 admin 之外
// 的角色产生，后者仅 admin 独有（getUserAssignedShopIds 返回 null）。
//
// 历史缺陷：filterOrdersByAssignments / filterOnlineProductsByAssignments 把
// 空数组当成「不过滤」直接返回全集，而 /api/orders/purchase-export 又漏了调用方
// 的空数组分支，导致零分配的受限用户能导出全部店铺的订单。
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canUserAccessShop,
  filterOnlineProductsByAssignments,
  filterOrdersByAssignments,
  getUserAssignedShopIds
} = require("./shop-scope");
const { createOrdersRoutes } = require("./routes/orders");
const { ROLE_ADMIN, ROLE_FINANCE, ROLE_SUPPORT } = require("./permissions");

const SHOPS = [
  { id: "SHOP-A", name: "A 店", campaignId: "111", companyId: "C1" },
  { id: "SHOP-B", name: "B 店", campaignId: "222", companyId: "C1" }
];
const ORDERS = [
  { id: "ORD-A", shopId: "SHOP-A", shopOrderNo: "A-1" },
  { id: "ORD-B", shopId: "SHOP-B", shopOrderNo: "B-1" }
];

// ---------------------------------------------------------------------------
// 纯函数层：空分配必须 fail closed
// ---------------------------------------------------------------------------

test("空分配列表 fail closed：返回空集合，而不是全部", () => {
  assert.deepEqual(filterOrdersByAssignments(ORDERS, [], SHOPS), []);
  assert.deepEqual(filterOnlineProductsByAssignments(ORDERS, [], SHOPS), []);
});

test("非数组分配列表同样 fail closed", () => {
  assert.deepEqual(filterOrdersByAssignments(ORDERS, undefined, SHOPS), []);
  assert.deepEqual(filterOrdersByAssignments(ORDERS, null, SHOPS), []);
  assert.deepEqual(filterOnlineProductsByAssignments(ORDERS, undefined, SHOPS), []);
});

test("有分配时三种匹配方式仍然生效（shopId / campaignId / shopName）", () => {
  assert.deepEqual(
    filterOrdersByAssignments(ORDERS, ["SHOP-A"], SHOPS).map((order) => order.id),
    ["ORD-A"]
  );
  // 订单自身没有 shopId，只能靠 campaignId 归属到店铺
  const byCampaign = [{ id: "ORD-C", account: "222" }];
  assert.deepEqual(
    filterOrdersByAssignments(byCampaign, ["SHOP-B"], SHOPS).map((order) => order.id),
    ["ORD-C"]
  );
  // 订单自身没有 shopId/campaignId，只能靠店铺名归属
  const byName = [{ id: "ORD-D", shopName: "A 店" }];
  assert.deepEqual(
    filterOrdersByAssignments(byName, ["SHOP-A"], SHOPS).map((order) => order.id),
    ["ORD-D"]
  );
});

test("分配指向已被删除的店铺时，用户可见范围为空而不是全部", () => {
  // 这是最现实的触发路径：店铺被删除后 normalizeShopAssignments 会把失效 id 过滤掉。
  const staleUser = { id: "U-STALE", role: ROLE_SUPPORT, companyId: "C1", shopAssignments: ["SHOP-DELETED"] };
  const assigned = getUserAssignedShopIds(staleUser, SHOPS);
  assert.deepEqual(assigned, []);
  assert.deepEqual(filterOrdersByAssignments(ORDERS, assigned, SHOPS), []);
});

test("受限角色零分配时不授予任何店铺访问，admin 仍不受限制", () => {
  for (const role of [ROLE_SUPPORT, ROLE_FINANCE]) {
    const restricted = { id: `U-${role}`, role, companyId: "C1", shopAssignments: [] };
    assert.deepEqual(getUserAssignedShopIds(restricted, SHOPS), []);
    assert.equal(canUserAccessShop(restricted, "SHOP-A", SHOPS), false);
  }
  const admin = { id: "U-ADMIN", role: ROLE_ADMIN, companyId: "C1", shopAssignments: [] };
  assert.equal(getUserAssignedShopIds(admin, SHOPS), null);
  assert.equal(canUserAccessShop(admin, "SHOP-A", SHOPS), true);
});

// ---------------------------------------------------------------------------
// 路由层：/api/orders/purchase-export 不得泄漏跨店订单
// ---------------------------------------------------------------------------

const XLSX = require("xlsx");

function createOrdersHarness(db, user) {
  const deps = {
    authService: {
      requireAuth: () => ({ ok: true, user }),
      checkPermission: () => true
    },
    respondApi: (req, res, actorUser, auditContext, statusCode, payload) => {
      res.statusCode = statusCode;
      res.payload = payload;
    },
    getDb: () => db,
    XLSX,
    writeAudit: () => {},
    getUserAssignedShopIds,
    filterOrdersByAssignments,
    filterOnlineProductsByAssignments,
    canUserAccessShop
  };
  return createOrdersRoutes(deps);
}

async function exportOrders(routes) {
  const route = routes.find((entry) => entry.matches("/api/orders/purchase-export", "GET"));
  assert.ok(route, "purchase-export route not found");
  const chunks = [];
  const res = {
    statusCode: null,
    writeHead(status) { res.statusCode = status; },
    setHeader() {},
    end(chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); }
  };
  await route.handler({ method: "GET", url: "/api/orders/purchase-export", headers: {} }, res, {}, {});
  const buffer = Buffer.concat(chunks);
  let rows = [];
  if (buffer.length) {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
  }
  return { status: res.statusCode, payload: res.payload, rows };
}

test("purchase-export：零分配的受限角色导出为空，不带出任何店铺的订单", async () => {
  const user = { id: "U-EXPORT-EMPTY", role: ROLE_SUPPORT, companyId: "C1", shopAssignments: [] };
  const { status, rows } = await exportOrders(createOrdersHarness({ shops: SHOPS, orders: ORDERS }, user));
  assert.equal(status, 200, "仍应返回一个合法的空表，而不是错误");
  assert.deepEqual(rows, [], "零分配用户不应看到任何订单");
});

test("purchase-export：只导出被分配店铺的订单", async () => {
  const user = { id: "U-EXPORT-SCOPED", role: ROLE_FINANCE, companyId: "C1", shopAssignments: ["SHOP-A"] };
  const { status, rows } = await exportOrders(createOrdersHarness({ shops: SHOPS, orders: ORDERS }, user));
  assert.equal(status, 200);
  assert.equal(rows.length, 1, "只应有 A 店的一条订单");
  assert.equal(String(rows[0]["订单号"]), "A-1");
});

test("purchase-export：admin 不受店铺限制，能看到全部订单", async () => {
  const user = { id: "U-EXPORT-ADMIN", role: ROLE_ADMIN, companyId: "C1", shopAssignments: [] };
  const { status, rows } = await exportOrders(createOrdersHarness({ shops: SHOPS, orders: ORDERS }, user));
  assert.equal(status, 200);
  assert.equal(rows.length, 2, "admin 应看到两个店铺的订单");
});
