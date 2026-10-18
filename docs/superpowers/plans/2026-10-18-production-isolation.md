# 本地生产与开发隔离 Implementation Plan

**Goal:** 将已确认的 RDS 稳定版本纳入 main，并使 8787 服务脱离开发目录。

**Architecture:** main 以 RDS 分支为基础，增加生产控制程序与启动器。生产采用只读版本导出、独立依赖与正式配置，开发继续使用原工作区和隔离数据库。生命周期操作失败恢复旧服务配置。

**Tech Stack:** Git、Python 3.13、macOS launchd、现有 PostgreSQL 存储。

用户已授权在本次会话执行；由当前代理顺序执行，无需再次申请方案批准。

- [x] 保存 main、RDS、开发提交及生产快照、launchd 配置、口令/配置摘要。保持未提交文档不变。
- [x] 在隔离工作区将 main fast-forward 至 codex/rds-storage，提交设计。
- [x] 增加 scripts/local_production.py，修改原 .app 启停脚本，编写运行说明和生命周期边界测试。测试使用临时目录、模拟系统命令，禁止操作正式服务。
- [x] 执行 `python -m unittest test_local_production`、旧版隔离存储/HTTP测试，检查脚本语法、Git diff；提交 main，标记 `local-prod-20261018-rds`。
- [x] 导出 tag 至生产 releases 目录，创建独立 .venv、安装固定依赖；复制正式配置与口令（0600），生成完整提交和 SHA-256 manifest，设代码只读。
- [x] 切换前通过只读 /api/data 与 /api/health 获取即时基线；运行生产控制程序 start，失败恢复旧 launchd 配置。
- [x] 比较生产页面、数据、配置与口令摘要；核对进程路径、私有文件 404、开发健康状态。新版开发服务不写入正式 RDS。
- [x] 将 main 运维改动合回孩子账号分支，更新开发环境说明，记录实际验证结果；归档临时工作区。

## 回退

生命周期失败时控制程序恢复切换前的 launchd 配置。成功后保留独立生产版本、正式最新快照与旧服务配置。代码回退不回滚数据库；禁止用切换前快照覆盖之后新增业务数据。`current.json`、生产文件和配置出现不一致时拒绝启动，修复对应发布文件后重试。
