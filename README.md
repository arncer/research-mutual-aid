# 科研互助平台 · 部署说明

面向研究生与青年科研人员的文献互助平台：发布求助 → 他人应助上传 → 两级审核 → 悬赏积分结算，
附带期刊数据库检索、院校订阅核验与每日推荐。

- 技术形态：Node.js 原生 HTTP 服务 + 静态页面 + 云端托管 PostgreSQL
- 第三方依赖：**0 个**（详见 `requirements.txt`）
- 线上站点：https://research-aid.app.workbuddy.host

---

## 1. 目录结构

```
research-mutual-aid/
├── server.js                  # 服务端入口：静态托管 + /api 路由 + 邮件投递器
├── email-sender.js            # SMTP 发送与认证握手（可独立复用）
├── package.json               # 项目清单（start = node server.js）
├── requirements.txt           # 依赖清单说明（零第三方依赖）
├── README.md                  # 本文件
├── .email.config.example.json # 邮件配置模板（不含任何真实凭据）
├── assets/                    # 前端资源，全部自托管、无 CDN
│   ├── app.js                 #   业务逻辑与前后端 API 封装
│   ├── workbuddy-cloud-sdk.js #   云端数据库 / 认证 / 存储 SDK
│   ├── doi-core.js            #   DOI 解析与元数据归一化
│   └── style.css
├── database/                  # 数据库结构与函数（重建环境用）
│   ├── 00-sequences.sql
│   ├── 10-schema.sql          #   28 张表 + 约束 + 索引
│   ├── 20-rls-policies.sql    #   行级安全策略
│   ├── 90-functions-live.sql  #   业务函数（SECURITY DEFINER）
│   ├── 91-grants.sql          #   函数与表权限收紧
│   ├── 99-changelog-after-baseline.md  # 基线之后的增量变更
│   └── 期刊数据导入说明.md
├── docs/                      # 期刊数据导入模板与说明
└── *.html                     # 13 个页面（见下表）
```

页面清单：

| 文件 | 用途 | 访问权限 |
| --- | --- | --- |
| `index.html` | 首页与平台数据概览 | 公开 |
| `login.html` | 登录 / 注册 / 身份绑定 | 公开 |
| `square.html` | 互助广场（可应助的求助列表） | 公开浏览 |
| `publish.html` | 发布求助（DOI 自动回填或手动填写） | 需登录 |
| `request.html` | 求助详情、上传应助文件、审核 | 需登录 |
| `paper.html` | 论文详情 | 公开 |
| `profile.html` | 个人中心（资料、院校、通知、推荐、订阅） | 需登录 |
| `leaderboard.html` | 助人排行榜 | 公开 |
| `journals.html` / `journal-detail.html` | 期刊数据库检索与详情 | 公开 |
| `admin.html` | 管理员后台（用户、附件复核、违规、订阅） | 仅管理员 |
| `admin-journals.html` | 期刊与订阅管理 | 仅管理员 |
| `admin-email.html` | 邮件服务配置 | 仅管理员 |

---

## 2. 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | ≥ 18.0.0（用到 `fetch`、现代标准库） |
| npm | ≥ 9（仅用于 `npm start`，非必需） |
| 操作系统 | Windows / macOS / Linux 均可，无本地编译步骤 |
| 网络 | 需能访问 WorkBuddy 云端服务；DOI 查询需访问 Crossref / OpenAlex |

---

## 3. 快速开始（本地运行）

```bash
cd research-mutual-aid
npm start                 # 等价于 node server.js
# 或指定端口
PORT=8080 node server.js
```

启动后访问 http://127.0.0.1:3000 。自检：

```bash
curl http://127.0.0.1:3000/api/health
# 预期返回 {"ok":true,...}
```

无需 `npm install`：项目没有第三方依赖。

---

## 4. 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PORT` | 否 | 监听端口，默认 `3000` |
| `WB_PUBLISHABLE_KEY` | 部署时 | 云端服务 publishable key（`wbpk_` 开头） |
| `WB_DB_ORIGIN` | 否 | 云数据库 REST 地址，缺省由平台注入 |
| `WB_AUTH_ORIGIN` | 否 | 认证服务地址，缺省由平台注入 |
| `EMAIL_WORKER_SECRET` | 否 | 服务端投递凭据；未设则读 `.email.config.json` 的 `workerSecret` |
| `MAIL_PAUSED` | 否 | 设为 `1` 可全局暂停邮件发送（当前线上为暂停态，见第 7 节） |
| `FORCE_RAW_HTTP` | 否 | 调试用，强制走原始 HTTP 客户端 |

---

## 5. 数据库

