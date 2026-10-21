# Shared UI

Both React apps resolve `@shared/*` to `shared-ui/src/*`; `@/*` remains app-local. UI sources live here only. The current Maia registry sources and hashes are recorded in `shared-ui/registry-provenance.json`; the pre-Maia origin remains in `admin-ui/registry-provenance.json`. New additions compose the existing Radix dependency and DayPicker.

Each app imports `shared-ui/src/theme.css` after Tailwind and includes `@source` for `shared-ui/src`. The shared theme follows preset `b2C8W74qG` (Maia, Mist, yellow, locally bundled Inter Variable), with 14px body text, at least 12px helpers, 40px controls, and 44px targets on coarse pointers. The root font remains 16px so Tailwind spacing retains its standard dimensions. Text inputs use 16px on narrow screens to avoid automatic zoom.

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

## Preset b2C8W74qG

The exact official preset response is retained in `preset.json`, including both light and dark CSS variables. The public application remains in its existing light mode. Both apps import one theme; do not override the preset variables in page CSS.

The preset selects `base-maia`. To retain the existing Radix accessibility, focus and event contracts, the project uses the official matching `radix-maia` component sources, rather than replacing the runtime with Base UI. All three `components.json` files record this adaptation. Local adjustments retain Chinese accessible labels, layer ordering, 40px controls and 44px touch targets; the calendar retains Chinese, Monday-first and local-date handling. `shadcn-variants.css` is the vendored shadcn 4.22.1 variant CSS needed by the current official sources.

Brand backgrounds use `primary` with `primary-foreground`; text links and active labels on white use `brand-ink` to avoid yellow-on-white. `success` and `warning` describe business status, not brand color. `destructive-ink` deepens danger text on tinted surfaces without changing the preset destructive token. The unchanged preset muted text is retained as `muted-foreground`; rendered secondary copy uses `text-secondary` (90% muted text mixed with foreground), including Tailwind `text-muted-foreground`, to pass contrast on muted surfaces. The full preset radius scale remains available; Maia components intentionally use pill controls, 2xl cards and 4xl dialogs.

Inter is bundled from `@fontsource-variable/inter` with `Inter-OFL.txt`; Chinese uses the local system font fallback. Fonts and icons never require a CDN. Printing retains its separate paper CSS.
