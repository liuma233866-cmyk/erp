# V2 阶段 0 基础层

V2 使用独立模块和独立数据库迁移，不接入旧后端路由。

数据库时间约定为 UTC：连接池固定 `timezone: "Z"`，并设置 `dateStrings: true`，因此 `DATETIME(3)` 读写统一使用 UTC 字符串。写入 MySQL 的时间字段统一通过 `core/dateTime.js` 的 `toMysqlDatetime` 格式化。

## 迁移

配置 `V2_MYSQL_HOST`、`V2_MYSQL_PORT`、`V2_MYSQL_USER`、`V2_MYSQL_PASSWORD`、`V2_MYSQL_DATABASE` 后运行：

```powershell
node backend-v2/migrations/run.js
```

也可以在服务启动流程中调用 `createV2Pool()` + `runMigrations(pool)`，迁移完成后再启动 V2 API。

## MySQL 8 真实门禁

设置 `V2_MYSQL_HOST`、`V2_MYSQL_PORT`、`V2_MYSQL_USER`、`V2_MYSQL_PASSWORD` 后，使用 `V2_MYSQL_RUN_INTEGRATION=1` 执行真实数据库门禁。可通过 `V2_MYSQL_TEST_DATABASE` 和 `V2_MYSQL_TEST_INCREMENTAL_DATABASE` 指定一次性测试库，避免复用已有库：

```powershell
$env:V2_MYSQL_RUN_INTEGRATION="1"
$env:V2_MYSQL_TEST_DATABASE="v2test_gate"
$env:V2_MYSQL_TEST_INCREMENTAL_DATABASE="v2test_gate_incr"
node --test backend-v2/migrations/mysql.integration.test.js
```

该测试覆盖空库顺序迁移、阶段 0 到当前版本的增量升级，以及重复执行幂等性。

迁移文件按 `V001__...sql` 顺序执行。执行过的迁移会保存 SHA-256 校验和，历史文件被修改时执行器会拒绝继续。

## 安全与审计

- `AuthAdapter` 负责验证 Bearer Token，验证实现通过依赖注入提供。
- `TenantAdapter` 负责公司租户范围校验。
- `PermissionAdapter` 负责 V2 权限检查。
- `getOrCreateRequestId` 负责请求关联 ID。
- `AuditLogger` 可接 `MySqlAuditSink` 写入 `v2_audit_logs`，敏感字段会先脱敏。

阶段 0 当前已覆盖：四张基础业务表、迁移元数据表、审计表、错误码、requestId、认证/租户/权限适配器和基础测试。

## 阶段 1 中央库

V007–V011 创建 `central_products`、`central_product_variants`、`central_product_sources`、`central_product_versions` 和 `central_product_assets`。`central/CentralCatalogService` 提供租户内 SKU/来源去重、SPU/变体唯一校验、乐观锁编辑、不可变版本和图片资产操作；`MysqlCentralCatalogRepository` 负责 MySQL 持久化。

中央库页面骨架位于 `frontend-v2/central/`，列表、详情、版本、变体和图片资产使用 `/api/v2/central` 路由契约。

V2 HTTP 入口由 `backend-v2/http/v2Server.js` 提供；调用方注入 Token 校验函数后，可用 `createV2Application({ pool, verifyToken })` 创建独立 V2 server，不复用旧后端路由。

## 阶段 2 首批：采集 / 刊登批次状态机

按 `DEVELOPMENT_PRODUCT_PUBLISH_V2.md` §5 状态模型与 §6.1 / §6.7 / §12.4 契约实现，状态迁移集中在服务层，前端不得直接改状态字段：

| 模块 | 覆盖 | 状态值 |
|---|---|---|
| `collection/collectionBatchService.js` | 采集批次与项目、批次内去重、计数聚合 | 批次 `created/running/succeeded/partially_succeeded/failed`；项目 `pending/succeeded/failed/duplicate` |
| `publish/publishBatchService.js` | 发布批次、迁移白名单、终态保护、乐观锁、子流程聚合 | `created/queued/running/partially_succeeded/succeeded/failed/blocked/cancelled/timed_out` |
| `publish/publishClaimService.js` | 刊登占用与租约：获取/续期/探测态/终态释放、过期恢复 | `held/probe_required/released` |

