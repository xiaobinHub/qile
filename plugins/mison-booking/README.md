# 美森约课插件

当前源码候选版本为 **1.0.33**（以 `plugin.json` 为准），要求插件平台结构 v3、前端协议 1.1。源码构建、隔离回归与真实上游验收分别记录；本说明不代表当前安装版本或生产发布状态。当前能力及证据边界见 [上游核验记录](../../docs/plugins/mison-booking/upstream-verification.md)，部署顺序见 [插件部署说明](../../docs/plugins/deployment.md)。

本次直接重构现有插件的前端，入口保持 `frontend/entry.ts → frontend/app.tsx`。没有额外页面、独立预览应用或另一套导航。

在当前项目主应用的导航中打开“美森约课”，即可由原插件加载器加载本插件前端。按用户要求，主应用插件页面外壳不再显示重复标题和“应用设置”快捷按钮；顶部主导航保持原样。

## 页面结构

- 未登录时隐藏插件顶部栏，显示“请登录美森网课账号”和账号、密码、登录按钮；失败保留密码，密码框右侧可切换显示/隐藏，密码仅保留在当前表单内存。
- 首次打开时，主应用先显示铺满插件区域的标准骨架；插件挂载后同步换成美森自己的全屏骨架，直到第一页老师、登录页或连接错误就绪。筛选栏不提前出现。再次进入已挂载页面不重放这套首屏骨架。
- 登录成功后顶部左侧提供“教师与约课 / 课程日历”两个 tab，默认教师与约课；右侧保留账号设置。我的预约放在课程日历工具栏，位于刷新按钮左侧。教师页保持全宽老师卡片网格，点击预约后收为左侧栏、右侧展开约课区。
- 课程日历由插件内部的 `course-calendar.tsx`、`calendar-views.tsx`、`calendar-bookings.ts`、`calendar-date.ts` 和局部 CSS 独立实现，只借鉴主日历布局，不导入主应用日历、不依赖共享日历组件，也不要求重建宿主。仅保留连续月历，支持前后月份导航、今天、我的预约及刷新；课程卡片显示头像、教师、时间段、课件与状态，已上课浅黄、已预约浅绿，取消课程不显示。
- 切换 tab 保留筛选、档期、已选课时和日历位置；按账号绑定隔离数据，预约成功或关闭预约抽屉后刷新课程。两种课程状态独立读取，遍历同步及结果分页，失败单独重试。月份位置按可见日期锚定，避免数据加载和窗口缩放导致跳月。窄屏日历在内部横向滚动。
- “收起约课区”恢复全宽网格，保留筛选、浏览位置和当前时段/课件选择。
- 切换教师时保留日期/时段的布局及滚动位置；120ms 内完成的请求直接更新，较慢请求显示共享 Skeleton。加载期间禁用日期、时段及下一步；失败后保留占位与重试，避免把旧教师档期当作新数据。
- “仅看收藏”和“只看可约日期/时段”使用共享 Switch，触控热区至少 44px。后者默认开启，同时隐藏不可约日期以及已占用、本人已约、未排班时段；关闭可查看完整档期。当前日期不可约且没有已选课时时自动转到首个可约日期；全部不可约时显示空状态。选时段页底部仅展示已选课时数，不再罗列起止时间。
- 账号管理、我的预约、筛选和主体共用白色面板，用内部灰线分隔。
- 教师档案展示简介与原生视频播放器，不展示课时时长或复制入口；视频支持暂停、进度拖动和全屏。
- 教师日期筛选复用主应用日历的共享DatePicker；具体时段以多选面板展示，选择后发送逗号拼接的times查询。
- 课件确认在右侧工作区；我的预约和教师档案使用抽屉；更换课件使用分类选择弹窗。
- 全部基础控件复用共享shadcn/ui源码：Card、Button、Field/InputGroup、Popover、Checkbox、ToggleGroup、Tabs、Dialog/Sheet/AlertDialog、RadioGroup、ScrollArea、Avatar、Badge、Alert、Empty等；日期复用共享DatePicker，窄屏约课时通过收起按钮返回列表。视频使用原生video；PDF复用共享PDF.js预览，连续页面在原生滚动区域内浏览，支持适合宽度、旋转屏幕后重新排版、失败重试、下载及按需释放画布。

## iPad 触控验收

