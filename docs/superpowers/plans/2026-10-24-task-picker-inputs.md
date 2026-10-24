# Task editor selection controls

**Goal:** Reduce keyboard invocation on iPad by using scroll selection for task numbers and duration, and a day grid for monthly recurrence.

**Architecture:** Retain persisted task fields and API operations. Add shared selection-only number and month-day pickers. Reuse the existing time picker for a duration presentation. Preserve the time wheel's cyclic behavior; numeric wheels are bounded at their configured minimum/maximum and render a small sliding window rather than thousands of DOM rows.

**Tech stack:** React, TypeScript, existing shadcn Popover/Input/Button, native scrolling, Playwright isolated database harness.

## Implementation

- [x] Add `frontend/shared/src/components/number-wheel.tsx`: 44px rows, five-row viewport, native touch scroll, fixed selection highlight, keyboard arrows/PageUp/PageDown/Home/End, commit visible value before close, bounded sliding render window. Points retain their existing nonnegative integer range; interval is 1–99 and repetition count is 1–10000.
- [x] Add `number-picker.tsx`: readonly input with `inputMode="none"`, labelled Popover and wheel, Done/outside/Escape closing, correct focus restoration, disabled/readonly behavior, immediate controlled value updates.
- [x] Add `month-day-picker.tsx`: labelled Popover containing all 31 selectable days, active-day theme color, keyboard navigation, selection closes and returns focus. Use a two-column form-grid wrapper to make the field half width.
- [x] Extend `time-picker.tsx` with duration presentation: hours/minutes wheels remain unchanged, display duration units, distinct accessible panel name. Task editor derives duration from its existing start/end values, preserves that duration when startTime changes, and computes endTime when duration is selected. Applying a preset derives duration from its stored start/end times; existing tasks initialize from stored times. Reject zero duration and end beyond 23:59 with a field-level message and a save guard; never silently wrap or clamp.
- [x] Integrate pickers in `frontend/parent/src/features/calendar.tsx`; keep task creation/edit scopes, presets, archived/completed readonly behavior, API payloads, and prior calendar color work intact.
- [x] Update existing browser interactions to select through the controls. Extend isolated picker acceptance for numeric scroll/click/touch/keyboard, bounds and large values, number input keyboard suppression, duration start-shift/preset/edit/save/overflow, monthly days 1 and 31, half-width alignment, focus and responsive behavior.
- [x] Run typechecks/build, formatting, domain tests, typography guard and full isolated browser suite. Inspect screenshots at desktop, iPad and narrow viewports. No production deployment or real business data writes.

## Review

No schema or server migration is needed. Preserve monthly clamping to the last valid date of short months. Numeric ranges are taken from current backend validation; do not impose the legacy preset points cap on task points. Browser emulation does not prove physical iPad keyboard/Safari behavior.

## Validation result

Full admin/parent build, domain/runtime tests, formatting, typography and repository layout checks passed. The final isolated browser run passed 30 scenarios with no page errors and 34 accessibility states with zero violations. Picker coverage includes desktop, iPad portrait/landscape and a 390px touch viewport; physical iPad/Safari keyboard behavior remains outside automated coverage. Read-only asset hash checks confirmed that development port 18787 serves the final parent build.
