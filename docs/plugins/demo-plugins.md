# 完整插件接入 Demo

这两个 Demo 用于验证协议 1.0 已开放的能力。原有 `growth-notes`、`reminder-demo` 继续作为最小示例；完整 Demo 使用独立 ID 和数据命名空间。

| 插件 | ID | 类型 | 初始版本 | 使用入口 |
| --- | --- | --- | --- | --- |
| 页面能力 Demo | `demo-page` | 页面型，同时有独立后端 | 1.0.0 | 启用后顶部导航；配置位于应用管理 |
| 后台能力 Demo | `demo-service` | 后台型，`frontend=null` | 1.0.0 | 应用管理的配置弹窗；不产生顶部导航 |

两个 Demo 都有包内 PNG 图标、名称、简介和操作说明。新登记默认待发布，需管理员设置范围并上架，再由儿童负责人安装。配置、记录和启停状态对当前儿童的所有家长共享。

## 能力覆盖

| 能力 | 页面 Demo | 后台 Demo |
| --- | --- | --- |
| 按需加载与清理 | 独立 ESM/CSS，进入才加载；离开清理监听、10 秒刷新计时器和 DOM | 不包含前端资源 |
| 文本、整数、小数、布尔、枚举 | 标题、分页大小、权重、自动刷新、主题 | 消息、批量数、权重、开关、记录通道 |
| 多选与数量校验 | 记录分类，至少选择一项 | 星期选择 |
| 日期、日期时间、邮箱、网址 | 配置快照中的格式样例，仅作元数据展示 | — |
| 时间与 IANA 时区 | — | 每日时间支持 `HH:MM[:SS]`，时区决定每日计划和星期判定 |
| 配置分组、说明、默认值、边界 | 通用配置弹窗和前后端一致校验 | 同左 |
| 共享记录 | `entries` 集合：新建、修订号编辑、归档/恢复 | `executions` 集合：实际执行结果 |
| 分页 | 平台游标分页，上一页/下一页；刷新保留当前页 | 可通过平台 records API 分页读取 |
| 写入幂等、冲突、未知结果恢复 | 新建使用修订 0；编辑使用当前修订；失败保留原操作编号和请求体；冲突保留草稿并读取新记录供核对 | 手动探测和后台效果使用稳定业务标识，由平台去重 |
| 独立后端 API | `info`、`probe`、`fail`、`slow`，页面按钮可操作 | 相同接口，通过当前儿童授权的 runtime API 使用 |
| 通知和核心导航 | 发送提示、进入设置、返回日历 | — |
| 周期任务 | 每 60 秒心跳，写入 `activity` 集合 | 每 60 秒心跳 |
| 配置驱动的每日任务 | — | 每日指定时间/时区，仅所选星期产生记录 |
| 核心事件 | `task.completed` 写入 `activity` | `task.completed` 写入 `executions`，包含最小任务引用和真实积分权重计算 |
| 批量业务效果 | 手动探测产生一条活动记录 | 每次任务按批量数产生 1–3 条记录，带批次编号 |
| 任务失败重试 | 接口错误可由页面捕获、恢复 | “模拟后台失败”默认关闭；开启后在产生效果前失败，平台记录重试 |
| 儿童隔离和资格撤销 | 接口、资源和异步响应均绑定当前儿童/活动版本 | 服务执行和接收效果时复核资格 |
| 安装、启停、卸载、发布范围 | 使用平台通用流程 | 同左；浏览器关闭后仍可执行后台任务 |
| 独立更新/回退 | 独立制品、活动版本与发布记录；保留共享数据 | 同左；其他插件与主系统继续运行 |

清单显式声明 `plugin.state.read`、`plugin.state.write`、`plugin.jobs.schedule`、`plugin.events.subscribe`。后台不自建永久业务定时器，由平台调度。

## 本机接入与操作

1. 启动本机 Web 开发服务，确认插件表已完成显式维护：

   ```sh
   .venv/bin/python scripts/dev.py plugins-setup
   .venv/bin/python scripts/dev.py start
   ```

2. 插件运行服务需单独常驻，并与 Web 服务使用同一运行目录。默认是本仓库 `data/plugin-runtime`，控制通道是私有 Unix socket。

   ```sh
   .venv/bin/python deploy/plugin_runtime.py --config data/development/config.json
   ```

   已有同目录运行服务时复用它。重启 Web 服务不会自动重启此独立运行服务。

3. 构建检查与独立打包：

   ```sh
   npm run check:demo-plugins
   .venv/bin/python scripts/package_plugin.py --plugin demo-page --allow-dirty
   .venv/bin/python scripts/package_plugin.py --plugin demo-service --allow-dirty
   ```

   `--allow-dirty` 只用于本地开发。提交后可省略该参数生成正式制品。输出位于 `output/plugin-releases/<id>/1.0.0/`。同版本不能覆盖，后续代码更新必须增加版本号。

4. 使用 `deploy/plugins.py deploy --config data/development/config.json --package <制品路径>` 预览，核对本机开发目标后添加 `--apply --confirm <预览返回的targetId>`。详见 [独立部署](deployment.md)。

