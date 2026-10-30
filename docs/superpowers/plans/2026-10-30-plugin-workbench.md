# 儿童成长工作台插件系统 Implementation Plan

> **For agentic workers:** 使用 `subagent-driven-development` 按任务执行，先完成依赖任务再并行独立工作；每个任务验证后集成，所有 `[ ]` 表示尚未实施。

**Goal:** 交付儿童共享的插件安装、启停、两类入口、管理员发布范围控制，以及不重启主系统的单插件更新能力。

**Architecture:** 同仓库分制品，平台统一目录/权限/配置/导航；插件前端独立 ESM 构建，有后端能力的插件运行在独立工作进程，通过本机协议访问平台能力。以 PostgreSQL 持久化任务、事件、版本和部署阶段，允许目标插件更新中短暂停用。

**Tech Stack:** 现有 React / TypeScript / Vite、Python / FastAPI / httpx、PostgreSQL、Linux systemd、现有 unittest 与浏览器验收工具。

**设计依据：** [完整设计与官方资料参考](../specs/2026-10-30-plugin-workbench-design.md)。这是一份架构与实施分解方案，不包含尚未编写的完整产品源码；下述拟新增路径和命令均为实施交付目标。

---

## 1. 执行边界

- 用户已经确认儿童共享、页面型/后台型、三种发布状态、指定儿童范围及允许目标插件短暂更新中。
- 负责人管理、卸载保留数据、强制失效后手动恢复等补齐规则见设计第 1 节，按明确默认值实现，不能误标成用户逐条确认。
- 本次仅整理方案。实施阶段留在 `codex/plugin-mode`；正式发布使用单独的发布流程。
- 首次主系统接入需要一次主系统发布；后续单插件更新不得重新构建主系统资源或重启 parent/admin。
- 先保持现有核心功能完整，用两个小插件验收整个机制，不同时拆迁日历和积分商城。

## 2. 模块与文件职责

下表路径均相对仓库根目录 `/Users/xiaobin/Desktop/项目/乐乐成长`。

| 路径 | 职责 |
| --- | --- |
| `backend/lele_growth/plugins/manifest.py` | 清单与资源图校验、兼容性判定 |
| `backend/lele_growth/plugins/catalog.py` | 目录、运营资料、发布范围、版本登记 |
| `backend/lele_growth/plugins/policy.py` | 家长/儿童/后台任务统一运行资格判断 |
| `backend/lele_growth/plugins/installations.py` | 安装、启停、卸载、重新启用与修订号 |
| `backend/lele_growth/plugins/configuration.py` | schema 校验、配置读写及不支持字段拒绝 |
| `backend/lele_growth/plugins/routes.py` | 复用现有入口认证，分发插件管理接口 |
| `backend/lele_growth/plugins/gateway.py` | 业务调用、版本门禁和内部身份上下文 |
| `backend/lele_growth/plugins/state_store.py` | 儿童插件命名空间数据、幂等效果 |
| `backend/lele_growth/plugins/supervisor.py` | 工作进程生命周期、隔离及健康检查 |
| `backend/lele_growth/plugins/scheduler.py`、`events.py` | 调度、租约、事件投递与重试 |
| `backend/lele_growth/plugins/deployment.py` | 单插件更新状态机、切换与恢复 |
| `backend/lele_growth/db/add_plugin_platform.sql` | 插件平台增量表、索引及约束 |
| `frontend/parent/src/plugins/` | 类型、状态客户端、按需加载器、插件页面容器 |
| `frontend/parent/src/settings/applications.tsx` | 家长应用目录与已安装管理 |
| `frontend/parent/src/settings/plugin-config-dialog.tsx` | 平台通用配置弹窗 |
| `frontend/admin/src/pages/plugins/` | 插件列表、资料表单、发布范围和版本记录 |
| `packages/plugin-sdk/`、`packages/plugin-sdk-python/` | 版本化开发合同、客户端和辅助工具 |
| `scripts/build_plugin.mjs`、`scripts/package_plugin.py` | 独立构建、包白名单和摘要 |
| `deploy/plugins.py`、`deploy/plugin_runtime.py` | 运维入口、运行服务入口 |
| `deploy/lele-growth-plugin-runtime.service` | Linux 运行服务和资源限制 |
| `plugins/growth-notes/`、`plugins/reminder-demo/` | 页面型与后台型参考插件 |

`child_service.py` 只保留必要的入口路由与业务事件调用，不继续堆入完整插件实现。新模块可按规模拆分，但上述职责不能重新合并到单个大文件。

