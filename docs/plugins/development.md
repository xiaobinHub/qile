# 插件开发约定

平台与前端 API 当前支持 1.1，继续兼容声明 1.0 的插件。插件与平台同仓库开发，每个插件单独构建和部署。管理后台决定发布状态和儿童范围；家庭负责人决定当前儿童是否安装及启用。全家共享状态、配置及菜单。

## 目录及类型

参考 `plugins/growth-notes/`（页面型）与 `plugins/reminder-demo/`（后台型）。每个目录提供 `plugin.json`、`schemas/config.json`，以及可选的 frontend/backend。

需要覆盖完整接入特性时，参考 `plugins/demo-page/` 和 `plugins/demo-service/`；[完整 Demo 指南](demo-plugins.md)提供能力矩阵、测试步骤与独立验收命令。

- 页面型：`type=page`，启用后自动出现顶部入口。第一次进入时才加载 ESM 与样式；使用 `mount(container, context)` 并返回清理函数。
- 后台型：`type=service`，`frontend=null`，没有顶部入口。配置弹窗由平台统一渲染，不执行插件页面代码。
- 页面型也可以声明后端任务。插件 ID、类型和代码入口由技术清单决定，管理员编辑展示资料，不编辑执行路径。

前端合同见 `packages/plugin-sdk/src/index.ts`，可读 JSON Schema 见 `packages/plugin-sdk/schema/plugin.schema.json`。服务端 `plugins/manifest.py` 是上线时实际执行的严格校验器。

## 前端

使用 `overlay`、`isActive` 或 `onVisibility` 的插件必须声明 `frontendApi: { "major": 1, "minMinor": 1 }`。宿主在入口及运行接口发送 `X-Plugin-Frontend-Api: 1.1`；旧页面没有该请求头，按 1.0 处理。服务器在交付入口或调用后端前检查兼容性，入口响应同时返回 `frontendApi` 供加载器再次检查。不兼容返回 `plugin_frontend_incompatible` 并提示刷新整个页面；前端提供整页刷新操作。声明 1.0 的插件仍可由旧页面访问。

独立 ESM 导出 `mount(container, context)`，在容器中构建自己的界面。`context` 提供当前儿童显示信息、活动版本、AbortSignal、本插件 API、通知和返回核心页面的导航。禁止导入平台内部业务对象或宿主带哈希的构建分块。

页面插件第一次进入、入口尚未挂载完成时，宿主在整个插件区域显示一套全屏标准骨架，不使用随内容收缩的小卡片。`mount()` 返回后宿主撤下这套骨架。仍需等待首屏数据的插件，要在 `mount()` 里同步画出自己的全屏骨架，不能先留白。两套骨架都铺满同一区域，交接时允许轮廓变化。已经挂载的插件再次切回时，不重放宿主骨架。加载失败、停用和更新中仍使用原来的状态卡。翻页、筛选和插件内部的后续加载由插件自己处理。

从日历、积分商城、设置或其他页面插件离开时，宿主保留当前儿童、当前会话里已经打开过的全部页面插件，不重新加载入口。页面只是被挂起：移出布局和焦点，`signal` 不中止。只有正在显示的插件可见，其余插件和它们的浮层保持隐藏且不可交互。某个插件第一次进入时才加载；不要因为插件数量淘汰已打开的实例。`context.isActive()` 表示当前是否正在显示；`context.onVisibility` 在离开和返回时通知。返回后可以静默刷新轻量状态，不要清空列表、滚动位置、草稿或打开中的弹窗。

弹窗、抽屉和浮层必须渲染到宿主提供的 `context.overlay`，不要挂到 `document.body`。挂起时要放开焦点圈定、页面点击锁和 Escape，避免挡住日历或其他插件，但不要因此关掉弹窗。

以下情况仍卸载并中止该范围内的全部页面插件：切换或归档儿童、退出登录、会话代次变化，以及插件状态尚未确认。停用、卸载、更新、版本或配置变化、加载失败后重试和开发热更新只卸载对应插件。dispose 必须移除定时器、监听和本插件 DOM；异步响应应检查 signal，不能在这些上下文变化后继续渲染。

CSS 仅作用于插件根节点，不能重置 body、按钮或宿主主题。

插件记录接口通过 context.api 调用：

```ts
const result = await context.api<{ records: Array<{ id: string; payload: unknown }> }>(
  "records/notes",
)
await context.api("records/notes/record-123", {
  method: "PUT",
  body: { payload: { text: "今天的小进步" }, operationId: crypto.randomUUID() },
})
```

