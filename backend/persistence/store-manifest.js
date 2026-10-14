"use strict";
// 持久化归属清单（单一事实来源）。
//
// 语义决定（2026-09-27）：**内存 db 是运行期唯一事实源（single writer）**，
// MySQL 侧只由它单向派生：
//   - AppState 单行快照：承载没有专用表的实体；
//   - 专用表：承载有专用表的实体，启动时反向 hydrate 回内存。
// 写入方永远只有内存；没有任何路径从 MySQL 反写内存（除启动 hydrate），
// 因此「同一实体同时存在于快照和专用表」即为双轨隐患，必须消除。
//
// 校验入口：node scripts/persistence-divergence.cjs

// 有专用表、且**不应**出现在 AppState 快照里的实体。
// writeMode: snapshot = DELETE + INSERT（内存即全集）；upsert = 逐行 UPSERT（配合 deleteXxx 处理删除）
const TABLE_OWNED_ENTITIES = [
  { name: "orders", key: "orders", table: "orders", writeMode: "snapshot", hydrate: "startup" },
  { name: "orderPurchaseOverrides", key: "orderPurchaseOverrides", table: "order_purchases", writeMode: "snapshot", hydrate: "startup" },
  { name: "collectionBox", key: "collectionBox", table: "collection_box", writeMode: "snapshot", hydrate: "startup" },
  { name: "publishRecords", key: "publishRecords", table: "publish_records", writeMode: "snapshot", hydrate: "startup" },
  { name: "users", key: "users", table: "users", writeMode: "upsert", hydrate: "startup" },
  { name: "activeSessions", key: "activeSessions", table: "active_sessions", writeMode: "snapshot", hydrate: "startup" },
  { name: "shops", key: "shops", table: "shops", writeMode: "upsert", hydrate: "startup" },
  { name: "reviewRules", key: "reviewRules", table: "review_rules", writeMode: "upsert", hydrate: "startup" },
  { name: "onlineProducts", key: "onlineProducts", table: "online_products", writeMode: "snapshot", hydrate: "startup" },
  // 审计日志只追加、不整表重写；启动时取最近 AUDIT_MAX_RECORDS 条回内存。
  { name: "auditLogs", key: "auditLogs", table: "audit_logs", writeMode: "append", hydrate: "startup" },
  // Yandex 合法费率目录是单文档（曾占快照 6MB），整体 upsert 到单行表。
  { name: "yandexCommissionCatalog", key: "yandexCommissionCatalog", table: "yandex_commission_catalog", writeMode: "document", hydrate: "startup" }
];

// 只存在于 AppState 快照里的实体（没有专用表）。
const APPSTATE_OWNED_ENTITIES = [
  { name: "publishProducts", key: "publishProducts", note: "刊登草稿/采集草稿" },
  { name: "publishSettings", key: "publishSettings", note: "刊登设置" },
  { name: "messages", key: "messages", note: "站内消息" },
  { name: "aiConfig", key: "aiConfig", note: "AI 配置（另见 ai_models / ai_image_prompts 表）" },
  { name: "aiImageTasks", key: "aiImageTasks", note: "AI 图任务（另见 ai_image_tasks 表）" }
];

// 历史遗留孤儿表：既不写也不读，却与 AppState 同名实体冲突，是本次双轨分歧的根源。
const LEGACY_ORPHAN_TABLES = [
  {
    table: "publish_products",
    replacedBy: "AppState.publishProducts",
    reason: "当前代码全库无引用（字面量与 MYSQL_PUBLISH_PRODUCT_TABLE 均零匹配）",
    backupTable: "legacy_publish_products_backup"
  },
  {
    table: "publish_settings",
    replacedBy: "AppState.publishSettings",
    reason: "当前代码全库无引用（MYSQL_PUBLISH_SETTINGS_TABLE 零匹配）",
    backupTable: "legacy_publish_settings_backup"
  }
];

function tableOwnedKeys() {
  return TABLE_OWNED_ENTITIES.map((entity) => entity.key);
}

function appStateOwnedKeys() {
  return APPSTATE_OWNED_ENTITIES.map((entity) => entity.key);
}

module.exports = {
  TABLE_OWNED_ENTITIES,
  APPSTATE_OWNED_ENTITIES,
  LEGACY_ORPHAN_TABLES,
  tableOwnedKeys,
  appStateOwnedKeys
};