`npm run test:ipad` 使用隔离 HTTP 样例检查老师全屏/侧边列表、课件分类及内容、预约抽屉、PDF 多页/横竖屏及完整文件下载、主应用月历/周历、任务表单和时间滚轮。切出插件时检查原实例保留、页面与弹层隐藏且 inert、焦点/滚动锁释放，返回后检查原实例与位置恢复；切换儿童、停用和卸载的真正销毁由 `npm run test:plugins:ui` 验证。Chromium 使用原生触摸输入；WebKit 使用带触控能力的桌面上下文与原生滚轮检查布局和阅读器（Playwright 的移动 WebKit 不支持滚轮或滑动手势接口）。证据写入系统临时目录。

主应用固定在可见视口内，根页面不滚动。工作区由宿主分配高度，老师列表与约课内容各自使用单一原生滚动容器，切换全屏/侧栏保留各自位置；设置、商城等长内容由 main 区域滚动。打印样式不锁定文档。抽屉跟随可见视口；PDF 使用同源模块 worker，插件构建资源保持相对路径和 `.js` 白名单。

自动化不能替代物理 iPad 添加主屏幕后对系统回弹、软键盘及恢复前台的验收。触控表单回归会单独记录 Radix Switch/Popover 的既有开发环境 `flushSync` 警告，其余控制台错误和页面异常均使测试失败。

## 检查与构建

```sh
npm run check:mison
npm run plugin:build -- mison-booking
npm run test:mison:ui
npm run check:typography
npm run check:layout
```

前端验收从**现有主应用**进入插件：使用原导航、PluginPage、插件加载器和构建后的 `frontend/entry.js`，不再挂载独立App或编写替代主应用。测试仅拦截HTTP接口提供隔离数据，数据夹具位于 `tests/fixtures/mison/frontend-data.ts`，不随插件打包。

验收覆盖全宽/分栏切换、筛选与异步竞态、草稿保留、换老师确认、连续时段、课件选择、写入结果核对、预约分类、档案抽屉、键盘焦点、多屏宽布局，以及插件页面外壳不再显示重复标题和设置快捷按钮。该验收不代表真实美森接口闭环。

插件构建输出：`output/plugin-releases/mison-booking/<plugin.json 中的 version>/build/`，当前候选对应 `1.0.33/build/`。已安装版本不可原地覆盖；本机开发环境通过正常插件部署链更新，保留现有发布范围、儿童安装、配置、登录绑定和加密Token。开发包不代表已部署；正式发布包须从干净且已提交的工作区生成。

1.0.11 移除插件自行测高、负边距及滑动时更新高度的逻辑，改为填满主应用分配的空间；老师列表和约课内容使用原生滚动。该版本须与包含固定视口布局的家长端配套发布。

1.0.12 为教师切换增加同尺寸骨架屏，保持日期、时段、页脚及内容滚动位置稳定。`SCHEDULE_TRANSITION_ACCEPTANCE=1 PARENT_ACCEPTANCE_ORIGIN=http://chenxiaobin.cn:18787 node tests/browser/mison_frontend_acceptance.cjs` 专项验收逐帧采样 PC/iPad 横竖屏、连续切换时的乱序响应和失败重试；添加 `TOUCH_BROWSER=webkit` 检查 WebKit。Browser plugin not available，使用项目现有 Playwright；业务接口均为隔离样例。

1.0.13 将收藏和可约日期筛选改为切换开关，并移除底部已选时段的明细行及占位样式。

1.0.14 默认同时筛选可约日期和时段，统一搜索、日期、时段三个输入框宽度，并将侧栏滚动条外的右边距移入列表内容。`AVAILABILITY_ACCEPTANCE=1 IPAD_TOUCH_ACCEPTANCE=1 PARENT_ACCEPTANCE_ORIGIN=http://chenxiaobin.cn:18787 node tests/browser/mison_frontend_acceptance.cjs` 检查默认过滤、关闭恢复、保留选择、空状态、自动换日，以及横竖屏等宽/贴边布局；添加 `TOUCH_BROWSER=webkit` 检查 WebKit。

1.0.15 为预约列表增加卡片外描边及阴影的绘制空间，修复左右边缘被滚动容器裁剪的问题。

1.0.16 在教师日期筛选框中增加独立的清空按钮；仅选择日期后显示，清空时保留其他筛选条件并将焦点返回日期控件。清空按钮与日历触发按钮为兄弟节点，避免嵌套按钮或误触打开日历。

1.0.21 课程日历卡片支持点击及键盘打开课程 PDF，复用 `GET bookings/{key}/resources` 和原 ResourceViewer。多份 PDF 显示选择列表，无 PDF 显示说明；请求失败可再次点击重试。重复点击只发一个读取请求，切出日历或更换绑定后丢弃晚到响应；关闭阅读器恢复卡片焦点及原日历位置。

1.0.20 移除课程日历加载时的“正在读取课程…”占位行，避免该行出现/消失引起日历顶部跳动。加载状态仅使用不占布局空间的 aria-busy 表达，错误与空态继续按实际结果展示。

