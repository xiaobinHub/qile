# Demo Plugin Implementation Plan

**Goal:** 两个可独立构建、部署和验收的完整插件接入示例。

**Architecture:** 使用现有协议 1.0，不扩张平台接口。页面 Demo 使用 SDK 的 mount、api、notify、navigateCore 和 signal；worker 仅通过 effects 持久化。原有示例和正式儿童数据保持独立。

**Tech Stack:** TypeScript ESM/CSS、Python wheel、JSON Schema、现有 PostgreSQL 插件平台和 Playwright。

## Task 1: 后端与声明

- [x] 新建 plugins/demo-page 与 plugins/demo-service 的 plugin.json、schemas/config.json、assets/*.png、backend/*.py。
- [x] 实现 GET info、GET slow、POST probe、POST fail；签名上下文不回传 scopeToken。
- [x] 实现心跳、每日任务、任务完成事件和无副作用 health/cancel_job/shutdown。
- [x] 新建 tests/backend/test_demo_plugins.py：真实配置校验、业务输出、关闭开关、格式边界、事件过滤和失败模拟。

## Task 2: 页面

- [x] 新建 plugins/demo-page/frontend/entry.ts、style.css 和必要的同目录模块。
- [x] 记录使用 records/entries?limit=N&after=cursor；写入携带 expectedRevision/operationId；重试复用请求体。
- [x] 加入后端探测、运行信息、错误/慢请求、activity 读取、通知和导航，使用语义表单与 44px 控件。
- [x] dispose 检查 signal，清除间隔和监听；响应序列防止旧读取覆盖新列表。

## Task 3: 集成与交付

- [x] 构建打包两个插件：npm run plugin:build -- demo-page / demo-service；scripts/package_plugin.py --plugin ID --allow-dirty。
- [x] 创建隔离数据和真实运行验收，覆盖共享、分页、冲突、幂等、事件和撤销；浏览器覆盖桌面/窄屏。
- [x] 编写 docs/plugins/demo-plugins.md，列出能力矩阵、测试命令和服务型记录读取方式。
- [x] 审查并运行定向检查；源码以功能分支检查点保存，本机接入登记使用待发布状态。
