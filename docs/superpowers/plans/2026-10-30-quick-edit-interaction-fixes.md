# 快捷编辑交互修复 Implementation Plan

**Goal:** 修复触屏斜向拖动和待删除长列表撤销跳动；按用户明确选择，Esc 不影响正在进行的拖放。不增加移动端适配。

**Architecture:** 复用现有指针拖放与草稿控制器。常用任务卡片自己处理触屏手势：200ms 内开始的横划滚动任务栏，长按后允许任意方向拖动；日历及鼠标滚动保持原生行为。撤销仅删除对应列表行，恢复相邻焦点和可用范围内的原滚动位置。

**Tech Stack:** React、Pointer Events、既有 Popover、Playwright 隔离浏览器环境。

## Tasks

- [x] 增强 `tests/browser/calendar_quick_edit_acceptance.cjs`，新增 `calendar_quick_edit_interactions.cjs`：去掉先向下移动的绕行，覆盖触屏长按直接斜拖、横划中停留后继续滚动、拖动中 Esc 后仍可正常投放，以及长列表中间/末尾撤销的顺序和滚动位置。
- [x] `calendar-quick-drag.ts` 和 `calendar-quick-edit.css`：常用任务整卡 `touch-action:none`，以手势开始时间与移动方向区分横向滚动和任务拖动；横划采用同一任务栏的 scrollLeft，进入滚动后不变成拖动。滚动和拖动结束均抑制派生点击。移除拖动的 Esc 取消监听，保留失焦/pointercancel/无效投放处理。
- [x] `calendar-quick-edit.tsx`：仅调整辅助提示中 Esc 的说明，仍可取消键盘选择。
- [x] `calendar-trash.tsx`：撤销前记录滚动位置及相邻按钮，更新后以 preventScroll 聚焦相邻按钮，并恢复合法范围内的原滚动位置；空列表聚焦关闭按钮。
- [x] 运行域测试、类型、格式/布局/字体检查和家长端构建；顺序运行隔离的快捷编辑浏览器验收，不操作用户现有页面。记录结果，保留在当前功能分支。

## 验证结果

- 新回归先在旧构建上复现 Esc 取消拖动，与用户本次要求相反；修正后保持预览并能正常投放，松手不意外选中任务。
- 最新定向验收16场景、29次无障碍扫描全部通过，零违规、零页面运行错误。长列表覆盖987桌面点击和820触屏点击；斜拖覆盖820/1180触屏，既有其他尺寸回归保留，无新增移动端适配。
- 长列表测试等待浮层稳定后使用真实点击坐标，避免自动化工具点击前主动滚动；验证仅删除对应行、其余行顺序不变、中间滚动位置保持、末尾删除按新滚动范围正常收缩、相邻焦点及零请求。
- 域逻辑、类型、家长端构建、格式、目录、字体和差异检查通过。18787/18788健康，开发页面8个公开构建文件与本地字节一致。
- 报告：`output/playwright/quick-edit/result.json`。截图：同目录`quick-trash-stable-middle-987.png`、`quick-trash-stable-last-820.png`。实际iPad硬件未验证；未合并或部署生产。
