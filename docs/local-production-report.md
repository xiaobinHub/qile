# 本地生产隔离验收记录

日期：2026-10-18。此次仅整理代码版本与本机运行目录，正式业务代码、数据库和连接设置保持原样。

## 最终状态

- 正式入口：http://localhost:8787/。
- 独立目录：`/Users/xiaobin/Desktop/项目/乐乐成长-生产`。
- 固定 Git tag：`local-prod-20261018-rds`。
- 完整发布提交：`3f5e1089f0ad95388861a2a8f0eb20edc69a86ba`。
- 生产从独立 `.venv` 运行 `releases/local-prod-20261018-rds/server.py`，正式配置、数据根目录与日志均在生产目录；没有引用开发工作区。
- 发布共30个文件，SHA-256 由生产 `current.json` 记录，发布文件均为只读。运行控制程序校验通过。
- `main` 已包含 RDS 稳定版和生产运维管理；后续本报告等文档提交不改变生产 tag。`codex/rds-storage` 保留历史分支。
- 原工作区继续使用 `codex/child-accounts`，合入 main 运维管理；新版孩子账号业务未发布到 8787。

## 数据与运行验证

- 即时切换前与切换后修订号均为306，完整正式记录逐字段相等。
- 正式记录规范化 SHA-256：`21d6ca93b6380a95850a2e6d7ca98b3d3ca49727a50d4b5b5e383b2d8b64cda5`。
- 页面 SHA-256：`12244280dfa10143b74e2bf615a8ba7fe4ed1cbc5268c4d77f77475d006f1f5b`，与切换前、Git 固定发布完全相同。
- `/api/health` 返回 PostgreSQL 存储、databaseReady=true。
- Python 解释器路径、psycopg 安装路径、launchd 工作目录、server.py 路径、--db-config 与 --data-root 均指向独立生产目录。
- 正式 RDS 配置、存储模式文件与局域网口令文件的 SHA-256 与原文件一致，权限0600。未迁移、初始化、覆盖或写入测试数据到正式数据库。
- `/data/rds-config.json`、`/.git/config`、`/server.py`、`/current.json` 均返回404。
- 18787/18788 两个新版服务健康检查均为 development、databaseReady=true、ok=true；没有停止或重建开发服务/数据库。
- 用户未提交的 `docs/美森API接入要求.md` 摘要与基线一致，未纳入此次提交。

## 检查与边界

21项检查通过：5项生产生命周期边界，以及旧版临时 JSON 存储、访问口令、数据库配置和错误边界检查。生命周期检查覆盖发布被篡改时拒绝启动、路径越界、JSON 回退或公开凭据拒绝、其他进程占用端口时拒绝接管、启动失败恢复旧配置。两份 .app 启停脚本语法检查、Git diff 检查通过。

首次实际启动未成功，控制程序自动恢复旧 launchd 配置，旧正式服务健康检查通过。随后带诊断的实际切换成功，再通过原控制程序正常重启一次；最终健康状态与数据等值检查全部通过。首次失败没有保留底层错误，未能确定具体原因，后续未复现。

本次未重新执行浏览器交互、真实 iPad 打印或 Finder 点击验收；业务页面及后端关键文件字节保持不变，进行了页面哈希与只读接口验收。未修改原数据库连接的 SSL 设置；没有进行新的服务器部署。

## 本机回退资料

- 原 main：`582d00290189e059c1ac88f3f69cc79a21dbb1e5`，标签 `baseline-main-before-isolation-20261018`。
- 原开发分支：`9c34e00d6697ac67f5fe9075246ab466b26dbc44`，标签 `baseline-dev-before-isolation-20261018`。
- 原项目 `data/production-isolation/baseline/` 与生产 `backups/cutover-baseline/` 保留初始正式快照、即时切换前快照、旧 launchd 配置和摘要，权限受保护、未纳入 Git。
- 生产 `backups/cutover-verification.json` 保存只读验收详情；每次启动前的旧 launchd 配置另存于生产 `backups/`。

正式业务会继续更新，上述修订号与摘要只代表本次切换时点。恢复代码不等于恢复数据，禁止使用这些快照覆盖之后新增的业务。
