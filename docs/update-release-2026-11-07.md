# 2026-11-07 腾讯云主应用与美森约课发布

北京时间 **2026-11-07 06:59:33** 完成切换，随后完成公网和数据核验。

**当前生产已于 07:29:10 更新至主应用 `2731e82`、美森 `1.0.35`／Python SDK `1.1.1`**，修正首次真实使用时出现的 Linux worker 并发读取失败。当前标签为 `prod-20261107-2731e82`；详细热修复和新备份记录见本文末节。下面保留 06:59 首发记录。

## 固定来源与范围

- `codex/meisen-course-booking-plugin` 的 9 个提交先合并至 `main`；功能分支保留。
- 实际部署源：`62ef95c6c45a66ed36490690593f3a8c325a689e`；合并后的文件与已验证功能分支完全一致。
- 正式标签：`prod-20261107-62ef95c`，已与 `main` 一起推送 GitHub。后续发布记录提交不改变该标签或运行源码。
- `prod-20261107-9357bba` 是早期准备标签，保留记录，**未用于生产部署**；该提交生成的主应用准备包同样未激活。
- 发布家长端、管理端、私有插件运行服务，以及美森约课 `1.0.34`。正式包不包含 Demo 插件源码、包、测试库或开发凭据；生产目录和插件目录中均未登记 Demo。
- 腾讯云 `43.136.23.153`，`current` 为 `/opt/lele-growth/releases/20261107-62ef95c`。
- 家长端 <https://chenqile.cn/>；管理端 <https://admin.chenqile.cn/>。

| 制品                                                        | 来源                              | SHA-256                                                            |
| ----------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| `lele-growth-20261106-225159-62ef95c.tar.gz`，93 个清单文件 | 干净 main，purpose=release        | `f81003963682528ce73f35582bd43e433981a67ec22fb0f59201615dcecebccb` |
| `mison-booking-1.0.34.tar.gz`，21 个清单文件                | 同一个 main 提交，purpose=release | `96ab8a8585ea3b5d51ab9f4ab371c7fbf70a2e47f62a34fdea03ff630f71f7ca` |

## 发布前验证与兼容性

422 项非 Demo 后台测试、领域测试、两端构建、格式检查通过；此前完整美森前端回归及 WebKit iPad 验收通过。用户确认已完成 Chromium iPad PDF 转竖屏滚动检查和实体 iPad 验证。这两项作为用户验收记录，不改写此前自动测试的失败日志。

候选主应用使用独立 Python 3.13.18 环境，保留原生产 36 项依赖的版本；新增源码 requirements 已固定的 `websockets==15.0.1`，共 37 项依赖，依赖检查通过。服务器无需 Node.js。

在服务器相同 systemd 隔离设置下，验证美森纯 Python wheel 离线安装、独立 worker 启动与 Unix socket 健康、合成凭据 AES-GCM 加解密；未使用美森正式凭据或访问美森上游。

主应用及私有运行服务均支持平台 API **1.2**、前端 API **1.1**；美森 `1.0.34` 要求平台 1.2 / 前端 1.1。按先结构、主应用/运行服务，再单插件部署的顺序发布。旧页面读取插件时仍受前端协议检查，正式页面应完整刷新。旧版哈希资源保留，供已打开页面读取。

美森已上架，开放范围为全部儿童，初始 `installedCount=0`、`enabledCount=0`。家长从设置中的应用管理安装后自行连接美森账号；未自动安装、登录或开启课程同步，未复制本地账号及凭据。

## 数据库更新脚本与验证

继续使用原 RDS `lele_growth_v4` 和原私有 OSS。核心结构保持 **v6**，核心字段无待维护项；插件结构由 **v2 升级至 v3**，总表数 **37 → 42**。

版本化 SQL 为 [migrate_plugin_v2_to_v3.sql](../backend/lele_growth/db/migrate_plugin_v2_to_v3.sql)，新增私有记录、凭据、外部操作、租约和资源票据 5 张表。课程关联、取消墓碑、同步修订号及回执复用私有记录表，无额外业务结构变更。

通过候选版本的正常维护入口预览并使用实际返回的 targetId 明确执行，未直接导入或重建数据库：