平台绑定儿童与插件命名空间，检查活动版本、安装和运行资格；插件不自行指定另一个儿童。写入响应未知时重试同一 operationId 和同一请求体，不生成新的操作编号。

## 配置

配置为声明式 JSON Schema 子集，支持文本、数字、布尔、枚举、枚举多选、时间与时区，以及分组说明。实际支持字段以 `plugins/configuration.py` 为准。服务器和前端同时校验；未知字段和可执行表达式拒绝。

配置为儿童共享数据，有独立修订号；同时编辑发生冲突时重新读取，不能静默覆盖其他家长。公开配置 Schema 仍拒绝 password、token、secret 等凭据字段。插件结构 v3 已提供 `plugin.private-state`、`plugin.credentials`、`plugin.external-operations` 和 `plugin.resources` 私有能力，美森通过私有 Bridge 保存加密凭据和外部操作回执；不把凭据放进公开配置或前端存储。其他插件或外部通知渠道须单独实现并核验适配器，不能把现有能力声明当作接口已接通。

## 后端

后端使用 `packages/plugin-sdk-python` 的 worker 协议。首期交付纯 Python wheel，在插件自己的虚拟环境安装，运行时不依赖宿主源码目录。主系统不 import 插件模块。

处理函数：`health()`、`handle_request(context,path,method,body)`、`handle_job(context,task,payload)`；可选 `cancel_job` 和 `shutdown`。返回 JSON，持久化业务效果通过 `effects` 声明：

```python
def handle_job(context, task, payload):
    return {"effects": [{
        "collection": "executions", "id": payload["occurrenceKey"],
        "payload": {"message": context["config"]["message"]},
    }]}
```

平台在接收效果时重新检查权限和版本，旧进程不能绕过停用。不要在模块导入、health 或自己创建的永久定时器里执行业务。SDK 和插件代码均不接收数据库凭据。

后台运行不依赖家长登录或浏览器开着。停用、卸载、下架和范围收回都会失效任务；退出登录只清理该浏览器页面。

`task.completed` 在核心完成操作的同一事务内记录当时已订阅、已安装启用且位于发布范围内的插件及安装代次。每个不同事件逐条投递，同一事件重试通过持久去重键避免重复效果；事件不适用定时任务的 `skip` 或 `latest` 合并规则。

首次安装、新增事件订阅、重新上架或重新启用都不接收此前无资格时的事件。事件产生后若停用、卸载或收回范围，旧安装代次不能在重新启用后恢复投递。部署更新期间保持订阅快照，完成后按最新兼容版本继续处理。接收者快照是平台内部元数据，不传给插件。

定时任务按儿童实例分页扫描，游标跨轮推进并在末尾回到开头；每轮有数量和时间预算，异常或失效实例不阻塞后续实例。定时任务的错过策略仍由清单决定。

## 独立构建

在项目根目录：

```sh
npm run plugin:build -- growth-notes
.venv/bin/python scripts/package_plugin.py --plugin growth-notes --allow-dirty
npm run plugin:build -- reminder-demo
.venv/bin/python scripts/package_plugin.py --plugin reminder-demo --allow-dirty
```

打包命令会先基于当前源码重新构建，并复核提交及工作区状态，避免把过期构建标记为当前版本。产物位于 `output/plugin-releases/<id>/<version>/`。`--allow-dirty` 只产生开发制品，生产拒绝。正式交付先提交确认的源代码，再省略该参数打包。同 ID 同版本禁止覆盖，功能变更必须增加版本号。

后端包内包括锁定 SDK 和插件 wheel；首期不接受原生平台 wheel。主系统发布包不携带插件源目录，插件构建也不重新构建主系统。

参考插件仅用于验证平台：成长随记记录文字；提醒示例只记录执行，不向真实联系人发送消息。公开上架前需完善介绍与使用说明并选择儿童范围。

## 源码热更新

本地开发可使用 `npm run plugin:dev -- mison-booking`，接口联调追加 `--with-backend`。参见[本地开发模式](development-mode.md)。

## 私有记录读取兼容

具备 `plugin.private-state` 的后端可通过 Bridge 调用 `private.get`。请求中的 `includeExpired` 为可选布尔值，默认 `false`，此时仍隐藏超过 `expiresAt` 的记录。显式传 `true` 可读取本儿童、本插件下保留的旧记录，用于取消旧业务 TTL 等兼容场景；不跳过安装、权限、生命周期或账号凭据校验，调用方仍须校验业务账号范围和提交资格。`private.put` 传 `expiresAt: null` 取消该条记录的存储 TTL。美森草稿使用此方式兼容旧数据，登录会话、凭据及其他记录的到期规则不变。
