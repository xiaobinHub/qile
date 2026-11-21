# Bark 设备名称 Implementation Plan

> **For agentic workers:** Use subagent-driven-development for backend metadata. Preserve dirty work; no commit or release.

**Goal:** Remove the rhythm/rule help icons and let owners rename each Bark Key to identify its device.

**Architecture:** Add optional `notifications.barkKeyNames` aligned with `barkKeys`, preserving the existing key-array API and legacy clients. Name and secret remain paired through UI draft edits, validation, removals and page save. Backend stores nonsecret names next to encrypted-recipient fingerprints and preserves existing names by fingerprint for legacy saves. Readonly UI stays count/scenes only.

**Tech Stack:** Existing React form/Overlay, scoped CSS, Python encrypted notification store, isolated API/browser fixtures.

### Task 1: UI

- [x] Remove only execution rhythm/rule help icons and unused imports.
- [x] Add editable device name input per Key, default blank, trim names while preserving empty values, max40 characters.
- [x] Preserve separate drawer draft/apply/cancel behavior and name/key pairing through add/remove/hide/validation.
- [x] Include names in page normalization/save, preserving pairing when disabled keys are filtered or deduplicated.

### Task 2: Backend

- [x] Accept optional names without breaking old request/response shapes.
- [x] Encrypt keys as before; persist names aligned to fingerprints and expose them to owners only.
- [x] Preserve aliases across legacy saves/reordering by fingerprint; keep delivery recipients and payloads unchanged.
- [x] Test validation, save/reload/rename, key replacement/removal/reorder, legacy and readonly behavior.

### Task 3: Verify

- [x] Update browser fixtures and verify named-device draft cancellation, removal, unified save/reload and readonly privacy.
- [x] Check desktop/mobile key row geometry, typecheck, plugin build, relevant backend and Chromium/WebKit browser tests.
- [x] Review implementation, update docs and confirm local preview healthy; preserve the user's unsaved live draft.

## Verification evidence

- Type check, plugin build and whitespace checks passed.
- Backend: 18 focused name tests plus existing notification/auto-booking regressions, 68 tests passed with protected test configuration and mocked upstream.
- Each browser passed 12 scenarios at 1440, 1034, 820 and 390px; no page/console errors or unexpected business requests.
- chromium: `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-J9nmSY`.
- webkit: `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-0FxBNt`.

- Spec review passed after removing input-time truncation. Regression confirms whitespace around40 Unicode characters is preserved/trimmed,41characters is rejected with name focus, and no extra page save occurs.
- Final chromium evidence: `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-VkxvDK`.
- Final webkit evidence: `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-dnkGEp`.

- Code-quality review passed for frontend/backend name pairing, legacy retention, owner isolation and readonly behavior. Local source runtime revision22 is ready. No real settings saved or live browser reload performed; all acceptance writes used isolated fixtures.

## Follow-up: blank names and input backgrounds

- Notification input backgrounds are transparent, matching the white drawer surface.
- New/unnamed device names remain empty and use the 设备名称 placeholder; no Key N is inserted by UI normalization, drawer apply, page save, backend validation or fingerprint fallback. Existing saved names remain intact.
- Updated existing name tests for empty values and save/reopen behavior.
- Verification: type check, plugin build, 18 focused backend tests and 12 Chromium browser scenarios passed. Four viewport widths have no page errors; the final drawer screenshot confirms white input surfaces. Evidence: `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-rqklbp`.

## Follow-up: required device fields and channel actions

- Device name and Key are required for every device row, including while the channel is off. The drawer disables Save until all rows are valid; blur errors identify missing/invalid fields. Enabled channels also require a device and the booked scene.
- Both fields disable autocomplete; new rows stay blank, Keys use plain text, and visibility controls are removed. Existing values are retained when editing.
- Drawer actions read 保存 and 添加设备. 保存 still applies to the page draft only. The 配置参数 text button sits immediately before the Bark App switch.
- Updated existing acceptance scenarios to cover disabled Save, whitespace/format/duplicate errors, plain text, autocomplete attributes, valid trimming, paired devices and text-button positioning.
- Verification: type check, plugin build, whitespace checks and all 12 Chromium fixture scenarios passed at 1440, 1034, 820 and 390px with no page errors or findings. Evidence: `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-Qnaxpj`. No real settings, bookings or Bark notifications were written.
