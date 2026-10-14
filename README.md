# 爆单兽 ERP（erp）

跨境电商（Yandex / Ozon / 1688）的订单与商品管理系统。纯 Node.js，无框架、无打包器：
后端 `http.createServer` + MySQL，前端是多面板 HTML（服务端 include 拼接）+ 原生 JS。

## 快速开始

```bash
cd erp
node backend/server.js          # 启动服务（默认 http://127.0.0.1:3000）
# 或者双击 scripts\start-server.bat（Windows，会开一个独立窗口）
```

健康检查：`GET /health` → `{"ok":true,...}`

## 目录结构

```
erp/
├── backend/
│   ├── server.js              # 入口：HTTP 服务、路由分发、启动流程（建表/载入数据）
│   ├── permissions.js         # 角色与权限定义（改权限看这里）
│   ├── routes/                # 各模块路由（每模块一个文件，见 API.md）
│   ├── product-dev/           # 商品管理（产品开发库）：routes / service / repository / schema
│   └── audit/                 # 审计日志存储（audit_logs 表 + 内存镜像）
├── frontend/
│   ├── index.html             # 外壳：导航 + 用 <!--#include--> 拼接各面板
│   ├── pages/                 # 各面板（HTML 片段 + JS + CSS）
│   ├── shared/                # 公共：base.css、api.js、router.js、permissions.js
│   ├── uploads/               # 上传的图片（运行时生成，静态可访问）
│   └── product-detail.html    # 商品详情的独立页（点 SKU 新标签页打开）
├── scripts/                   # 启动脚本、静态守卫等
├── logs/                      # 运行日志
├── .env                       # 配置（MySQL、端口、初始管理员）
└── API.md                     # 接口索引（自动生成）
```

## 配置（`.env`）

| 变量 | 用途 |
| --- | --- |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | 数据库连接 |
| `PORT` / `HOST` | 服务监听（默认 3000 / 127.0.0.1） |
| `DEFAULT_ADMIN_USERNAME` / `DEFAULT_ADMIN_PASSWORD` | 首次启动时创建的管理员 |

> ⚠️ 生产部署前请务必更换数据库密码与初始管理员密码。

## 权限与审计

- 角色（`backend/permissions.js`）：`admin`、`product_dev`、`operations`、`support`、`finance`、`supervisor`。
- **商品管理**的写操作要求 `pdev.write`：只有 `admin` 与 `product_dev` 有；其余角色只读（**服务端强制 403**，不只是前端隐藏按钮）。
- 每个写操作都会写审计日志（`audit_logs`）：操作人、角色、动作、资源、结果、脱敏后的请求体。
- **编辑日志**：`GET /api/product-dev/products/:publicId/logs`，任何登录用户都能看（需求如此），带公司隔离。

## 测试

```bash
cd erp
node --test --test-isolation=none --test-timeout=60000 backend/**/*.test.js frontend/**/*.test.js
node scripts/frontend-static-guard.mjs      # 前端静态守卫：检查脚本加载顺序与未定义的调用
```

说明：产品开发库的测试使用**假仓储**（不连真库），所以 SQL 层面的问题测试盖不住 —— **改了 SQL 必须打真实接口验证**。

## 已知约定 / 注意点

- **商品图片**：主图存在 `pdev_assets` 里（`asset_type = 'main'`），列表显示第一张；外部图床有防盗链时，`<img>` 需带 `referrerpolicy="no-referrer"`（代码里已加）。
- **商品SKU**：就是商品编号（`public_id`）。新建时留空 → 系统生成 `PD_<32位十六进制>`；填入 → 用你填的（服务端校验格式与唯一性）。
- **图片上传**：`POST /api/uploads`（base64），存 `frontend/uploads/<日期>/`，通过 `/uploads/...` 直接访问。
- **系统类目**：独立表 `system_categories`，界面上是「佣金页」的第三个标签；商品管理里的系统类目下拉取自它。
- **面板拼接**：`index.html` 用 `<!--#include file="..." -->` 引入各面板片段 —— 改片段后需**整页刷新**（Ctrl+F5）才会生效。
- **版本号**：前端资源引用带 `?v=`，改完 css/js 需同步升版本号，否则浏览器会用缓存。

## 接口文档

见 [API.md](./API.md)（由脚本扫描代码自动生成的接口索引）。
