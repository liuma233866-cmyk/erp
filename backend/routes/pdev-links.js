// SKU 关系管理：商品管理商品（A2） ↔ 店铺在线产品（A1）的人工绑定关系。
// 独立模块，自带建表；写操作要求 pdev.write，全部进审计。
"use strict";

const nodeCrypto = require("crypto");
const nodeFs = require("fs");
const nodePath = require("path");
// 【task-18】导入模板下载：优先真 .xlsx（复用项目已有的 xlsx 依赖）；拿不到就退化成带 BOM 的 CSV。
let XLSX = null;
try { XLSX = require("xlsx"); } catch { XLSX = null; }

// 导入模板列（【task-22】在「店铺账户」后加「店铺ID」，用于跨店铺重名时更稳地消歧）
const IMPORT_TEMPLATE_COLUMNS = ["店铺SKU", "商品SKU", "店铺账户", "店铺ID", "数量", "备注"];

// ==================================================================
// 【task-20】导入解析/校验的纯工具（不碰数据库，便于单测/复用）
// ==================================================================
const UPLOAD_ROOT = nodePath.join(__dirname, "..", "..", "frontend", "uploads");
// 【task-28】导出文件落盘目录：**独立于 uploads**（用户导入的文件不混层），同样在 frontend 下 → 可被静态服务直接下载
const EXPORT_ROOT = nodePath.join(__dirname, "..", "..", "frontend", "exports");
const IMPORT_REQUIRED_COLUMNS = ["店铺SKU", "商品SKU"];
const IMPORT_OPTIONAL_COLUMNS = ["店铺账户", "数量", "备注", "店铺ID"];
const IMPORT_MAX_ROWS = 5000;
const IMPORT_REASON_LIMIT = 1024;
const IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const IMPORT_STATUS_OK = "处理成功";
const IMPORT_STATUS_PARTIAL = "部分成功";
const IMPORT_STATUS_FAIL = "处理失败";
const IMPORT_STATUS_PROCESSING = "处理中";

