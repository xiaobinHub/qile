# 美森约课插件：前端与接口完整实施方案

> 面向接手实现的工程师或模型。按本文任务逐项执行并记录证据；具备技能环境时可使用 `subagent-driven-development` 组织独立任务。本文是实施合同，配套 API 合同是字段与错误语义的唯一来源。不要重新引入已被用户否定的一级 Tab。

**Goal：** 在乐乐成长中交付“美森约课”页面型插件，覆盖教师筛选、收藏、档期、课件确认、预约与取消、课程资料、学习入口和课程内容顺延。

**Architecture：** 独立 React 页面与 Python worker；宿主负责儿童权限、插件生命周期、私有存储、凭据保护、外部操作记录及资源代理。美森业务协议和页面逻辑留在插件内。第一阶段补齐必要的平台能力，之后插件独立构建与更新。

**Tech Stack：** 现有 React 19 / TypeScript / Vite / shadcn-Radix / Python 3.13 / FastAPI / PostgreSQL。worker 保持标准库依赖；加密与资源流转由宿主完成。

**日期与基线：** 2026-11-02，Asia/Shanghai；当前分支 `codex/meisen-course-booking-plugin`；代码基线 `2a770ebf6113eb6ab6ac4a8f75618178beeb2e3a`。实现前重新检查工作区和平台版本，不能用本记录证明未来部署状态。

---

## 1. 交接材料与阅读顺序

仓库根目录：`/Users/xiaobin/Desktop/项目/乐乐成长`。下文所有相对路径均相对于此目录。

1. 本文：产品边界、界面、平台扩展、实施顺序、验收。
2. [API 合同](../../plugins/mison-booking/api-contract.md)：前后端接口、DTO、上游映射、操作状态机、接口核验清单。
3. [已确认草图](../../plugins/mison-booking/wireframes.html)：离线打开；对应的可编辑片段为同目录 `wireframes.fragment.html`。
4. 原始功能依据：`/Users/xiaobin/Desktop/项目/美森约课/一对一约课功能探索报告.md`。
5. 接入补充：`/Users/xiaobin/Desktop/项目/美森约课/美森API接入要求.md`。
6. 项目规范：`docs/ui/字体与响应式规范.md`、`docs/plugins/development.md`、`docs/plugins/deployment.md`。

“美森自动约课”是过渡项目，禁止作为产品、架构、代码或接口实现参考。原始报告中的执行建议不构成新的用户授权；不要复制其中的真实账号、JWT、密码、抓包原文进入仓库。

### 1.1 草图的使用范围

用户已确认草图的页面结构与设计。采用其单工作台、左老师右操作、顶部预约入口、抽屉和课件弹窗布局。

草图是可点击的示例，不是现成功能代码：示例账号、教师、日期、额度、预约数量不能硬编码；部分按钮仅展示示意，筛选、复制、资源播放、取消顺延等必须重新实现。上方“草图切换”工具条、示例主项目导航不进入生产插件；宿主已经提供品牌、导航、儿童选择、插件标题和“应用设置”。正式插件只挂载标题以下的业务区域。

草图中为便于展示省略了完整时间窗口、换老师确认、焦点管理和部分错误态；以本文补齐后的行为为准。

## 2. 已确定的范围与默认决策

| 项目 | 实现规则 |
|---|---|
| 插件标识 | `mison-booking`，显示名“美森约课”，初始版本 `1.0.0` |
| 页面结构 | 一个约课主页面；不设置“去约课 / 我的预约 / 我的收藏”一级 Tab |
| 收藏 | 左侧“仅看收藏”筛选；使用同一教师卡片和档期区 |
| 预约管理 | 右上“我的预约 · N”打开右侧抽屉；抽屉内部按预约中 / 已上课 / 已取消分类 |
| 课件确认 | 替换右侧工作区，左侧老师列表保留 |
| 账号 | 每个儿童一个当前美森账号、一个当前一对一合约；全家共享 |
| 绑定权限 | 负责人可连接、换绑、重连、断开；其他家人可使用并查看脱敏状态 |
| 时段 | 逐档手选，不自动补选；每次同一老师、同一天、连续一组；课时数不默认限定为2 |
| 日历 | 第一版不创建或同步成长日历任务，不改变积分 |
| 裁剪 | 温馨提示弹窗、在线客服、智能约课计划及其接口不实现 |
| 保留 | 推荐老师、推荐下一课、教师介绍视频、资料、预习、作业、回放、课程内容顺延 |
| 分享 | 复制老师的姓名、简介与可约信息，不实现微信等原生系统分享 |
| 自动化 | 不自动抢课、不后台登录、不定时预约；无任务和事件订阅 |
| 密码 | 仅当前登录请求使用，不持久化；令牌在服务端加密存储和复用 |
| 时间 | 业务日期一律 Asia/Shanghai；浏览器系统时区不改变约课日期 |
| 发布 | 本文不授权上线；先完成隔离验收与可审查制品 |

同一个美森账号可能被不同儿童绑定：本地草稿、配置、权限必须隔离；上游账号内的收藏与课程天然共享，不能伪称美森提供儿童级数据隔离。跨实例写操作按美森用户指纹串行，避免共用账号额度与预约冲突。

## 3. 页面与交互合同

### 3.1 公共框架

业务区顶部左侧为连接状态与“管理”，右侧为“我的预约 · N”。N 采用上游待上课总数；未知时不显示0，不用当前分页条数替代总数。刷新失败保留旧值并标注未刷新。

初次未连接：业务区显示连接卡，负责人填写账号密码；非负责人显示“请儿童负责人连接美森账号”。没有有效一对一合约时显示明确空态，不能展示通用空教师列表。

左栏宽度：≥1200px 为360px，1024–1199px 为320px；右栏自适应，列间距16px。<1024px 改为老师列表与档期详情主从切换；返回保持筛选与滚动位置。草图中用于较小预览宽度的280px侧栏不作为正式PC宽度。

