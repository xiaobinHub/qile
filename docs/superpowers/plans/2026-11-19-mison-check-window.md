# 自动约课检查时间 Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the independent backend admission task. Preserve all existing dirty work. No commits or production deployment.

**Goal:** Replace sleep controls with a 24-hour active checking window, midnight centered, with no enable switch and a full-day 12:00–12:00 state labeled 全天执行.

**Architecture:** Keep the persisted sleep contract as the complement of the selected active window, preserving all existing schedules without migration. UI uses a circular time range projected onto a noon-to-noon axis; 12:00 at opposite ends represents the entire day. Backend admits automated Mison requests only during that active window, including a running round and pending reconciliation. Manual browsing remains independent.

**Tech Stack:** Existing React/Radix sliders, scoped CSS, Python scheduler/admission and isolated browser/backend fixtures.

### Task 1: Time range UI and config adapter

- [x] Add focused time-axis conversion helpers and active-window slider component.
- [x] Show 12:00 → 00:00 → 12:00; display the active range, with 全天执行 at full span; no switch.
- [x] Support minute precision, keyboard and pointer editing, crossing midnight/noon, legacy values, and read-only access.
- [x] Integrate into execution rhythm; update dashboard labels and saved-rule summaries to checking-window wording.

### Task 2: Backend request boundary

- [x] Reuse persisted quiet interval as the inverse active window and defer out-of-window work to the next opening.
- [x] Guard each automatic Mison request so a round cannot continue reads past the window end; keep pending receipt state for later reconciliation.
- [x] Add isolated regression coverage for same-day/overnight/full-day windows and a round crossing the closing boundary.

### Task 3: Verify and document

- [x] Migrate existing UI acceptance to active-window sliders; cover full-day save/reload, inverse payloads, crossings, keyboard, no master switch and readonly behavior.
- [x] Type check, plugin build, backend tests, Chromium/WebKit responsive checks; inspect rendered screenshots.
- [x] Review spec and code quality, update UI/README docs, confirm local source runtime healthy. Do not save or reload the user's current draft.

## Verification evidence

- Domain conversion checks, type check and local plugin build passed.
- Backend worker ran `LELE_TEST_CONFIG=data/testing/backend/config.json PYTHONPATH=backend .venv/bin/python -m unittest tests.backend.test_mison_auto_booking_window tests.backend.test_mison_auto_booking tests.backend.test_mison_booking tests.backend.test_mison_bark -v`: 92 tests passed, including 14 window cases.
- Each browser passed all 11 focused scenarios at 1440×1000, 1034×889, 820×1180 and 390×844; no console/page errors or unexpected business requests.
- chromium evidence: `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-7OqE13`.
- webkit evidence: `/var/folders/40/58fnhr6110n87z4ynzrjc57w0000gn/T/mison-frontend-PMfm8G`.
- Local parent/admin/runtime healthy; source backend revision21 ready. No real config saves, requests or browser reloads performed during acceptance; all writes used fixtures.

- Boundary recovery regression: a local admission denial after mark-dispatch is recorded as definitely unsent, clearing pending so the next window can retry. Actual transport timeout/lost receipts remain uncertain and are never blindly resent. Main independently repeated the two exact-boundary cases: both passed.
- Final spec review passed, including the original zero-transmission stall probe and three focused backend regressions. Frontend code-quality review passed. Backend code-quality review also passed, covering request admission, deferral/recovery, definite-unsent classification and receipt safety.

- Full-day screenshot: `/Users/xiaobin/.codex/visualizations/2026/11/18/01a1ef03-5ec4-7be2-b221-d762c0215658/mison-check-window-all-day.png`. All planned tasks completed; code remains local and uncommitted.