## 3. 实施任务

### Task 1：冻结插件清单和前后端合同

**新增：** `packages/plugin-sdk/src/index.ts`、`packages/plugin-sdk/schema/plugin.schema.json`、`packages/plugin-sdk-python/pyproject.toml`、`packages/plugin-sdk-python/src/lele_plugin_sdk/`、`backend/lele_growth/plugins/manifest.py`。
**测试：** `tests/backend/test_plugin_manifest.py`。

- [ ] 将设计第 7 节清单落实为严格 schema；拒绝未知关键字段、重复 ID/version、非法路径、后台型声明页面入口，以及未支持的平台协议/能力。
- [ ] 固定前端合同，独立导出类型，禁止引用宿主内部业务类型：

```ts
export type PluginContext = {
  child: { id: string; name: string };
  releaseId: string;
  signal: AbortSignal;
  api<T>(path: string, options?: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
  }): Promise<T>;
  notify(message: string): void;
  navigateCore(view: "calendar" | "store" | "settings"): void;
};
export type PluginModule = {
  mount(container: HTMLElement, context: PluginContext): () => void;
};
```

- [ ] 固定后端协议：health、handle_request、handle_job、cancel_job、shutdown；所有业务调用必须携带服务端签发的儿童上下文与取消标识。
- [ ] 用真实最小清单夹具验证合法 page/service、缺入口、越界资源路径、协议不兼容和重复版本。
- [ ] 文档记录协议 1.0，后续任务以其为输入，代码实现和清单变更必须同时更新合同测试。

### Task 2：建立数据表及显式增量维护

**新增：** `backend/lele_growth/db/add_plugin_platform.sql`、`tests/backend/test_plugin_schema.py`。
**修改：** `backend/lele_growth/maintenance.py`、`production_maintenance.py`、`child_service.py` 的结构检查、`scripts/dev.py` 的隔离测试初始化。

- [ ] 建立设计第 8 节全部表、外键、唯一约束和状态索引，插件表版本独立记录，不重写儿童业务快照或日历 revision。
- [ ] 维护命令先只读展示待建表和目标环境，再由现有显式 apply 路径执行；Web 启动和首次插件请求不得自动迁移。
- [ ] 增量维护可重复执行；错误中断时整体事务回退或明确显示已完成阶段。
- [ ] 用空测试库及带原有儿童/任务/积分数据的测试库分别升级；比对原数据、修订号和计数完全一致。
- [ ] 增加安装唯一、任务 occurrence 唯一、事件投递唯一和部署锁竞争测试。

### Task 3：实现资格判定、共享安装及配置生命周期

**新增：** `policy.py`、`installations.py`、`configuration.py`、`state_store.py`、`tests/backend/test_plugin_lifecycle.py`。

- [ ] 统一实现设计第 5 节 effective_enabled 条件；路由、任务和最终写入复用，不能各自简化。
- [ ] 实现安装/启用/停用/卸载/重装/重新启用；默认配置有效才允许首次安装直接启用。
- [ ] 写操作携带 operationId、expectedRevision；配置与安装的并发更新冲突返回 409。
- [ ] 实现 JSON schema 支持子集和按儿童共享配置；拒绝首期不支持的 secret 字段，不执行表单中的代码。
- [ ] 明确锁顺序与 fencing：禁止插件 gateway 持有儿童事务等待进程响应；状态写入在最终事务中再检查 generation/epoch。
- [ ] 测试两家长读同一配置、普通成员不可管理、儿童 A/B 隔离、停用后旧请求拒绝、卸载重装保留配置且不自动启用。

### Task 4：管理员登记、上架和范围管理

**新增：** `catalog.py`、`routes.py`、`tests/backend/test_plugin_admin.py`。
**修改：** `backend/lele_growth/child_service.py`、`accounts_app.py`。

- [ ] 部署登记仅在首次创建时写 pending；重复登记和新版本不覆盖运营信息、发布状态、范围和儿童安装记录。
- [ ] 实现设计第 8 节管理接口与儿童选择接口，限定 admin 入口且只返回必要儿童元数据。
- [ ] 上架验证资料、活动版本及指定范围；实现下架、范围原子切换及受影响实例 requires_reenable。
- [ ] 上下架、范围变化、资料修改写审计摘要；列表计数区分已安装、家长选择启用和实际有效启用。
- [ ] 测试全量不自动安装、指定儿童看不到目录也不能直接调用、缩小范围停止对应儿童、重新上架仍需负责人启用。

