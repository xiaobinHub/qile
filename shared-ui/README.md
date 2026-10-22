# Shared UI

Both React apps resolve `@shared/*` to `shared-ui/src/*`; `@/*` remains app-local. UI sources live here only. The current Vega registry sources and hashes are recorded in `shared-ui/registry-provenance.json`; the pre-Vega origin remains in `admin-ui/registry-provenance.json`. New additions compose the existing Radix dependency and DayPicker.

Each app imports `shared-ui/src/theme.css` after Tailwind and includes `@source` for `shared-ui/src`. The shared theme follows preset `b2BplS640` (Vega, Mist, yellow, locally bundled Inter Variable), with 14px body text, 13px helpers, 12px compact metadata, and 44px targets on coarse pointers. Typography uses rem against the browser's default root size (normally 16px). Text inputs use 16px on coarse-pointer devices. See [字体与响应式规范](../docs/ui/字体与响应式规范.md) for the shared type roles and the current PC/iPad density rules.

Import individual modules:

- `@shared/components/ui/{button,input,textarea,checkbox,switch,select,tabs,toggle-group,popover,calendar,dialog,alert-dialog,sheet,dropdown-menu,table,card,badge,label,separator,skeleton}`
- `@shared/components/ui/toast`: wrap an app in `ToastProvider`; `useToast()` returns `{ toast }`; call `toast({ title, description?, variant?: "default" | "destructive" })` for transient feedback. Put persistent validation in `FormFeedback` or `FormField`.
- `@shared/components/password-input`: `PasswordInput` accepts Input props and a forwarded input ref. `passwordPolicy` and `passwordHelp` preserve the current password contract.
- `@shared/components/form-field`: `FormField({ id?, label, help?, error?, required?, children, className? })` associates the single child control with its label, help and error. `required` marks the label; pass `required` to the child for native validation.
- `@shared/components/form-feedback`: `FormFeedback({ message, success?, id?, className? })`.
- `@shared/components/date-picker`: `DatePicker({ value?: string, onChange, id?, name?, disabled?, disabledDates?, placeholder?, className?, ...aria })`.
- `@shared/components/date-range-picker`: `DateRangePicker` uses the same base props with `{ from?: string, to?: string }` value and callback. When `name` is supplied, hidden inputs are named `name.from` and `name.to`. Two clicks choose a range, including a single-day range.
- Date values are local `YYYY-MM-DD` strings. `@shared/lib/local-date` exports strict `parseLocalDate` and `formatLocalDate`; no date-only value passes through UTC. Calendar uses Chinese locale and Monday as the first day of the week. When an `id` is supplied, picker triggers use their external Label as the accessible name; explicit ARIA labels remain supported.
- `@shared/components/time-picker`: `TimePicker({ value?: string, onChange, ...inputProps })` uses a read-only local `HH:mm` field. Clicking the field opens two simple cyclic wheels. Native mouse/touch scrolling snaps the centered number into a fixed yellow frame; 23→00 and 59→00 wrap in either direction without changing the other wheel. All 24 hours and 60 minutes remain available. Each wheel exposes one accessible `spinbutton`; duplicated visual rows are hidden from assistive technology. Arrow/Page/Home/End keys change the value, Enter/Space or “完成” closes, and Esc/outside click preserves the selection and returns focus. Direct text entry and the software keyboard stay disabled; reduced-motion preferences disable smooth click selection.
- `@shared/components/empty-state`: `EmptyState({ title?, description?, action?, icon?, className? })`.
- `@shared/components/async-confirm`: `AsyncConfirm({ open, onOpenChange, title, description, id?, cancelId?, confirmId?, confirmLabel?, cancelLabel?, destructive?, onConfirm: () => Promise<unknown>, children? })`. Uses AlertDialog, blocks duplicate submissions and dismissal while pending, closes on success, and keeps errors visible for retry. Optional `id`, `cancelId`, and `confirmId` identify the dialog content and its cancel/confirm buttons. The caller owns the actual mutation and should throw on failure.