生产库为平台托管的 PostgreSQL，业务规则全部下沉到数据库函数（`SECURITY DEFINER`），
前端无法绕过规则直接改数据。

**新环境重建**（按序执行）：

```bash
psql "$DATABASE_URL" -f database/00-sequences.sql
psql "$DATABASE_URL" -f database/10-schema.sql
psql "$DATABASE_URL" -f database/20-rls-policies.sql
psql "$DATABASE_URL" -f database/90-functions-live.sql
psql "$DATABASE_URL" -f database/91-grants.sql
```

然后应用基线之后的增量变更，见 `database/99-changelog-after-baseline.md`。

初始化管理员（首个管理员需手工写入）：

```sql
INSERT INTO admins (user_id, note) VALUES ('<用户ID>', '首位管理员') ON CONFLICT DO NOTHING;
```

---

## 6. 部署到 WorkBuddy 托管

1. 确认本地自检通过：`node --check server.js` 且 `curl /api/health` 返回 200。
2. 在 WorkBuddy 中执行发布，参数：
   - 目录：`research-mutual-aid`
   - 语言/类型：`node`
   - 域名前缀：`research-aid`
3. 发布后逐项验收：
   - 13 个页面返回 200
   - `/api/health` 返回 `{"ok":true}`
   - `/api/email/status` 返回当前邮件开关状态
   - `/api/whoami` 匿名访问返回 `ok:false`（不应泄露管理员身份）

**回滚**：用备份目录覆盖源码后重新发布即可；数据库不随发布变更，无需回滚。

---

## 7. 邮件功能（当前状态：暂停）

`server.js` 内置开关 `MAIL_PAUSED`：

- 为 `true`（当前线上状态）时：SMTP 发送、30 秒自动投递、启动投递、测试邮件、端口诊断、保存配置测连 **全部拦截**，管理页显示「邮件提醒暂未启用」。
- 未发送队列 **不会被删除**，恢复后统一投递。
- 暂停不影响任何主流程：附件上传、站内通知、审核、积分结算照常工作
  （数据库函数中邮件入队被 `EXCEPTION` 包裹，邮件失败不会导致上传事务回滚）。

**恢复邮件**：在管理员「邮件服务」页填写 SMTP 参数（授权码只提交到服务端，存云端凭据库，
不写入代码、日志或前端），保存后会自动做一次真实认证握手；确认无误再把 `MAIL_PAUSED` 改回
`false` 并重新发布。

邮件配置也可放在 `.email.config.json`（**该文件含密钥，已排除在打包之外**）：

```bash
cp .email.config.example.json .email.config.json   # 然后填入自己的值
```

---

## 8. 安全说明

- **不要**把真实授权码、worker secret 写进任何会被提交或打包的文件。本包只提供
  `.email.config.example.json` 模板，真实配置文件未包含在内。
- 静态资源采用白名单（`assets/*` 与 `*.html`），点开头的隐藏文件对外返回 404。
- 所有需要身份的接口都在服务端二次校验；`x-wb-user-token` 用于传递登录令牌
  （平台入口会覆盖标准 `Authorization` 头，故改用自定义头）。
- 数据库函数权限已收紧（见 `91-grants.sql`）；管理员判定来自 `admins` 表。

---

## 9. 常见问题

**Q1：页面能打开但数据为空？**
检查浏览器控制台是否报 401/403 —— 多为 publishable key 或登录态问题；可访问 `/api/whoami` 查看服务端判定结果。

**Q2：DOI 查不到？**
Crossref/OpenAlex 为公开接口，可能有网络或限流问题。查不到时可改用「无 DOI 手动填写」，
功能与数据结构一致，仅 `doi` 字段为空。

**Q3：上传附件后对方没收到邮件？**
当前邮件功能处于暂停态，站内通知是唯一可靠通道（个人中心 → 通知）。恢复邮件需完成第 7 节。

**Q4：积分扣了但流水对不上？**
已知一处历史数据不一致（某账号余额与流水相差 5 分，疑似去重路径漏记），尚未修复，
详见交付报告「发现的问题」。

**Q5：npm install 报错？**
无需安装依赖。若误建了 `node_modules`，删除后直接 `node server.js` 即可。

---

## 10. 维护备忘

| 事项 | 状态 |
| --- | --- |
| 邮件功能 | 暂停中（`MAIL_PAUSED=true`），恢复见第 7 节 |
| 匿名绕过加固 | 10 个数据库函数的 `uid='anon'` 判定缺口待评审后修复 |
| 积分数据一致性 | 1 处历史差异待修复 |
| 账号级端到端验证 | 需真实账号走一遍完整闭环 |
