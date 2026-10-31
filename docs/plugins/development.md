# 插件开发约定

插件协议为 1.0。插件与平台同仓库开发，每个插件单独构建和部署。管理后台决定发布状态和儿童范围；家庭负责人决定当前儿童是否安装及启用。全家共享状态、配置及菜单。

## 目录及类型

参考 `plugins/growth-notes/`（页面型）与 `plugins/reminder-demo/`（后台型）。每个目录提供 `plugin.json`、`schemas/config.json`，以及可选的 frontend/backend。

需要覆盖完整接入特性时，参考 `plugins/demo-page/` 和 `plugins/demo-service/`；[完整 Demo 指南](demo-plugins.md)提供能力矩阵、测试步骤与独立验收命令。

- 页面型：`type=page`，启用后自动出现顶部入口。进入页面时才加载 ESM 与样式；使用 `mount(container, context)` 并返回清理函数。
- 后台型：`type=service`，`frontend=null`，没有顶部入口。配置弹窗由平台统一渲染，不执行插件页面代码。
- 页面型也可以声明后端任务。插件 ID、类型和代码入口由技术清单决定，管理员编辑展示资料，不编辑执行路径。

前端合同见 `packages/plugin-sdk/src/index.ts`，可读 JSON Schema 见 `packages/plugin-sdk/schema/plugin.schema.json`。服务端 `plugins/manifest.py` 是上线时实际执行的严格校验器。

## 前端

独立 ESM 导出 `mount(container, context)`，在容器中构建自己的界面。`context` 提供当前儿童显示信息、活动版本、AbortSignal、本插件 API、通知和返回核心页面的导航。禁止导入平台内部业务对象或宿主带哈希的构建分块。

CSS 仅作用于插件根节点，不能重置 body、按钮或宿主主题。dispose 必须移除定时器、监听和本插件 DOM；异步响应应检查 signal，不能在儿童切换后继续渲染。

插件记录接口通过 context.api 调用：

```ts
const result = await context.api<{records: Array<{id: string; payload: unknown}>}>("records/notes")
await context.api("records/notes/record-123", {
  method: "PUT",
  body: {payload: {text: "今天的小进步"}, operationId: crypto.randomUUID()},
})
```

平台绑定儿童与插件命名空间，检查活动版本、安装和运行资格；插件不自行指定另一个儿童。写入响应未知时重试同一 operationId 和同一请求体，不生成新的操作编号。

## 配置

配置为声明式 JSON Schema 子集，支持文本、数字、布尔、枚举、枚举多选、时间与时区，以及分组说明。实际支持字段以 `plugins/configuration.py` 为准。服务器和前端同时校验；未知字段和可执行表达式拒绝。

配置为儿童共享数据，有独立修订号；同时编辑发生冲突时重新读取，不能静默覆盖其他家长。首期拒绝 password、token、secret 等凭据字段。接入真实外部通知渠道前，需要扩展平台凭据能力。

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
