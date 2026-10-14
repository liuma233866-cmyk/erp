# ERP 接口文档（API）

> ⚠️ **本文件由脚本扫描代码自动生成**（提取各路由文件的 `matches:` 注册语句），生成时间：2026-10-11 08:00:33。
> **它的定位是：快速索引，不是权威契约**：
> - 正则形式的路由、以及一条 `matches` 里挂多个路径的情况，**可能提取不全**；
> - 请求/响应字段、错误码等细节**不在本文件**，请看各路由实现或（历史上曾有的）契约文档；
> - **以代码为准**：`erp/backend/routes/*.js` 与 `erp/backend/product-dev/pdev-routes.js`。
> 
> 共扫描到 21 个模块、90 条接口注册。

## 通用约定

| 项 | 说明 |
| --- | --- |
| 服务地址 | `http://127.0.0.1:3000`（主机/端口来自 `erp/.env`） |
| 鉴权 | 二选一：`Authorization: Bearer <token>`，或 HttpOnly Cookie `auth_token`（浏览器自动携带） |
| 免登录 | `POST /api/login`、`POST /api/register`、`GET /health` |
| 返回 | JSON；失败为 `{ message }` + 对应状态码（400 / 401 / 403 / 404 / 409 / 413 / 500） |
| 角色 | 见 `erp/backend/permissions.js`：`admin` / `product_dev` / `operations` / `support` / `finance` / `supervisor` |
| 审计 | 写操作普遍写 `audit_logs`（操作人、角色、动作、资源、结果、脱敏请求体） |

### 值得单独说明的几条

- `GET /api/product-dev/products/:publicId/logs` —— 商品编辑日志，**只需登录**（所有人可看），带公司隔离，只列编辑动作。
- `POST /api/uploads` —— 图片上传（base64，png/jpg/webp/gif，≤5MB），要求 `pdev.write`；文件落在 `erp/frontend/uploads/<日期>/`，通过静态路径 `/uploads/...` 访问。
- `/api/system-categories` —— 系统类目清单（独立表 `system_categories`，首次调用懒建表），写操作要求 `pdev.write`。
- 商品管理的写操作统一要求 `pdev.write`：只有 `admin` 与 `product_dev` 可改，其余角色服务端返回 403。

## AI 能力 · `ai.js`

| 方法 | 路径 |
| --- | --- |
| `（见实现）` | `/api/ai/models*` |
| `（见实现）` | `/api/ai/image-prompts*` |
| `（见实现）` | `/api/ai/image-tasks*` |
| `（见实现）` | `/api/ai/chat` |

