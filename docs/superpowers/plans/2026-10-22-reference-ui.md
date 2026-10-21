# 设计稿还原实施计划

**Goal:** 按已确认的设置 V2、日历 V2、商城设计稿落实家长端，保留真实业务与 PC/iPad 适配。

**Architecture:** 在现有 React 页面与共享 shadcn/ui 控件上调整语义主题、导航变体及页面布局。不重建应用，不替换业务图片、数据与接口。前端产物继续由本地开发服务提供。

**Tech Stack:** React、TypeScript、Tailwind CSS、shadcn/ui Vega、Lucide、Vite。

## 视觉基准与回滚

- 设置：`output/ui-design-20261022/settings-design-v2.png`。
- 日历：`output/ui-design-20261022/calendar-design-v2.png`。
- 商城：`output/ui-design-20261022/store-design.png`。
- 原图均为 1487×1058。按相同视口截图比较；iPad 保留左右设置分栏与 44px 操作入口。
- 开发基线 `de53bef`；回滚标签 `codex/ui-design-before-20261022`。不提交用户文件 `docs/美森API接入要求.md` 或历史输出。

## 实施步骤

- [x] 为共享 Button 增加明确的顶部导航／侧栏导航语义变体，深色字、浅黄选中及下划线由组件维护；父应用主题使用批准色值。
- [x] 修改 `parent-ui/src/styles.css`、`App.tsx`：白色全宽顶部与灰色工作区，匹配品牌、导航、头像及内容边距。
- [x] 修改 `settings/index.tsx`、`children.tsx`、`styles.css`：白色侧栏、分组分隔、移除稿中没有的侧栏账号块；管理员徽标、全宽表单及折叠区按稿排列。
- [x] 修改 `features/calendar.tsx`、相关样式：白色星期表头、深色标题、周末轻底色、圆形状态图标；保留连续月历和日期定位，禁止为了静态稿改业务行为。
- [x] 修改商城页面和样式：白色完整工作面板、两项下划线 Tab、三列礼品布局及内边距、紧邻积分与对齐操作、带边界兑换记录折叠区。真实图片和积分保持真实。
- [x] 两端类型检查和构建，领域测试及现有隔离浏览器回归；增加稿尺寸与关键视觉状态验证，覆盖 iPad、窄屏、只读、弹窗及键盘。
- [x] 以同尺寸并排图复核整体与局部，修正显著差异并记录 `design-qa.md`。仅本地开发，不发布生产。

## 验证路径

登录现有隔离测试账号 → 日历与月份导航 → 设置孩子昵称与其他设置切换 → 商城礼品兑换／积分流水 → 管理礼品与编辑弹窗 → 取消操作。写入和删除回归只在 `lele_test_unified_ui`、18887/18888 中进行。