Use AlertDialog/AsyncConfirm for business confirmations. Use Dialog for editing forms, Sheet for navigation or side content, and Popover for temporary selectors.

## 当前应用规则

- 两端的 `components.json` 指向同一 `@shared` 源码；`@` 只表示各自应用目录。新增通用组件放在此目录，不再向后台或家长目录复制一份。
- Command 基于 cmdk，用于任务名称框内的常用任务搜索。ARIA 关联使用组件实际生成的 ID，避免硬编码与库内部 ID 冲突。
- 弹层层级：Dialog/Sheet 遮罩 50、内容 51；确认遮罩 60、内容 61；Popover/Select/Dropdown 80；Toast 100。业务界面避免同时堆叠两个普通编辑 Dialog。
- 按钮使用 variant 表达普通、次要、危险操作，业务样式只控制布局，不单独绘制另一套按钮。日期不经过 UTC 序列化，时间不自动四舍五入。
- UI 由 React 管理；允许业务组件通过 ref 测量滚动和恢复焦点，不允许用 innerHTML 或另一个 React 根节点改写当前界面。
- 纸张排版使用专门的 A4 样式，不把屏幕主题色强加到打印内容。

## Preset b2BplS640

The exact official preset response is retained in `preset.json`, including both light and dark CSS variables. The public application remains in its existing light mode. Both apps import the shared theme. The approved 2026-10-22 parent reference adds a single app-level semantic token mapping in `parent-ui/src/styles.css`; individual pages must not invent separate palettes.

The preset selects `base-vega`. To retain the existing Radix accessibility, focus and event contracts, the project uses the official matching `radix-vega` component sources, rather than replacing the runtime with Base UI. All three `components.json` files record this adaptation. Local adjustments retain Chinese accessible labels, layer ordering, 40px controls and 44px touch targets; the calendar retains Chinese, Monday-first and local-date handling. `shadcn-variants.css` is the vendored shadcn 4.22.1 variant CSS needed by the current official sources.

Brand backgrounds use `primary` with `primary-foreground`; text links and active labels on white use `brand-ink` to avoid yellow-on-white. `success` and `warning` describe business status, not brand color. `destructive-ink` deepens danger text on tinted surfaces without changing the preset destructive token. The unchanged preset muted text is retained as `muted-foreground`; rendered secondary copy uses `text-secondary` (90% muted text mixed with foreground), including Tailwind `text-muted-foreground`, to pass contrast on muted surfaces. The full preset radius scale remains available; Vega components intentionally use md controls and xl cards/dialogs.

Inter is bundled from `@fontsource-variable/inter` with `Inter-OFL.txt`; Chinese uses the local system font fallback. Fonts and icons never require a CDN. Printing retains its separate paper CSS.

## PC 与 iPad 页面组合规范（2026-10-21）