5. 打开管理后台“插件管理”，选择这两个 Demo，为测试儿童设置发布范围并上架；打开该儿童的“设置 → 应用管理”安装。页面 Demo 出现导航入口，后台 Demo 通过配置弹窗使用。

### 页面 Demo 的测试顺序

1. 保存一条记录，用另一位家长查看；再用另一个儿童验证不能访问。
2. 编辑记录、归档、恢复；把每页数量改为 1，创建两条以上记录验证分页。
3. 两位家长同时编辑同一修订，后保存者收到冲突；草稿保留，点击“读取最新记录并核对”再决定保存。
4. 模拟响应丢失后点击“重试原请求”，请求体和 operationId 相同，记录不重复。
5. “调用后端”显示服务器返回的加权数值，并新增一条手动活动；“模拟接口错误”后再正常调用，验证恢复。
6. 发起“测试慢请求”后立即返回日历，确认旧响应不会重新渲染页面；再次进入应重新加载。
7. 完成一个日历任务，或等待一分钟，读取后台活动核对事件和心跳；运行快照可核对儿童 ID、版本、配置修订和所有格式样例。

### 后台 Demo 的结果查看

后台型 Demo 的管理入口是通用配置弹窗，不额外增加页面。开发者可用只读工具查看一个儿童最近的 Demo 记录，包括卸载后保留的记录：

```sh
.venv/bin/python scripts/inspect_demo_plugin.py \
  --config data/development/config.json \
  --plugin demo-service --child CHILD_ID --limit 20
```

`CHILD_ID` 替换为测试儿童 ID。工具只接受本机 `lele_dev` / `lele_test*` 配置；使用本机服务配置的操作者权限读数据，不输出连接凭据、不安装插件、不触发任务。

- 启用后等待约一分钟，可看到 `heartbeat`。Web 浏览器关闭不影响执行。
- 在配置中设置稍后的每日时间，选择当天星期，保存；到点产生 `daily-reminder`。
- 完成一个日历任务，查看 `task.completed`、任务引用、实际积分和 `weightedPoints`。
- 批量数为 3 时，同一 occurrence 有 3 个不同 `batchIndex`，每条业务 ID 稳定。
- 开启“模拟后台失败”后，平台按自己的退避策略重试，不产生部分记录；修正配置后由下一次计划按新配置执行。
- 停用、卸载、下架或移出范围后，不再接受新的执行效果；记录保留。恢复资格后按平台要求重新启用。

### 接口合同

当前儿童启用后，使用其活动 `releaseId` 调用：

```text
GET  /api/children/{childId}/plugins/{pluginId}/runtime/info
GET  /api/children/{childId}/plugins/{pluginId}/runtime/slow
POST /api/children/{childId}/plugins/{pluginId}/runtime/probe
POST /api/children/{childId}/plugins/{pluginId}/runtime/fail
GET  /api/children/{childId}/plugins/{pluginId}/runtime/records/{collection}?limit=20
```

请求需要家长会话、写入 CSRF 和 `X-Plugin-Release`。页面插件通过 SDK 自动携带；无页面插件可由开发验收脚本调用。`probe` 请求体为 `{operationId, message, value}`，响应包含 `weightedValue`；返回的 `effects` 由平台收取，不会原样发到浏览器。`info` 只返回明确列出的业务字段，不返回 scopeToken 或数据库凭据。

## 自动验收

先准备本机开发 PostgreSQL、Python/Node 依赖与 Playwright Chromium。首次或主系统代码变化后执行 `npm run build`，验收服务使用已构建的家长端和管理端资源。

```sh
npm run check:demo-plugins
npm run test:demo-plugins
```

单元测试使用源码模块和真实清单/配置校验器。集成验收使用专用 `lele_test_demo_plugins`、19087/19088 端口和 `data/testing/demo-plugins`；真实加载两个插件、独立 worker、任务和事件，不向当前开发儿童写测试记录。截图及机器报告位于 `/tmp/lele-demo-plugin-qa`。

平台目前没有通用外部消息凭据、任意数据迁移或平台级删除能力，这些不会在 Demo 中伪装成已实现功能。提醒通道仅是记录标签；邮箱/网址是配置格式样例，不发送邮件、不请求外部地址。

### 本次验收记录（2026-10-31）

类型检查、独立构建和 18 项单元测试通过；真实浏览器/网关/worker 验收 9 组全部通过，页面异常为 0。覆盖 390/820 视口、共享与儿童隔离、配置校验、修订冲突、响应丢失幂等重试、原文/哈希操作编号隔离、真实后台任务和任务完成事件、两个插件分别更新至 1.0.1 并回退、停用/移出范围/下架/卸载后旧请求被拒绝且数据保留。更新期间家长、管理和运行服务 PID 保持不变。

证据：`/tmp/lele-demo-plugin-qa/results.json`、同目录截图及 axe 报告。后台重试已验证首次失败与下一次退避，未等待耗尽全部重试；视口测试不代表真实设备或其他浏览器验收。
