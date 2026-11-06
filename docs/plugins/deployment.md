# 插件运行与独立部署

本文件描述操作入口，不代表已发布生产。所有运维动作使用显式目标配置；inspect 和未携带 apply 的命令只预览。

## 首次接入

先发布包含插件平台能力的主系统。插件表由独立增量维护创建，应用启动、浏览应用目录和部署代码都不会自动建表。

生产维护沿用既有私有配置、目标确认及数据库保护流程：

```sh
.venv/bin/python deploy/manage.py upgrade-plugins --config /etc/lele-growth/production.json
```

核对预览中的目标、待建表与 `pendingMigrations`，再添加 `--apply --confirm` 和本次返回的 targetId。维护只增加插件结构，不覆盖已有儿童、日历或积分记录。

当前插件结构为 v3（`backend/lele_growth/maintenance.py` 中的 `PLUGIN_SCHEMA_VERSION`），核心结构仍为 v6，两个版本号分别维护。首次接入依次安装 v1、v2、v3；v1 环境执行 v2、v3，v2 环境只执行 `migrate_plugin_v2_to_v3.sql`，已为 v3 时无待执行迁移。保留各版 SQL 及摘要，不改写旧迁移。

v2 为 outbox 增加事件产生时的接收对象快照；历史事件快照默认为空，不推断或补投历史订阅。v3 增加插件私有记录、加密凭据、外部操作日志/租约及资源票据表，供美森登录、草稿、幂等回执及媒体代理使用。已有投递、任务、插件记录和核心业务数据保留；本次同步设置回执复用 v3 的私有记录表，无新增结构迁移。

已有插件环境升级时，先停止旧插件运行服务，使用候选主系统代码执行上述维护预览和确认，再切换主系统并启动新版插件运行服务。家长端、管理端与运行服务应使用同一主系统版本。维护前新版家长端仍可保存核心日历操作，插件管理提示待维护；这段过渡期不新建插件事件。不得让旧版分发器在升级期间继续处理事件。迁移事务失败会同时回滚结构、版本记录和核心结构指纹，可重新预览后重试；成功后再次预览应为 `version=3` 且 `pendingMigrations=[]`。迁移前备份及真实目标上的恢复演练仍须按发布流程完成，本文不代表已执行。

本机开发库可显式执行 `.venv/bin/python scripts/dev.py plugins-setup`，再执行 `.venv/bin/python scripts/dev.py restart`；该入口固定使用本机 development 配置。

本机 `start` / `restart` 会同时启动家长端、管理端和私有插件运行服务；`stop` 会停止三者。只需恢复插件连接时执行 `.venv/bin/python scripts/dev.py plugins-runtime-start`，不用重启主应用。`status` 返回 `pluginRuntime` 就绪状态。运行服务通过带身份校验的 Unix socket `/ready` 检查，不把残留 socket 文件当成已启动；现有健康进程会复用。本机 `plugins-deploy` 使用相同的运行目录和 socket，并在部署后保持服务运行。

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

使用凭据能力的插件需要服务端密钥文件，`LELE_PLUGIN_VAULT_KEY` 指定该文件路径，默认 `/etc/lele-growth/plugin-vault.txt`，不是直接传入密钥内容。文件权限为 0600，每行是 `keyId:URL-safe Base64 编码的 32 字节密钥`；格式校验见 `backend/lele_growth/plugins/credential_vault.py`。正式环境须使用受保护的独立密钥；已有环境保留原密钥及恢复备份，不能重新生成后期待旧密文仍可解密。开发运行器的本机密钥不随发布包上传。

## 发布前构建与兼容性

主系统归档直接包含 `web/admin-dist` 和 `web/parent-dist`，必须先从同一份源码重建两端，再打包。只检查 TypeScript 或只构建插件不能更新管理端产物。

```sh
npm run check:format
npx --no-install prettier --check plugins/mison-booking/frontend
npm run test:domain
npm run build
npm run test:ipad
npm run test:plugins:ui
.venv/bin/python scripts/package_release.py
```

浏览器测试使用隔离样例；后台完整回归使用项目测试配置另行执行。正式打包要求源码和生成产物全部提交、工作区干净；`--allow-dirty` 只生成标记为 development 的本地验收包，不能作为生产发布通过的证明。

美森 1.0.30 和成长记录 1.0.1 的最低前端协议为 1.1。先部署支持该协议的主系统，再部署要求 1.1 的插件。家长端在入口和运行请求携带 `X-Plugin-Frontend-Api: 1.1`；缺少请求头按旧协议 1.0 处理，不兼容时在加载插件代码或派发 worker 前返回 `plugin_frontend_incompatible`。旧标签页须整页刷新。新宿主仍支持协议 1.0 的插件；不要通过降低清单要求来绕过兼容性检查。具体版本以各插件 `plugin.json` 为准。

美森 1.0.34 起还要求平台 API 1.2，以保存课程关联、取消墓碑并校验采集修订号。先更新家长端、管理端及私有插件运行服务，再更新插件；旧宿主会拒绝安装新包。插件结构仍为 v3，不新增数据库迁移。本机开发运行器会核对 `/ready` 的 `platformMinor` 和 `frontendMinor`，并重启协议较旧的运行进程。没有采集修订号的旧插件同步请求会被暂停，不能绕过宿主的并发保护。

美森 1.0.35 携带 Python SDK 1.1.1，修正 Linux worker 在并发读取时因 192 MiB 虚拟地址空间不足而失败的问题，上限改为 512 MiB。虚拟地址空间不等于实际驻留内存，生产 systemd 的 512 MiB 总内存预算、并发数和 CPU 限制保持不变。先更新接受 SDK 1.1.1 wheel 的宿主，再部署美森新包；宿主继续接受 SDK 1.0.0 和 1.1.0。无需数据库维护，不重新生成或替换现有凭据密钥。

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

主系统回退须验证候选旧代码能识别当前插件 v3 结构，并兼容已部署插件的前端协议、私有数据及凭据。不能直接假设迁移前的旧二进制可用；不执行删除 v3 表的结构降级，也不用旧数据库快照覆盖发布后产生的任务、积分或操作回执。

停用或下架与更新并发时，恢复以最新资格为准。已经不可撤销的外部消息不能由停用撤回；参考提醒插件只有站内执行记录，不触达外部系统。

平台级删除暂不纳入本期。家长卸载保留配置和历史数据，管理员下架使所有已安装实例失效。