所有页面共用宿主 token：`--background`、`--card`、`--foreground`、`--primary`、`--border`、`--radius-*` 与语义字号。页面标题由宿主提供22/30；详情标题20/28，分组16/24，卡片15/22，正文14/22，说明13/20，徽标12/18。生产 CSS 不复制草图的固定字号和示例配色。

### 3.2 左侧：找老师与收藏

1. 姓名支持回车或点击搜索。清空后立即查询，保留其他筛选。
2. 日期、时段、标签使用 Popover。打开时拷贝已应用值为编辑值；“重置”只清当前面板；“应用”提交；X、点击外部、Esc 丢弃未应用值。
3. 日期单选，默认不限。时段多选，上午/下午/晚间分组，实际档位来自接口。标签按授课人群、教学能力、课堂风格分组多选，AND匹配。
4. 已应用条件展示 Chip，可逐个删除。“清空筛选”清空姓名、日期、时段、标签，**保留“仅看收藏”模式**，避免用户失去收藏上下文；取消收藏模式由用户单独关闭开关。
5. 收藏模式无时间限制时展示所有收藏老师，包括暂时无可约档期的老师；叠加日期或时段时只展示满足条件者。不得只在当前已加载的搜索页中取交集而漏掉收藏老师。
6. 卡片显示头像、姓名、收藏星、简介两行、标签、推荐标记、最近可约时间。姓名和头像打开档案；卡片空白与“查看档期”选择老师；星标点击不能触发选择老师。
7. 普通老师和推荐老师分组。只对推荐池翻页；按教师ID去重，普通老师不重复追加。搜索条件改变时重置查询游标。
8. 首次自动展示首位老师，但不自动选课。后续修改筛选不自动切换正在查看的老师；右栏继续明确显示当前老师姓名。
9. 收藏按钮采用请求完成后确认的状态；请求中禁用同一老师的重复操作。失败恢复原状态，全部出现位置同步。
10. 空态区分“未收藏”“筛选无结果”“加载失败”“部分结果仍在查找”。部分扫描失败不能伪装成没有结果。

### 3.3 右侧：选择时段

教师头部：头像、姓名、标签、收藏、每课时时长、查看档案。下方步骤标题“①选择时段 → ②确认课件”。

日期条每屏展示7天，可前后滚动全部接口窗口；可约日依接口数组，不能固定14/17天。服务端输出窗口基准日期，防止跨午夜或客户端时区产生一天偏差。

选择老师时优先使用左侧筛选日期；未限定时使用最近可约日期。右侧换日不改左侧筛选。没有可约日期时显示该教师空档期提示及返回老师列表入口。

时段网格桌面6列，中屏4列，窄屏3列。显示完整时间模板，不仅草图中的09:00–20:30。状态为可约、已选、本人已约、他人占用、未排班；后两种显示不可约，辅以可读原因。上游他人userid在服务端归一化后丢弃，不能返回浏览器。

点击单档只选/取消该档。选择中的间隔允许存在，但下一步禁用并解释；连续性按时间模板相邻且实际间隔符合档位步长验证，不能只按数组索引跨过缺失档位。末班时段不自动添加跨日课程。

底部显示每档实际起止和课时数；示例10:00–10:25、10:30–10:55。上课25分钟和时段步长30分钟分别建模，不将两者混同。

有选择时换老师或换日期，弹“切换后将清空本次已选时段与课件”，提供保留/切换。仅查看别人的教师档案不改变预约对象；点击档案内“查看档期”才触发上述切换流程。

每次进入下一步、提交前、页面恢复前台且档期缓存超过30秒时重新核对；失效项显式移除并提示。不在背景周期轮询。

### 3.4 右侧：确认课件与预约结果

进入确认时按课时数请求推荐，展示上次学到和每课时一行。推荐不足时标记待补选并阻止提交，不自动复制同一课件凑数。推荐为空时允许自选；推荐接口失败显示重试，不能当成“没有学习记录”。

返回选时段保留草稿。课时变化后按时间键保留仍有效的手选课件，只为新增课时补推荐；重新检查重复和作废状态。

“更换课件”打开宽弹窗，左分类树支持任意深度，右列表支持分页；显示面包屑、已学/新课件/不可用/本次已选。暂存单选，点击“使用此课件”才提交选择；关闭不改变原课件。当前课时原课件可保持；其他课时已选禁止重复。`choosed`上游标记和本地草稿去重同时检查。

有取消/作废关联内容时增加“待补学内容”来源切换，复用选择器。不将所有未学课件等同于取消课件列表，也不复制原App的`alwaysway`本地偏好。

额度使用服务端返回的 `remaining/total`，不固定每日5次。不因打开、翻页、展开分类扣额。点击预览/确认更换前展示扣额说明；扣额操作必须调用经核验的上游流程，不允许直接读公开PDF绕过预览计数。未知额度时禁用扣额动作并允许重试。

点击提交后按钮加载中，不能二次点击；其他可能改变账号/草稿的操作禁用。草稿与 operationId 在结果未确认期间保留。成功直接替换右栏内容；显示实际老师、日期、全部时间、本次消费。“继续预约”清除已提交选择并刷新档期；“查看我的预约”打开抽屉并高亮新课节，课节ID尚未同步时显示“预约成功，正在同步课程记录”，不诱导再次提交。

### 3.5 我的预约抽屉

PC宽640px（屏幕不足时限制为可用宽度），<768px全屏。抽屉内容可滚动，标题、状态切换和底部操作可见；背景保留原约课上下文。

“预约中”按开始时间升序；“已上课”“已取消”按上课日期倒序，不伪称已取消接口提供取消发生时间。使用日期分组课程卡，不采用整页表格。

每卡展示老师头像、完整日期/时段、课件名、状态。预约中：去上课、课程资料下拉、取消；已上课：观看课程、课程资料、课后作业；已取消只展示。超长名称两行截断且可展开查看全文，不能只依赖鼠标悬停。

