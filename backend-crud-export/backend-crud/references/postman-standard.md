# Postman Collection v2.1 规范

## 一、位置与命名

- 单模块：`docs/<module>.postman_collection.json`
- 项目已有统一 collection：在 `docs/` 下找到它，追加模块文件夹，保留原有请求
- 模块名用项目现有命名风格，小写 + 连字符或下划线，全文一致
- 一个模块只维护一个 collection；接口变更时更新，不新建副本

不要放到 `docs/api/` 之外的临时目录，不要生成 `.postman_environment.json` 之外的私密文件，不要把真实 token 写进去。

## 二、最小结构

```json
{
  "info": {
    "_postman_id": "b7c1f0a2-6d4e-4c3b-9f1a-2e8d7c6b5a40",
    "name": "订单模块 API",
    "description": "订单创建、查询与状态流转。示例数据仅用于文档。",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "订单",
      "item": [
        {
          "name": "创建订单",
          "request": {
            "method": "POST",
            "header": [
              { "key": "Content-Type", "value": "application/json" }
            ],
            "auth": {
              "type": "bearer",
              "bearer": [{ "key": "token", "value": "{{token}}", "type": "string" }]
            },
            "body": {
              "mode": "raw",
              "raw": "{\n  \"customerId\": 1001,\n  \"amount\": \"99.00\"\n}",
              "options": { "raw": { "language": "json" } }
            },
            "url": {
              "raw": "{{baseUrl}}/api/v1/orders",
              "host": ["{{baseUrl}}"],
              "path": ["api", "v1", "orders"]
            },
            "description": "创建订单。amount 为字符串金额，保留两位小数。"
          },
          "response": [
            {
              "name": "201 Created",
              "originalRequest": {
                "method": "POST",
                "header": [],
                "url": { "raw": "{{baseUrl}}/api/v1/orders", "host": ["{{baseUrl}}"], "path": ["api", "v1", "orders"] }
              },
              "status": "Created",
              "code": 201,
              "_postman_previewlanguage": "json",
              "header": [{ "key": "Content-Type", "value": "application/json" }],
              "body": "{\n  \"code\": 0,\n  \"message\": \"ok\",\n  \"data\": { \"id\": 10001 }\n}"
            }
          ]
        }
      ]
    }
  ],
  "variable": [
    { "key": "baseUrl", "value": "http://localhost:8080" },
    { "key": "token", "value": "" }
  ]
}
```

字段说明：

- `info.schema` 必须是 `collection/v2.1.0`
- `_postman_id` 用 UUID，更新时保持不变
- `item` 可嵌套文件夹；模块下按资源分组
- 请求名用"动作 + 资源"，如"创建订单""订单列表""更新订单状态"
- `url` 用对象形式，便于 Postman 展开 query/path 变量；至少包含 `raw` + `host` + `path`
- 路径参数放 `url.variable`，query 放 `url.query`
- Body 用 `raw` + `options.raw.language: "json"`
- 认证优先用 `request.auth` 的 bearer，值必须是 `{{token}}`；不用明文 token
- 每个请求至少一个成功示例；关键接口再补 400/401/403/404/409 中适用的错误示例
- 示例字段必须来自实际 DTO/model，不虚构字段名和类型
- `description` 写业务约束、必填、取值范围、幂等/权限说明，不写大段实现细节

## 三、变量

Collection 级别定义：

```json
"variable": [
  { "key": "baseUrl", "value": "http://localhost:8080" },
  { "key": "token", "value": "" }
]
```

- `baseUrl` 只放本地或开发地址，生产地址不入库
- `token` 留空，由使用者填写；示例里只出现 `{{token}}`
- 模块公共 ID 可加 `{{orderId}}` 之类的集合变量，并在描述里说明如何获得

## 四、增删改查命名

| 操作 | 请求名 | 方法 |
| --- | --- | --- |
| 列表 | 订单列表 | GET |
| 详情 | 订单详情 | GET |
| 创建 | 创建订单 | POST |
| 全量更新 | 更新订单 | PUT |
| 部分更新 | 修改订单 | PATCH |
| 删除 | 删除订单 | DELETE |
| 状态流转 | 提交订单 / 审核订单 | POST 或 PATCH，跟随项目 |

同一模块内命名风格统一；不要混用"新增/创建""查询/获取"。

## 五、更新已有 collection

1. 在 `docs/` 下找 `*.postman_collection.json`，确认是否已有项目级 collection。
2. 有则读取顶层 `item`，追加/更新本模块文件夹；保留其他模块和变量。
3. 没有则新建单模块文件。
4. 不改变已有请求的 ID、名称和示例，除非本次确实修改了该接口。
5. 更新后在描述里补一句变更说明，不写日期流水账。

## 六、校验

```bash
node scripts/validate-postman.mjs docs/order.postman_collection.json
```

- `0`：结构通过（warning 不影响）
- `1`：存在必须修的错误
- `2`：文件或参数错误

脚本会检查 schema 版本、名称、方法、URL、重复请求名、明文 token、未定义的 `{{baseUrl}}`、缺少示例响应等。warning 需要人工判断，不一定要改。

## 七、gRPC 模块

Postman 不能直接调用原生 gRPC。只有项目存在 HTTP gateway / grpc-gateway 映射时才生成 collection，并只收录实际暴露的 HTTP 路由；纯 gRPC 模块不生成 Postman 文档，改为向用户确认是否需要 HTTP 映射或改用其他文档形式。
