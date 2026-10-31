# 插件运行与独立部署

本文件描述操作入口，不代表已发布生产。所有运维动作使用显式目标配置；inspect 和未携带 apply 的命令只预览。

## 首次接入

先发布包含插件平台能力的主系统。插件表由独立增量维护创建，应用启动、浏览应用目录和部署代码都不会自动建表。

生产维护沿用既有私有配置、目标确认及数据库保护流程：

```sh
.venv/bin/python deploy/manage.py upgrade-plugins --config /etc/lele-growth/production.json
```

核对预览中的目标、待建表与 `pendingMigrations`，再添加 `--apply --confirm` 和本次返回的 targetId。维护只增加插件结构，不覆盖已有儿童、日历或积分记录。

当前插件结构为 v2。首次接入依次安装 v1 和 v2；已安装 v1 的环境只执行独立的 `migrate_plugin_v1_to_v2.sql`，保留 v1 脚本及摘要。v2 为 outbox 增加事件产生时的接收对象快照；历史事件保留原内容，快照默认为空，不推断或补投历史订阅。已有投递、任务和插件记录保留。

已有插件环境升级时，先停止旧插件运行服务，使用候选主系统代码执行上述维护预览和确认，再切换主系统并启动新版插件运行服务。家长端与运行服务应使用同一版本。维护前新版家长端仍可保存核心日历操作，插件管理提示待维护；这段过渡期不新建插件事件。不得让旧版分发器在 v2 升级期间继续按当前订阅推断历史事件。迁移事务失败会同时回滚结构、版本记录和核心结构指纹，可重新预览后重试。

本机开发库可显式执行 `.venv/bin/python scripts/dev.py plugins-setup`，再执行 `.venv/bin/python scripts/dev.py restart`；该入口固定使用本机 development 配置。

隔离测试配置的显式初始化示例：

```sh
PYTHONPATH=backend .venv/bin/python -c 'from lele_growth.child_service import ChildService; from lele_growth.maintenance import initialize_plugin_platform; initialize_plugin_platform(ChildService("data/testing/plugins-browser/config.json"))'
```

示例路径为浏览器专项生成的测试配置，须先运行对应测试准备，不应替换成生产配置调用开发初始化。

## 独立运行服务

家长端、管理端和插件运行服务必须使用相同的配置、LELE_PLUGIN_ROOT 与 LELE_PLUGIN_SOCKET_ROOT。生产推荐分别为 `/opt/lele-growth/plugins`、`/run/lele-growth-plugins`，与主系统 current 版本目录分开。

- `deploy/production.env.example`：家长/管理服务环境示例。
- `deploy/plugin-runtime.env.example`：插件运行服务环境示例。
- `deploy/lele-growth-plugin-runtime.service`：单独的 systemd 服务模板。

确认现有服务账号、目录权限及 Python 路径后安装模板。控制 socket 和凭证仅供本机同一服务身份访问；不设置公网插件后端端口。运行服务可以统一调度，但无有效启用实例时不会执行该插件儿童业务。

本机启动方式：

```sh
LELE_PLUGIN_ROOT="$PWD/data/testing/plugins-browser/runtime" LELE_PLUGIN_SOCKET_ROOT="/tmp/lele-plugin-sockets" .venv/bin/python deploy/plugin_runtime.py --config data/testing/plugins-browser/config.json
```

连接它的家长测试服务必须设置同样两个环境变量。正式服务的环境文件权限为 0600，不把数据库或其他秘密放进插件包。

## 新插件及更新

构建/打包后，预览单插件部署：

```sh
.venv/bin/python deploy/plugins.py deploy --config /etc/lele-growth/production.json --package /path/to/plugin.tar.gz
```

核对插件 ID、当前/候选版本、兼容性和目标，然后添加 `--apply --confirm` 与预览返回的 targetId。只推送 Git 提交不会部署服务器。

新插件登记为待发布，管理员完善资料及范围后上架。已有插件更新保持发布状态和儿童配置，准备通过后显示更新中，再单独切换版本。主系统与其他插件不重启。前端旧页面收到版本变化时重新进入插件。

首期独立更新只接受相同数据 schema 版本和兼容配置；无法自动证明兼容时拒绝更新，需要单独设计迁移。候选失败时回到兼容旧版本，不能用旧数据库快照覆盖新业务数据。

## 回退与中断恢复

```sh
.venv/bin/python deploy/plugins.py rollback --config /etc/lele-growth/production.json --plugin growth-notes --version 1.0.0
.venv/bin/python deploy/plugins.py recover --config /etc/lele-growth/production.json --plugin growth-notes
```

同样先预览，再明确 apply 和目标确认。recover 用于中断的部署，检查锁租约和持久阶段；不能与仍然进行中的部署竞争。操作结果不明确时先查看后台版本记录和预览状态。

停用或下架与更新并发时，恢复以最新资格为准。已经不可撤销的外部消息不能由停用撤回；参考提醒插件只有站内执行记录，不触达外部系统。

平台级删除暂不纳入本期。家长卸载保留配置和历史数据，管理员下架使所有已安装实例失效。