// 【task-28】导出历史表：字段参照 pdev_import_files（导出不需要 ok/fail/skipped 三列，
//   只保留 total_rows 表示这次导出了多少条）。同样是惰性 ensure，CREATE TABLE IF NOT EXISTS，不 DROP/重建。
const EXPORT_FILES_DDL = `CREATE TABLE IF NOT EXISTS pdev_export_files (
  id VARCHAR(40) NOT NULL,
  company_key VARCHAR(128) NOT NULL,
  file_name VARCHAR(255) NULL,
  file_url VARCHAR(1024) NULL,
  created_by VARCHAR(128) NULL,
  status VARCHAR(32) NULL,
  progress INT NOT NULL DEFAULT 0,
  failure_reason VARCHAR(1024) NULL,
  total_rows INT NULL,
  created_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_export_created (created_at),
  KEY idx_export_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

function makeExportId() {
  return "EXP-" + nodeCrypto.randomBytes(8).toString("hex").toUpperCase();
}

function mapExportFileRow(r) {
  return {
    id: r.id,
    fileName: r.file_name,
    fileUrl: r.file_url,
    createdBy: r.created_by,
    status: r.status,
    progress: r.progress === null || r.progress === undefined ? 0 : Number(r.progress),
    failureReason: r.failure_reason,
    totalRows: r.total_rows === null || r.total_rows === undefined ? null : Number(r.total_rows),
    createdAt: r.created_at,
    finishedAt: r.finished_at
  };
}

// 从备注里取回数量：note 形如「商品名 x2」→ 2；取不到就 1
function quantityFromNote(note) {
  const matched = /x\s*(\d+)\s*$/i.exec(String(note == null ? "" : note).trim());
  const parsed = matched ? Number(matched[1]) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

// 导出内容的行数据：列顺序与导入模板**完全一致**（导出文件可直接再导入）
function buildExportMatrix(linkRows) {
  return (linkRows || []).map(function (r) {
    return [
      importCell(r.offer_id) || importCell(r.market_sku),   // 店铺SKU：优先 offerId，没有则 marketSku
      importCell(r.pdev_public_id),                          // 商品SKU
      importCell(r.shop_name),                               // 店铺账户
      importCell(r.shop_id),                                 // 店铺ID（最可靠，导入时优先用它消歧）
      String(quantityFromNote(r.note)),                      // 数量
      importCell(r.note)                                     // 备注
    ];
  });
}

// 【task-22】「跳过数」列：老库的表已存在，所以同样用 information_schema 判断缺列才 ALTER，不重建、不 DROP。
const SKIPPED_COLUMN = "skipped_rows";
const SKIPPED_DDL = `ALTER TABLE pdev_import_files ADD COLUMN ${SKIPPED_COLUMN} INT NULL`;

function importCell(value) {
  return String(value == null ? "" : value).trim();
}

// 【task-21】店铺名归一化：NFKC + 去所有空白/零宽 + **同形字折叠**（Cyrillic/Greek → Latin）+ 小写。
//   真实 bug 现场：用户填 `Славянский Bazaar`（拉丁 B），库里是 `Славянский Бazaar`（**西里尔 Б U+0411**），
//   两者只差一个同形字母、肉眼完全一样，NFKC/小写/去空白都救不了 → 必须折叠同形字。
//   注意：折叠只会把「本来匹配不上」变成「匹配上」；万一折叠后有多条命中，消歧逻辑仍会判失败（安全底线不变）。
const IMPORT_HOMOGLYPHS = {
  "А": "a", "В": "b", "Е": "e", "К": "k", "М": "m", "Н": "h", "О": "o", "Р": "p", "С": "c", "Т": "t", "У": "y", "Х": "x", "Ѕ": "s", "І": "i", "Ј": "j", "Б": "b", "Ё": "e",
  "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "ѕ": "s", "і": "i", "ј": "j", "б": "b", "ё": "e",
  "Α": "a", "Β": "b", "Ε": "e", "Ζ": "z", "Η": "h", "Ι": "i", "Κ": "k", "Μ": "m", "Ν": "n", "Ο": "o", "Ρ": "p", "Τ": "t", "Υ": "y", "Χ": "x",
  "α": "a", "β": "b", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "y", "χ": "x"
};

function normalizeImportKey(value) {
  const text = String(value == null ? "" : value)
    .normalize("NFKC")
    .replace(/[\s\u00A0\u1680\u2000-\u200F\u2028\u2029\u202F\u205F\u3000\uFEFF]/g, "")
    .toLowerCase();
  let out = "";
  for (const ch of text) out += (IMPORT_HOMOGLYPHS[ch] || ch);
  return out;
}

// CSV 解析：去 BOM、支持 CRLF、支持双引号包裹（"" 转义、引号内可含逗号/换行）
function parseCsvRows(text) {
  const raw = String(text == null ? "" : text).replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else { field += ch; }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (ch === "\r") continue;
    field += ch;
  }
  row.push(field);
  rows.push(row);
  return rows.filter(function (r) { return r.some(function (c) { return importCell(c) !== ""; }); });
}

// 文件路径防穿越：只允许 erp/frontend/uploads 下的文件
function resolveImportUploadPath(fileUrl) {
  const url = String(fileUrl || "").trim();
  if (!url) return null;
  const rel = url.replace(/^\/+/, "");
  if (rel.indexOf("uploads/") !== 0) return null;
  const root = nodePath.resolve(UPLOAD_ROOT);
  const full = nodePath.resolve(root, rel.slice("uploads/".length));
  if (full !== root && full.indexOf(root + nodePath.sep) !== 0) return null;
  return full;
}

// 表头 → 列下标（中文列名，去空白，允许列顺序不同/多余列）
// 【task-22】同时建一份小写索引，便于「店铺ID / 店铺Id / 店铺id」这类大小写差异的容错
function mapImportHeader(headerRow) {
  const indexByName = {};
  const lowerIndexByName = {};
  (headerRow || []).forEach(function (cell, index) {
    const name = importCell(cell);
    if (!name) return;
    if (indexByName[name] === undefined) indexByName[name] = index;
    const lower = name.toLowerCase();
    if (lowerIndexByName[lower] === undefined) lowerIndexByName[lower] = index;
  });
  indexByName.__lower = lowerIndexByName;
  return indexByName;
}

// 取列下标：先精确名，再按小写名容错（店铺ID/店铺Id/店铺id…）
function importColumnIndex(headerIndex, names) {
  for (const name of names) {
    if (headerIndex[name] !== undefined) return headerIndex[name];
  }
  const lower = headerIndex.__lower || {};
  for (const name of names) {
    const idx = lower[String(name).toLowerCase()];
    if (idx !== undefined) return idx;
  }
  return undefined;
}

function appendImportReason(reasons, text) {
  reasons.push(text);
  return reasons;
}

function joinImportReasons(reasons) {
  const text = (Array.isArray(reasons) ? reasons : []).filter(Boolean).join("；");
  if (text.length <= IMPORT_REASON_LIMIT) return text || null;
  return text.slice(0, IMPORT_REASON_LIMIT - 12) + "…（已截断）";
}


const DDL = `CREATE TABLE IF NOT EXISTS pdev_online_links (
  id VARCHAR(40) NOT NULL,
  company_key VARCHAR(128) NOT NULL,
  pdev_public_id VARCHAR(40) NOT NULL,
  online_product_id VARCHAR(64) NULL,
  shop_id VARCHAR(64) NULL,
  shop_name VARCHAR(255) NULL,
  provider VARCHAR(64) NULL,
  market_sku VARCHAR(128) NULL,
  offer_id VARCHAR(128) NULL,
  product_title VARCHAR(500) NULL,
  sale_price DECIMAL(14,2) NULL,
  commission_percent DECIMAL(10,4) NULL,
  note VARCHAR(255) NULL,
  created_by VARCHAR(128) NULL,
  created_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_pdev_online (pdev_public_id, online_product_id),
  KEY idx_pdev (pdev_public_id),
  KEY idx_online (online_product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

// 【task-17】佣金比例列：老库里的表已经存在（不能重建/DROP），所以单独做一次「缺列才加」的惰性迁移。
const COMMISSION_COLUMN = "commission_percent";
const COMMISSION_DDL = `ALTER TABLE pdev_online_links ADD COLUMN ${COMMISSION_COLUMN} DECIMAL(10,4) NULL`;

// 【task-19】导入历史表：每次上传登记一条（解析/逐行建绑定留到下一阶段）
const IMPORT_FILES_DDL = `CREATE TABLE IF NOT EXISTS pdev_import_files (
  id VARCHAR(40) NOT NULL,
  company_key VARCHAR(128) NOT NULL,
  file_name VARCHAR(255) NULL,
  file_url VARCHAR(1024) NULL,
  import_mode VARCHAR(64) NULL,
  created_by VARCHAR(128) NULL,
  status VARCHAR(32) NULL,
  progress INT NOT NULL DEFAULT 0,
  failure_reason VARCHAR(1024) NULL,
  total_rows INT NULL,
  ok_rows INT NULL,
  fail_rows INT NULL,
  created_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_import_created (created_at),
  KEY idx_import_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const IMPORT_MODES = ["single", "systemCombo", "selfCombo"];

function makeImportId() {
  return "IMP-" + nodeCrypto.randomBytes(8).toString("hex").toUpperCase();
}

function normalizeImportMode(value) {
  const text = String(value == null ? "" : value).trim();
  return IMPORT_MODES.indexOf(text) >= 0 ? text : "single";
}

function mapImportFileRow(r) {
  return {
    id: r.id,
    fileName: r.file_name,
    fileUrl: r.file_url,
    importMode: r.import_mode,
    createdBy: r.created_by,
    status: r.status,
    progress: r.progress === null || r.progress === undefined ? 0 : Number(r.progress),
    failureReason: r.failure_reason,
    totalRows: r.total_rows === null || r.total_rows === undefined ? null : Number(r.total_rows),
    okRows: r.ok_rows === null || r.ok_rows === undefined ? null : Number(r.ok_rows),
    failRows: r.fail_rows === null || r.fail_rows === undefined ? null : Number(r.fail_rows),
    // 【task-22】重复（已存在绑定）而静默跳过的行数；不计入 fail_rows
    skippedRows: r.skipped_rows === null || r.skipped_rows === undefined ? null : Number(r.skipped_rows),
    createdAt: r.created_at,
    finishedAt: r.finished_at
  };
}

function makeId() {
  return "PL-" + nodeCrypto.randomBytes(8).toString("hex").toUpperCase();
}

function createPdevLinkRoutes(deps = {}) {
  const { authService, respondApi, parseJsonBody, getSqlPool } = deps;
  if (!authService) throw new Error("createPdevLinkRoutes requires authService");
  if (typeof respondApi !== "function") throw new Error("createPdevLinkRoutes requires respondApi");
  if (typeof getSqlPool !== "function") throw new Error("createPdevLinkRoutes requires getSqlPool");

  let tableReady = false;
  async function pool() {
    const p = getSqlPool();
    if (!p || typeof p.query !== "function") throw new Error("MySQL 连接池不可用");
    if (!tableReady) {
      await p.query(DDL);
      // 【task-17】老库表已存在但没有 commission_percent 列：用 information_schema 判断，缺了才 ALTER（不重建、不 DROP）。
      const [colRows] = await p.query(
        "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pdev_online_links' AND COLUMN_NAME = ?",
        [COMMISSION_COLUMN]
      );
      const hasColumn = Array.isArray(colRows) && colRows.length > 0 && Number(colRows[0].n) > 0;
      if (!hasColumn) await p.query(COMMISSION_DDL);
      // 【task-19】导入历史表（IF NOT EXISTS，只建不改）
      await p.query(IMPORT_FILES_DDL);
      // 【task-28】导出历史表（IF NOT EXISTS，只建不改）
      await p.query(EXPORT_FILES_DDL);
      // 【task-22】老库里这张表没有 skipped_rows 列：缺了才 ALTER（不重建、不 DROP）
      const [skipRows] = await p.query(
        "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pdev_import_files' AND COLUMN_NAME = ?",
        [SKIPPED_COLUMN]
      );
      const hasSkipCol = Array.isArray(skipRows) && skipRows.length > 0 && Number(skipRows[0].n) > 0;
      if (!hasSkipCol) await p.query(SKIPPED_DDL);
      tableReady = true;
    }
    return p;
  }
  const readBody = async (req) => (typeof parseJsonBody === "function" ? await parseJsonBody(req) : {});
  const str = (v, max) => { const s = String(v == null ? "" : v).trim(); return max && s.length > max ? s.slice(0, max) : s; };

  // ==================================================================
  // 【task-20】解析导入文件 → 逐行校验 → 逐行建绑定（**只新增，绝不删改已有绑定**）
  //   执行方式：**同步**（在登记请求里直接处理完再回写）。理由：
  //     · 上限 5000 行 / 5MB，且所有对照数据（在线产品 1529 条、商品、已有绑定对）都是一次性预加载到内存，
  //       每行只做「内存查找 + 1 条 INSERT」，实测几百行在 1 秒内完成，不会把请求拖死；
  //     · 同步没有「进程重启导致记录永久卡在处理中」的问题（记录只在本请求期间是处理中）；
  //     · 但仍加了一道兜底：GET 列表时把超过 10 分钟还停在「处理中」的记录判为「处理失败·处理中断」，
  //       以覆盖「进程在请求中途被杀」这种极小概率情况。
  //   模式：只完整实现「单品映射」；系统组合映射 / 自配对组合映射 语义未定义 → 整份失败并写明原因（不猜）。
  // ==================================================================
  async function processImportFile(p, record) {
    const reasons = [];
    const finishAll = function (status, message) {
      return { status: status, progress: 100, totalRows: null, okRows: null, failRows: null, failureReason: message || null };
    };

    // ① 模式
    const mode = String(record.import_mode || "single").trim() || "single";
    if (mode !== "single") {
      const label = mode === "systemCombo" ? "系统组合映射" : mode === "selfCombo" ? "自配对组合映射" : mode;
      return finishAll(IMPORT_STATUS_FAIL, label + " 暂不支持：目前只实现了「单品映射」的解析入库（该模式语义待与业务确认后再实现）");
    }

    // ② 读文件（路径必须落在 uploads 下）
    const filePath = resolveImportUploadPath(record.file_url);
    if (!filePath) return finishAll(IMPORT_STATUS_FAIL, "文件路径非法或不在 uploads 目录下：" + String(record.file_url || "（空）"));
    if (!nodeFs.existsSync(filePath)) return finishAll(IMPORT_STATUS_FAIL, "文件不存在或已被删除：" + String(record.file_url || ""));
    let buffer = null;
    try {
      const stat = nodeFs.statSync(filePath);
      if (stat.size > IMPORT_MAX_FILE_BYTES) return finishAll(IMPORT_STATUS_FAIL, "文件超过 5MB 限制");
      buffer = nodeFs.readFileSync(filePath);
    } catch (error) {
      return finishAll(IMPORT_STATUS_FAIL, "文件读取失败：" + String((error && error.message) || error));
    }

    // ③ 解析成二维数组
    const ext = nodePath.extname(filePath).toLowerCase();
    let matrix = null;
    try {
      if (ext === ".csv") {
        matrix = parseCsvRows(buffer.toString("utf8"));
      } else if (ext === ".xlsx" || ext === ".xls") {
        if (!XLSX) return finishAll(IMPORT_STATUS_FAIL, "服务器缺少 xlsx 依赖，无法解析该文件（请改用 CSV）");
        const workbook = XLSX.read(buffer, { type: "buffer" });
        const sheetName = (workbook.SheetNames || [])[0];
        if (!sheetName) return finishAll(IMPORT_STATUS_FAIL, "xlsx 里没有工作表");
        matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false })
          .filter(function (r) { return Array.isArray(r) && r.some(function (c) { return importCell(c) !== ""; }); });
      } else {
        return finishAll(IMPORT_STATUS_FAIL, "不支持的文件类型：" + ext + "（只支持 .csv/.xlsx/.xls）");
      }
    } catch (error) {
      return finishAll(IMPORT_STATUS_FAIL, "文件解析失败：" + String((error && error.message) || error));
    }
    if (!matrix || !matrix.length) return finishAll(IMPORT_STATUS_FAIL, "文件内容为空（没有表头行）");

    // ④ 表头匹配（中文列名，允许顺序不同）
    const headerIndex = mapImportHeader(matrix[0]);
    const missing = IMPORT_REQUIRED_COLUMNS.filter(function (name) { return headerIndex[name] === undefined; });
    if (missing.length) {
      return finishAll(IMPORT_STATUS_FAIL, "缺少必需列：" + missing.join("、") + "（表头需包含 " + IMPORT_TEMPLATE_COLUMNS.join("、") + "）");
    }
    const dataRows = matrix.slice(1);
    if (dataRows.length > IMPORT_MAX_ROWS) {
      return finishAll(IMPORT_STATUS_FAIL, "数据行数 " + dataRows.length + " 超过上限 " + IMPORT_MAX_ROWS + " 行，整份未处理");
    }
    if (!dataRows.length) return finishAll(IMPORT_STATUS_FAIL, "只有表头、没有数据行");

    // ⑤ 预加载对照数据（一次性；之后每行只做内存查找）
    const [onlineRows] = await p.query("SELECT id, shopId, shopName, provider, marketSku, offerId, shopSku, vendorCode, name, salePrice, commissionPercent FROM online_products");
    const onlineByKey = new Map();                    // 店铺侧标识(lower) → [在线产品…]
    onlineRows.forEach(function (r) {
      const product = {
        id: r.id, shopId: r.shopId, shopName: r.shopName, provider: r.provider,
        marketSku: r.marketSku, offerId: r.offerId, name: r.name,
        salePrice: r.salePrice === undefined ? null : r.salePrice,
        commissionPercent: r.commissionPercent === null || r.commissionPercent === undefined ? null : Number(r.commissionPercent)
      };
      [r.shopSku, r.offerId, r.vendorCode, r.marketSku].forEach(function (raw) {
        const key = importCell(raw).toLowerCase();
        if (!key) return;
        if (!onlineByKey.has(key)) onlineByKey.set(key, []);
        const list = onlineByKey.get(key);
        if (!list.some(function (x) { return x.id === product.id; })) list.push(product);
      });
    });
    const [pdevRows] = await p.query("SELECT public_id, title FROM pdev_products");
    const pdevBySku = new Map();
    pdevRows.forEach(function (r) {
      const key = importCell(r.public_id).toLowerCase();
      if (key && !pdevBySku.has(key)) pdevBySku.set(key, { publicId: r.public_id, title: r.title });
    });
    const [existingRows] = await p.query("SELECT pdev_public_id, online_product_id FROM pdev_online_links");
    const existingPairs = new Set(existingRows.map(function (r) { return importCell(r.pdev_public_id).toLowerCase() + "|" + importCell(r.online_product_id); }));

    // ⑥ 逐行处理
    const colShopSku = importColumnIndex(headerIndex, ["店铺SKU"]);
    const colPdevSku = importColumnIndex(headerIndex, ["商品SKU"]);
    const colShopName = importColumnIndex(headerIndex, ["店铺账户"]);
    // 【task-21/22】可选列：容错 店铺ID / 店铺Id / 店铺id / shopId
    const colShopId = importColumnIndex(headerIndex, ["店铺ID", "店铺Id", "店铺id", "shopId"]);
    const colQty = importColumnIndex(headerIndex, ["数量"]);
    const colNote = importColumnIndex(headerIndex, ["备注"]);
    let okRows = 0;
    let failRows = 0;
    let skippedRows = 0;                              // 【task-22】重复（已存在绑定）静默跳过，不计失败

    for (let i = 0; i < dataRows.length; i += 1) {
      const row = dataRows[i] || [];
      const lineNo = i + 2;                            // 表头是第 1 行
      const shopSku = importCell(row[colShopSku]);
      const pdevSku = importCell(row[colPdevSku]);
      const shopNameCell = colShopName === undefined ? "" : importCell(row[colShopName]);
      const qtyCell = colQty === undefined ? "" : importCell(row[colQty]);
      const noteCell = colNote === undefined ? "" : importCell(row[colNote]);

      if (!shopSku) { appendImportReason(reasons, "第 " + lineNo + " 行：店铺SKU 为空"); failRows += 1; continue; }
      if (!pdevSku) { appendImportReason(reasons, "第 " + lineNo + " 行：商品SKU 为空"); failRows += 1; continue; }
      const candidates = onlineByKey.get(shopSku.toLowerCase()) || [];
      if (!candidates.length) { appendImportReason(reasons, "第 " + lineNo + " 行：店铺SKU「" + shopSku + "」在在线产品里找不到"); failRows += 1; continue; }
      let product = candidates[0];
      if (candidates.length > 1) {
        // 【task-20/21】跨店铺重名（同一店铺SKU 命中多条在线产品）：必须靠「店铺账户」列消歧，**不猜**。
        //   ① 归一化后全等（NFKC + 去空白/零宽 + 同形字折叠 + 小写）
        //   ② 互相包含
        //   ③ 店铺ID（模板「店铺ID」列，或「店铺账户」里直接写 SHP-xxx）
        //   ④ 都不唯一 → 失败，并把该 SKU 的**候选店铺名 + 店铺ID**全列出来，让用户照抄
        const wanted = normalizeImportKey(shopNameCell);
        let matched = wanted ? candidates.filter(function (c) { return normalizeImportKey(c.shopName) === wanted; }) : [];
        if (matched.length !== 1 && wanted) {
          matched = candidates.filter(function (c) {
            const name = normalizeImportKey(c.shopName);
            return name && (name.indexOf(wanted) >= 0 || wanted.indexOf(name) >= 0);
          });
        }
        if (matched.length !== 1) {
          const idCell = colShopId === undefined ? "" : importCell(row[colShopId]);
          const idTokens = (String(idCell) + " " + String(shopNameCell)).match(/SHP-[A-Za-z0-9-]+/g) || [];
          if (idTokens.length) {
            matched = candidates.filter(function (c) {
              return idTokens.some(function (x) { return normalizeImportKey(x) === normalizeImportKey(c.shopId); });
            });
          }
        }
        if (matched.length === 1) product = matched[0];
        else {
          const candidateText = candidates.map(function (c) {
            return "「" + importCell(c.shopName) + "」(店铺ID " + importCell(c.shopId) + ")";
          }).join("、");
          appendImportReason(reasons, "第 " + lineNo + " 行：店铺SKU「" + shopSku + "」命中 " + candidates.length + " 条在线产品（跨店铺重名）" +
            (wanted ? "，按「店铺账户: " + shopNameCell + "」" + (matched.length ? "匹配到 " + matched.length + " 条" : "匹配不到") : "，且未填「店铺账户」") +
            "。该店铺SKU 的候选店铺是：" + candidateText + "；请照抄其中一个店铺名（或在「店铺ID」列填店铺ID）后重试");
          failRows += 1;
          continue;
        }
      }
      const pdev = pdevBySku.get(pdevSku.toLowerCase());
      if (!pdev) { appendImportReason(reasons, "第 " + lineNo + " 行：商品SKU「" + pdevSku + "」在商品管理里找不到"); failRows += 1; continue; }
      const pairKey = importCell(pdev.publicId).toLowerCase() + "|" + importCell(product.id);
      if (existingPairs.has(pairKey)) {
        // 【task-22】重复（已存在绑定）→ **静默跳过**：不计失败、不写 failure_reason、不覆盖已有绑定
        skippedRows += 1;
        continue;
      }
      let qty = 1;
      if (qtyCell) {
        const parsedQty = Number(qtyCell);
        if (!Number.isFinite(parsedQty) || parsedQty < 1) {
          appendImportReason(reasons, "第 " + lineNo + " 行：数量「" + qtyCell + "」不是正整数");
          failRows += 1;
          continue;
        }
        qty = Math.floor(parsedQty);
      }
      const title = importCell(pdev.title) || importCell(product.name);
      const note = (noteCell || (title ? title + " x" + qty : "x" + qty)).slice(0, 255);

      try {
        await p.query(
          "INSERT INTO pdev_online_links (id, company_key, pdev_public_id, online_product_id, shop_id, shop_name, provider, market_sku, offer_id, product_title, sale_price, commission_percent, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [makeId(), str(record.company_key, 128) || "system", str(pdev.publicId, 40), str(product.id, 64),
            product.shopId || null, product.shopName || null, product.provider || null, product.marketSku || null,
            product.offerId || null, product.name || null, product.salePrice === undefined ? null : product.salePrice,
            Number.isFinite(product.commissionPercent) ? product.commissionPercent : null, note,
            str(record.created_by, 128) || null, new Date()]
        );
        existingPairs.add(pairKey);                    // 同一文件内的重复行也跳过
        okRows += 1;
      } catch (error) {
        if (error && error.code === "ER_DUP_ENTRY") {
          // 【task-22】并发下撞唯一键也等同「已存在」→ 静默跳过，不算失败
          skippedRows += 1;
          continue;
        }
        appendImportReason(reasons, "第 " + lineNo + " 行：写入绑定失败（" + String((error && error.message) || error) + "）");
        failRows += 1;
      }
    }

    // 【task-22】状态只由**真实失败**决定：有真实失败才失败/部分成功；重复跳过不影响状态
    const status = failRows === 0
      ? IMPORT_STATUS_OK
      : (okRows > 0 ? IMPORT_STATUS_PARTIAL : IMPORT_STATUS_FAIL);
    return {
      status: status,
      progress: 100,
      totalRows: dataRows.length,
      okRows: okRows,
      failRows: failRows,
      skippedRows: skippedRows,
      failureReason: joinImportReasons(reasons)
    };
  }

  return [
    {
      // 【task-18】导入模板下载（只读，不写库；不要求 pdev.write）：真 .xlsx，缺 xlsx 依赖则退化成 CSV
      matches: (pathname, method) => pathname === "/api/pdev-links/import-template" && method === "GET",
      handler: async (req, res, query, auditBase) => {
        const auth = authService.requireAuth(req, res, { ...auditBase, actionType: "read", resourceType: "pdev_link" });
        if (!auth.ok) return;
        if (XLSX) {
          // 【task-24】主表**只有表头**（避免用户直接上传时把示例当数据）；
          //   示例行与每列中文说明放到第二个 sheet「填写说明」里（导入只读第一个 sheet，所以不会被当成数据）。
          const workbook = XLSX.utils.book_new();
          const mainSheet = XLSX.utils.aoa_to_sheet([IMPORT_TEMPLATE_COLUMNS]);
          mainSheet["!cols"] = [{ wch: 16 }, { wch: 20 }, { wch: 26 }, { wch: 26 }, { wch: 8 }, { wch: 30 }];
          XLSX.utils.book_append_sheet(workbook, mainSheet, "SKU关系导入");
          const guideRows = [
            ["填写说明（本页只是说明，不会被导入；导入时只读取第一个工作表「SKU关系导入」）"],
            [],
            ["示例行（请勿直接上传，示例里的备注也写了“示例行，请勿上传”）"],
            IMPORT_TEMPLATE_COLUMNS,
            ["235279001", "SKU-261010-HPIH", "Славянский Бazaar", "SHP-MN0M5ZG3-CA70", "1", "示例行，请勿上传"],
            [],
            ["列说明"],
            ["列名", "是否必填", "说明"],
            ["店铺SKU", "必填", "店铺侧的 SKU / offerId / 货号，用于匹配「在线产品」（如 235279001）"],
            ["商品SKU", "必填", "商品管理里的商品SKU（如 SKU-261010-HPIH）"],
            ["店铺账户", "选填（消歧用）", "店铺名称（如 Славянский Bazaar）。同一个「店铺SKU」命中多个店铺时**必须**填；注意西里尔/拉丁同形字，建议直接从店铺管理复制店铺名"],
            ["店铺ID", "选填（最可靠）", "「店铺管理」里的店铺ID，形如 SHP-MN0M5ZG3-CA70。填了它最稳：不怕店铺名写法/同形字/改名"],
            ["数量", "选填", "默认 1"],
            ["备注", "选填", "留空会自动写成「商品名 x数量」"],
            [],
            ["其它说明", "", "最多 5000 行；重复（该 商品SKU↔店铺 已存在绑定）的行会被静默跳过，不会覆盖已有绑定；「系统组合映射 / 自配对组合映射」暂不支持"]
          ];
          const guideSheet = XLSX.utils.aoa_to_sheet(guideRows);
          guideSheet["!cols"] = [{ wch: 14 }, { wch: 18 }, { wch: 96 }];
          XLSX.utils.book_append_sheet(workbook, guideSheet, "填写说明");
          const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
          res.writeHead(200, {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": "attachment; filename=sku-link-import-template.xlsx"
          });
          res.end(buffer);
          return;
        }
        // CSV 单表：**不加任何示例行/说明行**（否则会被当成数据行导入）。列说明只放在 xlsx 的第二个 sheet。
        const csv = "\uFEFF" + IMPORT_TEMPLATE_COLUMNS.join(",") + "\n";
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=sku-link-import-template.csv"
        });
        res.end(csv);
      }
    },
    {
      // 【task-19】导入历史列表（只读）：fileName 模糊 + created_at 区间 + 分页
      matches: (pathname, method) => pathname === "/api/pdev-links/import-files" && method === "GET",
      handler: async (req, res, query, auditBase) => {
        const auditContext = { ...auditBase, actionType: "read", resourceType: "pdev_link" };
        const auth = authService.requireAuth(req, res, auditContext);
        if (!auth.ok) return;
        try {
          const p = await pool();
          // 【task-20】兜底：进程在请求中途被杀时，记录会停在「处理中」。这里把超过 10 分钟仍处理中的
          // 记录判为「处理失败·处理中断」（只动 pdev_import_files 的状态，不碰任何绑定数据）。
          try {
            await p.query(
              "UPDATE pdev_import_files SET status = ?, progress = 100, failure_reason = ?, finished_at = NOW(3) WHERE status = ? AND created_at < DATE_SUB(NOW(3), INTERVAL 10 MINUTE)",
              [IMPORT_STATUS_FAIL, "处理中断（服务重启或请求超时），请重新上传该文件", IMPORT_STATUS_PROCESSING]
            );
          } catch (ignore) { /* 兜底失败不影响列表读取 */ }
          const fileName = str((query && query.fileName) || "", 255);
          const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(String((query && query.dateFrom) || "").trim()) ? String(query.dateFrom).trim() : "";
          const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(String((query && query.dateTo) || "").trim()) ? String(query.dateTo).trim() : "";
          const pageRaw = Number((query && query.page) || 1);
          const sizeRaw = Number((query && query.pageSize) || 10);
          const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
          const pageSize = Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.min(200, Math.floor(sizeRaw)) : 10;

          const where = [];
          const params = [];
          if (fileName) { where.push("file_name LIKE ?"); params.push("%" + fileName + "%"); }
          if (dateFrom) { where.push("created_at >= ?"); params.push(dateFrom + " 00:00:00.000"); }
          if (dateTo) { where.push("created_at <= ?"); params.push(dateTo + " 23:59:59.999"); }
          const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";

          const [countRows] = await p.query("SELECT COUNT(*) AS n FROM pdev_import_files" + whereSql, params);
          const total = Array.isArray(countRows) && countRows.length ? Number(countRows[0].n) || 0 : 0;
          const totalPages = Math.max(1, Math.ceil(total / pageSize));
          const safePage = Math.min(page, totalPages);
          const [rows] = await p.query(
            "SELECT * FROM pdev_import_files" + whereSql + " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
            params.concat([pageSize, (safePage - 1) * pageSize])
          );
          respondApi(req, res, auth.user, auditContext, 200, {
            items: rows.map(mapImportFileRow),
            pagination: { page: safePage, pageSize, total, totalPages }
          });
        } catch (error) {
          respondApi(req, res, auth.user, auditContext, 500, { message: String((error && error.message) || error) });
        }
      }
    },
    {
      // 【task-19】上传登记：{ fileName, fileUrl, importMode } → status=处理中、progress=0
      matches: (pathname, method) => pathname === "/api/pdev-links/import-files" && method === "POST",
      handler: async (req, res, query, auditBase) => {
        const auditContext = { ...auditBase, actionType: "create", resourceType: "pdev_link" };
        const auth = authService.requireAuth(req, res, auditContext);
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "pdev.write")) {
          respondApi(req, res, auth.user, auditContext, 403, { message: "只读账号：只有「产品开发」或「管理员」可以登记导入文件" });
          return;
        }
        try {
          const body = await readBody(req);
          const fileName = str(body && body.fileName, 255);
          const fileUrl = str(body && body.fileUrl, 1024);
          const importMode = normalizeImportMode(body && body.importMode);
          if (!fileName) { respondApi(req, res, auth.user, auditContext, 400, { message: "fileName 必填" }); return; }
          const p = await pool();
          const id = makeImportId();
          const now = new Date();
          await p.query(
            "INSERT INTO pdev_import_files (id, company_key, file_name, file_url, import_mode, created_by, status, progress, failure_reason, total_rows, ok_rows, fail_rows, created_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [id, str(auth.user && auth.user.companyKey, 128) || "system", fileName, fileUrl || null, importMode,
              str(auth.user && auth.user.username, 128) || null, IMPORT_STATUS_PROCESSING, 0, null, null, null, null, now, null]
          );
          auditContext.resourceId = id;
          // 【task-20】登记后**同步**解析入库（只新增绑定；失败/重复只记录，绝不改已有数据）
          const [before] = await p.query("SELECT * FROM pdev_import_files WHERE id = ?", [id]);
          let result = { status: IMPORT_STATUS_FAIL, progress: 100, totalRows: null, okRows: null, failRows: null, skippedRows: null, failureReason: "处理异常" };
          try {
            result = await processImportFile(p, before.length ? before[0] : { file_url: fileUrl, import_mode: importMode, company_key: auth.user && auth.user.companyKey, created_by: auth.user && auth.user.username });
          } catch (error) {
            result = { status: IMPORT_STATUS_FAIL, progress: 100, totalRows: null, okRows: null, failRows: null, skippedRows: null, failureReason: "处理异常：" + String((error && error.message) || error) };
          }
          await p.query(
            "UPDATE pdev_import_files SET status = ?, progress = ?, total_rows = ?, ok_rows = ?, fail_rows = ?, skipped_rows = ?, failure_reason = ?, finished_at = ? WHERE id = ?",
            [result.status, result.progress, result.totalRows, result.okRows, result.failRows,
              result.skippedRows === undefined ? null : result.skippedRows, result.failureReason, new Date(), id]
          );
          const [rows] = await p.query("SELECT * FROM pdev_import_files WHERE id = ?", [id]);
          respondApi(req, res, auth.user, auditContext, 201, rows.length ? mapImportFileRow(rows[0]) : { id: id, ...result });
        } catch (error) {
          respondApi(req, res, auth.user, auditContext, 500, { message: String((error && error.message) || error) });
        }
      }
    },
    {
      // 【task-20】删除一条导入历史记录（只删历史，不动任何业务绑定）；/^\/api\/pdev-links\/import-files\/[^/]+$/
      matches: (pathname, method) => method === "DELETE" && /^\/api\/pdev-links\/import-files\/[^/]+$/.test(String(pathname || "")),
      handler: async (req, res, query, auditBase) => {
        const auditContext = { ...auditBase, actionType: "delete", resourceType: "pdev_link" };
        const auth = authService.requireAuth(req, res, auditContext);
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "pdev.write")) {
          respondApi(req, res, auth.user, auditContext, 403, { message: "只读账号：只有「产品开发」或「管理员」可以删除导入记录" });
          return;
        }
        try {
          const matched = /^\/api\/pdev-links\/import-files\/([^/]+)$/.exec(String((req && req.url) || "").split("?")[0]);
          const id = matched ? decodeURIComponent(matched[1]) : "";
          if (!id) { respondApi(req, res, auth.user, auditContext, 400, { message: "缺少导入记录 id" }); return; }
          const p = await pool();
          const [r] = await p.query("DELETE FROM pdev_import_files WHERE id = ?", [id]);
          if (!r || !r.affectedRows) { respondApi(req, res, auth.user, auditContext, 404, { message: "导入记录不存在：" + id }); return; }
          auditContext.resourceId = id;
          respondApi(req, res, auth.user, auditContext, 200, { deleted: id });
        } catch (error) {
          respondApi(req, res, auth.user, auditContext, 500, { message: String((error && error.message) || error) });
        }
      }
    },
    {
      // 【task-28】导出历史列表（只读）：fileName 模糊 + created_at 区间 + 分页（照导入那份）
      matches: (pathname, method) => pathname === "/api/pdev-links/export-files" && method === "GET",
      handler: async (req, res, query, auditBase) => {
        const auditContext = { ...auditBase, actionType: "read", resourceType: "pdev_link" };
        const auth = authService.requireAuth(req, res, auditContext);
        if (!auth.ok) return;
        try {
          const p = await pool();
          const fileName = str((query && query.fileName) || "", 255);
          const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(String((query && query.dateFrom) || "").trim()) ? String(query.dateFrom).trim() : "";
          const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(String((query && query.dateTo) || "").trim()) ? String(query.dateTo).trim() : "";
          const pageRaw = Number((query && query.page) || 1);
          const sizeRaw = Number((query && query.pageSize) || 10);
          const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
          const pageSize = Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.min(200, Math.floor(sizeRaw)) : 10;

          const where = [];
          const params = [];
          if (fileName) { where.push("file_name LIKE ?"); params.push("%" + fileName + "%"); }
          if (dateFrom) { where.push("created_at >= ?"); params.push(dateFrom + " 00:00:00.000"); }
          if (dateTo) { where.push("created_at <= ?"); params.push(dateTo + " 23:59:59.999"); }
          const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";

          const [countRows] = await p.query("SELECT COUNT(*) AS n FROM pdev_export_files" + whereSql, params);
          const total = Array.isArray(countRows) && countRows.length ? Number(countRows[0].n) || 0 : 0;
          const totalPages = Math.max(1, Math.ceil(total / pageSize));
          const safePage = Math.min(page, totalPages);
          const [rows] = await p.query(
            "SELECT * FROM pdev_export_files" + whereSql + " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
            params.concat([pageSize, (safePage - 1) * pageSize])
          );
          respondApi(req, res, auth.user, auditContext, 200, {
            items: rows.map(mapExportFileRow),
            pagination: { page: safePage, pageSize, total, totalPages }
          });
        } catch (error) {
          respondApi(req, res, auth.user, auditContext, 500, { message: String((error && error.message) || error) });
        }
      }
    },
    {
      // 【task-28】导出：读取**全部绑定关系**生成 xlsx（列与导入模板完全一致 → 可直接再导入），落盘 + 写历史
      matches: (pathname, method) => pathname === "/api/pdev-links/export-files" && method === "POST",
      handler: async (req, res, query, auditBase) => {
        const auditContext = { ...auditBase, actionType: "create", resourceType: "pdev_link" };
        const auth = authService.requireAuth(req, res, auditContext);
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "pdev.write")) {
          respondApi(req, res, auth.user, auditContext, 403, { message: "只读账号：只有「产品开发」或「管理员」可以导出 SKU 关系" });
          return;
        }
        try {
          const body = await readBody(req);
          const rawName = str(body && body.fileName, 200);
          if (!rawName) { respondApi(req, res, auth.user, auditContext, 400, { message: "fileName 必填" }); return; }
          if (!XLSX) { respondApi(req, res, auth.user, auditContext, 500, { message: "服务器缺少 xlsx 依赖，无法生成导出文件" }); return; }
          // 文件名净化：去掉路径分隔符与控制字符（防路径穿越），自动补 .xlsx
          const baseName = rawName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").replace(/\.+$/, "").slice(0, 180) || "sku-links-export";
          const fileName = /\.xlsx$/i.test(baseName) ? baseName : baseName + ".xlsx";

          const p = await pool();
          const [linkRows] = await p.query("SELECT * FROM pdev_online_links ORDER BY created_at ASC, id ASC");
          const matrix = [IMPORT_TEMPLATE_COLUMNS].concat(buildExportMatrix(linkRows));
          const workbook = XLSX.utils.book_new();
          const sheet = XLSX.utils.aoa_to_sheet(matrix);
          sheet["!cols"] = [{ wch: 20 }, { wch: 20 }, { wch: 26 }, { wch: 26 }, { wch: 8 }, { wch: 40 }];
          XLSX.utils.book_append_sheet(workbook, sheet, "SKU关系导出");
          const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

          // 落盘到独立目录 frontend/exports/<YYYY-MM-DD>/<hex>.xlsx（与 uploads 的日期命名保持一致）
          const day = new Date().toISOString().slice(0, 10);
          const dir = nodePath.join(EXPORT_ROOT, day);
          nodeFs.mkdirSync(dir, { recursive: true });
          const diskName = nodeCrypto.randomBytes(8).toString("hex") + ".xlsx";
          nodeFs.writeFileSync(nodePath.join(dir, diskName), buffer);
          const fileUrl = "/exports/" + day + "/" + diskName;

          const id = makeExportId();
          const now = new Date();
          const reason = linkRows.length ? null : "当前没有任何绑定关系：导出文件只含表头（共 0 条）";
          await p.query(
            "INSERT INTO pdev_export_files (id, company_key, file_name, file_url, created_by, status, progress, failure_reason, total_rows, created_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [id, str(auth.user && auth.user.companyKey, 128) || "system", fileName, fileUrl,
              str(auth.user && auth.user.username, 128) || null, IMPORT_STATUS_OK, 100, reason, linkRows.length, now, now]
          );
          auditContext.resourceId = id;
          const [saved] = await p.query("SELECT * FROM pdev_export_files WHERE id = ?", [id]);
          respondApi(req, res, auth.user, auditContext, 201, saved.length ? mapExportFileRow(saved[0]) : { id: id });
        } catch (error) {
          respondApi(req, res, auth.user, auditContext, 500, { message: String((error && error.message) || error) });
        }
      }
    },
    {
      // 【task-29】删除一条导出历史：**记录 + 它自己的磁盘文件**一起清
      //   语义（顺序与失败处理）：**先删文件、后删记录**
      //     · 文件正常删除 → 再删记录，响应 { ok:true, fileDeleted:true }
      //     · 文件/目录不存在 → 幂等成功（fileDeleted:false + fileNote），记录照删
      //     · file_url 不在 /exports/ 下、或路径越界（.. / 绝对路径 / 指向目录或符号链接）→
      //       **绝不碰 exports 外的任何文件**，跳过文件删除并在 fileNote 里说明，记录照删
      //     · 文件删除**抛错**（权限/占用等真实失败）→ 500 且**保留记录**（不制造「文件还在但记录已没、无人知晓」的孤儿）；
      //       因为顺序是文件优先，重试会自然收敛
      matches: (pathname, method) => /^\/api\/pdev-links\/export-files\/[^/]+$/.test(pathname) && method === "DELETE",
      handler: async (req, res, query, auditBase) => {
        const auditContext = { ...auditBase, actionType: "delete", resourceType: "pdev_link" };
        const auth = authService.requireAuth(req, res, auditContext);
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "pdev.write")) {
          respondApi(req, res, auth.user, auditContext, 403, { message: "只读账号：只有「产品开发」或「管理员」可以删除导出记录" });
          return;
        }
        try {
          const matched = /^\/api\/pdev-links\/export-files\/([^/]+)$/.exec(String(req.url || "").split("?")[0]);
          const id = matched ? decodeURIComponent(matched[1]) : "";
          if (!id) { respondApi(req, res, auth.user, auditContext, 400, { message: "缺少导出记录 id" }); return; }
          const p = await pool();
          const [rows] = await p.query("SELECT * FROM pdev_export_files WHERE id = ?", [id]);
          if (!rows.length) { respondApi(req, res, auth.user, auditContext, 404, { message: "导出记录不存在：" + id }); return; }
          const record = rows[0];

          // ① 解析并删除磁盘文件（只允许 EXPORT_ROOT 之内；任何异常情况都不动外部文件）
          const fileUrl = String(record.file_url || "");
          let fileDeleted = false;
          let fileNote = "";
          const relative = /^\/exports\/(.+)$/.exec(fileUrl);
          if (!fileUrl) {
            fileNote = "该记录没有文件路径，无需删除文件";
          } else if (!relative) {
            fileNote = "文件路径不在 /exports/ 下，已跳过文件删除：" + fileUrl;
          } else {
            const target = nodePath.resolve(EXPORT_ROOT, relative[1]);
            const rootPrefix = EXPORT_ROOT.endsWith(nodePath.sep) ? EXPORT_ROOT : EXPORT_ROOT + nodePath.sep;
            const inside = target.toLowerCase() === EXPORT_ROOT.toLowerCase() || target.toLowerCase().indexOf(rootPrefix.toLowerCase()) === 0;
            if (!inside) {
              fileNote = "文件路径越出导出目录，已拒绝删除（未触碰任何外部文件）：" + fileUrl;
            } else {
              let stat = null;
              try { stat = nodeFs.lstatSync(target); } catch (error) { stat = null; }
              if (!stat) {
                fileNote = "文件不存在（视为已删除，幂等成功）";
              } else if (!stat.isFile()) {
                fileNote = "目标不是普通文件（可能是目录/符号链接），已跳过";
              } else {
                nodeFs.unlinkSync(target);   // 真实失败（权限/占用）会抛出 → 走 catch：500 且保留记录
                fileDeleted = true;
                fileNote = "文件已删除：" + fileUrl;
              }
            }
          }

          // ② 删记录（只有文件那一步没有抛出真实异常才会走到这里）
          const [deleted] = await p.query("DELETE FROM pdev_export_files WHERE id = ?", [id]);
          auditContext.resourceId = id;
          respondApi(req, res, auth.user, auditContext, 200, {
            ok: true,
            id: id,
            fileDeleted: fileDeleted,
            fileNote: fileNote,
            recordDeleted: !!(deleted && deleted.affectedRows)
          });
        } catch (error) {
          respondApi(req, res, auth.user, auditContext, 500, {
            message: "删除导出记录失败（记录已保留，可重试）：" + String((error && error.message) || error)
          });
        }
      }
    },
    {
      // 列出绑定关系（可按 商品SKU 过滤）
      matches: (pathname, method) => pathname === "/api/pdev-links" && method === "GET",
      handler: async (req, res, query, auditBase) => {
        const auditContext = { ...auditBase, actionType: "read", resourceType: "pdev_link" };
        const auth = authService.requireAuth(req, res, auditContext);
        if (!auth.ok) return;
        try {
          const p = await pool();
          const pdevSku = str((query && query.pdevSku) || "", 40);
          const keyword = str((query && query.q) || "", 120).toLowerCase();
          const sql = pdevSku
            ? "SELECT * FROM pdev_online_links WHERE pdev_public_id = ? ORDER BY created_at DESC LIMIT 500"
            : "SELECT * FROM pdev_online_links ORDER BY created_at DESC LIMIT 500";
          const [rows] = await p.query(sql, pdevSku ? [pdevSku] : []);
          let items = rows.map((r) => ({
            id: r.id, pdevSku: r.pdev_public_id, onlineProductId: r.online_product_id,
            shopId: r.shop_id, shopName: r.shop_name, provider: r.provider,
            marketSku: r.market_sku, offerId: r.offer_id, productTitle: r.product_title,
            salePrice: r.sale_price === null ? null : Number(r.sale_price),
            // 【task-17】佣金比例（百分数口径，来自 online_products.commissionPercent；没有则为 null）
            commissionPercent: r.commission_percent === null || r.commission_percent === undefined ? null : Number(r.commission_percent),
            note: r.note, createdBy: r.created_by, createdAt: r.created_at
          }));
          if (keyword) items = items.filter((x) => (String(x.pdevSku) + " " + String(x.offerId) + " " + String(x.marketSku) + " " + String(x.productTitle)).toLowerCase().includes(keyword));
          respondApi(req, res, auth.user, auditContext, 200, { items });
        } catch (error) {
          respondApi(req, res, auth.user, auditContext, 500, { message: String((error && error.message) || error) });
        }
      }
    },
    {
      // 新建绑定：{ pdevSku, onlineProductId, note? }
      matches: (pathname, method) => pathname === "/api/pdev-links" && method === "POST",
      handler: async (req, res, query, auditBase) => {
        const auditContext = { ...auditBase, actionType: "create", resourceType: "pdev_link" };
        const auth = authService.requireAuth(req, res, auditContext);
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "pdev.write")) {
          respondApi(req, res, auth.user, auditContext, 403, { message: "只读账号：只有「产品开发」或「管理员」可以维护 SKU 关系" });
          return;
        }
        try {
          const body = await readBody(req);
          const pdevSku = str(body && body.pdevSku, 40);
          const onlineProductId = str(body && body.onlineProductId, 64);
          if (!pdevSku || !onlineProductId) { respondApi(req, res, auth.user, auditContext, 400, { message: "pdevSku 与 onlineProductId 必填" }); return; }
          const p = await pool();
          const [op] = await p.query("SELECT id, shopId, shopName, provider, marketSku, offerId, name, salePrice, commissionPercent FROM online_products WHERE id = ? LIMIT 1", [onlineProductId]);
          if (!op.length) { respondApi(req, res, auth.user, auditContext, 404, { message: "在线产品不存在：" + onlineProductId }); return; }
          const o = op[0];
          const [dup] = await p.query("SELECT id FROM pdev_online_links WHERE pdev_public_id = ? AND online_product_id = ? LIMIT 1", [pdevSku, onlineProductId]);
          if (dup.length) { respondApi(req, res, auth.user, auditContext, 409, { message: "这对关系已经绑定过了" }); return; }
          const id = makeId();
          // 【task-17】新建绑定时把该在线产品的佣金比例一并带过来
          const commissionPercent = o.commissionPercent === null || o.commissionPercent === undefined ? null : Number(o.commissionPercent);
          await p.query(
            "INSERT INTO pdev_online_links (id, company_key, pdev_public_id, online_product_id, shop_id, shop_name, provider, market_sku, offer_id, product_title, sale_price, commission_percent, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [id, str(auth.user && auth.user.companyKey, 128) || "system", pdevSku, onlineProductId, o.shopId || null, o.shopName || null, o.provider || null, o.marketSku || null, o.offerId || null, o.name || null, o.salePrice === undefined ? null : o.salePrice, Number.isFinite(commissionPercent) ? commissionPercent : null, str(body && body.note, 255) || null, str(auth.user && auth.user.username, 128) || null, new Date()]
          );
          auditContext.resourceId = id;
          respondApi(req, res, auth.user, auditContext, 201, { id, pdevSku, onlineProductId, commissionPercent: Number.isFinite(commissionPercent) ? commissionPercent : null });
        } catch (error) {
          respondApi(req, res, auth.user, auditContext, 500, { message: String((error && error.message) || error) });
        }
      }
    },
    {
      // 解除绑定
      matches: (pathname, method) => /^\/api\/pdev-links\/[^/]+$/.test(pathname) && method === "DELETE",
      handler: async (req, res, query, auditBase) => {
        const auditContext = { ...auditBase, actionType: "delete", resourceType: "pdev_link" };
        const auth = authService.requireAuth(req, res, auditContext);
        if (!auth.ok) return;
        if (!authService.checkPermission(auth.user, "pdev.write")) {
          respondApi(req, res, auth.user, auditContext, 403, { message: "只读账号：只有「产品开发」或「管理员」可以维护 SKU 关系" });
          return;
        }
        try {
          const m = /^\/api\/pdev-links\/([^/]+)$/.exec(String((req && req.url) || "").split("?")[0]);
          const id = m ? decodeURIComponent(m[1]) : str((auditBase && auditBase.publicId) || "", 40);
          if (!id) { respondApi(req, res, auth.user, auditContext, 400, { message: "缺少关系 id" }); return; }
          const p = await pool();
          const [r] = await p.query("DELETE FROM pdev_online_links WHERE id = ?", [id]);
          if (!r || !r.affectedRows) { respondApi(req, res, auth.user, auditContext, 404, { message: "关系不存在：" + id }); return; }
          auditContext.resourceId = id;
          respondApi(req, res, auth.user, auditContext, 200, { deleted: id });
        } catch (error) {
          respondApi(req, res, auth.user, auditContext, 500, { message: String((error && error.message) || error) });
        }
      }
    }
  ];
}

module.exports = { createPdevLinkRoutes };
