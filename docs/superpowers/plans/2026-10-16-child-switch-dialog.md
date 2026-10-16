# 我的孩子弹窗 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 按用户指定交互，将孩子切换移动到页面右上角的头像昵称按钮，并用“我的孩子”弹窗集中完成卡片切换、邀请接受/拒绝和创建孩子。

**Architecture:** 家长端继续使用现有原生 HTML/JS 和 dialog；弹窗只调用现有 children、invitations 接口。保留无孩子或账号页面上的完整“我的孩子”页面作为首次登录和退出授权后的落点。弹窗打开不清空当前孩子上下文，实际进入另一孩子才执行已有安全上下文切换。

**Tech Stack:** 原生 dialog、现有家长端 CSS 变量、同源账号 API、现有隔离 Playwright 回归。

---

## 文件

- `web/parent.js`：右上角头像昵称入口、弹窗状态/读取/操作、原有安全上下文清理适配。
- `web/parent.html`：静态 dialog 壳及限定在新控件内的响应式样式。
- `scripts/browser_smoke.cjs` 与新增孩子弹窗浏览器辅助模块：新交互、邀请、创建、上下文和失败边界验证。
- `docs/local-test-report.md`：实际验证、截图和本地发布范围。

## Task 1：入口与弹窗

- [x] 记录改造前回滚点 `00e8614`，不改动无关文件。
- [x] 在 `.topbar` 右端放置头像、孩子昵称和下拉指示；头像使用昵称首字与固定配色生成，不引入额外数据字段。删除页面中部原账号条和孩子 select。
- [x] 当前孩子归档时明确显示只读状态；保留本地开发标识，控制在顶部小标记中。
- [x] 新建 `#childrenDialog` 原生弹窗，标题“我的孩子”，分为已有权限的孩子卡片、待接受邀请卡片、创建区域。新头像入口为 `#openChildrenDialog`，携带 `data-child-id` 和可访问名称。
- [x] 已有权限卡片标记当前孩子、负责人/共同管理、归档状态，按钮 `[data-open-child]` 可进入；当前孩子点击仅关闭弹窗。待邀请卡片提供 `[data-accept-invite]` 与 `[data-reject-invite]`。
- [x] 创建区表单可折叠展开，输入昵称后创建；成功后刷新并展示新卡片，用户可点击进入。

## Task 2：状态与安全

- [x] 弹窗读取 `GET /api/children` 与 `GET /api/invitations`，校验页面代次、当前孩子与本次打开序号；关闭后的旧响应不得填充弹窗或覆盖新会话的列表。
- [x] 提供加载、空列表、失败与重试状态。弹窗内写入不得重复提交，提交期间阻止 Escape 与关闭按钮；失败保留输入并提示。不会自动重试不确定写入。
- [x] 关闭时清空弹窗内容和临时姓名，防止隐藏 DOM 留下重复 ID。退出、权限撤销和上下文切换时一起清空弹窗。
- [x] 只有切换才执行既有 `selectChild` 与 URL 更新，保存/刷新进行中不得切换。关闭弹窗返回触发按钮焦点；切换后不把焦点拉回旧孩子。
- [x] 沿用服务端授权，邀请接受前不允许读取孩子业务数据。已失效邀请显示后端错误并可刷新。

## Task 3：验证与交付

- [x] 适配现有回归中 `#childSwitch` 和 `#allChildren` 的旧定位，使用新头像按钮及弹窗；不留下隐藏 select 来满足测试。
- [x] 在 `lele_test_browser` 验证右上角位置、卡片切换、当前卡片关闭、创建、邀请接受和拒绝、空/加载/失败重试、Escape 和焦点返回。
- [x] 延迟列表响应后关闭或退出，验证旧响应不重开弹窗、页面保留当前任务或在退出时彻底清理。
- [x] 保留原有任务/积分/礼品/邀请/多孩子隔离/独立标签页回归，检查 1543×954、815×954 和 390×844，无页面横向溢出。
- [x] 规格审查后进行代码质量复核，修复明确问题并重跑受影响检查。
- [x] 记录验收并提交 Git；本地页面刷新生效，不发布阿里云，不向现有开发孩子或正式 RDS 写测试记录。
