# 美森课程日历 Implementation Plan

> 用户已确认设计并要求实施，并明确要求日历在插件内部独立实现；在当前会话顺序执行，保留工作区已有改动。

**Goal:** 在美森约课增加可切换的课程日历，以头像、时间和课件展示已上课和已预约课程。

**Architecture:** 在插件内部独立实现连续月历滚动、周网格、日期工具及样式，只借鉴主日历的布局和交互，不依赖主应用日历。美森使用独立课程读取组件，按范围完整读取两种状态及全部游标；tab 容器保留已挂载组件的状态。

**Tech Stack:** React、TypeScript、共享 shadcn Tabs/ToggleGroup/Avatar、原生滚动、Playwright Chromium/WebKit。

- [x] 创建插件内部 `frontend/calendar-views.tsx`、`calendar-views.css`、`calendar-date.ts`；撤回本轮主应用和共享层抽取，保持主应用文件不变。
- [x] 创建 `plugins/mison-booking/frontend/course-calendar.tsx`：月/周导航、状态图例、课程卡片、分页读取、错误重试、响应代际校验。复用 `request<BookingQuery>(context, 'bookings?' + new URLSearchParams({status, from, to, pageSize: '50', ...cursor}))`，直到 `state === 'ready' && !nextCursor`。
- [x] `app.tsx` 使用 Tabs/TabsList/TabsTrigger/TabsContent，教师面板与日历面板保持挂载并按 hidden 隐藏。将约课成功及抽屉关闭接到日历 refresh 计数，绑定变化使用 key 隔离缓存。
- [x] 添加布局 CSS：顶部 tab 左对齐，操作靠右；日历填满剩余空间，窄屏网格局部横向滚动，周课程不重叠，卡片使用浅黄/浅绿语义变量。
- [x] 在现有真实家长应用 + 隔离接口验收中加入课程日历专项，验证分页、混合状态、失败重试、导航、tab 状态保留与桌面/手机尺寸；运行 `npm run check:mison`、`npm run check:parent`、`npm run plugin:build -- mison-booking` 及已有约课回归。
- [x] 更新 README 和版本，通过现有本机 development 部署链发布插件，保留安装与账号绑定，核对 ready。仅更新本机 development 插件，不重建或部署主应用。

Browser plugin not available；沿用项目已有 Playwright 验收环境。测试接口全部隔离，不访问真实美森业务接口。截图保存在系统临时目录。

## 验证结果

- 主应用 `frontend/parent` 和共享层 `frontend/shared` 均无本轮改动；新增日历及工具、样式全部位于美森插件目录。
- `check:mison`、`check:parent`、插件构建、Prettier、字体规范、仓库布局和 `git diff --check` 通过。
- Chromium/WebKit 日历专项通过，均无页面异常或控制台错误；覆盖 66 节已预约、3 节已上课、同步/结果分页、失败独立重试、过期响应、分页不推进、跨午夜日期、重叠课程、空态、Tab 选择保留、滚动位置及缩放保持日期、1180/820/390 布局和 axe 检查。
- 当前运行的 `http://chenxiaobin.cn:18787` 宿主实际构建上的 Chromium 日历专项与美森完整功能回归通过。证据：系统临时目录 `mison-frontend-Q4pqcx`（实际构建日历）、`mison-frontend-jdmjV6`（完整回归）、`mison-frontend-AeC3pF`（WebKit）。
- 1.0.17 通过原 PluginDeployment 链更新本机 development，ready/succeeded。安装、配置、加密凭据及登录绑定前后摘要一致，旧版保留；未重建主应用，未部署生产。
- 当前用户浏览器已刷新并打开课程日历，真实课程头像、时间段、课件与两种状态只读展示成功。没有进行真实预约、取消、换号或预览扣额操作。
- 物理 iPad 添加主屏幕后的触控仍需设备复核。

## 1.0.18 卡片调整

按用户标注调整姓名、头像和时间排列、课件字号/颜色及移除卡片状态文字。沿用原有 Chromium/WebKit 课程日历专项验证，页面异常和控制台错误为零，类型、构建、格式与字体规范通过。证据目录为 `mison-frontend-xaCI1k`（Chromium）和 `mison-frontend-uaYfHO`（WebKit）。

1.0.18 已通过原部署链更新本机 development，ready/succeeded；当前用户浏览器已刷新并只读核对实际卡片为纯姓名、40px 头像及右侧姓名/时间排布、淡色小号课件，无卡片状态文字。未修改主应用。

## 1.0.19 月历与卡片式 Tab

按用户标注仅保留月视图，删除周网格、周课程布局、视图切换和相关样式。功能 Tab 改为上方及两侧描边的卡片式页签，选中页签与内容衔接；仅插件内生效。月份翻页与今天动作主动更新标题，避免依赖滚动事件导致标题滞后。

`check:mison`、插件构建、格式、字体与差异检查通过；Chromium/WebKit 月历专项通过，无页面异常与控制台错误。证据分别为 `mison-frontend-NfxlH7` 和 `mison-frontend-R2vHjM`；现有约课完整回归为 `mison-frontend-EJ0TyI`。

## 1.0.20 移除加载提示行

按用户标注移除“正在读取课程…”提示，使用不占布局空间的 aria-busy 保留加载语义。沿用现有 Chromium/WebKit 日历专项，通过分页、刷新、错误重试、月历位置和多尺寸回归，页面异常/控制台错误为零；证据为 `mison-frontend-VIj4Xk`、`mison-frontend-vE7IyT`。类型、构建、格式和差异检查通过。

已部署本机 development 1.0.20，ready/succeeded；安装、配置、凭据与登录绑定摘要一致。当前浏览器刷新前后星期栏顶部均为 217px，确认提示行已不存在；本次响应很快，瞬时采样时请求已完成。未修改主应用。

## 1.0.21 课程卡片 PDF

将课程卡片改为原生按钮，接入现有只读课程资料 GET 接口及 App ResourceViewer，单 PDF 直接打开、多 PDF 可选择、无资料有说明、失败可重新点击。读请求有防重锁与生命周期检查，切出日历或绑定改变后丢弃旧响应。保留焦点与原滚动位置。未变更后台、主应用或共享阅读器。

Chromium/WebKit 日历及 PDF 专项通过，覆盖已上课/已预约、键盘激活、实际 PDF 页面渲染、重复点击仅一个 GET、错误重试、多文件、无 PDF、晚到响应及关闭后焦点/滚动恢复；证据为 `mison-frontend-gRlpNt`、`mison-frontend-GgMJkq`。原约课完整回归通过（`mison-frontend-VvIGT2`）；类型、构建、格式、字体和差异检查通过。

1.0.21 已经原部署链更新本机 development，ready/succeeded；安装、配置、加密凭据及登录绑定前后摘要一致。当前浏览器实际点击用户标注的已上课课程，成功打开对应 14 页学生 PDF，首页已渲染；只读读取课程资料，没有调用预约、取消或付费预览接口。