常驻工具只保留刷新、日期筛选和“更多”。课程内容顺延在“更多”中，进入后才出现复选框、全选可操作项、已选数量、退出与提交。全选仅当前已加载且可操作记录，并显示数量，不默默选取未加载课程。

距开课不足3小时、缺少cid、上游明确禁止的课程不能顺延。前端使用服务端时间；提交前服务端重新判断。不能据此推导取消课程也有3小时限制，取消以它自己的上游规则为准。

取消确认展示本次点击的真实课节，默认不勾“取消后顺延课程内容”。两步取消的部分成功见API合同；失败不关闭弹窗。取消完成后刷新列表、数量和受影响档期。关闭确认框回到原预约抽屉及滚动位置。

批量顺延按上游真实语义执行；不加拖拽改时间、不自行编排课件顺延算法。提交前列出选中课节与影响说明；成功刷新实际课程内容。

### 3.6 教师档案、资源与账号

教师档案为抽屉：头像、姓名、收藏、全文简介、标签、视频、复制老师信息、查看档期。视频不自动播放，关闭/卸载时停止并释放播放器。复制使用 Clipboard API，失败时显示可选择的文本；不得只弹“已复制”而没有复制。

资料下载和预览只展示学员有权访问的资源；不能因为返回了`teacher_file_url`就暴露教师版PPT。PDF优先同源预览，下载名称由服务端净化。上课/回放/预习/作业有官方PC入口时新标签打开；否则显示经验证的官方客户端使用方式。绝不编造H5链接、猜测`isLive`就是回放地址。

账号连接采用“登录 → 识别可用课程 → 确认绑定”。单一合约可直接确认；多个提供名称与有效状态选择；候选列表没有可用合约则说明原因。换绑前说明将清空当前草稿并切换预约数据，已预约课程不会被取消。

美森会话失效只改变插件连接状态，不登出乐乐成长。断开连接清除凭据和缓存、撤销资源票据；不调用美森账号注销接口，不取消课程。默认不调用上游logout，避免处理含糊的终端语义；用户明确重连才login，禁止每次进页登录。

### 3.7 状态模型与浮层原则

```ts
type WorkspaceStep = 'schedule' | 'confirm' | 'success';
type DraftDestination = { kind: 'teacher'; teacherId: string; date: string | null }
  | { kind: 'date'; date: string } | { kind: 'connection' };
type Drawer = null | { kind: 'bookings'; status: 'upcoming'|'completed'|'cancelled' }
  | { kind: 'teacher'; teacherId: string };
type Dialog = null | { kind: 'courseware'; slotStart: string }
  | { kind: 'cancel'; bookingKey: string }
  | { kind: 'account' } | { kind: 'resource'; resourceId: string }
  | { kind: 'discard-draft'; destination: DraftDestination };
// bindingRevision、queryKey、requestGeneration 随请求携带；旧响应不得覆盖新状态。
```

只允许一个大抽屉；小确认框可覆盖抽屉，返回时恢复。课件选择弹窗不能再次打开另一个选择器。所有浮层具备Esc、焦点圈定、打开时聚焦、关闭恢复焦点；提交中不能以关闭来暗示请求已撤销。

浏览器草稿仅存本次插件会话内存；后端保留30分钟的权威草稿及revision。sessionStorage仅可记待核对operationId及不含隐私的作用域键，供刷新恢复查询；不保存密码、令牌、资源签名URL或完整学习记录。卸载、儿童切换时由宿主context.signal终止请求；换筛选/账号时递增generation并丢弃旧响应，清理旧监听、视频与作用域状态。当前api没有逐请求signal参数，不能假设自行创建AbortController就能中止宿主请求；更不能把浏览器中止等同于上游撤销。

### 3.8 前端事件与请求编排

| 页面事件 | 调用顺序与状态变化 |
|---|---|
| 挂载页面 | GET bootstrap；未连接停在连接卡；已连接并行GET teacher-filters与teachers，选首位后GET其schedule；不自动login |
| 应用筛选 / 仅看收藏 | 生成新的queryKey，清旧cursor；GET teachers；保留右栏老师，旧generation响应不得追加 |
| 选择老师 / 日期 | 有草稿先确认；通过后GET schedule；只读请求失败保留原可见数据并标未刷新，不清成空列表 |
| 下一步 | 本地验证时段非空、连续且不超服务端bookingLimits；新草稿POST drafts，原草稿同老师同日改时段PUT slots；等待服务端复查和推荐后进入confirm |
| 打开课件选择 | 按需并行GET categories、quota；选叶子后GET courseware；保留slotStart与draftRevision，翻页不扣额 |
| 预览 / 使用此课件 | 创建一次operationId；POST preview或PUT对应课时courseware；显示进行中/未决，拿到权威Draft后一次替换，不在UI自行扣额度 |
| 提交预约 | 固定draftId/revision和operationId；POST bookings；成功右栏变success，未决保留确认内容并展示核对入口；后台只允许GET核对 |
| 打开我的预约 | GET bookings(upcoming)；切状态/日期重置查询；building期间按cursor继续，同一查询只保留一个推进请求；全部完成再展示排序后的页 |
| 取消 / 顺延 | 先确认真实课节与选项，再发对应POST；若operation未决/待修复按canReconcile/canRepair显示动作；成功刷新列表、数量和受影响档期 |
| 打开资料 / 学习入口 | 只读resources返回允许动作；需要副作用的入口调用POST actions；按Resource.action决定内嵌、下载、官方网页或App说明 |

所有相对路径见API合同。GET参数用URLSearchParams编码；数组先用逗号连接再编码，不能直接拼中文昵称。每个queryKey用递增generation防竞态；同key只读请求可合并，写请求不做通用自动重试。共用api.ts对Result失败进行类型化处理，按钮只在所属请求生命周期内loading。

quota为null、bookingLimits未核实、草稿过期、课件待补选时分别给出具体阻止理由；不能把全部情况归为“提交失败”。bookingLimits.maxContiguousLessons必须来自G02证据；为null时book能力暂不可用，不能默认2或无限。仅已核验单课时能力时可明确返回1，并准确说明上限。

