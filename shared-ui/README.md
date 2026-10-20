# Shared UI

Both React apps resolve `@shared/*` to `shared-ui/src/*`; `@/*` remains app-local. UI sources live here only. The registry-derived sources and hashes are recorded in `admin-ui/registry-provenance.json`; new additions compose the existing Radix dependency and DayPicker.

Each app imports `shared-ui/src/theme.css` after Tailwind and includes `@source` for `shared-ui/src`. The shared theme uses `#39734F`, 14px body text, at least 12px helpers, 40px controls, and 44px targets on coarse pointers. The root font remains 16px so Tailwind spacing retains its standard dimensions. Text inputs use 16px on narrow screens to avoid automatic zoom.

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
