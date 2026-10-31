# Admin Settings Shell Implementation Plan

**Goal:** 管理后台采用家长端设置页的顶部栏、独立侧栏和内容区，页面底色为灰色，复用同一套视觉变量和已有共享组件。

**Architecture:** 将家长端现有配色与控件变量提取为 shared/workspace-theme.css，两端导入；AdminLayout 使用完整横向顶部栏和下方两列卡片。账号/插件列表继续仅列表内部滚动；详情及个人资料在内容区内滚动。小屏保留可访问的导航抽屉。业务请求和权限流程保持原实现。

**Tech Stack:** React、现有共享 shadcn Button/Card/Sheet、CSS、Playwright。

- [x] 提取共享视觉变量，家长端计算值保持不变。
- [x] 改造 AdminLayout：72px 顶栏、208/184px 白色侧栏、白色内容区、灰色外层及页脚；导航用现有 sidebar-navigation 变体、选中箭头，用户入口放在顶栏。
- [x] 统一现有页面的卡片边框/圆角、标题及控件规范，保留表头和底栏修复。
- [x] 构建、格式和静态检查；隔离数据验证账号/插件/个人资料/详情/弹窗/导航和短长列表滚动，检查 PC、平板、窄屏和低高度视口并查看截图。

低高度补充：480px 以下的横屏窗口由内容区提供滚动兜底，窗口和顶部栏保持稳定；列表自身限制高度并继续内部滚动，避免汇总/工具栏把列表压到 0。已在触屏模拟 667×375、390×360 的短长列表复核。

验收：npm run build、check:typography、check:layout、Prettier 和 git diff --check 通过。隔离 lele_test_demo_plugins 的 Playwright 验收 41 项通过、页面异常 0；覆盖 1280×960、820×1180、390×844、1280×600、667×375 touch、390×360 touch。详情页隐藏控件约束在内容区内，页面切换在绘制前复位内容区滚动。证据保存在 /tmp/lele-admin-settings-qa/results.json 及同目录截图。未验证真实物理设备。