## 4. 已复核的工程现状与必须补齐项

| 当前事实 | 实施落点 |
|---|---|
| PluginContext只有child、releaseId、signal、api、notify、navigateCore | 不从前端猜负责人；bootstrap由后端给`canManageConnection` |
| 普通配置明确拒绝password/token/secret | 账号管理单独走业务API，凭据进入新vault，不放config或公开records |
| 现有records允许家庭成员按集合访问 | 新增独立私有存储；换一个集合名不等于安全存储 |
| worker没有数据库凭据，仅支持返回effects | 新增私有bridge；worker仍不访问宿主数据库 |
| effects在上游调用之后才落库 | 不能用于预约发送前的防重；新增外部操作日志与发送前登记 |
| runtime与supervisor默认单请求10秒 | 加清单声明、服务端验证的有限预算；不全局无限延时 |
| worker wheel目前不安装第三方依赖 | 使用urllib/http.client/ssl等标准库；不能写httpx import后假设能运行 |
| gateway只支持JSON业务响应 | 图片/视频/PDF单独同源流式资源路由，不能base64塞进worker返回 |
| 宿主CSP只允许self/指定OSS | 资源代理解决，不修改成`*`或放行整个互联网 |
| plugin build目前只有entry.ts且无@shared alias | 补通用alias/TSX构建；保留entry.ts薄入口 |
| SDK打包脚本硬编码1.0.0 | 改为读取SDK元数据，避免新源码仍标旧版本 |
| plugin schema为v2 | 新增v3增量；版本检查要识别旧版本对应表集，不能先加入新表就判v2损坏 |

## 5. 平台扩展设计（协议1.1，向后兼容1.0）

### 5.1 清单与构建

新插件清单目标：

```json
{
  "manifestVersion": 1,
  "id": "mison-booking", "version": "1.0.0", "type": "page",
  "name": "美森约课", "description": "查看老师档期、预约一对一课程并管理课程资料。",
  "platformApi": {"major": 1, "minMinor": 1},
  "frontendApi": {"major": 1, "minMinor": 0},
  "frontend": {"entry": "frontend/entry.js", "styles": ["frontend/style.css"]},
  "backend": {"entryModule": "mison_booking", "requestTimeoutSeconds": 45},
  "configSchema": "schemas/config.json", "dataSchemaVersion": 1,
  "capabilities": ["plugin.private-state", "plugin.credentials", "plugin.external-operations", "plugin.resources"],
  "resourceOrigins": ["https://file.mison.cn"],
  "tasks": [], "events": [], "icons": ["assets/icon.png"]
}
```

这些capability、backend.requestTimeoutSeconds和resourceOrigins是**需要新增**的合同，不是现有能力。清单验证器与JSON Schema同时更新；1.0清单无新字段继续按10秒运行。平台API允许minMinor 0/1，前端API仍只0；不能把共用`_api`直接放宽后宣称前端也支持1.1。requestTimeoutSeconds为1–45的整数；resourceOrigins为最多16个去重的HTTPS origin，仅支持精确域名、默认443端口、无路径/查询/通配符；声明资源能力才允许填写。其他已核验CDN只能经清单更新和发布审查加入，浏览器和worker不能临时放宽。

Python SDK版本升为1.1.0，worker HTTP传输的健康检查协议字符串保持1.0以兼容现有supervisor；新BridgeClient是新增库功能。打包器从pyproject读取版本。新插件不要声明公开state能力或jobs/events。

config schema为空对象、additionalProperties=false：安装启用不要求在通用配置表单填账号，账号连接在插件页完成。

`scripts/build_plugin.mjs`加入`@shared`别名与React/TSX支持；插件使用共享Button/Input/Badge等控件。新布局使用根节点`.mison-booking`作用域CSS，不重复导入Tailwind preflight或修改body。共享组件现有utility由宿主CSS提供；插件不新增依赖宿主尚未编译的新utility。如需修改共享组件或新增共享样式，纳入本次宿主发布。

Dialog/Sheet portal必须属于插件自己的portal根节点；当前共享DialogContent没有portalContainer参数，可增加可选参数并保持原默认行为，Sheet同样核对。不可让卸载后浮层残留在body。禁止导入宿主的业务runtime单例或打包分块。

### 5.2 私有Bridge

runtime新增`bridge.sock`，权限0600，与control.sock分离。worker仅接收`LELE_PLUGIN_BRIDGE_SOCKET`路径，不接收control.token、vault主密钥或数据库配置。SDK BridgeClient通过Unix HTTP发送已有scopeToken签名上下文。

请求形状：`{context, action, payload}`。runtime用transport_signer验证、重新检查活动安装/发布版本/儿童权限，随后分派白名单动作。不要将bridge挂载到家长或管理端HTTP。

| Bridge动作 | 能力及规则 |
|---|---|
| `actor.info` | 从签名actorId查询当前用户与成员关系，返回owner/member及可用动作；不信任浏览器role |
| `private.get / private.put / private.delete / private.batch` | plugin.private-state；只在当前child/plugin命名空间；put/delete需expectedRevision；单记录64KiB；batch支持带回执的本地原子写入，不能修改预留binding/credential/operation集合 |
| `credential.get / credential.stage / credential.candidates / credential.discard` | plugin.credentials；get仅给当前worker；其余检查负责人，只管理候选凭据，10分钟TTL；活动凭据不能独立覆盖或删除，不返回浏览器 |
| `binding.commit / binding.disconnect` | 同时要求private-state与credentials；负责人、候选归属与CAS校验；同一事务更新绑定、切换/撤销凭据、撤销票据及保存本地幂等回执 |
| `operation.fingerprint / operation.begin / operation.mark-dispatch / operation.stage / operation.finish / operation.get` | plugin.external-operations；发送前持久登记，requestHash和资源锁防重，状态限制见API合同 |
| `resource.issue` | plugin.resources；生成绑定儿童、凭据版本与资源来源的短时同源资源票据 |