关键约定：

- 幂等靠数据库唯一约束兜底：批次 `(company_id, request_namespace, request_id|client_request_id)`，项目 `(batch, source_platform, source_product_id)`，占用 `(company_id, platform, shop_id, business_key)`；插入撞 `ER_DUP_ENTRY` 时改回读已有行。
- 聚合规则：只有全部子项 `succeeded` 才是 `succeeded`；有成功也有失败/阻塞是 `partially_succeeded`；没有成功但有阻塞是 `blocked`；完全没有成功是 `failed`。
- 租约到期**不等于**可安全重试：`held` 过期由恢复流程转 `probe_required`，只有探测到终态或人工确认平台没建商品才允许释放。
- MySQL DATETIME 无时区标记，一律用 `core/dateTime.parseUtcDate` 解析（用 `new Date(string)` 会按本地时区解释，租约判定会整体偏移）。

仓储：`collection/mysqlCollectionRepository.js`、`publish/mysqlPublishRepository.js`（更新字段白名单化——`publish_batches` 没有 `updated_at`）。

真实库门禁（自建测试库、跑完即删）：

```powershell
$env:V2_MYSQL_RUN_INTEGRATION="1"
node --test backend-v2/collection/collectionBatch.integration.test.js
```

未设置环境变量时该用例自动跳过；`V2_MYSQL_*` 未提供时回退读 `erp/.env` 的 `MYSQL_*`。默认库名 `ecommerce_order_admin_test`（与 `backend/app.test.js` 共用，两者不要并发跑）。

### HTTP 路由

`createV2Application()` 现在挂载三个前缀，按最长前缀匹配（`pickMount`），未挂载路径返回 400：

| 前缀 | 控制器 | 路由 |
|---|---|---|
| `/api/v2/central` | `central/centralController.js` | 中央库既有路由 |
| `/api/v2/collection` | `collection/collectionController.js` | `POST /batches`、`GET /batches/:publicId`、`POST /batches/:publicId/items`、`POST /batches/:publicId/items/:itemId/succeeded|failed`、`POST /batches/:publicId/finish` |
| `/api/v2/publish` | `publish/publishController.js` | `POST /batches`、`POST /batches/:publicId/transitions`、`POST /batches/:publicId/finish`、`POST /claims`、`POST /claims/recover-expired`、`POST /claims/:id/renew|probe-required|release` |

权限：读用 `collection.read` / `publish.read`，写用 `collection.write` / `publish.write`；租户一律由 `TenantAdapter` 解析，请求体里的 `companyId` 只能作为显式声明、不能越权。

两个真实库坑位（已修）：

1. **`v2_audit_logs.action` 只有 VARCHAR(64)**：把完整路径（含批次号与项目 id）写进去会因 "Data too long" 抛错，把**已经成功**的业务调用变成 500。控制器现在把 action 截断到 64 字符，完整路径放 `metadata.path`。
2. **`v2_audit_logs.actor_id` / `company_id` 是 BIGINT**：调用方注入的用户标识必须是数字字符串（如 `"1"`），非数字（如 `"u-1"`）会让审计插入失败并冒泡成 500。

全栈 HTTP 门禁（自建库、跑完即删）：

```powershell
$env:V2_MYSQL_RUN_INTEGRATION="1"
node --test backend-v2/http/v2Server.integration.test.js
```

注意：同一环境变量也会启用既有的迁移门禁（`migrations/mysql.integration.test.js`），它默认用 `v2test` / `v2test_incr` 库名，需要能建库的账号（如 root）；用受限账号（`erp_app` 仅授权两个业务库名）时该文件会失败，此时请单独指定要跑的门禁文件。
