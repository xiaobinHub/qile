# Shared UI

Both React apps resolve `@shared/*` to `shared-ui/src/*`; `@/*` remains app-local. UI sources live here only. The current Vega registry sources and hashes are recorded in `shared-ui/registry-provenance.json`; the pre-Vega origin remains in `admin-ui/registry-provenance.json`. New additions compose the existing Radix dependency and DayPicker.

Each app imports `shared-ui/src/theme.css` after Tailwind and includes `@source` for `shared-ui/src`. The shared theme follows preset `b2BplS640` (Vega, Mist, yellow, locally bundled Inter Variable), with 14px body text, at least 12px helpers, 40px controls, and 44px targets on coarse pointers. The root font remains 16px so Tailwind spacing retains its standard dimensions. Text inputs use 16px on narrow screens to avoid automatic zoom.

Import individual modules:

- `@shared/components/ui/{button,input,textarea,checkbox,switch,select,tabs,toggle-group,popover,calendar,dialog,alert-dialog,sheet,dropdown-menu,table,card,badge,label,separator,skeleton}`
- `@shared/components/ui/toast`: wrap an app in `ToastProvider`; `useToast()` returns `{ toast }`; call `toast({ title, description?, variant?: "default" | "destructive" })` for transient feedback. Put persistent validation in `FormFeedback` or `FormField`.
- `@shared/components/password-input`: `PasswordInput` accepts Input props and a forwarded input ref. `passwordPolicy` and `passwordHelp` preserve the current password contract.
- `@shared/components/form-field`: `FormField({ id?, label, help?, error?, required?, children, className? })` associates the single child control with its label, help and error. `required` marks the label; pass `required` to the child for native validation.
- `@shared/components/form-feedback`: `FormFeedback({ message, success?, id?, className? })`.
- `@shared/components/date-picker`: `DatePicker({ value?: string, onChange, id?, name?, disabled?, disabledDates?, placeholder?, className?, ...aria })`.
- `@shared/components/date-range-picker`: `DateRangePicker` uses the same base props with `{ from?: string, to?: string }` value and callback. When `name` is supplied, hidden inputs are named `name.from` and `name.to`. Two clicks choose a range, including a single-day range.
- Date values are local `YYYY-MM-DD` strings. `@shared/lib/local-date` exports strict `parseLocalDate` and `formatLocalDate`; no date-only value passes through UTC. Calendar uses Chinese locale and Monday as the first day of the week. When an `id` is supplied, picker triggers use their external Label as the accessible name; explicit ARIA labels remain supported.
- `@shared/components/time-picker`: `TimePicker({ value?: string, onChange, ...inputProps })` uses an editable local 24-hour `HH:mm` input and a Popover with keyboard-accessible hour and five-minute choices. Custom minutes remain exact until the user explicitly chooses another minute.
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

The exact official preset response is retained in `preset.json`, including both light and dark CSS variables. The public application remains in its existing light mode. Both apps import one theme; do not override the preset variables in page CSS.

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
- 设置保持左右分栏，详情内所有输入/选择/密码控件填满所在列；操作行统一在末尾右对齐。列表删除放入带中文名称的行菜单，排序按钮保持可见。菜单先释放焦点再打开确认。
- 月历保留七列连续滚动；触控设备整日单元只有一个交互入口，任务条仅预览；周历短事件维持真实分钟高度，通过 44px 以上日期入口查看当天详情。
- PC 验收尺寸：1280×720、1280×900、1440×900。iPad 模拟尺寸：820×1180、1180×820、1024×1366、1366×1024。手机布局保留既有兼容，不在本轮另做专用设计。