```sh
runuser -u lele -- /opt/lele-growth/releases/20261107-62ef95c/.venv/bin/python \
  /opt/lele-growth/releases/20261107-62ef95c/deploy/manage.py upgrade-plugins \
  --config /etc/lele-growth/production.json
```

执行时追加 `--apply --confirm` 和本次预览返回的 targetId。发布后再次预览为 `version=3`、`pendingMigrations=[]`、`pendingTables=[]`；重复维护无变化。

先在仅开放私有 Unix socket 的 PostgreSQL 18 恢复实例中完成原生备份恢复、v2→v3 演练和重复维护校验。原有 37 张表的原有记录及 OID 保留，只有插件结构版本和维护审计按预期追加；全部儿童业务数据和修订号逐字核对一致。旧核心代码读取也通过，完整回退仍使用下面的兼容版本。

正式窗口为 **06:59:06–06:59:33**。停止两个主应用及旧运行服务后重新取得原生一致性备份，再升级。维护前 3 个儿童、1394 行记录；上线前后业务 SHA-256 均为 `38224c9a02acb82e39ca58db2be2bbf10e6543d2df432f87682658a0d3ed1e23`，任务、积分及历史数据保持一致。

## 私有备份

所有原始数据、配置和密钥备份仅保留在腾讯云私有目录 `/var/lib/lele-growth/release-backups/20261107-mison-release/`：

- `rehearsal.dump`：已实际恢复并用于升级演练的数据库原生备份。
- `before.dump`：停服后最终一致性原生备份，10,090,204 字节，SHA-256 为 `61f03cc062d409365ea7987d883149301982cfe74c32c509014a625ac36311d4`，`pg_restore --list` 校验通过。
- `before.json`：与原生备份使用相同导出快照的完整表、业务记录和 OID 核验副本。
- `configuration-before.tar.gz`：应用/OSS 配置、两个环境文件、服务单元及现有 Nginx 站点配置备份。
- `plugin-runtime-before.tar.gz`：发布前插件运行目录备份。
- `plugin-vault.txt`：新增生产独立密钥的私有备份，0600，不随 Git 或应用包传输。

生产密钥位于 `/etc/lele-growth/plugin-vault.txt`，由服务器本地生成，服务账号 lele 拥有、0600；未使用开发密钥。现有生产/OSS/环境/Nginx 配置与服务单元内容的摘要均保持不变。

## 公网及运行核验

- 两个主应用和插件运行服务均 active/running，`NRestarts=0`，实际进程工作目录均为本次 release。
- 两端 HTTPS、健康、当前资源、旧版保留资源、匿名鉴权、错误 Origin 和私有路径检查：自然解析 **40/40**、固定腾讯云 IP **40/40** 通过；严格校验证书。
- 两端公网 HTTP 本次均返回正确 **301**，服务器解析也指向腾讯云。先前发布的服务商 HTTP 拦截现象本次未复现。
- 本机自然解析走 198.18 网段代理映射，初轮将该中间地址误当服务器地址而中断断言；原始证据保留。随后分别验证自然访问内容/TLS，以及固定腾讯云 IP 的完整访问，不修改系统 DNS 或代理设置。
- 两张现有 OSS 图片读回后大小和摘要均一致，匿名访问均 403；未上传、删除或修改对象。
- 现有 RDS 连接配置仍为未启用 TLS，本次未改变数据库连接策略。
- 未使用正式账户做登录、预约、取消或积分验收写入；生产美森凭据数为 0，真实账号连接由家长安装后进行。

## 兼容回退与证据

旧发布 `/opt/lele-growth/releases/20261101-64e0c95` 保留原样。不能把完整旧后台/运行服务直接作为 v3 插件环境的回退组合。

已准备并在隔离恢复的 v3 库验证 `/opt/lele-growth/releases/20261107-compatible-rollback-62ef95c`：保留本次兼容后台、任务保护及运行协议，恢复旧版家长端和管理端页面。两端健康及页面内容检查通过，兼容新旧静态资源。

回退脚本为服务器 `/root/lele-growth-deployment/tencent-mison-20261107/rollback.py`，默认只预览。添加 `--apply --confirm prod-20261107-62ef95c` 才执行：停服、通过正常目录服务下架美森、原子切换至兼容版本、重启及检查两端健康。保留安装记录、凭据、密钥、任务、积分、OSS 和当前数据库增量，**不恢复旧备份覆盖上线后的数据**。本次只运行该脚本预览，未执行正式回退。

