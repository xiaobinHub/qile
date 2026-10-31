# 页面能力 Demo

完整能力、接入和验收说明：[docs/plugins/demo-plugins.md](../../docs/plugins/demo-plugins.md)。

- 入口：`frontend/entry.ts`，仅通过 PluginContext 与宿主交互。
- 后端：`backend/demo_page.py`，独立 Python worker。
- 数据：当前儿童的 `entries` 与 `activity` 集合。
- 类型检查：`npx tsc -p plugins/demo-page/tsconfig.json`。