Bridge API输出也用`{ok,data}`或`{ok:false,error}`，业务异常不能抛裸ValueError让worker只回`invalid_request`。签名里的actorId只证明原请求来源；每次敏感动作须重新验证用户active、儿童成员/负责人和安装资格。

Bridge输入最小合同如下；childId/pluginId/actorId从context取，不接受payload覆盖：

| 动作 | payload / 返回data |
|---|---|
| private.get | `{collection,recordId}` → `{record:null或{payload,revision,expiresAt}}` |
| private.put / private.delete | `{collection,recordId,expectedRevision,payload?,expiresAt?}`；新建expectedRevision=0，冲突不覆盖 |
| private.batch | `{operationId,requestHash,mutations:[{type:'put'或'delete',collection,recordId,expectedRevision,payload?,expiresAt?}],response}` → 保存的response；最多16条、总计256KiB，同事务检查全部revision并保存幂等回执 |
| credential.stage | `{operationId,provider,token,expiresAt,maskedAccount,identity,candidates}` → `{pendingConnectionId,expiresAt}`；候选元组由worker从可信上游识别后提供，仅存服务端；同operationId重复不新增候选 |
| credential.candidates | `{pendingConnectionId,expectedRevision,candidates,complete,nextCursor}` → 候选元数据与新revision；GET发现过程补充结果用，不改token、不延长TTL |
| credential.get / credential.discard | `{credentialId,expectedRevision?}`；get返回token仅供worker；discard只删除当前负责人创建的候选 |
| binding.commit | `{operationId,expectedBindingRevision,pendingConnectionId,candidateKey}` → 新绑定摘要；事务内采用保存的候选元组，不接受客户端合约ID |
| binding.disconnect | `{operationId,expectedBindingRevision}` → 未连接摘要及递增版本；一并撤销活动与候选凭据 |
| operation.fingerprint | `{operationId,method,path,canonicalRequest}` → `{requestHash,keyId}`；涉及密码时仅在内存计算服务端HMAC，禁止body日志；已存在操作按原keyId核对，密钥不返回worker |
| operation.begin | `{operationId,kind,bindingRevision,requestHash,keyId,resourceKeys,sanitizedRequest,baseline}` → `{mayExecute,operation}`；登录前身份归并见API合同 |
| operation.mark-dispatch / operation.stage | `{operationId,expectedStageVersion,stage}` → `{operation,deadline,completionReceipt}`；后续外部阶段仍须重新校验完整context，完成回执不能授权发送 |
| operation.finish / operation.get | finish提交`{operationId,expectedStageVersion,completionReceipt,state,result,evidence}`；get提交`{operationId}`；阶段CAS，结果白名单化，禁止把token放result |
| resource.issue | `{resourceId,bindingRevision,credentialId,credentialRevision,url,purpose,mimeType,filename}` → 同源Resource；来源须符合活动清单resourceOrigins |

private.batch仅供本地草稿/缓存写入与回执合并，不持事务执行HTTP。账号两种binding动作在专用实现中完成，不能拆成credential与private的连续调用。receipt查找先于CAS校验：同请求重放返回已存结果；当前绑定已再次变化时返回BINDING_CHANGED，不重做旧换绑。私有缓存中的预约草稿应冻结在dispatching期间，避免两个页面同一草稿revision边改课件边提交。credential.stage可先保存identity已确认、candidates为空的令牌，再用credential.candidates补齐识别结果；binding.commit只能选用complete且eligible的已存候选。

请求预算45秒由清单读取，gateway→RuntimeClient→runtime→supervisor一致传递；browser不能指定。scope TTL至少预算+30秒且不超过120秒。上游单次连接5秒、读10秒；每次业务调用设置35秒总截止时间，查询剩余工作通过cursor继续。worker capacity保留4，单账号同时最多2个只读请求、1个写操作。禁止持有数据库事务等待上游网络。

### 5.3 私有存储与凭据

迁移文件：`backend/lele_growth/db/migrate_plugin_v2_to_v3.sql`。新增表采用现有child_plugins复合外键，不改变日历和积分表。

| 表 | 必需字段/约束 |
|---|---|
| `plugin_private_records` | child_id, plugin_id, collection, record_id复合主键；payload JSONB、revision、expires_at、timestamps；无浏览器通用records访问 |
| `plugin_credentials` | id、child_id、plugin_id、provider、key_id、nonce、ciphertext、revision、expires_at、masked_account、state、timestamps；候选与活动凭据分开 |
| `plugin_external_operations` | operation_id UUID；child/plugin/actor、binding_revision、credential_id/revision、remote_fingerprint、kind、request_hash、hash_key_id、resource_keys、state、stage、stage_version、sanitized_request、baseline、result、timestamps；同child/plugin/operationId唯一 |
| `plugin_external_leases` | plugin_id+remote_fingerprint主键；operation_id、lease_until；以事务锁实现跨进程串行，不仅使用Python锁 |
| `plugin_resource_tickets` | 不可猜随机ticket主键；child/plugin、credential_id/revision、binding_revision、安装generation、upstream_url、purpose、mime、filename、expires_at |

binding/current保存用户ID、课程班ID、一对一合约ID、liveid、显示名称、凭据引用、bindingRevision；凭据内容不嵌入该记录。与现有configRevision分开；每次换绑/断开递增bindingRevision。

大查询快照按UTF-8编码字节拆成≤64KiB的私有记录：`query_meta/{queryId}`存筛选hash、上游游标、状态、chunkCount、总条数、revision和TTL；`query_chunks/{queryId}:{index}`存不拆单条对象的记录数组。先写完整新分片，再以CAS发布meta；读者仅使用meta引用的已完成分片。异常遗留分片同TTL清理；单条对象超过限制直接返回结构错误。全量排序在worker临时内存内完成后写新一代分片，不能把8MiB快照塞入单条64KiB记录或1MiB响应。

