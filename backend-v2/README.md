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
