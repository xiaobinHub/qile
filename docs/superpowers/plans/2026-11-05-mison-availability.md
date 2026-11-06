# 美森可约筛选与列表布局 Implementation Plan

> 按用户给出的三处界面要求在当前分支内实施，使用现有 Playwright 与隔离接口验证。

**Goal:** 默认仅展示可约日期及可约时段，移除侧栏滚动条外侧留白，统一三个筛选输入框的宽度。

**Architecture:** 在 SchedulePanel 保留完整档期数据，渲染时按同一个开关过滤 `day.available` 和 `slot.state === "available"`。开关默认开启；加载成功且当前日期不可约、没有已选课时时，切换到首个可约日期；无可约内容保持空状态。保留现有骨架屏、请求竞态保护和原生列表滚动。

**Tech Stack:** React、共享 shadcn Switch、CSS 容器查询、Playwright Chromium/WebKit。

- [x] 在 `tests/browser/mison_availability_acceptance.cjs` 检查默认开启、日期与时段同时过滤、关闭恢复已约/占用/未排班时段、全部不可约及首日不可约后的自动换日；在 `mison_frontend_acceptance.cjs` 添加隔离验收入口及对应接口状态。先运行确认旧版不满足默认与文案要求。
- [x] 在 `plugins/mison-booking/frontend/schedule-panel.tsx` 将状态初始值改为 `true`、文案改为“只看可约日期/时段”，使用完整 `slots` 派生展示列表，保留关闭筛选后的所有状态；避免自动换日覆盖用户已有选择。
- [x] 在 `plugins/mison-booking/frontend/style.css` 将三种输入框统一为 200px，保证搜索提示完整显示；容器宽度 540–740px 时等分一行，更窄时各占整行。侧栏右 padding 移入原生滚动容器内，保持卡片内边距并让滚动容器贴右。
- [x] 更新旧回归的开关文案与默认状态；通过 `npm run check:mison`、Chromium 完整功能回归及双引擎专项验证，检查 1305×984、1180×820、820×1180、390×844 下的等宽与侧栏边界。
- [x] 版本更新至 1.0.14，使用 `.venv/bin/python scripts/package_plugin.py --plugin mison-booking --allow-dirty` 打包；通过原部署链更新本机 development，并核对安装/配置/凭据/登录绑定指纹不变。保留旧版本与现有构建文件。

Browser plugin not available；使用项目已有 Playwright。专项入口为 `AVAILABILITY_ACCEPTANCE=1 IPAD_TOUCH_ACCEPTANCE=1 PARENT_ACCEPTANCE_ORIGIN=http://chenxiaobin.cn:18787 node tests/browser/mison_frontend_acceptance.cjs`，添加 `TOUCH_BROWSER=webkit` 检查 WebKit。不访问真实美森业务接口，不部署生产。

## 验证结果

- 旧版专项因不存在新开关文案而失败，确认原行为不满足要求。家长端实际运行构建 + 1.0.14 插件的 Chromium/WebKit 可约筛选专项均通过，页面异常为零；覆盖默认过滤、关闭恢复、保留选择、空状态、自动换日及多尺寸等宽/贴边。
- Chromium 完整插件功能回归通过；Chromium 触摸输入、WebKit 原生滚动及两引擎软键盘回归均通过，实际构建控制台错误与异常为零。最终等宽输入为 200px，按钮只过渡颜色/边框，避免缩放时宽度动画不同步。
- 插件 1.0.14 已通过原 PluginDeployment 链更新本机 development，状态 ready；安装、配置、加密凭据及登录绑定的前后指纹一致。旧版本保留，未部署生产。
- 类型、打包、Prettier 和 git diff --check 通过。专项证据位于系统临时目录 mison-frontend-BrU2l4（Chromium）、mison-frontend-QNuiYB（WebKit）；滚动回归为 mison-frontend-c9Rci4、mison-frontend-FtYghQ。物理 iPad 仍需设备复核。
