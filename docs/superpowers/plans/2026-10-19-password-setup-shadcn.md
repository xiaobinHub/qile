# 密码设置页 shadcn/ui 改造

用户要求：使用 shadcn/ui 重绘现有强制密码设置页，UI 样式不变。回滚基线：`f783d0e`。本次只开发本地环境。

架构：新增独立 React 页面入口，直接导入管理后台已有、记录了官方来源的 shadcn Card、Input、Label、Button。通过同步 mount/unmount 桥接现有家长端；仅在强制密码设置页挂载。继续使用现有精确样式，不引入全局 Tailwind reset，避免改变日历及其他页面。密码请求复用现有认证、CSRF、会话清理及退出确认。

- [x] 新建 `parent-ui/src/password-setup.tsx`：卡片标题、两个独立显隐输入、原帮助与错误提示、保存和退出按钮；提交期间禁用表单，重复密码不一致不提交，卸载后忽略旧响应。
- [x] 新建 `parent-ui/vite.config.mts`、`parent-ui/tsconfig.json`，构建为固定名称的同源 IIFE；`package.json` 增加类型检查与构建命令。组件直接复用现有 shadcn 源码，样式继续使用项目现有类。
- [x] `web/parent.js` 挂载新页面并在清理上下文时卸载；提取共用改密回调。`web/parent-settings.js` 删除强制页旧实现，保留普通改密。`web/parent.html` 引入构建入口；`accounts_app.py` 精确白名单仅开放该构建 JS，不开放源码或后台资源。
- [x] 构建检查通过后，在专用测试库运行后端和浏览器回归。断言实际 shadcn data-slot，验证显隐、重复/原密码错误、六位规则、提交禁用、退出确认、会话失效和窄屏布局。与改造前桌面和手机截图比较。
- [x] 核验通过后只重启本地开发服务，比较现有业务数据校验值；记录结果并提交，保留无关文件，生产不发布。


## 验证结果

- `npm run build:parent`：类型检查和构建通过；IIFE 直接复用管理后台已有 shadcn 组件源码，React 运行时随同源构建交付，不使用 CDN，不加载全局 Tailwind CSS。
- 后端 30 项测试通过，包含构建资源仅供家长端访问；浏览器 31 场景通过，页面错误 0。验证实际 card/input/label/button 的 data-slot，密码规则、重复输入不一致、原密码相同的服务端错误、两个小眼睛、提交期间禁用和重复提交保护、取消/Esc/确认退出以及原有日历、积分、邀请、备份流程。
- 同一浏览器下的 1098×890 桌面与 390×844 手机截图，与改造前截图逐像素一致。图片位于已忽略的 `output/playwright/parent-password-setup-desktop.png` 和 `parent-password-setup-mobile.png`。
- 开发 18787/18788 已重启，新页面、组件构建、脚本及样式与工作区逐字节一致。重启前后 6 个孩子完整业务数据校验值一致，修订号 0、0、0、0、0、262。独立生产 8787 进程仍为 69434，阿里云未发布。