1.0.19 移除月/周视图切换及周视图实现，仅保留月历。顶部功能切换改为卡片式 Tab：页签上方及两侧描边，选中项与下方内容衔接，窄屏操作按钮移到页签上方。保留共享 Tabs 的键盘及无障碍语义，样式只作用于插件功能 Tab，不改变预约抽屉 Tab。

1.0.18 精简课程日历卡片：仅显示姓名，月历头像增至 40px、周历增至 32px，时间放在姓名下方且位于头像右侧；课件使用更小、更淡的文字，移除卡片内重复状态文字，保留背景色与顶部图例。

1.0.17 增加插件独立课程日历与功能 tab。专项入口为 `CALENDAR_ACCEPTANCE=1 node tests/browser/mison_frontend_acceptance.cjs`，添加 `TOUCH_BROWSER=webkit` 检查 WebKit；可设置 `PARENT_ACCEPTANCE_ORIGIN=http://chenxiaobin.cn:18787` 验证已运行的宿主构建。测试使用完整宿主加载器与隔离课程数据，覆盖共享分页、超过 50 节课程、多状态、跨午夜日期、错误重试、过期响应、顺序变化、空态、重叠课程、关闭预约弹窗不重复请求、保留选择/滚动位置及桌面/手机布局。

2026-11-05 课程日历验证：Chromium/WebKit 日历专项、axe、当前实际宿主构建上的日历专项与美森完整功能回归通过，页面异常与控制台错误为零。本机 development 已更新至 1.0.17、ready；安装、配置、凭据及登录绑定摘要一致。用户当前浏览器的真实课程已只读展示；未操作真实预约/取消，未修改或重建主应用，未部署生产。物理 iPad 仍需设备复核。

2026-11-05 验证：Chromium 完整功能回归及 Chromium/WebKit 切换专项通过，专项页面异常为零；WebKit 完整功能回归仍在课件弹窗关闭后的焦点恢复断言失败，已用原 1.0.11 构建复核为既有问题。本机 development 已更新至 1.0.12、状态 ready，安装/配置/凭据/登录绑定的前后指纹一致；未部署生产，未操作真实预约。物理 iPad 主屏幕模式仍需设备复核。

对正在运行的本地主应用构建验收：`PARENT_ACCEPTANCE_ORIGIN=http://chenxiaobin.cn:18787 IPAD_TOUCH_ACCEPTANCE=1 node tests/browser/mison_frontend_acceptance.cjs`，添加 `TOUCH_BROWSER=webkit` 检查 WebKit。主应用静态资源从实际服务读取，业务 API 全部拦截为隔离样例，不调用真实美森接口。

该入口通过本机测试服务器读取指定服务的主应用页面/静态资源，浏览器使用本机夹具来源，API 与插件业务请求不转发到指定服务。合成 PDF 由夹具服务器提供真实 HTTP 响应，避免 Chromium 原生下载绕过 Playwright 拦截后落到真实服务；验收必须检查下载状态及完整文件字节。

## 真实接入状态

已接通真实密码登录：POST `connection/login` 调用 `https://api.mison.cn/v2/member/login`，同时校验外层 `status=0`、内层 `data.status=200`。成功后通过私有Bridge在服务端加密保存Token；浏览器只收到脱敏账号和连接状态，不收到Token，不持久化密码。刷新页面调用bootstrap复用会话，不重复登录。账号密码错误显示上游原因；结果不明时只核对状态，须手动明确再次登录。仅儿童负责人可登录/换号/退出，家人共享已连接账号。

本机开发运行器自动创建0600权限的 `data/development/plugin-vault.txt`，密钥不能提交到仓库、泄露或随意重建；正式环境须独立配置 `LELE_PLUGIN_VAULT_KEY`。私有Unix Bridge与运行控制共用socket、使用不同身份凭证，worker只获得Bridge凭证，不获得控制凭证；所有请求仍校验签名上下文和当前安装/儿童权限。

已接通真实只读能力：教师列表与昵称/日期/时段/标签筛选、仅看收藏、教师资料、日期窗口和当日时段、我的预约三状态及日期筛选/分页、预约中计数。通过 `myOneToOneList` 和 `myCourseList` 动态关联有效合约与课程班级，没有写入样本账号ID。普通教师池跨页去重，智能池继续翻页；课程记录完整扫描后排序并分页。

查询使用已持久化Token，没有自动登录。收到13000/50000或401/403时，只标记当前匹配凭据失效并提示手动登录；不返回宿主HTTP401。Token和密码不进入前端响应或查询缓存。

