---
name: backend-crud
description: 后端模块开发与 CRUD 生成：先侦察并模仿项目现有分层、命名、错误处理与响应风格，严格按 model 结构体生成 DTO、校验与查询；上下文只保留业务流程，不保留代码细节和缺陷明细；发现严重缺陷立即提示；新模块完成时在项目 docs 目录生成 Postman Collection v2.1 接口文档；禁止执行无条件 DELETE/UPDATE 及 TRUNCATE/DROP；只在难理解处写注释。用于新增接口、补 CRUD、按 model 生成代码、审查后端改动、补接口文档等请求。 Backend module and CRUD development for Go services: mirror existing project conventions, derive code from model structs, keep business-flow-only context, report severe defects immediately, generate Postman v2.1 docs in docs/, block unconditional destructive SQL, and comment only non-obvious logic.
---

# Backend CRUD

## 定位

后端开发搭档。目标不是生成一套通用 CRUD，而是**长出一个和项目原有代码一样的模块**。

模仿优先于个人偏好；model 是唯一事实来源；项目已有的约定优先于"最佳实践"。只有涉及正确性、安全或数据丢失时，才偏离既有风格，并说明原因。

## 不可协商的七条

1. **先看再写**：没读过同类模块和 model，不动手。
2. **model 即契约**：字段、类型、标签、可空性、关联、软删除都以 model 为准，不自行加字段。
3. **上下文只留业务**：只记录模块、实体、流程、接口、权限、待确认项；不记录代码、diff、堆栈和缺陷明细。
4. **严重缺陷立即报**：发现即说，一句话讲影响和修法；不写进业务记录，修完即弃。
5. **破坏性 SQL 零容忍**：不执行、不生成无 WHERE 的 DELETE/UPDATE，不执行 TRUNCATE/DROP。
6. **注释只在难理解处**：默认不写；只解释"为什么"，不解释"是什么"。
7. **新模块必须有接口文档**：完成时在 `docs/` 生成或更新 Postman Collection v2.1。

## 工作流

### 0. 侦察项目约定

先确认当前项目根目录，再找同类模块作参照。至少摸清：

- 分层与目录：handler / service / repository / model / dto / router / middleware
- 一个**最完整、最近修改**的参考模块（同层级、同类型接口）
- 路由注册方式、URL 前缀、版本号、中间件与权限
- 统一响应结构、错误码、错误包装方式
- 分页、排序、筛选的既有写法
- 数据库访问方式（ORM / SQL）、事务写法、context 传递
- 校验方式、日志字段、配置读取
- 测试文件位置与写法、迁移文件命名
- `docs/` 下是否已有 Postman collection

产出**项目约定卡**：只写结论，不贴代码。约定冲突时先问用户以哪套为准。

找不到可模仿的模块时，停下来要一个参考文件或让用户确认最小约定，不要凭空发明一套架构。

### 1. 业务与模型

读 model 结构体，输出**业务卡片**（格式见下），然后判断字段来源：

| 来源 | 处理 |
| --- | --- |
| 用户填写 | 请求 DTO + 校验 |
| 系统生成 | ID、时间、操作人等，请求中忽略，响应只读 |
| 状态驱动 | 枚举校验，明确状态流转 |
| 外部导入 | 标注来源，禁止静默覆盖 |
| 计算得出 | 不落库或按项目惯例，响应只读 |

项目里还没有 model 时，先确认表结构与迁移，生成 model 后再做 CRUD；不要绕过 model 直接写 SQL。判不出来源、或字段的业务含义影响接口形态时，**立即问**。一次最多 3 个问题，每个给候选选项。

需要新增/修改 model 字段或迁移时，先说清字段、类型、默认值、索引、历史数据回填方案，得到确认再动。不要为了让接口跑通而私自加列。

### 2. 确定接口面

按项目现有风格列出本次要生成的接口：方法、路径、用途、权限、分页/筛选、删除语义、幂等要求。

- 用户没要的接口不生成；"通用后台都有"不是理由。
- 修改已有接口契约（字段、状态码、错误码）前必须问。
- 删除默认跟随 model：有 `DeletedAt` 用软删除；没有则先问硬删除还是软删除。
- 列表默认分页；筛选和排序字段必须在 model 中存在，排序字段用白名单。
- 多表写入、状态流转、扣减库存等必须明确事务边界。

### 3. 生成代码

按依赖顺序写：DTO → repository → service → handler → route → 测试。已有 model 不重写；需要改时先确认。

**模仿规则**：

- 文件位置、包名、命名、构造函数、依赖注入方式照抄参考模块。
- 响应包装、错误码、日志字段、分页结构照抄，不自创。
- 数据库访问沿用项目方式；不要为了新模块引入新 ORM、参数校验库或工具库。
- 不顺手重构无关代码，不调整无关格式。
- 模仿不包括注释密度：源文件注释再多，也只在本 skill 规定的位置写。

**model → CRUD 映射**：

- 字段名与 JSON 名以 struct tag 为准；没有 tag 时按项目惯例，不猜。
- 指针字段视为可空；更新接口区分全量/部分更新，别把"未传"写成零值覆盖。
- 时间、金额、枚举按项目既有类型和序列化方式处理。
- 敏感字段（密码、token、密钥）不得出现在响应和日志中。
- 关联字段不默认预加载；是否 Preload/Join 看参考模块，避免 N+1。
- 有租户字段时，每条查询都必须带租户条件，不能只靠上层鉴权。
- 有版本号/更新时间字段时，更新要考虑乐观锁或并发覆盖。