### Task 5：家长目录、状态同步与通用配置弹窗

**新增：** `frontend/parent/src/plugins/types.ts`、`client.ts`、`store.ts`、`settings/applications.tsx`、`settings/plugin-config-dialog.tsx`。
**修改：** `frontend/parent/src/settings/index.tsx`、`settings/types.ts`、`lib/runtime.ts`。
**测试：** `tests/browser/plugin_management_acceptance.cjs`。

- [ ] 增加应用管理设置入口、名称搜索、发现/已安装两个视图，全部围绕当前儿童。
- [ ] 用同一平台表单渲染器实现 schema 配置；未启用插件不导入任何业务模块。
- [ ] 落实负责人管理/其他成员只读、停用可配置、失效仅查看与卸载、更新中可停用卸载但不可修改配置。
- [ ] 独立插件状态 store 与日历快照分开；前台 5 秒摘要刷新，聚焦/切换儿童立即更新，取消过期请求。
- [ ] 对两独立浏览器会话验证共享变化；离线、冲突和切换儿童时不得显示另一儿童的配置。
- [ ] 检查键盘焦点、表单校验、窄屏弹窗滚动，沿用共享 UI 和字体规范。

### Task 6：动态导航与独立前端资源加载

**新增：** `frontend/parent/src/plugins/loader.ts`、`plugin-page.tsx`、`tests/browser/plugin_loading_acceptance.cjs`。
**修改：** `frontend/parent/src/App.tsx`、`lib/runtime.ts`、`backend/lele_growth/accounts_app.py`。

- [ ] 将导航类型扩展为核心页面与 `{kind:"plugin", pluginId}` 的明确联合类型，不在源码枚举具体插件 ID。
- [ ] 页面型依共享状态生成 Tab；后台型不生成；更新/故障保留平台占位入口。
- [ ] entry 接口返回已授权活动版本，从固定同源资源根加载 ESM 和作用域 CSS；不预取未进入插件。
- [ ] 卸载、儿童切换、停用、版本变化执行 dispose、AbortController 取消和过期 mount 隔离。
- [ ] 对静态路由校验会话、有效成员及启用资格、版本和发布资源清单；依赖分块同样校验，禁止路径遍历和公开内部 manifest，不以会话全局当前儿童覆盖多个标签页。
- [ ] 用浏览器网络记录证明未安装/停用/后台型没有业务 JS 请求，配置弹窗不破例；慢加载时切换儿童不会残留旧页面。
- [ ] 插件抛错显示本插件错误状态，主导航和核心页面可继续使用。

### Task 7：独立工作进程及平台能力网关

**新增：** `gateway.py`、`supervisor.py`、`deploy/plugin_runtime.py`、`deploy/lele-growth-plugin-runtime.service`、`tests/backend/test_plugin_runtime.py`。

- [ ] 工作进程按插件独立启动，使用该 release 的虚拟环境；纯前端无进程；无有效实例不运行儿童业务。
- [ ] 通过 Unix socket/httpx 和受限服务身份调用，不将工作进程端口暴露公网，不共享 parent/admin 的进程内对象。
- [ ] 上下文绑定 plugin、child、actor/job、能力、generation、configRevision、releaseEpoch 和期限；运行服务内部网关验证后访问数据。
- [ ] 首期开放插件命名空间记录读写及 reference 插件实际需要的能力；不提供原始 SQL 和全量儿童快照。
- [ ] 实现健康检查、调用超时、关闭、取消、重启退避和资源预算；插件挂掉不阻塞核心请求线程。
- [ ] 测试伪造儿童/能力/epoch、过期上下文、插件崩溃、启动失败和最后一个有效实例停用。

### Task 8：统一调度、事件与可停止执行

**新增：** `scheduler.py`、`events.py`、`tests/backend/test_plugin_jobs.py`。
**修改：** `backend/lele_growth/child_service.py` 业务提交处与儿童归档/删除分支。

- [ ] 定时任务持久化且领取有租约、心跳和超时回收；唯一键不包含代码版本，防止更新触发重复业务项。
- [ ] 成功的 task.completed 在原事务写 outbox；分发和插件执行在提交后进行，按插件独立记录消费位置。
- [ ] 任务创建、领取、结果提交三处验证资格；每个运行任务持有 generation/epoch fencing，取消旧版本仍不可写。
- [ ] 重试、uncertain、misfire 与 Asia/Shanghai 默认时区按设计第 9 节落实；退出浏览器不改变调度资格。
- [ ] 测试停用/下架与领取并发、重复事件、租约过期、更新期间任务、儿童删除、两插件互不影响，以及外部结果未知不盲目重发。