生命周期清理：草稿30分钟、查询及资源票据5分钟、候选凭据10分钟；本地幂等回执保留7天，外部终态结果保留90天后移除课程详情但长期保留operationId/hash/终态最小墓碑，防止旧ID再次发送。未决/待修复操作不得按TTL自动删除；超时租约仅释放执行占用，未决资源阻挡仍生效。使用宿主维护任务清理，插件不额外申请jobs能力。儿童删除时按宿主生命周期级联处理；插件禁用不抹除未决证据。

凭据加密使用AES-256-GCM，12字节随机nonce，AAD包含provider/plugin/child/credentialId。主密钥由0600的运行配置文件提供，仅runtime读取；key_id支持轮换，新写用活动key，旧key只解密。requirements显式固定`cryptography==50.0.2`（本机基线已有版本），不在worker wheel中引入原生依赖。缺key时该插件返回连接能力不可用，不回退明文。

公开响应、审计、异常和测试报告只允许白名单字段；不记录密码、JWT、salt、rnd、完整上游登录响应。令牌payload只能帮助提取标识，用户身份必须由真实成功登录/会话核验确定，不能单凭JWT decode视为已认证。

迁移状态检查按版本维护必需表集：v2只有原13表，v3才包含新表；否则现有`plugin_schema_status`的`not pending`会在升级前误报损坏。v1/v2 SQL及source hash不能改写。新结构通过显式maintenance事务升级，并保持现有schema指纹机制。

### 5.4 资源代理

浏览器只接收 `/api/children/{childId}/plugins/mison-booking/media/{ticket}`，不接收美森Bearer。票据默认5分钟，GET每次核验平台会话、成员关系、插件生效、绑定版本与票据过期时间。浏览器media请求不依赖自定义X-Plugin-Release头，资格从票据和当前安装比对。

首期图片/视频/PDF只允许活动清单resourceOrigins中的HTTPS CDN域名；已知`file.mison.cn`，头像其他域名必须在核验记录确认后更新清单。禁止localhost、私网、IP字面量、userinfo、非HTTPS和任意跳转；重定向最多2次且每跳重新校验目标及解析地址，防SSRF和DNS重绑定。校验后的IP必须用于实际连接并保持TLS hostname/SNI校验，不能校验后交给默认客户端重新解析；不能仅检查字符串后缀。

流式下载由宿主httpx处理，解耦1MiB worker JSON限制；验证类型，图片≤10MiB，PDF/学员资料≤50MiB，教师视频≤200MiB。大资源读取有总大小与时间限制，不载入全部内存；视频支持单Range并返回正确206/416、Content-Range、Accept-Ranges。仅将客户端Range转发到验证过的公共资源，不转发Cookie或美森JWT。

PDF可使用同源iframe/blob预览；大视频通过同源media URL播放。维持现有CSP限制，并显式加入`media-src 'self' blob:`；不能给connect-src或frame-src加通配符。下载使用attachment和净化后的文件名，浏览器不得执行上游HTML错误页。资源票据失效仅刷新票据，不重复扣预览额度。

需要带美森身份的官方H5上课地址不得伪装成公共CDN代理。由插件解析经证实的官方打开方式，见API能力合同。

## 6. 文件职责与实施任务

以下文件尚未创建，均是实现目标；不要因方案列出路径就当成现成功能。各任务提交前运行对应检查，小步提交，不把演示数据写入现用儿童。

### T0：接口证据与契约冻结

- [ ] 按配套API合同G01–G07核验账号识别、多课时编码、额度、顺延、资源、列表顺序和作废课件。
- [ ] 在`docs/plugins/mison-booking/upstream-verification.md`记录端点、入参、业务成功条件、样本日期、证据等级和脱敏样本位置。
- [ ] 测试样本放`tests/fixtures/mison/`，每个样本清除凭据/真实联系信息并替换标识。
- [ ] 先从报告、既有抓包/APK中提取已有证据；不能参考临时自动约课项目。实时读操作和消费额度/预约/取消等真实写入分开；真实写入只使用明确指定的测试账号/课程。
- [ ] G项未完成时可以实现Mock页面与适配器接口，但不能声明真实功能完成；尤其不能猜endpoint后发送写请求。

### T1：平台1.1、Bridge与v3迁移

修改：`backend/lele_growth/plugins/{manifest,gateway,supervisor}.py`（RuntimeClient也在supervisor.py内）、`deploy/plugin_runtime.py`、`backend/lele_growth/{maintenance,accounts_app}.py`（增量维护及media路由/CSP）、`packages/plugin-sdk/schema/plugin.schema.json`、`packages/plugin-sdk-python/pyproject.toml`、`scripts/package_plugin.py`、`requirements.txt`。

新增：`backend/lele_growth/plugins/{private_bridge,private_store,credential_vault,external_operations,resource_proxy}.py`、`packages/plugin-sdk-python/src/lele_plugin_sdk/bridge.py`、v3 SQL、`tests/backend/test_plugin_private_bridge.py`、`tests/backend/test_plugin_external_operations.py`、`tests/backend/test_plugin_resource_proxy.py`。

- [ ] 先写跨儿童/跨插件/旧签名/非负责人vault写入被拒、v2升级、同operationId重放等回归。
- [ ] 实现上述有边界的Bridge及数据表，复用平台认证和锁顺序：catalog→child→binding→external lease→operation，不在网络期持锁。
- [ ] 增加可选45秒预算，验证旧插件仍10秒且健康检查兼容。
- [ ] 账号断开/换绑阻止新发送，已经发送的外部请求仍可结束；其最终结果只写旧绑定操作日志，不改新绑定页面。旧worker不能凭失效context任意写入：发送登记时签发仅限该operation完成回执的短期completion凭证，Bridge允许写终态证据但禁止启动后续上游步骤。
- [ ] 历史数据迁移与主密钥配置完成后才进入真实账号联调。

### T2：插件骨架、构建与UI组件

新增：

