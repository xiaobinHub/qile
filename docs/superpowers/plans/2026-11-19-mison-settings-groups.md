# 自动约课设置分组重构 Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the independent notification drawer. Preserve existing dirty work; do not commit or release to production.

**Goal:** Implement the approved three-group settings design with an isolated notification drawer and one page-level save.

**Architecture:** Replace the execution card with peer rhythm, booking-rule and notification-summary cards. The notification drawer owns a deep copy of its incoming draft and returns validated changes only on Done. Keep the current config API and backend unchanged.

**Tech Stack:** Existing React/Radix UI, plugin-scoped CSS, TypeScript and isolated Playwright fixture host.

---

### Task 1: Grouped main settings

- [x] Extract rhythm/rule/notification-summary composition from the large settings file.
- [x] Rhythm: check interval and sleep controls. Booking rules: notice hours, daily limit, rebooking switch. Notifications: a Bark App channel with its own switch, configured key/scenario summary and configure action; no group-wide switch.
- [x] Use two equal columns for the first two cards and a half-width notification card aligned below rhythm; stack below 700px. Keep 16px gaps and existing theme/type tokens.
- [x] Enabling incomplete notification settings opens a draft with enabled=true; cancellation preserves the original switch. Configured toggles update only the page draft.
- [x] Close and discard the drawer on view/context/revision changes. Preserve owner/read-only and busy/uncertain behavior.

### Task 2: Notification drawer

- [x] Add a component using existing Overlay/Sheet with a scoped class for 440px desktop/full-width mobile layout.
- [x] Support local numbered key rows, add/remove/show/hide, scene checkbox, current validation limits, inline errors and focus on the first invalid field.
- [x] Done applies sanitized local values to the page draft without network requests; Cancel/X/Esc/backdrop discard. Prevent local form Enter/submit from bubbling to the page save handler.
- [x] Read-only members see only count and scenes. Fixed header/footer and a scrolling body retain keyboard and safe-area behavior.

### Task 3: Integration and verification

- [x] Update old layout-specific acceptance assertions to semantic group assertions while retaining booking behavior checks.
- [x] Verify 1440, 1034, 820 and 390px layouts, drawer width and scroll/footer placement against the approved concept.
- [x] Exercise all dismissal paths, isolated edits, validation/focus, key visibility, incomplete-toggle rollback, page-view closure, read-only access and one unified PUT on save.
- [x] Run type checks, plugin build, relevant browser acceptance and whitespace checks. Preserve the live local user's unsaved draft and confirm source dev mode stays healthy.
- [x] Complete independent spec and quality/visual review, resolving actionable findings before delivery.

## Completion evidence

- Additional user correction implemented: date and weekly cards use equal column widths and stretch to the same height; their edges align with rhythm/rules below.
- Type check: `npm run check:mison` passed.
- Build: `npm run plugin:build -- mison-booking` passed (local 1.1.3 build).
- `node tests/browser/mison_settings_groups_acceptance.cjs` and `TOUCH_BROWSER=webkit node tests/browser/mison_settings_groups_acceptance.cjs` each passed 9 focused scenarios at 1440×1000, 1034×889, 820×1180 and 390×844. No page/console errors or unexpected business requests. All writes used isolated fixtures.
- Verified local runtime remains ready, source revision 7. No real settings were saved and the user's current tab was not reloaded. Direct in-app tab inspection was unavailable in this chat; rendered verification used the repository Playwright host.
- Independent spec and code-quality reviews passed. Fixed a legacy width rule compressing Switch tracks and WebKit click-focus restoration; notification switch propagation no longer sends an outside click into the newly opened drawer.
- Chromium evidence: `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-FAQDXZ`.
- WebKit evidence: `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-Zkfn8A`.

## Follow-up: channel hierarchy

- Removed the slider endpoint hint row; slider limits and current range remain available.
- Notification card occupies one desktop column, aligned with rhythm; it expands to the container width in the stacked layout.
- Removed the notification master switch. Bark App owns its switch, configuration summary and scoped drawer; page draft/save and cancellation behavior remain unchanged.
- Updated browser assertions to verify channel scope, lack of a master switch/endpoint hints, and card width alignment.

Channel follow-up verification: type check and plugin build passed; Chromium and WebKit each passed all 9 focused scenarios at the four required widths. Evidence:
- chromium: `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-2mPqjZ`.
- webkit: `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-dErbOV`.

## Follow-up: booking rule sliders

- Replaced both number pickers with single-value sliders matching the check interval styling. Values and units stay visible at the right.
- Notice uses integer hours from 0 to 72 for normal configs; existing larger values extend the range and stay intact while editing. Daily lessons keeps the existing integer range 1–4.
- Removed the obsolete compact-input CSS. Updated existing picker assertions and added bounds, pointer/keyboard, save and legacy-value coverage.
- Type check and local plugin build passed. Chromium and WebKit each passed all 10 focused scenarios at the four required widths; no console/page errors or unexpected business requests.
- chromium evidence: `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-fy8lxI`.
- webkit evidence: `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-yxANbc`.

## Follow-up: compact teachers and weekday settings

- Remove the unconfigured notification placeholder while keeping configured summaries.
- Teacher chips fit their name lengths on desktop and mobile, wrap naturally and truncate overlong names within the container. Keep teacher removal and priority ordering.
- Weekday slots keep ordered display chips without delete buttons. A borderless settings icon opens a local selected-times copy, supporting additions and removals (including clearing the day), Save, Cancel and Escape. Existing off-grid times remain selectable so they can still be removed. Only page Save persists.
- Reset weekday panels when inactive/busy/read-only; disable background slot reordering while editing and return focus to the settings icon on close.
- Validation: type check, plugin build and whitespace checks passed. All 13 Chromium fixture scenarios passed at 1440, 1034, 820 and 390px (plus the supplied 1305px layout); no findings/page errors. Covered weekday add/remove/clear, Cancel/Escape, priority ordering, teacher intrinsic widths and page-level save. Evidence: `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-tNboMd`. Local source runtime revision23 remains ready; real browser drafts and settings were not changed by QA.

## Follow-up: stable weekday actions and live sorting

- Use two grid columns at every width: wrapping slots on the left and the settings action fixed on the right. Empty days share the same placement.
- Priority lists preview their keyed order during native dragging. Crossing a target midpoint reorders immediately; the dragged card is shown as a subdued placeholder. Drop applies the preview to the page draft once; Escape/outside cancellation restores its prior order. Existing keyboard ordering and read-only behavior remain.
- Added real mouse-drag browser acceptance before mouse release, a stationary-pointer stability check, drag cancellation, teacher-object ordering, page persistence and wrapped-day geometry at1305,1034,820,390px. MISON_SETTINGS_CASE can select one scenario for focused browser checks. All business requests remain intercepted fixtures.
- Validation: type check, plugin build and whitespace checks passed. Chromium passed all14 settings scenarios (`/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-DTaiGG`); WebKit passed the focused live-drag, cancellation and multi-row layout scenario (`/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-WlPTBl`). Both had no findings/page errors. Actual pointer dragging was asserted before release, and the saved fixture retains the preview order. No real settings writes or bookings.
