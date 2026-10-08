# 积分商城横向 Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将“可兑换礼品”和“已兑换礼品”由上下两个区块改为横向 Tab，并只显示当前 Tab 的礼品列表。

**Architecture:** 在现有单文件应用状态中增加商城 Tab 状态。商城外壳只在进入商城时渲染一次，Tab 切换仅替换 `#storeTabPanel` 内容并重新绑定当前列表按钮，不触发数据保存；兑换或撤销后的正常应用重绘继续保留所选 Tab。

**Tech Stack:** 原生 HTML、CSS、JavaScript；现有隐藏自检运行器。

---

### Task 1: 商城横向 Tab 与局部列表渲染

**Files:**
- Modify: `index.html`
- Test: `index.html?selftest=1`

- [x] **Step 1: 增加列表选择自检**

为商城列表选择函数增加自检：`available` 返回可兑换数组，`redeemed` 返回已兑换数组，非法值回退到 `available`。

- [x] **Step 2: 实现横向 Tab 和局部渲染**

在 `state` 中加入 `storeTab: 'available'`。新增 `storeTabItems`、`renderStoreTabPanel` 和 `bindStoreTabContent`，让 Tab 按钮只刷新面板；添加当前态下划线、数量和窄屏横向滚动样式。

- [x] **Step 3: 完成静态与隐藏自检**

Run: 提取 `index.html` 内联 JavaScript 后执行 `node --check`，并打开 `http://127.0.0.1:8787/?selftest=1`。

Expected: JavaScript 语法检查通过，隐藏自检全部通过。

- [x] **Step 4: 浏览器交互检查**

Run: 在积分商城依次点击“可兑换礼品”和“已兑换礼品”。

Expected: 选中态正确切换，下方仅显示当前礼品列表，商城页面不发生整页刷新。

- [x] **Step 5: 检查补丁格式**

Run: 使用项目可用的 Git 运行 `git diff --check`。

Expected: 无空白错误，且不修改个人数据与无关文件。
