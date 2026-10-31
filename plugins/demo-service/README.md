# 后台能力 Demo

完整能力、接入和验收说明：[docs/plugins/demo-plugins.md](../../docs/plugins/demo-plugins.md)。

`frontend=null`；只使用通用配置弹窗。后端 `backend/demo_service.py` 演示每分钟心跳、每日任务、任务完成事件和批量效果。结果保存在当前儿童的 `executions` 集合，使用只读 `scripts/inspect_demo_plugin.py` 查看。