### Task 9：独立构建、制品校验和开发流程

**新增：** `scripts/build_plugin.mjs`、`scripts/package_plugin.py`、`tests/backend/test_plugin_package.py`。
**修改：** `package.json`、`scripts/package_release.py`、`scripts/release_assets.py`、`scripts/dev.py`。

- [ ] 先建立 `tests/fixtures/plugins/` 的最小 page/service 制品夹具，为每个插件生成独立 ESM、作用域 CSS、后端 wheel 及声明文件；固定 SDK 版本，包内不依赖宿主 Vite 哈希资源。下方 growth-notes 命令在 Task 11 提供实际插件后验收。
- [ ] 分别验证插件资源图、可执行入口、文件摘要、平台协议和 Python/OS/架构；拒绝缺失依赖和同版本覆盖。
- [ ] 发布包白名单排除密钥、开发数据库、日志、源码环境和临时文件；解包拒绝链接、绝对路径、目录逃逸和超限文件。
- [ ] Linux 后端制品在匹配生产的构建环境生成；安装依赖仅进入插件自己的 venv。
- [ ] 主包打包继续通过原有校验，且不带入插件源目录；完整交付允许编排多个独立包。
- [ ] 增加本地插件运行入口与独立测试配置；只监听本机，不读取生产配置。

拟新增命令合同：

```sh
npm run plugin:build -- growth-notes
.venv/bin/python scripts/package_plugin.py --plugin growth-notes
```

期望输出：`output/plugin-releases/growth-notes/1.0.0/` 下的包及 SHA-256 文件；主系统构建文件和另一个插件制品摘要保持不变。

### Task 10：单插件更新、回退与崩溃恢复

**新增：** `backend/lele_growth/plugins/deployment.py`、`deploy/plugins.py`、`tests/backend/test_plugin_deployment.py`。

- [ ] 部署入口显式接受目标配置、包路径和插件 ID；默认预览，不从 Web 请求执行包脚本。
- [ ] 完整实现设计第 10 节 prepare → updating → drain → activate → ready，并记录阶段、锁租约、旧/新活动版本。
- [ ] 磁盘准备与数据库切换分别处理；只有验证通过后才将目标插件置为更新中，活动版本切换事务包含资源和后端版本。
- [ ] 首期只允许无需转换或已验证前后兼容的数据变化；不兼容升级预览时报错，不能默认自动回退数据库。
- [ ] 更新中允许撤销行为；恢复按数据库最新资格，不用部署前 enabled 快照覆盖家长的后续选择。
- [ ] 注入每阶段进程中断，验证可恢复；模拟新进程无法启动、回退失败和并发部署，确保状态确定。
- [ ] 对主系统 parent/admin 进程 ID、连续健康/业务请求及另一插件进行观测，证明单插件更新不触发主系统重启。

拟新增运维命令合同（实施前不可运行）：

```text
deploy/plugins.py inspect  --config <目标配置> --package <插件包>
deploy/plugins.py deploy   --config <目标配置> --package <插件包>
deploy/plugins.py deploy   --config <目标配置> --package <插件包> --apply --confirm <预览目标ID>
deploy/plugins.py rollback --config <目标配置> --plugin <插件ID> --version <目标版本>
deploy/plugins.py recover  --config <目标配置> --plugin <插件ID>
```

deploy/rollback/recover 默认预览；写操作均要求 apply 和匹配目标 ID。展示插件自身影响范围、当前/候选版本和数据兼容结果，生产操作沿用受限维护模式。

### Task 11：管理端页面及两类参考插件

**新增：** `frontend/admin/src/pages/plugins/index.tsx`、`detail.tsx`、`scope-picker.tsx`、`plugins/growth-notes/`、`plugins/reminder-demo/`。
**修改：** `frontend/admin/src/App.tsx`、`components/admin-layout.tsx`。
**测试：** `tests/browser/plugin_admin_acceptance.cjs`、`tests/browser/plugin_update_acceptance.cjs`。

- [ ] 实现插件列表、三状态筛选、详情资料、指定儿童选择、上下架影响提示、运行状态与部署记录。
- [ ] 页面型成长随记提供最小记录列表/新增功能，使用平台命名空间 API，验证两家长共享和不同儿童隔离。
- [ ] 后台型提醒示例提供共享时间配置和执行记录，使用隔离测试接收器；代码中不植入真实收件人和发送凭据。
- [ ] 为两插件各构建 1.0.0 与兼容的 1.0.1，实际演练一次单独更新及回退，并检查记录不丢失。
- [ ] 检查目标插件 updating 占位、另一插件持续可用、管理员下架后旧家长页面不可继续操作。

