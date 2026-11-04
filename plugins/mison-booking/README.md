# 美森约课插件

本次直接重构现有插件的前端，入口保持 `frontend/entry.ts → frontend/app.tsx`。没有额外页面、独立预览应用或另一套导航。

在当前项目主应用的导航中打开“美森约课”，即可由原插件加载器加载本插件前端。按用户要求，主应用插件页面外壳不再显示重复标题和“应用设置”快捷按钮；顶部主导航保持原样。

## 页面结构

- 未登录时隐藏插件顶部栏，显示“请登录美森网课账号”和账号、密码、登录按钮；失败保留密码，密码框右侧可切换显示/隐藏，密码仅保留在当前表单内存。
- 登录成功后显示默认全宽老师卡片网格；点击预约后，列表收为左侧栏、右侧展开约课区。
- “收起约课区”恢复全宽网格，保留筛选、浏览位置和当前时段/课件选择。
- 切换教师时保留日期/时段的布局及滚动位置；120ms 内完成的请求直接更新，较慢请求显示共享 Skeleton。加载期间禁用日期、时段及下一步；失败后保留占位与重试，避免把旧教师档期当作新数据。
- “仅看收藏”和“只看可约日期”使用共享 Switch，保留原筛选行为及标签操作，触控热区至少 44px。选时段页底部仅展示已选课时数，不再罗列起止时间。
- 账号管理、我的预约、筛选和主体共用白色面板，用内部灰线分隔。
- 教师档案展示简介与原生视频播放器，不展示课时时长或复制入口；视频支持暂停、进度拖动和全屏。
- 教师日期筛选复用主应用日历的共享DatePicker；具体时段以多选面板展示，选择后发送逗号拼接的times查询。
- 课件确认在右侧工作区；我的预约和教师档案使用抽屉；更换课件使用分类选择弹窗。
- 全部基础控件复用共享shadcn/ui源码：Card、Button、Field/InputGroup、Popover、Checkbox、ToggleGroup、Tabs、Dialog/Sheet/AlertDialog、RadioGroup、ScrollArea、Avatar、Badge、Alert、Empty等；日期复用共享DatePicker，窄屏约课时通过收起按钮返回列表。视频使用原生video；PDF复用共享PDF.js预览，连续页面在原生滚动区域内浏览，支持适合宽度、缩放、失败重试及按需释放画布。

## iPad 触控验收

`npm run test:ipad` 使用隔离 HTTP 样例检查老师全屏/侧边列表、课件分类及内容、预约抽屉、PDF 多页与缩放、月历/周历、任务表单和时间滚轮。Chromium 使用原生触摸输入；WebKit 使用带触控能力的桌面上下文与原生滚轮检查布局和阅读器（Playwright 的移动 WebKit 不支持滚轮或滑动手势接口）。证据写入系统临时目录。

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

插件构建输出：`output/plugin-releases/mison-booking/1.0.13/build/`。已安装版本不可原地覆盖；本机开发环境通过正常插件部署链更新，保留现有发布范围、儿童安装、配置、登录绑定和加密Token。旧版保留，未操作生产。

1.0.11 移除插件自行测高、负边距及滑动时更新高度的逻辑，改为填满主应用分配的空间；老师列表和约课内容使用原生滚动。该版本须与包含固定视口布局的家长端配套发布。

1.0.12 为教师切换增加同尺寸骨架屏，保持日期、时段、页脚及内容滚动位置稳定。`SCHEDULE_TRANSITION_ACCEPTANCE=1 PARENT_ACCEPTANCE_ORIGIN=http://chenxiaobin.cn:18787 node tests/browser/mison_frontend_acceptance.cjs` 专项验收逐帧采样 PC/iPad 横竖屏、连续切换时的乱序响应和失败重试；添加 `TOUCH_BROWSER=webkit` 检查 WebKit。Browser plugin not available，使用项目现有 Playwright；业务接口均为隔离样例。

1.0.13 将收藏和可约日期筛选改为切换开关，并移除底部已选时段的明细行及占位样式。

2026-11-05 验证：Chromium 完整功能回归及 Chromium/WebKit 切换专项通过，专项页面异常为零；WebKit 完整功能回归仍在课件弹窗关闭后的焦点恢复断言失败，已用原 1.0.11 构建复核为既有问题。本机 development 已更新至 1.0.12、状态 ready，安装/配置/凭据/登录绑定的前后指纹一致；未部署生产，未操作真实预约。物理 iPad 主屏幕模式仍需设备复核。

对正在运行的本地主应用构建验收：`PARENT_ACCEPTANCE_ORIGIN=http://chenxiaobin.cn:18787 IPAD_TOUCH_ACCEPTANCE=1 node tests/browser/mison_frontend_acceptance.cjs`，添加 `TOUCH_BROWSER=webkit` 检查 WebKit。主应用静态资源从实际服务读取，业务 API 全部拦截为隔离样例，不调用真实美森接口。

## 真实接入状态

已接通真实密码登录：POST `connection/login` 调用 `https://api.mison.cn/v2/member/login`，同时校验外层 `status=0`、内层 `data.status=200`。成功后通过私有Bridge在服务端加密保存Token；浏览器只收到脱敏账号和连接状态，不收到Token，不持久化密码。刷新页面调用bootstrap复用会话，不重复登录。账号密码错误显示上游原因；结果不明时只核对状态，须手动明确再次登录。仅儿童负责人可登录/换号/退出，家人共享已连接账号。

本机开发运行器自动创建0600权限的 `data/development/plugin-vault.txt`，密钥不能提交到仓库、泄露或随意重建；正式环境须独立配置 `LELE_PLUGIN_VAULT_KEY`。私有Unix Bridge与运行控制共用socket、使用不同身份凭证，worker只获得Bridge凭证，不获得控制凭证；所有请求仍校验签名上下文和当前安装/儿童权限。

已接通真实只读能力：教师列表与昵称/日期/时段/标签筛选、仅看收藏、教师资料、日期窗口和当日时段、我的预约三状态及日期筛选/分页、预约中计数。通过 `myOneToOneList` 和 `myCourseList` 动态关联有效合约与课程班级，没有写入样本账号ID。普通教师池跨页去重，智能池继续翻页；课程记录完整扫描后排序并分页。

查询使用已持久化Token，没有自动登录。收到13000/50000或401/403时，只标记当前匹配凭据失效并提示手动登录；不返回宿主HTTP401。Token和密码不进入前端响应或查询缓存。

2026-11-03使用用户已保存Token完成真实只读验收；登录调用0次、预约/取消/扣额度调用0次。另有合成上游单元测试、隔离数据库登录回归，以及原宿主加载器的浏览器回归。测试输出只记录数量、结构和端点名，不复制个人资料或Token。

1.0.10已接通推荐课件、分类/分页选择、待补学内容查询、预览、单/多连续课时预约、结果核对、两阶段取消和学生PDF资料。收藏修改与批量顺延仍不可用。上课/回放/课后作业提供明确的美森App操作说明，尚未实现PC原生学习协议。自动识别限唯一有效一对一合约，多合约明确报错，不能静默选错课程。


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

当前源码开发版已接通 `teacherCollect` 收藏/取消收藏，采用明确目标状态和持久化操作回执。推荐教师按 App 同传 `user1v1_id`。写入结果未知时仅通过 `getTeacherCollect` 核对，不自动重发。卡片和教师档案同步收藏状态；此变更尚未打包发布。
