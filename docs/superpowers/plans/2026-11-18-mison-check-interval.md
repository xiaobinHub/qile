# Mison Check Interval Implementation Plan

> **For agentic workers:** Execute the following tasks in the current session. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Keep weekday add buttons compact at intermediate widths and let owners choose a random 1–30 minute checking range.

**Architecture:** Store `checkInterval: { minMinutes, maxMinutes }` with the existing private automatic booking configuration. Normalize older records to 4–6 minutes and draw a new inclusive second interval after each normal check or interrupted round. Preserve sleep and upstream retry rules.

**Tech Stack:** React, Radix Slider, existing scoped CSS, Python host scheduler, unittest and Playwright fixtures.

---

### Task 1: Configuration and scheduling

- [x] Extend `backend/lele_growth/plugins/auto_booking.py` defaults, normalization and validation with integer bounds `1 <= minMinutes <= maxMinutes <= 30`.
- [x] Use `minMinutes * 60 + secrets.randbelow((maxMinutes - minMinutes) * 60 + 1)` at both existing ordinary randomized scheduling sites.
- [x] Accept the field in `plugins/mison-booking/backend/mison_booking/auto_booking.py`, retaining compatibility with requests that omit it.
- [x] Extend `tests/backend/test_mison_auto_booking.py` to check validation, old config normalization, fresh draws and API save/read/scheduling.

### Task 2: Controls and responsive layout

- [x] Extend `plugins/mison-booking/frontend/types.ts` and `auto-booking.tsx` to normalize, compare, validate and save the range.
- [x] Add an accessible two-thumb Radix Slider in `auto-booking-settings.tsx`, labelled minimum/maximum, with 1-minute steps, visible selected range, endpoints and explanation.
- [x] In `auto-booking-settings.css`, keep slots and actions in separate grid columns at intermediate widths and retain a 32px add button there. Keep mobile touch dimensions.
- [x] Replace hard-coded 4–6 minute help text with the configured range and update the plugin README.

### Task 3: Verification

- [x] Run `npm run check:mison` and targeted backend unittest with the isolated `lele_test` config.
- [x] Validate the settings through the existing Playwright fixture host at 1031×953, 1440×1000 and 390×844. Browser plugin is not available; use the installed project Playwright runtime.
- [x] Exercise pointer and keyboard slider changes, equal endpoints, save/reload, read-only behavior, add-slot interaction, button dimensions and no horizontal overflow. Keep screenshots and temporary scripts outside the repository.
- [x] Review only the changes added for this request and preserve the existing dirty worktree.