### Task 12：整体回归、上线材料和开发文档

**新增：** `docs/plugins/development.md`、`docs/plugins/deployment.md`、`docs/plugins/acceptance.md`。
**修改：** `docs/project-structure.md`、`docs/development.md`、`deploy/README.md`、`tests/browser/unified_browser_smoke.cjs`。

- [ ] 将插件专项接入隔离测试入口，不复用 development 业务数据；保留已有账号、日历、积分和设置回归。
- [ ] 运行下列现有命令，检查预期为通过；插件集成测试不能以 SKIP 代替通过：

```sh
npm run check:parent
npm run check:admin
npm run test:domain
npm run test:backend
npm run build
npm run test:browser
npm run check:typography
npm run check:layout
```

- [ ] 记录设计第 12 节每条验收对应的用例、结果和证据；浏览器覆盖 1280×900、820×1180、390×844，不将模拟结果写成真机通过。
- [ ] 编写插件创建、配置 schema、任务能力、独立构建、单独发布、回退和故障恢复说明；示例命令必须在本机隔离环境实际走通。
- [ ] 首次上线准备包含平台增量建表、运行服务配置、固定代码版本与回退兼容核验；不自动给所有儿童安装示例插件。
- [ ] 评审通过后提交阶段成果；生产部署、公开上架及真实通知接入分别按具体任务执行。

## 4. 依赖与集成顺序

```text
Task 1 → Task 2 → Task 3 → Task 4
                     ├→ Task 5 → Task 6
                     └→ Task 7 → Task 8
Task 1 → Task 9
Task 4 + Task 7 + Task 8 + Task 9 → Task 10
Task 4 + Task 5 + Task 6 + Task 10 → Task 11 → Task 12
```

Task 5/6 与 Task 7/8 可在合同固定后并行；Task 9 可独立推进。Task 11 的后台页面可以提前制作，最终参考插件及更新演练须等 Task 10。每个阶段提交只包含对应任务文件，不混入其他工作区修改。

## 5. 关键验收案例

| 编号 | 操作 | 必须观察到的结果 |
| --- | --- | --- |
| P01 | 爸爸为儿童 A 启用页面型，妈妈进入 A | 相同 Tab 与配置；儿童 B 没有该安装 |
| P02 | A 安装后台型，修改时间，关闭浏览器 | 无 Tab；后台仍按已保存时间执行 |
| P03 | 打开未安装/停用插件详情与配置 | 没有该插件业务 JS/CSS 网络请求 |
| P04 | 管理员范围只包含 A，B 伪造 entry/runtime 请求 | 拒绝，不能泄露 A 的配置或数据 |
| P05 | 已打开插件时管理员下架 | 新业务调用和待执行任务立即被门禁拒绝；前台同步为已下架 |
| P06 | 旧任务执行中停用，再尝试写入 | 旧 generation 无法提交；已进入外部调用的结果单独记录 |
| P07 | 更新提醒示例，持续操作日历与成长随记 | 只有提醒示例更新中；其他操作成功且 parent/admin 未重启 |
| P08 | 更新期间家长停用，更新完成 | 保持停用，不自动恢复 |
| P09 | 候选版本启动失败或部署工具中断 | 旧版本可恢复，阶段可追溯，无永久 updating |
| P10 | 新旧任务重复投递同一业务项 | 内部效果只出现一次；外部结果未知不盲重试 |
| P11 | 更新、产生新记录、回退兼容版本 | 新记录仍在，未恢复旧数据库快照 |
| P12 | 下架后重上架；卸载后重装 | 保留数据，负责人重新启用后才恢复工作 |
| P13 | 爸爸妈妈同时保存共享配置 | 一方成功另一方收到冲突，不静默覆盖 |
| P14 | 缺文件、越界路径、协议不兼容制品 | 在进入更新中之前拒绝，当前可用版本不受影响 |
| P15 | 最后一个有效儿童实例停用 | 不再执行插件业务，并停止无用途的工作进程 |

## 6. 本次方案交付状态

本次完成官方资料核对、现有代码入口与发布流程检查、设计和实施任务整理。尚未编写插件业务代码、执行数据库升级、运行实现期测试或发布生产。文档中的测试命令、验收目标和新文件路径是后续实施要求，不代表已经通过。