## 审计日志 / 日志检查 · `audit.js`

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/audit-logs` |
| `GET` | `/api/log-checker` |

## 认证与会话 · `auth.js`

| 方法 | 路径 |
| --- | --- |
| `POST` | `/api/register` |
| `POST` | `/api/login` |
| `POST` | `/api/logout` |
| `GET` | `/api/profile` |
| `GET` | `/api/sessions` |
| `DELETE` | `/api/sessions/*` |

## 类目映射（系统管理·平台类目） · `category-mapping.js`

| 方法 | 路径 |
| --- | --- |
| `GET / POST` | `/api/category-mapping/rules` |
| `PUT / DELETE` | `/^\/api\/category-mapping\/rules\/([^/]+)$/` |

## 采集箱 · `collection-box.js`

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/collection-box` |
| `DELETE` | `/api/collection-box` |

## 采集器 · `collector.js`

| 方法 | 路径 |
| --- | --- |
| `POST` | `/api/collector/products` |

## 佣金 · `commission.js`

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/yandex/commission-catalog` |
| `POST` | `/api/yandex/commission-catalog/sync` |

## 市场佣金 · `market-commissions.js`

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/market-category-commissions` |
| `POST` | `/api/market-category-commissions/sync` |

## 消息 · `messages.js`

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/messages` |
| `POST` | `/api/messages` |

## 在线产品 · `online-products.js`

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/online-products` |
| `GET` | `/api/online-products/commission-unmatched` |
| `POST` | `/api/online-products/sync` |
| `POST` | `/api/online-products/sync-sku` |
| `POST` | `/api/ozon-products/sync` |
| `PUT` | `/^\/api\/online-products\/([^/]+)\/source$/` |
| `POST` | `/api/online-products/export` |
| `PUT` | `/api/online-products/batch-inventory` |
| `DELETE` | `/api/online-products` |

## 订单 · `orders.js`

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/orders` |
| `GET` | `/api/orders/summary` |
| `POST` | `/api/orders/sync` |
| `POST` | `/api/orders` |
| `GET` | `/api/orders-v2` |
| `PUT` | `/^\/api\/orders\/([^/]+)\/match-product$/` |
| `PUT` | `/api/orders/*` |
| `PUT` | `/api/orders/*` |
| `GET` | `/api/orders/purchase-template` |
| `GET` | `/api/orders/purchase-export` |
| `POST` | `/api/orders/purchase-import` |
| `POST` | `/api/orders/*` |
| `POST` | `/api/orders/*` |
| `GET` | `/api/orders/*` |
| `POST` | `/api/orders/*` |
| `GET` | `/api/orders/*` |
| `GET` | `/api/orders/*` |
| `POST` | `/api/orders/labels/merge` |
| `DELETE` | `/api/orders/*` |
| `GET` | `/api/orders/profit-issues` |
| `GET` | `/api/orders/*` |

## 刊登记录 · `publish-records.js`

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/publish-records` |

## 刊登 · `publish.js`

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/product-publish/import-template` |
| `POST` | `/api/product-publish/import-file` |
| `GET` | `/api/product-publish` |
| `GET` | `/api/product-publish/settings` |
| `POST` | `/api/product-publish/copy-online` |
| `PUT` | `/api/product-publish/settings` |
| `POST` | `/api/product-publish` |
| `DELETE` | `/api/product-publish` |
| `POST` | `/api/product-publish/bulk-stock` |
| `GET` | `/^\/api\/product-publish\/([^/]+)\/logs$/` |
| `PUT` | `/api/product-publish/*` |
| `PUT` | `/^\/api\/product-publish\/([^/]+)$/` |
| `POST` | `/api/yandex/publish` |
| `POST` | `/api/product-publish/publish-yandex` |
| `POST` | `/api/product-publish/publish-ozon` |

## 汇率 · `rates.js`

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/rates/cbr` |
| `GET` | `/api/rates/rub-purchase-cost` |

## 审核规则 · `review-rules.js`

| 方法 | 路径 |
| --- | --- |
| `GET / POST` | `/api/review-rules` |
| `PUT / DELETE` | `/^\/api\/review-rules\/([^/]+)$/` |

## 店铺 · `shops.js`

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/shops` |
| `POST` | `/api/shops` |
| `PUT` | `/^\/api\/shops\/([^/]+)$/` |
| `DELETE` | `/api/shops/*` |
| `PUT` | `/api/shops/*` |
| `PUT` | `/api/shops/*` |

## 系统类目 · `system-categories.js`

| 方法 | 路径 |
| --- | --- |
| `GET / POST` | `/api/system-categories` |

## 图片上传 · `uploads.js`

| 方法 | 路径 |
| --- | --- |
| `POST` | `/api/uploads` |

## 用户与权限 · `users.js`

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/users` |
| `POST` | `/api/users` |
| `PUT` | `/api/users/*` |
| `PUT` | `/api/users/*` |
| `PUT` | `/api/users/*` |
| `DELETE` | `/api/users/*` |

## Yandex 类目参数 · `yandex-category-params.js`

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/yandex/category-parameters` |

## Yandex 质量分 · `yandex-quality.js`

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/yandex/card-quality/batch` |
| `GET / POST` | `/api/yandex/card-quality` |
