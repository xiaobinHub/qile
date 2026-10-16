# 管理后台 shadcn/ui Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 用真实 shadcn/ui 组件重构后台，落实已确认的侧栏、账号列表、弹窗与独立账号设置布局，保留现有账号和权限行为。

**Architecture:** `admin-ui/` 存放 React/TypeScript 源码；Vite 将单一页面和静态资源编译到 `web/admin-dist/`，现有 FastAPI 管理入口只提供这些构建文件。通过同源请求访问原有 API；家长端继续使用原入口。

**Tech Stack:** React、TypeScript、Vite、Tailwind CSS、shadcn/ui（Radix）、Lucide、现有 FastAPI/Psycopg、现有 Playwright 浏览器回归。

---

## 文件与边界

- `admin-ui/`：入口、构建配置、shadcn 组件、API、页面与公共布局。按布局、账号列表、表单分别拆分。
- `web/admin-dist/`：可直接运行的构建结果，纳入版本管理，后续部署不需要在服务器安装 Node。
- `accounts_app.py`：管理页面及其明确静态目录路由；保持家长端路由和安全响应头。
- `package.json`、`package-lock.json`：增加后台构建及类型检查命令和固定依赖。
- `scripts/browser_smoke.cjs`：保留原业务回归，适配新弹窗入口，并覆盖筛选、启停、重置、个人资料与窄屏。
- `test_child_backend.py`：确认管理端构建资源可访问，家长端不能访问后台资源，任意文件路径不开放。
- `docs/development.md`、`docs/local-test-report.md`：构建说明、验证结果和回滚点。
- 不修改 `child_service.py` 的业务接口、家长页面或正式配置。不操作阿里云。

## Task 1：构建与同源接入

- [x] 确认当前 Git 回滚点 `79d7757`，保留无关的 `docs/美森API接入要求.md`。
- [x] 依官方文档配置 Vite、React、Tailwind 和 `@/` 别名；通过 shadcn 官方注册表添加 button、input、label、card、badge、table、dialog、alert-dialog、dropdown-menu、select、separator、skeleton。
- [x] 增加 `build:admin`（类型检查后构建）及 `check:admin` 命令。
- [x] 为后台提供 `web/admin-dist/index.html`，静态资源限定到后台目录，解析实际路径并确认是根目录的直接子文件，其他路径返回 404。家长端静态白名单保持只允许 `parent.js`。
- [x] 使用 `npm run build:admin` 确认构建通过；用隔离应用 TestClient 检查入口、JS/CSS 的 Content-Type，以及家长端与私有路径的 404。

## Task 2：后台完整 UI 与状态

- [x] 拆分 API 客户端、管理布局、登录页、账号列表、账号操作弹窗、我的账号页面。
- [x] API 统一附加 CSRF，使用同源 Cookie 与 no-store；使用会话代次拒绝退出前的旧响应。请求失败显示后端错误，不输出密码。
- [x] 左侧品牌和两个导航，底部当前账号和退出；顶部位置提示；浅色、中性边框和绿色主按钮；窄屏提供可收起导航。
- [x] 账号列表显示真实统计、搜索、按一致规则计算的状态筛选、刷新和开通入口；提供加载、失败重试、空状态。行操作使用菜单及确认弹窗。
- [x] 开通、重置和改密沿用 6–128 位英文字母和数字组合校验；字段标签、密码显隐和校验提示完整。取消操作不发请求，保存防止重复提交，错误保留输入。
- [x] 资料与密码使用独立卡片；首次改密门禁、当前密码验证、成功改密后退出及会话失效流程保留。
- [x] 编译后通过桌面 1059×954 与手机 390×844 的真实浏览器观察与截图，修复截断、重叠、横向溢出或焦点问题。

## Task 3：回归、复核与交付

- [x] 适配现有浏览器创建与重置入口。测试账号仅写入 `lele_test_browser`，不修改 `lele_dev`。
- [x] 运行 `npm run build:admin`、`LELE_TEST_CONFIG=data/development/test-config.json .venv/bin/python -m unittest test_child_backend -v`、`npm run test:browser`。
- [x] 浏览器断言包括：登录、初次改密、开通 6 位密码账号、搜索与筛选、刷新、启停取消及确认、密码重置和重新登录、昵称修改、退出、空状态、弹窗键盘关闭与窄屏。原任务/礼品/邀请/孩子隔离回归继续通过。
- [x] 规格审查通过后做代码质量复核，修复具体问题并重跑受影响检查。
- [x] 更新开发与验收说明，重启本地两端服务，确认健康及已有会话下后台只读加载，提交 Git。

## 完成标准

后台使用实际本地 shadcn/ui 组件源码；授权范围、字段规则和原操作完整；构建可复现、资源只由同源提供、测试通过；本地服务可用并提供效果截图，阿里云保持待发布状态。
