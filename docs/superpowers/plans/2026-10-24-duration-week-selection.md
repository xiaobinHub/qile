# Task duration and single-week printing

**Goal:** Apply the three browser comments: remove the derived end-time hint, filter cross-day durations, and select exactly one Monday–Sunday week for printing.

**Architecture:** Retain task start/end API fields. Bound the existing duration wheel by `1439 - startMinutes`; changing hours clamps minutes to the available maximum. Reposition the time wheel when its option count changes. Moving the task start later preserves duration where possible and shortens it to end at 23:59 when necessary. Zero duration keeps its existing field validation. Printing stores one week start and derives its six-day-later end; a shared week picker selects the whole week with one click, using the existing calendar and date-range styles.

**Stack:** React, TypeScript, existing shared UI, react-day-picker, isolated Playwright regression harness.

- [x] Update `frontend/shared/src/components/time-picker.tsx` with a duration maximum and filtered hour/minute counts; guard all emitted changes.
- [x] Update `frontend/shared/src/components/time-wheel.tsx` to reposition on count changes and cancel pending scroll callbacks.
- [x] Update `frontend/parent/src/features/calendar.tsx`: remove help text, pass the same-day duration bound, and cap the derived end when the start changes.
- [x] Extend `frontend/shared/src/components/date-picker.tsx` with a dedicated `WeekPicker` using a whole-week branch of the existing calendar. Export it from parent `ui.tsx`.
- [x] Update `frontend/parent/src/features/print.tsx` to store a single week, keep this/next-week shortcuts and generate exactly one week.
- [x] Update existing picker acceptance assertions and the iPad PWA PDF regression. Check late starts, hour-dependent minute options, scroll/keyboard boundaries, re-expansion of options, one-click week replacement, cross-month/year weeks, focus, and one-page PDF regeneration.
- [x] Build both surfaces, run domain/runtime checks and the isolated browser suite, inspect desktop/iPad/narrow screenshots, then verify development serves the new assets. Browser plugin is unavailable; use the repository's installed Playwright harness. Test writes target only `lele_test_unified_ui`, never real development or production records.

No schema, server, or deployment changes are needed. Existing uncommitted changes remain in place. Physical iPad Safari and system printer UI are outside automated coverage.

## Validation

Both surface builds, domain/runtime tests, typography, formatting, repository layout and diff checks passed. The full isolated browser suite passed 31 scenarios with no page errors and 36 accessibility states with zero violations. Single-week selection passed at 1135×789 desktop, 820×1180 and 1180×820 iPad emulation, and 390×844 narrow touch viewport. It covers one-click and Enter selection, full seven-day highlighting, focus return, month/year boundaries, shortcuts and one-page printing. The emulated iPad PWA regenerated a one-page A4 landscape PDF and revoked the old URL after switching weeks. Focused capture was repeated after animations settled; screenshots are in `/private/tmp/lele-week-selection-qa`. Read-only development health and asset hashes confirmed port 18787 serves the new parent and print builds. Physical iPad Safari and the OS print dialog remain unverified.