- 页面标题使用 `PageHeading`（24/32px）；普通弹窗标题 20/28px，正文/字段 14/22px，说明 13/20px，元信息最低 12px。孩子卡牌标题保留独立的 28px 展示层级。
- `StatusBadge` 提供 neutral/success/warning/danger/brand 语义；黄色用于主操作和少量选中状态，退出登录使用次要按钮。内容白底，Mist 用于表头、工具栏和辅助区；业务任务类型颜色保留。
- 编辑弹窗用 `.ui-modal-frame` + `.ui-modal-header` + `.ui-modal-body` + `.ui-modal-footer`。标题、操作区不滚动，仅中间内容滚动。默认宽 560px，small 440px，complex 720px，四周至少 16px。普通遮罩黑色 35%；卡牌切换传 `backdrop="immersive"` 使用 72% 独立遮罩。
- 家长端 `Modal` 通过 `footer` 与 `size` 组合；底部按钮位于表单外时必须设置 `form`，并显式维护 `disabled`，不可依赖字段集的禁用继承。所有确认使用 AlertDialog，失败保留输入和错误，取消默认聚焦。
- 懒加载弹窗必须保留原触发按钮：`Modal.returnFocusTo` 可显式指定返回目标；临时加载框传 `false`，避免内容交接时错误恢复背景焦点。取消加载时由宿主恢复原触发点。
- 两端入口用 `ViewportBounds` 跟随可用视口；最大高度包含安全区，缩放时不重算。它为 iPad 软键盘布局提供基础，不代替真机验收。
- 任务弹窗启用 `keyboardScroll`：软键盘挤占可用视口时，标题、完整表单和操作区作为同一滚动区域；聚焦字段仅调整弹窗滚动，不移动背后的日历。键盘收起后恢复固定标题与操作区；普通滚动不会自动跳回输入框。`scripts/task_keyboard_acceptance.cjs` 模拟独立的 visualViewport 高度、偏移与缩放，真机键盘仍需验收。
- 设置保持左右分栏，详情内所有输入/选择/密码控件填满所在列；操作行统一在末尾右对齐。列表删除放入带中文名称的行菜单，排序按钮保持可见。菜单先释放焦点再打开确认。
- 月历保留七列连续滚动；触控设备整日单元只有一个交互入口，任务条仅预览；周历短事件维持真实分钟高度，通过 44px 以上日期入口查看当天详情。
- PC 验收尺寸：1280×720、1280×900、1440×900。iPad 模拟尺寸：820×1180、1180×820、1024×1366、1366×1024。手机布局保留既有兼容，不在本轮另做专用设计。

## 已确认设计稿还原（2026-10-22）

以下为紧凑化前的还原基线；尺寸以末尾的字体与紧凑布局规范为准。

- 以 `docs/ui/reference-20261022/` 的设置 V2、日历 V2、商城原稿为视觉基准。1487×1058 下设置侧栏宽 308px，主区横向边距 34px、栏间距 26px，白色顶部高 112px；iPad 按现有断点缩放，保持两栏和 44px 操作入口。
- 家长工作区 `#EEF1F3`、内容及设置侧栏/星期表头 `#FFFFFF`、正文 `#1F2933`、普通导航 `#374151`、主操作 `#FACC15`、选中面 `#FFF0B3`。日历任务类型颜色保留业务配置。
- `Button variant="navigation" size="navigation"` 使用 `aria-current="page"` 表示顶部选中项，呈现浅黄底和黄色下划线；`variant="sidebar-navigation" size="menu"` 表示设置导航。控件颜色、选中和焦点由共享组件负责。
- `Badge variant="role"` 用于孩子管理员角色；普通成员使用 secondary。商城与设置不恢复先前删掉的总标题或额外入口。
- `TabsTrigger` 未选中项使用完整的语义文字颜色，不再用文字透明度。outline 按钮使用白色内容表面，避免灰色工作区透进控件。
- 设计稿中的任务、图片和积分是示例，不覆盖用户内容。只读视觉响应样例位于 `scripts/reference_ui_capture.cjs`；全部非 GET 请求被拒绝，样例不落库。实际业务回归仍使用独立测试数据库和真实 API。

## 字体与紧凑布局（2026-10-22）

- `src/typography.css` 集中定义 page / detail / section / card / body / caption / meta / number 字号和行高。CSS 与 Tailwind 共用同一数值源，`cn` 支持这些字号的正确合并。
- 页头 72px；设置侧栏 PC 208px、iPad 184px；普通文字不按 vw 放缩。商城 ≥1024px 四列、768–1023px 三列、<768px 两列。
- 所有输入在触控设备使用 16px，主要控件至少 44px；屏幕密度与打印纸张、头像装饰字号分别管理。
- `npm run check:typography` 防止新增任意像素和视口字号；`npm run test:browser` 包含计算字号、响应式布局和文本放大验收。完整规则与例外见上方规范链接。