服务器私有操作和发布记录：`/root/lele-growth-deployment/tencent-mison-20261107/`。本机不含凭据的发布、HTTP 和回退证据：`output/operations/tencent-release-20261107/`。正式数据库备份、配置归档、密钥和原始业务快照没有下载至本机。

## 07:29 Linux worker 并发读取热修复

用户报告进入美森后出现“应用进程暂时无法处理请求”。生产日志显示首次登录后并发调用返回 503，之后短暂恢复，加载教师和头像时又出现失败；主服务未异常重启，systemd 没有内存耗尽记录。

根因为 Python SDK 对 Linux worker 的虚拟地址空间设置了 192 MiB 上限，不能承载正常 Python 多线程及缓存的地址空间需求。该指标与实际驻留内存不同：排障时 worker 实际占用约 34 MiB，地址空间峰值已接近限制；并发调用丢失 worker 并进入重启退避。先前的单次健康探针未覆盖此场景。

对同一个正式 worker 临时调高地址空间限制后，相同四路宿主设置只读调用全部成功；随后发布持久修复。新建进程已确认自带 `RLIMIT_AS=536870912`，不依赖临时 `prlimit`。观察到虚拟地址空间约 335 MiB、实际内存约 39 MiB。原有并发上限、CPU 限额和 systemd 的 512 MiB 总实际内存预算保持不变。

- 来源提交：`2731e8202e58b7cccb3ee36b4b02a8195fecc913`，已提交并推送 main。
- 固定生产标签：`prod-20261107-2731e82`。
- 主应用路径：`/opt/lele-growth/releases/20261107-2731e82`。
- 主应用包：`lele-growth-20261106-232441-2731e82.tar.gz`，SHA-256 `29973a500cd3b3a3e5ce2a23c5f62754692f20411332e142e3afdca38aaceb78`。
- 美森包：`mison-booking-1.0.35.tar.gz`，SHA-256 `ec1f8c81a9e03f79223e7682415b6d644bf6c63053cdc71ed4e4f2bfa2009f25`，包含 SDK 1.1.1。宿主同时兼容旧 SDK 1.0.0、1.1.0。
- 本机 424 项非 Demo 后台回归通过；腾讯云相同 systemd 隔离和 512 MiB 内存预算下 9 项真实 worker/包验证测试通过，新增 64 MiB 合成缓存及四路同时调用场景。测试不连接正式库、不访问美森。
- 07:28:50–07:29:10 完成最终备份和切换；无数据库迁移，宿主依赖版本不变，未发布 Demo。
- 以正常私有 RPC 和现有连接只读验证：四路 `course-sync` GET、`bootstrap`、`teacher-filters`、`teachers` 均为 HTTP 200 / `ok=true`，实际教师列表返回 20 条。未重新登录、预约、取消或变更同步设置，未输出账号或 token。
- 三个服务均 active，`NRestarts=0`。安装资格、配置、绑定、加密凭据及私有记录在更新前后逐字一致，业务数据及修订号未变，现有密钥和生产配置未变。

新增原生备份为 `/var/lib/lele-growth/release-backups/20261107-mison-release/worker-hotfix-before.dump`，10,110,653 字节，包含当时 42 张表、1417 行及现有加密登录记录。SHA-256 为 `a4e93e3f077ab935d23312e68805d81d12ee397f514c4b083d7cd988df7ae4db`。同目录保存前后完整核验快照及 `plugin-vault-before-worker-hotfix.txt` 私有密钥备份；这些原始文件未下载至本机。

本次热修复的操作目录为 `/root/lele-growth-deployment/tencent-worker-hotfix-20261107/`，本机不含秘密的证据为 `output/operations/tencent-worker-hotfix-20261107/`。该目录的 `rollback.py` 默认只预览，需 `--apply --confirm prod-20261107-2731e82` 才回退宿主至 `20261107-62ef95c`；保留已安装的美森 1.0.35 / SDK 1.1.1 和当前数据库，不退回包含 192 MiB 限额的旧插件。本次未实际执行回退。