```text
plugins/mison-booking/
  plugin.json
  schemas/config.json
  assets/icon.png
  tsconfig.json
  README.md
  frontend/
    entry.ts                 # mount/createRoot/unmount
    app.tsx                  # 单工作台与浮层协调
    api.ts                   # PluginContext封装、契约解析
    types.ts                 # 配套合同DTO
    state.ts                 # reducer、queryKey、草稿与操作状态
    style.css                # 仅.mison-booking作用域
    components/
      teacher-list.tsx
      teacher-filters.tsx
      teacher-profile.tsx
      schedule-panel.tsx
      booking-confirmation.tsx
      courseware-picker.tsx
      bookings-drawer.tsx
      cancellation-dialog.tsx
      connection-dialog.tsx
      resource-viewer.tsx
      plugin-overlays.tsx
  backend/mison_booking/
    __init__.py              # health/handle_request，受控错误封装
    routes.py                # method/path/输入验证
    contracts.py             # DTO白名单输出
    upstream.py              # 标准库HTTP、deadline、业务envelope
    connection.py            # 登录候选、识别、绑定、会话失效
    teachers.py              # 搜索、收藏、档期与去重
    courseware.py            # 推荐、树、候选、额度与选择
    bookings.py              # 预约/取消/列表/核对/顺延
    resources.py             # 学员资源和官方打开方式
    operations.py            # Bridge操作编排；不重造DB日志
    normalize.py             # ID/时间/上游格式转换
```

- [ ] 保留entry.ts，使用`createRoot(container)`和`React.createElement(App,{context})`，TSX经本插件tsconfig编译。
- [ ] 补构建alias；共享依赖打入插件自己的bundle，不依赖宿主内部hash块。
- [ ] 对应修改`scripts/build_plugin.mjs`、`package.json`及`frontend/shared/src/components/ui/{dialog,sheet}.tsx`；所有可选参数保持现有调用兼容。
- [ ] 用契约Mock实现8个草图状态及本文异常态，移除草图导航和假通知。
- [ ] 扩展字号检查脚本为可指定插件目录，或新增插件专项，避免现有check未扫描plugins却误报已覆盖。

### T3：连接与教师浏览

- [ ] 实现bootstrap、连接候选、课程选择、绑定CAS、重连/断开与负责人鉴权。
- [ ] 接入教师元数据、查询、收藏、日期和档期；缓存键包含child/bindingRevision/teacher/date/filter。
- [ ] 已登录复用token；401/50000/13000统一为美森登录失效，返回插件错误，不向宿主返回HTTP401。
- [ ] 明确收藏筛选完整性：未扫描完推荐池时不能显示“无匹配”；查询继续机制见API合同。
- [ ] TeacherProfile独立于选中预约老师，关闭档案不改变草稿。

### T4：课件与预约闭环

- [ ] 实现服务端草稿：同绑定、老师、日期、时段与课件选择，revision+TTL；浏览器不能把任意课件或跨儿童合约直接提交。
- [ ] 推荐和选择器按合同工作；区分previewTicket与selectionReceipt，确保获取文件不绕过扣额。
- [ ] 实现发送前operation登记、档期复查、上游提交、无cid回读匹配、未知结果核对。
- [ ] 多课时按核验过的原生批量方式提交；若上游不支持，不擅自拆成多次单课并伪称原子成功，应按证据反馈限制并更新实现记录。
- [ ] 加载/超时/部分成功/课件失效/重复提交的UI和接口测试全部通过。

### T5：预约抽屉、取消、顺延与学习资源

- [ ] 三状态列表与课程卡；数量采用真实总数，日期筛选覆盖全部查询结果。
- [ ] 两阶段取消及repair；同cid多家长并发只发一次有效取消，adjustLessons在原操作内固定不可重放时修改。
- [ ] 内容顺延用G04确认后的适配器；3小时边界双端检查，不实现预约时间拖动。
- [ ] 所有资源入口按返回capability实现，字幕、作业完成状态等只用有证据字段；素材代理、下载、视频Range、PDF及官方PC/客户端回退均验收。

### T6：隔离集成、故障注入与发布制品

新增专项：`tests/backend/test_mison_*.py`、`tests/domain/mison_booking_tests.cjs`、`tests/browser/mison_booking_acceptance.cjs`、`tests/fixtures/plugins/mison_probe.py`。测试数据库固定本机`lele_test_mison_booking`，工作目录`data/testing/mison-booking`，产物`output/playwright/mison-booking`。

- [ ] 搭建与生产相同的真实宿主→runtime→独立wheel worker链路；上游传输用可控假服务/依赖注入，不能只Mock前端请求就算接口验收。
- [ ] 模拟HTTP200业务失败、HTML401/500、超时、响应丢失、worker被杀、两个家长并发、发布切换和停用。
- [ ] 在本机测试配置中启动fake上游；允许localhost必须来自明确test模式，生产配置无法启用，不能借fixture豁免生产SSRF规则。
- [ ] 生成逐项检查结果和截图，任何跳过的真实集成标为未验证。
- [ ] 分别生成主系统增量变更与插件包；插件登记为待发布，不自动上架或替真实儿童安装。

## 7. 推荐执行命令

由实现任务新增以下npm命令，避免执行者自行猜测试入口：

```json
{
  "check:mison": "tsc -p plugins/mison-booking/tsconfig.json --noEmit",
  "test:mison:domain": "node tests/domain/mison_booking_tests.cjs",
  "test:mison:browser": "node tests/browser/mison_booking_acceptance.cjs"
}
```

阶段验证：

```sh
npm run check:mison
npm run plugin:build -- mison-booking
PYTHONPATH=backend .venv/bin/python -m unittest discover -s tests/backend -p 'test_mison_*.py' -v
PYTHONPATH=backend .venv/bin/python -m unittest discover -s tests/backend -p 'test_plugin_*.py' -v
npm run test:mison:domain
npm run check:layout
npm run check:typography
npm run build
npm run test:mison:browser
npm run test:plugins:browser
.venv/bin/python scripts/package_plugin.py --plugin mison-booking --allow-dirty
```