**注释**：只在并发控制、事务边界、非直观业务规则、必要 workaround、复杂查询的原因处写 1–2 行；其余不写。禁止注释掉的代码、分隔线、复述函数名的废话注释。

### 4. 自检

按项目已有命令执行格式化、编译、测试、lint。再逐项确认：

- 路由已注册且鉴权/权限正确
- 请求校验、错误分支、空结果、分页边界
- 事务覆盖所有相关写入，失败可回滚
- 查询有 tenant/权限条件，列表有上限
- 没有无条件 DELETE/UPDATE；所有 SQL 先过 `scripts/sql-guard.mjs`
- 注释只出现在难理解处
- 改动范围仅限本模块
- 无密钥、真实 token、生产地址入库

### 5. 生成 Postman 文档

新模块完成时（新增或明显变更接口），在项目 `docs/` 下生成/更新 Postman Collection v2.1：

- `docs/` 不存在就创建
- 单模块：`docs/<module>.postman_collection.json`
- 已有项目级 collection：追加一个模块文件夹，保留原有请求，不覆盖
- 必须含：`{{baseUrl}}`、`{{token}}`、每个接口的 method/url/headers/body/ query、成功与主要错误示例
- 不写真实密钥和生产域名
- 用 `scripts/validate-postman.mjs` 校验后再交付

细节见 [references/postman-standard.md](references/postman-standard.md)。

### 6. 交付

简短讲五件事：

1. 本次模块与业务流程（业务卡片）
2. 改了哪些文件（路径，不贴代码）
3. 验证结果（编译/测试/lint 实际执行了什么）
4. Postman 文档路径与校验结果
5. 未解决的严重缺陷、待确认问题

不复述实现过程，不贴大段代码，不重复已经报过的缺陷。

## 业务卡片格式

上下文里唯一长期保留的东西。只写业务，不写实现：

```
模块：订单管理
实体：Order（订单）
关键字段：订单号 / 客户 / 金额 / 状态 / 创建时间（只写业务含义）
主流程：创建 → 待审核 → 已通过 → 已完成
接口：POST /orders、GET /orders、GET /orders/:id、PATCH /orders/:id/status
权限：运营可创建；主管可审核；仅本人可查看
外部依赖：库存服务、支付回调
待确认：取消订单是否允许退款后撤销
```

**不写入**：代码片段、类型与 tag、文件全文、diff、堆栈、日志、测试输出、缺陷细节、临时调试结论。

恢复工作时以业务卡片为地图，需要细节就重新读对应文件，不凭记忆复述代码。

## 缺陷上报

| 级别 | 例子 | 动作 |
| --- | --- | --- |
| P0 严重 | 越权/租户穿透、SQL 注入、无 WHERE 的删改、事务缺失导致不一致、密钥泄露、请求路径 panic、并发竞态、破坏性接口变更 | **立即停下报告**，给影响和修法，问是否现在修 |
| P1 应修 | 缺校验、列表无上限、错误被吞、错误码不一致、明显 N+1、缺超时 | 当前步骤结束前用不超过 3 条简述 |
| P2 建议 | 命名、重复代码、可读性 | 用户问再说 |

上报格式一行：`P0 · path:line — 影响：… 修法：… 现在修吗？`

缺陷只存在于当次提示：不写进业务卡片，不在后续摘要里复述，不贴完整代码或堆栈；修复并验证后即丢弃。不要借修缺陷之名改无关代码。

## SQL 安全

- 任何 `DELETE` / `UPDATE` 必须有**顶层 WHERE**，且条件能定位到具体记录或明确批次。
- 禁止 `WHERE 1=1`、`WHERE true`、无条件更新、`TRUNCATE`、`DROP TABLE/DATABASE/SCHEMA`、`ALTER TABLE ... DROP`。
- 参数化查询；不拼接用户输入；批量任务必须有 dry-run 计数、批次上限和确认。
- 迁移中的破坏性 DDL 必须先说明影响、备份与回滚方案，由用户明确确认后手工执行。
- 执行任何 SQL 文件或语句前先跑：

```bash
node scripts/sql-guard.mjs --file <file.sql>
node scripts/sql-guard.mjs --sql "DELETE FROM orders WHERE id = ?"
node scripts/sql-guard.mjs --scan <项目目录>
```

脚本退出码 `0` 安全、`1` 拦截、`2` 参数错误。**被拦截时不得绕过、改写规避或换一种写法执行**，先向用户报告。写在代码里的 SQL 同样用 `--sql` 预检；`--scan` 只覆盖 `.sql` 文件。

## 边界

- 不替用户决定业务规则；规则不清就问。
- 不生成用户没要的模块、定时任务、缓存层、消息队列。
- 不引入新依赖；确有必要先问。
- 不做无关重构、不批量改格式。
- 不执行生产环境命令，不读取真实密钥。
- 不把"能跑"当成"完成"：接口文档、验证、严重缺陷处理都算完成的一部分。

## 资源

- [references/imitation-guide.md](references/imitation-guide.md) — 侦察清单、参考模块选择、model 解析与 CRUD 生成细则
- [references/context-and-defects.md](references/context-and-defects.md) — 业务卡片、上下文压缩、缺陷分级与上报模板、注释规则
- [references/postman-standard.md](references/postman-standard.md) — Postman Collection v2.1 结构与命名规范
- [assets/postman-collection-template.json](assets/postman-collection-template.json) — 可直接改写的 collection 模板
- [scripts/sql-guard.mjs](scripts/sql-guard.mjs) — 无条件删改与破坏性 DDL 拦截
- [scripts/validate-postman.mjs](scripts/validate-postman.mjs) — Postman collection 校验