2026-11-03使用用户已保存Token完成真实只读验收；登录调用0次、预约/取消/扣额度调用0次。另有合成上游单元测试、隔离数据库登录回归，以及原宿主加载器的浏览器回归。测试输出只记录数量、结构和端点名，不复制个人资料或Token。

自1.0.10已接通推荐课件、分类/分页选择、待补学内容查询、预览、单/多连续课时预约、结果核对、两阶段取消和学生PDF资料。当前源码也已接通教师收藏修改；批量顺延仍不可用。上课/回放/预习/课后作业提供明确的美森App操作说明，尚未实现PC原生学习协议。自动识别限唯一有效一对一合约，多合约明确报错，不能静默选错课程。原生预约协议和取消状态机已在隔离样例中验证，真实预约/取消闭环仍待单独授权验收。


登录回归检查：

```sh
PYTHONPATH=backend .venv/bin/python -m unittest tests.backend.test_dev_plugin_runtime
LELE_TEST_CONFIG=data/testing/backend/config.json PYTHONPATH=backend:packages/plugin-sdk-python/src:plugins/mison-booking/backend .venv/bin/python -m unittest tests.backend.test_mison_login
```

数据库测试只接受本机 `lele_test*` 配置，使用独立库与随机作用域，不读取真实美森凭据、不调用真实美森服务。


## 查询实现边界

- `upstream.py`：固定读取与写入端点白名单，35秒总预算，单次请求最多10秒，3MiB响应上限，无自动重试/登录。
- `read_api.py`：合约关联、筛选DTO、教师去重、北京时间日期与占用映射、课程排序分页。每次最多扫3个源页；历史同步未完返回building，前端继续游标查询。扫描上限5000条，超限明确报错，不伪装完整结果。
- `read_store.py`：worker内有界TTL缓存与opaque游标（5分钟）；不持久化业务数据。绑定childId、bindingRevision、credentialId和查询条件，账号变化或worker重启后旧游标失效，需刷新列表。Token仍独立加密保存在数据库。
- `images.py`：头像按需经插件JSON接口返回不超过128KiB的JPEG/PNG/WebP/GIF数据URI；只允许固定 `mp.mison.cn` / `file.mison.cn`，不带Bearer、不跟重定向、保持TLS证书与主机名校验。拒绝私网DNS；仅兼容本机Clash/TUN已观察到的基准测试虚拟地址段198.18/15和2001:2::/48。前端最多并行请求2张头像，避免占满worker。不改主应用CSP或页面。

```sh
PYTHONPATH=backend:packages/plugin-sdk-python/src:plugins/mison-booking/backend .venv/bin/python -m unittest tests.backend.test_mison_reads
```


## 教师介绍视频

1.0.8开始由已登录的插件读取教师资料中的 `intro_video`，经私有Bridge `resource.issue` 生成20分钟有效的同源视频地址。播放器直接使用浏览器原生controls与playsInline，不自动播放。没有视频时显示暂无视频；加载失败提示重新打开档案。

宿主只补充 `/api/children/{childId}/plugins/{pluginId}/media/{ticket}` GET/HEAD流接口，不改主应用页面或CSP。请求验证主应用会话、儿童权限、插件启用与release epoch、账号bindingRevision及凭据revision。固定HTTPS来源、不跟随重定向、不转发Bearer；支持单段Range，200MiB上限、64KiB流块，不整段加载进worker。票据失效后需重新打开档案，视频播放不消耗课件预览次数。

2026-11-03真实CDN已核验206分段响应与MP4头；原宿主浏览器使用合成测试视频验证实际播放和拖动。后台使用隔离数据库测试会话/票据权限与流接口，不写真实课程数据。


## 共享组件与独立打包

1.0.9将现有业务页面迁移为共享shadcn/ui组合，组件源码统一放在 `frontend/shared/src/components/ui/`，业务代码仍位于本插件。共享弹层与DatePicker仅新增可选portalContainer参数，宿主默认行为保持不变。

插件独立打包组件、Radix与React依赖，不依赖宿主在运行时导出组件。`frontend/utilities.css`编译共享语义token映射与控件utilities；构建器将CSS限定到`.mison-ui`，动画也加插件前缀，不引入全局preflight。主题变量继承当前宿主，插件CSS只补充业务布局。共享源码更新后须重新发布插件才会生效。

挂载时创建单独的弹层容器，供Sheet/Dialog/AlertDialog/Popover及嵌套日期选择使用；卸载时统一移除，并由Radix还原焦点、滚动和指针状态。浏览器验收额外检查宿主导航样式不变、抽屉内日期选择、焦点恢复与弹层清理。原API、权限、Token存储与视频协议未因本次UI迁移而更改。