预期：类型检查/领域单测通过，真实隔离DB集成不跳过，浏览器无未捕获异常，插件包在独立venv内可health并运行。`--allow-dirty`仅用于开发制品；最终源码提交后省略该参数生成正式候选包。不需要为了本文另行发布。

## 8. 验收矩阵

| 编号 | 场景与通过标准 |
|---|---|
| UI01 | 单工作台无一级业务Tab；收藏开关只改变左侧列表；确认只替换右侧 |
| UI02 | 姓名、日期、时段、标签编辑/应用/取消/重置一致，空态不混淆 |
| UI03 | 点一档只选一档；间断不可提交；末班不跨日；时间长度与档位间隔正确 |
| UI04 | 查看其他老师档案不换预约对象；真正换老师/日期会确认；取消确认不丢草稿 |
| UI05 | 关闭预约抽屉、取消确认、课件选择恢复正确焦点、滚动和草稿 |
| UI06 | 1400/1280宽PC、1024宽、820竖屏、390窄屏无溢出；触控≥44px，键盘可操作 |
| UI07 | 长课件名、无头像、视频404、零额度、推荐不足、暂无合约有明确状态 |
| AUTH01 | 家人共用账号；普通成员不能绑定/断开；伪造role/child/合约参数无效 |
| AUTH02 | 连续进页/刷新不login；美森失效不登出主站；密码、令牌不在响应或日志 |
| AUTH03 | 儿童切换、账号换绑、负责人变更、停用、下架后旧上下文/票据失效 |
| API01 | 普通与推荐池去重分页正确；收藏不因只看第一页而漏失 |
| API02 | 北京午夜和客户端不同时区不偏日；全部窗口及本人已约状态准确 |
| API03 | 推荐课件与提交课时一一对应；不能伪造课件/预览凭证绕过额度 |
| WRITE01 | 同operationId同请求重放不再发送上游；同ID不同body返回冲突 |
| WRITE02 | 双家长、不同operationId预约相同资源不会重复扣课时 |
| WRITE03 | 上游成功但浏览器断线/worker被杀，恢复后核对；不自动再发预约 |
| WRITE04 | 无cid成功回读；匹配不唯一仍待核对；部分课程存在时不把整组当成功 |
| WRITE05 | 取消步骤1成功步骤2失败显示needs_repair；重试不重复步骤1；顺延不重复执行 |
| WRITE06 | 停用后不启动新外部调用；已发送结果可记录，不能伪称已撤回上游效果 |
| MEDIA01 | 头像/视频/PDF通过CSP；Range、下载名称、过期票据与最大体积正确 |
| MEDIA02 | 跨儿童票据、任意URL、私网/跳转/DNS重绑定、HTML伪PDF拒绝 |
| PLATFORM01 | 现有1.0插件继续运行；v2→v3与全新安装通过；旧SQL/hash不变 |
| DEPLOY01 | 新插件独立更新，主系统核心功能及其他插件正常；旧草稿遇版本变更停止提交 |

### 8.1 关键测试示例

实现下面同语义的故障注入测试；测试用的是fake upstream，不能用真实付费账号制造失败：

```python
def test_booking_timeout_does_not_resend(service, upstream):
    upstream.appointment_succeeds_then_drops_response()
    request = booking_request(operation_id='22222222-2222-4222-8222-222222222222')
    first = service.submit(request)
    assert first['data']['state'] == 'uncertain'
    again = service.submit(request)
    assert again['data']['operationId'] == first['data']['operationId']
    assert upstream.appointment_call_count == 1
    resolved = service.reconcile(first['data']['operationId'])
    assert resolved['data']['state'] == 'succeeded'
    assert upstream.appointment_call_count == 1

def test_cancel_repairs_only_second_stage(service, upstream):
    upstream.cancel_ok_marker_rejected_once()
    result = service.cancel(cancel_request(adjust_lessons=False))
    assert result['data']['state'] == 'needs_repair'
    service.repair(result['data']['operationId'])
    assert upstream.cancel_call_count == 1
    assert upstream.marker_call_count == 2
```

这里`service/upstream`是专项测试夹具接口，`booking_request/cancel_request`在`tests/fixtures/mison/factories.py`中提供固定脱敏实体与合法UUID；不得误当现有项目已有这些函数。

## 9. 交付与发布顺序

1. 交付实现代码、API核验记录、脱敏fixture、隔离验收结果及更新后的使用说明。
2. 主系统先升级平台1.1/v3与vault密钥配置，随后部署mison-booking插件。
3. 平台扩展涉及主系统发布；不能承诺第一次接入只上传插件包。后续同协议内业务变更可以独立更新插件。
4. v3迁移保留原表及全部业务数据。回退使用仍能识别v3的兼容宿主版本；不能直接启动只接受v2的旧宿主，也不能用旧数据库备份覆盖新增预约操作记录。
5. 核验未完成的上游能力列为阻塞项，不能用Toast或灰按钮算完成。被证实只能在官方客户端执行的学习动作，可按本文官方入口回退验收，并在交付中明确说明。
6. 本次方案整理没有登录美森、调用业务API、消费额度、预约/取消课程、迁移数据库或部署。

## 10. 给执行模型的启动指令

> 在 `/Users/xiaobin/Desktop/项目/乐乐成长` 的 `codex/meisen-course-booking-plugin` 分支实现“美森约课”。先完整阅读本实施方案、配套API合同和已确认草图，复核当前分支与工作区，再按T0–T6执行。坚持单工作台，收藏做筛选，我的预约做抽屉，课件确认在右栏。不要参考“美森自动约课”临时项目，不要把草图假数据和演示按钮当真实能力。先完成必要平台扩展与隔离测试，再接入已核验上游。遇到接口证据不足，执行合同中的核验任务并报告具体缺口，不猜写接口。最终交付可独立构建的插件、主系统必要补丁、验收证据和发布说明；不要自动发布生产。
