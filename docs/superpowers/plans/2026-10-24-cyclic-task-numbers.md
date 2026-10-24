# Cyclic task reward and recurrence interval pickers

**Goal:** New task rewards default to 0 and select 0–100 in steps of 5; recurrence intervals select 1–15. Both wheels loop and use a narrower panel.

**Architecture:** Reuse the existing cyclic time wheel with numeric label/ARIA mapping. The number picker chooses this implementation only when looping is enabled and a finite maximum is supplied. Retain the bounded wheel for repeat counts. Legacy stored values remain unchanged by opening/closing a picker; an explicit new selection applies the current range. Keep API fields and server validation unchanged.

**Stack:** React/TypeScript, existing shared Popover and native scroll wheel, isolated Playwright harness. Continue the previously loaded brainstorming, writing-plans and frontend-testing workflows using the user's two comments as the concrete requirements.

- [x] Add numeric mapping to `frontend/shared/src/components/time-wheel.tsx`; preserve all existing time/duration behavior.
- [x] Add step/loop options to `number-picker.tsx`, map numeric selections, preserve legacy values until interaction, and reduce cyclic panels from 192px to 144px.
- [x] In `frontend/parent/src/features/calendar.tsx`, default new task points to 0, configure rewards as min 0/max 100/step 5/loop, and intervals as min 1/max 15/loop. Leave total repeat count unchanged.
- [x] Update `tests/browser/picker_actions.cjs` for numeric steps. Update picker acceptance for both wrap directions, mouse/touch scrolling, 5-step rows, panel bounds, pending scroll commit, legacy-value preservation, interval 15, unchanged repeat count, focus and saved payloads.
- [x] Build both surfaces and run domain, formatting, typography and isolated full-browser regression checks. Inspect desktop/iPad/narrow screenshots. Verify development port 18787 serves the result. Never write fixtures to development or production business data.

## Validation result

Admin and parent builds/type checks, domain/runtime tests, source formatting, typography, layout and diff checks passed. The full isolated browser suite passed 31 scenarios with no page errors and 36 accessibility states with no violations. Numeric acceptance covers PC, iPad portrait/landscape emulation and 390px touch viewports; step-5 rows, default zero, both wrap directions, native scrolling, touch gestures, close-time scroll commit, 144px panel width, legacy point/interval preservation and explicit mouse/keyboard replacement all passed. Existing repeat counts, time/duration and single-week printing regressions also passed. Read-only health and asset hashes verified that development port 18787 serves the final build. Physical iPad Safari was not tested. No production deployment or real development/production data writes were performed.