## 预约和课件接口（1.0.10）

- `drafts.py`：私有草稿不设固定有效期，保留绑定校验与修订CAS；兼容旧草稿的30分钟过期标记。进入确认页及提交前重新检查真实档期，默认按开始时间逐项分配推荐课件。草稿修改不提交课程。
- `courseware.py`：真实推荐/分类/分页列表、预览额度、待补学记录；无法证实的“学过”字段保持未知，不能由choosed随意推导。分类liveid来自当前有效合约，不写死样本ID。
- `operations.py`：同账号操作先写持久日志，再发送一次上游请求。多课时按App的CSV课件编码一次提交；确认失败后允许用户显式新请求，超时只核对。跨儿童绑定同美森账号也共用数据库写入锁。
- 选择/更换预约前课件只更新草稿，不消耗预览额度。预览直接打开课件列表中的学员 PDF（`student_file_url`），经同源票据加载，不调用 `onevonePreviewCourseware`，也不消耗每日预览次数。额度为 0 仍可选择课件、预览和预约。
- 源码开发版不再显示每日预览额度，草稿不再查询该额度。2026-11-04已核验一份真实学员PDF可在不带Token时返回206及PDF文件头；此证据仅对应该文件。文件缺失或来源不受支持时明确报错，不回退到扣次接口。教师文件不用于预览。
- 刷新通过bootstrap恢复未决操作。部分成功逐课时显示，既不自动补约，也不自动取消；预览结果无法可靠确认时可先在App核实，再显式结束核对，至少等待60秒。此操作只结束跟踪，不修改真实课程。
- 取消顺序为`cancelLesson`→核验status=1→`onevoneSaveCancelLesson(adjust_lessons=0)`。临近上课或出现额外扣额规则时转到App确认，不默认接受费用或顺延。第二步失败只核对，不重放第一步。
- 已预约学生资料由`courseClassResource`取得文件ID，再按App协议`/v2/download/pdf`取得真实下载地址；只代理学生PDF。媒体票据沿用会话/儿童/发布版本/绑定权限，PDF最多50MiB、支持Range；仅该PDF响应允许同源iframe展示，主应用页面安全策略不变。

真实验证继续复用数据库Token，登录0次、真实预约/取消/预览扣额0次；只读验证了推荐两份课件、真实分类列表、额度、已预约资料结构和下载地址。任何真实约课测试必须严格晚于当前48小时；本次未执行真实约课。

```sh
LELE_TEST_CONFIG=data/testing/backend/config.json PYTHONPATH=backend:packages/plugin-sdk-python/src:plugins/mison-booking/backend .venv/bin/python -m unittest tests.backend.test_mison_booking tests.backend.test_mison_reads tests.backend.test_mison_login tests.backend.test_plugin_video
```

当前源码已接通 `teacherCollect` 收藏/取消收藏，采用明确目标状态和持久化操作回执。推荐教师按 App 同传 `user1v1_id`。写入结果未知时仅通过 `getTeacherCollect` 核对，不自动重发。卡片和教师档案同步收藏状态；构建验收不等于真实收藏写入验收或生产部署。

## 1.0.30 发布审查修复

课程同步在宿主写入事务内核对当前账号、登录绑定、凭据编号/修订及有效期，拒绝退出、换号或重新登录前采集的迟到结果。自动运行只使用已保存的积分和起始日；采集期间设置改变时放弃该次旧结果。

保存设置携带 `operationId`、`expectedRevision` 和 `bindingRevision`。宿主使用现有私有记录表原子保存课程/积分、设置和持久回执；原请求重试返回原回执，不重复采集或执行积分变更。新的过期修订请求返回 `REVISION_CONFLICT`，同编号不同参数返回 `OPERATION_CONFLICT`。前端保留未确认请求的完整参数供重试，成功后重新读取当前设置。

定时同步每天 06:00（北京时间）跑一次，错过时只补最近一次，不回补更早的次数；保存设置仍会立即同步。定时任务使用签名任务身份及当前数据库任务租约/执行次数，只有同步读取、执行和对应的会话失效处理可用；后台任务不能登录、退出账号或保存同步设置。前端协议最低要求调整为 1.1，入口及运行接口检查宿主版本，旧页面明确提示刷新。

新增隔离集成验收：`tests/backend/test_mison_sync_integration.py`、`tests/backend/test_plugin_frontend_protocol.py`。浏览器完整验收包含同步设置的未确认重试、冲突后新请求及最新设置回读。无需新增数据库结构；本轮没有部署或执行真实预约、取消操作。
